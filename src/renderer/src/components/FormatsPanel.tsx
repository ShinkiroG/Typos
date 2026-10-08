import { useEffect, useState } from 'react'
import { Plus, Trash2, Check, Languages } from 'lucide-react'
import { api, formatLang, langLabel, RESOLUTIONS, uid, type Format } from '../lib'

// os mais usados primeiro; o resto vem da lista do corretor
const PREFERRED = ['pt-BR', 'pt-PT', 'en-US', 'en-GB', 'es-ES']

interface Props {
  formats: Format[]
  activeId: string
  onChange: (formats: Format[]) => void
  onSelect: (id: string) => void
}

export function FormatsPanel({ formats, activeId, onChange, onSelect }: Props) {
  const patch = (id: string, p: Partial<Format>) => onChange(formats.map((f) => (f.id === id ? { ...f, ...p } : f)))
  const [langs, setLangs] = useState<string[]>(PREFERRED)
  useEffect(() => {
    api
      .spellLanguages()
      .then((all) => all.length && setLangs([...PREFERRED.filter((l) => all.includes(l)), ...all.filter((l) => !PREFERRED.includes(l)).sort()]))
      .catch(() => null)
  }, [])

  return (
    <div className="panel-body">
      <p className="muted small">Formatos ficam salvos no app e servem pra qualquer roteiro. O ativo define a velocidade de fala, o limite de duração e o <b>idioma do corretor ortográfico</b>.</p>
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
            <label className="format-lang">
              <span>
                <Languages size={11} /> Idioma do corretor
              </span>
              <select value={formatLang(f)} onChange={(e) => patch(f.id, { lang: e.target.value })}>
                {(langs.includes(formatLang(f)) ? langs : [formatLang(f), ...langs]).map((l) => (
                  <option key={l} value={l}>
                    {langLabel(l)} ({l})
                  </option>
                ))}
                <option value="off">Corretor desligado</option>
              </select>
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
        onClick={() => onChange([...formats, { id: uid(), name: 'Novo formato', aspect: '16:9', wpm: 150, maxSeconds: null, lang: 'pt-BR' }])}
      >
        <Plus size={14} /> Novo formato
      </button>
    </div>
  )
}
