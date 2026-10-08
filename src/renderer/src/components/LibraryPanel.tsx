import { useState } from 'react'
import { Pencil, Trash2, Search, Bookmark } from 'lucide-react'
import { blockLabel, fileUrl, type LibraryItem } from '../lib'

interface Props {
  items: LibraryItem[]
  onInsert: (item: LibraryItem) => void
  onEdit: (item: LibraryItem) => void
  onDelete: (item: LibraryItem) => void
}

export const SNIPPET_MIME = 'application/x-rs-snippet'

export function LibraryPanel({ items, onInsert, onEdit, onDelete }: Props) {
  const [q, setQ] = useState('')
  const shown = items.filter((i) => i.title.toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="panel-body">
      <div className="search">
        <Search size={14} />
        <input placeholder="Buscar atalho…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {items.length === 0 && (
        <div className="empty-lib">
          <Bookmark size={22} />
          <p>
            Clique com o <b>botão direito</b> num prompt, transição ou sobe som e escolha <b>Salvar na biblioteca</b>.
          </p>
          <p className="muted small">Depois é só arrastar o atalho pro texto, ou clicar pra inserir no cursor.</p>
        </div>
      )}
      <div className="lib-grid">
        {shown.map((item) => (
          <div
            key={item.id}
            className={'lib-card t-' + item.node.type}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(SNIPPET_MIME, item.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={() => onInsert(item)}
            title={`${blockLabel(item.node.type ?? '')} · clique pra inserir ou arraste pro texto`}
          >
            {item.cover ? (
              <div className="lib-cover" style={{ backgroundImage: `url("${fileUrl(item.cover)}")` }} />
            ) : (
              <div className="lib-cover text">{item.title}</div>
            )}
            <div className="lib-meta">
              <span className="lib-title">{item.title}</span>
              <span className="lib-type">{blockLabel(item.node.type ?? '')}</span>
            </div>
            <div className="lib-tools" onClick={(e) => e.stopPropagation()}>
              <button className="icon-btn" title="Editar" onClick={() => onEdit(item)}>
                <Pencil size={13} />
              </button>
              <button className="icon-btn danger" title="Excluir" onClick={() => confirm(`Excluir "${item.title}"?`) && onDelete(item)}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
