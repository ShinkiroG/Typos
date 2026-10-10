import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Copy, X, AlertTriangle, Pencil } from 'lucide-react'
import { referencesText, type RefRange } from '../editor/reference'

type Ref = RefRange & { excerpt: string; block: number }

/** caixa pra digitar a referência do trecho selecionado */
export function RefModal({
  edit,
  onCancel,
  onSave
}: {
  edit: { text: string; excerpt: string; id?: string }
  onCancel: () => void
  onSave: (text: string) => void
}) {
  const [text, setText] = useState(edit.text)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  const ok = text.trim().length > 0
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal ref-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          <BookOpen size={16} /> {edit.id ? 'Editar referência' : 'Nova referência'}
        </h3>
        <blockquote className="ref-excerpt">{edit.excerpt.length > 220 ? edit.excerpt.slice(0, 220) + '…' : edit.excerpt}</blockquote>
        <textarea
          ref={ref}
          rows={4}
          value={text}
          placeholder="Ex.: VG Insights. Steam Games Market Report 2025. Disponível em: https://vginsights.com/… Acesso em: 10 out. 2026."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel()
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ok) onSave(text)
          }}
        />
        <div className="modal-actions">
          <span className="muted small">Ctrl+Enter salva</span>
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!ok} onClick={() => onSave(text)}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  )
}

/** o que pode estar faltando numa referência (só um lembrete, não bloqueia nada) */
function problems(text: string) {
  const t = text.trim()
  const out: string[] = []
  if (t.length < 12) out.push('muito curta')
  if (!/\b(1[5-9]|20)\d{2}\b/.test(t)) out.push('sem ano')
  return out
}

/** lista de todas as referências: conferir, pular pro trecho e copiar pro rodapé/descrição */
export function RefsPanel({
  refs,
  onClose,
  onJump,
  onEdit,
  onCopy
}: {
  refs: Ref[]
  onClose: () => void
  onJump: (r: Ref) => void
  onEdit: (r: Ref) => void
  onCopy: (text: string) => void
}) {
  // mesma fonte usada em vários trechos aparece uma vez, com os trechos embaixo
  const groups = useMemo(() => {
    const m = new Map<string, Ref[]>()
    for (const r of refs) {
      const k = r.text.trim()
      m.set(k, [...(m.get(k) ?? []), r])
    }
    return [...m.entries()]
  }, [refs])
  const text = referencesText(refs)
  const warn = groups.filter(([t]) => problems(t).length).length

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal refs-panel" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          <BookOpen size={16} /> Referências bibliográficas
          <button className="icon-btn" onClick={onClose} title="Fechar">
            <X size={16} />
          </button>
        </h3>
        {!groups.length ? (
          <p className="muted">
            Nenhuma ainda. Selecione um trecho do texto, clique com o botão direito e escolha <b>Criar referência</b>.
          </p>
        ) : (
          <>
            <p className="muted small">
              {groups.length} {groups.length === 1 ? 'fonte' : 'fontes'} em {refs.length} {refs.length === 1 ? 'trecho' : 'trechos'}
              {warn ? ` · ${warn} pra conferir` : ' · tudo certo'}
            </p>
            <ol className="refs-list">
              {groups.map(([t, list], i) => {
                const p = problems(t)
                return (
                  <li key={i}>
                    <div className="refs-text">
                      {t}
                      {p.length > 0 && (
                        <span className="refs-warn" title="Só um lembrete">
                          <AlertTriangle size={11} /> {p.join(', ')}
                        </span>
                      )}
                    </div>
                    {list.map((r) => (
                      <div key={r.from} className="refs-use">
                        <button className="refs-jump" onClick={() => onJump(r)} title="Ir pro trecho">
                          “{r.excerpt.length > 90 ? r.excerpt.slice(0, 90) + '…' : r.excerpt}”
                        </button>
                        <button className="icon-btn" title="Editar" onClick={() => onEdit(r)}>
                          <Pencil size={12} />
                        </button>
                      </div>
                    ))}
                  </li>
                )
              })}
            </ol>
            <label className="refs-out">
              Pro rodapé / descrição do vídeo
              <textarea readOnly rows={Math.min(8, groups.length + 2)} value={text} />
            </label>
          </>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Fechar
          </button>
          <button className="btn primary" disabled={!text} onClick={() => onCopy(text)}>
            <Copy size={13} /> Copiar
          </button>
        </div>
      </div>
    </div>
  )
}
