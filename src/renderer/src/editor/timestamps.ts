import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { formatTime } from '../lib'

/**
 * Tempo estimado no começo de cada bloco (o mesmo da timeline). Clicar leva o playhead pra lá.
 * Quem manda os tempos é o Workspace (vêm de buildTiming), via setTimestamps().
 */

interface TsState {
  enabled: boolean
  starts: number[]
  decos: DecorationSet
}

const key = new PluginKey<TsState>('typosTimestamps')

export const seekTo = (t: number) => window.dispatchEvent(new CustomEvent('typos:seek', { detail: t }))

function widget(t: number) {
  const el = document.createElement('span')
  el.className = 'ts-chip'
  el.contentEditable = 'false'
  el.textContent = formatTime(t)
  el.title = 'Levar a timeline pra cá'
  el.addEventListener('mousedown', (e) => {
    e.preventDefault()
    seekTo(t)
  })
  return el
}

export function setTimestamps(editor: Editor | null, enabled: boolean, starts: number[]) {
  if (!editor || editor.isDestroyed) return
  const { state, view } = editor
  const decos: Decoration[] = []
  if (enabled) {
    let i = 0
    state.doc.forEach((node, offset) => {
      const t = starts[i++] ?? 0
      // linha vazia não tem fala (e o chip ficaria em cima do "Fala…")
      if (!node.isTextblock || node.content.size === 0) return
      decos.push(Decoration.widget(offset + 1, () => widget(t), { side: -1, key: `ts-${offset}-${t.toFixed(1)}`, ignoreSelection: true }))
    })
  }
  view.dispatch(state.tr.setMeta(key, { enabled, starts, decos: DecorationSet.create(state.doc, decos) }).setMeta('addToHistory', false))
}

export const Timestamps = Extension.create({
  name: 'typosTimestamps',
  addProseMirrorPlugins() {
    return [
      new Plugin<TsState>({
        key,
        state: {
          init: () => ({ enabled: false, starts: [], decos: DecorationSet.empty }),
          apply(tr, old) {
            const meta = tr.getMeta(key) as TsState | undefined
            return meta ?? { ...old, decos: old.decos.map(tr.mapping, tr.doc) }
          }
        },
        props: {
          decorations: (state) => key.getState(state)?.decos
        }
      })
    ]
  }
})
