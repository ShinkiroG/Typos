import { app, ipcMain, dialog } from 'electron'
import { spawn, execFile } from 'child_process'
import { join, dirname, basename, extname } from 'path'
import { promises as fs, existsSync } from 'fs'
import { createHash } from 'crypto'
import { loadSettings } from './settings'
import { profileFromPcm, wavPcm, type SoundProfile } from './soundProfile'

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

export function run(file: string, args: string[], opts: { onErr?: (line: string) => void; timeoutMs?: number; signal?: AbortSignal } = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const p = spawn(file, args, { windowsHide: true })
    opts.signal?.addEventListener('abort', () => p.kill(), { once: true })
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
  /** codec do vídeo (h264, hevc, prores…) e taxa em bits/s, quando o ffprobe diz */
  codec?: string
  bitrate?: number
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
        fps: d ? n / d : undefined,
        codec: v?.codec_name,
        bitrate: Number(v?.bit_rate) || Number(j.format?.bit_rate) || undefined
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
    height: size ? +size[2] : undefined,
    codec: r.err.match(/Stream .*Video: (\w+)/)?.[1]
  }
}

const keyOf = async (path: string, tag: string) => {
  const st = await fs.stat(path)
  return createHash('sha1').update(`${tag}|${path}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20)
}

const pending = new Map<string, Promise<string | { error: string }>>()

/** onde fica (ou vai ficar) o áudio de prévia de um arquivo, sem gerar nada */
export const proxyPathOf = async (path: string) => join(mediaCacheDir(), (await keyOf(path, 'proxy32k')) + '.wav')

/** Áudio de prévia (mono 32 kHz WAV): toca sem travar e com corte exato, mesmo de vídeo enorme. */
export function proxyAudio(path: string): Promise<string | { error: string }> {
  let p = pending.get(path)
  if (p) return p
  p = (async () => {
    const ff = await findFfmpeg()
    if (!ff) return { error: 'ffmpeg não encontrado' }
    const out = await proxyPathOf(path)
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

// ---------- prévia leve de vídeo pesado ----------
// 4K, HEVC, ProRes e afins travam o player da Montagem. Pra esses o Typos faz uma cópia
// 720p em H.264 com quadro-chave a cada meio segundo (pular na timeline fica instantâneo)
// e usa ela só na prévia; o render sempre lê o arquivo original.
const HEAVY_CODECS = /^(hevc|h265|prores|dnxhd|dnxhr|av1|vp9|mpeg2video|cfhd|mjpeg|rawvideo|v210)$/i
const videoProxies = new Map<string, Promise<string | null>>()
let proxyChain: Promise<unknown> = Promise.resolve()

export function proxyVideo(path: string): Promise<string | null> {
  let p = videoProxies.get(path)
  if (p) return p
  p = (async () => {
    const ff = await findFfmpeg()
    if (!ff || !existsSync(path)) return null
    const out = join(mediaCacheDir(), (await keyOf(path, 'proxy720')) + '.mp4')
    if (existsSync(out)) return out
    const info = await probe(path)
    if ('error' in info || !info.hasVideo) return null
    const heavy = (info.height ?? 0) > 1080 || (info.width ?? 0) > 1920 || HEAVY_CODECS.test(info.codec ?? '') || (info.bitrate ?? 0) > 60e6
    if (!heavy) return null
    // um de cada vez: não disputa a CPU com a edição
    const job = proxyChain.then(async () => {
      await fs.mkdir(mediaCacheDir(), { recursive: true })
      const tmp = out + '.part.mp4'
      const r = await run(ff.ffmpeg, [
        '-hide_banner', '-y', '-i', path, '-an',
        '-vf', 'scale=-2:min(720\\,ih)',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
        '-g', String(Math.max(1, Math.round((info.fps || 30) / 2))), '-movflags', '+faststart', tmp
      ])
      if (r.code !== 0 || !existsSync(tmp)) {
        await fs.rm(tmp, { force: true }).catch(() => null)
        return null
      }
      await fs.rename(tmp, out)
      return out
    })
    proxyChain = job.catch(() => null)
    return job
  })()
  videoProxies.set(path, p)
  // falhou: deixa tentar de novo depois
  p.then((r) => r || videoProxies.delete(path))
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
  ipcMain.handle('media:proxyVideo', (_e, path: string) => proxyVideo(path))
  ipcMain.handle('media:loudness', (_e, path: string, start: number, dur: number) => loudness(path, start, dur))
  ipcMain.handle('media:soundProfiles', (_e, paths: string[]) => soundProfiles(paths))
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

// ---------- perfil de sons (efeitos e trilhas das pastas do estilo e do bruto) ----------
const profiles = new Map<string, Promise<SoundProfile | null>>()

/** perfil de um som (impacto, começo, fim, volume, curva de energia); fica em cache no disco por arquivo */
export function soundProfile(path: string): Promise<SoundProfile | null> {
  let p = profiles.get(path)
  if (p) return p
  p = (async () => {
    const file = join(mediaCacheDir(), (await keyOf(path, 'perfil1').catch(() => 'x')) + '.perfil.json')
    if (file.endsWith('x.perfil.json')) return null
    const cached = await fs.readFile(file, 'utf8').then((t) => JSON.parse(t) as SoundProfile | null).catch(() => undefined)
    if (cached !== undefined) return cached
    const wav = await proxyAudio(path)
    if (typeof wav !== 'string') return null
    const pcm = wavPcm(await fs.readFile(wav))
    const prof = pcm && profileFromPcm(pcm.pcm, pcm.rate)
    if (prof) {
      const l = await loudness(path, 0, Math.min(prof.duration, 600)).catch(() => null)
      if (l) prof.lufs = Math.round(l.i * 10) / 10
    }
    await fs.writeFile(file, JSON.stringify(prof ?? null)).catch(() => null)
    return prof ?? null
  })()
  profiles.set(path, p)
  p.catch(() => profiles.delete(path))
  return p
}

/** vários perfis, 3 de cada vez (bibliotecas de som têm muitos arquivos curtos) */
export async function soundProfiles(paths: string[]) {
  const out: (SoundProfile | null)[] = new Array(paths.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < paths.length) {
      const i = next++
      out[i] = await soundProfile(paths[i]).catch(() => null)
    }
  }
  await Promise.all([worker(), worker(), worker()])
  return out
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

export interface FrameWeights {
  /** 0..100: quanto aprender da estética (mais quadros soltos) */
  aesthetic: number
  /** 0..100: quanto aprender do motion (sequências rápidas) */
  motion: number
  /** motion no máximo + checagem quadro a quadro: sequências longas a 24 q/s */
  frameByFrame?: boolean
}

/** quantos quadros os pesos pedem: estética = quadros soltos espalhados; motion = sequências rápidas */
export function framePlan(w: FrameWeights) {
  const a = Math.max(0, Math.min(100, w.aesthetic))
  const m = Math.max(0, Math.min(100, w.motion))
  const even = Math.round(2 + (a / 100) * 7) // 2..9
  if (w.frameByFrame && m >= 100) return { even, bursts: 4, perBurst: 12, fps: 24 }
  const bursts = m >= 25 ? Math.min(3, 1 + Math.round((m - 25) / 35)) : 0 // 25→1 · 60→2 · 95→3
  return { even, bursts, perBurst: 6, fps: 8 }
}

/** quadros pro treino de estilo, conforme os pesos da referência (cache por arquivo + plano) */
export async function framesForFocus(
  path: string,
  weights: FrameWeights,
  outRoot: string
): Promise<{ path: string; kind: 'even' | 'burst'; group: number; index: number; t: number; fps: number }[] | { error: string }> {
  const ff = await findFfmpeg()
  if (!ff) return { error: 'ffmpeg não encontrado' }
  const info = await probe(path)
  if ('error' in info) return info
  if (!info.hasVideo || !info.duration) return { error: 'esse arquivo não tem vídeo' }
  const plan = framePlan(weights)
  const st = await fs.stat(path)
  const key = createHash('sha1').update(`${path}|${st.size}|${st.mtimeMs}|${plan.even}|${plan.bursts}|${plan.perBurst}|${plan.fps}`).digest('hex').slice(0, 16)
  const dir = join(outRoot, key)
  await fs.mkdir(dir, { recursive: true })
  const out: { path: string; kind: 'even' | 'burst'; group: number; index: number; t: number; fps: number }[] = []
  const d = info.duration
  for (let i = 0; i < plan.even; i++) {
    const t = d * ((i + 0.5) / plan.even)
    const f = join(dir, `e${String(i + 1).padStart(2, '0')}.jpg`)
    if (!existsSync(f)) await run(ff.ffmpeg, ['-hide_banner', '-y', '-ss', t.toFixed(2), '-i', path, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', f], { timeoutMs: 60000 })
    if (existsSync(f)) out.push({ path: f, kind: 'even', group: 0, index: i, t, fps: plan.fps })
  }
  // sequências: quadros seguidos (8 q/s, ou 24 q/s no quadro a quadro) em pontos diferentes do vídeo (dá pra "ver" o movimento)
  const span = plan.perBurst / plan.fps
  for (let b = 0; b < plan.bursts; b++) {
    const center = d * ((b + 1) / (plan.bursts + 1))
    const start = Math.max(0, Math.min(d - span, center - span / 2))
    const pattern = join(dir, `b${b + 1}_%02d.jpg`)
    const firstFile = join(dir, `b${b + 1}_01.jpg`)
    if (!existsSync(firstFile))
      await run(ff.ffmpeg, ['-hide_banner', '-y', '-ss', start.toFixed(2), '-i', path, '-t', (span + 0.05).toFixed(2), '-vf', `fps=${plan.fps},scale=480:-2`, '-q:v', '5', '-frames:v', String(plan.perBurst), pattern], { timeoutMs: 60000 })
    for (let k = 1; k <= plan.perBurst; k++) {
      const f = join(dir, `b${b + 1}_${String(k).padStart(2, '0')}.jpg`)
      if (existsSync(f)) out.push({ path: f, kind: 'burst', group: b + 1, index: k - 1, t: start + (k - 1) / plan.fps, fps: plan.fps })
    }
  }
  return out.length ? out : { error: 'não deu pra tirar quadros desse vídeo' }
}

/** um quadro em cada tempo pedido (s do arquivo), em cache: o que está embaixo de um bloco de instrução */
export async function framesAt(path: string, times: number[], outRoot: string, width = 480): Promise<(string | null)[]> {
  const ff = await findFfmpeg()
  if (!ff) return times.map(() => null)
  const st = await fs.stat(path).catch(() => null)
  if (!st) return times.map(() => null)
  const dir = join(outRoot, createHash('sha1').update(`${path}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16))
  await fs.mkdir(dir, { recursive: true })
  const out: (string | null)[] = []
  for (const t of times) {
    const f = join(dir, `t${Math.max(0, t).toFixed(2)}${width === 480 ? '' : '-' + width}.jpg`)
    if (!existsSync(f))
      await run(ff.ffmpeg, ['-hide_banner', '-y', '-ss', Math.max(0, t).toFixed(2), '-i', path, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', width === 480 ? '5' : '2', f], {
        timeoutMs: 60000
      })
    out.push(existsSync(f) ? f : null)
  }
  return out
}

