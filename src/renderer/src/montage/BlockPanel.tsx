import { useEffect, useRef, useState } from 'react'
import { Paperclip, ClipboardPaste, X, Sparkles, Film, Loader2, Check, Maximize2, Trash2, AlertTriangle, MessageSquare, Send, ArrowLeftToLine, ArrowRightToLine } from 'lucide-react'
import { api, absPath, fileUrl, pasteClipboardImage, type Attachment, type BlockAttachment, type Format, type InstructionBlock, type MontageData } from '../lib'
import { PromptMenu } from './PromptMenu'
import { rememberPrompt } from './prompts'
import { blockDur, blockLabel, blockSync, isImage, neighborOf, neighborText, previewStale } from './blocks'

const fmtTc = (t: number) => {
  const m = Math.floor(Math.max(0, t) / 60)
  return `${m}:${(Math.max(0, t) - m * 60).toFixed(2).padStart(5, '0')}`
}

export interface BlockBusy {
  id: string
  label: string
  /** dentro da etapa atual (0–1); null = sem medida */
  pct: number | null
  /** pedaço do total que a etapa ocupa (pra barra geral) */
  span?: [number, number]
  /** quando começou (pra mostrar o tempo) */
  t0?: number
  /** quadros da gravação em andamento (pra mostrar quantos faltam) */
  frames?: number
}

/** quanto do trabalho todo já foi (0–1); sem etapa conhecida, o da etapa */
export const busyOverall = (b: BlockBusy) => (b.span ? b.span[0] + (b.span[1] - b.span[0]) * Math.max(0, Math.min(1, b.pct ?? 0)) : (b.pct ?? 0))

const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** barra de progresso da prévia/clipe: etapa, % do total, tempo e Cancelar */
export function BusyBar({ busy, onCancel, big }: { busy: BlockBusy; onCancel: () => void; big?: boolean }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const all = busyOverall(busy)
  const cancelling = busy.label === 'Cancelando…'
  return (
    <div className="blk-prev-busy">
      <div className="blk-busy-row">
        <Loader2 size={13} className="spin" />
        <span className="blk-busy-label">{busy.label}</span>
        <span className="blk-busy-num">
          {Math.round(all * 100)}%{busy.t0 ? ` · ${fmtElapsed(Date.now() - busy.t0)}` : ''}
        </span>
      </div>
      {!!busy.frames && busy.pct !== null && busy.label.startsWith('Gravando') && (
        <small className="blk-busy-frames">
          quadro {Math.min(busy.frames, Math.round(busy.pct * busy.frames))} de {busy.frames} · faltam {Math.max(0, busy.frames - Math.round(busy.pct * busy.frames))}
        </small>
      )}
      <div className={'mt-bar blk-busy-bar' + (busy.span || busy.pct !== null ? '' : ' indet')}>
        <i style={{ width: `${Math.round(all * 1000) / 10}%` }} />
      </div>
      <button className="btn small" disabled={cancelling} onClick={onCancel}>
        <X size={12} /> {cancelling ? 'Cancelando…' : 'Cancelar'}
      </button>
      {big && <small className="blk-prev-bg">Pode fechar esta janela e continuar usando o Typos: a prévia segue em segundo plano e fica neste bloco.</small>}
    </div>
  )
}

interface FormProps {
  b: InstructionBlock
  /** a timeline (pra mostrar o que encosta no bloco) */
  data?: MontageData
  dir: string
  patch: (p: Partial<InstructionBlock>, gesture?: string) => void
  /** os estilos (formatos) que o bloco pode usar no lugar do estilo do vídeo */
  formats?: Format[]
  /** o estilo do vídeo (o que vale quando o bloco não escolhe outro) */
  videoFormat?: Format
}

const toBlockAtt = (a: Attachment): BlockAttachment => ({ ...a, use: 'insert' })

