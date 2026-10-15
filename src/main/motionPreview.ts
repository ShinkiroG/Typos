import { BrowserWindow, ipcMain, session, type NativeImage, type WebContents } from 'electron'
import { dirname, join } from 'path'
import { promises as fs, existsSync } from 'fs'
import { createHash } from 'crypto'
import { findFfmpeg, run } from './media'
import { partArgs, type VLayer } from './compose'

/**
 * Prévia de um bloco de instrução: o HTML de motion que a IA escreveu é tocado numa janela
 * invisível com um relógio de mentira (quadro a quadro, sem pressa) e vira um MP4 leve
 * (12 fps, baixa resolução) com o áudio do trecho. Aprovada, a mesma animação é gravada de novo
 * na resolução do projeto e vira um clipe na timeline. O render usa o mesmo motor pros letterings.
 */

export interface PreviewJob {
  /** pasta do projeto: a prévia fica em <projeto>/previas/<bloco> */
  dir: string
  block: string
  html: string
  seconds: number
  width: number
  height: number
  fps: number
  /** áudio do trecho (WAV), já mixado pela Montagem */
  wav?: Uint8Array
  /** arquivos que o HTML usa pelo nome (anexos de insert) */
  files: { src: string; name: string }[]
  /** clipe final (qualidade do projeto) em vez da prévia leve */
  final?: boolean
  /** zoom da página (HTML escrito pro tamanho da prévia, gravado maior) */
  zoom?: number
  /** HTML já salvo (o da prévia aprovada): lê dele em vez de `html` */
  htmlPath?: string
}

/**
 * Relógio virtual: performance.now, Date.now, requestAnimationFrame, setTimeout/setInterval e as
 * animações CSS/WAAPI andam só quando o Typos manda (__typosStep). Assim cada quadro sai no tempo
 * certo mesmo que a captura seja lenta.
 */
const CLOCK = `<script>(function(){
var vt=0,last=0,seq=0,raf=[],timers=[],seen=new WeakMap(),T0=Date.now(),realRaf=window.requestAnimationFrame.bind(window),realST=window.setTimeout.bind(window);
performance.now=function(){return vt};
Date.now=function(){return T0+vt};
window.requestAnimationFrame=function(cb){var id=++seq;raf.push({id:id,cb:cb});return id};
window.cancelAnimationFrame=function(id){raf=raf.filter(function(r){return r.id!==id})};
function add(cb,ms,args,every){var id=++seq;timers.push({id:id,at:vt+Math.max(0,+ms||0),cb:cb,args:args,every:every});return id}
window.setTimeout=function(cb,ms){return add(cb,ms,[].slice.call(arguments,2),0)};
window.setInterval=function(cb,ms){return add(cb,ms,[].slice.call(arguments,2),Math.max(4,+ms||0))};
window.clearTimeout=window.clearInterval=function(id){timers=timers.filter(function(t){return t.id!==id})};
function call(f,a){try{typeof f==='function'?f.apply(null,a||[]):(0,eval)(String(f))}catch(e){console.error(e)}}
window.__typosStep=function(ms){
  for(var g=0;g<20000;g++){timers.sort(function(a,b){return a.at-b.at});var t=timers[0];if(!t||t.at>ms)break;vt=t.at;if(t.every)t.at+=t.every;else timers.shift();call(t.cb,t.args)}
  vt=ms;var q=raf;raf=[];q.forEach(function(r){call(r.cb,[ms])});
  if(document.getAnimations)document.getAnimations().forEach(function(a){
    if(!seen.has(a))seen.set(a,last);
    try{a.pause();a.currentTime=Math.max(0,ms-seen.get(a))}catch(e){}
  });
  last=ms;
  return seekVideos(ms).then(function(){return new Promise(function(r){realRaf(function(){realRaf(function(){r(true)})})})})};
// todo <video> (ex.: embaixo.mp4, o vídeo que está embaixo do bloco) anda junto com o relógio do bloco
function seekVideos(ms){return Promise.all([].slice.call(document.querySelectorAll('video')).map(function(v){return new Promise(function(r){
  var ok=false,to,done=function(){if(ok)return;ok=true;clearTimeout(to);r(true)};to=realST(done,2000);
  try{v.muted=true;v.autoplay=false;v.loop=false;v.pause();
    var go=function(){var t=ms/1000;if(v.duration&&t>v.duration-0.02)t=Math.max(0,v.duration-0.02);if(Math.abs(v.currentTime-t)<0.0005&&v.readyState>=2)return done();v.addEventListener('seeked',done,{once:true});v.currentTime=t};
    if(v.readyState<1){v.preload='auto';v.addEventListener('loadedmetadata',go,{once:true});v.load&&v.readyState===0&&!v.currentSrc&&v.load()}else go()
  }catch(e){done()}})}))}
})();</script>`

