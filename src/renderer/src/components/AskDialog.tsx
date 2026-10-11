import { useEffect, useRef, useState } from 'react'

/**
 * Caixinha de texto do app (o Electron não tem window.prompt).
 * Use: const nome = await askText('Nome da pasta:', 'Nova pasta')
 */
export function askText(label: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => window.dispatchEvent(new CustomEvent('typos:ask', { detail: { label, initial, resolve } })))
}

export function AskDialog() {
  const [ask, setAsk] = useState<{ label: string; initial: string; resolve: (v: string | null) => void } | null>(null)
  const [text, setText] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail
      setAsk(d)
      setText(d.initial)
    }
    window.addEventListener('typos:ask', on)
    return () => window.removeEventListener('typos:ask', on)
  }, [])
  useEffect(() => {
    if (ask) setTimeout(() => ref.current?.select(), 0)
  }, [ask])
  if (!ask) return null
  const done = (v: string | null) => {
    ask.resolve(v)
    setAsk(null)
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => done(null)}>
      <div className="modal ask-modal" onMouseDown={(e) => e.stopPropagation()}>
        <label className="ask-label">{ask.label}</label>
        <input
          ref={ref}
          autoFocus
          className="ask-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') done(text.trim() || null)
            if (e.key === 'Escape') done(null)
          }}
        />
        <div className="modal-actions">
          <button className="btn" onClick={() => done(null)}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!text.trim()} onClick={() => done(text.trim())}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
