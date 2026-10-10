import { useEffect, useState } from 'react'
import { Plus, Trash2, Check, Languages, Save, Undo2, ChevronDown, ChevronRight, FolderPlus, ImagePlus, X, Play } from 'lucide-react'
import { api, fileUrl, formatLang, langLabel, mediaKindOf, openPreview, RESOLUTIONS, uid, type Format } from '../lib'

// os mais usados primeiro; o resto vem da lista do corretor
const PREFERRED = ['pt-BR', 'pt-PT', 'en-US', 'en-GB', 'es-ES']

interface Props {
  formats: Format[]
  activeId: string
  onChange: (formats: Format[]) => void
  onSelect: (id: string) => void
}

/**
 * Formatos = estilos de vídeo (velocidade, duração, idioma, regras, referência de motion, assets).
 * Editar mexe num rascunho; "Salvar formato" grava junto com as preferências do Typos.
 */
export function FormatsPanel({ formats, activeId, onChange, onSelect }: Props) {
  const [drafts, setDrafts] = useState<Format[]>(formats)
  const [open, setOpen] = useState<Record<string, boolean>>({ [activeId]: true })
  const [langs, setLangs] = useState<string[]>(PREFERRED)

  // formatos salvos mudaram por fora (outro painel, importação): traz o que não está sendo editado
  useEffect(() => {
    setDrafts((ds) => {
      const byId = new Map(ds.map((d) => [d.id, d]))
      const kept = formats.map((f) => {
        const d = byId.get(f.id)
        return d && d.__dirty ? d : f
      })
      const fresh = ds.filter((d) => d.__dirty && !formats.some((f) => f.id === d.id))
      return [...kept, ...fresh]
    })
  }, [formats])

  useEffect(() => {
    api
      .spellLanguages()
      .then((all) => all.length && setLangs([...PREFERRED.filter((l) => all.includes(l)), ...all.filter((l) => !PREFERRED.includes(l)).sort()]))
      .catch(() => null)
  }, [])

  const patch = (id: string, p: Partial<Format>) => setDrafts((ds) => ds.map((f) => (f.id === id ? { ...f, ...p, __dirty: true } : f)))
  const saved = (id: string) => formats.find((f) => f.id === id)
  const clean = ({ __dirty, ...f }: Format) => f as Format

  const saveOne = (id: string) => {
    const d = drafts.find((f) => f.id === id)
    if (!d) return
    const next = saved(id) ? formats.map((f) => (f.id === id ? clean(d) : f)) : [...formats, clean(d)]
    setDrafts((ds) => ds.map((f) => (f.id === id ? clean(f) : f)))
    onChange(next)
  }
  const discard = (id: string) => {
    const s = saved(id)
    setDrafts((ds) => (s ? ds.map((f) => (f.id === id ? s : f)) : ds.filter((f) => f.id !== id)))
  }
  const remove = (f: Format) => {
    if (!confirm(`Excluir o formato "${f.name}"?`)) return
    setDrafts((ds) => ds.filter((x) => x.id !== f.id))
    if (saved(f.id)) onChange(formats.filter((x) => x.id !== f.id))
  }

  return (
    <div className="panel-body">
      <p className="muted small">
        Cada formato é um <b>estilo de vídeo</b>: velocidade de fala, duração, idioma do corretor, regras, referência de motion e assets. Fica salvo no
        Typos e serve pra qualquer roteiro.
      </p>
      {drafts.map((f) => {
        const dirty = !!f.__dirty || !saved(f.id)
        const isOpen = open[f.id] ?? false
        return (
          <div key={f.id} className={'format-card' + (f.id === activeId ? ' active' : '') + (dirty ? ' dirty' : '')}>
            <div className="format-row">
              <button className="icon-btn" onClick={() => setOpen((o) => ({ ...o, [f.id]: !isOpen }))} title={isOpen ? 'Recolher' : 'Abrir'}>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <input className="format-name" value={f.name} onChange={(e) => patch(f.id, { name: e.target.value })} />
              {f.id === activeId ? (
                <span className="pill">
                  <Check size={12} /> neste roteiro
                </span>
              ) : (
                saved(f.id) && (
                  <button className="btn small" onClick={() => onSelect(f.id)}>
                    Usar
                  </button>
                )
              )}
            </div>
            {!isOpen && (
              <div className="format-summary muted small">
                {f.aspect} · {f.wpm} ppm{f.maxSeconds ? ` · até ${f.maxSeconds}s` : ''}
                {f.motionRef ? ' · ref. de motion' : ''}
                {f.assetFolders?.length ? ` · ${f.assetFolders.length} pasta(s)` : ''}
              </div>
            )}
            {isOpen && (
              <>
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

                <label className="format-field">
                  Regras do estilo
                  <textarea
                    rows={4}
                    value={f.rules ?? ''}
                    placeholder="Ex.: overlays de lower third, pngtuber no canto inferior, cortes secos, legenda amarela… (vai junto quando a IA mexer no roteiro)"
                    onChange={(e) => patch(f.id, { rules: e.target.value })}
                  />
                </label>

                <div className="format-field">
                  <label className="toggle-row">
                    <input type="checkbox" checked={!!f.motionRef} onChange={(e) => patch(f.id, { motionRef: e.target.checked })} />
                    Referência pro motion
                  </label>
                  {f.motionRef && (
                    <div className="format-refs">
                      {(f.motionRefFiles ?? []).map((p) => (
                        <div key={p} className="format-ref">
                          {mediaKindOf(p) === 'video' ? (
                            <video src={fileUrl(p)} preload="metadata" muted onClick={() => openPreview(fileUrl(p))} />
                          ) : (
                            <img src={fileUrl(p)} onClick={() => openPreview(fileUrl(p))} />
                          )}
                          {mediaKindOf(p) === 'video' && <Play size={11} className="fi-play" />}
                          <button
                            className="icon-btn danger"
                            title="Tirar"
                            onClick={() => patch(f.id, { motionRefFiles: (f.motionRefFiles ?? []).filter((x) => x !== p) })}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                      <button
                        className="format-ref add"
                        title="Adicionar imagem ou vídeo de referência"
                        onClick={async () => {
                          const files = await api.pickFormatImages()
                          if (files.length) patch(f.id, { motionRefFiles: [...(f.motionRefFiles ?? []), ...files] })
                        }}
                      >
                        <ImagePlus size={18} />
                        <span>{f.motionRefFiles?.length ? 'mais' : 'pôr imagem'}</span>
                      </button>
                    </div>
                  )}
                </div>

                <div className="format-field">
                  <span>Assets frequentes</span>
                  {(f.assetFolders ?? []).map((p) => (
                    <div key={p} className="format-folder" title={p}>
                      <span>{p.split(/[\\/]/).pop()}</span>
                      <small>{p}</small>
                      <button
                        className="icon-btn danger"
                        title="Tirar do formato (não apaga nada do PC)"
                        onClick={() => patch(f.id, { assetFolders: (f.assetFolders ?? []).filter((x) => x !== p) })}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    className="btn small"
                    onClick={async () => {
                      const p = await api.pickFolder()
                      if (p && !(f.assetFolders ?? []).includes(p)) patch(f.id, { assetFolders: [...(f.assetFolders ?? []), p] })
                    }}
                  >
                    <FolderPlus size={13} /> {f.assetFolders?.length ? 'Adicionar mais' : 'Indicar pasta'}
                  </button>
                </div>
              </>
            )}

            {dirty && (
              <div className="format-save">
                <button className="btn small primary" onClick={() => saveOne(f.id)}>
                  <Save size={13} /> Salvar formato
                </button>
                <button className="btn small" onClick={() => discard(f.id)} title="Voltar ao que estava salvo">
                  <Undo2 size={13} /> Descartar
                </button>
              </div>
            )}
            {drafts.length > 1 && (
              <button className="icon-btn danger format-del" title="Excluir formato" onClick={() => remove(f)}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        )
      })}
      <button
        className="btn block"
        onClick={() => {
          const id = uid()
          setDrafts((ds) => [...ds, { id, name: 'Novo formato', aspect: '16:9', wpm: 150, maxSeconds: null, lang: 'pt-BR', __dirty: true }])
          setOpen((o) => ({ ...o, [id]: true }))
        }}
      >
        <Plus size={14} /> Novo formato
      </button>
    </div>
  )
}
