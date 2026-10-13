import { describe, expect, it } from 'vitest'
import { describeChange } from '../montage/history'
import { defaultMontage, type MontageData } from '../lib'
import { splitClip } from '../montage/EditTimeline'

const base = (): MontageData => {
  const m = defaultMontage()
  return {
    ...m,
    media: [{ id: 'm1', bin: m.bins[0].id, path: 'C:\\a.wav', name: 'a.wav', kind: 'audio', duration: 30, hasAudio: true, hasVideo: false }],
    clips: [
      { id: 'a', track: m.tracks[0].id, media: 'm1', start: 0, in: 0, out: 5 },
      { id: 'b', track: m.tracks[0].id, media: 'm1', start: 6, in: 6, out: 10 }
    ]
  }
}

describe('nome de cada passo do histórico', () => {
  it('dividir', () => {
    const d = base()
    const [l, r] = splitClip(d.clips[0], 2)!
    expect(describeChange(d, { ...d, clips: [l, r, d.clips[1]] })).toBe('Dividiu corte')
  })
  it('apagar e fechar vão', () => {
    const d = base()
    expect(describeChange(d, { ...d, clips: [d.clips[0]] })).toBe('Apagou 1 corte')
    expect(describeChange(d, { ...d, clips: [{ ...d.clips[1], start: 0 }] })).toBe('Apagou e fechou o vão: 1 corte')
  })
  it('volume, mover, fechar vão', () => {
    const d = base()
    expect(describeChange(d, { ...d, clips: [{ ...d.clips[0], gainDb: -3 }, d.clips[1]] })).toBe('Volume')
    expect(describeChange(d, { ...d, clips: [d.clips[0], { ...d.clips[1], start: 5 }] })).toBe('Moveu')
    expect(describeChange(d, { ...d, clips: d.clips.map((c) => ({ ...c, start: c.start - 0.5 })) })).toBe('Fechou vão')
  })
  it('importar mídia e lettering', () => {
    const d = base()
    expect(describeChange(d, { ...d, media: [...d.media, { ...d.media[0], id: 'm2' }] })).toBe('Importou 1 mídia')
    expect(describeChange(d, { ...d, markers: [{ id: 'x', kind: 'lettering', t: 1 } as any] })).toBe('Lettering')
  })
})
