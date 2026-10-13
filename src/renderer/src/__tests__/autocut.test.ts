import { describe, expect, it } from 'vitest'
import { autoCut, numberWords, sentences, tokens, type Take } from '../montage/autocut'
import { defaultMontage, clipEndT, type MontageMedia } from '../lib'

describe('números por extenso', () => {
  it('escreve como se fala', () => {
    expect(numberWords(0)).toEqual(['zero'])
    expect(numberWords(100)).toEqual(['cem'])
    expect(numberWords(21)).toEqual(['vinte', 'e', 'um'])
    expect(numberWords(2026).join(' ')).toBe('dois mil e vinte e seis')
  })
})

describe('tokens e frases', () => {
  it('ignora acento, maiúscula e pontuação', () => {
    expect(tokens('Olá, Você!')).toEqual(tokens('ola voce'))
  })
  it('número escrito casa com o extenso', () => {
    expect(tokens('2026')).toEqual(tokens('dois mil e vinte e seis'))
  })
  it('separa as frases', () => {
    expect(sentences('Primeira frase. Segunda? Terceira!')).toEqual(['Primeira frase.', 'Segunda?', 'Terceira!'])
  })
})

describe('corte automático', () => {
  const media: MontageMedia = { id: 'n1', bin: 'narration', path: 'C:\\narracao.wav', name: 'narracao.wav', kind: 'audio', duration: 20, hasAudio: true, hasVideo: false }
  // a primeira frase foi gravada duas vezes: fica a última tomada
  const words = [
    ['bom', 0.5, 0.8], ['dia', 0.8, 1.1], ['pessoal', 1.1, 1.6],
    ['bom', 3.0, 3.3], ['dia', 3.3, 3.6], ['pessoal', 3.6, 4.1],
    ['hoje', 5.0, 5.3], ['tem', 5.3, 5.5], ['video', 5.5, 6.0], ['novo', 6.0, 6.4]
  ].map(([w, s, e]) => ({ w: w as string, s: s as number, e: e as number }))
  const take: Take = { media, words, silences: [[1.6, 3.0], [4.1, 5.0], [6.4, 20]] }

  it('acha as frases, conta a repetição e monta clipes em ordem', () => {
    const base = { ...defaultMontage(), media: [media] }
    const r = autoCut([{ index: 0, type: 'paragraph', text: 'Bom dia, pessoal. Hoje tem vídeo novo.' }], [take], base)
    expect(r.found).toBe(2)
    expect(r.missing).toEqual([])
    expect(r.retakes).toBe(1)
    const added = r.data.clips.filter((c) => c.media === 'n1').sort((a, b) => a.start - b.start)
    expect(added.length).toBeGreaterThanOrEqual(2)
    // a primeira frase vem da segunda tomada (3.0 s em diante), não da primeira
    expect(added[0].in).toBeGreaterThanOrEqual(2.5)
    // sem sobreposição na timeline
    for (let i = 1; i < added.length; i++) expect(added[i].start).toBeGreaterThanOrEqual(clipEndT(added[i - 1]) - 0.001)
  })

  it('lista o que não achou', () => {
    const r = autoCut([{ index: 0, type: 'paragraph', text: 'Frase que ninguém gravou.' }], [take], { ...defaultMontage(), media: [media] })
    expect(r.found).toBe(0)
    expect(r.missing.length).toBe(1)
  })
})
