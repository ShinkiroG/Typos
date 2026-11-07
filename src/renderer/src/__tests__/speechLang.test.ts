import { describe, expect, it } from 'vitest'
import { speechLangOf, type Format } from '../lib'
import { applyFixes, editFor, fixWords, setPrompt, storeEdit } from '../montage/transcriptEdits'

const fmt = (lang?: string) => ({ id: 'f', name: 'F', aspect: '16:9', wpm: 150, maxSeconds: null, lang }) as Format

describe('idioma da fala do projeto', () => {
  it('sem escolha segue o corretor do estilo', () => {
    expect(speechLangOf('', fmt('en-US'))).toBe('en')
    expect(speechLangOf(undefined, fmt())).toBe('pt')
    expect(speechLangOf('', fmt('off'))).toBe('pt')
  })
  it('a escolha do projeto vence o estilo', () => {
    expect(speechLangOf('en', fmt('pt-BR'))).toBe('en')
    expect(speechLangOf('auto', fmt('pt-BR'))).toBe('auto')
  })
})

describe('correções por idioma', () => {
  const pt = [
    { s: 0, e: 0.4, w: 'olá' },
    { s: 0.5, e: 0.9, w: 'mundo' }
  ]
  const en = [
    { s: 0, e: 0.4, w: 'hello' },
    { s: 0.5, e: 0.9, w: 'world' }
  ]
  it('correção feita lendo em PT não aparece na leitura em EN; o prompt sim', () => {
    let e = storeEdit(undefined, fixWords(pt, undefined, 1, 1, 'Mundo'), 'pt')!
    e = storeEdit(e, setPrompt(editFor(e, 'pt'), { from: 0, to: 0.9, text: 'zoom' }), 'pt')!
    expect(e.fixLang).toBe('pt')
    expect(applyFixes(en, editFor(e, 'en')).map((w) => w.w)).toEqual(['hello', 'world'])
    expect(editFor(e, 'en')?.prompts).toHaveLength(1)
    expect(applyFixes(pt, editFor(e, 'pt')).map((w) => w.w)).toEqual(['olá', 'Mundo'])
  })
  it('mexer só no prompt em EN não apaga as correções de PT', () => {
    const e = storeEdit(undefined, fixWords(pt, undefined, 1, 1, 'Mundo'), 'pt')!
    const next = storeEdit(e, setPrompt(editFor(e, 'en'), { from: 0, to: 0.4, text: 'zoom' }), 'en')!
    expect(next).toMatchObject({ fixLang: 'pt', fix: e.fix })
    expect(next.prompts).toHaveLength(1)
  })
  it('correções antigas (sem idioma) continuam valendo', () => {
    const old = fixWords(pt, undefined, 1, 1, 'Mundo')
    expect(applyFixes(pt, editFor(old, 'en')).map((w) => w.w)).toEqual(['olá', 'Mundo'])
  })
})
