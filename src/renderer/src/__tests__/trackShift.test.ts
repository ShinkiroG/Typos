import { describe, expect, it } from 'vitest'
import { shiftTracks } from '../montage/trackShift'
import type { MontageClip, MontageTrack } from '../lib'

const tracks: MontageTrack[] = [
  { id: 'v2', kind: 'video', name: 'V2' },
  { id: 'v1', kind: 'video', name: 'V1' },
  { id: 'a1', kind: 'audio', name: 'A1' },
  { id: 'a2', kind: 'audio', name: 'A2' },
  { id: 'a3', kind: 'audio', name: 'A3' }
]
const clip = (id: string, track: string, start: number): MontageClip => ({ id, track, media: 'm', start, in: 0, out: 2 })
const tr = (id: string) => tracks.find((t) => t.id === id)!

describe('arrastar vários cortes pra outra faixa', () => {
  const clips = [clip('x', 'a1', 0), clip('y', 'a1', 5), clip('z', 'a2', 9), clip('v', 'v1', 0)]

  it('todos os áudios da faixa descem juntos pra faixa de baixo', () => {
    const m = shiftTracks(tracks, clips, ['x', 'y'], 'x', tr('a2'))
    expect([...m]).toEqual([
      ['x', 'a2'],
      ['y', 'a2']
    ])
  })

  it('cortes em faixas diferentes pulam o mesmo tanto', () => {
    const m = shiftTracks(tracks, clips, ['x', 'z'], 'x', tr('a2'))
    expect(m.get('x')).toBe('a2')
    expect(m.get('z')).toBe('a3')
  })

  it('não deixa ninguém passar da última faixa', () => {
    const m = shiftTracks(tracks, clips, ['x', 'z'], 'x', tr('a3'))
    expect(m.get('x')).toBe('a2')
    expect(m.get('z')).toBe('a3')
  })

  it('vídeo junto: cada um anda dentro do seu tipo', () => {
    const v2 = [clip('x', 'a1', 0), clip('v', 'v2', 0)]
    const m = shiftTracks(tracks, v2, ['x', 'v'], 'x', tr('a2'))
    expect(m.get('x')).toBe('a2')
    expect(m.get('v')).toBe('v1')
    // V1 já é a última de vídeo: o grupo não desce
    expect(shiftTracks(tracks, clips, ['x', 'v'], 'x', tr('a2')).size).toBe(0)
  })

  it('em cima de faixa de outro tipo ou fora das faixas, nada muda', () => {
    expect(shiftTracks(tracks, clips, ['x', 'y'], 'x', tr('v1')).size).toBe(0)
    expect(shiftTracks(tracks, clips, ['x', 'y'], 'x', null).size).toBe(0)
  })
})
