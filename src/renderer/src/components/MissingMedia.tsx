import { useEffect, useState } from 'react'
import { AlertTriangle, FolderSearch, X } from 'lucide-react'
import { api, type MontageData } from '../lib'

/**
 * Aviso ao abrir o roteiro: mídias da Montagem que não estão mais onde estavam (HD trocado, pasta
 * renomeada…). "Procurar numa pasta" acha os arquivos pelo nome e religa todos de uma vez.
 */
export function MissingMedia({ montage, onChange }: { montage: MontageData; onChange: (m: MontageData) => void }) {
  const [missing, setMissing] = useState<string[]>([])
  const [hidden, setHidden] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const paths = montage.media.map((m) => m.path)
  const key = paths.join('|')

  useEffect(() => {
    if (!paths.length) return setMissing([])
    api.missingMedia(paths).then(setMissing)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (hidden || !missing.length) return null

  const relink = async () => {
    const root = await api.pickFolder()
    if (!root) return
    setBusy(true)
    setNote('')
    const map = await api.relinkMedia(missing, root)
    setBusy(false)
    const n = Object.keys(map).length
    if (!n) return setNote('Nenhum desses arquivos está nessa pasta.')
    onChange({ ...montage, media: montage.media.map((m) => (map[m.path] ? { ...m, path: map[m.path] } : m)) })
    const left = missing.length - n
    setNote(left ? `${n} religado(s). Ainda faltam ${left}: tente outra pasta.` : '')
  }

  const name = (p: string) => p.split(/[\\/]/).pop()
  return (
    <div className="missing-media">
      <AlertTriangle size={14} />
      <span>
        {missing.length === 1 ? '1 arquivo da Montagem não está mais onde estava' : `${missing.length} arquivos da Montagem não estão mais onde estavam`}
        {note && <em> · {note}</em>}
      </span>
      <button className="btn small primary" disabled={busy} onClick={relink} title="Escolha a pasta onde os arquivos estão agora (procura nas subpastas também)">
        <FolderSearch size={13} /> {busy ? 'Procurando…' : 'Procurar numa pasta…'}
      </button>
      <button className="btn small" onClick={() => setOpen((o) => !o)}>
        {open ? 'Esconder lista' : 'Ver quais'}
      </button>
      <button className="icon-btn" title="Fechar aviso" onClick={() => setHidden(true)}>
        <X size={14} />
      </button>
      {open && (
        <ul className="missing-list">
          {missing.map((p) => (
            <li key={p} title={p}>
              <b>{name(p)}</b> <span>{p}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
