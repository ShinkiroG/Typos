import { useEffect, useState } from 'react'
import { FilePlus2, FolderOpen, Clapperboard } from 'lucide-react'
import { api, type ProjectData } from '../lib'

type Recent = { dir: string; title: string; openedAt: string }

export function Welcome({ onOpen }: { onOpen: (dir: string, data: ProjectData) => void }) {
  const [recent, setRecent] = useState<Recent[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    api.recentProjects().then(setRecent)
  }, [])

  const handle = (r: any) => {
    if (!r) return
    if (r.error) return setError(r.error)
    onOpen(r.dir, r.data)
  }

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-logo">
          <Clapperboard size={34} />
          <h1>Typos</h1>
        </div>
        <p className="muted">Roteiros com fala, prompts de motion, transições e sobe som.</p>
        <div className="welcome-actions">
          <button className="btn primary big" onClick={async () => handle(await api.newProject())}>
            <FilePlus2 size={18} /> Novo roteiro
          </button>
          <button className="btn big" onClick={async () => handle(await api.openProject())}>
            <FolderOpen size={18} /> Abrir pasta…
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {recent.length > 0 && (
          <>
            <h3>Recentes</h3>
            <ul className="recent">
              {recent.map((r) => (
                <li key={r.dir} onClick={async () => handle(await api.openProject(r.dir))}>
                  <span className="recent-title">{r.title}</span>
                  <span className="recent-dir">{r.dir}</span>
                  <span className="recent-date">{new Date(r.openedAt).toLocaleDateString('pt-BR')}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
