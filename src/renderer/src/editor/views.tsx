import { useEffect, useRef, useState } from 'react'
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react'
import { Paperclip, Copy, Check, Music, ArrowLeftRight, Trash2, ClipboardPaste, FolderOpen, Maximize2 } from 'lucide-react'
import { api, attachmentUrl, getProjectDir, openPreview, pasteClipboardImage, TRANSITIONS, type Attachment } from '../lib'

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

function AttachmentManager({ atts, onAdd, onRemove }: { atts: Attachment[]; onAdd: (a: Attachment[]) => void; onRemove: (id: string) => void }) {
  const [msg, setMsg] = useState('')
  const dir = getProjectDir()

  const paste = async () => {
    const a = await pasteClipboardImage(dir)
    if (a) onAdd([a])
    else setMsg('A área de transferência não tem imagem.')
  }

  return (
    <div className="popover attach-pop">
      <div className="pop-head">Referências deste prompt</div>
      {atts.length === 0 && <div className="pop-empty">Nenhuma imagem anexada ainda.</div>}
      <div className="pop-list">
        {atts.map((a) => (
          <div className="pop-item" key={a.id}>
            <img src={attachmentUrl(a)} onClick={() => openPreview(attachmentUrl(a))} />
            <span className="pop-name" title={a.path}>
              {a.name}
            </span>
            <button className="icon-btn" title="Ver grande" onClick={() => openPreview(attachmentUrl(a))}>
              <Maximize2 size={14} />
            </button>
            <button className="icon-btn danger" title="Remover do prompt (o arquivo continua em assets/)" onClick={() => onRemove(a.id)}>
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
      <div className="pop-hint">Dica: com o cursor no prompt, Ctrl+V cola a imagem direto. Também dá pra arrastar arquivos pro prompt.</div>
    </div>
  )
}

export function PromptView({ node, updateAttributes }: NodeViewProps) {
  const atts: Attachment[] = node.attrs.attachments ?? []
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(ref, open, () => setOpen(false))

  const add = (list: Attachment[]) => list.length && updateAttributes({ attachments: [...(node.attrs.attachments ?? []), ...list] })
  const remove = (id: string) => updateAttributes({ attachments: atts.filter((a) => a.id !== id) })

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
          <div className="attach-anchor" contentEditable={false} ref={ref}>
            <button className={'icon-btn attach' + (atts.length ? ' has' : '')} title="Anexos" onClick={() => setOpen((o) => !o)}>
              <Paperclip size={15} />
              {atts.length > 0 && <span className="badge">{atts.length}</span>}
            </button>
            {open && <AttachmentManager atts={atts} onAdd={add} onRemove={remove} />}
          </div>
        </div>
        {atts.length > 0 && (
          <div className="thumbs" contentEditable={false}>
            {atts.map((a) => (
              <img key={a.id} src={attachmentUrl(a)} title={a.name} onClick={() => openPreview(attachmentUrl(a))} />
            ))}
          </div>
        )}
      </div>
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
