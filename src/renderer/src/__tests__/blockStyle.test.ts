import { describe, expect, it } from 'vitest'
import { assetFiles, blockKey, blockPrompt, newBlock, type StyleAsset } from '../montage/blocks'
import type { Format } from '../lib'

const fmt: Format = { id: 'f1', name: 'Canal', aspect: '16:9', wpm: 150, maxSeconds: null, rules: 'pngtuber no canto inferior direito' }
const assets: StyleAsset[] = [
  { path: '/p/feliz.png', rel: 'pngtuber/feliz.png', kind: 'image', name: 'estilo-1-feliz.png' },
  { path: '/p/bravo.png', rel: 'pngtuber/bravo.png', kind: 'image', name: 'estilo-11-bravo.png' }
]
const prompt = (o: Partial<Parameters<typeof blockPrompt>[0]> = {}) =>
  blockPrompt({ block: newBlock('V1', 0, 4), format: fmt, heard: [], hasAudio: false, scriptHere: [], falas: '', files: [], size: { w: 480, h: 270 }, ...o })

describe('estilo do bloco', () => {
  it('escolher outro estilo deixa a prévia velha; blocos antigos não mudam de chave', () => {
    const b = newBlock('V1', 1, 3)
    expect(blockKey({ ...b, formatId: undefined })).toBe(blockKey(b))
    expect(blockKey({ ...b, formatId: 'f2' })).not.toBe(blockKey(b))
  })
  it('as regras e as pastas de assets do estilo vão pro prompt', () => {
    const p = prompt({ assets: { list: assets, first: 3, shown: 2 } })
    expect(p).toContain('pngtuber no canto inferior direito')
    expect(p).toContain('estilo-1-feliz.png ← pngtuber/feliz.png')
    expect(p).toContain('As imagens 3 a 4')
  })
  it('só copia os assets que a animação usa', () => {
    expect(assetFiles(assets, '<img src="estilo-11-bravo.png">')).toEqual([{ src: '/p/bravo.png', name: 'estilo-11-bravo.png' }])
  })
})
