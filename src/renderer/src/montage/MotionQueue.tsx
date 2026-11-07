import { useEffect, useState } from 'react'
import { AlertTriangle, Check, ListPlus, ListX, Loader2, X } from 'lucide-react'
import type { InstructionBlock } from '../lib'
import { busyOverall } from './BlockPanel'
import { blockLabel, previewStale } from './blocks'
import { MAX_PARALLEL, type BusyMap } from './busy'

const fmtTc = (t: number) => {
  const m = Math.floor(Math.max(0, t) / 60)
  return `${m}:${(Math.max(0, t) - m * 60).toFixed(1).padStart(4, '0')}`
}

/**
 * Fila de motion: todos os blocos da timeline, cada um com o modo (prévia pra revisar ou aprovar
 * sozinho). Marca vários e põe na fila; ela faz 2 por vez e o próximo entra sozinho.
 */
export function MotionQueue({
  blocks,
  queue,
  busy,
  errors,
  onMode,
  onQueue,
  onUnqueue,
  onCancel,
  onOpen,
  onClose
}: {
  blocks: InstructionBlock[]
  queue: string[]
  busy: BusyMap
  errors: Record<string, string>
  onMode: (id: string, auto: boolean) => void
  onQueue: (ids: string[]) => void
  onUnqueue: (ids: string[]) => void
  onCancel: (id: string) => void
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const [picked, setPicked] = useState<string[]>([])
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const list = [...blocks].sort((a, b) => a.start - b.start)
  const free = (id: string) => !busy[id] && !queue.includes(id)
  const pickable = list.filter((b) => free(b.id))
  const sel = picked.filter((id) => list.some((b) => b.id === id))
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const queueSel = () => {
    // na ordem da timeline
    onQueue(list.filter((b) => sel.includes(b.id) && free(b.id)).map((b) => b.id))
    setPicked([])
  }
  const status = (b: InstructionBlock) => {
    const run = busy[b.id]
    if (run)
      return (
        <span className="mq-status run">
          {run.queued ? 'esperando a gravação do outro bloco' : run.label} · {Math.round(busyOverall(run) * 100)}%
          <button className="btn small" onClick={() => onCancel(b.id)}>
            Cancelar
          </button>
        </span>
      )
    const pos = queue.indexOf(b.id) + 1
    if (pos)
      return (
        <span className="mq-status wait">
          na fila ({pos}º)
          <button className="btn small" onClick={() => onUnqueue([b.id])}>
            Tirar
          </button>
        </span>
      )
    if (errors[b.id])
      return (
        <span className="mq-status err" title={errors[b.id]}>
          <AlertTriangle size={11} /> erro: {errors[b.id]}
        </span>
      )
    if (b.preview) return <span className="mq-status ok">{previewStale(b) ? 'prévia desatualizada' : 'prévia pronta pra revisar'}</span>
    return <span className="mq-status">sem motion ainda</span>
  }
  const running = Object.keys(busy).length
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal mq-window" role="dialog">
        <div className="blk-window-head">
          <h3>
            Fila de motion{' '}
            <small>
              {running ? `${running} rodando` : 'nada rodando'} · {queue.length} na fila · {MAX_PARALLEL} por vez
            </small>
          </h3>
          <button className="icon-btn" title="Fechar (Esc)" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <p className="mq-hint">
          Marque os blocos, escolha em cada um se ele para na prévia pra você revisar ou se aprova sozinho (grava o clipe final e já importa na timeline, no lugar do bloco). A
          fila faz {MAX_PARALLEL} por vez e continua enquanto você edita; Ctrl+Z desfaz cada importação.
        </p>
        {list.length ? (
          <div className="mq-list">
            {list.map((b) => (
              <div key={b.id} className={'mq-row' + (busy[b.id] ? ' run' : '')}>
                <input type="checkbox" disabled={!free(b.id)} checked={sel.includes(b.id)} onChange={() => toggle(b.id)} />
                <button className="mq-name" title="Abrir o bloco" onClick={() => onOpen(b.id)}>
                  {busy[b.id] && <Loader2 size={11} className="spin" />} {blockLabel(b)} <small>{fmtTc(b.start)}</small>
                </button>
                <select value={b.autoApprove ? 'auto' : 'preview'} disabled={!!busy[b.id]} onChange={(e) => onMode(b.id, e.target.value === 'auto')}>
                  <option value="preview">Prévia pra revisar</option>
                  <option value="auto">Aprovar sozinho</option>
                </select>
                {status(b)}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-empty small">Nenhum bloco de instrução na timeline.</div>
        )}
        <div className="mq-foot">
          <button className="btn small" disabled={!pickable.length} onClick={() => setPicked(sel.length === pickable.length ? [] : pickable.map((b) => b.id))}>
            <Check size={13} /> {sel.length === pickable.length && pickable.length ? 'Desmarcar todos' : 'Marcar todos'}
          </button>
          <button className="btn small" disabled={!pickable.length} onClick={() => setPicked(pickable.filter((b) => !b.preview).map((b) => b.id))}>
            Marcar os sem motion
          </button>
          {!!sel.length && (
            <span className="mq-modes">
              Marcados:
              <button className="btn small" onClick={() => sel.forEach((id) => !busy[id] && onMode(id, false))}>
                prévia
              </button>
              <button className="btn small" onClick={() => sel.forEach((id) => !busy[id] && onMode(id, true))}>
                aprovar sozinho
              </button>
            </span>
          )}
          <span className="mt-grow" />
          {!!queue.length && (
            <button className="btn small" onClick={() => onUnqueue(queue)}>
              <ListX size={13} /> Esvaziar a fila
            </button>
          )}
          <button className="btn small primary" disabled={!sel.length} onClick={queueSel}>
            <ListPlus size={13} /> Pôr na fila{sel.length ? ` (${sel.length})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
