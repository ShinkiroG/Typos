import { useEffect, useRef, useState } from 'react'
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react'
import { Paperclip, Copy, Check, Music, ArrowLeftRight, Trash2, ClipboardPaste, FolderOpen, Maximize2, Play, Pause, Tv } from 'lucide-react'
import {
  api,
  attachmentUrl,
  fileUrl,
  getProjectDir,
  isPreviewing,
  kindOf,
  openPreview,
  pasteClipboardImage,
  toggleAudioPreview,
  ATTACHMENT_STATUS,
  TRANSITIONS,
  type Attachment,
  type AttachmentStatus
} from '../lib'

function useOutsideClose(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, ref, close])
}

const Placeholder = ({ show, text }: { show: boolean; text: string }) =>
  show ? (
    <span className="blk-placeholder" contentEditable={false}>
      {text}
    </span>
  ) : null

/** Botão de play/pausa ligado ao player de prévia único do app. */
export function AudioPlayButton({ url, size = 14 }: { url: string; size?: number }) {
  const [playing, setPlaying] = useState(isPreviewing(url))
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ url: string; playing: boolean }>).detail
      setPlaying(d.url === url && d.playing)
    }
    window.addEventListener('typos:audio', on)
    return () => window.removeEventListener('typos:audio', on)
  }, [url])
  return (
    <button
      className={'audio-play' + (playing ? ' on' : '')}
      title={playing ? 'Pausar' : 'Ouvir'}
      onClick={(e) => {
        e.stopPropagation()
        toggleAudioPreview(url)
      }}
    >
      {playing ? <Pause size={size} /> : <Play size={size} />}
    </button>
  )
}

/** Prévia de um anexo: imagem, vídeo (quadro + abre grande) ou áudio (play). */
export function MediaThumb({ a, className = '' }: { a: Attachment; className?: string }) {
  const url = attachmentUrl(a)
  const kind = kindOf(a)
  if (kind === 'audio')
    return (
      <div className={'media-audio ' + className} title={a.name}>
        <AudioPlayButton url={url} />
        <span>{a.name}</span>
      </div>
    )
  if (kind === 'video')
    return (
      <div className={'media-video ' + className} title={a.name} onClick={() => openPreview(url)}>
        <video src={url + '#t=0.5'} preload="metadata" muted />
        <Play size={18} className="media-video-icon" />
      </div>
    )
  return <img className={className} src={url} title={a.name} onClick={() => openPreview(url)} />
}

/** Recorte feito pelo Claude em assets/recortes/<mesmo nome>.png (só aparece se existir). */
function CutPreview({ a }: { a: Attachment }) {
  const [ok, setOk] = useState(true)
  if (a.external || !ok || kindOf(a) !== 'image') return null
  const base = a.path.split('/').pop()!.replace(/\.[^.]+$/, '')
  const src = fileUrl(`${getProjectDir()}/assets/recortes/${base}.png`)
  return <img className="cut-preview" src={src} title="Recorte pronto" onError={() => setOk(false)} onClick={() => openPreview(src)} />
}

