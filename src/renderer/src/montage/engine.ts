import { LiveAudio } from '../audio'
import { api, audioPath, clipEndT, fileUrl, type FadeCurve, type MontageClip, type MontageData, type MontageMedia } from '../lib'

export const PEAKS_PER_SEC = 100

export interface LoadedAudio {
  buffer: AudioBuffer
  peaks: Float32Array
}

const dbToGain = (db = 0) => Math.pow(10, db / 20)

/** Trecho que um clipe realmente toca, já contando os crossfades com os vizinhos. */
export interface Span {
  clip: MontageClip
  /** início/fim na timeline e de onde o arquivo começa */
  t0: number
  t1: number
  src0: number
  /** meia-duração dos crossfades de entrada/saída (s): o trecho começa xIn antes do corte */
  xIn: number
  xOut: number
  gain: number
}

const LINEAR: FadeCurve = [0.5, 0.5]

/** x da bezier quadrática (0,0)→(cx,·)→(1,·) volta pro t */
function solveT(cx: number, x: number) {
  const a = 1 - 2 * cx
  const b = 2 * cx
  if (Math.abs(a) < 1e-6) return b ? x / b : x
  return (-b + Math.sqrt(Math.max(0, b * b + 4 * a * x))) / (2 * a)
}

/** volume do fade de entrada no progresso p (0..1), seguindo a curva */
export function fadeInGain(curve: FadeCurve | undefined, p: number) {
  if (p <= 0) return 0
  if (p >= 1) return 1
  const [cx, cy] = curve ?? LINEAR
  const t = solveT(cx, p)
  return Math.max(0, Math.min(1, 2 * t * (1 - t) * cy + t * t))
}

/** volume do fade de saída no progresso p (0 = começo do fade, 1 = fim) */
export function fadeOutGain(curve: FadeCurve | undefined, p: number) {
  if (p <= 0) return 1
  if (p >= 1) return 0
  const [cx, cy] = curve ?? LINEAR
  const t = solveT(cx, p)
  return Math.max(0, Math.min(1, (1 - t) * (1 - t) + 2 * t * (1 - t) * cy))
}

/** colados: o fim de um é o começo do outro */
export const butted = (a: MontageClip | undefined, b: MontageClip | undefined) => !!a && !!b && Math.abs(clipEndT(a) - b.start) < 0.002

/**
 * Meia-duração real do crossfade entre prev e c (s). O crossfade é centrado no corte e usa o
 * que sobra do arquivo antes do "in" de c e depois do "out" de prev: se um lado não tem sobra,
 * o crossfade encolhe pros dois (fica simétrico, sem buraco no volume).
 */
export function xfadeHalf(prev: MontageClip | undefined, c: MontageClip, mediaDur: (id: string) => number) {
  if (!c.splice || !butted(prev, c)) return 0
  return Math.max(0, Math.min(c.splice / 2, c.in, mediaDur(prev!.media) - prev!.out))
}

/** clipes de cada faixa (ligada), em ordem */
function byTrack(data: MontageData) {
  return data.tracks.filter((t) => !t.muted).map((tr) => data.clips.filter((c) => c.track === tr.id).sort((a, b) => a.start - b.start))
}

export function spans(data: MontageData, mediaDur: (id: string) => number): Span[] {
  const out: Span[] = []
  for (const list of byTrack(data)) {
    list.forEach((c, i) => {
      const xIn = xfadeHalf(list[i - 1], c, mediaDur)
      const xOut = list[i + 1] ? xfadeHalf(c, list[i + 1], mediaDur) : 0
      out.push({ clip: c, t0: c.start - xIn, t1: clipEndT(c) + xOut, src0: c.in - xIn, xIn, xOut, gain: dbToGain(c.gainDb) })
    })
  }
  return out
}

/** valor do envelope (0..1) num instante relativo ao começo do trecho */
export function envAt(s: Span, rel: number) {
  const c = s.clip
  const d = s.t1 - s.t0
  const dur = c.out - c.in
  let v = 1
  if (s.xIn > 0) v *= Math.min(1, Math.max(0, rel / (2 * s.xIn)))
  if (s.xOut > 0) v *= Math.min(1, Math.max(0, (d - rel) / (2 * s.xOut)))
  // fades do próprio clipe contam a partir das bordas dele (não do crossfade)
  const r = rel - s.xIn
  if (c.fadeIn) v *= fadeInGain(c.fadeInCurve, r / c.fadeIn)
  if (c.fadeOut) v *= fadeOutGain(c.fadeOutCurve, (r - (dur - c.fadeOut)) / c.fadeOut)
  return v
}

