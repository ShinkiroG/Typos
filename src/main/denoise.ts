import { app, ipcMain } from 'electron'
import { join } from 'path'
import { promises as fs, existsSync } from 'fs'
import { createHash } from 'crypto'
import { findFfmpeg, mediaCacheDir, proxyAudio, run } from './media'
import { wavPcm } from './soundProfile'
import { bestLag, denoiseArgs, denoiseFilter, DENOISE_V, loudestStart, noiseFloorDb, typicalLag, type DenoiseLevel } from './denoiseCore'
import model from './rnnoise/voz.rnnn?raw'

/**
 * Limpeza de ruído da Montagem: gera uma cópia limpa do áudio (WAV, no cache de mídia) e a prévia,
 * o render e a normalização usam ela no lugar do original. O arquivo do usuário não é tocado,
 * e desligar a limpeza volta pro original na hora.
 */

/** pasta do modelo da IA de voz (o ffmpeg roda dentro dela e lê o modelo pelo nome, sem caminho pra escapar) */
const modelDir = () => join(app.getPath('userData'), 'denoise')
const MODEL = 'voz.rnnn'

async function ensureModel() {
  const f = join(modelDir(), MODEL)
  if (existsSync(f) && (await fs.stat(f)).size === Buffer.byteLength(model)) return
  await fs.mkdir(modelDir(), { recursive: true })
  await fs.writeFile(f, model, 'utf8')
}

let hasRnn: boolean | undefined
async function rnnSupported(ffmpeg: string) {
  if (hasRnn === undefined) hasRnn = /\barnndn\b/.test((await run(ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 15000 })).out)
  return hasRnn
}

/** onde fica a cópia limpa de um arquivo numa intensidade (muda se o arquivo mudar) */
async function cleanPathOf(path: string, level: DenoiseLevel) {
  const st = await fs.stat(path)
  const key = createHash('sha1').update(`clean${DENOISE_V}-${level}|${path}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20)
  return join(mediaCacheDir(), key + '.wav')
}

/** atraso (s) que a cadeia põe no som, medido num trecho com fala do próprio arquivo */
async function measureLag(ffmpeg: string, path: string, filter: string, start: number, cwd: string) {
  const a = join(mediaCacheDir(), `lag-${process.pid}-${Date.now()}-a.wav`)
  const b = a.replace(/-a\.wav$/, '-b.wav')
  try {
    const cut = ['-hide_banner', '-nostdin', '-y', '-ss', start.toFixed(3), '-t', '4', '-i', path, '-vn', '-ac', '1']
    const r1 = await run(ffmpeg, [...cut, '-ar', '16000', '-c:a', 'pcm_s16le', a], { timeoutMs: 60000 })
    const r2 = await run(ffmpeg, [...cut, '-af', `${filter},aresample=16000`, '-ar', '16000', '-c:a', 'pcm_s16le', b], { timeoutMs: 60000, cwd })
    if (r1.code || r2.code) return null
    const x = wavPcm(await fs.readFile(a))
    const y = wavPcm(await fs.readFile(b))
    if (!x || !y) return null
    const lag = bestLag(x.pcm, y.pcm, 1600)
    return lag === null ? null : lag / 16000
  } finally {
    await fs.rm(a, { force: true }).catch(() => null)
    await fs.rm(b, { force: true }).catch(() => null)
  }
}

const pending = new Map<string, Promise<string | { error: string }>>()

/** caminho do áudio limpo (gera se ainda não tiver) */
export function cleanAudio(path: string, level: DenoiseLevel): Promise<string | { error: string }> {
  const id = `${level}|${path}`
  let p = pending.get(id)
  if (p) return p
  p = (async () => {
    const ff = await findFfmpeg()
    if (!ff) return { error: 'ffmpeg não encontrado' }
    if (!existsSync(path)) return { error: 'arquivo não encontrado: ' + path }
    const out = await cleanPathOf(path, level)
    if (existsSync(out)) return out
    await fs.mkdir(mediaCacheDir(), { recursive: true })
    // o ruído e onde está a fala saem da prévia (mono 32 kHz), que a Montagem já tem
    const proxy = await proxyAudio(path)
    if (typeof proxy !== 'string') return proxy
    const pcm = wavPcm(await fs.readFile(proxy))
    const noise = pcm ? noiseFloorDb(pcm.pcm, pcm.rate) : null
    const rnn = await rnnSupported(ff.ffmpeg)
    if (rnn) await ensureModel()
    const filter = denoiseFilter(level, noise, rnn ? MODEL : null)
    const cwd = modelDir()
    await fs.mkdir(cwd, { recursive: true })
    const lag = (pcm && (await measureLag(ff.ffmpeg, path, filter, loudestStart(pcm.pcm, pcm.rate, 4), cwd))) ?? typicalLag(level, rnn)
    const tmp = out + '.part.wav'
    const r = await run(ff.ffmpeg, denoiseArgs(path, tmp, filter, lag), { cwd })
    if (r.code !== 0 || !existsSync(tmp)) {
      await fs.rm(tmp, { force: true }).catch(() => null)
      return { error: 'o ffmpeg não conseguiu limpar o áudio: ' + r.err.split('\n').slice(-3).join(' ').slice(0, 200) }
    }
    await fs.rename(tmp, out)
    return out
  })()
  pending.set(id, p)
  p.finally(() => pending.delete(id))
  return p
}

export function initDenoise() {
  ipcMain.handle('media:clean', (_e, path: string, level: DenoiseLevel) => cleanAudio(path, level))
}
