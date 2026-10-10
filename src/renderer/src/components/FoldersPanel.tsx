import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderPlus, RefreshCw, X, ChevronDown, ChevronRight, Search, Play, LayoutGrid, Grid3x3, List, Image as ImageIcon, Music, Film } from 'lucide-react'
import { api, fileUrl, uid } from '../lib'
import { AudioPlayButton } from '../editor/views'

type Folder = { id: string; name: string; path: string }
type Item = { path: string; name: string; rel: string; kind: 'image' | 'audio' | 'video' }
type Scan = Item[] | { error: string }
type View = 'grid' | 'small' | 'list'
type KindFilter = 'all' | Item['kind']

export const FILE_MIME = 'application/x-rs-file'

/** quantos itens aparecem de cada vez (o resto em "Mostrar mais") */
const PAGE = 120

// escaneamento e miniaturas ficam guardados enquanto o app está aberto:
// trocar de aba não reescaneia nem regera nada (↻ força)
const scanCache = new Map<string, Scan>()
const thumbCache = new Map<string, string | null>()

function remembered<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

/** Miniatura do Windows, pedida só quando o item aparece na tela. */
function LazyThumb({ item, size }: { item: Item; size: number }) {
  const key = `${size}|${item.path}`
  const [src, setSrc] = useState<string | null | undefined>(thumbCache.get(key))
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (src !== undefined || !ref.current) return
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      api.thumb(item.path, size).then((u) => {
        thumbCache.set(key, u)
        setSrc(u)
      })
    }, { rootMargin: '200px' })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [key, src, item.path, size])
  return (
    <div className={'fi-thumb k-' + item.kind} ref={ref}>
      {src ? <img src={src} draggable={false} /> : <span className="fi-ph">{item.kind === 'video' ? <Film size={16} /> : <ImageIcon size={16} />}</span>}
      {item.kind === 'video' && <Play size={12} className="fi-play" />}
    </div>
  )
}

/**
 * Pastas de mídia do PC (SFX, referências, gameplay…). O app só lê a pasta; ao usar um
 * arquivo no roteiro ele é copiado pra dentro do projeto.
 */
