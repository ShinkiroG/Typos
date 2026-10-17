import { describe, expect, it } from 'vitest'
import { envStep, profileFromPcm, wavPcm } from '../soundProfile'

const RATE = 8000
/** silêncio, um estouro curto em 0,5 s que decai, e silêncio */
function hit(len = 1.2, at = 0.5) {
  const pcm = new Int16Array(Math.round(len * RATE))
  for (let i = Math.round(at * RATE); i < pcm.length; i++) {
    const t = i / RATE - at
    pcm[i] = Math.round(Math.sin(i * 0.3) * 20000 * Math.exp(-t * 12))
  }
  return pcm
}

function wav(pcm: Int16Array, rate: number) {
  const b = Buffer.alloc(44 + pcm.length * 2)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(36 + pcm.length * 2, 4)
  b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(pcm.length * 2, 40)
  Buffer.from(pcm.buffer).copy(b, 44)
  return b
}

describe('perfil de som', () => {
  it('acha o começo, o impacto e o fim de um efeito', () => {
    const p = profileFromPcm(hit(), RATE)!
    expect(p.duration).toBeCloseTo(1.2, 2)
    expect(p.attack).toBeGreaterThanOrEqual(0.49)
    expect(p.attack).toBeLessThanOrEqual(0.51)
    expect(p.peakAt).toBeGreaterThanOrEqual(0.49)
    expect(p.peakAt).toBeLessThanOrEqual(0.53)
    expect(p.tail).toBeGreaterThan(0.6)
    expect(p.tail).toBeLessThan(1.1)
    expect(p.peakDb).toBeLessThan(0)
    expect(p.step).toBe(0.1)
    expect(p.env.length).toBe(12)
    expect(p.env.slice(0, 5)).toBe('00000')
    expect(p.env[5]).toBe('9')
  })
  it('silêncio não tem perfil', () => {
    expect(profileFromPcm(new Int16Array(RATE), RATE)).toBeNull()
  })
  it('trilha longa: no máximo ~100 dígitos de energia', () => {
    expect(envStep(3)).toBe(0.1)
    expect(envStep(40)).toBe(0.5)
    expect(envStep(180)).toBe(2)
    expect(envStep(5000)).toBe(50)
  })
  it('lê o PCM do WAV do proxy', () => {
    const pcm = hit()
    const r = wavPcm(wav(pcm, RATE))!
    expect(r.rate).toBe(RATE)
    expect(r.pcm.length).toBe(pcm.length)
    expect(r.pcm[4500]).toBe(pcm[4500])
    expect(wavPcm(Buffer.from('nada disso'))).toBeNull()
  })
})
