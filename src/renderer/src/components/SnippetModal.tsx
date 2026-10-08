import { useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { api, fileUrl } from '../lib'

export interface SnippetDraft {
  /** id existente quando editando */
  id?: string
  title: string
  cover: string | null
  /** imagem absoluta que pode virar capa com 1 clique (1º anexo do prompt) */
  suggestedCover?: string
}

interface Props {
  draft: SnippetDraft
  onCancel: () => void
  onSave: (d: SnippetDraft) => void
}

export function SnippetModal({ draft, onCancel, onSave }: Props) {
  const [title, setTitle] = useState(draft.title)
  const [cover, setCover] = useState<string | null>(draft.cover)

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{draft.id ? 'Editar atalho' : 'Salvar na biblioteca'}</h3>
        <label className="field">
          Título do atalho
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && title.trim() && onSave({ ...draft, title: title.trim(), cover })}
          />
        </label>
        <div className="field">
          Imagem (opcional)
          <div className="cover-row">
            {cover ? (
              <div className="cover-preview" style={{ backgroundImage: `url("${fileUrl(cover)}")` }}>
                <button className="icon-btn" onClick={() => setCover(null)} title="Tirar imagem">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="cover-preview empty">sem imagem: mostra o título</div>
            )}
            <div className="cover-btns">
              <button
                className="btn small"
                onClick={async () => {
                  const p = await api.pickLibraryCover()
                  if (p) setCover(p)
                }}
              >
                <ImagePlus size={14} /> Escolher…
              </button>
              {draft.suggestedCover && (
                <button className="btn small" onClick={async () => setCover(await api.coverFromFile(draft.suggestedCover!))}>
                  Usar o anexo
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!title.trim()} onClick={() => onSave({ ...draft, title: title.trim(), cover })}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  )
}
