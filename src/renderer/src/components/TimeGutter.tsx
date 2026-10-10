import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { formatTime, type Timing } from '../lib'
import { seekTo } from '../editor/timestamps'

/**
 * Tempo de cada bloco numa coluna fixa à esquerda do texto, sempre na altura da primeira
 * linha (fala, prompt, pausa… tudo igual). Clicar leva a timeline pra lá.
 */
export function TimeGutter({ editor, timing }: { editor: Editor | null; timing: Timing }) {
  const ref = useRef<HTMLDivElement>(null)
  const [chips, setChips] = useState<{ pos: number; top: number; t: number }[]>([])
  const [x, setX] = useState(0)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el || !editor || editor.isDestroyed) return setChips([])
    const box = el.getBoundingClientRect()
    const base = box.top
    // coluna = borda esquerda do texto (igual pra todo tipo de bloco)
    setX(editor.view.dom.getBoundingClientRect().left - box.left)
    const out: { pos: number; top: number; t: number }[] = []
    let i = 0
    editor.state.doc.forEach((node, offset) => {
      const t = timing.blockStarts[i++] ?? 0
      // linha vazia não tem fala; bloco escondido por filtro não aparece
      if (!node.isTextblock || node.content.size === 0) return
      const dom = editor.view.nodeDOM(offset)
      if (!(dom instanceof HTMLElement) || dom.offsetParent === null) return
      // primeira letra de verdade (pula quebra de linha/espaço no começo)
      let first = offset + 1
      let found = false
      node.descendants((child, p) => {
        if (found) return false
        if (child.isText && /\S/.test(child.text ?? '')) {
          first = offset + 1 + p + (child.text!.length - child.text!.trimStart().length)
          found = true
          return false
        }
        return true
      })
      try {
        const c = editor.view.coordsAtPos(first, 1)
        out.push({ pos: offset, top: (c.top + c.bottom) / 2 - base, t })
      } catch {
        /* nó sem posição de texto */
      }
    })
    setChips(out)
  }, [editor, timing])

  useLayoutEffect(() => {
    measure()
  }, [measure])

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(editor.view.dom)
    return () => ro.disconnect()
  }, [editor, measure])

  return (
    <div className="time-gutter" ref={ref}>
      {chips.map((c) => (
        <button
          key={c.pos}
          className="ts-chip"
          style={{ top: c.top, left: x }}
          title="Levar a timeline pra cá"
          onMouseDown={(e) => {
            e.preventDefault()
            seekTo(c.t)
          }}
        >
          {formatTime(c.t)}
        </button>
      ))}
    </div>
  )
}