/** campos do bloco: nome, tempo, modo, instruções e anexos (o mesmo no painel e na janela) */
export function BlockForm({ b, data, dir, patch, big, formats, videoFormat }: FormProps & { big?: boolean }) {
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
      {!!formats?.length && (
        <label className="blk-label blk-style" title="Estilo de motion só deste bloco (guia, cores, fontes, regras, pastas de assets e memória). Vale na próxima prévia.">
          Estilo deste bloco
          <select value={b.formatId && formats.some((f) => f.id === b.formatId) ? b.formatId : ''} onChange={(e) => patch({ formatId: e.target.value || undefined })}>
            <option value="">Estilo do vídeo{videoFormat ? ` (${videoFormat.name})` : ''}</option>
            {formats
              .filter((f) => f.id !== videoFormat?.id)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
        </label>
      )}
      <label className="blk-label blk-sync" title="Quanto o motion acompanha o que é dito no trecho. Vale na próxima prévia.">
        <span>
          Sincronia com a fala <b>{blockSync(b).toFixed(2).replace('.', ',')}</b>
          <small>{blockSync(b) <= 0.05 ? 'não sincroniza' : blockSync(b) < 0.4 ? 'só os momentos-chave' : blockSync(b) < 0.75 ? 'meio-termo' : blockSync(b) < 0.95 ? 'quase tudo' : 'sincroniza tudo'}</small>
        </span>
        <input type="range" min={0} max={1} step={0.05} value={blockSync(b)} onChange={(e) => patch({ sync: Number(e.target.value) }, g + 'sy')} />
      </label>
      <div className="blk-chain">
        <span className="blk-chain-title">Emenda com os vizinhos (sem corte seco)</span>
        {(['prev', 'next'] as const).map((side) => {
          const on = side === 'prev' ? !!b.fromPrev : !!b.toNext
          const n = data ? neighborOf(data, b, side) : null
          return (
            <label
              key={side}
              className={'blk-chain-opt' + (on ? ' on' : '')}
              title={
                side === 'prev'
                  ? 'O primeiro quadro deste bloco é o último quadro do que toca antes (um bloco encostado ou o vídeo da timeline); o motion parte dali. Se for um bloco, ele precisa ter prévia.'
                  : 'O motion termina chegando no primeiro quadro do que toca depois (um bloco encostado ou o vídeo da timeline). Se for um bloco, ele precisa ter prévia.'
              }
            >
              <input type="checkbox" checked={on} onChange={(e) => patch(side === 'prev' ? { fromPrev: e.target.checked } : { toNext: e.target.checked })} />
              {side === 'prev' ? <ArrowLeftToLine size={12} /> : <ArrowRightToLine size={12} />}
              <span>
                {side === 'prev' ? 'Continuar do último quadro de antes' : 'Fazer motion até o primeiro quadro de depois'}
                {data && <small>{side === 'prev' ? 'antes' : 'depois'}: {neighborText(n)}</small>}
              </span>
            </label>
          )
        })}
      </div>
      <div className="blk-label">
        <span className="blk-label-head">
          <label htmlFor={g + '-text'}>{b.dynamic ? 'Dicas (opcional): o motion sai da fala do trecho' : 'Como você imagina o motion'}</label>
          <PromptMenu
            text={b.text}
            onPick={(t) => {
              // o texto que estava no campo não se perde: vai pros recentes
              rememberPrompt(b.text)
              patch({ text: t })
            }}
          />
        </span>
        <textarea
          id={g + '-text'}
          rows={big ? 10 : 6}
          value={b.text}
          placeholder={
            b.dynamic
              ? 'Ex.: algo mais calmo, cores frias, termina com o logo…'
              : 'Ex.: gráfico de pizza montando fatia por fatia com as porcentagens; câmera aproxima da maior fatia quando falo “70%”…'
          }
          onChange={(e) => patch({ text: e.target.value }, g + 't')}
        />
      </div>
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

export type AdjustFn = (t: { text: string; files: Attachment[] }) => void

/** pedir ajustes na prévia atual: o histórico do que já foi pedido + campo de texto com anexos */
export function AdjustBox({
  b,
  dir,
  busy,
  onAdjust,
  onClose,
  title = 'Pedir ajustes nesta prévia',
  allowEmpty,
  sendLabel = 'Enviar ajuste'
}: {
  b: InstructionBlock
  dir: string
  busy: boolean
  onAdjust: AdjustFn
  onClose?: () => void
  title?: string
  /** pode enviar sem texto nem imagem (ex.: continuar o motion) */
  allowEmpty?: boolean
  sendLabel?: string
}) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const send = () => {
    if (busy || (!allowEmpty && !text.trim() && !files.length)) return
    onAdjust({ text: text.trim(), files })
    setText('')
    setFiles([])
  }
  const imgs = (list: Attachment[]) => setFiles((f) => [...f, ...list.filter(isImage)])
  return (
    <div
      className="blk-adjust"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={async (e) => {
        const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
        if (!paths.length) return
        e.preventDefault()
        e.stopPropagation()
        imgs(await api.importPaths(dir, paths))
      }}
    >
      <div className="blk-adjust-head">
        <MessageSquare size={12} /> {title}
        <span className="st-grow" />
        {onClose && (
          <button className="icon-btn" title="Fechar" onClick={onClose}>
            <X size={12} />
          </button>
        )}
      </div>
      {!!b.tweaks?.length && (
        <ol className="blk-adjust-log" title="O que já foi pedido nesta prévia (some quando você refaz a prévia do zero)">
          {b.tweaks.map((t) => (
            <li key={t.id}>
              {t.text || <i>só imagens</i>}
              {!!t.files.length && <small> · {t.files.length} imagem(ns)</small>}
            </li>
          ))}
        </ol>
      )}
      <textarea
        ref={ref}
        rows={3}
        value={text}
        placeholder="Ex.: o número entra mais cedo, quando falo “70%”; troca o fundo por um mais escuro; tira a seta da direita…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send()
          e.stopPropagation()
        }}
        onPaste={async (e) => {
          if (![...e.clipboardData.items].some((i) => i.type.startsWith('image/'))) return
          e.preventDefault()
          const a = await pasteClipboardImage(dir)
          if (a) imgs([a])
        }}
      />
      {!!files.length && (
        <div className="blk-adjust-files">
          {files.map((a) => (
            <span key={a.id}>
              <img src={fileUrl(absPath(a))} alt="" />
              <X size={11} onClick={() => setFiles((f) => f.filter((x) => x.id !== a.id))} />
            </span>
          ))}
        </div>
      )}
      <div className="blk-adjust-btns">
        <button className="icon-btn" title="Anexar imagem do PC" onClick={async () => imgs(await api.pickAssets(dir))}>
          <Paperclip size={13} />
        </button>
        <button
          className="icon-btn"
          title="Colar imagem (print)"
          onClick={async () => {
            const a = await pasteClipboardImage(dir)
            if (a) imgs([a])
          }}
        >
          <ClipboardPaste size={13} />
        </button>
        <span className="st-grow" />
        <button className="btn small primary" disabled={busy || (!allowEmpty && !text.trim() && !files.length)} title="Ctrl+Enter" onClick={send}>
          <Send size={12} /> {sendLabel}
        </button>
      </div>
    </div>
  )
}