// ---------- baixar vídeo (YouTube etc.) com o yt-dlp ----------
let ytdlpFound: string | null | undefined
export async function findYtDlp(force = false) {
  if (ytdlpFound !== undefined && !force) return ytdlpFound
  const s = await loadSettings()
  const links = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe')
  const cands = [s.ytdlpPath, await which('yt-dlp'), links].filter(Boolean) as string[]
  let hit = cands.find((p) => existsSync(p)) ?? null
  if (!hit) {
    // winget às vezes não cria o atalho: procura na pasta de pacotes
    const pkgs = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages')
    for (const d of await fs.readdir(pkgs).catch(() => [] as string[]))
      if (/yt-dlp/i.test(d)) {
        const f = join(pkgs, d, 'yt-dlp.exe')
        if (existsSync(f)) hit = f
      }
  }
  return (ytdlpFound = hit)
}

/** cancela o que estiver rodando no download (o yt-dlp ou o corte local no ffmpeg) */
let dlStop: (() => void) | null = null
let dlBusy = false

/** "1:05", "0:28.5", "90" → segundos */
const toSecs = (t?: string) => (t ? t.split(':').reduce((a, x) => a * 60 + Number(x), 0) : NaN)

/**
 * O "ffmpeg exited with code 3436169992" do yt-dlp é o AVERROR_HTTP_FORBIDDEN (0xCCCFCB08):
 * no --download-sections quem baixa é o ffmpeg, direto do servidor do YouTube, e ele leva 403.
 * O downloader do próprio yt-dlp passa, então o trecho cai pro plano B: baixa inteiro e corta aqui.
 */
