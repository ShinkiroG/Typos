import { useEffect, useRef, useState } from 'react'
import { History, Star, X } from 'lucide-react'
import { forgetPrompt, loadPrompts, togglePin, updatePrompts, type SavedPrompts } from './prompts'

const MENU_W = 380

/** botão ao lado de "Como você imagina o motion": abre os prompts recentes e favoritos */
export function PromptMenu({ text, onPick }: { text: string; onPick: (t: string) => void }) {
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null)
  const [saved, setSaved] = useState<SavedPrompts>(loadPrompts)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  const close = () => setPos(null)
  const open = () => {
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    setSaved(loadPrompts())
    setPos({
      top: r.bottom + 4,
      left: Math.max(8, Math.min(window.innerWidth - MENU_W - 8, r.right - MENU_W)),
      maxH: Math.max(160, window.innerHeight - r.bottom - 16)
    })
  }

  useEffect(() => {
    if (!pos) return
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) close()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', close)
    }
  }, [pos])

  const cur = text.trim()
  const curPinned = !!cur && saved.pinned.includes(cur)
  const item = (t: string, pinned: boolean) => (
    <div key={(pinned ? 'p:' : 'r:') + t} className={'prm-item' + (t === cur ? ' cur' : '')}>
      <button
        className="prm-text"
        title={t}
        onClick={() => {
          onPick(t)
          close()
        }}
      >
        {t}
      </button>
      <button className={'icon-btn' + (pinned ? ' on' : '')} title={pinned ? 'Tirar dos favoritos' : 'Salvar nos favoritos'} onClick={() => setSaved(updatePrompts((s) => togglePin(s, t)))}>
        <Star size={12} />
      </button>
      <button className="icon-btn" title="Esquecer" onClick={() => setSaved(updatePrompts((s) => forgetPrompt(s, t)))}>
        <X size={12} />
      </button>
    </div>
  )

  return (
    <>
      <button ref={btn} type="button" className={'icon-btn prm-btn' + (pos ? ' on' : '')} title="Prompts recentes e favoritos" onClick={() => (pos ? close() : open())}>
        <History size={13} />
      </button>
      {pos && (
        <div ref={menu} className="prm-menu" style={{ top: pos.top, left: pos.left, width: MENU_W, maxHeight: pos.maxH }}>
          <button className="prm-save" disabled={!cur} onClick={() => setSaved(updatePrompts((s) => togglePin(s, cur)))}>
            <Star size={12} /> {curPinned ? 'Tirar o texto atual dos favoritos' : 'Salvar o texto atual nos favoritos'}
          </button>
          {!!saved.pinned.length && <div className="ctx-label">Favoritos</div>}
          {saved.pinned.map((t) => item(t, true))}
          {!!saved.recent.length && <div className="ctx-label">Recentes</div>}
          {saved.recent.map((t) => item(t, false))}
          {!saved.pinned.length && !saved.recent.length && <div className="prm-empty">Os prompts entram aqui quando você gera uma prévia. Clique na estrela pra deixar um sempre à mão.</div>}
        </div>
      )}
    </>
  )
}
