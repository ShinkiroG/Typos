import { app, ipcMain, dialog } from 'electron'
import { spawn, execFile } from 'child_process'
import { join, dirname, basename, extname } from 'path'
import { promises as fs, existsSync } from 'fs'
import { createHash } from 'crypto'
import { loadSettings } from './settings'

/**
 * Mídia da Montagem: tudo que precisa de ffmpeg (duração, áudio de prévia, transcrição, exportar).
 * Os arquivos do usuário nunca são copiados nem alterados: o projeto só guarda o caminho.
 */

const MEDIA_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.png', '.jpg', '.jpeg', '.webp']

export const mediaCacheDir = () => join(app.getPath('userData'), 'media-cache')

let found: { ffmpeg: string; ffprobe: string | null } | null | undefined

function which(cmd: string): Promise<string | null> {
  return new Promise((res) => execFile('where', [cmd], { windowsHide: true }, (err, out) => res(err ? null : out.split(/\r?\n/)[0]?.trim() || null)))
}

/** ffmpeg do usuário: caminho manual (Configurações) → PATH → WinGet → pastas comuns */
export async function findFfmpeg(force = false) {
  if (found !== undefined && !force) return found
  const s = await loadSettings()
  const candidates = [
    s.ffmpegPath,
    await which('ffmpeg'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe')
  ].filter(Boolean) as string[]
  const ffmpeg = candidates.find((p) => existsSync(p)) ?? null
  if (!ffmpeg) return (found = null)
  const probe = join(dirname(ffmpeg), 'ffprobe.exe')
  return (found = { ffmpeg, ffprobe: existsSync(probe) ? probe : null })
}

export function run(file: string, args: string[], opts: { onErr?: (line: string) => void; timeoutMs?: number } = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const p = spawn(file, args, { windowsHide: true })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => {
      const s = d.toString()
      err += s
      if (err.length > 2_000_000) err = err.slice(-1_000_000)
      if (opts.onErr) for (const line of s.split(/\r?\n|\r/)) line && opts.onErr(line)
    })
    const timer = opts.timeoutMs ? setTimeout(() => p.kill(), opts.timeoutMs) : null
    p.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, out, err })
    })
    p.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
  })
}

export interface Probe {
  duration: number
  hasVideo: boolean
  hasAudio: boolean
  width?: number
  height?: number
  fps?: number
}

export async function probe(path: string): Promise<Probe | { error: string }> {
  const ff = await findFfmpeg()
  if (!ff) return { error: 'ffmpeg não encontrado' }
  if (ff.ffprobe) {
    const r = await run(ff.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { timeoutMs: 30000 })
    try {
      const j = JSON.parse(r.out)
      const v = j.streams?.find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic)
      const a = j.streams?.find((s: any) => s.codec_type === 'audio')
      const [n, d] = String(v?.avg_frame_rate ?? '0/1').split('/').map(Number)
      return {
        duration: Number(j.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0,
        hasVideo: !!v,
        hasAudio: !!a,
        width: v?.width,
        height: v?.height,
        fps: d ? n / d : undefined
      }
    } catch {
      /* cai pro ffmpeg -i */
    }
  }
  const r = await run(ff.ffmpeg, ['-hide_banner', '-i', path], { timeoutMs: 30000 })
  const m = r.err.match(/Duration: (\d+):(\d+):([\d.]+)/)
  const size = r.err.match(/Video: .*?(\d{2,5})x(\d{2,5})/)
  return {
    duration: m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0,
    hasVideo: /Stream .*Video:/.test(r.err) && !/attached pic/.test(r.err),
    hasAudio: /Stream .*Audio:/.test(r.err),
    width: size ? +size[1] : undefined,
    height: size ? +size[2] : undefined
  }
}

