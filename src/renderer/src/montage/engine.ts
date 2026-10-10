import { followOutput } from '../audio'
import { api, clipEndT, fileUrl, type MontageClip, type MontageData, type MontageMedia } from '../lib'

export const PEAKS_PER_SEC = 100

export interface LoadedAudio {
  buffer: AudioBuffer
  peaks: Float32Array
}

const dbToGain = (db = 0) => Math.pow(10, db / 20)

/** Trecho que um clipe realmente toca, já contando as Emendas (crossfade) com os vizinhos. */
export interface Span {
  clip: MontageClip
  /** início/fim na timeline e de onde o arquivo começa */
  t0: number
  t1: number
  src0: number
  /** rampas de entrada/saída (s) */
  fin: number
  fout: number
  gain: number
}

/** Emenda = crossfade centrado no corte: o clipe da esquerda estica x/2, o da direita começa x/2 antes. */
export function spans(data: MontageData, mediaDur: (id: string) => number): Span[] {
  const out: Span[] = []
  for (const tr of data.tracks) {
    if (tr.muted) continue
    const list = data.clips.filter((c) => c.track === tr.id).sort((a, b) => a.start - b.start)
    list.forEach((c, i) => {
      const prev = list[i - 1]
      const next = list[i + 1]
      const butted = (a: MontageClip | undefined, b: MontageClip | undefined) => !!a && !!b && Math.abs(clipEndT(a) - b.start) < 0.002
      // emenda com o anterior: começa antes usando o que sobra antes do "in"
      const xIn = butted(prev, c) && c.splice ? Math.min(c.splice / 2, c.in) : 0
      // emenda com o próximo: estica usando o que sobra depois do "out"
      const xOut = butted(c, next) && next!.splice ? Math.min(next!.splice / 2, Math.max(0, mediaDur(c.media) - c.out)) : 0
      out.push({
        clip: c,
        t0: c.start - xIn,
        t1: clipEndT(c) + xOut,
        src0: c.in - xIn,
        fin: Math.max(c.fadeIn ?? 0, xIn * 2),
        fout: Math.max(c.fadeOut ?? 0, xOut * 2),
        gain: dbToGain(c.gainDb)
      })
    })
  }
  return out
}

/** valor do envelope (0..1) num instante relativo ao começo do trecho */
const envAt = (s: Span, rel: number) => {
  const d = s.t1 - s.t0
  let v = 1
  if (s.fin > 0 && rel < s.fin) v = Math.min(v, rel / s.fin)
  if (s.fout > 0 && rel > d - s.fout) v = Math.min(v, (d - rel) / s.fout)
  return Math.max(0, v)
}

/**
 * Toca o áudio da Montagem (das prévias mono do ffmpeg) com corte exato, fades e Emendas.
 * O vídeo só acompanha o relógio daqui.
 */
export class MontageEngine {
  private ctx: AudioContext | null = null
  private master: DynamicsCompressorNode | null = null
  private loading = new Map<string, Promise<LoadedAudio | null>>()
  private ready = new Map<string, LoadedAudio>()
  private nodes: { src: AudioBufferSourceNode; gain: GainNode }[] = []
  private startedAt = 0
  private startPos = 0
  playing = false
  /** avisa quando uma prévia de áudio fica pronta (pra desenhar a onda) */
  onLoaded: (() => void) | null = null

  private context() {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      followOutput(this.ctx)
      // limitador (estilo broadcast): segura os picos depois da normalização, sem mexer no resto
      const lim = this.ctx.createDynamicsCompressor()
      lim.threshold.value = -1.5
      lim.knee.value = 0
      lim.ratio.value = 20
      lim.attack.value = 0.002
      lim.release.value = 0.12
      lim.connect(this.ctx.destination)
      this.master = lim
    }
    return this.ctx
  }

  get(mediaId: string) {
    return this.ready.get(mediaId)
  }

  load(m: MontageMedia): Promise<LoadedAudio | null> {
    if (!m.hasAudio) return Promise.resolve(null)
    let p = this.loading.get(m.id)
    if (!p) {
      p = (async () => {
        const proxy = await api.proxyAudio(m.path)
        if (typeof proxy !== 'string') throw new Error(proxy.error)
        const res = await fetch(fileUrl(proxy))
        const buffer = await this.context().decodeAudioData(await res.arrayBuffer())
        const loaded = { buffer, peaks: computePeaks(buffer) }
        this.ready.set(m.id, loaded)
        this.onLoaded?.()
        return loaded
      })()
      this.loading.set(m.id, p)
      p.catch(() => this.loading.delete(m.id))
    }
    return p
  }

  position() {
    return this.playing && this.ctx ? this.startPos + (this.ctx.currentTime - this.startedAt) : this.startPos
  }

  seek(t: number, data: MontageData, dur: (id: string) => number) {
    const was = this.playing
    this.stopNodes()
    this.playing = false
    this.startPos = Math.max(0, t)
    if (was) this.play(data, dur)
  }

  restart(data: MontageData, dur: (id: string) => number) {
    if (this.playing) this.seek(this.position(), data, dur)
  }

  async play(data: MontageData, dur: (id: string) => number) {
    const ctx = this.context()
    if (ctx.state === 'suspended') await ctx.resume()
    if (this.playing) this.startPos = this.position()
    this.stopNodes()
    const from = this.startPos
    const now = ctx.currentTime + 0.04
    this.startedAt = now
    this.playing = true

    for (const s of spans(data, dur)) {
      if (s.t1 <= from) continue
      const loaded = this.ready.get(s.clip.media)
      if (!loaded) continue
      const rel0 = Math.max(0, from - s.t0)
      const when = now + Math.max(0, s.t0 - from)
      const srcFrom = s.src0 + rel0
      const len = s.t1 - s.t0 - rel0
      if (len <= 0 || srcFrom >= loaded.buffer.duration) continue

      const src = ctx.createBufferSource()
      src.buffer = loaded.buffer
      const gain = ctx.createGain()
      const g = gain.gain
      g.setValueAtTime(s.gain * envAt(s, rel0), when)
      const d = s.t1 - s.t0
      // pontos do envelope: fim do fade de entrada e começo do de saída
      for (const p of [s.fin, d - s.fout, d]) {
        if (p <= rel0 || p > d) continue
        g.linearRampToValueAtTime(s.gain * envAt(s, p), when + (p - rel0))
      }
      src.connect(gain).connect(this.master ?? ctx.destination)
      src.start(when, srcFrom, len)
      this.nodes.push({ src, gain })
    }
  }

  pause() {
    this.startPos = this.position()
    this.stopNodes()
    this.playing = false
  }

  private stopNodes() {
    for (const n of this.nodes) {
      try {
        n.src.stop()
      } catch {
        /* já parado */
      }
      n.src.disconnect()
      n.gain.disconnect()
    }
    this.nodes = []
  }

  dispose() {
    this.stopNodes()
    this.playing = false
    this.ctx?.close()
  }
}

export function computePeaks(buffer: AudioBuffer) {
  const step = Math.max(1, Math.floor(buffer.sampleRate / PEAKS_PER_SEC))
  const n = Math.ceil(buffer.length / step)
  const peaks = new Float32Array(n)
  const ch = buffer.getChannelData(0)
  for (let i = 0; i < n; i++) {
    let max = 0
    const end = Math.min(buffer.length, (i + 1) * step)
    for (let s = i * step; s < end; s += 2) {
      const v = Math.abs(ch[s])
      if (v > max) max = v
    }
    peaks[i] = max
  }
  return peaks
}
