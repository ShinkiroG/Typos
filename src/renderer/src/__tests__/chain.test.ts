import { describe, expect, it } from 'vitest'
import { snapMove } from '../montage/snap'
import { blockKey, neighborOf, newBlock } from '../montage/blocks'
import type { MontageData } from '../lib'

// ímã de teste: gruda em 10 e 20 se estiver a menos de 0,2 s
const near = (t: number) => [10, 20].find((c) => Math.abs(c - t) < 0.2) ?? t

describe('ímã ao arrastar', () => {
  it('gruda pelo começo', () => {
    expect(snapMove(near, 9.9, 3)).toEqual({ start: 10, hit: 10 })
  })
  it('gruda pelo fim (antes o começo "ganhava" sem ter encaixe)', () => {
    expect(snapMove(near, 16.9, 3)).toEqual({ start: 17, hit: 20 })
  })
  it('sem nada perto fica onde está', () => {
    expect(snapMove(near, 14, 3)).toEqual({ start: 14, hit: null })
  })
})

const montage = (): MontageData =>
  ({
    bins: [],
    tracks: [
      { id: 'V1', kind: 'video', name: 'V1' },
      { id: 'A1', kind: 'audio', name: 'A1' }
    ],
    media: [
      { id: 'm1', bin: 'b', path: '/x/gameplay.mp4', name: 'gameplay.mp4', kind: 'video', duration: 60, hasAudio: false, hasVideo: true },
      { id: 'm2', bin: 'b', path: '/x/motion.mp4', name: 'Bloco 0:20.mp4', kind: 'video', duration: 5, hasAudio: false, hasVideo: true, motionHtml: '/x/m.html' }
    ],
    clips: [
      { id: 'c1', track: 'V1', media: 'm1', start: 0, in: 0, out: 20 },
      { id: 'c2', track: 'V1', media: 'm2', start: 20, in: 0, out: 5 }
    ],
    blocks: []
  }) as unknown as MontageData

describe('vizinhos do bloco', () => {
  it('bloco encostado vem antes do vídeo da timeline', () => {
    const d = montage()
    const a = { ...newBlock('V1', 5, 10), id: 'a' }
    const b = { ...newBlock('V1', 10.05, 14), id: 'b' }
    d.blocks = [a, b]
    const n = neighborOf(d, b, 'prev')
    expect(n?.kind === 'block' && n.block.id).toBe('a')
    expect(neighborOf(d, a, 'next')?.kind).toBe('block')
  })
  it('sem bloco encostado: o corte de vídeo da emenda', () => {
    const d = montage()
    const b = newBlock('V1', 12, 16)
    const n = neighborOf(d, b, 'prev')
    expect(n).toMatchObject({ kind: 'video', label: 'gameplay.mp4' })
  })
  it('motion aprovado na emenda leva o HTML e o instante dele', () => {
    const d = montage()
    const b = newBlock('V1', 15, 22)
    expect(neighborOf(d, b, 'next')).toMatchObject({ kind: 'video', label: 'Bloco 0:20.mp4', html: '/x/m.html' })
    const c = newBlock('V1', 25, 30)
    expect(neighborOf(d, c, 'prev')).toMatchObject({ kind: 'video', html: '/x/m.html', htmlT: 5 })
  })
  it('nada antes do começo do vídeo', () => {
    expect(neighborOf(montage(), newBlock('V1', 0, 3), 'prev')).toBeNull()
  })
  it('ligar a emenda deixa a prévia velha; blocos antigos não mudam de chave', () => {
    const b = newBlock('V1', 1, 3)
    expect(blockKey({ ...b, fromPrev: false, toNext: false })).toBe(blockKey(b))
    expect(blockKey({ ...b, toNext: true })).not.toBe(blockKey(b))
  })
})
