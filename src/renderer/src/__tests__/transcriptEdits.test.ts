import { describe, expect, it } from 'vitest'
import { applyFixes, fixWords, lines, promptOf, removePrompt, revertWord, setPrompt, tidy } from '../montage/transcriptEdits'
import { blockPrompt, blockSpeech, blockWindows, newBlock } from '../montage/blocks'
import { speechFiles } from '../montage/transcripts'
import type { MontageData } from '../lib'

const words = [
  { s: 0, e: 0.4, w: 'o' },
  { s: 0.5, e: 0.9, w: 'tesla' },
  { s: 1.0, e: 1.3, w: 'model' },
  { s: 1.4, e: 1.6, w: 'é' },
  { s: 3.0, e: 3.5, w: 'caro' }
]

describe('correções na transcrição', () => {
  it('corrige uma palavra e guarda o que o Whisper ouviu', () => {
    const e = fixWords(words, undefined, 1, 1, 'Tesla')
    const shown = applyFixes(words, e)
    expect(shown.map((w) => w.w)).toEqual(['o', 'Tesla', 'model', 'é', 'caro'])
    expect(shown[1]).toMatchObject({ fixed: true, orig: 'tesla' })
  })
  it('várias palavras viram uma correção só, que vai até o fim da última', () => {
    const e = fixWords(words, undefined, 1, 2, 'Tesla Model 3')
    const shown = applyFixes(words, e)
    expect(shown.map((w) => w.w)).toEqual(['o', 'Tesla Model 3', 'é', 'caro'])
    expect(shown[1]).toMatchObject({ s: 0.5, e: 1.3, orig: 'tesla model' })
    // voltar ao original desfaz o grupo todo
    expect(applyFixes(words, revertWord(words, e, 1)).map((w) => w.w)).toEqual(words.map((w) => w.w))
  })
  it('corrigir de novo pro mesmo texto não guarda nada', () => {
    const e = fixWords(words, undefined, 4, 4, 'caro')
    expect(tidy(e)).toBeUndefined()
  })
  it('prompts presos às palavras: cria, acha, edita e apaga', () => {
    let e = setPrompt(undefined, { from: 0.5, to: 1.3, text: 'logo da Tesla girando' })
    const p = promptOf(e, words[2])!
    expect(p.text).toBe('logo da Tesla girando')
    expect(promptOf(e, words[3])).toBeUndefined()
    e = setPrompt(e, { id: p.id, from: 0, to: 0, text: 'zoom no logo' })
    expect(e.prompts).toEqual([{ id: p.id, from: 0.5, to: 1.3, text: 'zoom no logo' }])
    expect(tidy(removePrompt(e, p.id))).toBeUndefined()
  })
  it('quebra em linhas nas pausas', () => {
    expect(lines(words).map((l) => l.map((w) => w.w).join(' '))).toEqual(['o tesla model é', 'caro'])
  })
})

const data: MontageData = {
  bins: [{ id: 'narr', name: 'Narração', role: 'narration' }],
  media: [
    { id: 'n', bin: 'narr', path: '/p/voz.wav', name: 'voz.wav', kind: 'audio', duration: 60, hasAudio: true, hasVideo: false },
    { id: 'g', bin: 'narr', path: '/p/game.wav', name: 'game.wav', kind: 'audio', duration: 60, hasAudio: true, hasVideo: false }
  ],
  tracks: [
    { id: 'V1', kind: 'video', name: 'V1' },
    { id: 'A1', kind: 'audio', name: 'A1' },
    { id: 'A2', kind: 'audio', name: 'A2', deaf: true }
  ],
  clips: [
    { id: 'c1', track: 'A1', media: 'n', start: 10, in: 2, out: 12 },
    { id: 'c2', track: 'A2', media: 'g', start: 10, in: 0, out: 10 }
  ]
}

describe('escuta por faixa', () => {
  it('faixa desarmada não entra na leitura nem no que o bloco ouve', () => {
    expect(speechFiles(data).map((f) => f.path)).toEqual(['/p/voz.wav'])
    const b = newBlock('V1', 12, 15)
    expect(blockSpeech(data, b)).toEqual(['/p/voz.wav'])
    // o bloco de 12 a 15 s pega o arquivo de 4 a 7 s
    expect([...blockWindows(data, b)]).toEqual([['/p/voz.wav', [[4, 7]]]])
  })
  it('o prompt do bloco lista os prompts das falas', () => {
    const p = blockPrompt({
      block: newBlock('V1', 0, 4),
      heard: [{ t: 0.5, w: 'Tesla' }],
      heardPrompts: [{ t0: 0.5, t1: 1.3, words: 'Tesla Model 3', text: 'logo girando' }],
      hasAudio: true,
      scriptHere: [],
      falas: '',
      files: [],
      size: { w: 480, h: 270 }
    })
    expect(p).toContain('quando é dito "Tesla Model 3": logo girando')
  })
})
