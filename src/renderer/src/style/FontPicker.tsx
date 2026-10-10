import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'

/** escolher uma fonte instalada vendo cada uma com a própria cara (com busca) */
export function FontPicker({ label, fonts, value, onChange }: { label: string; fonts: string[]; value?: string; onChange: (v: string | undefined) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', down)
    return () => window.removeEventListener('mousedown', down)
  }, [open])
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (s ? fonts.filter((f) => f.toLowerCase().includes(s)) : fonts).slice(0, 400)
  }, [fonts, q])

  return (
    <div className="fp" ref={ref}>
      <span className="fp-label">{label}</span>
      <button className="fp-btn" onClick={() => setOpen((o) => !o)} style={{ fontFamily: value ? `"${value}"` : undefined }}>
        <span>{value ?? 'escolher fonte…'}</span>
        {value ? (
          <X
            size={12}
            onClick={(e) => {
              e.stopPropagation()
              onChange(undefined)
            }}
          />
        ) : (
          <ChevronDown size={13} />
        )}
      </button>
      {open && (
        <div className="fp-pop">
          <input autoFocus className="fp-search" placeholder={`Buscar entre ${fonts.length} fontes…`} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="fp-list">
            {!fonts.length && <div className="fp-empty">carregando as fontes do Windows…</div>}
            {list.map((f) => (
              <button
                key={f}
                className={'fp-item' + (f === value ? ' on' : '')}
                style={{ fontFamily: `"${f}"` }}
                onClick={() => {
                  onChange(f)
                  setOpen(false)
                }}
                title={f}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
