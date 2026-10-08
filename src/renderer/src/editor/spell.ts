import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { api } from '../lib'

/**
 * Corretor desenhado pelo próprio editor. O sublinhado nativo do Chromium só aparece em
 * palavras digitadas na hora (texto colado/carregado nunca é verificado dentro do
 * ProseMirror), então as palavras vão pro Hunspell no processo principal.
 */

interface SpellState {
  decos: DecorationSet
}

export const spellKey = new PluginKey<SpellState>('typosSpell')

// palavras com letras/acentos, aceitando apóstrofo e hífen internos ("d'água", "guarda-chuva")
const WORD = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu
/** só a fala e os capítulos; prompts e transições costumam misturar idiomas */
const CHECKED = new Set(['paragraph', 'chapter'])

let lang = 'pt-BR'
/** palavra → errada? (só pro idioma atual) */
const cache = new Map<string, boolean>()

const ignorable = (w: string) => w.length < 2 || /^\p{Lu}+$/u.test(w) // siglas
const blockText = (node: PMNode) => node.textBetween(0, node.content.size, '\n', '￼')

function words(doc: PMNode) {
  const out: { word: string; from: number; to: number }[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (!CHECKED.has(node.type.name)) return false
    for (const m of blockText(node).matchAll(WORD)) {
      if (ignorable(m[0])) continue
      out.push({ word: m[0], from: pos + 1 + m.index!, to: pos + 1 + m.index! + m[0].length })
    }
    return false
  })
  return out
}

function build(doc: PMNode, caret?: number) {
  const decos = words(doc)
    // a palavra que está sendo digitada só é julgada quando o cursor sai dela
    .filter((w) => cache.get(w.word) && !(caret !== undefined && caret >= w.from && caret <= w.to))
    .map((w) => Decoration.inline(w.from, w.to, { class: 'spell-error' }))
  return DecorationSet.create(doc, decos)
}

async function refresh(view: EditorView) {
  if (lang === 'off' || view.isDestroyed) return
  const asked = lang
  const unknown = [...new Set(words(view.state.doc).map((w) => w.word))].filter((w) => !cache.has(w))
  if (unknown.length) {
    const wrong = new Set(await api.spellCheck(asked, unknown))
    if (asked !== lang) return // trocou de idioma no meio
    for (const w of unknown) cache.set(w, wrong.has(w))
  }
  if (view.isDestroyed) return
  const sel = view.state.selection
  const caret = view.hasFocus() && sel.empty ? sel.head : undefined
  view.dispatch(view.state.tr.setMeta(spellKey, { decos: build(view.state.doc, caret) }).setMeta('addToHistory', false))
}

/** Palavra errada na posição (null se correta ou fora da fala). */
export function misspelledAt(doc: PMNode, pos: number) {
  if (lang === 'off') return null
  const $p = doc.resolve(pos)
  if (!$p.parent.isTextblock || !CHECKED.has($p.parent.type.name)) return null
  const start = $p.start()
  const off = pos - start
  for (const m of blockText($p.parent).matchAll(WORD)) {
    if (m.index! <= off && off <= m.index! + m[0].length) {
      return cache.get(m[0]) ? { word: m[0], from: start + m.index!, to: start + m.index! + m[0].length } : null
    }
  }
  return null
}

export const spellSuggestions = (word: string) => (lang === 'off' ? Promise.resolve([]) : api.spellSuggest(lang, word))

/** Troca de idioma (vem do formato do roteiro). "off" desliga. */
export function setSpellLanguage(editor: Editor | null, next: string) {
  lang = next
  cache.clear()
  if (!editor || editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(spellKey, { decos: DecorationSet.empty }).setMeta('addToHistory', false))
  refresh(editor.view)
}

export function acceptWord(editor: Editor | null, word: string) {
  api.spellAdd(word)
  cache.set(word, false)
  if (editor && !editor.isDestroyed) refresh(editor.view)
}

export const SpellCheck = Extension.create({
  name: 'typosSpell',
  addProseMirrorPlugins() {
    return [
      new Plugin<SpellState>({
        key: spellKey,
        state: {
          init: () => ({ decos: DecorationSet.empty }),
          apply(tr, old) {
            const meta = tr.getMeta(spellKey) as SpellState | undefined
            return meta ?? { decos: old.decos.map(tr.mapping, tr.doc) }
          }
        },
        props: {
          decorations: (state) => (lang === 'off' ? DecorationSet.empty : spellKey.getState(state)?.decos)
        },
        view(view) {
          let timer: number | undefined
          const schedule = (ms: number) => {
            window.clearTimeout(timer)
            timer = window.setTimeout(() => refresh(view), ms)
          }
          schedule(150)
          return {
            update(v, prev) {
              if (!v.state.doc.eq(prev.doc)) schedule(450)
              else if (!v.state.selection.eq(prev.selection)) schedule(700)
            },
            destroy() {
              window.clearTimeout(timer)
            }
          }
        }
      })
    ]
  }
})
