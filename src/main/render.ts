import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { basename, join, resolve as resolvePath, sep } from 'path'
import { promises as fs, existsSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { findFfmpeg, probe } from './media'
import { concatList, finalArgs, partArgs, partFrames, ENCODE_V, type ALayer, type VLayer } from './compose'
import { htmlToVideo } from './motionPreview'
import { cleanAudio } from './denoise'

/**
 * Workspace Render: o Typos compila a timeline de montagem aqui no PC com o ffmpeg (sem IA):
 * camadas de vídeo com fades e crossfades, o mix das faixas de áudio, os clipes de motion
 * aprovados e os letterings. Sai em partes (render/partes) e junta no fim; o que ficou pronto
 * sobrevive a cancelar ou fechar o app.
 */

const MEDIA_RE = /\.(wav|mp3|ogg|flac|aac|m4a|aiff?|mp4|mov|mkv|webm|avi|m4v|png|jpe?g|webp|gif|bmp|svg)$/i

/** existe? dá pra ler? quantos arquivos de mídia tem (pasta: até 2 níveis, para em 2000) */
async function check(path: string) {
  if (!path || !existsSync(path)) return { path, ok: false, error: 'não encontrado' }
  try {
    const st = await fs.stat(path)
    if (st.isFile()) {
      await fs.access(path)
      return { path, ok: true, files: 1, size: st.size }
    }
    let n = 0
    const walk = async (d: string, depth: number) => {
      if (n >= 2000) return
      const list = await fs.readdir(d, { withFileTypes: true })
      for (const e of list) {
        if (n >= 2000) return
        if (e.isDirectory() && depth < 2) await walk(join(d, e.name), depth + 1).catch(() => {})
        else if (MEDIA_RE.test(e.name)) n++
      }
    }
    await walk(path, 0)
    return { path, ok: true, files: n }
  } catch (e: any) {
    return { path, ok: false, error: e?.code === 'EPERM' || e?.code === 'EACCES' ? 'sem permissão de leitura' : String(e?.message ?? e) }
  }
}

export interface RenderPartIn {
  id: string
  label: string
  from: number
  to: number
  key: string
  video: VLayer[]
  audio: ALayer[]
  letterings: string[]
}

export interface LetteringIn {
  id: string
  label: string
  t: number
  dur: number
  html: string
}

export interface RenderJob {
  dir: string
  width: number
  height: number
  fps: number
  /** nome do vídeo final, dentro de render/ */
  finalFile: string
  parts: RenderPartIn[]
  letterings: LetteringIn[]
  /** joga fora o que já foi feito e começa do zero */
  fresh?: boolean
  /** subpasta de render/ (cada recorte do Criar Clipes tem a dele, com as partes e o estado próprios) */
  sub?: string
  /** como o vídeo entra no quadro: contain (padrão) ou cover (preenche e corta, pros recortes verticais) */
  fit?: 'contain' | 'cover'
  /** pasta de export: o vídeo pronto é copiado pra lá (com exportName) e é essa cópia que volta */
  exportDir?: string
  exportName?: string
}

interface StepState {
  id: string
  label: string
  file: string
  weight: number
  expect?: number
  sig: string
  done: boolean
}

/** render/estado.json: o que já ficou pronto (sobrevive a cancelar, fechar o app, desligar o PC) */
interface RenderState {
  v: 2
  status: 'rodando' | 'interrompido' | 'pronto'
  reason?: string
  updated: number
  steps: StepState[]
}

export interface RenderProgress {
  phase: 'letterings' | 'partes' | 'final'
  /** 0–1 */
  pct: number
  /** segundos que faltam (null = ainda calculando) */
  eta: number | null
  steps: { id: string; label: string; done: boolean }[]
  /** etapas reaproveitadas de uma rodada anterior */
  resumed: number
}

const STATE = 'estado.json'
const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16)

let current: ChildProcess | null = null
let busy = false
let cancelled = false

async function readState(out: string): Promise<RenderState | null> {
  try {
    const j = JSON.parse(await fs.readFile(join(out, STATE), 'utf8'))
    return j?.v === 2 && Array.isArray(j.steps) ? j : null
  } catch {
    return null
  }
}
const writeState = (out: string, st: RenderState) => fs.writeFile(join(out, STATE), JSON.stringify({ ...st, updated: Date.now() }, null, 1), 'utf8').catch(() => {})

