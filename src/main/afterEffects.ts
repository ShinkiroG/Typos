import { dialog, ipcMain, BrowserWindow, type WebContents } from 'electron'
import { spawn } from 'child_process'
import { dirname, join } from 'path'
import { promises as fs, existsSync } from 'fs'
import { findFfmpeg, run } from './media'
import { RGB_TO_YUV, x264Args, nvencArgs } from './compose'
import { loadSettings, saveSettings } from './settings'
import { aeScript, aeYear, aerenderErrors, aerenderFrame, parseResult, pickAeFolders, renderInput } from './aeCore'
import { hasNvenc, oneAtATime } from './motionPreview'

/**
 * Motion no After Effects (o "híbrido"): o Claude escreve um script ExtendScript, o AE roda ele e monta o
 * projeto .aep do bloco, o aerender grava e o ffmpeg põe o áudio do trecho e deixa no formato da timeline.
 * O autor pode abrir o .aep, mexer, salvar e mandar renderizar de novo.
 */

export interface AeInfo {
  afterfx: string
  aerender: string
  /** ano da versão (2025, 2024…), se der pra saber pela pasta */
  year: number | null
}

/** acha o AE: o caminho das Configurações, senão a versão mais nova em Arquivos de Programas\Adobe */
function fromExe(exe: string): AeInfo | null {
  const dir = dirname(exe)
  const aerender = join(dir, 'aerender.exe')
  if (!existsSync(exe) || !existsSync(aerender)) return null
  return { afterfx: exe, aerender, year: aeYear(dirname(dir).split(/[\\/]/).pop() ?? '') }
}

/** todos os AE instalados em Arquivos de Programas\\Adobe, na ordem de preferência (2025, 2024, depois os outros) */
export async function listAe(): Promise<AeInfo[]> {
  const roots = [process.env.ProgramFiles, process.env.ProgramW6432, 'C:\\Program Files'].filter(Boolean) as string[]
  const out: AeInfo[] = []
  for (const root of roots.filter((r, i) => roots.findIndex((x) => x.toLowerCase() === r.toLowerCase()) === i)) {
    const adobe = join(root, 'Adobe')
    const names = await fs.readdir(adobe).catch(() => [] as string[])
    for (const n of pickAeFolders(names)) {
      const got = fromExe(join(adobe, n, 'Support Files', 'AfterFX.exe'))
      if (got && !out.some((x) => x.afterfx.toLowerCase() === got.afterfx.toLowerCase())) out.push(got)
    }
  }
  return out
}

/** o AE que o Typos usa: o escolhido nas Configurações, senão o 2025, o 2024 ou o mais novo que tiver */
export async function findAe(): Promise<AeInfo | null> {
  const s = await loadSettings()
  if (s.aePath) {
    const got = fromExe(s.aePath)
    if (got) return got
  }
  return (await listAe())[0] ?? null
}

