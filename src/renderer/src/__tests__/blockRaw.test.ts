import { describe, expect, it } from 'vitest'
import { blockKey, blockPrompt, newBlock, parseSounds, rawFiles, soundsToTimeline, SOUND_TRACK } from '../montage/blocks'
import type { MontageData } from '../lib'

const data: MontageData = {
  bins: [
    { id: 'narr', name: 'Narração', role: 'narration' },
    { id: 'raw', name: 'Material bruto', role: 'raw' },
    { id: 'prints', name: 'Prints', role: 'custom', parent: 'raw' },
    { id: 'sfx', name: 'SFX', role: 'sfx' }
  ],
  media: [
    { id: 'n', bin: 'narr', path: '/p/voz.wav', name: 'voz.wav', kind: 'audio', duration: 60, hasAudio: true, hasVideo: false },
    { id: 'i', bin: 'prints', path: '/p/tesla.png', name: 'tesla.png', kind: 'image', duration: 5, hasAudio: false, hasVideo: false },
    { id: 'v', bin: 'raw', path: '/p/gameplay.mp4', name: 'gameplay.mp4', kind: 'video', duration: 30, hasAudio: true, hasVideo: true },
    { id: 's', bin: 'sfx', path: '/p/whoosh.wav', name: 'whoosh.wav', kind: 'audio', duration: 1.5, hasAudio: true, hasVideo: false },
    { id: 'img-sfx', bin: 'sfx', path: '/p/capa.png', name: 'capa.png', kind: 'image', duration: 5, hasAudio: false, hasVideo: false }
  ],
  tracks: [{ id: 'A1', kind: 'audio', name: 'A1' }],
  clips: []
}

describe('Material bruto no bloco', () => {
  it('lista o bruto (com subpastas) e só os sons da pasta SFX; a narração fica de fora', async () => {
    const list = await rawFiles(data)
    expect(list.map((f) => [f.rel, f.kind])).toEqual([
      ['Material bruto/Prints/tesla.png', 'image'],
      ['Material bruto/gameplay.mp4', 'video'],
      ['SFX/whoosh.wav', 'audio']
    ])
    expect(list[2].name).toBe('bruto-3-whoosh.wav')
  })
  it('a checkbox deixa a prévia velha; blocos sem ela não mudam de chave', () => {
    const b = newBlock('V1', 1, 3)
    expect(blockKey({ ...b, useRaw: false })).toBe(blockKey(b))
    expect(blockKey({ ...b, useRaw: true })).not.toBe(blockKey(b))
  })
  it('o prompt lista os arquivos e pede a tag <sons>', async () => {
    const list = await rawFiles(data)
    const p = blockPrompt({ block: newBlock('V1', 0, 4), heard: [], hasAudio: false, scriptHere: [], falas: '', files: [], size: { w: 480, h: 270 }, raw: { list, first: 1, shown: 1 } })
    expect(p).toContain('bruto-1-tesla.png ← Material bruto/Prints/tesla.png (imagem')
    expect(p).toContain('<sons>')
    expect(blockPrompt({ block: newBlock('V1', 0, 4), heard: [], hasAudio: false, scriptHere: [], falas: '', files: [], size: { w: 480, h: 270 } })).not.toContain('<sons>')
  })
  it('lê os sons da resposta: só arquivos da lista e dentro do bloco', async () => {
    const list = await rawFiles(data)
    const text = '<demo>x</demo><sons>[{"arquivo":"bruto-3-whoosh.wav","em":1.2,"volume":0.5},{"arquivo":"inventado.wav","em":1},{"arquivo":"bruto-3-whoosh.wav","em":9}]</sons>'
    expect(parseSounds(text, list, 4)).toEqual([{ path: '/p/whoosh.wav', name: 'bruto-3-whoosh.wav', at: 1.2, vol: 0.5, duration: 1.5, bin: 'sfx' }])
    expect(parseSounds('<demo>x</demo>', list, 4)).toBeNull()
  })
  it('ao aprovar, os sons viram cortes em faixas próprias, sem um por cima do outro', () => {
    const b = newBlock('V1', 10, 14)
    const s = { path: '/p/whoosh.wav', name: 'bruto-3-whoosh.wav', vol: 0.5, duration: 1.5, bin: 'sfx' }
    const r = soundsToTimeline(data, b, [{ ...s, at: 0 }, { ...s, at: 1 }, { ...s, at: 3.5 }])
    const sons = r.tracks.filter((t) => t.name.startsWith(SOUND_TRACK))
    expect(sons.length).toBe(2)
    expect(r.media.length).toBe(data.media.length)
    expect(r.clips.map((c) => [c.start, c.out, c.media])).toEqual([
      [10, 1.5, 's'],
      [11, 1.5, 's'],
      [13.5, 0.5, 's']
    ])
    expect(r.clips[0].gainDb).toBeCloseTo(-6, 0)
  })
})
