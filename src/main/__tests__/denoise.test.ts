import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { bestLag, denoiseArgs, denoiseFilter, loudestStart, noiseFloorDb } from '../denoiseCore'
import { wavPcm } from '../soundProfile'

/** ruído branco em dBFS (rms) com uma "fala" (tom alto) no meio */
function signal(rate: number, secs: number, noiseDb: number, talk: [number, number]) {
  const a = Math.pow(10, noiseDb / 20) * Math.sqrt(3) * 32767
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1
  return Int16Array.from({ length: rate * secs }, (_, i) => {
    const t = i / rate
    const tone = t >= talk[0] && t < talk[1] ? 12000 * Math.sin(2 * Math.PI * 220 * t) : 0
    return Math.round(tone + a * rnd())
  })
}

describe('limpeza de ruído', () => {
  it('mede o chão de ruído nas partes quietas', () => {
    const pcm = signal(16000, 6, -50, [2, 4])
    expect(noiseFloorDb(pcm, 16000)).toBeCloseTo(-50, 0)
    // silêncio digital não conta como ruído
    expect(noiseFloorDb(new Int16Array(16000 * 2), 16000)).toBeNull()
  })

  it('acha o trecho com fala', () => {
    expect(loudestStart(signal(16000, 10, -50, [6, 8]), 16000, 2)).toBeCloseTo(6, 1)
  })

  it('mede o atraso pela correlação', () => {
    const ref = signal(16000, 2, -20, [0, 2])
    const out = new Int16Array(ref.length + 500)
    out.set(ref, 400)
    expect(bestLag(ref, out, 1600)).toBe(400)
    expect(bestLag(ref, ref, 1600)).toBe(0)
  })

  it('monta a cadeia de cada intensidade', () => {
    expect(denoiseFilter(1, -55, 'voz.rnnn')).toBe('highpass=f=70,afftdn=nr=12:nf=-35')
    expect(denoiseFilter(2, -55, 'voz.rnnn')).toBe('highpass=f=80,arnndn=m=voz.rnnn')
    expect(denoiseFilter(3, -55, 'voz.rnnn')).toBe('highpass=f=80,arnndn=m=voz.rnnn,afftdn=nr=20:nf=-35')
    // sem arnndn no ffmpeg: só o afftdn
    expect(denoiseFilter(2, -55, null)).not.toContain('arnndn')
    // nf fica no que o afftdn aceita
    expect(denoiseFilter(1, -10, null)).toContain('nf=-20')
    expect(denoiseFilter(1, -120, null)).toContain('nf=-80')
  })

  it('tira o atraso no começo e completa o fim (mesma duração)', () => {
    const a = denoiseArgs('in.wav', 'out.wav', 'afftdn', 0.025)
    expect(a[a.indexOf('-af') + 1]).toBe('afftdn,aresample=48000,atrim=start_sample=1200,asetpts=PTS-STARTPTS,apad=pad_len=1200')
  })

  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
  it.skipIf(!hasFfmpeg)('limpa de verdade com o ffmpeg e o arquivo continua no tempo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typos-dn-'))
    try {
      const src = join(dir, 'in.wav')
      // "fala" em rajadas (tom que varia, como a voz) + ruído rosa constante
      execFileSync('ffmpeg', [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*(180+120*mod(t,1))*t)*lt(mod(t,2),1)':d=6:s=48000",
        '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=pink:a=0.03',
        '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0', '-ar', '48000', '-c:a', 'pcm_s16le', src
      ])
      const rnn = /\barnndn\b/.test(execFileSync('ffmpeg', ['-hide_banner', '-filters']).toString())
      const filter = denoiseFilter(1, -45, rnn ? 'voz.rnnn' : null)
      const out = join(dir, 'out.wav')
      execFileSync('ffmpeg', denoiseArgs(src, out, filter, 0.025), { cwd: resolve(__dirname, '../rnnoise'), stdio: 'ignore' })
      const s16 = (f: string) => {
        const o = f + '.16.wav'
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', f, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', o])
        return wavPcm(readFileSync(o))!.pcm
      }
      const a = s16(src)
      const b = s16(out)
      expect(Math.abs(a.length - b.length)).toBeLessThan(20)
      // continua no tempo (sem os 25 ms do afftdn)
      expect(bestLag(a.subarray(0, 32000), b, 160)).toBeLessThanOrEqual(3)
      expect(bestLag(b.subarray(0, 32000), a, 160)).toBeLessThanOrEqual(3)
      // o trecho sem fala ficou mais baixo
      const rms = (x: Int16Array, t0: number, t1: number) => {
        let s = 0
        for (let i = t0 * 16000; i < t1 * 16000; i++) s += x[i] * x[i]
        return 20 * Math.log10(Math.sqrt(s / ((t1 - t0) * 16000)) / 32768)
      }
      expect(rms(b, 1.3, 1.8)).toBeLessThan(rms(a, 1.3, 1.8) - 6)
      // e a fala ficou
      expect(rms(b, 0.2, 0.8)).toBeGreaterThan(rms(a, 0.2, 0.8) - 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
