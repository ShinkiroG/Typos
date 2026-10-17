/**
 * Perfil de um som (efeito ou trilha) pro Claude saber usar sem ouvir: onde está o impacto, quando
 * começa e some, o volume e uma curva de energia em dígitos. Parte do PCM mono 16 bits.
 */

export interface SoundProfile {
  duration: number
  /** começo audível (s): onde o som passa de -20 dB do máximo */
  attack: number
  /** o momento mais forte (s), o "impacto" */
  peakAt: number
  /** onde ele praticamente some (s): último trecho acima de -30 dB do máximo */
  tail: number
  /** pico de amostra (dBFS) */
  peakDb: number
  /** volume percebido (LUFS integrado), quando o ffmpeg mediu */
  lufs?: number
  /** energia de 0 a 9, um dígito a cada `step` segundos */
  env: string
  step: number
}

const FRAME = 0.01
const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -120)

/** passo da curva de energia: sons curtos em décimos, trilhas em segundos (no máximo ~100 dígitos) */
export function envStep(duration: number) {
  for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10]) if (duration / s <= 100) return s
  return Math.ceil(duration / 100)
}

export function profileFromPcm(pcm: Int16Array, rate: number): SoundProfile | null {
  const duration = pcm.length / rate
  const n = Math.floor(pcm.length / (rate * FRAME))
  if (n < 1) return null
  const per = Math.floor(rate * FRAME)
  const rms = new Float64Array(n)
  let peak = 0
  for (let f = 0; f < n; f++) {
    let sum = 0
    for (let i = f * per; i < (f + 1) * per; i++) {
      const v = pcm[i] / 32768
      sum += v * v
      const a = Math.abs(v)
      if (a > peak) peak = a
    }
    rms[f] = db(Math.sqrt(sum / per))
  }
  let top = 0
  for (let f = 1; f < n; f++) if (rms[f] > rms[top]) top = f
  const max = rms[top]
  if (max <= -90) return null
  let attack = 0
  while (attack < n - 1 && rms[attack] < max - 20) attack++
  let tail = n - 1
  while (tail > 0 && rms[tail] < max - 30) tail--
  const step = envStep(duration)
  const per2 = Math.max(1, Math.round(step / FRAME))
  let env = ''
  for (let f = 0; f < n; f += per2) {
    let m = -120
    for (let k = f; k < Math.min(n, f + per2); k++) m = Math.max(m, rms[k])
    env += String(Math.max(0, Math.min(9, Math.round(((m - (max - 40)) / 40) * 9))))
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  return { duration: r3(duration), attack: r3(attack * FRAME), peakAt: r3((top + 0.5) * FRAME), tail: r3((tail + 1) * FRAME), peakDb: Math.round(db(peak) * 10) / 10, env, step }
}

/** PCM 16 bits de um WAV (o proxy do Typos: mono 32 kHz) */
export function wavPcm(buf: Buffer): { pcm: Int16Array; rate: number } | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let rate = 0
  let channels = 1
  let bits = 16
  for (let p = 12; p + 8 <= buf.length; ) {
    const id = buf.toString('ascii', p, p + 4)
    const size = buf.readUInt32LE(p + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(p + 10)
      rate = buf.readUInt32LE(p + 12)
      bits = buf.readUInt16LE(p + 22)
    } else if (id === 'data') {
      if (!rate || bits !== 16) return null
      const end = Math.min(buf.length, p + 8 + size)
      const all = new Int16Array(buf.buffer.slice(buf.byteOffset + p + 8, buf.byteOffset + end - ((end - p - 8) % 2)))
      if (channels === 1) return { pcm: all, rate }
      const mono = new Int16Array(Math.floor(all.length / channels))
      for (let i = 0; i < mono.length; i++) mono[i] = all[i * channels]
      return { pcm: mono, rate }
    }
    p += 8 + size + (size % 2)
  }
  return null
}
