import workletUrl from './recorder.worklet.js?url&no-inline'

/**
 * Hardware de áudio: qual microfone grava, por onde o som sai e o processamento do Windows.
 * Fica salvo neste PC (localStorage) e vale pro app inteiro.
 */

export interface AudioPrefs {
  /** deviceId do microfone ('' = padrão do Windows) */
  input: string
  /** deviceId da saída ('' = padrão do Windows) */
  output: string
  /** redução de ruído / cancelamento de eco / ganho automático do navegador (desligado = som cru, melhor pra narração) */
  processing: boolean
}

const KEY = 'typos.audio'
const DEFAULTS: AudioPrefs = { input: '', output: '', processing: false }

export function audioPrefs(): AudioPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setAudioPrefs(p: Partial<AudioPrefs>) {
  const next = { ...audioPrefs(), ...p }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* sem storage */
  }
  window.dispatchEvent(new CustomEvent('typos:audio-prefs', { detail: next }))
  return next
}

/** manda um AudioContext pra saída escolhida (e acompanha se mudar) */
export function followOutput(ctx: AudioContext) {
  const apply = (id: string) => {
    const c = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    c.setSinkId?.(id).catch(() => null)
  }
  if (audioPrefs().output) apply(audioPrefs().output)
  const on = (e: Event) => apply((e as CustomEvent<AudioPrefs>).detail.output)
  window.addEventListener('typos:audio-prefs', on)
  return () => window.removeEventListener('typos:audio-prefs', on)
}

/** a promessa resolve dentro do prazo? (false se rejeitar ou demorar) */
const within = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])

/** o relógio do contexto está andando? (só anda se a saída de som estiver viva) */
export async function ticking(ctx: BaseAudioContext & { resume(): Promise<void> }, ms = 500) {
  if (ctx.state === 'closed') return false
  if (ctx.state !== 'running' && !(await within(ctx.resume(), 1500))) return false
  const t0 = ctx.currentTime
  const end = performance.now() + ms
  while (performance.now() < end) {
    await new Promise((r) => setTimeout(r, 8))
    if (ctx.currentTime > t0) return true
  }
  return false
}

/**
 * AudioContext de tocar que se refaz quando a saída de som morre. Depois de horas aberto ou de uma
 * tarefa longa (o monitor dorme e leva junto o som do HDMI, o fone desconecta, o Windows troca ou
 * suspende o dispositivo), o Chromium deixa o contexto "running" com o relógio parado, ou o resume()
 * nunca volta: o play não tocava nem andava. Antes de tocar, `ready()` confere se o relógio anda e,
 * se não, fecha e abre outro (os AudioBuffers já decodificados servem no contexto novo).
 */
export class LiveAudio {
  private ctx: AudioContext | null = null
  private unfollow: (() => void) | null = null
  private failed = false

  /** `setup` monta o que fica pendurado no contexto (ex.: o limitador) a cada contexto novo */
  constructor(private setup?: (ctx: AudioContext) => void) {}

  /** o contexto atual, sem criar */
  get current() {
    return this.ctx
  }

  get() {
    if (!this.ctx) {
      const ctx = new AudioContext()
      this.ctx = ctx
      this.failed = false
      // o Chromium avisa quando o dispositivo de saída falha
      ctx.addEventListener('error', () => {
        if (this.ctx === ctx) this.failed = true
      })
      this.unfollow = followOutput(ctx)
      this.setup?.(ctx)
    }
    return this.ctx
  }

  /** contexto pronto pra tocar: tenta o atual e, se a saída morreu, um novo */
  async ready() {
    const cur = this.get()
    if (!this.failed && (await ticking(cur))) return cur
    if (this.ctx === cur) this.close()
    const ctx = this.get()
    await ticking(ctx)
    return ctx
  }

  close() {
    this.unfollow?.()
    this.unfollow = null
    this.ctx?.close().catch(() => null)
    this.ctx = null
  }
}

