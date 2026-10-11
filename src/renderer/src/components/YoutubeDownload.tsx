import { useEffect, useState } from 'react'
import { Download, Loader2, X } from 'lucide-react'
import { api } from '../lib'

/**
 * Baixar vídeo do YouTube (ou outro site) com o yt-dlp, inteiro ou só um trecho.
 * Usado no Material bruto da Montagem e nas referências de motion do Estilo.
 */
export function YoutubeDownload({
  dir,
  target,
  allowAudio = true,
  hint,
  onDone
}: {
  /** pasta do projeto (o Material bruto vai em assets/material-bruto) */
  dir: string
  /** 'motion': vai pra pasta global das referências de estilo */
  target?: 'motion'
  allowAudio?: boolean
  hint: string
  /** recebe o arquivo baixado; é a versão do momento em que o download começou */
  onDone: (path: string) => void | Promise<void>
}) {
  const [yt, setYt] = useState<{ url: string; quality: '1080' | '720' | 'audio'; from: string; to: string }>({ url: '', quality: target === 'motion' ? '720' : '1080', from: '', to: '' })
  const [ytdlp, setYtdlp] = useState<{ path: string } | null | undefined>(undefined)
  const [dl, setDl] = useState<{ pct: number; speed: string; eta: string } | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    api.ytdlpInfo().then(setYtdlp)
  }, [])

  const download = async () => {
    const url = yt.url.trim()
    if (!/^https?:\/\//i.test(url)) return
    const done = onDone
    setMsg('')
    setDl({ pct: 0, speed: '', eta: '' })
    // o progresso vem por um canal só: quem baixa agora é quem escuta
    api.onDownloadProgress((p) => setDl(p))
    const r = await api.downloadVideo(url, dir, { quality: yt.quality, from: yt.from.trim() || undefined, to: yt.to.trim() || undefined, target })
    setDl(null)
    if ('error' in r) return setMsg(r.error)
    setMsg('Baixado: ' + (r.path.split(/[\\/]/).pop() ?? ''))
    setYt((y) => ({ ...y, url: '', from: '', to: '' }))
    await done(r.path)
  }

  return (
    <div className="mt-yt">
      {ytdlp === undefined ? (
        <span className="muted small">
          <Loader2 size={12} className="spin" /> procurando o yt-dlp…
        </span>
      ) : ytdlp === null ? (
        <div className="mt-yt-install">
          <span className="small">
            Pra baixar vídeos o Typos usa o <b>yt-dlp</b> (gratuito). Ele ainda não está neste PC.
          </span>
          <button
            className="btn small primary"
            disabled={msg === 'instalando'}
            onClick={async () => {
              setMsg('instalando')
              const r = await api.installYtdlp()
              setMsg('error' in r ? r.error : '')
              if (!('error' in r)) setYtdlp(r)
            }}
          >
            {msg === 'instalando' ? <Loader2 size={12} className="spin" /> : <Download size={12} />} Instalar yt-dlp
          </button>
        </div>
      ) : (
        <>
          <input
            className="mt-yt-url"
            placeholder="Cole o link do YouTube…"
            value={yt.url}
            disabled={!!dl}
            onChange={(e) => setYt((y) => ({ ...y, url: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && !dl && download()}
          />
          <div className="mt-yt-row">
            <select value={yt.quality} disabled={!!dl} onChange={(e) => setYt((y) => ({ ...y, quality: e.target.value as typeof y.quality }))}>
              <option value="1080">até 1080p</option>
              <option value="720">até 720p</option>
              {allowAudio && <option value="audio">só áudio</option>}
            </select>
            <span className="muted small">trecho</span>
            <input className="mt-yt-t" placeholder="início" value={yt.from} disabled={!!dl} onChange={(e) => setYt((y) => ({ ...y, from: e.target.value }))} title="Opcional, ex.: 1:20" />
            <input className="mt-yt-t" placeholder="fim" value={yt.to} disabled={!!dl} onChange={(e) => setYt((y) => ({ ...y, to: e.target.value }))} title="Opcional, ex.: 2:05" />
            {dl ? (
              <button className="btn small" onClick={() => api.cancelDownload()}>
                <X size={12} /> Parar
              </button>
            ) : (
              <button className="btn small primary" disabled={!/^https?:\/\//i.test(yt.url.trim())} onClick={download}>
                <Download size={12} /> Baixar
              </button>
            )}
          </div>
          {dl && (
            <div className="mt-progress">
              <span>
                <Loader2 size={12} className="spin" /> baixando {Math.round(dl.pct * 100)}%{dl.speed ? ` · ${dl.speed}` : ''}
                {dl.eta ? ` · ${dl.eta}` : ''}
              </span>
              <div className="mt-bar">
                <i style={{ width: `${Math.round(dl.pct * 100)}%` }} />
              </div>
            </div>
          )}
          <span className="mt-yt-hint">{hint}</span>
        </>
      )}
      {msg && msg !== 'instalando' && <span className={'small ' + (msg.startsWith('Baixado') ? 'ok' : 'error')}>{msg}</span>}
    </div>
  )
}
