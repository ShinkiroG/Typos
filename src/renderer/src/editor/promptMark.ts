import { Mark, mergeAttributes, getMarkRange, type Editor, type JSONContent } from '@tiptap/core'

/**
 * Prompt preso a um trecho do texto (como a referência): "nesse pedaço da fala, o motion é X".
 * Convive com os blocos de prompt de sempre.
 */
export const PromptRange = Mark.create({
  name: 'promptRange',
  inclusive: false,
  excludes: '',
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute('data-prompt-id'), renderHTML: (a) => ({ 'data-prompt-id': a.id }) },
      text: { default: '', parseHTML: (el) => el.getAttribute('data-prompt') ?? '', renderHTML: (a) => ({ 'data-prompt': a.text }) }
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-prompt]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'prompt-mark' }), 0]
  }
})

export interface PromptRangeInfo {
  from: number
  to: number
  id: string
  text: string
}

export function promptAt(editor: Editor, pos: number): PromptRangeInfo | null {
  const type = editor.schema.marks.promptRange
  const $p = editor.state.doc.resolve(pos)
  const mark = [...$p.marks(), ...($p.nodeAfter?.marks ?? [])].find((m) => m.type === type)
  if (!mark) return null
  const range = getMarkRange($p, type, mark.attrs) ?? getMarkRange(editor.state.doc.resolve(pos + 1), type, mark.attrs)
  return range ? { ...range, id: mark.attrs.id, text: mark.attrs.text } : null
}

/** prompts de trecho dentro de um bloco (JSON): [{ trecho, instrução }] na ordem */
export function blockPrompts(n: JSONContent): { excerpt: string; text: string }[] {
  const out: { id: string; excerpt: string; text: string }[] = []
  const walk = (node: JSONContent) => {
    for (const c of node.content ?? []) {
      if (c.type !== 'text') {
        walk(c)
        continue
      }
      const m = c.marks?.find((x) => x.type === 'promptRange')
      if (!m) continue
      const last = out[out.length - 1]
      if (last && last.id === m.attrs?.id) last.excerpt += c.text ?? ''
      else out.push({ id: m.attrs?.id, excerpt: c.text ?? '', text: m.attrs?.text ?? '' })
    }
  }
  walk(n)
  return out.map(({ excerpt, text }) => ({ excerpt: excerpt.trim(), text }))
}

/** põe a marca de prompt no primeiro lugar em que o trecho aparece no conteúdo (vindo da IA) */
export function markExcerpt(content: JSONContent[] | undefined, excerpt: string, attrs: { id: string; text: string }): JSONContent[] | null {
  if (!content || !excerpt) return null
  const full = content.map((c) => c.text ?? '').join('')
  const at = full.indexOf(excerpt)
  if (at < 0) return null
  const end = at + excerpt.length
  const out: JSONContent[] = []
  let pos = 0
  for (const c of content) {
    const t = c.text ?? ''
    const s = pos
    const e = pos + t.length
    pos = e
    if (e <= at || s >= end) {
      out.push(c)
      continue
    }
    const a = Math.max(at, s) - s
    const b = Math.min(end, e) - s
    if (a > 0) out.push({ ...c, text: t.slice(0, a) })
    out.push({ ...c, text: t.slice(a, b), marks: [...(c.marks ?? []), { type: 'promptRange', attrs }] })
    if (b < t.length) out.push({ ...c, text: t.slice(b) })
  }
  return out
}
