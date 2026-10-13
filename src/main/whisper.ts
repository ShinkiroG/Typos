import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { promises as fs, existsSync, createWriteStream } from 'fs'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { findFfmpeg, proxyAudio, proxyPathOf, probe, run, mediaCacheDir } from './media'
import { loadSettings, saveSettings } from './settings'

/**
 * Transcrição local (Whisper via filtro do ffmpeg) pra o corte automático da narração.
 * Os modelos vêm do repositório oficial do whisper.cpp e ficam em userData/whisper.
 */

const HF = 'https://huggingface.co'
export const MODELS = [
  { id: 'large-v3', label: 'large-v3 · mais completo', file: 'ggml-large-v3.bin', mb: 3095 },
  { id: 'large-v3-turbo', label: 'large-v3-turbo · quase igual, bem mais rápido', file: 'ggml-large-v3-turbo.bin', mb: 1624 },
  { id: 'small', label: 'small · leve', file: 'ggml-small.bin', mb: 488 }
] as const
const VAD = { file: 'ggml-silero-v5.1.2.bin', url: `${HF}/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin` }

const dir = () => join(app.getPath('userData'), 'whisper')
const modelUrl = (file: string) => `${HF}/ggerganov/whisper.cpp/resolve/main/${file}`

/** caminho pro filtro do ffmpeg: dois níveis de escape (opção dentro do filtergraph) */
const esc = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\\\:')

async function download(url: string, dest: string, onPct: (p: number) => void) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download falhou (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0
  let last = 0
  const tmp = dest + '.part'
  const body = Readable.fromWeb(res.body as any)
  body.on('data', (c: Buffer) => {
    got += c.length
    const now = Date.now()
    if (total && now - last > 300) {
      last = now
      onPct(got / total)
    }
  })
  await fs.mkdir(dir(), { recursive: true })
  await pipeline(body, createWriteStream(tmp))
  await fs.rename(tmp, dest)
}

export interface Word {
  s: number
  e: number
  w: string
}

let downloading: Promise<unknown> | null = null

export function initWhisper() {
  ipcMain.handle('whisper:status', async () => {
    const s = await loadSettings()
    return {
      model: s.whisperModel ?? 'large-v3',
      models: MODELS.map((m) => ({ ...m, ready: existsSync(join(dir(), m.file)) })),
      vad: existsSync(join(dir(), VAD.file)),
      downloading: !!downloading
    }
  })

  ipcMain.handle('whisper:setModel', (_e, id: string) => saveSettings({ whisperModel: id }))

  ipcMain.handle('whisper:download', async (e, id: string) => {
    const m = MODELS.find((x) => x.id === id)
    if (!m) return { error: 'modelo desconhecido' }
    if (downloading) return { error: 'já tem um download em andamento' }
    const send = (pct: number) => !e.sender.isDestroyed() && e.sender.send('whisper:progress', { stage: 'download', pct })
    downloading = (async () => {
      if (!existsSync(join(dir(), VAD.file))) await download(VAD.url, join(dir(), VAD.file), () => null)
      if (!existsSync(join(dir(), m.file))) await download(modelUrl(m.file), join(dir(), m.file), send)
    })()
    try {
      await downloading
      return { ok: true }
    } catch (err) {
      return { error: 'Não deu pra baixar o modelo: ' + (err as Error).message }
    } finally {
      downloading = null
    }
  })

  ipcMain.handle('whisper:transcribe', (_e, path: string, lang: string) => transcribe(path, lang))
  ipcMain.handle('media:silences', (_e, path: string) => silences(path))

  // fila em segundo plano: ler (e guardar) o áudio antes de precisar
  ipcMain.handle('whisper:queue', (_e, paths: string[], lang: string) => {
    for (const p of paths) void transcribe(p, lang)
  })
  ipcMain.handle('whisper:cached', async (_e, paths: string[], lang: string) => {
    const out: Record<string, boolean> = {}
    for (const p of paths) out[p] = !!(await cacheFile(p, lang).catch(() => null))?.hit
    return out
  })
  ipcMain.handle('whisper:jobs', () => snapshot())
  ipcMain.handle('whisper:cancel', (_e, path?: string, lang?: string) => cancel(path, lang))
  ipcMain.handle('whisper:clear', () => {
    for (const [k, j] of jobs) if (j.state === 'error') jobs.delete(k)
    broadcast()
  })
  ipcMain.handle('whisper:parallel', async (_e, n?: number) => {
    if (n) {
      parallel = Math.max(1, Math.min(4, Math.round(n)))
      await saveSettings({ whisperParallel: parallel })
      pump()
    }
    return parallel
  })
  loadSettings().then((s) => {
    parallel = s.whisperParallel ?? 2
  })
}