const keyOf = async (path: string, tag: string) => {
  const st = await fs.stat(path)
  return createHash('sha1').update(`${tag}|${path}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20)
}

const pending = new Map<string, Promise<string | { error: string }>>()

/** Áudio de prévia (mono 32 kHz WAV): toca sem travar e com corte exato, mesmo de vídeo enorme. */
export function proxyAudio(path: string): Promise<string | { error: string }> {
  let p = pending.get(path)
  if (p) return p
  p = (async () => {
    const ff = await findFfmpeg()
    if (!ff) return { error: 'ffmpeg não encontrado' }
    const out = join(mediaCacheDir(), (await keyOf(path, 'proxy32k')) + '.wav')
    if (existsSync(out)) return out
    await fs.mkdir(mediaCacheDir(), { recursive: true })
    const tmp = out + '.part.wav'
    const r = await run(ff.ffmpeg, ['-hide_banner', '-y', '-i', path, '-vn', '-ac', '1', '-ar', '32000', '-c:a', 'pcm_s16le', tmp])
    if (r.code !== 0 || !existsSync(tmp)) return { error: 'ffmpeg não conseguiu ler o áudio: ' + r.err.split('\n').slice(-3).join(' ').slice(0, 200) }
    await fs.rename(tmp, out)
    return out
  })()
  pending.set(path, p)
  p.finally(() => pending.delete(path))
  return p
}

export function initMedia() {
  ipcMain.handle('media:ffmpeg', async (_e, force?: boolean) => {
    const f = await findFfmpeg(!!force)
    if (!f) return null
    const v = await run(f.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 15000 })
    const w = await run(f.ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 15000 })
    return { path: f.ffmpeg, version: v.out.split('\n')[0]?.replace(/^ffmpeg version /, '').split(' ')[0] ?? '?', whisper: /\bwhisper\b/.test(w.out) }
  })

  ipcMain.handle('media:pick', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Importar mídia pra Montagem',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Vídeo, áudio e imagem', extensions: MEDIA_EXT.map((e) => e.slice(1)) }]
    })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('media:probe', (_e, path: string) => probe(path))
  ipcMain.handle('media:proxy', (_e, path: string) => proxyAudio(path))
  ipcMain.handle('media:loudness', (_e, path: string, start: number, dur: number) => loudness(path, start, dur))
  ipcMain.handle('media:exists', (_e, paths: string[]) => paths.map((p) => existsSync(p)))
}

export const isMediaFile = (p: string) => MEDIA_EXT.includes(extname(p).toLowerCase())
export const nameOf = (p: string) => basename(p)

/** volume percebido (LUFS integrado) e pico real (dBTP) de um trecho, pelo loudnorm do ffmpeg */
export async function loudness(path: string, start: number, dur: number): Promise<{ i: number; tp: number } | null> {
  const ff = await findFfmpeg()
  if (!ff || dur < 0.4) return null
  const r = await run(ff.ffmpeg, ['-hide_banner', '-nostats', '-ss', String(Math.max(0, start)), '-t', String(dur), '-i', path, '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { timeoutMs: 120000 })
  const m = r.err.match(/\{[^{}]*"input_i"[^{}]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    const i = Number(j.input_i)
    const tp = Number(j.input_tp)
    return Number.isFinite(i) && i > -70 ? { i, tp: Number.isFinite(tp) ? tp : 0 } : null
  } catch {
    return null
  }
}

/** quadros espalhados pelo vídeo (jpg 640px), pra IA "ver" o estilo; ficam em cache por arquivo */
export async function extractFrames(path: string, outRoot: string, n = 8): Promise<string[] | { error: string }> {
  const ff = await findFfmpeg()
  if (!ff) return { error: 'ffmpeg não encontrado' }
  const info = await probe(path)
  if ('error' in info) return info
  if (!info.hasVideo || !info.duration) return { error: 'esse arquivo não tem vídeo' }
  const st = await fs.stat(path)
  const key = createHash('sha1').update(`${path}|${st.size}|${st.mtimeMs}|${n}`).digest('hex').slice(0, 16)
  const dir = join(outRoot, key)
  await fs.mkdir(dir, { recursive: true })
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    // evita o primeiro/último instante (fade de abertura/fechamento)
    const t = info.duration * ((i + 0.5) / n)
    const f = join(dir, `f${String(i + 1).padStart(2, '0')}.jpg`)
    if (!existsSync(f)) await run(ff.ffmpeg, ['-hide_banner', '-y', '-ss', t.toFixed(2), '-i', path, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', f], { timeoutMs: 60000 })
    if (existsSync(f)) out.push(f)
  }
  return out.length ? out : { error: 'não deu pra tirar quadros desse vídeo' }
}

let fontCache: string[] | null = null
/** fontes instaladas no Windows (pra escolher e ver a prévia) */
export async function systemFonts(): Promise<string[]> {
  if (fontCache) return fontCache
  const r = await run('powershell.exe', [
    '-NoProfile',
    '-Command',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }'
  ], { timeoutMs: 30000 })
  fontCache = [...new Set(r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  return fontCache
}

/** quantos quadros o foco pede: estética = poucos espalhados; motion = + sequências rápidas (8 q/s) */
export function framePlan(focus = 50) {
  const even = Math.round(3 + (Math.max(0, Math.min(100, focus)) / 100) * 6) // 3..9
  const bursts = focus >= 40 ? Math.min(3, 1 + Math.round((focus - 40) / 30)) : 0 // 40→1 · 70→2 · 100→3
  return { even, bursts, perBurst: 6 }
}

/** quadros pro treino de estilo, conforme o foco da referência (cache por arquivo + plano) */
export async function framesForFocus(
  path: string,
  focus: number,
  outRoot: string
): Promise<{ path: string; kind: 'even' | 'burst'; group: number; index: number; t: number }[] | { error: string }> {
  const ff = await findFfmpeg()
  if (!ff) return { error: 'ffmpeg não encontrado' }
  const info = await probe(path)
  if ('error' in info) return info
  if (!info.hasVideo || !info.duration) return { error: 'esse arquivo não tem vídeo' }
  const plan = framePlan(focus)
  const st = await fs.stat(path)
  const key = createHash('sha1').update(`${path}|${st.size}|${st.mtimeMs}|${plan.even}|${plan.bursts}`).digest('hex').slice(0, 16)
  const dir = join(outRoot, key)
  await fs.mkdir(dir, { recursive: true })
  const out: { path: string; kind: 'even' | 'burst'; group: number; index: number; t: number }[] = []
  const d = info.duration
  for (let i = 0; i < plan.even; i++) {
    const t = d * ((i + 0.5) / plan.even)
    const f = join(dir, `e${String(i + 1).padStart(2, '0')}.jpg`)
    if (!existsSync(f)) await run(ff.ffmpeg, ['-hide_banner', '-y', '-ss', t.toFixed(2), '-i', path, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', f], { timeoutMs: 60000 })
    if (existsSync(f)) out.push({ path: f, kind: 'even', group: 0, index: i, t })
  }
  // sequências: 6 quadros seguidos a 8 q/s em pontos diferentes do vídeo (dá pra "ver" o movimento)
  for (let b = 0; b < plan.bursts; b++) {
    const center = d * ((b + 1) / (plan.bursts + 1))
    const start = Math.max(0, Math.min(d - plan.perBurst / 8, center - plan.perBurst / 16))
    const pattern = join(dir, `b${b + 1}_%02d.jpg`)
    const firstFile = join(dir, `b${b + 1}_01.jpg`)
    if (!existsSync(firstFile))
      await run(ff.ffmpeg, ['-hide_banner', '-y', '-ss', start.toFixed(2), '-i', path, '-t', (plan.perBurst / 8 + 0.05).toFixed(2), '-vf', 'fps=8,scale=480:-2', '-q:v', '5', '-frames:v', String(plan.perBurst), pattern], { timeoutMs: 60000 })
    for (let k = 1; k <= plan.perBurst; k++) {
      const f = join(dir, `b${b + 1}_${String(k).padStart(2, '0')}.jpg`)
      if (existsSync(f)) out.push({ path: f, kind: 'burst', group: b + 1, index: k - 1, t: start + (k - 1) / 8 })
    }
  }
  return out.length ? out : { error: 'não deu pra tirar quadros desse vídeo' }
}
