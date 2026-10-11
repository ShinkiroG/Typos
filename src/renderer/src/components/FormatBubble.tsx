import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { Bold, Italic, Underline, Strikethrough, Baseline, Highlighter, RemoveFormatting, Minus, Plus, Clapperboard, BookOpen } from 'lucide-react'
import { FontPicker } from '../style/FontPicker'
import { api } from '../lib'

const TEXT_COLORS = ['#ffffff', '#ffd34d', '#ff8a5c', '#ff6b6b', '#ff6bd5', '#a26bff', '#7c8cff', '#4fd6f5', '#4fe0c4', '#8bd450']
const MARKS = ['#ffd34d55', '#ff6b6b55', '#ff6bd555', '#a26bff55', '#4fd6f555', '#4fe0c455', '#8bd45055']

let fontCache: string[] | null = null

/**
 * Barrinha que aparece em cima do texto selecionado (como a do Word): fonte, tamanho,
 * negrito, itálico, sublinhado, tachado, cor, marca-texto e os atalhos de prompt/referência.
 */
export function FormatBubble({
  editor,
  onPrompt,
  onReference
}: {
  editor: Editor | null
  onPrompt: (sel: { from: number; to: number }) => void
  onReference: (sel: { from: number; to: number }) => void
}) {
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null)
  const [, setTick] = useState(0)
  const [fonts, setFonts] = useState<string[]>(fontCache ?? [])
  const [palette, setPalette] = useState<'color' | 'mark' | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  useEffect(() => {
    if (!fontCache) api.systemFonts().then((f) => setFonts((fontCache = f)))
  }, [])

  useEffect(() => {
    if (!editor) return
    const place = () => {
      const { from, to, empty } = editor.state.selection
      if (empty || dragging.current || !editor.isEditable || !editor.state.doc.textBetween(from, to).trim()) {
        setPos(null)
        setPalette(null)
        return
      }
      try {
        const a = editor.view.coordsAtPos(from)
        const b = editor.view.coordsAtPos(to)
        const top = Math.min(a.top, b.top)
        const below = top < 120
        const x = Math.max(16, Math.min(window.innerWidth - 16, (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2))
        setPos({ x, y: below ? Math.max(a.bottom, b.bottom) + 10 : top - 10, below })
      } catch {
        setPos(null)
      }
      setTick((n) => n + 1)
    }
    const dom = editor.view.dom
    // arrastando pra selecionar: só mostra quando solta (igual ao Word)
    const down = () => {
      dragging.current = true
      setPos(null)
    }
    const up = () => {
      dragging.current = false
      setTimeout(place, 0)
    }
    editor.on('selectionUpdate', place)
    editor.on('transaction', place)
    dom.addEventListener('mousedown', down)
    window.addEventListener('mouseup', up)
    const scroller = dom.closest('.editor-scroll')
    scroller?.addEventListener('scroll', place)
    // clicou fora do texto e da barra: some
    const outside = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (ref.current?.contains(t) || t.closest?.('.fp-pop') || dom.contains(t)) return
      setPos(null)
    }
    window.addEventListener('mousedown', outside)
    return () => {
      editor.off('selectionUpdate', place)
      editor.off('transaction', place)
      dom.removeEventListener('mousedown', down)
      window.removeEventListener('mouseup', up)
      scroller?.removeEventListener('scroll', place)
      window.removeEventListener('mousedown', outside)
    }
  }, [editor])

  if (!editor || !pos) return null

  const chain = () => editor.chain().focus()
  const sel = () => ({ from: editor.state.selection.from, to: editor.state.selection.to })
  const style = editor.getAttributes('textStyle') as { fontFamily?: string; fontSize?: string; color?: string }
  // tamanho atual: o da marca, senão o que está na tela
  const sizeNow = (() => {
    if (style.fontSize) return parseFloat(style.fontSize)
    try {
      const n = editor.view.domAtPos(editor.state.selection.from).node
      const el = (n.nodeType === 3 ? n.parentElement : n) as HTMLElement
      return Math.round(parseFloat(getComputedStyle(el).fontSize))
    } catch {
      return 22
    }
  })()
  const setSize = (v: number) => chain().setFontSize(`${Math.max(8, Math.min(96, v))}px`).run()

  const btn = (on: boolean, title: string, onClick: () => void, icon: React.ReactNode) => (
    <button className={'fb-btn' + (on ? ' on' : '')} title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {icon}
    </button>
  )

  return (
    <div
      ref={ref}
      className={'format-bubble' + (pos.below ? ' below' : '')}
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => {
        // não deixa o clique na barra tirar a seleção do texto
        if (!(e.target as HTMLElement).closest('input')) e.preventDefault()
      }}
    >
      <div className="fb-font">
        <FontPicker
          compact
          fonts={fonts}
          value={style.fontFamily?.replace(/^"|"$/g, '')}
          placeholder="Fonte"
          onChange={(v) => (v ? chain().setFontFamily(`"${v}"`).run() : chain().unsetFontFamily().run())}
        />
      </div>
      <div className="fb-size" title="Tamanho da fonte">
        <button className="fb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setSize(sizeNow - 2)}>
          <Minus size={12} />
        </button>
        <span>{sizeNow}</span>
        <button className="fb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setSize(sizeNow + 2)}>
          <Plus size={12} />
        </button>
      </div>
      <span className="fb-sep" />
      {btn(editor.isActive('bold'), 'Negrito (Ctrl+B) · ênfase na fala, vai pro Claude', () => chain().toggleBold().run(), <Bold size={14} />)}
      {btn(editor.isActive('italic'), 'Itálico (Ctrl+I)', () => chain().toggleItalic().run(), <Italic size={14} />)}
      {btn(editor.isActive('underline'), 'Sublinhado (Ctrl+U)', () => chain().toggleUnderline().run(), <Underline size={14} />)}
      {btn(editor.isActive('strike'), 'Tachado', () => chain().toggleStrike().run(), <Strikethrough size={14} />)}
      <span className="fb-sep" />
      <div className="fb-pal-wrap">
        {btn(!!style.color, 'Cor do texto', () => setPalette((p) => (p === 'color' ? null : 'color')), (
          <span className="fb-color">
            <Baseline size={14} />
            <i style={{ background: style.color ?? '#ffffff' }} />
          </span>
        ))}
        {btn(editor.isActive('highlight'), 'Marca-texto', () => setPalette((p) => (p === 'mark' ? null : 'mark')), <Highlighter size={14} />)}
        {palette && (
          <div className="fb-palette">
            {(palette === 'color' ? TEXT_COLORS : MARKS).map((c) => (
              <button
                key={c}
                className="fb-swatch"
                style={{ background: c }}
                title={c}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (palette === 'color') chain().setColor(c).run()
                  else chain().setHighlight({ color: c }).run()
                  setPalette(null)
                }}
              />
            ))}
            <button
              className="fb-swatch none"
              title="Tirar"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (palette === 'color') chain().unsetColor().run()
                else chain().unsetHighlight().run()
                setPalette(null)
              }}
            >
              ×
            </button>
          </div>
        )}
      </div>
      {btn(false, 'Limpar formatação (fonte, tamanho, cor, negrito…)', () =>
        // só o visual: prompt do trecho e referência ficam
        chain().unsetBold().unsetItalic().unsetUnderline().unsetStrike().unsetHighlight().unsetColor().unsetFontFamily().unsetFontSize().removeEmptyTextStyle().run(), <RemoveFormatting size={14} />)}
      <span className="fb-sep" />
      {btn(false, 'Criar prompt pra este trecho', () => onPrompt(sel()), <Clapperboard size={14} />)}
      {btn(false, 'Criar referência bibliográfica', () => onReference(sel()), <BookOpen size={14} />)}
    </div>
  )
}