export const sectionFailed = (msg: string) => /ffmpeg exited with code|HTTP error 403|403 Forbidden|Server returned 403/i.test(msg)

export function initDownloads() {
  ipcMain.handle('media:ytdlp', async () => {
    const p = await findYtDlp(true)
    return p ? { path: p } : null
  })

  /** instala pelo winget (o usuário clicou em "Instalar yt-dlp") */
  ipcMain.handle('media:installYtdlp', async () => {
    const r = await run('winget', ['install', '--id', 'yt-dlp.yt-dlp', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { timeoutMs: 10 * 60000 })
    const p = await findYtDlp(true)
    return p ? { path: p } : { error: 'Não deu pra instalar: ' + (r.out + r.err).split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) }
  })

  ipcMain.handle('media:dlCancel', () => {
    dlStop?.()
    dlStop = null
  })

  ipcMain.handle(
    'media:download',
    async (e, url: string, dir: string, opts: { quality: '1080' | '720' | 'audio'; from?: string; to?: string; target?: 'motion' }): Promise<{ path: string } | { error: string }> => {
      const yt = await findYtDlp()
      if (!yt) return { error: 'yt-dlp não encontrado' }
      if (dlBusy) return { error: 'já tem um download em andamento' }
      dlBusy = true
      try {
        return await download(e.sender, yt, url, dir, opts)
      } finally {
        dlBusy = false
        dlStop = null
      }
    }
  )
}

