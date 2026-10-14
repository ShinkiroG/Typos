import { describe, expect, it } from 'vitest'
import { PEAKS_PER_SEC } from '../montage/engine'
import { SILENCE_DEFAULT, silenceStats, suggestThreshold, voicedRanges } from '../montage/silence'

/** 1 s de fala (−10 dB), 1 s de silêncio (−60 dB), 1 s de fala, com um estalo curto no meio do silêncio */
function peaks() {
  const n = 3 * PEAKS_PER_SEC
  const p = new Float32Array(n)
  for (let i = 0; i < n; i++) p[i] = i < PEAKS_PER_SEC || i >= 2 * PEAKS_PER_SEC ? 0.3 : 0.001
  p[Math.floor(1.5 * PEAKS_PER_SEC)] = 0.3
  return p
}

describe('corte por silêncio', () => {
  const src = [{ media: 'm', in: 0, out: 3 }]
  const of = () => peaks()
  it('o estalo curto sai com "ignorar ruídos"', () => {
    const o = { ...SILENCE_DEFAULT, pad: 0, minSilence: 0.2, minVoice: 0.1 }
    expect(voicedRanges(peaks(), 0, 3, o)).toHaveLength(2)
  })
  it('estima quanto sai', () => {
    const st = silenceStats(src, of, { ...SILENCE_DEFAULT, pad: 0, minSilence: 0.2, minVoice: 0.1 })
    expect(st.total).toBe(3)
    expect(st.removed).toBeGreaterThan(0.9)
    expect(st.pieces).toBe(2)
  })
  it('sugere o limiar entre o ruído e a fala', () => {
    const t = suggestThreshold(src, of)!
    expect(t).toBeGreaterThan(-60)
    expect(t).toBeLessThan(-10)
  })
})