/** prévia: vídeo, gerar de novo, pedir ajustes, aprovar (vira clipe na timeline) */
export function BlockPreviewBox({
  b,
  dir,
  busy,
  onGenerate,
  onAdjust,
  onCancel,
  onApprove,
  heard,
  big
}: {
  b: InstructionBlock
  dir: string
  busy: BlockBusy | null
  onGenerate: () => void
  onAdjust: AdjustFn
  onCancel: () => void
  onApprove: () => void
  /** linha "Som do trecho: lido / não lido" */
  heard?: React.ReactNode
  big?: boolean
}) {
  const mine = busy?.id === b.id
  const stale = previewStale(b)
  const [asking, setAsking] = useState(false)
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
      {!!b.preview?.safeIssues?.length && (
        <details className="blk-prev-stale blk-prev-safe">
          <summary>
            <AlertTriangle size={12} /> Algo ainda ficou fora da safe zone. Peça um ajuste ou refaça.
          </summary>
          <ul>
            {b.preview.safeIssues.map((t, i) => (
              <li key={i}>{t.replace(/^- /, '')}</li>
            ))}
          </ul>
        </details>
      )}
      {mine ? (
        <BusyBar busy={busy!} onCancel={onCancel} big={big} />
      ) : (
        <div className="blk-prev-btns">
          <button
            className={'btn small' + (b.preview ? '' : ' primary')}
            disabled={!!busy}
            title={busy ? 'Outra prévia está sendo feita' : b.preview ? 'Cria o motion de novo, do zero (esquece os ajustes pedidos)' : ''}
            onClick={onGenerate}
          >
            <Sparkles size={13} /> {b.preview ? 'Refazer do zero' : 'Gerar prévia'}
          </button>
          {b.preview && (
            <button
              className={'btn small' + (asking ? ' on' : ' primary')}
              disabled={!!busy}
              title="Conta pro Claude o que mudar: ele parte desta prévia e mantém o resto"
              onClick={() => setAsking((a) => !a)}
            >
              <MessageSquare size={13} /> Pedir ajustes{b.tweaks?.length ? ` (${b.tweaks.length})` : ''}
            </button>
          )}
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
      {heard}
      {b.preview && asking && <AdjustBox b={b} dir={dir} busy={!!busy} onAdjust={onAdjust} onClose={() => setAsking(false)} />}
      {b.preview?.transcript && (
        <details className="blk-heard">
          <summary>O que foi ouvido no trecho</summary>
          <pre>{b.preview.transcript}</pre>
        </details>
      )}
    </div>
  )
}

/** gera a prévia e guarda o texto nos prompts recentes */
const generate = (p: { b: InstructionBlock; onGenerate: () => void }) => {
  rememberPrompt(p.b.text)
  p.onGenerate()
}

/** painel da direita (inspetor) com o bloco selecionado */
export function BlockInspector(p: FormProps & { busy: BlockBusy | null; onGenerate: () => void; onAdjust: AdjustFn; onCancel: () => void; onApprove: () => void; onOpen: () => void; onRemove: () => void; heard?: React.ReactNode }) {
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
      <BlockPreviewBox b={p.b} dir={p.dir} busy={p.busy} onGenerate={() => generate(p)} onAdjust={p.onAdjust} onCancel={p.onCancel} onApprove={p.onApprove} heard={p.heard} />
      <BlockForm b={p.b} data={p.data} dir={p.dir} patch={p.patch} formats={p.formats} videoFormat={p.videoFormat} />
    </div>
  )
}

/** janela do bloco (duplo clique): todas as propriedades + o player da prévia */
export function BlockWindow(p: FormProps & { busy: BlockBusy | null; onGenerate: () => void; onAdjust: AdjustFn; onCancel: () => void; onApprove: () => void; onClose: () => void; heard?: React.ReactNode }) {
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
          <BlockPreviewBox b={p.b} dir={p.dir} busy={p.busy} onGenerate={() => generate(p)} onAdjust={p.onAdjust} onCancel={p.onCancel} onApprove={p.onApprove} heard={p.heard} big />
          <BlockForm b={p.b} data={p.data} dir={p.dir} patch={p.patch} formats={p.formats} videoFormat={p.videoFormat} big />
        </div>
      </div>
    </div>
  )
}
