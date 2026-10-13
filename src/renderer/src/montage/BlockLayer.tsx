import { useRef } from 'react'
import { Paperclip, Sparkles, Film, Ear, Loader2 } from 'lucide-react'
import type { BlockHeard } from './AudioRead'
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
  /** ímã (bordas dos cortes, playhead) sem contar os ids passados; on = Shift segurado */
  snap: (t: number, skip: string[], on?: boolean) => number
  /** linha do encaixe (null esconde) */
  showSnap: (t: number | null) => void
  /** faixa embaixo do mouse */
  trackAt: (clientY: number) => { id: string; kind: 'video' | 'audio' } | null
  /** gerando prévia agora */
  busy: string | null
  /** o som do bloco já foi lido (Whisper)? */
  heard?: (b: InstructionBlock) => BlockHeard
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
    const sh = e.shiftKey
    const off = (a: number, b: number) => Math.abs(a - b) > 1e-6
    let hit: number | null = null
    let nb: InstructionBlock
    if (d.kind === 'move') {
      const len = blockDur(o)
      let s = Math.max(0, o.start + dt)
      const a = p.snap(s, [o.id], sh)
      const z = p.snap(s + len, [o.id], sh) - len
      const first = Math.abs(a - s) <= Math.abs(z - s)
      if (first ? off(a, s) : off(z, s)) hit = first ? a : z + len
      s = Math.max(0, first ? a : z)
      const tr = p.trackAt(e.clientY)
      nb = { ...o, start: s, end: s + len, track: tr?.kind === 'video' ? tr.id : o.track }
    } else if (d.kind === 'l') {
      const raw = Math.max(0, o.start + dt)
      const sn = p.snap(raw, [o.id], sh)
      if (off(sn, raw)) hit = sn
      nb = { ...o, start: Math.min(o.end - BLOCK_MIN, Math.max(0, sn)) }
    } else {
      const raw = o.end + dt
      const sn = p.snap(raw, [o.id], sh)
      if (off(sn, raw)) hit = sn
      nb = { ...o, end: Math.max(o.start + BLOCK_MIN, sn) }
    }
    p.showSnap(hit)
    p.change({ ...p.data, blocks: d.all.map((x) => (x.id === o.id ? nb : x)) }, d.g)
  }
  const up = () => {
    drag.current = null
    p.showSnap(null)
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
              {(() => {
                const h = p.heard?.(b) ?? 'none'
                if (h === 'none') return null
                return (
                  <span
                    className={'heard ' + h}
                    title={h === 'done' ? 'Som do trecho já lido: a prévia não espera o Whisper' : h === 'running' ? 'Lendo o som do trecho (Whisper)…' : 'Som do trecho ainda não lido (Ler áudio, na barra da timeline)'}
                  >
                    {h === 'running' ? <Loader2 size={10} className="spin" /> : <Ear size={10} />}
                  </span>
                )
              })()}
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
