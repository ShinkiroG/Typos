import { memo, useLayoutEffect, useRef } from 'react'
import { Volume2, VolumeX, Plus } from 'lucide-react'
import { clipDur, clipEndT, formatTime, uid, type MontageClip, type MontageData, type MontageMedia, type MontageTrack } from '../lib'
import { PEAKS_PER_SEC, type MontageEngine } from './engine'

export const MEDIA_MIME = 'application/x-typos-media'
export type Tool = 'select' | 'blade'

interface Props {
  data: MontageData
  /** gesture: mudanças do mesmo arrasto viram um passo só no desfazer */
  change: (next: MontageData, gesture?: string) => void
  engine: MontageEngine
  media: Map<string, MontageMedia>
  selected: string[]
  onSelect: (ids: string[]) => void
  tool: Tool
  pps: number
  posRef: React.MutableRefObject<number>
  seek: (t: number) => void
  playheadRef: React.RefObject<HTMLDivElement | null>
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** muda quando chega uma onda nova */
  wavesVersion: number
  /** faixa de áudio que recebe a gravação */
  armed: string | null
  onArm: (trackId: string) => void
  recording: { track: string; start: number } | null
  recClipRef: React.RefObject<HTMLDivElement | null>
  /** botão direito num corte */
  onClipMenu: (e: React.MouseEvent, c: MontageClip) => void
}

const HEAD_W = 132
const SNAP_PX = 8
const MIN_DUR = 0.04

/** duração "infinita" de imagem parada */
export const mediaLen = (m?: MontageMedia) => (!m ? 0 : m.kind === 'image' ? 3600 : m.duration)

/**
 * Soltar um corte em cima de outro (na mesma faixa) corta o de baixo, como num editor de vídeo:
 * o pedaço coberto some de verdade (arrastar de volta deixa o vão, não o som antigo).
 */
export function overwrite(clips: MontageClip[], ids: string[]): MontageClip[] {
  let out = clips
  for (const id of ids) {
    const top = out.find((c) => c.id === id)
    if (!top) continue
    const s = top.start
    const e = clipEndT(top)
    const next: MontageClip[] = []
    for (const o of out) {
      if (o.id === top.id || ids.includes(o.id) || o.track !== top.track) {
        next.push(o)
        continue
      }
      const os = o.start
      const oe = clipEndT(o)
      if (oe <= s + 0.001 || os >= e - 0.001) next.push(o) // não encosta
      else if (os >= s - 0.001 && oe <= e + 0.001) continue // coberto inteiro: sai
      else if (os < s && oe > e) {
        // o de cima caiu no meio: o de baixo vira dois pedaços
        next.push({ ...o, out: o.in + (s - os), fadeOut: 0 })
        next.push({ ...o, id: uid(), start: e, in: o.in + (e - os), fadeIn: 0, splice: undefined })
      } else if (os < s) next.push({ ...o, out: o.in + (s - os), fadeOut: 0 }) // perde o fim
      else next.push({ ...o, start: e, in: o.in + (e - os), fadeIn: 0, splice: undefined }) // perde o começo
    }
    out = next
  }
  return out
}

export function splitClip(c: MontageClip, t: number): [MontageClip, MontageClip] | null {
  if (t <= c.start + MIN_DUR || t >= clipEndT(c) - MIN_DUR) return null
  const cut = c.in + (t - c.start)
  return [
    { ...c, out: cut, fadeOut: 0 },
    { ...c, id: uid(), start: t, in: cut, fadeIn: 0, splice: undefined }
  ]
}

function rulerStep(pps: number) {
  for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) if (s * pps >= 70) return s
  return 1200
}

