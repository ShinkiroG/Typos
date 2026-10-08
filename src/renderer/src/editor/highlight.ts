import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export interface HighlightRange {
  word: { from: number; to: number } | null
  /** trecho já falado do bloco atual (do começo do bloco até a palavra) */
  spoken: { from: number; to: number } | null
  block: { from: number; to: number } | null
}

export const highlightKey = new PluginKey<DecorationSet>('playbackHighlight')

/** Destaca no texto a palavra que a timeline está tocando. */
export const PlaybackHighlight = Extension.create({
  name: 'playbackHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: highlightKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(highlightKey) as HighlightRange | undefined
            if (meta === undefined) return old.map(tr.mapping, tr.doc)
            const decos: Decoration[] = []
            const size = tr.doc.content.size
            const ok = (r: { from: number; to: number } | null) => r && r.from >= 0 && r.to <= size && r.from < r.to
            if (ok(meta.block)) decos.push(Decoration.node(meta.block!.from, meta.block!.to, { class: 'tl-block' }))
            if (ok(meta.spoken)) decos.push(Decoration.inline(meta.spoken!.from, meta.spoken!.to, { class: 'tl-spoken' }))
            if (ok(meta.word)) decos.push(Decoration.inline(meta.word!.from, meta.word!.to, { class: 'tl-word' }))
            return DecorationSet.create(tr.doc, decos)
          }
        },
        props: {
          decorations(state) {
            return highlightKey.getState(state)
          }
        }
      })
    ]
  }
})