/** instantes (relativos ao trecho) onde o envelope muda: rampas lineares entre eles seguem a curva */
export function envPoints(s: Span) {
  const c = s.clip
  const d = s.t1 - s.t0
  const dur = c.out - c.in
  const pts = [0, d]
  const region = (a: number, b: number, n: number) => {
    for (let i = 0; i <= n; i++) pts.push(a + ((b - a) * i) / n)
  }
  if (s.xIn) region(0, 2 * s.xIn, 1)
  if (s.xOut) region(d - 2 * s.xOut, d, 1)
  if (c.fadeIn) region(s.xIn, s.xIn + c.fadeIn, 24)
  if (c.fadeOut) region(s.xIn + dur - c.fadeOut, s.xIn + dur, 24)
  return [...new Set(pts.filter((p) => p >= 0 && p <= d))].sort((a, b) => a - b)
}

/**
 * Toca o áudio da Montagem (das prévias mono do ffmpeg) com corte exato, fades e crossfades.
 * O vídeo só acompanha o relógio daqui.
 */
export class MontageEngine {
  private master: DynamicsCompressorNode | null = null
  private audio = new LiveAudio((ctx) => {
    // limitador (estilo broadcast): segura os picos depois da normalização, sem mexer no resto
    const lim = ctx.createDynamicsCompressor()
    lim.threshold.value = -1.5
    lim.knee.value = 0
    lim.ratio.value = 20
    lim.attack.value = 0.002
    lim.release.value = 0.12
    lim.connect(ctx.destination)
    this.master = lim
  })
  private loading = new Map<string, Promise<LoadedAudio | null>>()
  private ready = new Map<string, LoadedAudio>()
  /** a versão da prévia que cada mídia quer agora (arquivo + limpeza) */
  private want = new Map<string, string>()
  private nodes: { src: AudioBufferSourceNode; gain: GainNode }[] = []
  private startedAt = 0
  private startPos = 0
  /** play esperando a saída de som ficar pronta (pause/seek no meio cancelam) */
  private pending: object | null = null
  playing = false
  /** avisa quando uma prévia de áudio fica pronta (pra desenhar a onda) */
  onLoaded: (() => void) | null = null

  get(mediaId: string) {
    return this.ready.get(mediaId)
  }

  /** carrega a prévia; com a limpeza de ruído ou os picos ligados, a da cópia tratada (trocar recarrega) */
  load(m: MontageMedia): Promise<LoadedAudio | null> {
    if (!m.hasAudio) return Promise.resolve(null)
    const key = `${m.id}|${m.path}|${m.denoise ?? 0}|${m.peaks ?? 0}`
    let p = this.loading.get(key)
    if (!p) {
      p = (async () => {
        const src = await audioPath(m)
        if (typeof src !== 'string') throw new Error(src.error)
        const proxy = await api.proxyAudio(src)
        if (typeof proxy !== 'string') throw new Error(proxy.error)
        const res = await fetch(fileUrl(proxy))
        const buffer = await this.audio.get().decodeAudioData(await res.arrayBuffer())
        return { buffer, peaks: computePeaks(buffer) }
      })()
      this.loading.set(key, p)
      p.catch(() => this.loading.delete(key))
    }
    this.want.set(m.id, key)
    // só vale se ninguém trocou a limpeza enquanto carregava
    p.then(
      (l) => {
        if (!l || this.want.get(m.id) !== key || this.ready.get(m.id) === l) return
        this.ready.set(m.id, l)
        this.onLoaded?.()
      },
      () => null
    )
    return p
  }

  position() {
    const ctx = this.audio.current
    return this.playing && ctx ? this.startPos + (ctx.currentTime - this.startedAt) : this.startPos
  }

  seek(t: number, data: MontageData, dur: (id: string) => number) {
    const was = this.playing || !!this.pending
    this.pending = null
    this.stopNodes()
    this.playing = false
    this.startPos = Math.max(0, t)
    if (was) this.play(data, dur)
  }

  restart(data: MontageData, dur: (id: string) => number) {
    if (this.playing) this.seek(this.position(), data, dur)
  }

  async play(data: MontageData, dur: (id: string) => number) {
    if (this.playing) this.startPos = this.position()
    this.stopNodes()
    this.playing = false
    const me = {}
    this.pending = me
    const ctx = await this.audio.ready()
    if (this.pending !== me) return
    this.pending = null
    const from = this.startPos
    const now = ctx.currentTime + 0.04
    this.startedAt = now
    this.playing = true

    for (const s of spans(data, dur)) {
      if (s.t1 <= from || s.clip.audioOff) continue
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
      for (const p of envPoints(s)) {
        if (p <= rel0 || p > d) continue
        g.linearRampToValueAtTime(s.gain * envAt(s, p), when + (p - rel0))
      }
      src.connect(gain).connect(this.master ?? ctx.destination)
      src.start(when, srcFrom, len)
      this.nodes.push({ src, gain })
    }
  }

  pause() {
    this.pending = null
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
    this.pending = null
    this.stopNodes()
    this.playing = false
    this.audio.close()
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
