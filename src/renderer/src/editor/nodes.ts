import { Node, Extension, mergeAttributes, InputRule, textblockTypeInputRule, type Editor } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { isKey } from '../keys'
import { PromptView, TransitionView, SoundUpView, SonoraView } from './views'

/** Backspace no começo de um bloco especial volta ele pra fala comum. */
const backspaceToParagraph =
  (name: string) =>
  ({ editor }: { editor: Editor }) => {
    const { empty, $from } = editor.state.selection
    if (!empty || $from.parent.type.name !== name || $from.parentOffset !== 0) return false
    return editor.commands.setNode('paragraph')
  }

const jsonAttr = (attr: string, fallback: unknown) => ({
  default: fallback,
  parseHTML: (el: HTMLElement) => {
    try {
      return JSON.parse(el.getAttribute(attr) ?? '')
    } catch {
      return fallback
    }
  },
  renderHTML: (attrs: Record<string, unknown>) => ({ [attr]: JSON.stringify(attrs[attr.replace('data-', '')] ?? fallback) })
})

export const Prompt = Node.create({
  name: 'prompt',
  group: 'block',
  content: 'inline*',
  defining: true,

  addAttributes() {
    return { attachments: jsonAttr('data-attachments', []) }
  },
  parseHTML() {
    return [{ tag: 'div[data-type="prompt"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'prompt' }), 0]
  },
  addNodeView() {
    return ReactNodeViewRenderer(PromptView)
  },
  addKeyboardShortcuts() {
    return { Backspace: backspaceToParagraph(this.name) }
  },
  addInputRules() {
    // digitar "[qualquer coisa]" numa linha de fala vira prompt
    return [
      new InputRule({
        find: /^\[([^[\]]+)\]$/,
        handler: ({ state, range, match }) => {
          if (state.doc.resolve(range.from).parent.type.name !== 'paragraph') return null
          const text = match[1]
          state.tr.insertText(text, range.from, range.to)
          state.tr.setBlockType(range.from, range.from + text.length, this.type)
        }
      })
    ]
  }
})

export const Transition = Node.create({
  name: 'transition',
  group: 'block',
  content: 'inline*',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'Corte seco',
        parseHTML: (el) => el.getAttribute('data-kind') ?? 'Corte seco',
        renderHTML: (a) => ({ 'data-kind': a.kind })
      }
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-type="transition"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'transition' }), 0]
  },
  addNodeView() {
    return ReactNodeViewRenderer(TransitionView)
  },
  addKeyboardShortcuts() {
    return { Backspace: backspaceToParagraph(this.name) }
  }
})

export const SoundUp = Node.create({
  name: 'soundUp',
  group: 'block',
  content: 'inline*',
  defining: true,

  addAttributes() {
    return {
      seconds: {
        default: 3,
        parseHTML: (el) => Number(el.getAttribute('data-seconds')) || 3,
        renderHTML: (a) => ({ 'data-seconds': a.seconds })
      }
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-type="soundUp"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'soundUp' }), 0]
  },
  addNodeView() {
    return ReactNodeViewRenderer(SoundUpView)
  },
  addKeyboardShortcuts() {
    return { Backspace: backspaceToParagraph(this.name) }
  }
})

/** Trecho mostrado com som original, sem narração (jornal, gameplay, série…). Ocupa tempo na timeline. */
export const Sonora = Node.create({
  name: 'sonora',
  group: 'block',
  content: 'inline*',
  defining: true,

  addAttributes() {
    return {
      seconds: {
        default: 5,
        parseHTML: (el) => Number(el.getAttribute('data-seconds')) || 5,
        renderHTML: (a) => ({ 'data-seconds': a.seconds })
      },
      /** a pausa foi criada no meio de uma fala (a fala foi dividida): ao apagar, as metades se juntam de novo */
      split: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-split') === 'true',
        renderHTML: (a) => (a.split ? { 'data-split': 'true' } : {})
      },
      attachments: jsonAttr('data-attachments', [])
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-type="sonora"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'sonora' }), 0]
  },
  addNodeView() {
    return ReactNodeViewRenderer(SonoraView)
  },
  addKeyboardShortcuts() {
    return { Backspace: backspaceToParagraph(this.name) }
  }
})

export const Chapter = Node.create({
  name: 'chapter',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes() {
    return {
      // lettering capitular (transição de capítulo) no vídeo: null = segue o padrão do roteiro
      lettering: {
        default: null,
        parseHTML: (el) => (el.getAttribute('data-lettering') === 'on' ? true : el.getAttribute('data-lettering') === 'off' ? false : null),
        renderHTML: (a) => (a.lettering === null || a.lettering === undefined ? {} : { 'data-lettering': a.lettering ? 'on' : 'off' })
      }
    }
  },

  parseHTML() {
    return [{ tag: 'h2[data-type="chapter"]' }, { tag: 'h1' }, { tag: 'h2' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['h2', mergeAttributes(HTMLAttributes, { 'data-type': 'chapter', class: 'blk-chapter' }), 0]
  },
  addKeyboardShortcuts() {
    return { Backspace: backspaceToParagraph(this.name) }
  },
  addInputRules() {
    return [textblockTypeInputRule({ find: /^#\s$/, type: this.type })]
  }
})

/** Duração própria de uma fala (ritmo variado), definida esticando o bloco na timeline. */
export const SpeechTiming = Extension.create({
  name: 'speechTiming',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          seconds: {
            default: null,
            parseHTML: (el) => Number(el.getAttribute('data-seconds')) || null,
            renderHTML: (a) => (a.seconds ? { 'data-seconds': a.seconds } : {})
          }
        }
      }
    ]
  }
})

// mesma ordem do painel Inserir: Capítulo, Prompt, Fala, Transição, Sobe som, Pausa
const TYPE_KEYS: [string, string][] = [
  ['script.chapter', 'chapter'],
  ['script.prompt', 'prompt'],
  ['script.speech', 'paragraph'],
  ['script.transition', 'transition'],
  ['script.soundUp', 'soundUp'],
  ['script.pause', 'sonora']
]

/** trocar o tipo do bloco pelo teclado (as teclas vêm de keys.ts e o usuário pode mudar) */
export const ScriptKeys = Extension.create({
  name: 'scriptKeys',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('scriptKeys'),
        props: {
          handleKeyDown: (_view, e) => {
            const hit = TYPE_KEYS.find(([id]) => isKey(e, id))
            if (!hit) return false
            e.preventDefault()
            editor.commands.setNode(hit[1])
            return true
          }
        }
      })
    ]
  }
})

/**
 * Converte linhas coladas no formato do roteiro:
 *   "[instrução]"            -> bloco de prompt
 *   "[instrução] fala aqui"  -> prompt + fala
 */
export function convertBracketLines(editor: Editor | null) {
  if (!editor || editor.isDestroyed) return
  const { state } = editor
  const { schema } = state
  const tr = state.tr
  state.doc.forEach((node, offset) => {
    if (node.type.name !== 'paragraph') return
    const m = node.textContent.match(/^\s*\[([^[\]]+)\]\s*(.*)$/s)
    if (!m) return
    const promptText = m[1].trim()
    const rest = m[2].trim()
    const nodes = [schema.nodes.prompt.create(null, promptText ? schema.text(promptText) : null)]
    if (rest) nodes.push(schema.nodes.paragraph.create(null, schema.text(rest)))
    const from = tr.mapping.map(offset)
    tr.replaceWith(from, from + node.nodeSize, nodes)
  })
  if (tr.docChanged) editor.view.dispatch(tr)
}
