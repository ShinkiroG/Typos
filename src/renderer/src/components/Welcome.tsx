import { useEffect, useState } from 'react'
import { FilePlus2, FolderOpen, Clapperboard, Settings, X, Trash2, FileClock, History } from 'lucide-react'
import { api, type ProjectData } from '../lib'

type Recent = { dir: string; title: string; openedAt: string }
type Draft = Awaited<ReturnType<typeof api.drafts>>[number]

const when = (iso: string) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? `hoje, ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : d.toLocaleDateString('pt-BR')
}

export function Welcome({
  onOpen,
  onOpenSettings
}: {
  onOpen: (dir: string, data: ProjectData, draft: boolean) => void
  onOpenSettings: () => void
}) {
  const [recent, setRecent] = useState<Recent[]>([])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [error, setError] = useState('')

  const refresh = () => {
    api.recentProjects().then(setRecent)
    api.drafts().then(setDrafts)
  }
  useEffect(refresh, [])

  const handle = (r: any) => {
    if (!r) return
    if (r.error) return setError(r.error)
    onOpen(r.dir, r.data, !!r.draft)
  }

  return (
    <div className="welcome">
      <button className="icon-btn welcome-gear" title="Configurações" onClick={onOpenSettings}>
        <Settings size={18} />
      </button>
      <div className="welcome-card">
        <div className="welcome-logo">
          <Clapperboard size={34} />
          <h1>Typos</h1>
        </div>
        <p className="muted">Roteiros com fala, prompts de motion, transições e sobe som.</p>
        <div className="welcome-actions">
          <button className="btn primary big" onClick={async () => handle(await api.newProject())} title="Começa na hora; salva sozinho como rascunho">
            <FilePlus2 size={18} /> Novo roteiro
          </button>
          <button className="btn big" onClick={async () => handle(await api.openProject())}>
            <FolderOpen size={18} /> Abrir pasta…
          </button>
        </div>
        {error && <div className="error">{error}</div>}

        <div className="welcome-lists">
          <section>
            <h3>
              <FileClock size={13} /> Rascunhos não salvos
            </h3>
            {drafts.length === 0 ? (
              <p className="list-empty">Nenhum rascunho. Um roteiro novo fica aqui até você salvar.</p>
            ) : (
              <ul className="recent">
                {drafts.map((d) => (
                  <li key={d.dir} onClick={async () => handle(await api.openProject(d.dir))}>
                    <span className="recent-title">{d.title}</span>
                    <span className="recent-dir">{d.preview || 'sem texto ainda'}</span>
                    <span className="recent-date">{when(d.updatedAt)}</span>
                    <button
                      className="icon-btn danger recent-x"
                      title="Apagar rascunho"
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (!confirm(`Apagar o rascunho "${d.title}"? Não dá pra desfazer.`)) return
                        await api.deleteDraft(d.dir)
                        refresh()
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>
              <History size={13} /> Arquivos recentes
            </h3>
            {recent.length === 0 ? (
              <p className="list-empty">Os roteiros que você salvar ou abrir aparecem aqui.</p>
            ) : (
              <ul className="recent">
                {recent.map((r) => (
                  <li key={r.dir} onClick={async () => handle(await api.openProject(r.dir))}>
                    <span className="recent-title">{r.title}</span>
                    <span className="recent-dir">{r.dir}</span>
                    <span className="recent-date">{when(r.openedAt)}</span>
                    <button
                      className="icon-btn recent-x"
                      title="Tirar da lista (não apaga o arquivo)"
                      onClick={async (e) => {
                        e.stopPropagation()
                        await api.removeRecent(r.dir)
                        refresh()
                      }}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
