import { absPath, clipEnd, envelopeAt, fileUrl, type Clip } from '../lib'

/** Picos por segundo usados pra desenhar a forma de onda. */
export const PEAKS_PER_SEC = 100

interface Loaded {
  buffer: AudioBuffer
  peaks: Float32Array
}

/**
 * Toca os clipes da timeline com Web Audio. A posição é derivada do relógio do AudioContext,
 * então o playhead fica sincronizado mesmo sem nenhuma música (só texto).
 */
export class AudioEngine {
  private ctx: AudioContext | null = null
  private cache = new Map<string, Promise<Loaded>>()
  private ready = new Map<string, Loaded>()
  private nodes: { src: AudioBufferSourceNode; gain: GainNode }[] = []
  private startedAt = 0
  private startPos = 0
  playing = false

  private context() {
    if (!this.ctx) this.ctx = new AudioContext()
    return this.ctx
  }

  get(path: string) {
    return this.ready.get(path)
  }

  load(c: Pick<Clip, 'path'>): Promise<Loaded> {
    let p = this.cache.get(c.path)
    if (!p) {
      p = (async () => {
        const res = await fetch(fileUrl(absPath({ id: '', name: '', path: c.path })))
        if (!res.ok) throw new Error(`Não achei o áudio ${c.path}`)
        const buffer = await this.context().decodeAudioData(await res.arrayBuffer())
        const loaded = { buffer, peaks: computePeaks(buffer) }
        this.ready.set(c.path, loaded)
        return loaded
      })()
      this.cache.set(c.path, p)
      p.catch(() => this.cache.delete(c.path))
    }
    return p
  }

  position() {
    return this.playing && this.ctx ? this.startPos + (this.ctx.currentTime - this.startedAt) : this.startPos
  }

  seek(t: number, clips: Clip[]) {
    const wasPlaying = this.playing
    this.stopNodes()
    this.playing = false
    this.startPos = Math.max(0, t)
    if (wasPlaying) this.play(clips)
  }

  /** Reagenda tudo (ex.: o usuário mexeu num clipe durante o play). */
  restart(clips: Clip[]) {
    if (this.playing) this.seek(this.position(), clips)
  }

  async play(clips: Clip[]) {
    const ctx = this.context()
    if (ctx.state === 'suspended') await ctx.resume()
    if (this.playing) this.startPos = this.position()
    this.stopNodes()
    const from = this.startPos
    const now = ctx.currentTime + 0.03
    this.startedAt = now
    this.playing = true

    for (const c of clips) {
      if (clipEnd(c) <= from) continue
      const loaded = this.ready.get(c.path)
      if (!loaded) continue
      const when = now + Math.max(0, c.start - from)
      const srcFrom = c.offset + Math.max(0, from - c.start)
      const dur = clipEnd(c) - Math.max(from, c.start)
      if (dur <= 0) continue

      const src = ctx.createBufferSource()
      src.buffer = loaded.buffer
      const gain = ctx.createGain()
      // automação do volume seguindo os keyframes (rampas lineares entre eles)
      gain.gain.setValueAtTime(c.gain * envelopeAt(c.keys, srcFrom), when)
      for (const k of c.keys) {
        if (k.t <= srcFrom || k.t >= srcFrom + dur) continue
        gain.gain.linearRampToValueAtTime(c.gain * k.v, when + (k.t - srcFrom))
      }
      src.connect(gain).connect(ctx.destination)
      src.start(when, srcFrom, dur)
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

function computePeaks(buffer: AudioBuffer) {
  const step = Math.max(1, Math.floor(buffer.sampleRate / PEAKS_PER_SEC))
  const n = Math.ceil(buffer.length / step)
  const peaks = new Float32Array(n)
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
  for (let i = 0; i < n; i++) {
    let max = 0
    const end = Math.min(buffer.length, (i + 1) * step)
    for (let s = i * step; s < end; s += 4) {
      for (const ch of chans) {
        const v = Math.abs(ch[s])
        if (v > max) max = v
      }
    }
    peaks[i] = max
  }
  return peaks
}