/** só mexe em arquivos dentro de render/ */
const insideDir = (dir: string, p: string) => resolvePath(p).startsWith(resolvePath(dir) + sep)

/** a etapa está pronta? o arquivo existe e tem a duração esperada (um .mp4 interrompido não tem índice e não conta) */
async function finished(out: string, s: StepState) {
  const p = join(out, s.file)
  const wav = p.replace(/\.mp4$/i, '.wav')
  if (!existsSync(p) || (s.id !== 'final' && !existsSync(wav))) return false
  if (!s.expect) return true
  const info = await probe(p)
  return !('error' in info) && info.duration >= s.expect * 0.97 - 0.3
}

/** roda o ffmpeg acompanhando o -progress (quadros feitos) */
function ffmpeg(bin: string, args: string[], onFrame?: (frame: number) => void) {
  return new Promise<{ code: number; err: string }>((resolve) => {
    const p = spawn(bin, args, { windowsHide: true })
    current = p
    let err = ''
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) {
        const m = l.match(/^frame=(\d+)/)
        if (m) onFrame?.(Number(m[1]))
      }
    })
    p.stderr.on('data', (d) => {
      err += d
      if (err.length > 400_000) err = err.slice(-200_000)
    })
    p.on('close', (code) => {
      current = null
      resolve({ code: code ?? -1, err })
    })
    p.on('error', (e) => {
      current = null
      resolve({ code: -1, err: String(e) })
    })
  })
}

const tail = (err: string) =>
  err
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-3)
    .join(' ')
    .slice(0, 400)

