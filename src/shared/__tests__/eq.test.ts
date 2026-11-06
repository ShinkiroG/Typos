import { describe, expect, it } from 'vitest'
import { EQ_BANDS, EQ_PRESETS, eqActive, eqFfmpeg, eqResponseDb, flatEq, normEq } from '../eq'
import { finalArgs } from '../../main/compose'

describe('equalizador', () => {
  it('plano ou desligado não muda nada', () => {
    expect(eqActive(flatEq())).toBe(false)
    expect(eqActive(undefined)).toBe(false)
    expect(eqFfmpeg({ on: false, highpass: 40, gains: [-6] })).toEqual([])
    expect(eqResponseDb(flatEq(), [30, 1000])).toEqual([0, 0])
  })

  it('normaliza o que vem do projeto', () => {
    const e = normEq({ highpass: 35.4, gains: [-40, 3.33] } as never)
    expect(e.on).toBe(true)
    expect(e.highpass).toBe(35)
    expect(e.gains).toHaveLength(EQ_BANDS.length)
    expect(e.gains[0]).toBe(-12)
    expect(e.gains[1]).toBe(3.3)
  })

  it('vira filtros do ffmpeg: passa-alta 24 dB/oitava e só as faixas mexidas', () => {
    const f = eqFfmpeg({ on: true, highpass: 40, gains: [-6, -4, 0, 0, 0, 0, 0, 0, 0, 0] })
    expect(f).toEqual([
      'highpass=f=40:p=2:t=q:w=0.7071',
      'highpass=f=40:p=2:t=q:w=0.7071',
      'equalizer=f=32:t=q:w=1.41:g=-6',
      'equalizer=f=64:t=q:w=1.41:g=-4'
    ])
  })

  it('a curva corta o subgrave e não mexe na voz', () => {
    const sub = EQ_PRESETS.find((p) => p.id === 'sub-forte')!.eq
    const [r20, r40, r1k, r4k] = eqResponseDb(sub, [20, 40, 1000, 4000])
    expect(r20).toBeLessThan(-20)
    expect(r40).toBeLessThan(-6)
    expect(Math.abs(r1k)).toBeLessThan(0.5)
    expect(Math.abs(r4k)).toBeLessThan(0.5)
  })

  it('uma faixa de pico dá o ganho pedido no centro', () => {
    const g = flatEq().gains.map((_, i) => (i === 5 ? 6 : 0))
    expect(eqResponseDb({ on: true, highpass: 0, gains: g }, [1000])[0]).toBeCloseTo(6, 1)
  })

  it('entra no passo final antes do limitador', () => {
    const args = finalArgs('v.txt', 'a.txt', 'out.mp4', true, eqFfmpeg({ on: true, highpass: 30, gains: [] }))
    const af = args[args.indexOf('-af') + 1]
    expect(af.startsWith('highpass=f=30')).toBe(true)
    expect(af.endsWith('alimiter=limit=0.84:attack=5:release=120:level=0')).toBe(true)
    expect(finalArgs('v.txt', 'a.txt', 'out.mp4', false)).not.toContain('-af')
  })
})