export function FoldersPanel() {
  const [folders, setFolders] = useState<Folder[]>([])
  const [items, setItems] = useState<Record<string, Scan | undefined>>({})
  const [open, setOpen] = useState<Record<string, boolean>>(() => remembered('typos.foldersOpen', {}))
  const [shown, setShown] = useState<Record<string, number>>({})
  const [q, setQ] = useState('')
  const [view, setView] = useState<View>(() => remembered('typos.foldersView', 'grid'))
  const [kind, setKind] = useState<KindFilter>(() => remembered('typos.foldersKind', 'all'))

  useEffect(() => {
    try {
      localStorage.setItem('typos.foldersView', JSON.stringify(view))
      localStorage.setItem('typos.foldersKind', JSON.stringify(kind))
      localStorage.setItem('typos.foldersOpen', JSON.stringify(open))
    } catch {
      /* sem storage */
    }
  }, [view, kind, open])

  const scan = async (f: Folder, force = false) => {
    if (!force && scanCache.has(f.path)) {
      setItems((m) => ({ ...m, [f.id]: scanCache.get(f.path) }))
      return
    }
    setItems((m) => ({ ...m, [f.id]: undefined })) // "escaneando…"
    const r = await api.scanFolder(f.path)
    scanCache.set(f.path, r)
    setItems((m) => ({ ...m, [f.id]: r }))
  }

  useEffect(() => {
    api.loadFolders().then((list) => {
      setFolders(list)
      setOpen((o) => ({ ...Object.fromEntries(list.map((f) => [f.id, true])), ...o }))
      list.forEach((f) => scan(f))
    })
  }, [])

  const save = (list: Folder[]) => {
    setFolders(list)
    api.saveFolders(list)
  }

  const add = async () => {
    const path = await api.pickFolder()
    if (!path || folders.some((f) => f.path === path)) return
    const f = { id: uid(), name: path.split(/[\\/]/).pop() || path, path }
    save([...folders, f])
    setOpen((o) => ({ ...o, [f.id]: true }))
    scan(f, true)
  }

  const query = q.trim().toLowerCase()
  const filtered = useMemo(() => {
    const out: Record<string, Scan | undefined> = {}
    for (const [id, list] of Object.entries(items))
      out[id] = Array.isArray(list) ? list.filter((i) => (kind === 'all' || i.kind === kind) && (!query || i.rel.toLowerCase().includes(query))) : list
    return out
  }, [items, query, kind])

  const thumbSize = view === 'grid' ? 160 : 72

  const renderItem = (it: Item) => (
    <div
      key={it.path}
      className={'folder-item k-' + it.kind}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(FILE_MIME, it.path)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      title={`${it.rel}\nArraste: em cima do texto = prévia no texto · na margem esquerda = prévia na margem · na timeline = clipe`}
    >
      {it.kind === 'audio' ? (
        <div className="fi-thumb k-audio">
          <AudioPlayButton url={fileUrl(it.path)} size={view === 'grid' ? 14 : 11} />
        </div>
      ) : view === 'list' ? (
        <span className="fi-icon">{it.kind === 'video' ? <Film size={13} /> : <ImageIcon size={13} />}</span>
      ) : (
        <LazyThumb item={it} size={thumbSize} />
      )}
      <span className="fi-name">{it.name}</span>
      {view === 'list' && <span className="fi-rel">{it.rel.includes('\\') || it.rel.includes('/') ? it.rel.replace(/[\\/][^\\/]*$/, '') : ''}</span>}
    </div>
  )

  return (
    <div className="panel-body">
      <div className="search">
        <Search size={14} />
        <input placeholder="Buscar nas pastas…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="folders-bar">
        <div className="seg">
          {(
            [
              ['all', 'Tudo', null],
              ['image', 'Imagens', <ImageIcon size={12} />],
              ['audio', 'Áudio', <Music size={12} />],
              ['video', 'Vídeo', <Film size={12} />]
            ] as const
          ).map(([k, label, icon]) => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)} title={label}>
              {icon ?? label}
            </button>
          ))}
        </div>
        <div className="seg">
          <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} title="Ícones grandes">
            <LayoutGrid size={13} />
          </button>
          <button className={view === 'small' ? 'on' : ''} onClick={() => setView('small')} title="Ícones pequenos">
            <Grid3x3 size={13} />
          </button>
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="Lista">
            <List size={13} />
          </button>
        </div>
      </div>

      {folders.length === 0 && (
        <div className="empty-lib">
          <FolderPlus size={22} />
          <p>
            Aponte pastas do seu PC (SFX, referências, gameplay…). Arraste os arquivos pro <b>texto</b> ou pra <b>timeline</b>.
          </p>
          <p className="muted small">O arquivo é copiado pra dentro do roteiro quando você usa.</p>
        </div>
      )}
      {folders.map((f) => {
        const list = filtered[f.id]
        const limit = shown[f.id] ?? PAGE
        return (
          <div key={f.id} className="folder">
            <div className="folder-head">
              <button className="icon-btn" onClick={() => setOpen((o) => ({ ...o, [f.id]: !o[f.id] }))}>
                {open[f.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <span
                className="folder-name"
                title={f.path}
                onDoubleClick={() => {
                  const name = prompt('Nome da pasta no painel:', f.name)
                  if (name?.trim()) save(folders.map((x) => (x.id === f.id ? { ...x, name: name.trim() } : x)))
                }}
              >
                {f.name}
                <small>{Array.isArray(list) ? list.length : ''}</small>
              </span>
              <button className="icon-btn" title="Escanear de novo" onClick={() => scan(f, true)}>
                <RefreshCw size={13} />
              </button>
              <button className="icon-btn danger" title="Tirar do painel (não apaga nada do PC)" onClick={() => save(folders.filter((x) => x.id !== f.id))}>
                <X size={13} />
              </button>
            </div>
            {open[f.id] &&
              (!list ? (
                <div className="muted small folder-msg">escaneando…</div>
              ) : 'error' in list ? (
                <div className="error small folder-msg">{list.error}</div>
              ) : list.length === 0 ? (
                <div className="muted small folder-msg">{query || kind !== 'all' ? 'nada encontrado' : 'sem imagens, áudios ou vídeos aqui'}</div>
              ) : (
                <>
                  <div className={'folder-items v-' + view}>{list.slice(0, limit).map(renderItem)}</div>
                  {list.length > limit && (
                    <button className="btn small block more-btn" onClick={() => setShown((s) => ({ ...s, [f.id]: limit + PAGE }))}>
                      Mostrar mais ({list.length - limit})
                    </button>
                  )}
                </>
              ))}
          </div>
        )
      })}
      <button className="btn block" onClick={add}>
        <FolderPlus size={14} /> Adicionar pasta
      </button>
    </div>
  )
}
