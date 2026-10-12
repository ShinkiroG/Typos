import { useRef } from 'react'
import { Paperclip, Sparkles, Film } from 'lucide-react'
import { formatTime, uid, type InstructionBlock, type MontageData } from '../lib'
import { BLOCK_MIN, blockDur, blockLabel, previewStale } from './blocks'

/**
 * Blocos de instrução desenhados numa faixa de vídeo: arrastar move (e troca de faixa de vídeo),
 * as bordas aparam, duplo clique abre a janela do bloco.
 */
export function BlockLayer(p: {
  data: MontageData
  track: string
  pps: number
  selected: string | null
  onSelect: (id: string | null) => void
  onOpen: (id: string) => void
  onMenu: (e: React.MouseEvent, id: string) => void
  change: (next: MontageData, gesture?: string) => void
  /** ímã (bordas dos cortes, playhead) sem contar os ids passados */
  snap: (t: number, skip: string[]) => number
  /** faixa embaixo do mouse */
  trackAt: (clientY: number) => { id: string; kind: 'video' | 'audio' } | null
  /** gerando prévia agora */
  busy: string | null
}) {
  const drag = useRef<{ kind: 'move' | 'l' | 'r'; x0: number; orig: InstructionBlock; all: InstructionBlock[]; g: string; moved: boolean } | null>(null)
  const blocks = (p.data.blocks ?? []).filter((b) => b.track === p.track)

  const down = (e: React.PointerEvent, b: InstructionBlock) => {
    if (e.button !== 0) return
    e.stopPropagation()
    p.onSelect(b.id)
    const role = (e.target as HTMLElement).dataset.role
    drag.current = { kind: role === 'l' || role === 'r' ? role : 'move', x0: e.clientX, orig: b, all: p.data.blocks ?? [], g: uid(), moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3 && d.kind === 'move') return
    d.moved = true
    const o = d.orig
    const dt = (e.clientX - d.x0) / p.pps
    let nb: InstructionBlock
    if (d.kind === 'move') {
      const len = blockDur(o)
      let s = Math.max(0, o.start + dt)
      const a = p.snap(s, [o.id])
      const z = p.snap(s + len, [o.id]) - len
      s = Math.max(0, Math.abs(a - s) <= Math.abs(z - s) ? a : z)
      const tr = p.trackAt(e.clientY)
      nb = { ...o, start: s, end: s + len, track: tr?.kind === 'video' ? tr.id : o.track }
    } else if (d.kind === 'l') {
      const s = Math.min(o.end - BLOCK_MIN, Math.max(0, p.snap(o.start + dt, [o.id])))
      nb = { ...o, start: s }
    } else {
      const en = Math.max(o.start + BLOCK_MIN, p.snap(o.end + dt, [o.id]))
      nb = { ...o, end: en }
    }
    p.change({ ...p.data, blocks: d.all.map((x) => (x.id === o.id ? nb : x)) }, d.g)
  }
  const up = () => {
    drag.current = null
  }

  return (
    <>
      {blocks.map((b) => {
        const stale = previewStale(b)
        return (
          <div
            key={b.id}
            className={'mt-iblock' + (p.selected === b.id ? ' sel' : '') + (b.dynamic ? ' dyn' : '') + (p.busy === b.id ? ' busy' : '')}
            style={{ left: b.start * p.pps, width: Math.max(4, blockDur(b) * p.pps) }}
            data-iblock={b.id}
            onPointerDown={(e) => down(e, b)}
            onPointerMove={move}
            onPointerUp={up}
            onDoubleClick={(e) => {
              e.stopPropagation()
              p.onOpen(b.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              p.onSelect(b.id)
              p.onMenu(e, b.id)
            }}
            title={`${blockLabel(b)}\n${formatTime(b.start)} → ${formatTime(b.end)} (${blockDur(b).toFixed(1)}s)\n${b.dynamic ? 'Dinâmico: o Claude deduz o motion pela fala' : b.text.trim() || 'Sem instruções ainda'}\nDuplo clique abre o bloco`}
          >
            <span className="mt-iblock-name">
              {b.dynamic && <Sparkles size={10} />}
              {blockLabel(b)}
            </span>
            <span className="mt-iblock-text">{b.text.trim() || (b.dynamic ? 'dinâmico (pela fala)' : 'sem instruções')}</span>
            <span className="mt-iblock-badges">
              {b.attachments.length > 0 && (
                <span title={`${b.attachments.length} anexo(s)`}>
                  <Paperclip size={10} />
                  {b.attachments.length}
                </span>
              )}
              {b.preview && (
                <span className={stale ? 'stale' : b.approved ? 'ok' : ''} title={stale ? 'Prévia desatualizada (o bloco mudou)' : b.approved ? 'Prévia aprovada' : 'Tem prévia'}>
                  <Film size={10} />
                </span>
              )}
            </span>
            <div className="mt-iblock-trim l" data-role="l" />
            <div className="mt-iblock-trim r" data-role="r" />
          </div>
        )
      })}
    </>
  )
}
