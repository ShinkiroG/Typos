import { useEffect, useMemo, useState } from 'react'
import { History, X, Copy, RotateCcw, CopyPlus, ChevronDown, ChevronRight, FolderX } from 'lucide-react'
import { api } from '../lib'
import type { HistoryProject, HistoryVersion } from '../../../preload'
import { REASON_LABEL, chapterDiff, dayLabel, docChapters, groupByDay, signed, timeLabel } from '../history'

type Opened = { dir: string; data: any; draft: boolean }

/**
 * Histórico de versões: as cópias que o Typos guarda sozinho (main/history.ts), agrupadas por dia.
 * Clicar numa versão mostra os capítulos dela; dá pra copiar o texto de um capítulo, voltar o
 * roteiro inteiro ou abrir a versão como rascunho novo. Sem `dir` (tela inicial) lista todos os
 * roteiros, inclusive os de pasta apagada ou movida.
 */
export function HistoryModal({
  dir,
  current,
  onClose,
  onRestore,
  onOpenCopy
}: {
  /** roteiro aberto: só o histórico dele */
  dir?: string
  /** o texto de agora do roteiro aberto, pra comparar os capítulos */
  current?: any
  onClose: () => void
  /** volta o roteiro da pasta pra versão (a de agora vira cópia antes) */
  onRestore: (dir: string, id: string, name: string) => void
  onOpenCopy: (r: Opened) => void
}) {
  const [projects, setProjects] = useState<HistoryProject[] | null>(null)
  const [project, setProject] = useState<{ id: string | null; title: string; dir: string; exists: boolean } | null>(null)
  const [versions, setVersions] = useState<HistoryVersion[]>([])
  const [picked, setPicked] = useState<string | null>(null)
  const [preview, setPreview] = useState<any | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [toast, setToast] = useState('')

  const load = async (ref: { dir?: string; id?: string }) => {
    const r = await api.historyList(ref)
    setProject(r)
    setVersions(r.versions)
    setPicked(r.versions[0]?.name ?? null)
  }

  useEffect(() => {
    if (dir) load({ dir })
    else
      api.historyProjects().then((list) => {
        setProjects(list)
        if (list[0]) load({ id: list[0].id })
      })
  }, [dir])

  useEffect(() => {
    setPreview(null)
    setOpen(null)
    if (project?.id && picked) api.historyRead(project.id, picked).then(setPreview)
  }, [project?.id, picked])

  useEffect(() => {
    const t = toast && window.setTimeout(() => setToast(''), 2500)
    return () => window.clearTimeout(t || 0)
  }, [toast])

  const groups = useMemo(() => groupByDay(versions), [versions])
  const chapters = useMemo(() => (preview ? docChapters(preview.doc) : []), [preview])
  const nowChapters = useMemo(() => (current ? docChapters(current) : null), [current])
  const diffs = useMemo(() => chapterDiff(chapters, nowChapters), [chapters, nowChapters])
  const v = versions.find((x) => x.name === picked)

  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text)
    setToast(`${what} copiado`)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={'modal history-modal' + (dir ? '' : ' all')} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="history-head">
          <h3>
            <History size={16} /> Histórico de versões
          </h3>
          <span className="muted small">Cópia automática a cada 2 min de edição, ao abrir e sempre que muito texto some. Ficam por até 90 dias.</span>
          <button className="icon-btn" title="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="history-body">
          {!dir && (
            <ul className="history-col history-projects">
              {projects?.length === 0 && <li className="list-empty">Nenhum roteiro tem histórico ainda.</li>}
              {projects?.map((p) => (
                <li key={p.id} className={project?.id === p.id ? 'on' : ''} onClick={() => load({ id: p.id })}>
                  <b>{p.title}</b>
                  <span className="muted small">
                    {p.exists ? p.dir : (
                      <>
                        <FolderX size={11} /> pasta não existe mais
                      </>
                    )}
                  </span>
                  <span className="muted small">
                    {p.versions} {p.versions === 1 ? 'versão' : 'versões'}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="history-col history-versions">
            {versions.length === 0 && <p className="list-empty">{project ? 'Nenhuma cópia ainda. A primeira sai quando você editar.' : 'Carregando…'}</p>}
            {groups.map((g) => (
              <section key={g.label}>
                <h4>{g.label}</h4>
                <ul>
                  {g.items.map((x) => (
                    <li key={x.name} className={x.name === picked ? 'on' : ''} onClick={() => setPicked(x.name)}>
                      <span className="history-time">{timeLabel(x.at)}</span>
                      <span className="history-words">{x.words.toLocaleString('pt-BR')} palavras</span>
                      {x.delta != null && x.delta !== 0 && <span className={'history-delta ' + (x.delta < 0 ? 'neg' : 'pos')}>{signed(x.delta)}</span>}
                      {REASON_LABEL[x.reason] && <span className={'history-reason r-' + x.reason}>{REASON_LABEL[x.reason]}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <div className="history-col history-preview">
            {!preview ? (
              <p className="list-empty">{v ? 'Abrindo…' : 'Escolha uma versão.'}</p>
            ) : (
              <>
                <div className="history-preview-head">
                  <b>{preview.title || 'Sem título'}</b>
                  <span className="muted small">
                    {chapters.length} {chapters.length === 1 ? 'capítulo' : 'capítulos'}
                    {nowChapters && ' · os números coloridos comparam com o roteiro de agora'}
                  </span>
                </div>
                <ul className="history-chapters">
                  {chapters.map((c, i) => (
                    <li key={i} className={open === i ? 'open' : ''}>
                      <div className="history-ch-row" onClick={() => setOpen(open === i ? null : i)}>
                        {open === i ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span className="history-ch-title">{c.title}</span>
                        <span className="muted small">{c.words.toLocaleString('pt-BR')} palavras</span>
                        {diffs[i] != null && diffs[i] !== 0 && (
                          <span className={'history-delta ' + (diffs[i]! > 0 ? 'pos' : 'neg')} title={diffs[i]! > 0 ? 'Esta versão tem mais texto que o roteiro de agora' : 'Esta versão tem menos texto que o roteiro de agora'}>
                            {signed(diffs[i]!)}
                          </span>
                        )}
                        <button
                          className="icon-btn"
                          title="Copiar o texto deste capítulo"
                          disabled={!c.text}
                          onClick={(e) => {
                            e.stopPropagation()
                            copy(c.text, 'Texto do capítulo')
                          }}
                        >
                          <Copy size={13} />
                        </button>
                      </div>
                      {open === i && <div className="history-ch-text">{c.text || <span className="muted">sem texto</span>}</div>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <span className="muted small">{toast}</span>
          <button
            className="btn"
            disabled={!project?.id || !picked}
            title="Abre esta versão como um rascunho novo; o roteiro original não muda"
            onClick={async () => {
              const r = await api.historyOpenCopy(project!.id!, picked!)
              if ('error' in r) return setToast(r.error)
              onOpenCopy(r)
            }}
          >
            <CopyPlus size={14} /> Abrir como cópia
          </button>
          <button
            className="btn primary"
            disabled={!project?.id || !picked || !(dir || project.exists)}
            title={dir || project?.exists ? 'O roteiro de agora também fica guardado no histórico' : 'A pasta desse roteiro não existe mais: use "Abrir como cópia"'}
            onClick={() => {
              if (!v || !project?.id) return
              if (!confirm(`Voltar o roteiro pra versão de ${dayLabel(v.at).toLowerCase()} às ${timeLabel(v.at)} (${v.words.toLocaleString('pt-BR')} palavras)?\n\nO roteiro de agora também fica guardado no histórico, dá pra voltar pra ele.`)) return
              onRestore(dir ?? project.dir, project.id, v.name)
            }}
          >
            <RotateCcw size={14} /> Voltar pra esta versão
          </button>
        </div>
      </div>
    </div>
  )
}
