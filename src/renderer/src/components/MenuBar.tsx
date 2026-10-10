import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Check } from 'lucide-react'

export interface MenuItem {
  label?: string
  shortcut?: string
  onClick?: () => void
  disabled?: boolean
  checked?: boolean
  sep?: boolean
  /** submenu (ex.: Abrir recente); pode ser carregado na hora */
  items?: MenuItem[] | (() => Promise<MenuItem[]>)
}
export interface Menu {
  label: string
  items: MenuItem[]
}

/** Menus no topo (Arquivo, Editar…): clique abre, passar o mouse troca, Esc/fora fecha. */
export function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null)
  // a barra do topo tem rolagem própria: a lista abre "por cima de tudo" (fixa), embaixo do título
  const [at, setAt] = useState({ left: 0, top: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const place = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setAt({ left: r.left, top: r.bottom + 4 })
  }

  useEffect(() => {
    if (open === null) return
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(null)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null)
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [open])

  return (
    <div className="menubar" ref={ref}>
      {menus.map((m, i) => (
        <div key={m.label} className="mb-root">
          <button
            className={'mb-title' + (open === i ? ' on' : '')}
            onMouseDown={(e) => {
              e.preventDefault()
              place(e.currentTarget)
              setOpen(open === i ? null : i)
            }}
            onMouseEnter={(e) => {
              if (open === null) return
              place(e.currentTarget)
              setOpen(i)
            }}
          >
            {m.label}
          </button>
          {open === i && <MenuList items={m.items} close={() => setOpen(null)} style={at} />}
        </div>
      ))}
    </div>
  )
}

function MenuList({ items, close, sub, style }: { items: MenuItem[]; close: () => void; sub?: boolean; style?: React.CSSProperties }) {
  const [subOpen, setSubOpen] = useState<number | null>(null)
  const [loaded, setLoaded] = useState<Record<number, MenuItem[]>>({})
  return (
    <div className={'mb-list' + (sub ? ' sub' : '')} style={style} onMouseDown={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="mb-sep" />
        ) : (
          <div
            key={i}
            className="mb-item-wrap"
            onMouseEnter={async () => {
              setSubOpen(it.items ? i : null)
              if (typeof it.items === 'function' && !loaded[i]) {
                const list = await it.items()
                setLoaded((l) => ({ ...l, [i]: list }))
              }
            }}
          >
            <button
              className="mb-item"
              disabled={it.disabled}
              onClick={() => {
                if (it.items) return
                close()
                it.onClick?.()
              }}
            >
              <span className="mb-check">{it.checked ? <Check size={12} /> : null}</span>
              <span className="mb-label">{it.label}</span>
              {it.shortcut && <span className="mb-key">{it.shortcut}</span>}
              {it.items && <ChevronRight size={13} className="mb-arrow" />}
            </button>
            {subOpen === i && it.items && (
              <MenuList
                sub
                close={close}
                items={
                  typeof it.items === 'function'
                    ? loaded[i] ?? [{ label: 'carregando…', disabled: true }]
                    : it.items.length
                      ? it.items
                      : [{ label: 'nada aqui', disabled: true }]
                }
              />
            )}
          </div>
        )
      )}
    </div>
  )
}
