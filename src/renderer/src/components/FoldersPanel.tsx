import { useEffect, useMemo, useState } from 'react'
import { FolderPlus, RefreshCw, X, ChevronDown, ChevronRight, Search, Play } from 'lucide-react'
import { api, fileUrl, uid } from '../lib'
import { AudioPlayButton } from '../editor/views'

type Folder = { id: string; name: string; path: string }
type Item = { path: string; name: string; rel: string; kind: 'image' | 'audio' | 'video' }

export const FILE_MIME = 'application/x-rs-file'

/**
 * Pastas de mídia do PC (SFX, referências, gameplay…). O app só lê a pasta; ao usar um
 * arquivo no roteiro ele é copiado pra dentro do projeto.
 */
export function FoldersPanel({ onInsert }: { onInsert: (path: string) => void }) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [items, setItems] = useState<Record<string, Item[] | { error: string }>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [q, setQ] = useState('')

  const scan = async (f: Folder) => {
    setItems((m) => {
      const n = { ...m }
      delete n[f.id] // mostra "escaneando…"
      return n
    })
    const r = await api.scanFolder(f.path)
    setItems((m) => ({ ...m, [f.id]: r }))
  }

  useEffect(() => {
    api.loadFolders().then((list) => {
      setFolders(list)
      setOpen(Object.fromEntries(list.map((f) => [f.id, true])))
      list.forEach(scan)
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
    scan(f)
  }

  const query = q.trim().toLowerCase()
  const filtered = useMemo(() => {
    const out: Record<string, Item[] | { error: string }> = {}
    for (const [id, list] of Object.entries(items)) out[id] = Array.isArray(list) ? list.filter((i) => !query || i.rel.toLowerCase().includes(query)) : list
    return out
  }, [items, query])

  return (
    <div className="panel-body">
      <div className="search">
        <Search size={14} />
        <input placeholder="Buscar nas pastas…" value={q} onChange={(e) => setQ(e.target.value)} />
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
        return (
          <div key={f.id} className="folder">
            <div className="folder-head">
              <button className="icon-btn" onClick={() => setOpen((o) => ({ ...o, [f.id]: !o[f.id] }))}>
                {open[f.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <span className="folder-name" title={f.path} onDoubleClick={() => {
                const name = prompt('Nome da pasta no painel:', f.name)
                if (name?.trim()) save(folders.map((x) => (x.id === f.id ? { ...x, name: name.trim() } : x)))
              }}>
                {f.name}
                <small>{Array.isArray(list) ? list.length : ''}</small>
              </span>
              <button className="icon-btn" title="Escanear de novo" onClick={() => scan(f)}>
                <RefreshCw size={13} />
              </button>
              <button
                className="icon-btn danger"
                title="Tirar do painel (não apaga nada do PC)"
                onClick={() => save(folders.filter((x) => x.id !== f.id))}
              >
                <X size={13} />
              </button>
            </div>
            {open[f.id] &&
              (!list ? (
                <div className="muted small folder-msg">escaneando…</div>
              ) : 'error' in list ? (
                <div className="error small folder-msg">{list.error}</div>
              ) : list.length === 0 ? (
                <div className="muted small folder-msg">{query ? 'nada encontrado' : 'sem imagens, áudios ou vídeos aqui'}</div>
              ) : (
                <div className="folder-items">
                  {list.slice(0, 400).map((it) => (
                    <div
                      key={it.path}
                      className={'folder-item k-' + it.kind}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(FILE_MIME, it.path)
                        e.dataTransfer.effectAllowed = 'copy'
                      }}
                      onClick={() => onInsert(it.path)}
                      title={`${it.rel}\nClique: anexa no bloco atual · arraste pro texto ou pra timeline`}
                    >
                      {it.kind === 'image' && <img src={fileUrl(it.path)} loading="lazy" />}
                      {it.kind === 'video' && (
                        <div className="fi-video">
                          <video src={fileUrl(it.path) + '#t=0.5'} preload="metadata" muted />
                          <Play size={14} />
                        </div>
                      )}
                      {it.kind === 'audio' && <AudioPlayButton url={fileUrl(it.path)} size={12} />}
                      <span className="fi-name">{it.name}</span>
                    </div>
                  ))}
                  {list.length > 400 && <div className="muted small folder-msg">+{list.length - 400}: use a busca</div>}
                </div>
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
