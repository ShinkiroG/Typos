import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, X } from 'lucide-react'
import { api, uid, type Format, type LibraryItem, type ProjectData } from './lib'
import { Welcome } from './components/Welcome'
import { Workspace } from './components/Workspace'
import { SettingsModal } from './components/SettingsModal'

function Lightbox() {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    const onPreview = (e: Event) => setSrc((e as CustomEvent<string>).detail)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSrc(null)
    window.addEventListener('rs:preview', onPreview)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('rs:preview', onPreview)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  if (!src) return null
  return (
    <div className="lightbox" onClick={() => setSrc(null)}>
      {/\.(mp4|webm|mov|m4v)(#|$)/i.test(decodeURIComponent(src)) ? (
        <video src={src} controls autoPlay onClick={(e) => e.stopPropagation()} />
      ) : (
        <img src={src} />
      )}
    </div>
  )
}

/** Avisos de atualização vindos do main (download em segundo plano / progresso). */
function UpdateBanner() {
  const [ready, setReady] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    api.onUpdate((ch, p) => {
      if (ch === 'update:ready') {
        setReady(p.version)
        setHidden(false)
      } else if (ch === 'update:progress') setProgress(p < 0 || p >= 1 ? null : p)
    })
  }, [])

  if (progress !== null)
    return (
      <div className="update-banner">
        <Download size={14} /> Baixando atualização… {Math.round(progress * 100)}%
      </div>
    )
  if (!ready || hidden) return null
  return (
    <div className="update-banner">
      <Download size={14} /> Typos {ready} baixado. Vai instalar quando você fechar o app.
      <button className="btn small primary" onClick={() => api.installUpdateNow()}>
        Reiniciar e atualizar agora
      </button>
      <button className="icon-btn" onClick={() => setHidden(true)} title="Esconder">
        <X size={14} />
      </button>
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState<{ key: string; dir: string; data: ProjectData; draft: boolean } | null>(null)
  const [formats, setFormats] = useState<Format[]>([])
  const [library, setLibrary] = useState<LibraryItem[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const flush = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    api.loadFormats().then(setFormats)
    api.loadLibrary().then(setLibrary)
    api.onFlush(async () => {
      await flush.current?.()
    })
  }, [])

  const registerFlush = useCallback((fn: (() => Promise<void>) | null) => {
    flush.current = fn
  }, [])

  const changeFormats = (f: Format[]) => {
    setFormats(f)
    api.saveFormats(f)
  }
  const changeLibrary = (l: LibraryItem[]) => {
    setLibrary(l)
    api.saveLibrary(l)
  }

  return (
    <>
      <UpdateBanner />
      {session && formats.length ? (
        <Workspace
          key={session.key}
          dir={session.dir}
          data={session.data}
          draft={session.draft}
          onSavedAs={(dir) => setSession((s) => (s ? { ...s, dir, draft: false } : s))}
          formats={formats}
          onFormatsChange={changeFormats}
          library={library}
          onLibraryChange={changeLibrary}
          onClose={() => setSession(null)}
          onOpenSettings={() => setSettingsOpen(true)}
          registerFlush={registerFlush}
        />
      ) : (
        <Welcome onOpen={(dir, data, draft) => setSession({ key: uid(), dir, data, draft })} onOpenSettings={() => setSettingsOpen(true)} />
      )}
      {settingsOpen && (
        <SettingsModal
          currentDir={session?.dir}
          onClose={() => setSettingsOpen(false)}
          onCleanAssets={async () => {
            if (!session) return ''
            // salva o que está aberto, limpa no disco e reabre (o roteiro aponta pros arquivos que ficaram)
            await flush.current?.()
            const r = await api.cleanAssets(session.dir)
            if ('error' in r) return r.error
            const o = await api.openProject(session.dir)
            if (o && !o.error) setSession({ key: uid(), dir: o.dir, data: o.data, draft: !!o.draft })
            return `${r.removed} arquivo(s) foram pra Lixeira · ${(r.bytes / 1024 / 1024).toFixed(1)} MB liberados.`
          }}
        />
      )}
      <Lightbox />
    </>
  )
}
