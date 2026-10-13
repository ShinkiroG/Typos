import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style'
import { Slice } from '@tiptap/pm/model'
import { Prompt, Transition, SoundUp, Sonora, Chapter } from '../editor/nodes'
import { Reference } from '../editor/reference'
import { PromptRange } from '../editor/promptMark'
import { markupToSlice, sliceToMarkup } from '../editor/markup'

// o mesmo conjunto de blocos e marcas do editor do roteiro
const schema = getSchema([
  StarterKit.configure({ heading: false }),
  Prompt,
  Transition,
  SoundUp,
  Chapter,
  Sonora,
  Reference,
  PromptRange,
  TextStyle,
  Color,
  FontFamily,
  FontSize,
  Highlight.configure({ multicolor: true })
])

const roundTrip = (text: string) => sliceToMarkup(markupToSlice(schema, text))
const types = (s: Slice) => {
  const out: string[] = []
  s.content.forEach((n) => out.push(n.type.name))
  return out
}

describe('marcação do roteiro (copiar e colar)', () => {
  it('linha sem marcação vira fala e [colchetes] vira prompt', () => {
    expect(types(markupToSlice(schema, 'Olá, pessoal\n[zoom no rosto]'))).toEqual(['paragraph', 'prompt'])
  })

  it('capítulo com #', () => {
    expect(types(markupToSlice(schema, '# Gancho\nTexto'))).toEqual(['chapter', 'paragraph'])
  })

  it('volta igual depois de ida e volta', () => {
    const text = ['# Gancho', '[zoom no rosto]', 'Hoje tem **novidade** e *muita* coisa ==boa==.', '<pausa s="2">respira</pausa>'].join('\n')
    const once = roundTrip(text)
    expect(roundTrip(once)).toBe(once)
    expect(once).toContain('**novidade**')
    expect(once).toContain('[zoom no rosto]')
  })

  it('caractere especial escapado continua literal', () => {
    const once = roundTrip('custa 2 \\* 3 reais')
    expect(markupToSlice(schema, once).content.textBetween(0, markupToSlice(schema, once).content.size)).toContain('2 * 3')
  })
})