async function start(sender: WebContents, job: RenderJob) {
  const send = (ev: { kind: 'info' | 'say'; text: string }) => !sender.isDestroyed() && sender.send('render:progress', ev)
  const ff = await findFfmpeg()
  if (!ff) throw new Error('O ffmpeg não foi encontrado (Configurações → Mídia).')
  if (!job.parts.length) throw new Error('A timeline de montagem está vazia: é ela que diz como o vídeo é feito.')
  const sub = (job.sub ?? '').replace(/\\/g, '/').split('/').filter((x) => /^[\w.-]+$/.test(x) && !/^\.+$/.test(x))
  const out = join(job.dir, 'render', ...sub)
  const partsDir = join(out, 'partes')
  const letDir = join(out, 'letterings')
  if (job.fresh) {
    await fs.rm(partsDir, { recursive: true, force: true })
    await fs.rm(join(out, STATE), { force: true })
  }
  await fs.mkdir(partsDir, { recursive: true })
  await fs.mkdir(letDir, { recursive: true })
  const t0 = Date.now()
  const total = job.parts[job.parts.length - 1].to - job.parts[0].from

  // ---------- o que já está pronto de uma rodada anterior ----------
  const letById = new Map(job.letterings.map((l) => [l.id, l]))
  const letFile = (l: LetteringIn) => join(letDir, sha([l.html, l.dur, job.width, job.height, job.fps, ENCODE_V].join('|')) + '.mp4')
  const old = await readState(out)
  const plan: StepState[] = [
    ...job.parts.map((p) => ({
      id: p.id,
      label: p.label,
      file: `partes/${p.id}.mp4`,
      weight: p.to - p.from,
      expect: p.to - p.from,
      sig: sha(p.key + '|' + ENCODE_V + '|' + p.letterings.map((id) => letById.get(id)?.html ?? '').join('|')),
      done: false
    })),
    { id: 'final', label: 'Vídeo final', file: job.finalFile, weight: Math.max(2, total * 0.04), expect: total, sig: '', done: false }
  ]
  plan[plan.length - 1].sig = sha(plan.map((x) => x.sig).join('|') + job.finalFile)
  for (const st of plan) {
    const prev = old?.steps.find((p) => p.id === st.id)
    if (prev && prev.sig === st.sig && prev.file === st.file) st.done = await finished(out, st)
    // arquivo de um plano antigo (a timeline mudou): some, pra ninguém achar que está pronto
    else if (insideDir(out, join(out, st.file))) {
      await fs.rm(join(out, st.file), { force: true })
      await fs.rm(join(out, st.file.replace(/\.mp4$/i, '.wav')), { force: true })
    }
  }
  const resumed = plan.filter((x) => x.done).length
  const state: RenderState = { v: 2, status: 'rodando', updated: 0, steps: plan }
  await writeState(out, state)
  const totalW = plan.reduce((a, x) => a + x.weight, 0) || 1
  const doneW = () => plan.filter((x) => x.done).reduce((a, x) => a + x.weight, 0)
  const startW = doneW()
  const progress = (phase: RenderProgress['phase'], extraW = 0) => {
    const w = doneW() + extraW
    const ran = w - startW
    const eta = ran > 0.5 ? Math.round(((Date.now() - t0) / 1000 / ran) * (totalW - w)) : null
    if (!sender.isDestroyed())
      sender.send('render:state', { phase, pct: w / totalW, eta, resumed, steps: plan.map((x) => ({ id: x.id, label: x.label, done: x.done })) } satisfies RenderProgress)
  }
  if (resumed) send({ kind: 'info', text: `Retomando: ${resumed} de ${plan.length} etapas já estavam prontas.` })
  const stop = async (reason: string) => {
    state.status = 'interrompido'
    state.reason = reason
    await writeState(out, state)
    const left = plan.filter((x) => !x.done).length
    return new Error(`${reason} ${plan.length - left} de ${plan.length} etapas ficaram prontas: "Continuar" segue de onde parou.`)
  }
  progress('partes')

  // ---------- letterings (gravados uma vez, reaproveitados enquanto não mudarem) ----------
  const pending = job.parts.filter((p) => !plan.find((x) => x.id === p.id)!.done)
  const needed = [...new Set(pending.flatMap((p) => p.letterings))].map((id) => letById.get(id)!).filter((l) => l && !existsSync(letFile(l)))
  for (const [i, l] of needed.entries()) {
    send({ kind: 'info', text: `Gravando o lettering "${l.label}" (${i + 1} de ${needed.length})…` })
    progress('letterings')
    try {
      const tmp = letFile(l).replace(/\.mp4$/, '.tmp.mp4')
      await htmlToVideo({ out: letDir, html: l.html, seconds: l.dur, width: job.width, height: job.height, fps: job.fps, files: [], video: tmp, quality: 'final', cancelled: () => cancelled })
      await fs.rename(tmp, letFile(l))
    } catch (e: any) {
      if (cancelled) throw await stop('Cancelado.')
      throw await stop('Não deu pra gravar o lettering "' + l.label + '": ' + String(e?.message ?? e) + '.')
    }
  }

  // ---------- limpeza de ruído e picos (as cópias tratadas, que ficam no cache, são feitas uma vez) ----------
  const cleaned = new Map<string, string>()
  const keyOf = (a: ALayer) => `${a.denoise ?? 0}|${a.peaks ?? 0}|${a.path}`
  const toClean = [...new Map(pending.flatMap((p) => p.audio).filter((a) => a.denoise || a.peaks).map((a) => [keyOf(a), a])).values()]
  for (const [i, a] of toClean.entries()) {
    if (cancelled) throw await stop('Cancelado.')
    send({ kind: 'info', text: `Tratando o som de ${basename(a.path)} (${i + 1} de ${toClean.length})…` })
    progress('partes')
    const r = await cleanAudio(a.path, a.denoise ?? 0, a.peaks ?? 0)
    if (typeof r !== 'string') throw await stop(`Não deu pra tratar o som de ${basename(a.path)}: ${r.error}.`)
    cleaned.set(keyOf(a), r)
  }
  const audioOf = (list: ALayer[]) => list.map((a) => (a.denoise || a.peaks ? { ...a, path: cleaned.get(keyOf(a)) ?? a.path } : a))

  // ---------- partes ----------
  for (const p of pending) {
    if (cancelled) throw await stop('Cancelado.')
    const st = plan.find((x) => x.id === p.id)!
    const lets: VLayer[] = p.letterings
      .map((id) => letById.get(id))
      .filter((l): l is LetteringIn => !!l)
      .map((l) => {
        const f = Math.min(0.35, l.dur / 4)
        return { path: letFile(l), image: false, t0: l.t, t1: l.t + l.dur, src0: 0, fadeIn: f, fadeOut: f }
      })
    send({ kind: 'info', text: `${p.label}…` })
    const frames = partFrames({ from: p.from, to: p.to, fps: job.fps })
    const args = partArgs({
      from: p.from,
      to: p.to,
      width: job.width,
      height: job.height,
      fps: job.fps,
      video: [...p.video, ...lets],
      audio: audioOf(p.audio),
      fit: job.fit,
      outVideo: join(out, st.file),
      outWav: join(out, st.file.replace(/\.mp4$/i, '.wav'))
    })
    const r = await ffmpeg(ff.ffmpeg, args, (f) => progress('partes', st.weight * Math.min(1, f / frames)))
    if (cancelled) throw await stop('Cancelado.')
    if (r.code !== 0) {
      const old = /normalize/i.test(r.err) ? ' (o ffmpeg é antigo demais: atualize pra versão 5 ou mais nova)' : ''
      throw await stop(`O ffmpeg falhou na ${p.label}${old}: ${tail(r.err)}.`)
    }
    st.done = true
    await writeState(out, state)
    progress('partes')
  }

  // ---------- final: junta as partes (vídeo copiado) e passa o limitador no áudio ----------
  const fin = plan[plan.length - 1]
  if (!fin.done) {
    send({ kind: 'info', text: 'Juntando as partes…' })
    progress('final')
    await fs.writeFile(join(partsDir, 'video.txt'), concatList(job.parts.map((p) => p.id + '.mp4')), 'utf8')
    await fs.writeFile(join(partsDir, 'audio.txt'), concatList(job.parts.map((p) => p.id + '.wav')), 'utf8')
    const dest = join(out, fin.file)
    let r = await ffmpeg(ff.ffmpeg, finalArgs(join(partsDir, 'video.txt'), join(partsDir, 'audio.txt'), dest))
    // ffmpeg antigo sem as opções do limitador: junta sem ele
    if (r.code !== 0 && !cancelled && /alimiter|level/i.test(r.err)) r = await ffmpeg(ff.ffmpeg, finalArgs(join(partsDir, 'video.txt'), join(partsDir, 'audio.txt'), dest, false))
    if (cancelled) throw await stop('Cancelado.')
    if (r.code !== 0) throw await stop('O ffmpeg falhou ao juntar as partes: ' + tail(r.err) + '.')
    fin.done = true
  }
  state.status = 'pronto'
  delete state.reason
  await writeState(out, state)
  progress('final')
  const seconds = Math.round((Date.now() - t0) / 1000)
  let path = join(out, fin.file)
  let where = ''
  if (job.exportDir) {
    const name = basename(job.exportName || fin.file).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-') || fin.file
    const dest = join(job.exportDir, /\.mp4$/i.test(name) ? name : name + '.mp4')
    try {
      await fs.mkdir(job.exportDir, { recursive: true })
      await fs.copyFile(path, dest)
      path = dest
      where = ` Copiado pra ${job.exportDir}.`
    } catch (e: any) {
      where = ` Não deu pra copiar pra pasta de export (${String(e?.message ?? e)}): ficou em render/.`
    }
  }
  return { path, summary: `Vídeo compilado: ${job.parts.length} partes, ${job.width}×${job.height} a ${job.fps} fps.${where}`, seconds }
}

