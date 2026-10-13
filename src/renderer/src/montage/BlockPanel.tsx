import { useEffect, useState } from 'react'
import { Paperclip, ClipboardPaste, X, Sparkles, Film, Loader2, Check, Maximize2, Trash2, AlertTriangle } from 'lucide-react'
import { api, absPath, fileUrl, pasteClipboardImage, type Attachment, type BlockAttachment, type InstructionBlock } from '../lib'
import { blockDur, blockLabel, isImage, previewStale } from './blocks'

const fmtTc = (t: number) => {
  const m = Math.floor(Math.max(0, t) / 60)
  return `${m}:${(Math.max(0, t) - m * 60).toFixed(2).padStart(5, '0')}`
}

export interface BlockBusy {
  id: string
  label: string
  pct: number | null
}

interface FormProps {
  b: InstructionBlock
  dir: string
  patch: (p: Partial<InstructionBlock>, gesture?: string) => void
}

const toBlockAtt = (a: Attachment): BlockAttachment => ({ ...a, use: 'insert' })

/** campos do bloco: nome, tempo, modo, instruções e anexos (o mesmo no painel e na janela) */
export function BlockForm({ b, dir, patch, big }: FormProps & { big?: boolean }) {
  const g = 'blk-' + b.id
  const [dropping, setDropping] = useState(false)
  const addAtts = (list: Attachment[]) => list.length && patch({ attachments: [...b.attachments, ...list.map(toBlockAtt)] })
  const setAtt = (id: string, p: Partial<BlockAttachment>, gesture?: string) =>
    patch({ attachments: b.attachments.map((a) => (a.id === id ? { ...a, ...p } : a)) }, gesture)
  const num = (v: number) => +v.toFixed(2)
  return (
    <div
      className={'blk-form' + (big ? ' big' : '') + (dropping ? ' dropping' : '')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDropping(true)
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={async (e) => {
        setDropping(false)
        const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
        if (!paths.length) return
        e.preventDefault()
        e.stopPropagation()
        addAtts(await api.importPaths(dir, paths))
      }}
    >
      <input className="blk-name" placeholder={blockLabel(b)} value={b.name ?? ''} onChange={(e) => patch({ name: e.target.value }, g + 'n')} />
      <div className="mt-insp-grid">
        <label>
          Início (s)
          <input type="number" step={0.1} value={num(b.start)} onChange={(e) => {
            const s = Math.max(0, Math.min(b.end - 0.5, Number(e.target.value)))
            patch({ start: s }, g + 's')
          }} />
        </label>
        <label>
          Fim (s)
          <input type="number" step={0.1} value={num(b.end)} onChange={(e) => patch({ end: Math.max(b.start + 0.5, Number(e.target.value)) }, g + 'e')} />
        </label>
      </div>
      <div className="seg blk-mode">
        <button className={!b.dynamic ? 'on' : ''} onClick={() => patch({ dynamic: false })} title="O Claude segue o que você escrever (e nada do roteiro)">
          Escrito
        </button>
        <button className={b.dynamic ? 'on' : ''} onClick={() => patch({ dynamic: true })} title="O Claude pensa o motion a partir do que é falado neste trecho">
          <Sparkles size={12} /> Dinâmico
        </button>
      </div>
      <label className="blk-label">
        {b.dynamic ? 'Dicas (opcional): o motion sai da fala do trecho' : 'Como você imagina o motion'}
        <textarea
          rows={big ? 10 : 6}
          value={b.text}
          placeholder={
            b.dynamic
              ? 'Ex.: algo mais calmo, cores frias, termina com o logo…'
              : 'Ex.: gráfico de pizza montando fatia por fatia com as porcentagens; câmera aproxima da maior fatia quando falo “70%”…'
          }
          onChange={(e) => patch({ text: e.target.value }, g + 't')}
        />
      </label>
      <div className="blk-atts">
        <div className="blk-atts-head">
          <span>Anexos</span>
          <button className="icon-btn" title="Anexar imagem do PC" onClick={async () => addAtts(await api.pickAssets(dir))}>
            <Paperclip size={13} />
          </button>
          <button
            className="icon-btn"
            title="Colar imagem (print) da área de transferência"
            onClick={async () => {
              const a = await pasteClipboardImage(dir)
              if (a) addAtts([a])
            }}
          >
            <ClipboardPaste size={13} />
          </button>
        </div>
        {!b.attachments.length && <div className="blk-hint">Arraste imagens aqui. Cada uma vira insert (entra no vídeo) ou referência (o Claude recria em motion).</div>}
        {b.attachments.map((a) => (
          <div key={a.id} className="blk-att">
            {isImage(a) ? <img src={fileUrl(absPath(a))} alt="" onClick={() => api.openPath(absPath(a))} /> : <div className="blk-att-file">{a.name.split('.').pop()}</div>}
            <div className="blk-att-body">
              <span className="blk-att-name" title={a.name}>
                {a.name}
              </span>
              <label title="A imagem entra no vídeo e ganha setas, zoom e destaques por cima">
                <input type="checkbox" checked={a.use === 'insert'} onChange={() => setAtt(a.id, { use: 'insert' })} /> Inserir no vídeo
              </label>
              <label title="Não aparece: o Claude recria com design bonito e anima (ex.: um clone da página do SteamDB)">
                <input type="checkbox" checked={a.use === 'ref'} onChange={() => setAtt(a.id, { use: 'ref' })} /> Referência pro motion
              </label>
              <input className="blk-att-note" placeholder="nota (opcional)" value={a.note ?? ''} onChange={(e) => setAtt(a.id, { note: e.target.value }, g + 'an' + a.id)} />
            </div>
            <button className="icon-btn" title="Tirar anexo" onClick={() => patch({ attachments: b.attachments.filter((x) => x.id !== a.id) })}>
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** prévia: vídeo, gerar de novo, aprovar (vira clipe na timeline) */
export function BlockPreviewBox({
  b,
  busy,
  onGenerate,
  onCancel,
  onApprove,
  big
}: {
  b: InstructionBlock
  busy: BlockBusy | null
  onGenerate: () => void
  onCancel: () => void
  onApprove: () => void
  big?: boolean
}) {
  const mine = busy?.id === b.id
  const stale = previewStale(b)
  return (
    <div className={'blk-prev' + (big ? ' big' : '')}>
      {b.preview ? (
        <video key={b.preview.video} src={fileUrl(b.preview.video)} controls loop={!big} playsInline />
      ) : (
        <div className="blk-prev-empty">
          <Film size={big ? 28 : 18} />
          <span>Sem prévia ainda. A prévia sai em 12 fps e baixa resolução, com o áudio do trecho. Aprovada, ela é gravada na resolução do projeto e entra na timeline como clipe.</span>
        </div>
      )}
      {stale && (
        <div className="blk-prev-stale">
          <AlertTriangle size={12} /> O bloco mudou depois desta prévia.
        </div>
      )}
      {mine ? (
        <div className="blk-prev-busy">
          <Loader2 size={13} className="spin" /> {busy!.label}
          {busy!.pct !== null && (
            <div className="mt-bar">
              <i style={{ width: `${Math.round(busy!.pct * 100)}%` }} />
            </div>
          )}
          <button className="btn small" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      ) : (
        <div className="blk-prev-btns">
          <button className="btn small primary" disabled={!!busy} title={busy ? 'Outra prévia está sendo feita' : ''} onClick={onGenerate}>
            <Sparkles size={13} /> {b.preview ? 'Refazer prévia' : 'Gerar prévia'}
          </button>
          {b.preview && (
            <button
              className="btn small"
              disabled={!!busy}
              onClick={onApprove}
              title="Grava esta animação na resolução do projeto, com o áudio do trecho, e põe o clipe na timeline no lugar do bloco (Ctrl+Z desfaz). O motion também vai pra memória do formato."
            >
              <Check size={13} /> Aprovar e importar na timeline
            </button>
          )}
        </div>
      )}
      {b.preview?.transcript && (
        <details className="blk-heard">
          <summary>O que foi ouvido no trecho</summary>
          <pre>{b.preview.transcript}</pre>
        </details>
      )}
    </div>
  )
}

/** painel da direita (inspetor) com o bloco selecionado */
export function BlockInspector(p: FormProps & { busy: BlockBusy | null; onGenerate: () => void; onCancel: () => void; onApprove: () => void; onOpen: () => void; onRemove: () => void }) {
  return (
    <div className="mt-insp blk-insp">
      <div className="blk-insp-head">
        <span className="mt-insp-name">Bloco de instrução · {fmtTc(blockDur(p.b))}</span>
        <button className="icon-btn" title="Abrir em janela (duplo clique no bloco)" onClick={p.onOpen}>
          <Maximize2 size={13} />
        </button>
        <button className="icon-btn" title="Excluir bloco (Delete)" onClick={p.onRemove}>
          <Trash2 size={13} />
        </button>
      </div>
      <BlockPreviewBox b={p.b} busy={p.busy} onGenerate={p.onGenerate} onCancel={p.onCancel} onApprove={p.onApprove} />
      <BlockForm b={p.b} dir={p.dir} patch={p.patch} />
    </div>
  )
}

/** janela do bloco (duplo clique): todas as propriedades + o player da prévia */
export function BlockWindow(p: FormProps & { busy: BlockBusy | null; onGenerate: () => void; onCancel: () => void; onApprove: () => void; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [p.onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="modal blk-window" role="dialog">
        <div className="blk-window-head">
          <h3>
            {blockLabel(p.b)} <small>{fmtTc(p.b.start)} → {fmtTc(p.b.end)} · {blockDur(p.b).toFixed(1)}s</small>
          </h3>
          <button className="icon-btn" title="Fechar (Esc)" onClick={p.onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="blk-window-body">
          <BlockPreviewBox b={p.b} busy={p.busy} onGenerate={p.onGenerate} onCancel={p.onCancel} onApprove={p.onApprove} big />
          <BlockForm b={p.b} dir={p.dir} patch={p.patch} big />
        </div>
      </div>
    </div>
  )
}
