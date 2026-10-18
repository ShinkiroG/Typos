import { describe, expect, it } from 'vitest'
import { blocksMoved, fitBlocksToLetterings, silenceStart, timelineSilences } from '../montage/letterings'
import { newBlock } from '../montage/blocks'
import { SILENCE_DEFAULT } from '../montage/silence'
import { PEAKS_PER_SEC } from '../montage/engine'
import type { InstructionBlock, MontageData, MontageMarker } from '../lib'

const mark = (t: number, dur = 3, id = 'k'): MontageMarker => ({ id, kind: 'lettering', t, dur, block: 2, label: 'Quanto custa' })
const blk = (id: string, start: number, end: number, o: Partial<InstructionBlock> = {}): InstructionBlock => ({ ...newBlock('V1', start, end), id, text: 'pizza', ...o })
const data = (blocks: InstructionBlock[], markers: MontageMarker[]): MontageData => ({ bins: [], media: [], tracks: [], clips: [], blocks, markers })

describe('lettering de capítulo corta os blocos', () => {
  it('bloco que atravessa o lettering vira dois, um de cada lado, com as mesmas instruções', () => {
    const d = fitBlocksToLetterings(data([blk('b1', 10, 30, { toNext: true, fromPrev: true })], [mark(18)]))
    expect(d.blocks!.map((b) => [b.id, b.start, b.end, b.text])).toEqual([
      ['b1', 10, 18, 'pizza'],
      ['b1-k', 21, 30, 'pizza']
    ])
    expect(d.blocks![0].toNext).toBe(false)
    expect(d.blocks![1].fromPrev).toBe(false)
  })
  it('bloco que só encosta de um lado perde a parte de baixo do lettering', () => {
    const d = fitBlocksToLetterings(data([blk('a', 10, 19), blk('b', 20, 30)], [mark(18)]))
    expect(d.blocks!.map((b) => [b.id, b.start, b.end])).toEqual([
      ['a', 10, 18],
      ['b', 21, 30]
    ])
  })
  it('não mexe em bloco aprovado, nem em bloco inteiro embaixo do lettering, nem no que não encosta', () => {
    const blocks = [blk('ok', 10, 30, { approved: true }), blk('in', 18.5, 20), blk('fora', 0, 18)]
    const d = data(blocks, [mark(18)])
    expect(fitBlocksToLetterings(d)).toBe(d)
  })
  it('sobra menor que o mínimo some', () => {
    const d = fitBlocksToLetterings(data([blk('b', 17.8, 25)], [mark(18)]))
    expect(d.blocks!.map((b) => [b.id, b.start, b.end])).toEqual([['b', 21, 25]])
  })
  it('só conta mexer no tempo dos blocos, não no texto', () => {
    const a = data([blk('b', 0, 5)], [])
    expect(blocksMoved(a, { ...a, blocks: [{ ...a.blocks![0], text: 'outra' }] })).toBe(false)
    expect(blocksMoved(a, { ...a, blocks: [{ ...a.blocks![0], end: 6 }] })).toBe(true)
  })
})

describe('lettering entra no silêncio', () => {
  // fala de 0 a 9.5 s, silêncio até 11 s, fala até 20 s (a onda do arquivo)
  const peaks = new Float32Array(20 * PEAKS_PER_SEC).map((_, i) => (i >= 9.5 * PEAKS_PER_SEC && i < 11 * PEAKS_PER_SEC ? 0 : 0.5))
  const d: MontageData = {
    bins: [],
    media: [{ id: 'm', path: '/n.wav', name: 'n.wav', kind: 'audio', duration: 20, hasAudio: true, hasVideo: false } as MontageData['media'][number]],
    tracks: [{ id: 'A1', kind: 'audio', name: 'A1' }],
    clips: [
      { id: 'c1', track: 'A1', media: 'm', start: 0, in: 0, out: 20 },
      { id: 'c2', track: 'A1', media: 'm', start: 25, in: 0, out: 5 }
    ]
  }
  const o = { ...SILENCE_DEFAULT, pad: 0 }
  it('acha o silêncio dentro do corte e o vão entre cortes', () => {
    const s = timelineSilences(d, () => peaks, o)
    expect(s.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)])).toEqual([
      [9.5, 11],
      [20, 25]
    ])
  })
  it('vai pro começo do silêncio em que cai ou do mais perto', () => {
    const s = timelineSilences(d, () => peaks, o)
    expect(silenceStart(10.2, s)).toBeCloseTo(9.5)
    expect(silenceStart(8.6, s)).toBeCloseTo(9.5)
    expect(silenceStart(4, s)).toBe(4)
    expect(silenceStart(22, s)).toBe(20)
  })
})
