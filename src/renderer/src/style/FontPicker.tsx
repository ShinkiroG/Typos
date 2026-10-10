import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'

/** escolher uma fonte instalada vendo cada uma com a própria cara (com busca) */
export function FontPicker({
  label,
  fonts,
  value,
  onChange,
  placeholder = 'escolher fonte…',
  compact
}: {
  label?: string
  fonts: string[]
  value?: string
  onChange: (v: string | undefined) => void
  placeholder?: string
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  // a lista abre "por cima de tudo" (fixa), embaixo do botão ou em cima se não couber
  const [pos, setPos] = useState<React.CSSProperties>({})
  const place = () => {
    const r = ref.current!.querySelector('.fp-btn')!.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 12
    const above = r.top - 12
    const up = below < 300 && above > below
    const maxH = Math.min(380, up ? above : below)
    setPos(up ? { left: r.left, bottom: window.innerHeight - r.top + 4, width: Math.max(r.width, 280), maxHeight: maxH } : { left: r.left, top: r.bottom + 4, width: Math.max(r.width, 280), maxHeight: maxH })
  }
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    // rolou a página: fecha (senão a lista fica solta no lugar antigo)
    const scroll = (e: Event) => !(e.target as HTMLElement).closest?.('.fp-pop') && setOpen(false)
    window.addEventListener('mousedown', down)
    window.addEventListener('scroll', scroll, true)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [open])
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (s ? fonts.filter((f) => f.toLowerCase().includes(s)) : fonts).slice(0, 400)
  }, [fonts, q])

  return (
    <div className={'fp' + (compact ? ' compact' : '')} ref={ref}>
      {label && <span className="fp-label">{label}</span>}
      <button
        className="fp-btn"
        onClick={() => {
          if (!open) place()
          setOpen((o) => !o)
        }} style={{ fontFamily: value ? `"${value}"` : undefined }}>
        <span>{value ?? placeholder}</span>
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
        <div className="fp-pop" style={pos}>
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