export async function listDevices() {
  // os nomes só aparecem depois que o app tem acesso ao microfone uma vez
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true })
    s.getTracks().forEach((t) => t.stop())
  } catch {
    /* sem permissão: lista sem nomes */
  }
  const all = await navigator.mediaDevices.enumerateDevices()
  const pick = (kind: MediaDeviceKind) =>
    all.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label || 'Dispositivo sem nome' }))
  return { inputs: pick('audioinput'), outputs: pick('audiooutput') }
}

export function micStream(p = audioPrefs()) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: p.input ? { exact: p.input } : undefined,
      channelCount: 1,
      echoCancellation: p.processing,
      noiseSuppression: p.processing,
      autoGainControl: p.processing
    }
  })
}

/** pico do sinal em dBFS (-∞..0) */
export function peakDb(an: AnalyserNode, buf: Float32Array<ArrayBuffer>) {
  an.getFloatTimeDomainData(buf)
  let m = 0
  for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]))
  return m > 0 ? 20 * Math.log10(m) : -120
}

/**
 * Grava o microfone em PCM (vira WAV 24 bits no fim). Dá o nível ao vivo pro medidor.
 * A captura roda num AudioWorklet (thread de áudio): a interface ocupada não faz perder pedaços,
 * que é o que dava os "pops" na gravação.
 */
export class Recorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private chunks: Float32Array[] = []
  private an: AnalyserNode | null = null
  private buf = new Float32Array(2048)
  sampleRate = 48000
  recording = false

  async open() {
    this.stream = await micStream()
    // grava na taxa do próprio microfone (sem reamostrar); buffer folgado (não é pra tocar)
    const rate = this.stream.getAudioTracks()[0]?.getSettings().sampleRate
    this.ctx = new AudioContext({ latencyHint: 'playback', ...(rate ? { sampleRate: rate } : {}) })
    this.sampleRate = this.ctx.sampleRate
    await this.ctx.audioWorklet.addModule(workletUrl)
    const src = this.ctx.createMediaStreamSource(this.stream)
    this.an = this.ctx.createAnalyser()
    this.an.fftSize = 2048
    src.connect(this.an)
    this.node = new AudioWorkletNode(this.ctx, 'typos-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' })
    this.node.port.onmessage = (e) => {
      if (e.data instanceof Float32Array) this.chunks.push(e.data)
    }
    src.connect(this.node)
  }

  start() {
    this.chunks = []
    this.recording = true
    this.node?.port.postMessage('start')
  }

  level() {
    return this.an ? peakDb(this.an, this.buf as Float32Array<ArrayBuffer>) : -120
  }

  /** para e devolve o WAV (espera o último pedaço sair da thread de áudio) */
  async stop(): Promise<{ wav: Uint8Array; duration: number }> {
    this.recording = false
    const node = this.node
    if (node)
      await new Promise<void>((done) => {
        const t = setTimeout(done, 1000)
        node.port.onmessage = (e) => {
          if (e.data instanceof Float32Array) this.chunks.push(e.data)
          else if (e.data === 'done') {
            clearTimeout(t)
            done()
          }
        }
        node.port.postMessage('stop')
      })
    const n = this.chunks.reduce((s, c) => s + c.length, 0)
    const pcm = new Float32Array(n)
    let o = 0
    for (const c of this.chunks) {
      pcm.set(c, o)
      o += c.length
    }
    this.chunks = []
    return { wav: encodeWav(pcm, this.sampleRate), duration: n / this.sampleRate }
  }

  close() {
    this.recording = false
    this.node?.disconnect()
    this.node = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.ctx?.close().catch(() => null)
    this.ctx = null
  }
}

/** WAV mono 24 bits */
export function encodeWav(pcm: Float32Array, rate: number) {
  const bytes = 3
  const data = pcm.length * bytes
  const out = new Uint8Array(44 + data)
  const v = new DataView(out.buffer)
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + data, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * bytes, true)
  v.setUint16(32, bytes, true)
  v.setUint16(34, 24, true)
  str(36, 'data')
  v.setUint32(40, data, true)
  let o = 44
  for (let i = 0; i < pcm.length; i++) {
    const x = Math.max(-1, Math.min(1, pcm[i]))
    const s = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff)
    out[o++] = s & 0xff
    out[o++] = (s >> 8) & 0xff
    out[o++] = (s >> 16) & 0xff
  }
  return out
}