/** pra mostrar "Continuar" ao abrir o projeto: o que a última rodada deixou pronto */
async function status(dir: string) {
  const st = await readState(join(dir, 'render'))
  if (!st) return null
  const total = st.steps.reduce((a, x) => a + x.weight, 0) || 1
  const done = st.steps.filter((x) => x.done)
  return {
    status: st.status === 'rodando' && !busy ? 'interrompido' : st.status,
    reason: st.reason,
    done: done.length,
    total: st.steps.length,
    pct: done.reduce((a, x) => a + x.weight, 0) / total,
    updated: st.updated
  }
}

export function initRender() {
  ipcMain.handle('render:check', async (_e, paths: string[]) => Promise.all([...new Set(paths)].map(check)))
  ipcMain.handle('render:status', (_e, dir: string) => status(dir))
  ipcMain.handle('render:start', async (e, job: RenderJob) => {
    if (busy) return { error: 'Já tem um vídeo sendo criado.' }
    busy = true
    cancelled = false
    try {
      return await start(e.sender, job)
    } catch (err: any) {
      return { error: String(err?.message ?? err) }
    } finally {
      busy = false
    }
  })
  ipcMain.handle('render:pickDir', async (e, current?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Pasta de export dos vídeos', buttonLabel: 'Exportar pra cá', defaultPath: current || undefined, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle('render:exists', (_e, paths: string[]) => paths.map((p) => !!p && existsSync(p)))
  ipcMain.handle('render:cancel', () => {
    cancelled = true
    current?.kill()
  })
}
