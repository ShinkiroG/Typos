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
 */
export class Recorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private proc: ScriptProcessorNode | null = null
  private chunks: Float32Array[] = []
  private an: AnalyserNode | null = null
  private buf = new Float32Array(2048)
  sampleRate = 48000
  recording = false

  async open() {
    this.stream = await micStream()
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.sampleRate = this.ctx.sampleRate
    const src = this.ctx.createMediaStreamSource(this.stream)
    this.an = this.ctx.createAnalyser()
    this.an.fftSize = 2048
    src.connect(this.an)
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1)
    this.proc.onaudioprocess = (e) => {
      if (this.recording) this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
    }
    src.connect(this.proc)
    // o processador só roda ligado em algo; a saída dele é silêncio
    this.proc.connect(this.ctx.destination)
  }

  start() {
    this.chunks = []
    this.recording = true
  }

  level() {
    return this.an ? peakDb(this.an, this.buf as Float32Array<ArrayBuffer>) : -120
  }

  /** para e devolve o WAV */
  stop(): { wav: Uint8Array; duration: number } {
    this.recording = false
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
    this.proc?.disconnect()
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
