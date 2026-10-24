import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { peaksFilter, speechLevelDb } from '../peaksCore'

const which = spawnSync('which', ['ffmpeg']).stdout?.toString().trim()
const tmp = mkdtempSync(join(tmpdir(), 'typos-peaks-'))
vi.mock('electron', () => ({ app: { getPath: () => join(tmp, 'userData') }, ipcMain: { handle: vi.fn() }, dialog: {} }))
vi.mock('../settings', () => ({ loadSettings: async () => ({ ffmpegPath: which }) }))

const { cleanAudio } = await import('../denoise')
const { bestLag } = await import('../denoiseCore')
const { wavPcm } = await import('../soundProfile')

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const s16 = (f: string) => {
  const o = f + '.16.wav'
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', f, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', o])
  return wavPcm(readFileSync(o))!.pcm
}
/** maior amostra (dBFS) do trecho */
const peak = (x: Int16Array, t0: number, t1: number) => {
  let m = 0
  for (let i = t0 * 16000; i < t1 * 16000; i++) m = Math.max(m, Math.abs(x[i]))
  return 20 * Math.log10(m / 32768)
}

describe('controle de picos', () => {
  it('mede o volume típico da fala, sem contar as pausas', () => {
    const rate = 16000
    // fala a -20 dBFS (rms) em metade do tempo, ruído bem baixo no resto
    const pcm = Int16Array.from({ length: rate * 8 }, (_, i) => {
      const t = i / rate
      return Math.round((t % 2 < 1 ? 0.1 * Math.SQRT2 * Math.sin(2 * Math.PI * 200 * t) : 0.0003 * Math.sin(2 * Math.PI * 50 * t)) * 32767)
    })
    expect(speechLevelDb(pcm, rate)).toBeCloseTo(-20, 0)
    expect(speechLevelDb(new Int16Array(rate), rate)).toBeNull()
  })

  it('monta a cadeia de cada intensidade (de-esser só no médio e no forte)', () => {
    expect(peaksFilter(1, -24)).not.toContain('deesser')
    expect(peaksFilter(2, -24)).toContain('deesser=i=0.3')
    expect(peaksFilter(3, -24)).toContain('deesser=i=0.5')
    for (const l of [1, 2, 3] as const) expect(peaksFilter(l, -24)).toMatch(/acompressor=.*,alimiter=.*level=0/)
    // o teto nunca passa de -1 dBFS, nem com fala muito alta
    expect(peaksFilter(1, -5)).toContain(`limit=${Math.pow(10, -1 / 20).toFixed(4)}`)
  })

  describe.skipIf(!which)('com o ffmpeg de verdade', () => {
    const src = join(tmp, 'narracao.wav')
    // fala normal (~-20 dBFS) com um grito 14 dB mais forte entre 3 e 3,5 s
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', "aevalsrc='(0.14+0.56*between(t,3,3.5))*sin(2*PI*(180+120*mod(t,1))*t)*lt(mod(t,2),1.5)':d=8:s=44100",
      '-c:a', 'pcm_s16le', src
    ])
    const a = s16(src)

    for (const level of [1, 2, 3] as const)
      it(`intensidade ${level}: o pico desce, a fala normal fica e continua no tempo`, async () => {
        const out = await cleanAudio(src, 0, level)
        expect(typeof out).toBe('string')
        const b = s16(out as string)
        expect(Math.abs(a.length - b.length)).toBeLessThan(20)
        expect(bestLag(a.subarray(0, 32000), b, 160)).toBeLessThanOrEqual(3)
        expect(bestLag(b.subarray(0, 32000), a, 160)).toBeLessThanOrEqual(3)
        // a diferença entre o grito e a fala normal encolhe
        const gapA = peak(a, 3.05, 3.45) - peak(a, 0.5, 1.4)
        const gapB = peak(b, 3.05, 3.45) - peak(b, 0.5, 1.4)
        expect(gapB).toBeLessThan(gapA - 4 - level)
        // e a fala normal quase não muda
        expect(Math.abs(peak(b, 0.5, 1.4) - peak(a, 0.5, 1.4))).toBeLessThan(3)
        expect(await cleanAudio(src, 0, level)).toBe(out)
      }, 60000)

    it('limpeza + picos saem numa cópia só', async () => {
      const both = await cleanAudio(src, 1, 2)
      const only = await cleanAudio(src, 1, 0)
      expect(typeof both).toBe('string')
      expect(both).not.toBe(only)
      expect(await cleanAudio(src, 0, 0)).toBe(src)
    }, 60000)
  })
})
