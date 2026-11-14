import { describe, expect, it } from 'vitest'
import { applyEdits, blockPrompt, blockPromptParts, newBlock, parseEdits, reviewTweak, shotSize } from '../montage/blocks'

const html = '<html><head><style>\n  h1 { color: red; }\n  p { color: red; }\n</style></head><body><h1>Oi</h1><p>mundo</p></body></html>'
const base = { heard: [], hasAudio: false, scriptHere: [], falas: 'fala do vídeo', files: [], size: { w: 1920, h: 1080 } }

describe('ajuste por edições', () => {
  it('lê as edições da resposta', () => {
    const eds = parseEdits('<edits>\n<edit>\n<old>\n<h1>Oi</h1>\n</old>\n<new>\n<h1>Olá</h1>\n</new>\n</edit>\n<edit><old><p>mundo</p></old><new></new></edit>\n</edits>')
    expect(eds).toEqual([
      { old: '<h1>Oi</h1>', next: '<h1>Olá</h1>' },
      { old: '<p>mundo</p>', next: '' }
    ])
    expect(parseEdits('<demo><html></html></demo>')).toBeNull()
  })
  it('aplica em ordem, e a seguinte enxerga o resultado da anterior', () => {
    const r = applyEdits(html, [
      { old: '<h1>Oi</h1>', next: '<h1>Olá</h1>' },
      { old: '<h1>Olá</h1><p>mundo</p>', next: '<h1>Olá, mundo</h1>' }
    ])
    expect('html' in r && r.html).toContain('<body><h1>Olá, mundo</h1></body>')
  })
  it('trecho que aparece duas vezes ou não existe não é aplicado', () => {
    expect(applyEdits(html, [{ old: 'color: red;', next: 'color: blue;' }])).toEqual({ error: 'o trecho antigo da edição 1 aparece 2 vezes no arquivo' })
    expect(applyEdits(html, [{ old: '<h2>Oi</h2>', next: '' }])).toEqual({ error: 'o trecho antigo da edição 1 não existe no arquivo' })
  })
  it('diferença só de espaço e quebra de linha ainda casa', () => {
    const r = applyEdits(html, [{ old: 'h1 { color: red; }\np {', next: 'h1 { color: blue; }\n  p {' }])
    expect('html' in r && r.html).toContain('h1 { color: blue; }\n  p { color: red; }')
  })
  it('o pedido de ajuste aceita edições; o de revisão aceita também <ok/>', () => {
    const b = newBlock('V1', 0, 4)
    const adjust = { html, tweaks: [{ text: 'título azul', names: [] }] }
    expect(blockPrompt({ ...base, block: b, adjust })).not.toContain('<edits>')
    const p = blockPrompt({ ...base, block: b, adjust, edits: true })
    expect(p).toContain('<edits>')
    expect(p).toContain('<demo>')
    expect(p).not.toContain('<ok/>')
    expect(blockPrompt({ ...base, block: b, adjust: { html, tweaks: [{ text: reviewTweak([0.5, 1.5]), names: [] }] }, edits: true, okAllowed: true })).toContain('responda só:\n<ok/>')
  })
})

describe('pedido em duas partes (cache)', () => {
  it('a parte fixa é igual pra dois blocos diferentes do mesmo vídeo', () => {
    const a = blockPromptParts({ ...base, block: { ...newBlock('V1', 0, 4), text: 'um gráfico' } })
    const z = blockPromptParts({ ...base, block: { ...newBlock('V1', 9, 15), text: 'um mapa', sync: 0.9 } })
    expect(a.fixed).toBe(z.fixed)
    expect(a.fixed).toContain('fala do vídeo')
    expect(a.fixed).toContain('Safe zone')
    expect(a.block).toContain('um gráfico')
    expect(a.block).not.toBe(z.block)
  })
})

describe('tamanho da prévia', () => {
  it('a página do tamanho do projeto é gravada reduzida até 480 px', () => {
    expect(shotSize({ w: 1920, h: 1080 })).toEqual({ w: 480, h: 270 })
    expect(shotSize({ w: 1080, h: 1920 })).toEqual({ w: 270, h: 480 })
    expect(shotSize({ w: 1080, h: 1350 })).toEqual({ w: 384, h: 480 })
    expect(shotSize({ w: 480, h: 270 })).toEqual({ w: 480, h: 270 })
  })
})
