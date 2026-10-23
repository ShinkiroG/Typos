import { useEffect, useState } from 'react'
import { Loader2, Star } from 'lucide-react'
import { api } from '../lib'

export type SfxLib = { path: string; name: string; program: string; why: string; files: number }

/**
 * O Claude procura no PC as bibliotecas de som (Mister Horse, Motion Bro…) e o autor marca quais vincular.
 * Começa a procurar quando aparece; as pastas em `linked` (já vinculadas) não entram na lista.
 */
export function SfxFinder({ linked, onLink, onClose }: { linked: string[]; onLink: (libs: SfxLib[]) => void; onClose: () => void }) {
  const [st, setSt] = useState<{ busy: boolean; libs?: SfxLib[]; pick?: Set<string>; error?: string }>({ busy: true })
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const t0 = Date.now()
    const t = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    api.findSfxLibraries().then((r) => {
      clearInterval(t)
      if ('error' in r) return setSt({ busy: false, error: r.error })
      const libs = r.libs.filter((l) => !linked.includes(l.path))
      setSt({ busy: false, libs, pick: new Set(libs.map((l) => l.path)) })
    })
    return () => clearInterval(t)
  }, [])
  const toggle = (path: string) =>
    setSt((s) => {
      const pick = new Set(s.pick)
      if (pick.has(path)) pick.delete(path)
      else pick.add(path)
      return { ...s, pick }
    })
  return (
    <div className="mt-sfxfind">
      {st.busy ? (
        <span className="small">
          <Loader2 size={12} className="spin" /> O Claude está procurando bibliotecas de som no seu PC… {elapsed}s (só lendo pastas, não muda nada)
        </span>
      ) : st.error ? (
        <span className="small error">{st.error}</span>
      ) : !st.libs?.length ? (
        <span className="small muted">Nenhuma biblioteca nova achada (as que já estão vinculadas não aparecem).</span>
      ) : (
        <>
          <span className="small">
            <b>{st.libs.length}</b> biblioteca(s) achada(s). Marque as que vão virar referência de som:
          </span>
          <div className="mt-sfxlist">
            {st.libs.map((l) => (
              <label key={l.path} className="mt-sfxlib" title={l.path}>
                <input type="checkbox" checked={!!st.pick?.has(l.path)} onChange={() => toggle(l.path)} />
                <span>
                  <b>{l.name}</b> <i>{l.program}</i> · {l.files >= 5000 ? '5000+' : l.files} sons
                  <small>{l.why}</small>
                  <small className="mt-sfxpath">{l.path}</small>
                </span>
              </label>
            ))}
          </div>
        </>
      )}
      <div className="mt-sfxbtns">
        {!!st.libs?.length && (
          <button className="btn small primary" disabled={!st.pick?.size} onClick={() => onLink(st.libs!.filter((l) => st.pick?.has(l.path)))}>
            <Star size={12} /> Vincular {st.pick?.size ?? 0} como favoritas
          </button>
        )}
        {!st.busy && (
          <button className="btn small" onClick={onClose}>
            Fechar
          </button>
        )}
      </div>
    </div>
  )
}
