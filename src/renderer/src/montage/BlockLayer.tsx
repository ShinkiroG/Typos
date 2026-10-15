import { useRef } from 'react'
import { Paperclip, Sparkles, Film, Ear, Loader2, ArrowLeftToLine, ArrowRightToLine } from 'lucide-react'
import type { BlockHeard } from './AudioRead'
import { formatTime, uid, type InstructionBlock, type MontageData } from '../lib'
import { BLOCK_MIN, blockDur, blockLabel, previewStale } from './blocks'
import { snapMove } from './snap'

/**
 * Blocos de instrução desenhados numa faixa de vídeo: arrastar move (e troca de faixa de vídeo),
 * as bordas aparam, duplo clique abre a janela do bloco. O ímã fica sempre ligado nos blocos
 * (Alt segurado solta).
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
  /** ímã (bordas dos cortes e blocos, playhead) sem contar os ids passados; on = liga o ímã */
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
  // o arrasto escuta a janela (não o elemento): trocar de faixa remonta o bloco em outra camada e
  // o elemento antigo perde o pointer capture no meio do gesto
  const live = useRef(p)
  live.current = p
  const blocks = (p.data.blocks ?? []).filter((b) => b.track === p.track)

  const down = (e: React.PointerEvent, b: InstructionBlock) => {
    if (e.button !== 0) return
    e.stopPropagation()
    p.onSelect(b.id)
    const role = (e.target as HTMLElement).dataset.role
    const kind: 'move' | 'l' | 'r' = role === 'l' || role === 'r' ? role : 'move'
    const x0 = e.clientX
    const o = b
    const all = p.data.blocks ?? []
    const g = uid()
    let moved = false
    const move = (ev: PointerEvent) => {
      const q = live.current
      if (!moved && Math.abs(ev.clientX - x0) < 3 && kind === 'move') return
      moved = true
      const dt = (ev.clientX - x0) / q.pps
      // blocos grudam sempre (é o que deixa um encostado no outro, sem vão nem corte); Alt solta
      const on = !ev.altKey
      const off = (a: number, z: number) => Math.abs(a - z) > 1e-6
      let hit: number | null = null
      let nb: InstructionBlock
      if (kind === 'move') {
        const len = blockDur(o)
        const sm = snapMove((t) => q.snap(t, [o.id], on), Math.max(0, o.start + dt), len)
        hit = sm.hit
        const s = Math.max(0, sm.start)
        const tr = q.trackAt(ev.clientY)
        nb = { ...o, start: s, end: s + len, track: tr?.kind === 'video' ? tr.id : o.track }
      } else if (kind === 'l') {
        const raw = Math.max(0, o.start + dt)
        const sn = q.snap(raw, [o.id], on)
        if (off(sn, raw)) hit = sn
        nb = { ...o, start: Math.min(o.end - BLOCK_MIN, Math.max(0, sn)) }
      } else {
        const raw = o.end + dt
        const sn = q.snap(raw, [o.id], on)
        if (off(sn, raw)) hit = sn
        nb = { ...o, end: Math.max(o.start + BLOCK_MIN, sn) }
      }
      q.showSnap(hit)
      q.change({ ...q.data, blocks: all.map((x) => (x.id === o.id ? nb : x)) }, g)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      live.current.showSnap(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
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
            title={`${blockLabel(b)}\n${formatTime(b.start)} → ${formatTime(b.end)} (${blockDur(b).toFixed(1)}s)\n${b.dynamic ? 'Dinâmico: o Claude deduz o motion pela fala' : b.text.trim() || 'Sem instruções ainda'}\nDuplo clique abre o bloco · arrastar gruda nas bordas (Alt solta)`}
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
              {b.fromPrev && (
                <span title="Continua do último quadro de antes">
                  <ArrowLeftToLine size={10} />
                </span>
              )}
              {b.toNext && (
                <span title="Termina no primeiro quadro de depois">
                  <ArrowRightToLine size={10} />
                </span>
              )}
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