// ---------- fila de transcrição ----------
type Result = { words: Word[] } | { error: string }
export interface JobInfo {
  path: string
  lang: string
  state: 'queued' | 'running' | 'done' | 'error'
  /** 'audio' = extraindo o áudio, 'model' = carregando o modelo, 'listen' = transcrevendo (pct vale) */
  stage: 'audio' | 'model' | 'listen' | null
  pct: number
  /** quando começou a transcrever de fato (pra estimar o tempo que falta) */
  since?: number
  error?: string
}
interface Job extends JobInfo {
  promise: Promise<Result>
  resolve: (r: Result) => void
  ac: AbortController
}

const jobs = new Map<string, Job>()
let parallel = 2
let running = 0
const jobKey = (path: string, lang: string) => `${path}|${lang}`

const snapshot = (): JobInfo[] => [...jobs.values()].map(({ path, lang, state, stage, pct, since, error }) => ({ path, lang, state, stage, pct, since, error }))

let timer: NodeJS.Timeout | null = null
/** manda o estado da fila pra todas as janelas (no máximo ~4x por segundo) */
function broadcast(now = true) {
  if (!now) {
    if (!timer) timer = setTimeout(() => broadcast(), 250)
    return
  }
  if (timer) clearTimeout(timer)
  timer = null
  const list = snapshot()
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('whisper:jobs', list)
}

function pump() {
  for (const j of jobs.values()) {
    if (running >= parallel) break
    if (j.state === 'queued') void start(j)
  }
}

async function start(j: Job) {
  running++
  j.state = 'running'
  j.stage = 'audio'
  broadcast()
  let r: Result
  try {
    r = await transcribeNow(j.path, j.lang, j.ac.signal, (stage, pct) => {
      if (stage === 'listen' && !j.since) j.since = Date.now()
      j.stage = stage
      j.pct = pct
      broadcast(false)
    })
  } catch (err) {
    r = { error: (err as Error).message }
  }
  running--
  if (j.ac.signal.aborted) r = { error: 'Cancelado.' }
  if ('error' in r) {
    j.state = 'error'
    j.error = r.error
  } else j.state = 'done'
  j.pct = 1
  j.stage = null
  j.resolve(r)
  // cancelado some da lista; o resto fica (o renderer sabe que terminou)
  if (j.ac.signal.aborted) jobs.delete(jobKey(j.path, j.lang))
  pump()
  broadcast()
}

function cancel(path?: string, lang?: string) {
  for (const [k, j] of jobs) {
    if (path && (j.path !== path || (lang && j.lang !== lang))) continue
    if (j.state === 'queued') {
      jobs.delete(k)
      j.resolve({ error: 'Cancelado.' })
    } else if (j.state === 'running') j.ac.abort()
  }
  broadcast()
}

/**
 * Palavras com tempo (s) de um arquivo de narração. Fica em cache por arquivo+modelo+idioma.
 * Quem pede o mesmo arquivo enquanto ele está sendo lido espera a mesma leitura; vários arquivos
 * são lidos em paralelo (até `parallel`), o resto espera na fila.
 */
export async function transcribe(path: string, lang: string): Promise<Result> {
  const c = await cacheFile(path, lang).catch(() => null)
  if (c?.hit) return { words: JSON.parse(await fs.readFile(c.file, 'utf8')) }
  const k = jobKey(path, lang)
  const cur = jobs.get(k)
  if (cur && (cur.state === 'queued' || cur.state === 'running')) return cur.promise
  let resolve!: (r: Result) => void
  const promise = new Promise<Result>((res) => (resolve = res))
  const j: Job = { path, lang, state: 'queued', stage: null, pct: 0, promise, resolve, ac: new AbortController() }
  jobs.delete(k) // reentra no fim da fila
  jobs.set(k, j)
  pump()
  broadcast()
  return promise
}

async function currentModel() {
  const s = await loadSettings()
  return MODELS.find((x) => x.id === (s.whisperModel ?? 'large-v3')) ?? MODELS[0]
}

/** o arquivo de cache da transcrição (pelo áudio de prévia, que só existe depois de gerado) */
async function cacheFile(path: string, lang: string, proxy?: string) {
  const m = await currentModel()
  proxy ??= await proxyPathOf(path)
  if (!existsSync(proxy)) return { file: '', hit: false }
  const st = await fs.stat(proxy)
  const key = createHash('sha1').update(`${proxy}|${st.size}|${m.id}|${lang}|v2`).digest('hex').slice(0, 20)
  const file = join(mediaCacheDir(), key + '.words.json')
  return { file, key, hit: existsSync(file) }
}

