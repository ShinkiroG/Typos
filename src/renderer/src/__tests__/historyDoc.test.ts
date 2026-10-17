import { describe, expect, it } from 'vitest'
import { chapterDiff, docChapters, groupByDay } from '../history'

const p = (text: string) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })
const ch = (text: string) => ({ type: 'chapter', content: [{ type: 'text', text }] })

describe('capítulos de uma versão', () => {
  const doc = { type: 'doc', content: [p('abertura solta'), ch('INTRO'), p('oi gente'), p(''), p('tudo bem'), ch('PRAZOS'), p('')] }

  it('texto por capítulo, com o que vem antes do primeiro como "Início"', () => {
    expect(docChapters(doc)).toEqual([
      { title: 'Início', words: 2, text: 'abertura solta' },
      { title: 'INTRO', words: 4, text: 'oi gente\n\ntudo bem' },
      { title: 'PRAZOS', words: 0, text: '' }
    ])
  })

  it('compara com o roteiro de agora pelo nome do capítulo', () => {
    const old = docChapters({ content: [ch('PRAZOS'), p('a Steam leva uns dias pra aprovar')] })
    const now = docChapters(doc)
    expect(chapterDiff(old, now)).toEqual([7])
    expect(chapterDiff(old, null)).toEqual([null])
  })
})

describe('lista por dia', () => {
  it('agrupa e mostra quantas palavras mudaram da versão anterior', () => {
    const now = new Date(2026, 9, 17, 12, 0).getTime()
    const at = (h: number, d = 17) => new Date(2026, 9, d, h, 0).getTime()
    const g = groupByDay(
      [
        { name: 'a', at: at(9), reason: 'auto', words: 500 },
        { name: 'b', at: at(10), reason: 'corte', words: 900 },
        { name: 'c', at: at(22, 16), reason: 'abertura', words: 880 }
      ],
      now
    )
    expect(g.map((x) => x.label)).toEqual(['Hoje', 'Ontem'])
    expect(g[0].items.map((x) => [x.name, x.delta])).toEqual([
      ['b', 400],
      ['a', -380]
    ])
    expect(g[1].items[0].delta).toBeNull()
  })
})
