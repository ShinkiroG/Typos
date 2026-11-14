import { describe, expect, it } from 'vitest'
import { letteringAt, nextPicture, pictureLayers } from '../montage/monitor'
import { defaultMontage, type MontageData } from '../lib'

const frame = { width: 1920, height: 1080 }
function montage(): { m: MontageData; media: Map<string, MontageData['media'][number]> } {
  const m = defaultMontage()
  const v2 = m.tracks.filter((t) => t.kind === 'video')
  // garante duas faixas de vídeo: a primeira da lista é a de cima
  if (v2.length < 2) m.tracks.unshift({ ...v2[0], id: 'V2', name: 'V2' })
  m.media = [
    { id: 'bruto', bin: 'raw', path: 'C:\\bruto.mp4', name: 'bruto.mp4', kind: 'video', duration: 60, hasAudio: true, hasVideo: true, width: 1920, height: 1080 },
    { id: 'motion', bin: 'raw', path: 'C:\\motion.mp4', name: 'motion.mp4', kind: 'video', duration: 60, hasAudio: false, hasVideo: true, width: 1920, height: 1080 },
    { id: 'alfa', bin: 'raw', path: 'C:\\alfa.webm', name: 'alfa.webm', kind: 'video', duration: 60, hasAudio: false, hasVideo: true, width: 1920, height: 1080 },
    { id: 'voz', bin: 'narration', path: 'C:\\voz.wav', name: 'voz.wav', kind: 'audio', duration: 60, hasAudio: true, hasVideo: false }
  ]
  return { m, media: new Map(m.media.map((x) => [x.id, x])) }
}
const [top, low] = (() => {
  const v = montage().m.tracks.filter((t) => t.kind === 'video')
  return [v[0].id, v[1].id]
})()

describe('visualizador da Montagem em camadas', () => {
  it('camada de cima inteira e opaca esconde a de baixo', () => {
    const { m, media } = montage()
    m.clips = [
      { id: 'a', track: low, media: 'bruto', start: 0, in: 5, out: 25 },
      { id: 'b', track: top, media: 'motion', start: 4, in: 0, out: 6 }
    ]
    expect(pictureLayers(m, media, 2, frame).map((l) => l.id)).toEqual(['a'])
    expect(pictureLayers(m, media, 2, frame)[0].src).toBeCloseTo(7)
    expect(pictureLayers(m, media, 6, frame).map((l) => l.id)).toEqual(['b'])
  })

  it('no fade da camada de cima as duas aparecem, com a opacidade do render', () => {
    const { m, media } = montage()
    m.clips = [
      { id: 'a', track: low, media: 'bruto', start: 0, in: 0, out: 20 },
      { id: 'b', track: top, media: 'motion', start: 4, in: 0, out: 6, fadeIn: 2, fadeOut: 1 }
    ]
    const l = pictureLayers(m, media, 5, frame)
    expect(l.map((x) => x.id)).toEqual(['a', 'b'])
    expect(l[1].opacity).toBeCloseTo(0.5)
    expect(pictureLayers(m, media, 9.5, frame)[1].opacity).toBeCloseTo(0.5)
  })

  it('vídeo com transparência por cima não esconde o de baixo', () => {
    const { m, media } = montage()
    m.clips = [
      { id: 'a', track: low, media: 'bruto', start: 0, in: 0, out: 20 },
      { id: 'b', track: top, media: 'alfa', start: 0, in: 0, out: 20 }
    ]
    expect(pictureLayers(m, media, 3, frame).map((l) => l.id)).toEqual(['a', 'b'])
  })

  it('faixa muda e som não entram; sem nada no instante, lista vazia', () => {
    const { m, media } = montage()
    m.clips = [{ id: 'a', track: low, media: 'bruto', start: 2, in: 0, out: 5 }]
    expect(pictureLayers(m, media, 1, frame)).toEqual([])
    m.tracks = m.tracks.map((t) => (t.id === low ? { ...t, muted: true } : t))
    expect(pictureLayers({ ...m }, media, 3, frame)).toEqual([])
  })

  it('o próximo corte aparece pra pré-carregar e o lettering é achado pelo tempo', () => {
    const { m, media } = montage()
    m.clips = [{ id: 'a', track: low, media: 'bruto', start: 2, in: 3, out: 8 }]
    expect(nextPicture(m, media, 1.5, 1)).toMatchObject({ id: 'a', src: 3, opacity: 0 })
    expect(nextPicture(m, media, 0.5, 1)).toBeNull()
    m.markers = [{ id: 'l', kind: 'lettering', label: 'Capítulo 1', t: 10, dur: 3 } as NonNullable<MontageData['markers']>[number]]
    expect(letteringAt(m, 11)?.id).toBe('l')
    expect(letteringAt(m, 13.5)).toBeNull()
  })
})
