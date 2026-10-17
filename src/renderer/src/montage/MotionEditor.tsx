import { useEffect, useRef, useState } from 'react'
import { X, Check, Undo2, Film, Scissors, ArrowRightToLine } from 'lucide-react'
import { api, fileUrl, formatTime, type Attachment, type InstructionBlock } from '../lib'
import { blockDur, blockLabel } from './blocks'
import { AdjustBox, BusyBar, type BlockBusy } from './BlockPanel'

const f2 = (t: number) => t.toFixed(2).replace('.', ',')
const THUMBS = 14

/**
 * Editor de um motion já aprovado (duplo clique no clipe): player, uma timeline só do clipe onde se
 * marca o trecho a mudar, o pedido de alteração (com imagens), o progresso com os quadros e o Cancelar.
 * A alteração sai primeiro como prévia (12 fps); "Aplicar no vídeo" grava de novo e troca o clipe.
 */
export function MotionEditor(p: {
  block: InstructionBlock
  /** tem uma prévia da alteração que ainda não foi pro vídeo */
  pending: boolean
  /** o clipe da timeline foi gravado com uma qualidade mais velha (fundo pode sair em blocos) */
  outdated: boolean
  dir: string
  busy: BlockBusy | null
  /** pedido de alteração: do trecho marcado, ou (com `extend`) continuar o motion até essa nova duração (s) */
  onAdjust: (t: { text: string; files: Attachment[] }, range: [number, number] | null, extend: number | null) => void
  onCancel: () => void
  onApply: () => void
  onDiscard: () => void
  onClose: () => void
}) {
  const b = p.block
  const len = blockDur(b)
  const src = b.preview!.video
  const mine = p.busy?.id === b.id
  const video = useRef<HTMLVideoElement>(null)
  const lane = useRef<HTMLDivElement>(null)
  const [t, setT] = useState(0)
  const [range, setRange] = useState<[number, number] | null>(null)
  const [thumbs, setThumbs] = useState<(string | null)[]>([])
  /** continuar o motion: nova duração total (s); null = sem estender */
  const [extend, setExtend] = useState<number | null>(null)
  // com "continuar" ligado a faixa mostra espaço depois do fim pra arrastar até onde ele vai
  const scale = extend !== null ? Math.max(len * 1.6, len + 6, extend + 2) : len

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [p.onClose])

  // quadros do clipe pra servir de fundo da timeline
  useEffect(() => {
    let live = true
    const times = Array.from({ length: THUMBS }, (_, i) => +(((i + 0.5) * len) / THUMBS).toFixed(2))
    api.motionFramesAt(src, times, 240).then((r) => live && setThumbs(r))
    return () => {
      live = false
    }
  }, [src, len])

  // playhead acompanha o vídeo
  useEffect(() => {
    let id = 0
    const loop = () => {
      if (video.current) setT(video.current.currentTime)
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [])

  const timeAt = (clientX: number) => {
    const r = lane.current!.getBoundingClientRect()
    return Math.max(0, Math.min(scale, ((clientX - r.left) / r.width) * scale))
  }
  const seek = (s: number) => {
    if (video.current) video.current.currentTime = s
  }
  /** arrastar marca o trecho; clique simples só leva o playhead */
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const a = timeAt(e.clientX)
    // depois do fim do clipe: arrastar/clicar ali escolhe até onde o motion continua
    if (extend !== null && a > len) {
      const set = (x: number) => setExtend(Math.round(Math.max(len + 0.5, x) * 10) / 10)
      set(a)
      const mv = (ev: PointerEvent) => set(timeAt(ev.clientX))
      const stop = () => {
        window.removeEventListener('pointermove', mv)
        window.removeEventListener('pointerup', stop)
      }
      window.addEventListener('pointermove', mv)
      window.addEventListener('pointerup', stop)
      return
    }
    let moved = false
    seek(a)
    const move = (ev: PointerEvent) => {
      const z = timeAt(ev.clientX)
      if (!moved && Math.abs(ev.clientX - e.clientX) < 4) return
      moved = true
      setRange([Math.min(a, z), Math.min(len, Math.max(a, z))])
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const pct = (s: number) => `${(s / scale) * 100}%`
  const every = scale > 40 ? 5 : scale > 16 ? 2 : 1
  const ticks = Array.from({ length: Math.floor(scale / every) + 1 }, (_, i) => i * every)

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="modal blk-window mx-window" role="dialog">
        <div className="blk-window-head">
          <h3>
            <Film size={15} /> Editar motion · {blockLabel(b)} <small>{f2(len)} s</small>
          </h3>
          <button className="icon-btn" title="Fechar (Esc)" onClick={p.onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="mx-body">
          <div className="mx-player">
            <video ref={video} key={src} src={fileUrl(src)} controls playsInline />
            {p.pending && (
              <div className="mx-pending">
                <span>Esta é a prévia da alteração (12 fps). O vídeo da timeline só muda quando você aplicar.</span>
                <button className="btn small primary" disabled={!!p.busy} onClick={p.onApply} title="Grava a animação alterada na resolução do projeto e troca o clipe na timeline (Ctrl+Z desfaz)">
                  <Check size={13} /> Aplicar no vídeo
                </button>
                <button className="btn small" disabled={!!p.busy} onClick={p.onDiscard} title="Volta pro motion que está na timeline">
                  <Undo2 size={13} /> Descartar
                </button>
              </div>
            )}
            {!p.pending && p.outdated && (
              <div className="mx-pending">
                <span>Este clipe foi gravado antes da v3, com pouca qualidade: fundo em gradiente pode sair em blocos. Regrave pra corrigir.</span>
                <button className="btn small" disabled={!!p.busy} onClick={p.onApply} title="Grava de novo o mesmo motion na resolução do projeto, com a qualidade atual, e troca o clipe na timeline (Ctrl+Z desfaz)">
                  <Film size={13} /> Regravar o clipe
                </button>
              </div>
            )}
          </div>
          <div className="mx-tl">
            <div className="mx-ruler">
              {ticks.map((s) => (
                <span key={s} style={{ left: pct(s) }}>
                  {s}s
                </span>
              ))}
            </div>
            <div className="mx-lane" ref={lane} onPointerDown={down} title="Arraste pra marcar o trecho que vai mudar; clique pra ir até um ponto">
              <div className="mx-thumbs" style={{ width: pct(len) }}>
                {thumbs.map((th, i) => (th ? <img key={i} src={fileUrl(th)} alt="" draggable={false} /> : <i key={i} />))}
              </div>
              {extend !== null && (
                <div className="mx-extend" style={{ left: pct(len), width: pct(extend - len) }}>
                  <span>+{f2(extend - len)} s</span>
                </div>
              )}
              {range && <div className="mx-range" style={{ left: pct(range[0]), width: pct(range[1] - range[0]) }} />}
              <div className="mx-head" style={{ left: pct(Math.min(len, t)) }} />
            </div>
            <div className="mx-range-row">
              <ArrowRightToLine size={12} />
              {extend === null ? (
                <>
                  <span>O motion acaba em {f2(len)} s.</span>
                  <button className="btn small" disabled={p.pending} title={p.pending ? 'Aplique ou descarte a alteração antes' : 'O Claude continua a animação de onde ela para, até onde você marcar'} onClick={() => (setExtend(Math.round((len + 3) * 10) / 10), setRange(null))}>
                    Continuar o motion…
                  </button>
                </>
              ) : (
                <>
                  <span>
                    Continuar até{' '}
                    <input
                      className="mx-extend-in"
                      type="number"
                      min={+(len + 0.5).toFixed(1)}
                      step={0.1}
                      value={extend}
                      onChange={(e) => setExtend(Math.max(len + 0.5, Number(e.target.value) || 0))}
                    />{' '}
                    s (+{f2(extend - len)} s; termina em {formatTime(b.start + extend)} na timeline). Arraste na faixa depois do fim. O que já existe fica igual.
                  </span>
                  <button className="btn small" onClick={() => setExtend(null)}>
                    Não continuar
                  </button>
                </>
              )}
            </div>
            {extend === null && (
            <div className="mx-range-row">
              <Scissors size={12} />
              {range ? (
                <>
                  <span>
                    Trecho: <b>{f2(range[0])} s</b> a <b>{f2(range[1])} s</b> ({f2(range[1] - range[0])} s). Só ele muda; o resto fica igual.
                  </span>
                  <button className="btn small" onClick={() => setRange(null)}>
                    Limpar
                  </button>
                </>
              ) : (
                <span>Sem trecho marcado: o pedido vale pro clipe todo. Arraste na faixa acima pra marcar só uma parte.</span>
              )}
            </div>
            )}
            {mine && <BusyBar busy={p.busy!} onCancel={p.onCancel} />}
            {!mine && p.busy && <div className="blk-hint">Outra prévia está sendo feita. Espere ela terminar.</div>}
          </div>
          <AdjustBox b={b} dir={p.dir} busy={!!p.busy} onAdjust={(tw) => {
              p.onAdjust(tw, extend === null ? range : null, extend)
              setExtend(null)
            }}
            title={extend !== null ? 'Como o motion continua (opcional)' : range ? 'Pedir alteração do trecho marcado' : 'Pedir alteração do motion'}
            allowEmpty={extend !== null}
            draftKey={`motion:${b.id}`}
            sendLabel={extend !== null ? `Continuar até ${f2(extend)} s` : 'Enviar alteração'}
          />
        </div>
      </div>
    </div>
  )
}