export function EditTimeline(p: Props) {
  const { data, pps, scrollRef } = p
  const end = Math.max(30, ...data.clips.map(clipEndT)) + 20
  const width = end * pps

  // ---------- arrastos ----------
  const drag = useRef<{
    kind: 'move' | 'trim-l' | 'trim-r' | 'fade-in' | 'fade-out' | 'scrub'
    x0: number
    orig: MontageData
    ids: string[]
    gesture: string
    main: string
    /** último estado do arrasto (o React pode não ter redesenhado ainda quando solta) */
    last?: MontageData
  } | null>(null)

  const timeAt = (clientX: number) => {
    const el = scrollRef.current!
    const r = el.getBoundingClientRect()
    return Math.max(0, (clientX - r.left - HEAD_W + el.scrollLeft) / pps)
  }

  /** ímã: bordas de outros clipes, playhead e zero */
  const snap = (t: number, skip: string[]) => {
    const cands = [0, p.posRef.current]
    for (const c of data.clips) if (!skip.includes(c.id)) cands.push(c.start, clipEndT(c))
    let best = t
    let bestD = SNAP_PX / pps
    for (const c of cands) {
      const d = Math.abs(c - t)
      if (d < bestD) {
        best = c
        bestD = d
      }
    }
    return best
  }

  const trackAt = (clientY: number): MontageTrack | null => {
    const el = document.elementsFromPoint(scrollRef.current!.getBoundingClientRect().left + HEAD_W + 4, clientY).find((e) => (e as HTMLElement).dataset?.track)
    return el ? data.tracks.find((t) => t.id === (el as HTMLElement).dataset.track) ?? null : null
  }

  const onClipDown = (e: React.PointerEvent, c: MontageClip) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const role = (e.target as HTMLElement).dataset.role
    if (p.tool === 'blade' && !role?.startsWith('fade')) {
      let t = timeAt(e.clientX)
      if (Math.abs(t - p.posRef.current) * pps < SNAP_PX) t = p.posRef.current
      const parts = splitClip(c, t)
      if (parts) p.change({ ...data, clips: data.clips.flatMap((x) => (x.id === c.id ? parts : [x])) })
      return
    }
    let ids = p.selected
    if (e.shiftKey || e.ctrlKey) ids = ids.includes(c.id) ? ids.filter((i) => i !== c.id) : [...ids, c.id]
    else if (!ids.includes(c.id)) ids = [c.id]
    p.onSelect(ids)
    const kind = (role || 'move') as 'move' | 'trim-l' | 'trim-r' | 'fade-in' | 'fade-out'
    drag.current = { kind, x0: e.clientX, orig: data, ids: kind === 'move' ? ids : [c.id], gesture: uid(), main: c.id }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'scrub') return p.seek(timeAt(e.clientX))
    const dt = (e.clientX - d.x0) / pps
    if (Math.abs(e.clientX - d.x0) < 2 && d.kind === 'move') return
    const o = d.orig.clips.find((c) => c.id === d.main)!
    const m = p.media.get(o.media)
    let clips = d.orig.clips
    if (d.kind === 'move') {
      // o clipe pego decide o ímã (pela borda mais perto)
      let ns = o.start + dt
      const s1 = snap(ns, d.ids)
      const s2 = snap(ns + clipDur(o), d.ids) - clipDur(o)
      ns = Math.abs(s1 - ns) <= Math.abs(s2 - ns) ? s1 : s2
      const shift = Math.max(-Math.min(...d.ids.map((id) => d.orig.clips.find((c) => c.id === id)!.start)), ns - o.start)
      const tr = d.ids.length === 1 ? trackAt(e.clientY) : null
      const okTrack = tr && tr.kind === d.orig.tracks.find((t) => t.id === o.track)?.kind ? tr.id : null
      clips = clips.map((c) => (d.ids.includes(c.id) ? { ...c, start: c.start + shift, track: okTrack ?? c.track } : c))
    } else if (d.kind === 'trim-l') {
      let nin = Math.min(o.out - MIN_DUR, Math.max(0, o.in + dt))
      const st = snap(o.start + (nin - o.in), [o.id])
      nin = Math.min(o.out - MIN_DUR, Math.max(0, o.in + (st - o.start)))
      clips = clips.map((c) => (c.id === o.id ? { ...c, in: nin, start: o.start + (nin - o.in) } : c))
    } else if (d.kind === 'trim-r') {
      let nout = Math.max(o.in + MIN_DUR, Math.min(mediaLen(m), o.out + dt))
      const en = snap(o.start + (nout - o.in), [o.id])
      nout = Math.max(o.in + MIN_DUR, Math.min(mediaLen(m), en - o.start + o.in))
      clips = clips.map((c) => (c.id === o.id ? { ...c, out: nout } : c))
    } else {
      const key = d.kind === 'fade-in' ? 'fadeIn' : 'fadeOut'
      const base = o[key] ?? 0
      const v = Math.max(0, Math.min(clipDur(o) / 2, base + (d.kind === 'fade-in' ? dt : -dt)))
      clips = clips.map((c) => (c.id === o.id ? { ...c, [key]: v < 0.01 ? 0 : v } : c))
    }
    d.last = { ...d.orig, clips }
    p.change(d.last, d.gesture)
  }

  const onUp = () => {
    const d = drag.current
    drag.current = null
    // terminou de mover/aparar: o que ficou por baixo é cortado (mesmo passo do desfazer)
    const cur = d?.last
    if (d && cur && (d.kind === 'move' || d.kind === 'trim-l' || d.kind === 'trim-r')) {
      const clips = overwrite(cur.clips, d.ids)
      if (clips.length !== cur.clips.length || clips.some((c, i) => c !== cur.clips[i])) p.change({ ...cur, clips }, d.gesture)
    }
  }

  // ---------- soltar mídia do painel ----------
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(MEDIA_MIME)
    const m = id && p.media.get(id)
    if (!m) return
    e.preventDefault()
    const want = m.kind === 'audio' ? 'audio' : 'video'
    const over = trackAt(e.clientY)
    const track = over?.kind === want ? over : data.tracks.find((t) => t.kind === want)
    if (!track) return
    const start = snap(timeAt(e.clientX), [])
    const clip: MontageClip = { id: uid(), track: track.id, media: m.id, start, in: 0, out: m.kind === 'image' ? 5 : m.duration }
    p.change({ ...data, clips: [...data.clips, clip] })
    p.onSelect([clip.id])
  }

  const step = rulerStep(pps)
  const ticks: number[] = []
  for (let t = 0; t <= end; t += step) ticks.push(t)

  const setTrack = (id: string, patch: Partial<MontageTrack>) => p.change({ ...data, tracks: data.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })
  const addTrack = (kind: 'video' | 'audio') => {
    const n = data.tracks.filter((t) => t.kind === kind).length + 1
    const id = (kind === 'video' ? 'V' : 'A') + n + '-' + uid().slice(0, 4)
    const t: MontageTrack = { id, kind, name: `${kind === 'video' ? 'V' : 'A'}${n}` }
    // vídeo novo entra em cima dos outros vídeos; áudio novo no fim
    p.change({ ...data, tracks: kind === 'video' ? [t, ...data.tracks] : [...data.tracks, t] })
  }

  return (
    <div
      className="mt-scroll"
      ref={scrollRef}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MEDIA_MIME)) e.preventDefault()
      }}
      onDrop={onDrop}
    >
      <div className="mt-inner" style={{ width: width + HEAD_W }}>
        <div
          className="mt-ruler"
          onPointerDown={(e) => {
            drag.current = { kind: 'scrub', x0: e.clientX, orig: data, ids: [], gesture: '', main: '' }
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
            p.seek(timeAt(e.clientX))
          }}
          onPointerMove={onMove}
          onPointerUp={onUp}
        >
          <div className="mt-corner" />
          {ticks.map((t) => (
            <span key={t} className="mt-tick" style={{ left: HEAD_W + t * pps }}>
              {formatTime(t)}
            </span>
          ))}
        </div>
        {data.tracks.map((tr) => (
          <div key={tr.id} className={'mt-track k-' + tr.kind + (tr.muted ? ' muted' : '')}>
            <div className="mt-head">
              <span>{tr.name}</span>
              {tr.kind === 'audio' && (
                <button
                  className={'mt-arm' + (p.armed === tr.id ? ' on' : '')}
                  title={p.armed === tr.id ? 'Faixa armada: a gravação (R) entra aqui' : 'Armar esta faixa pra gravar o microfone'}
                  onClick={() => p.onArm(tr.id)}
                />
              )}
              <button className="icon-btn" title={tr.muted ? 'Ligar faixa' : 'Silenciar/esconder faixa'} onClick={() => setTrack(tr.id, { muted: !tr.muted })}>
                {tr.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </button>
            </div>
            <div
              className="mt-lane"
              data-track={tr.id}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                p.onSelect([])
                p.seek(timeAt(e.clientX))
              }}
            >
              {data.clips
                .filter((c) => c.track === tr.id)
                .map((c) => (
                  <ClipView
                    key={c.id}
                    c={c}
                    m={p.media.get(c.media)}
                    pps={pps}
                    sel={p.selected.includes(c.id)}
                    blade={p.tool === 'blade'}
                    engine={p.engine}
                    wavesVersion={p.wavesVersion}
                    onDown={onClipDown}
                    onMenu={p.onClipMenu}
                  />
                ))}
              {data.clips
                // só onde os cortes estão colados (com vão entre eles a Emenda não age, então não aparece)
                .filter((c) => c.track === tr.id && c.splice && data.clips.some((x) => x.id !== c.id && x.track === tr.id && Math.abs(clipEndT(x) - c.start) < 0.002))
                .map((c) => {
                  const w = Math.max(14, c.splice! * pps)
                  return (
                    <svg
                      key={'x' + c.id}
                      className="mt-xfade"
                      style={{ left: c.start * pps - w / 2, width: w }}
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                    >
                      <title>{`Emenda: crossfade de ${Math.round(c.splice! * 1000)} ms`}</title>
                      <line x1="0" y1="10" x2="100" y2="90" vectorEffect="non-scaling-stroke" />
                      <line x1="0" y1="90" x2="100" y2="10" vectorEffect="non-scaling-stroke" />
                    </svg>
                  )
                })}
              {p.recording?.track === tr.id && (
                <div className="mt-clip rec" ref={p.recClipRef} style={{ left: p.recording.start * pps, width: 2 }}>
                  <span className="mt-clip-name">● gravando…</span>
                </div>
              )}
            </div>
          </div>
        ))}
        <div className="mt-add-track">
          <button className="btn small" onClick={() => addTrack('video')}>
            <Plus size={12} /> Vídeo
          </button>
          <button className="btn small" onClick={() => addTrack('audio')}>
            <Plus size={12} /> Áudio
          </button>
        </div>
        <div className="mt-playhead" ref={p.playheadRef} style={{ left: HEAD_W }} />
      </div>
    </div>
  )
}