export interface AeJob {
  /** pasta do projeto: o AE do bloco fica em <projeto>/previas/<bloco>/ae-<hora> */
  dir: string
  block: string
  /** miolo do script (o Claude escreveu) */
  body: string
  seconds: number
  width: number
  height: number
  fps: number
  wav?: Uint8Array
  files: { src: string; name: string }[]
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'arquivo'
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

/** o AE está aberto? (pra avisar que ele pode pedir pra salvar o projeto que está nele) */
async function aeRunning() {
  if (process.platform !== 'win32') return false
  const r = await run('tasklist', ['/FI', 'IMAGENAME eq AfterFX.exe', '/NH'], { timeoutMs: 8000 }).catch(() => null)
  return !!r && /AfterFX\.exe/i.test(r.out)
}

/** pede pro AE rodar o script e espera ele escrever o resultado */
async function runScript(ae: AeInfo, script: string, result: string, aep: string, cancelled: () => boolean) {
  await fs.rm(result, { force: true }).catch(() => null)
  const p = spawn(ae.afterfx, ['-r', script], { detached: true, stdio: 'ignore', windowsHide: false })
  p.on('error', () => null)
  p.unref()
  const t0 = Date.now()
  let savedAt = 0
  // abrir o AE do zero demora: até 6 minutos
  while (Date.now() - t0 < 6 * 60000) {
    if (cancelled()) throw new Error('Cancelado.')
    await new Promise((r) => setTimeout(r, 600))
    const text = await fs.readFile(result, 'utf8').catch(() => null)
    if (text !== null && text.trim()) return parseResult(text)
    // o .aep já foi salvo mas o resultado não veio: o AE está sem "Permitir que scripts gravem arquivos"
    // (ele salva o projeto mesmo assim); dá um tempinho e segue
    if (!savedAt && existsSync(aep)) savedAt = Date.now()
    if (savedAt && Date.now() - savedAt > 4000) return { ok: true as const }
  }
  return {
    error:
      'o After Effects não respondeu em 6 minutos. Veja se ele abriu e se não está parado numa janela (ex.: pedindo pra salvar o projeto aberto, ou avisando de plugin/licença). No AE, ligue também Editar → Preferências → Scripts e expressões → "Permitir que scripts gravem arquivos e acessem a rede".'
  }
}

/** grava o .aep com o aerender e converte pro clipe da timeline (tamanho, 30 fps, áudio do trecho) */
async function renderAep(job: { aep: string; out: string; seconds: number; width: number; height: number; fps: number; wav?: string }, onPct: (p: number) => void, cancelled: () => boolean) {
  const ae = await findAe()
  if (!ae) throw new Error('O After Effects não foi encontrado (Configurações → After Effects).')
  const ff = await findFfmpeg()
  if (!ff) throw new Error('O ffmpeg não foi encontrado (Configurações → Mídia).')
  const renderDir = join(dirname(job.aep), 'render')
  await fs.rm(renderDir, { recursive: true, force: true }).catch(() => null)
  await fs.mkdir(renderDir, { recursive: true })
  const frames = Math.max(1, Math.round(job.seconds * job.fps))
  const ac = new AbortController()
  const watch = setInterval(() => cancelled() && ac.abort(), 500)
  let log = ''
  const onLine = (l: string) => {
    log += l + '\n'
    const f = aerenderFrame(l)
    if (f !== null) onPct(Math.min(0.95, f / frames) * 0.9)
  }
  // o aerender escreve o progresso no stdout: lê pelas duas saídas
  const r = await new Promise<{ code: number }>((resolve) => {
    const p = spawn(ae.aerender, ['-project', job.aep, '-sound', 'OFF'], { windowsHide: true })
    ac.signal.addEventListener('abort', () => p.kill(), { once: true })
    const feed = (d: Buffer) => d.toString().split(/\r?\n|\r/).forEach((l) => l && onLine(l))
    p.stdout.on('data', feed)
    p.stderr.on('data', feed)
    p.on('close', (code) => resolve({ code: code ?? -1 }))
    p.on('error', (e) => {
      log += String(e)
      resolve({ code: -1 })
    })
  }).finally(() => clearInterval(watch))
  if (cancelled()) throw new Error('Cancelado.')
  const names = await fs.readdir(renderDir).catch(() => [] as string[])
  const input = renderInput(names)
  if (!input) throw new Error('O aerender não gravou nada' + (aerenderErrors(log) ? ': ' + aerenderErrors(log) : r.code ? ` (código ${r.code})` : '') + '.')
  onPct(0.9)
  const s = await loadSettings()
  const enc = s.motionEncoder === 'gpu' && (await hasNvenc()) ? nvencArgs() : x264Args('grain')
  const W = Math.round(job.width / 2) * 2
  const H = Math.round(job.height / 2) * 2
  const args = ['-hide_banner', '-y']
  if (input.pattern) args.push('-framerate', String(job.fps), '-start_number', String(input.pattern.start))
  args.push('-i', join(renderDir, input.file))
  if (job.wav) args.push('-i', job.wav)
  args.push('-map', '0:v:0')
  if (job.wav) args.push('-map', '1:a:0')
  args.push('-vf', `scale=${W}:${H}:${RGB_TO_YUV},fps=${job.fps},format=yuv420p`, ...enc, '-r', String(job.fps), '-t', job.seconds.toFixed(3))
  if (job.wav) args.push('-c:a', 'aac', '-b:a', '192k')
  else args.push('-an')
  args.push('-movflags', '+faststart', job.out)
  const enc2 = await run(ff.ffmpeg, args)
  if (enc2.code !== 0) throw new Error('O ffmpeg falhou ao converter o render do After Effects: ' + enc2.err.split('\n').slice(-3).join(' ').slice(0, 300))
  // o render cru é grande: some depois de convertido
  await fs.rm(renderDir, { recursive: true, force: true }).catch(() => null)
  onPct(1)
  return job.out
}

/** monta o projeto do bloco no AE (script do Claude) e grava o clipe */
export async function aeBuild(sender: Pick<WebContents, 'isDestroyed' | 'send'>, job: AeJob, cancelled: () => boolean) {
  const send = (stage: string, pct: number) => !sender.isDestroyed() && sender.send('motion:previewProgress', { block: job.block, stage, pct })
  const ae = await findAe()
  if (!ae) throw new Error('O After Effects não foi encontrado. Aponte o AfterFX.exe em Configurações → After Effects.')
  const t = stamp()
  const dir = join(job.dir, 'previas', safeName(job.block), `ae-${t}`)
  await fs.mkdir(dir, { recursive: true })
  for (const f of job.files) await fs.copyFile(f.src, join(dir, safeName(f.name))).catch(() => null)
  let wav: string | undefined
  if (job.wav?.length) {
    wav = join(dir, 'audio-trecho.wav')
    await fs.writeFile(wav, job.wav)
  }
  const aep = join(dir, 'motion.aep')
  const result = join(dir, '_resultado.txt')
  const bodyPath = join(dir, 'motion.jsx')
  await fs.writeFile(bodyPath, job.body, 'utf8')
  const script = join(dir, '_montar.jsx')
  const text = aeScript({ body: job.body, dir, aep, result, renderDir: join(dir, 'render'), width: job.width, height: job.height, seconds: job.seconds, fps: job.fps, wav: wav ? 'audio-trecho.wav' : undefined })
  await fs.writeFile(script, '\uFEFF' + text, 'utf8')
  return oneAtATime(async () => {
    if (cancelled()) throw new Error('Cancelado.')
    send((await aeRunning()) ? 'ae-montando' : 'ae-abrindo', 0)
    const r = await runScript(ae, script, result, aep, cancelled)
    if ('error' in r) return { scriptError: r.error, jsx: bodyPath }
    send('ae-render', 0)
    const video = await renderAep({ aep, out: join(dir, `clipe-${t}.mp4`), seconds: job.seconds, width: job.width, height: job.height, fps: job.fps, wav }, (p) => send('ae-render', p), cancelled)
    return { video, aep, jsx: bodyPath }
  })
}

/** grava de novo um .aep que o autor mexeu no AE */
export async function aeRerender(sender: Pick<WebContents, 'isDestroyed' | 'send'>, job: { block: string; aep: string; seconds: number; width: number; height: number; fps: number }, cancelled: () => boolean) {
  const send = (stage: string, pct: number) => !sender.isDestroyed() && sender.send('motion:previewProgress', { block: job.block, stage, pct })
  if (!existsSync(job.aep)) throw new Error('O projeto do After Effects deste bloco não existe mais: ' + job.aep)
  const dir = dirname(job.aep)
  const wav = join(dir, 'audio-trecho.wav')
  return oneAtATime(() =>
    renderAep({ aep: job.aep, out: join(dir, `clipe-${stamp()}.mp4`), seconds: job.seconds, width: job.width, height: job.height, fps: job.fps, wav: existsSync(wav) ? wav : undefined }, (p) => send('ae-render', p), cancelled)
  )
}

const jobs = new Map<string, { cancel: boolean }>()
async function owned<T>(block: string, fn: (cancelled: () => boolean) => Promise<T>): Promise<T | { error: string }> {
  if (jobs.has(block)) return { error: 'Esse bloco já está sendo gravado. Espere terminar.' }
  const me = { cancel: false }
  jobs.set(block, me)
  try {
    return await fn(() => me.cancel)
  } catch (err: any) {
    return { error: String(err?.message ?? err) }
  } finally {
    if (jobs.get(block) === me) jobs.delete(block)
  }
}

export function initAfterEffects() {
  ipcMain.handle('ae:info', async () => {
    const ae = await findAe()
    const s = await loadSettings()
    return { found: ae, manual: s.aePath ?? null, all: await listAe() }
  })
  /** escolhe o AfterFX.exe na mão (vazio = volta a procurar sozinho) */
  ipcMain.handle('ae:pick', async (e, clear?: boolean | string) => {
    if (clear === true) {
      await saveSettings({ aePath: undefined })
      return { found: await findAe(), manual: null, all: await listAe() }
    }
    // uma das versões achadas (a lista das Configurações)
    if (typeof clear === 'string') {
      const got = (await listAe()).find((x) => x.afterfx === clear)
      if (!got) return { error: 'Essa versão do After Effects não foi encontrada.' }
      await saveSettings({ aePath: got.afterfx })
      return { found: got, manual: got.afterfx, all: await listAe() }
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Onde está o AfterFX.exe?', defaultPath: 'C:\\Program Files\\Adobe', filters: [{ name: 'After Effects', extensions: ['exe'] }], properties: ['openFile' as const] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const exe = r.filePaths[0]
    if (r.canceled || !exe) return { found: await findAe(), manual: (await loadSettings()).aePath ?? null, all: await listAe() }
    if (!existsSync(join(dirname(exe), 'aerender.exe'))) return { error: 'Não achei o aerender.exe na mesma pasta. Escolha o AfterFX.exe dentro de "Support Files".' }
    await saveSettings({ aePath: exe })
    return { found: await findAe(), manual: exe, all: await listAe() }
  })
  ipcMain.handle('ae:build', (e, job: AeJob) => owned(job.block, (c) => aeBuild(e.sender, job, c)))
  ipcMain.handle('ae:rerender', (e, job: { block: string; aep: string; seconds: number; width: number; height: number; fps: number }) =>
    owned(job.block, async (c) => ({ video: await aeRerender(e.sender, job, c) }))
  )
  ipcMain.handle('ae:cancel', (_e, block?: string) => {
    for (const [k, j] of jobs) if (!block || k === block) j.cancel = true
  })
  /** abre o .aep do bloco no AE pro autor mexer */
  ipcMain.handle('ae:open', async (_e, aep: string) => {
    const ae = await findAe()
    if (!ae) return { error: 'O After Effects não foi encontrado (Configurações → After Effects).' }
    if (!existsSync(aep)) return { error: 'O projeto do After Effects deste bloco não existe mais.' }
    const p = spawn(ae.afterfx, [aep], { detached: true, stdio: 'ignore' })
    p.on('error', () => null)
    p.unref()
    return { ok: true }
  })
}
