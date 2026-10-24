import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const which = spawnSync('which', ['ffmpeg']).stdout?.toString().trim()
const tmp = mkdtempSync(join(tmpdir(), 'typos-dnrun-'))
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
const rms = (x: Int16Array, t0: number, t1: number) => {
  let s = 0
  for (let i = t0 * 16000; i < t1 * 16000; i++) s += x[i] * x[i]
  return 20 * Math.log10(Math.sqrt(s / ((t1 - t0) * 16000)) / 32768)
}

describe.skipIf(!which)('limpeza de ruído (ffmpeg de verdade)', () => {
  const src = join(tmp, 'narracao.wav')
  let a: Int16Array
  // dentro do beforeAll: sem ffmpeg o describe é pulado e isto nem roda
  beforeAll(() => {
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*(180+120*mod(t,1))*t)*lt(mod(t,2),1)':d=8:s=44100",
      '-f', 'lavfi', '-i', 'anoisesrc=d=8:c=pink:a=0.03:r=44100',
      '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0', '-c:a', 'pcm_s16le', src
    ])
    a = s16(src)
  })

  for (const level of [1, 2, 3] as const)
    it(`intensidade ${level}: menos ruído, mesma duração e no tempo`, async () => {
      const out = await cleanAudio(src, level)
      expect(typeof out).toBe('string')
      const b = s16(out as string)
      expect(Math.abs(a.length - b.length)).toBeLessThan(20)
      expect(bestLag(a.subarray(0, 48000), b, 160)).toBeLessThanOrEqual(3)
      expect(bestLag(b.subarray(0, 48000), a, 160)).toBeLessThanOrEqual(3)
      expect(rms(b, 1.3, 1.8)).toBeLessThan(rms(a, 1.3, 1.8) - 6)
      // a segunda vez sai do cache
      expect(await cleanAudio(src, level)).toBe(out)
    }, 60000)
})