function withClock(html: string) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + CLOCK)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + '<head>' + CLOCK + '</head>')
  return '<!doctype html><html><head>' + CLOCK + '</head><body>' + html + '</body></html>'
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'arquivo'

let busy: { cancel: boolean } | null = null

export interface HtmlVideoJob {
  /** pasta de trabalho (quadros, HTML tocável e anexos ficam aqui) */
  out: string
  html: string
  seconds: number
  /** tamanho do vídeo (px) */
  width: number
  height: number
  fps: number
  /** zoom da página: o HTML foi escrito pra um tamanho menor e é ampliado sem perder nitidez */
  zoom?: number
  wav?: Uint8Array
  files: { src: string; name: string }[]
  /** arquivo de saída (.mp4) */
  video: string
  crf: number
  onPct?: (pct: number) => void
  cancelled?: () => boolean
}

/** toca o HTML com o relógio virtual numa janela invisível e grava quadro a quadro num MP4 (com o áudio, se tiver) */
export async function htmlToVideo(job: HtmlVideoJob) {
  const ff = await findFfmpeg()
  if (!ff) throw new Error('O ffmpeg não foi encontrado (Configurações → Mídia).')
  const out = job.out
  const frames = join(out, 'quadros-' + Math.random().toString(36).slice(2, 8))
  await fs.rm(frames, { recursive: true, force: true })
  await fs.mkdir(frames, { recursive: true })
  for (const f of job.files) await fs.copyFile(f.src, join(out, safeName(f.name))).catch(() => null)
  const playPath = join(out, `_tocar-${Math.random().toString(36).slice(2, 8)}.html`)
  await fs.writeFile(playPath, withClock(job.html), 'utf8')

  const W = Math.max(16, Math.round(job.width / 2) * 2)
  const H = Math.max(16, Math.round(job.height / 2) * 2)
  let zoom = job.zoom && job.zoom > 0 ? job.zoom : 1
  // sessão própria, sem internet: a animação tem que ser autocontida (e não vaza nada)
  const ses = session.fromPartition('typos-motion-preview')
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|data|blob|about|devtools):/i.test(d.url) }))
  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    useContentSize: true,
    frame: false,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, zoomFactor: zoom }
  })
  win.setContentSize(W, H)
  // o Windows não deixa a janela passar do tamanho da tela (ex.: 1080×1920 num monitor de 1080 de altura):
  // se encolheu, grava menor na MESMA proporção (zoom junto) e o ffmpeg amplia, em vez de esticar o quadro
  const [cw, ch] = win.getContentSize()
  if (cw < W - 1 || ch < H - 1) {
    const f = Math.min(cw / W, ch / H)
    win.setContentSize(Math.max(16, Math.floor(W * f)), Math.max(16, Math.floor(H * f)))
    zoom *= f
  }
  let lastImg: NativeImage | null = null
  let waiting: ((img: NativeImage) => void) | null = null
  win.webContents.on('paint', (_e, _dirty, img) => {
    // o primeiro "quadro" às vezes vem vazio (0×0): ignora
    if (img.isEmpty()) return
    lastImg = img
    waiting?.(img)
  })
  /** próximo quadro pintado; se nada mudou na tela até o prazo, o último */
  const nextPaint = (ms: number) =>
    new Promise<NativeImage | null>((resolve) => {
      const t = setTimeout(() => {
        waiting = null
        resolve(lastImg)
      }, ms)
      waiting = (im) => {
        clearTimeout(t)
        waiting = null
        resolve(im)
      }
      win.webContents.invalidate()
    })
  win.webContents.setFrameRate(60)
  try {
    await win.loadFile(playPath)
    win.webContents.setZoomFactor(zoom)
    // fontes e imagens carregadas antes do primeiro quadro
    await win.webContents.executeJavaScript('(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => true)').catch(() => null)
    // espera a página aparecer de verdade antes do quadro 0
    for (let k = 0; k < 10 && !lastImg; k++) await nextPaint(300)
    const n = Math.max(1, Math.round(job.seconds * job.fps))
    for (let i = 0; i < n; i++) {
      if (job.cancelled?.()) throw new Error('Cancelado.')
      await win.webContents.executeJavaScript(`window.__typosStep && window.__typosStep(${((i * 1000) / job.fps).toFixed(3)})`).catch(() => null)
      const img = await nextPaint(400)
      if (!img) throw new Error('A animação não desenhou nada (o HTML veio vazio ou quebrado).')
      await fs.writeFile(join(frames, `q${String(i).padStart(5, '0')}.png`), img.toPNG())
      if (i % 3 === 0) job.onPct?.((i + 1) / n)
    }
  } catch (e) {
    await fs.rm(frames, { recursive: true, force: true }).catch(() => null)
    throw e
  } finally {
    win.destroy()
    await fs.rm(playPath, { force: true }).catch(() => null)
  }
  job.onPct?.(1)
  const args = ['-hide_banner', '-y', '-framerate', String(job.fps), '-i', join(frames, 'q%05d.png')]
  let wav = ''
  if (job.wav?.length) {
    wav = join(out, `audio-${Math.random().toString(36).slice(2, 8)}.wav`)
    await fs.writeFile(wav, job.wav)
    args.push('-i', wav)
  }
  args.push('-vf', `scale=${W}:${H}:flags=bicubic,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(job.crf), '-r', String(job.fps))
  if (wav) args.push('-c:a', 'aac', '-b:a', job.crf <= 20 ? '192k' : '96k', '-shortest')
  args.push('-movflags', '+faststart', job.video)
  const r = await run(ff.ffmpeg, args)
  await fs.rm(frames, { recursive: true, force: true }).catch(() => null)
  if (wav) await fs.rm(wav, { force: true }).catch(() => null)
  if (r.code !== 0) throw new Error('O ffmpeg falhou ao montar o vídeo: ' + r.err.split('\n').slice(-3).join(' ').slice(0, 300))
  return job.video
}

/**
 * Prévia (12 fps, baixa resolução) ou clipe final (resolução do projeto) de um bloco.
 * O clipe final toca o mesmo HTML da prévia aprovada, ampliado com zoom (a composição fica igual).
 */
export async function renderMotionPreview(sender: Pick<WebContents, 'isDestroyed' | 'send'>, job: PreviewJob) {
  const send = (stage: string, pct: number) => !sender.isDestroyed() && sender.send('motion:previewProgress', { block: job.block, stage, pct })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = join(job.dir, 'previas', safeName(job.block))
  await fs.mkdir(out, { recursive: true })
  let htmlPath = job.htmlPath ?? ''
  if (!htmlPath) {
    htmlPath = join(out, `motion-${stamp}.html`)
    await fs.writeFile(htmlPath, job.html, 'utf8')
  }
  const html = job.htmlPath ? await fs.readFile(job.htmlPath, 'utf8') : job.html
  const video = await htmlToVideo({
    out,
    html,
    seconds: job.seconds,
    width: job.width,
    height: job.height,
    fps: job.fps,
    zoom: job.zoom,
    wav: job.wav,
    files: job.files,
    video: join(out, `${job.final ? 'clipe' : 'previa'}-${stamp}.mp4`),
    crf: job.final ? 18 : 26,
    onPct: (p) => send(p >= 1 ? 'vídeo' : 'quadros', p),
    cancelled: () => !!busy?.cancel
  })
  send('vídeo', 1)
  return { video, html: htmlPath }
}

export interface LayoutJob {
  /** pasta do projeto: a checagem roda em <projeto>/previas/<bloco> */
  dir: string
  block: string
  html: string
  seconds: number
  width: number
  height: number
  files: { src: string; name: string }[]
  /** script que mede a página (devolve a lista de problemas daquele instante) */
  probe: string
  /** de quanto em quanto tempo medir (s) */
  step?: number
}

export interface LayoutHit {
  kind: string
  what: string
  t: number
  rect: { x: number; y: number; w: number; h: number }
}

/**
 * Checagem da safe zone: toca o HTML no relógio virtual (sem gravar quadros) e mede a página em vários
 * instantes. Um elemento só conta se ficar fora do lugar por duas medições seguidas ou no quadro final
 * (o que só atravessa a tela numa transição não conta).
 */
export async function checkLayout(job: LayoutJob): Promise<LayoutHit[]> {
  const out = join(job.dir, 'previas', safeName(job.block))
  await fs.mkdir(out, { recursive: true })
  for (const f of job.files) await fs.copyFile(f.src, join(out, safeName(f.name))).catch(() => null)
  const playPath = join(out, `_checar-${Math.random().toString(36).slice(2, 8)}.html`)
  await fs.writeFile(playPath, withClock(job.html), 'utf8')
  const W = Math.max(16, Math.round(job.width / 2) * 2)
  const H = Math.max(16, Math.round(job.height / 2) * 2)
  const ses = session.fromPartition('typos-motion-preview')
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|data|blob|about|devtools):/i.test(d.url) }))
  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    useContentSize: true,
    frame: false,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.setContentSize(W, H)
  win.webContents.setFrameRate(60)
  const found = new Map<string, LayoutHit>()
  try {
    await win.loadFile(playPath)
    await win.webContents.executeJavaScript('(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => true)').catch(() => null)
    const step = job.step ?? 0.25
    const times: number[] = []
    for (let t = 0; t < job.seconds - 0.01; t += step) times.push(t)
    times.push(Math.max(0, job.seconds - 0.05))
    let prev = new Map<string, LayoutHit>()
    for (const [i, t] of times.entries()) {
      if (busy?.cancel) throw new Error('Cancelado.')
      await win.webContents.executeJavaScript(`window.__typosStep && window.__typosStep(${(t * 1000).toFixed(3)})`).catch(() => null)
      const hits: Omit<LayoutHit, 't'>[] = (await win.webContents.executeJavaScript(job.probe).catch(() => [])) ?? []
      const now = new Map<string, LayoutHit>()
      for (const h of hits) now.set(h.kind + '|' + h.what, { ...h, t })
      const last = i === times.length - 1
      for (const [k, h] of now) if ((prev.has(k) || last) && !found.has(k)) found.set(k, prev.get(k) ?? h)
      prev = now
    }
  } finally {
    win.destroy()
    await fs.rm(playPath, { force: true }).catch(() => null)
  }
  return [...found.values()].sort((a, z) => a.t - z.t)
}

export interface UnderJob {
  /** pasta do projeto: fica em <projeto>/previas/<bloco>/embaixo */
  dir: string
  block: string
  from: number
  to: number
  width: number
  height: number
  /** camadas de vídeo de baixo pra cima (tempos da timeline), como no render */
  video: VLayer[]
}

/**
 * O que está embaixo de um bloco de instrução, num MP4 sem som do tamanho do bloco (o segundo 0 é o
 * começo do bloco). A animação põe ele num <video> e o relógio virtual mantém os dois em sincronia.
 */
export async function underVideo(job: UnderJob) {
  const ff = await findFfmpeg()
  if (!ff) throw new Error('O ffmpeg não foi encontrado (Configurações → Mídia).')
  const out = join(job.dir, 'previas', safeName(job.block), 'embaixo')
  await fs.mkdir(out, { recursive: true })
  const key = createHash('sha1').update(JSON.stringify(job)).digest('hex').slice(0, 12)
  const video = join(out, `embaixo-${job.width}-${key}.mp4`)
  if (existsSync(video)) return video
  const wav = join(out, `_${key}.wav`)
  const r = await run(
    ff.ffmpeg,
    partArgs({ from: job.from, to: job.to, width: job.width, height: job.height, fps: 30, video: job.video, audio: [], fit: 'contain', outVideo: video, outWav: wav }),
    { timeoutMs: 10 * 60000 }
  )
  await fs.rm(wav, { force: true }).catch(() => null)
  if (r.code !== 0) {
    await fs.rm(video, { force: true }).catch(() => null)
    throw new Error('O ffmpeg falhou ao recortar o vídeo de baixo: ' + r.err.split('\n').slice(-3).join(' ').slice(0, 300))
  }
  return video
}

/**
 * O HTML que gerou um clipe de motion (clipes aprovados antes de o Typos guardar isso): o motion-*.html
 * mais novo da mesma pasta da prévia que já existia quando o clipe foi gravado.
 */
export async function findMotionHtml(video: string): Promise<string | null> {
  const dir = dirname(video)
  const st = await fs.stat(video).catch(() => null)
  const names = await fs.readdir(dir).catch(() => [] as string[])
  let best: { path: string; t: number } | null = null
  for (const n of names) {
    if (!/^motion-.*\.html$/i.test(n)) continue
    const p = join(dir, n)
    const t = (await fs.stat(p).catch(() => null))?.mtimeMs ?? 0
    if (st && t > st.mtimeMs + 1000) continue
    if (!best || t > best.t) best = { path: p, t }
  }
  return best?.path ?? null
}

export function initMotionPreview() {
  ipcMain.handle('motion:findHtml', (_e, video: string) => findMotionHtml(video).catch(() => null))
  ipcMain.handle('motion:underVideo', async (_e, job: UnderJob) => {
    try {
      return { video: await underVideo(job) }
    } catch (err: any) {
      return { error: String(err?.message ?? err) }
    }
  })
  ipcMain.handle('motion:preview', async (e, job: PreviewJob) => {
    if (busy) return { error: 'Já tem uma prévia sendo feita. Espere ela terminar.' }
    busy = { cancel: false }
    try {
      return await renderMotionPreview(e.sender, job)
    } catch (err: any) {
      return { error: String(err?.message ?? err) }
    } finally {
      busy = null
    }
  })
  ipcMain.handle('motion:checkLayout', async (_e, job: LayoutJob) => {
    try {
      return { issues: await checkLayout(job) }
    } catch (err: any) {
      return { error: String(err?.message ?? err) }
    }
  })
  ipcMain.handle('motion:previewCancel', () => {
    if (busy) busy.cancel = true
  })
}
