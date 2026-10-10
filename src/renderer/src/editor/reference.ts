import { Mark, mergeAttributes, getMarkRange, type Editor } from '@tiptap/core'

/**
 * Referência bibliográfica presa a um trecho do texto (como um link). Passar o mouse mostra a fonte;
 * a lista inteira vai pro rodapé/descrição do vídeo.
 */
export const Reference = Mark.create({
  name: 'reference',
  inclusive: false,
  excludes: '',
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute('data-ref-id'), renderHTML: (a) => ({ 'data-ref-id': a.id }) },
      text: { default: '', parseHTML: (el) => el.getAttribute('data-ref') ?? '', renderHTML: (a) => ({ 'data-ref': a.text }) }
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-ref]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'ref-mark' }), 0]
  }
})

export interface RefRange {
  from: number
  to: number
  id: string
  text: string
}

/** a referência que está nesse ponto do texto (o trecho inteiro dela) */
export function referenceAt(editor: Editor, pos: number): RefRange | null {
  const type = editor.schema.marks.reference
  const $p = editor.state.doc.resolve(pos)
  const mark = [...$p.marks(), ...($p.nodeAfter?.marks ?? [])].find((m) => m.type === type)
  if (!mark) return null
  const range = getMarkRange($p, type, mark.attrs) ?? getMarkRange(editor.state.doc.resolve(pos + 1), type, mark.attrs)
  if (!range) return null
  return { ...range, id: mark.attrs.id, text: mark.attrs.text }
}

/** todas as referências do roteiro, na ordem (trechos vizinhos com a mesma ref viram um só) */
export function allReferences(editor: Editor) {
  const type = editor.schema.marks.reference
  const out: (RefRange & { excerpt: string; block: number })[] = []
  editor.state.doc.forEach((block, offset, index) => {
    block.descendants((node, pos) => {
      if (!node.isText) return
      const m = node.marks.find((x) => x.type === type)
      if (!m) return
      const from = offset + 1 + pos
      const last = out[out.length - 1]
      if (last && last.id === m.attrs.id && last.to === from) {
        last.to = from + node.nodeSize
        last.excerpt += node.text
      } else out.push({ from, to: from + node.nodeSize, id: m.attrs.id, text: m.attrs.text, excerpt: node.text ?? '', block: index })
    })
  })
  return out
}

/** texto pronto pro rodapé / descrição do YouTube (fontes iguais aparecem uma vez) */
export function referencesText(refs: { text: string }[]) {
  const unique = [...new Set(refs.map((r) => r.text.trim()).filter(Boolean))]
  if (!unique.length) return ''
  return ['Referências:', ...unique.map((t, i) => `${i + 1}. ${t}`)].join('\n')
}
