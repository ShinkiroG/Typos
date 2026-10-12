import { BrowserWindow, ipcMain, session, type NativeImage, type WebContents } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { findFfmpeg, run } from './media'

/**
 * Prévia de um bloco de instrução: o HTML de motion que a IA escreveu é tocado numa janela
 * invisível com um relógio de mentira (quadro a quadro, sem pressa) e vira um MP4 leve
 * (12 fps, baixa resolução) com o áudio do trecho.
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
}

/**
 * Relógio virtual: performance.now, Date.now, requestAnimationFrame, setTimeout/setInterval e as
 * animações CSS/WAAPI andam só quando o Typos manda (__typosStep). Assim cada quadro sai no tempo
 * certo mesmo que a captura seja lenta.
 */
const CLOCK = `<script>(function(){
var vt=0,last=0,seq=0,raf=[],timers=[],seen=new WeakMap(),T0=Date.now(),realRaf=window.requestAnimationFrame.bind(window);
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
  return new Promise(function(r){realRaf(function(){realRaf(function(){r(true)})})})};
})();</script>`

function withClock(html: string) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + CLOCK)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + '<head>' + CLOCK + '</head>')
  return '<!doctype html><html><head>' + CLOCK + '</head><body>' + html + '</body></html>'
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'arquivo'

let busy: { cancel: boolean } | null = null

export async function renderMotionPreview(sender: Pick<WebContents, 'isDestroyed' | 'send'>, job: PreviewJob) {
  const ff = await findFfmpeg()
  if (!ff) throw new Error('O ffmpeg não foi encontrado (Configurações → Mídia).')
  const send = (stage: string, pct: number) => !sender.isDestroyed() && sender.send('motion:previewProgress', { block: job.block, stage, pct })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = join(job.dir, 'previas', safeName(job.block))
  const frames = join(out, 'quadros')
  await fs.rm(frames, { recursive: true, force: true })
  await fs.mkdir(frames, { recursive: true })
  for (const f of job.files) await fs.copyFile(f.src, join(out, safeName(f.name))).catch(() => null)
  const htmlPath = join(out, `motion-${stamp}.html`)
  await fs.writeFile(htmlPath, job.html, 'utf8')
  const playPath = join(out, '_tocar.html')
  await fs.writeFile(playPath, withClock(job.html), 'utf8')

  const W = Math.max(16, Math.round(job.width / 2) * 2)
  const H = Math.max(16, Math.round(job.height / 2) * 2)
  // sessão própria, sem internet: a animação tem que ser autocontida (e não vaza nada)
  const ses = session.fromPartition('typos-motion-preview')
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|data|blob|about|devtools):/i.test(d.url) }))
  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    useContentSize: true,
    frame: false,
    webPreferences: { offscreen: true, session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.webContents.setZoomFactor(1)
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
    // fontes e imagens carregadas antes do primeiro quadro
    await win.webContents.executeJavaScript('(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => true)').catch(() => null)
    // espera a página aparecer de verdade antes do quadro 0
    for (let k = 0; k < 10 && !lastImg; k++) await nextPaint(300)
    const n = Math.max(1, Math.round(job.seconds * job.fps))
    for (let i = 0; i < n; i++) {
      if (busy?.cancel) throw new Error('Cancelado.')
      await win.webContents.executeJavaScript(`window.__typosStep && window.__typosStep(${((i * 1000) / job.fps).toFixed(3)})`).catch(() => null)
      const img = await nextPaint(400)
      if (!img) throw new Error('A animação não desenhou nada (o HTML veio vazio ou quebrado).')
      await fs.writeFile(join(frames, `q${String(i).padStart(5, '0')}.png`), img.toPNG())
      if (i % 3 === 0) send('quadros', (i + 1) / n)
    }
  } finally {
    win.destroy()
  }
  send('vídeo', 1)
  const video = join(out, `previa-${stamp}.mp4`)
  const args = ['-hide_banner', '-y', '-framerate', String(job.fps), '-i', join(frames, 'q%05d.png')]
  if (job.wav?.length) {
    const wav = join(out, 'audio.wav')
    await fs.writeFile(wav, job.wav)
    args.push('-i', wav)
  }
  args.push('-vf', `scale=${W}:${H}:flags=bicubic,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-r', String(job.fps))
  if (job.wav?.length) args.push('-c:a', 'aac', '-b:a', '96k', '-shortest')
  args.push('-movflags', '+faststart', video)
  const r = await run(ff.ffmpeg, args)
  if (r.code !== 0) throw new Error('O ffmpeg falhou ao montar a prévia: ' + r.err.split('\n').slice(-3).join(' ').slice(0, 300))
  await fs.rm(frames, { recursive: true, force: true }).catch(() => null)
  await fs.rm(playPath, { force: true }).catch(() => null)
  return { video, html: htmlPath }
}

export function initMotionPreview() {
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
  ipcMain.handle('motion:previewCancel', () => {
    if (busy) busy.cancel = true
  })
}
