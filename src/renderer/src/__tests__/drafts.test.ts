import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_DRAFTS, clearDraft, hasDraft, loadDraft, saveDraft } from '../montage/drafts'

const img = { id: 'a1', path: 'assets/x.png', name: 'x.png' }

describe('rascunho do pedir ajustes', () => {
  beforeEach(() => localStorage.clear())

  it('guarda texto e imagens por bloco e devolve ao reabrir', () => {
    saveDraft('prev:b1', { text: 'número entra mais cedo', files: [img] })
    saveDraft('prev:b2', { text: 'fundo escuro', files: [] })
    expect(loadDraft('prev:b1')).toEqual({ text: 'número entra mais cedo', files: [img] })
    expect(loadDraft('prev:b2').text).toBe('fundo escuro')
    expect(hasDraft('prev:b3')).toBe(false)
  })

  it('some quando esvazia (ajuste enviado)', () => {
    saveDraft('prev:b1', { text: 'x', files: [] })
    clearDraft('prev:b1')
    expect(hasDraft('prev:b1')).toBe(false)
    expect(localStorage.getItem('typos.adjustDrafts')).toBe('{}')
  })

  it('aguenta lixo no localStorage e limita a quantidade', () => {
    localStorage.setItem('typos.adjustDrafts', 'não é json')
    expect(loadDraft('k')).toEqual({ text: '', files: [] })
    for (let i = 0; i < MAX_DRAFTS + 5; i++) saveDraft(`k${i}`, { text: 't', files: [] })
    expect(Object.keys(JSON.parse(localStorage.getItem('typos.adjustDrafts')!)).length).toBe(MAX_DRAFTS)
    expect(hasDraft(`k${MAX_DRAFTS + 4}`)).toBe(true)
  })
})