async function transcribeNow(path: string, lang: string, signal: AbortSignal, onStage: (stage: 'audio' | 'model' | 'listen', pct: number) => void): Promise<Result> {
  const ff = await findFfmpeg()
  if (!ff) return { error: 'ffmpeg não encontrado' }
  const m = await currentModel()
  const model = join(dir(), m.file)
  if (!existsSync(model)) return { error: `O modelo ${m.id} ainda não foi baixado.` }
  if (!existsSync(path)) return { error: 'Arquivo não encontrado: ' + path }
  onStage('audio', 0)
  const proxy = await proxyAudio(path)
  if (typeof proxy !== 'string') return proxy
  if (signal.aborted) return { error: 'Cancelado.' }
  const c = await cacheFile(path, lang, proxy)
  const key = c.key!
  const cache = c.file
  if (c.hit) return { words: JSON.parse(await fs.readFile(cache, 'utf8')) }
  onStage('model', 0)

  const info = await probe(proxy)
  const total = 'error' in info ? 0 : info.duration
  const out = join(mediaCacheDir(), key + '.whisper.jsonl')
  await fs.rm(out, { force: true })
  const vad = join(dir(), VAD.file)
  const opts = [
    `model=${esc(model)}`,
    `language=${lang}`,
    'queue=20',
    `destination=${esc(out)}`,
    'format=json',
    'max_len=1',
    ...(existsSync(vad) ? [`vad_model=${esc(vad)}`] : [])
  ]
  // cada rodada do Whisper = um trecho de fala que o VAD achou; guarda onde a fala começa/termina nele
  const runs: { at: number; vs: number; ve: number }[] = []
  let seg = { vs: 0, ve: 0 }
  const r = await run(ff.ffmpeg, ['-hide_banner', '-nostats', '-y', '-i', proxy, '-af', `aresample=16000,whisper=${opts.join(':')}`, '-f', 'null', '-'], {
    signal,
    onErr: (line) => {
      const v = /VAD detected \d+ segments?, start: (\d+) ms, end: (\d+) ms/.exec(line)
      if (v) seg = { vs: Number(v[1]) / 1000, ve: Number(v[2]) / 1000 }
      const at = /run transcription at (\d+) ms/.exec(line)
      if (at) runs.push({ at: Number(at[1]) / 1000, ...seg })
      if (!at || !total) return
      onStage('listen', Math.min(0.99, Number(at[1]) / 1000 / total))
    }
  })
  if (signal.aborted) return { error: 'Cancelado.' }
  if (r.code !== 0) return { error: 'O Whisper falhou: ' + r.err.split('\n').slice(-4).join(' ').slice(0, 300) }
  const words: Word[] = []
  // O filtro devolve os tempos de cada rodada a partir do começo dela, "esticando" as primeiras palavras
  // por cima do silêncio inicial. Os limites do VAD são exatos: remapeia [0, fim] → [início da fala, fim].
  let k = 0
  const fix = (t: number) => {
    const R = runs[k]
    if (!R || R.ve <= 0) return t
    const rel = Math.min(Math.max(t - R.at, 0), R.ve)
    return R.at + R.vs + (rel * (R.ve - R.vs)) / R.ve
  }
  for (const line of (await fs.readFile(out, 'utf8').catch(() => '')).split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      const w = String(j.text ?? '').trim()
      const s0 = j.start / 1000
      while (k + 1 < runs.length && s0 >= runs[k + 1].at - 0.001) k++
      // texto inventado no silêncio do fim (o Whisper às vezes "legenda" o nada)
      const s = fix(s0)
      if (total && s > total - 0.05) continue
      if (w) words.push({ s, e: Math.min(fix(j.end / 1000), total || Infinity), w })
    } catch {
      /* linha quebrada */
    }
  }
  await fs.writeFile(cache, JSON.stringify(words))
  return { words }
}

/** trechos de silêncio [início, fim] (s): é onde o corte fica limpo */
async function silences(path: string): Promise<[number, number][] | { error: string }> {
  const ff = await findFfmpeg()
  if (!ff) return { error: 'ffmpeg não encontrado' }
  const proxy = await proxyAudio(path)
  if (typeof proxy !== 'string') return proxy
  const r = await run(ff.ffmpeg, ['-hide_banner', '-nostats', '-i', proxy, '-af', 'silencedetect=noise=-38dB:d=0.18', '-f', 'null', '-'])
  const out: [number, number][] = []
  let start: number | null = null
  for (const m of r.err.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    if (m[1] === 'start') start = Math.max(0, Number(m[2]))
    else if (start !== null) {
      out.push([start, Number(m[2])])
      start = null
    }
  }
  if (start !== null) out.push([start, Number.MAX_SAFE_INTEGER])
  return out
}
