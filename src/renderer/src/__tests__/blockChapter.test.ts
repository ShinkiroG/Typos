import { describe, expect, it } from 'vitest'
import { blockPrompt, chapterAt, newBlock, scriptFalas } from '../montage/blocks'
import type { ScriptBlock } from '../montage/autocut'
import type { MontageData } from '../lib'

const script: ScriptBlock[] = [
  { index: 0, type: 'chapter', text: 'Começo' },
  { index: 1, type: 'paragraph', text: 'Primeira fala.' },
  { index: 2, type: 'chapter', text: 'Quanto custa' },
  { index: 3, type: 'paragraph', text: 'Segunda fala.' }
]
const data = (o: Partial<MontageData> = {}): MontageData => ({
  bins: [],
  media: [{ id: 'm1', path: '/n.wav', name: 'n.wav', duration: 60, hasAudio: true } as MontageData['media'][number]],
  tracks: [{ id: 'A1', kind: 'audio', name: 'A1' }],
  clips: [
    { id: 'c1', track: 'A1', media: 'm1', start: 0, in: 0, out: 10, block: 1 },
    { id: 'c2', track: 'A1', media: 'm1', start: 10, in: 10, out: 30, block: 3 }
  ],
  ...o
})

describe('capítulo do bloco', () => {
  it('acha o capítulo pelas falas que tocam no bloco', () => {
    expect(chapterAt(data(), newBlock('V1', 20, 24), script)?.title).toBe('Quanto custa')
    expect(chapterAt(data(), newBlock('V1', 2, 4), script)?.title).toBe('Começo')
  })
  it('sem falas ligadas, usa o lettering; o lettering que passa pelo bloco vai com o tempo relativo', () => {
    const d = data({ clips: [], markers: [{ id: 'k', kind: 'lettering', t: 19, dur: 3, block: 2, label: 'Quanto custa' }] })
    const ch = chapterAt(d, newBlock('V1', 20, 24), script)
    expect(ch).toEqual({ title: 'Quanto custa', letterings: [{ label: 'Quanto custa', t0: 0, t1: 2 }] })
    const p = blockPrompt({ block: newBlock('V1', 20, 24), heard: [], hasAudio: false, scriptHere: [], falas: '', files: [], size: { w: 480, h: 270 }, chapter: ch })
    expect(p).toContain('no capítulo "Quanto custa"')
    expect(p).toContain('De 0.0s a 2.0s')
  })
  it('o roteiro mandado pro Claude tem os capítulos', () => {
    expect(scriptFalas(script)).toBe('# Começo\nPrimeira fala.\n# Quanto custa\nSegunda fala.')
  })
})
