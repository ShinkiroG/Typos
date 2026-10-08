import { Plus, Trash2, Check } from 'lucide-react'
import { RESOLUTIONS, uid, type Format } from '../lib'

interface Props {
  formats: Format[]
  activeId: string
  onChange: (formats: Format[]) => void
  onSelect: (id: string) => void
}

export function FormatsPanel({ formats, activeId, onChange, onSelect }: Props) {
  const patch = (id: string, p: Partial<Format>) => onChange(formats.map((f) => (f.id === id ? { ...f, ...p } : f)))

  return (
    <div className="panel-body">
      <p className="muted small">Formatos ficam salvos no app e servem pra qualquer roteiro. O ativo define a velocidade de fala e o limite de duração.</p>
      {formats.map((f) => (
        <div key={f.id} className={'format-card' + (f.id === activeId ? ' active' : '')}>
          <div className="format-row">
            <input className="format-name" value={f.name} onChange={(e) => patch(f.id, { name: e.target.value })} />
            {f.id === activeId ? (
              <span className="pill">
                <Check size={12} /> neste roteiro
              </span>
            ) : (
              <button className="btn small" onClick={() => onSelect(f.id)}>
                Usar
              </button>
            )}
          </div>
          <div className="format-grid">
            <label>
              Proporção
              <select value={f.aspect} onChange={(e) => patch(f.id, { aspect: e.target.value })}>
                {Object.keys(RESOLUTIONS).map((a) => (
                  <option key={a} value={a}>
                    {a} · {RESOLUTIONS[a]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Palavras/min
              <input type="number" min={60} max={300} value={f.wpm} onChange={(e) => patch(f.id, { wpm: Number(e.target.value) || 150 })} />
            </label>
            <label>
              Duração máx. (s)
              <input
                type="number"
                min={0}
                placeholder="sem limite"
                value={f.maxSeconds ?? ''}
                onChange={(e) => patch(f.id, { maxSeconds: e.target.value ? Number(e.target.value) : null })}
              />
            </label>
          </div>
          {formats.length > 1 && (
            <button
              className="icon-btn danger format-del"
              title="Excluir formato"
              onClick={() => confirm(`Excluir o formato "${f.name}"?`) && onChange(formats.filter((x) => x.id !== f.id))}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ))}
      <button
        className="btn block"
        onClick={() => onChange([...formats, { id: uid(), name: 'Novo formato', aspect: '16:9', wpm: 150, maxSeconds: null }])}
      >
        <Plus size={14} /> Novo formato
      </button>
    </div>
  )
}
