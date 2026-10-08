import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Format, type LibraryItem, type ProjectData } from './lib'
import { Welcome } from './components/Welcome'
import { Workspace } from './components/Workspace'

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
      <img src={src} />
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState<{ dir: string; data: ProjectData } | null>(null)
  const [formats, setFormats] = useState<Format[]>([])
  const [library, setLibrary] = useState<LibraryItem[]>([])
  const flush = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    api.loadFormats().then(setFormats)
    api.loadLibrary().then(setLibrary)
    api.onRequestClose(async () => {
      try {
        await flush.current?.()
      } finally {
        api.confirmClose()
      }
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
      {session && formats.length ? (
        <Workspace
          key={session.dir}
          dir={session.dir}
          data={session.data}
          formats={formats}
          onFormatsChange={changeFormats}
          library={library}
          onLibraryChange={changeLibrary}
          onClose={() => setSession(null)}
          registerFlush={registerFlush}
        />
      ) : (
        <Welcome onOpen={(dir, data) => setSession({ dir, data })} />
      )}
      <Lightbox />
    </>
  )
}