type Progress = { pct: number; speed: string; eta: string }

async function download(
  sender: Electron.WebContents,
  yt: string,
  url: string,
  dir: string,
  opts: { quality: '1080' | '720' | 'audio'; from?: string; to?: string; target?: 'motion' }
): Promise<{ path: string } | { error: string }> {
  const ff = await findFfmpeg()
  const send = (p: Progress) => !sender.isDestroyed() && sender.send('media:dlProgress', p)
  // referências de motion são globais (servem pra todo formato): ficam no userData
  const dest = opts.target === 'motion' ? join(app.getPath('userData'), 'format-media', 'videos') : join(dir, 'assets', 'material-bruto')
  await fs.mkdir(dest, { recursive: true })
  const audio = opts.quality === 'audio'
  const section = !!(opts.from || opts.to)
  const span = section ? toSecs(opts.to) - toSecs(opts.from || '0') : NaN
  const fmt = audio ? 'ba[ext=m4a]/ba' : `bv*[height<=${opts.quality}][ext=mp4]+ba[ext=m4a]/bv*[height<=${opts.quality}]+ba/b[height<=${opts.quality}]/b`

  /** uma rodada do yt-dlp; `cut` = baixa só o trecho (o ffmpeg busca direto do servidor) */
  const ytdlp = (outDir: string, cut: boolean) =>
    new Promise<{ code: number | null; file?: string; error?: string }>((resolve) => {
      const args = [
        '--no-playlist',
        '--newline',
        '--no-mtime',
        '-f',
        fmt,
        ...(audio ? ['-x', '--audio-format', 'm4a'] : ['--merge-output-format', 'mp4']),
        ...(ff ? ['--ffmpeg-location', dirname(ff.ffmpeg)] : []),
        ...(cut ? ['--download-sections', `*${opts.from || '0'}-${opts.to || 'inf'}`, '--force-keyframes-at-cuts'] : []),
        '-o',
        join(outDir, '%(title).80s [%(id)s]' + (cut ? ' (trecho)' : '') + '.%(ext)s'),
        '--print',
        'after_move:filepath',
        // o --print deixa o yt-dlp quieto: religa a saída pra ter o progresso
        '--no-quiet',
        '--progress',
        // caminho com acento ("você está…") volta certo (sem isso vem na página de código do Windows)
        '--encoding',
        'utf-8',
        url
      ]
      const started = Date.now()
      const p = spawn(yt, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
      dlStop = () => p.kill()
      let out = ''
      let err = ''
      let step = 0
      // no trecho a barra vai até 99%; no plano B o download é a primeira metade e o corte, a segunda
      const scale = section && !cut ? 0.5 : 1
      const onLine = (line: string) => {
        // trecho: o yt-dlp corta com o ffmpeg (sem %): o progresso sai do "time=" sobre a duração do trecho
        const tm = /time=(\d+):(\d+):([\d.]+)/.exec(line)
        if (tm && cut && span > 0) {
          const done = Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3])
          send({ pct: Math.min(0.99, done / span), speed: '', eta: '' })
        }
        // vídeo e áudio baixam separados: a barra vai de 0–50% e 50–100%
        if (/Destination:/.test(line)) step++
        const m = /\[download\]\s+([\d.]+)%(?:.*?at\s+(\S+))?(?:.*?ETA\s+(\S+))?/.exec(line)
        if (m) {
          const raw = Number(m[1]) / 100
          const pct = audio ? raw : (Math.max(0, step - 1) + raw) / 2
          send({ pct: Math.min(0.99, pct * scale), speed: m[2] ?? '', eta: m[3] ?? '' })
        }
        if (/\[Merger\]|\[ExtractAudio\]|\[ModifyChapters\]/.test(line)) send({ pct: Math.min(0.99, scale), speed: '', eta: 'juntando…' })
      }
      p.stdout.on('data', (d) => {
        out += d
        // o ffmpeg reescreve a mesma linha com \r (progresso): separa por \r também
        String(d).split(/\r\n|\r|\n/).forEach(onLine)
      })
      p.stderr.on('data', (d) => {
        err += d
        String(d).split(/\r\n|\r|\n/).forEach(onLine)
      })
      p.on('close', async (code) => {
        let file = out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && existsSync(l))
          .pop()
        // plano B: o arquivo mais novo da pasta, criado durante este download
        if (code === 0 && !file) {
          let best: { f: string; t: number } | null = null
          for (const n of await fs.readdir(outDir).catch(() => [] as string[])) {
            if (/\.(part|ytdl|temp)$/i.test(n)) continue
            const st = await fs.stat(join(outDir, n)).catch(() => null)
            if (st?.isFile() && st.mtimeMs >= started - 2000 && (!best || st.mtimeMs > best.t)) best = { f: join(outDir, n), t: st.mtimeMs }
          }
          file = best?.f
        }
        if (code === 0 && file) return resolve({ code, file })
        if (code === null) return resolve({ code })
        const lines = (err + '\n' + out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        const why = lines.filter((l) => /ERROR/.test(l)).pop() ?? lines.filter((l) => !/^\[download\]\s+[\d.]+%|frame=/.test(l)).slice(-2).join(' · ')
        resolve({ code, error: 'yt-dlp: ' + (why || `terminou sem dizer o motivo (código ${code})`).slice(0, 400) })
      })
      p.on('error', (er) => resolve({ code: -1, error: String(er) }))
    })

  const first = await ytdlp(dest, section)
  if (first.file) return { path: first.file }
  if (first.code === null) return { error: 'download cancelado' }
  if (!section || !ff || !sectionFailed(first.error ?? '')) return { error: first.error ?? 'yt-dlp falhou' }

  // sobras da tentativa que falhou
  for (const n of await fs.readdir(dest).catch(() => [] as string[]))
    if (n.includes('(trecho)') && /\.(part|ytdl|temp)$/i.test(n)) await fs.rm(join(dest, n), { force: true }).catch(() => {})

  // plano B do trecho: baixa o vídeo inteiro numa pasta temporária e corta aqui com o ffmpeg
  const tmp = join(dest, `.baixando-${Date.now()}`)
  await fs.mkdir(tmp, { recursive: true })
  try {
    send({ pct: 0, speed: '', eta: 'baixando o vídeo inteiro pra cortar…' })
    const full = await ytdlp(tmp, false)
    if (full.code === null) return { error: 'download cancelado' }
    if (!full.file) return { error: full.error ?? 'yt-dlp falhou' }
    const ext = audio ? '.m4a' : '.mp4'
    const out = join(dest, basename(full.file, extname(full.file)) + ' (trecho)' + ext)
    const ac = new AbortController()
    dlStop = () => ac.abort()
    const from = toSecs(opts.from || '0')
    // -ss antes do -i: busca rápida e, recodificando, o corte sai no quadro exato
    const r = await run(
      ff.ffmpeg,
      [
        '-hide_banner',
        '-y',
        ...(from > 0 ? ['-ss', String(from)] : []),
        '-i',
        full.file,
        ...(span > 0 ? ['-t', String(span)] : []),
        ...(audio ? ['-vn'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p']),
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        out
      ],
      {
        signal: ac.signal,
        onErr: (line) => {
          const tm = /time=(\d+):(\d+):([\d.]+)/.exec(line)
          if (tm && span > 0) {
            const done = Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3])
            send({ pct: Math.min(0.99, 0.5 + (done / span) * 0.5), speed: '', eta: 'cortando…' })
          }
        }
      }
    )
    if (ac.signal.aborted) {
      await fs.rm(out, { force: true })
      return { error: 'download cancelado' }
    }
    if (r.code !== 0 || !existsSync(out)) {
      await fs.rm(out, { force: true })
      const why = r.err.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? `código ${r.code}`
      return { error: 'ffmpeg (corte do trecho): ' + why.slice(0, 300) }
    }
    return { path: out }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}