const ClipView = memo(function ClipView({
  c,
  m,
  pps,
  sel,
  blade,
  engine,
  wavesVersion,
  onDown,
  onMenu
}: {
  c: MontageClip
  m?: MontageMedia
  pps: number
  sel: boolean
  blade: boolean
  engine: MontageEngine
  wavesVersion: number
  onDown: (e: React.PointerEvent, c: MontageClip) => void
  onMenu: (e: React.MouseEvent, c: MontageClip) => void
}) {
  const w = Math.max(2, clipDur(c) * pps)
  const kind = m?.kind ?? 'audio'
  return (
    <div
      className={'mt-clip k-' + kind + (sel ? ' sel' : '') + (blade ? ' blade' : '') + (!m ? ' missing' : '')}
      style={{ left: c.start * pps, width: w }}
      onPointerDown={(e) => onDown(e, c)}
      onContextMenu={(e) => onMenu(e, c)}
      title={`${m?.name ?? 'mídia sumiu'}\n${formatTime(c.start)} → ${formatTime(clipEndT(c))} (${clipDur(c).toFixed(2)}s)`}
    >
      {m?.hasAudio && <Wave c={c} engine={engine} width={w} version={wavesVersion} />}
      <span className="mt-clip-name">{m?.name ?? '?'}</span>
      {!!c.fadeIn && (
        <svg className="mt-fade in" style={{ width: c.fadeIn * pps }} viewBox="0 0 100 100" preserveAspectRatio="none">
          <polygon points="0,0 100,0 0,100" />
          <line x1="0" y1="100" x2="100" y2="0" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {!!c.fadeOut && (
        <svg className="mt-fade out" style={{ width: c.fadeOut * pps }} viewBox="0 0 100 100" preserveAspectRatio="none">
          <polygon points="0,0 100,0 100,100" />
          <line x1="0" y1="0" x2="100" y2="100" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      <div className="mt-knob in" data-role="fade-in" style={{ left: (c.fadeIn ?? 0) * pps }} title="Fade de entrada" />
      <div className="mt-knob out" data-role="fade-out" style={{ right: (c.fadeOut ?? 0) * pps }} title="Fade de saída" />
      <div className="mt-trim l" data-role="trim-l" />
      <div className="mt-trim r" data-role="trim-r" />
    </div>
  )
})

/** forma de onda do trecho in→out (canvas limitado; o CSS estica se o clipe for enorme) */
function Wave({ c, engine, width, version }: { c: MontageClip; engine: MontageEngine; width: number; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const cv = ref.current
    const loaded = engine.get(c.media)
    if (!cv || !loaded) return
    const W = Math.min(4000, Math.ceil(width))
    const H = 40
    cv.width = W
    cv.height = H
    const g = cv.getContext('2d')!
    g.clearRect(0, 0, W, H)
    g.fillStyle = 'rgba(255,255,255,0.55)'
    const a = c.in * PEAKS_PER_SEC
    const per = ((c.out - c.in) * PEAKS_PER_SEC) / W
    for (let x = 0; x < W; x++) {
      let v = 0
      const i0 = Math.floor(a + x * per)
      const i1 = Math.max(i0 + 1, Math.floor(a + (x + 1) * per))
      for (let i = i0; i < i1 && i < loaded.peaks.length; i++) v = Math.max(v, loaded.peaks[i])
      const h = Math.max(1, v * H)
      g.fillRect(x, (H - h) / 2, 1, h)
    }
  }, [c.in, c.out, c.media, width, version, engine])
  return <canvas className="mt-wave" ref={ref} />
}
