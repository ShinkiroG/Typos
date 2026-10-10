import { app, ipcMain, type WebContents } from 'electron'
import { join } from 'path'
import { promises as fs, existsSync, createWriteStream } from 'fs'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { findFfmpeg, proxyAudio, probe, run, mediaCacheDir } from './media'
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

  ipcMain.handle('whisper:transcribe', (e, path: string, lang: string) => transcribe(e.sender, path, lang))
  ipcMain.handle('media:silences', (_e, path: string) => silences(path))
}

/** Palavras com tempo (s) de um arquivo de narração. Fica em cache por arquivo+modelo+idioma. */
async function transcribe(sender: WebContents, path: string, lang: string): Promise<{ words: Word[] } | { error: string }> {
  const ff = await findFfmpeg()
  if (!ff) return { error: 'ffmpeg não encontrado' }
  const s = await loadSettings()
  const m = MODELS.find((x) => x.id === (s.whisperModel ?? 'large-v3')) ?? MODELS[0]
  const model = join(dir(), m.file)
  if (!existsSync(model)) return { error: `O modelo ${m.id} ainda não foi baixado.` }
  const proxy = await proxyAudio(path)
  if (typeof proxy !== 'string') return proxy
  const st = await fs.stat(proxy)
  const key = createHash('sha1').update(`${proxy}|${st.size}|${m.id}|${lang}|v2`).digest('hex').slice(0, 20)
  const cache = join(mediaCacheDir(), key + '.words.json')
  if (existsSync(cache)) return { words: JSON.parse(await fs.readFile(cache, 'utf8')) }

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
    onErr: (line) => {
      const v = /VAD detected \d+ segments?, start: (\d+) ms, end: (\d+) ms/.exec(line)
      if (v) seg = { vs: Number(v[1]) / 1000, ve: Number(v[2]) / 1000 }
      const at = /run transcription at (\d+) ms/.exec(line)
      if (at) runs.push({ at: Number(at[1]) / 1000, ...seg })
      if (at && total && !sender.isDestroyed()) sender.send('whisper:progress', { stage: 'transcribe', path, pct: Math.min(0.99, Number(at[1]) / 1000 / total) })
    }
  })
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