function AttachmentManager({
  atts,
  onAdd,
  onRemove,
  onStatus
}: {
  atts: Attachment[]
  onAdd: (a: Attachment[]) => void
  onRemove: (id: string) => void
  onStatus: (id: string, s: AttachmentStatus) => void
}) {
  const [msg, setMsg] = useState('')
  const dir = getProjectDir()

  const paste = async () => {
    const a = await pasteClipboardImage(dir)
    if (a) onAdd([a])
    else setMsg('A área de transferência não tem imagem.')
  }

  return (
    <div className="popover attach-pop">
      <div className="pop-head">Referências deste bloco</div>
      {atts.length === 0 && <div className="pop-empty">Nada anexado ainda (imagem, áudio ou vídeo).</div>}
      <div className="pop-list">
        {atts.map((a) => (
          <div className="pop-item" key={a.id}>
            <MediaThumb a={a} className="pop-media" />
            <div className="pop-info">
              <span className="pop-name" title={a.path}>
                {a.name}
              </span>
              <select
                className={'status-select st-' + (a.status ?? 'ref')}
                value={a.status ?? 'ref'}
                onChange={(e) => onStatus(a.id, e.target.value as AttachmentStatus)}
              >
                {ATTACHMENT_STATUS.map((s) => (
                  <option key={s.id} value={s.id} title={s.hint}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <CutPreview a={a} />
            {kindOf(a) !== 'audio' && (
              <button className="icon-btn" title="Ver grande" onClick={() => openPreview(attachmentUrl(a))}>
                <Maximize2 size={14} />
              </button>
            )}
            <button className="icon-btn danger" title="Remover do bloco (o arquivo continua em assets/)" onClick={() => onRemove(a.id)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="pop-actions">
        <button className="btn small" onClick={paste}>
          <ClipboardPaste size={14} /> Colar imagem
        </button>
        <button className="btn small" onClick={async () => onAdd(await api.pickAssets(dir))}>
          <FolderOpen size={14} /> Escolher arquivo…
        </button>
      </div>
      {msg && <div className="pop-msg">{msg}</div>}
      <div className="pop-hint">Dica: com o cursor no bloco, Ctrl+V cola a imagem direto. Também dá pra arrastar arquivos (ou itens das Pastas) pra cá.</div>
    </div>
  )
}

/** Clipe + popover + prévias na margem esquerda; usado por Prompt e Sonora. */
function useAttachments({ node, updateAttributes }: Pick<NodeViewProps, 'node' | 'updateAttributes'>) {
  const atts: Attachment[] = node.attrs.attachments ?? []
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(ref, open, () => setOpen(false))

  const add = (list: Attachment[]) => list.length && updateAttributes({ attachments: [...(node.attrs.attachments ?? []), ...list] })
  const remove = (id: string) => updateAttributes({ attachments: atts.filter((a) => a.id !== id) })
  const setStatus = (id: string, status: AttachmentStatus) =>
    updateAttributes({ attachments: atts.map((a) => (a.id === id ? { ...a, status } : a)) })

  const button = (
    <div className="attach-anchor" contentEditable={false} ref={ref}>
      <button className={'icon-btn attach' + (atts.length ? ' has' : '')} title="Anexos" onClick={() => setOpen((o) => !o)}>
        <Paperclip size={15} />
        {atts.length > 0 && <span className="badge">{atts.length}</span>}
      </button>
      {open && <AttachmentManager atts={atts} onAdd={add} onRemove={remove} onStatus={setStatus} />}
    </div>
  )

  // prévias: ficam na margem esquerda da página (ou embaixo, se a tela for estreita)
  const thumbs =
    atts.length > 0 ? (
      <div className="thumbs" contentEditable={false} data-more={atts.length > 1 ? `+${atts.length - 1}` : undefined}>
        {atts.map((a) => (
          <div key={a.id} className={'thumb k-' + kindOf(a) + ' st-' + (a.status ?? 'ref')}>
            <MediaThumb a={a} />
            {a.status && a.status !== 'ref' && <span className="thumb-status">{ATTACHMENT_STATUS.find((s) => s.id === a.status)?.label}</span>}
          </div>
        ))}
      </div>
    ) : null

  return { button, thumbs }
}

export function PromptView({ node, updateAttributes }: NodeViewProps) {
  const { button, thumbs } = useAttachments({ node, updateAttributes })
  return (
    <NodeViewWrapper className="blk blk-prompt" data-type="prompt">
      <div className="blk-body">
        <div className="prompt-line">
          <span className="bracket" contentEditable={false}>
            [
          </span>
          <div className="prompt-text-wrap">
            <NodeViewContent className="blk-text" />
            <Placeholder show={node.content.size === 0} text="instrução pra motion / Claude…" />
          </div>
          <span className="bracket" contentEditable={false}>
            ]
          </span>
          {button}
        </div>
        {thumbs}
      </div>
    </NodeViewWrapper>
  )
}

/** Sonora: trecho mostrado com som original (jornal, gameplay, série), sem narração por cima. */
export function SonoraView({ node, updateAttributes }: NodeViewProps) {
  const { button, thumbs } = useAttachments({ node, updateAttributes })
  return (
    <NodeViewWrapper className="blk blk-sonora" data-type="sonora">
      <div className="blk-chip" contentEditable={false}>
        <Tv size={14} />
        <span>SONORA</span>
        <input
          type="number"
          min={0}
          step={0.5}
          value={node.attrs.seconds}
          onChange={(e) => updateAttributes({ seconds: Number(e.target.value) || 0 })}
          title="Duração (também dá pra esticar na timeline)"
        />
        <span className="unit">s</span>
      </div>
      <div className="blk-main">
        <NodeViewContent className="blk-text" />
        <Placeholder show={node.content.size === 0} text="o que aparece aqui (trecho de jornal, gameplay, série…)" />
      </div>
      {button}
      {thumbs}
    </NodeViewWrapper>
  )
}

function CopyButton({ text, title }: { text: () => string; title: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="icon-btn"
      title={title}
      onClick={() => {
        navigator.clipboard.writeText(text())
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

export function TransitionView({ node, updateAttributes }: NodeViewProps) {
  const kind: string = node.attrs.kind
  const options = TRANSITIONS.includes(kind) ? TRANSITIONS : [kind, ...TRANSITIONS]
  return (
    <NodeViewWrapper className="blk blk-transition" data-type="transition">
      <div className="blk-chip" contentEditable={false}>
        <ArrowLeftRight size={14} />
        <select value={kind} onChange={(e) => updateAttributes({ kind: e.target.value })}>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>
      <div className="blk-main">
        <NodeViewContent className="blk-text" />
        <Placeholder show={node.content.size === 0} text="prompt interno da transição…" />
      </div>
      <div className="blk-actions" contentEditable={false}>
        <CopyButton title="Copiar prompt da transição" text={() => `[Transição: ${kind}] ${node.textContent}`.trim()} />
      </div>
    </NodeViewWrapper>
  )
}

export function SoundUpView({ node, updateAttributes }: NodeViewProps) {
  return (
    <NodeViewWrapper className="blk blk-soundup" data-type="soundUp">
      <div className="blk-chip" contentEditable={false}>
        <Music size={14} />
        <span>SOBE SOM</span>
        <input
          type="number"
          min={0}
          step={0.5}
          value={node.attrs.seconds}
          onChange={(e) => updateAttributes({ seconds: Number(e.target.value) || 0 })}
        />
        <span className="unit">s</span>
      </div>
      <div className="blk-main">
        <NodeViewContent className="blk-text" />
        <Placeholder show={node.content.size === 0} text="qual trilha / clima…" />
      </div>
      <div className="blk-actions" contentEditable={false}>
        <CopyButton title="Copiar" text={() => `[Sobe som ${node.attrs.seconds}s] ${node.textContent}`.trim()} />
      </div>
    </NodeViewWrapper>
  )
}
