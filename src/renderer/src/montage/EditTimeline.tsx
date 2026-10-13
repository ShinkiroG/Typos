import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Volume2, VolumeX, Plus } from 'lucide-react'
import { clipDur, clipEndT, formatTime, uid, type MontageClip, type MontageData, type MontageMarker, type MontageMedia, type MontageTrack } from '../lib'
import { PEAKS_PER_SEC, butted, fadeInGain, fadeOutGain, xfadeHalf, type MontageEngine } from './engine'
import { BlockLayer } from './BlockLayer'

export const MEDIA_MIME = 'application/x-typos-media'
/** arquivo de uma pasta do PC vinculada (entra no projeto ao soltar) */
export const PCFILE_MIME = 'application/x-typos-pcfile'
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
  /** botão direito numa junção de dois cortes (id do corte da direita) */
  onJoinMenu: (e: React.MouseEvent, rightId: string) => void
  /** soltou um arquivo do PC: o Montage importa e põe o corte */
  onDropFile: (path: string, trackKind: 'video' | 'audio', trackId: string | null, start: number) => void
  /** botão direito numa marcação de lettering */
  onMarkerMenu: (e: React.MouseEvent, m: MontageMarker) => void
  /** menu de contexto da faixa: criar bloco de instrução / lettering naquele ponto */
  onAddBlockAt: (track: string, t: number) => void
  onAddLetteringAt: (t: number) => void
  /** blocos de instrução (nas faixas de vídeo) */
  blockSel: string | null
  onBlockSel: (id: string | null) => void
  onBlockOpen: (id: string) => void
  onBlockMenu: (e: React.MouseEvent, id: string) => void
  /** bloco gerando prévia agora */
  blockBusy: string | null
}

export const HEAD_W = 132

/** régua: com marcas a cada fração de segundo, mostra os décimos (senão repete "0:04, 0:04") */
const tickLabel = (t: number, step: number) => {
  if (step >= 1) return formatTime(t)
  const m = Math.floor(t / 60)
  const sec = t - m * 60
  const dec = step >= 0.1 && Math.abs(step * 10 - Math.round(step * 10)) < 1e-9 ? 1 : 2
  return `${m}:${sec.toFixed(dec).padStart(dec + 3, '0')}`
}

const SNAP_PX = 8
const MIN_DUR = 0.04
/** o ímã mexeu no valor (com folga de arredondamento) */
const off = (a: number, b: number) => Math.abs(a - b) > 1e-6
const RULER_H = 24
/** altura padrão das faixas (px) e limites do redimensionar */
export const trackHeight = (t: MontageTrack) => t.height ?? (t.kind === 'video' ? 64 : 58)
export const TRACK_MIN_H = 30
export const TRACK_MAX_H = 260
/** clicar com o botão direito até esta distância (px) da borda colada abre o menu da junção */
const JOIN_HIT_PX = 10

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
    { ...c, out: cut, fadeOut: 0, fadeOutCurve: undefined },
    { ...c, id: uid(), start: t, in: cut, fadeIn: 0, fadeInCurve: undefined, splice: undefined }
  ]
}

function rulerStep(pps: number) {
  for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) if (s * pps >= 70) return s
  return 1200
}

export function EditTimeline(p: Props) {
  const { data, pps, scrollRef } = p
  // tamanho da área visível: a timeline sempre preenche a largura toda (sem "fim" no meio da tela)
  // e as metades de vídeo e áudio dividem a altura
  const [view, setView] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollRef])
  const end = Math.max(30, Math.max(0, ...data.clips.map(clipEndT), ...(data.blocks ?? []).map((b) => b.end)) + 20, (view.w - HEAD_W) / pps)
  const width = end * pps
  const mediaDur = (id: string) => mediaLen(p.media.get(id))

  // ---------- seleção por caixa (arrastar no vazio) ----------
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const startMarquee = (e: React.PointerEvent) => {
    const x0 = e.clientX
    const y0 = e.clientY
    const add = e.shiftKey || e.ctrlKey || e.metaKey
    const base = add ? p.selected : []
    let moved = false
    const hits = (x1: number, y1: number) => {
      const l = Math.min(x0, x1)
      const r = Math.max(x0, x1)
      const t = Math.min(y0, y1)
      const b = Math.max(y0, y1)
      const ids: string[] = []
      scrollRef.current?.querySelectorAll<HTMLElement>('.mt-clip[data-clip]').forEach((el) => {
        const c = el.getBoundingClientRect()
        if (c.right > l && c.left < r && c.bottom > t && c.top < b) ids.push(el.dataset.clip!)
      })
      return ids
    }
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
      moved = true
      setBox({ x0, y0, x1: ev.clientX, y1: ev.clientY })
      p.onSelect([...new Set([...base, ...hits(ev.clientX, ev.clientY)])])
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setBox(null)
      // clique simples no vazio: tira a seleção e leva o cursor pra lá
      if (!moved) {
        if (!add) p.onSelect([])
        p.seek(timeAt(ev.clientX))
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---------- arrastos ----------
  const drag = useRef<{
    kind: 'move' | 'trim-l' | 'trim-r' | 'fade-in' | 'fade-out' | 'curve-in' | 'curve-out' | 'xf-l' | 'xf-r' | 'scrub'
    x0: number
    /** retângulo do clipe no começo do arrasto (curva do fade) */
    rect?: DOMRect
    orig: MontageData
    ids: string[]
    gesture: string
    main: string
    /** último estado do arrasto (o React pode não ter redesenhado ainda quando solta) */
    last?: MontageData
    /** Shift+clique num corte já selecionado: tira da seleção se soltar sem arrastar */
    toggleOff?: string
  } | null>(null)

  /** arrastar a agulha: nunca passa pra trás dos nomes das faixas (encosta e rola a timeline) */
  const scrubTo = (clientX: number, shift: boolean) => {
    const el = scrollRef.current!
    const r = el.getBoundingClientRect()
    const left = r.left + HEAD_W
    if (clientX < left && el.scrollLeft > 0) el.scrollLeft = Math.max(0, el.scrollLeft - Math.max(4, (left - clientX) * 0.6))
    else if (clientX > r.right - 12) el.scrollLeft += Math.max(4, (clientX - r.right + 12) * 0.6)
    const x = Math.max(left, Math.min(r.right - 1, clientX))
    let t = Math.max(0, (x - left + el.scrollLeft) / pps)
    const s = snap(t, [], shift, false)
    showSnap(off(s, t) ? s : null)
    t = s
    p.seek(t)
  }

  const timeAt = (clientX: number) => {
    const el = scrollRef.current!
    const r = el.getBoundingClientRect()
    return Math.max(0, (clientX - r.left - HEAD_W + el.scrollLeft) / pps)
  }

  /**
   * ímã (só com Shift segurado): começo/fim de cortes, blocos e letterings, playhead e zero.
   * Mostra a linha do encaixe enquanto está grudado.
   */
  const snapLineRef = useRef<HTMLDivElement>(null)
  const showSnap = (t: number | null) => {
    const el = snapLineRef.current
    if (!el) return
    el.style.display = t === null ? 'none' : ''
    if (t !== null) el.style.left = `${HEAD_W + t * pps}px`
  }
  const snap = (t: number, skip: string[], on = true, playhead = true) => {
    if (!on) return t
    const cands = [0]
    if (playhead) cands.push(p.posRef.current)
    for (const c of data.clips) if (!skip.includes(c.id)) cands.push(c.start, clipEndT(c))
    for (const b of data.blocks ?? []) if (!skip.includes(b.id)) cands.push(b.start, b.end)
    for (const m of data.markers ?? []) if (!skip.includes(m.id)) cands.push(m.t, m.t + m.dur)
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
    if (p.tool === 'blade' && !role?.startsWith('fade') && !role?.startsWith('curve')) {
      let t = timeAt(e.clientX)
      if (Math.abs(t - p.posRef.current) * pps < SNAP_PX) t = p.posRef.current
      const parts = splitClip(c, t)
      if (parts) p.change({ ...data, clips: data.clips.flatMap((x) => (x.id === c.id ? parts : [x])) })
      return
    }
    let ids = p.selected
    // Shift também é o ímã: num corte já selecionado ele só sai da seleção se for clique sem arrastar
    let toggleOff: string | undefined
    if (e.ctrlKey || e.metaKey) ids = ids.includes(c.id) ? ids.filter((i) => i !== c.id) : [...ids, c.id]
    else if (e.shiftKey) {
      if (ids.includes(c.id)) toggleOff = c.id
      else ids = [...ids, c.id]
    } else if (!ids.includes(c.id)) ids = [c.id]
    p.onSelect(ids)
    const kind = (role || 'move') as 'move' | 'trim-l' | 'trim-r' | 'fade-in' | 'fade-out' | 'curve-in' | 'curve-out'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    drag.current = { kind, x0: e.clientX, orig: data, ids: kind === 'move' ? ids : [c.id], gesture: uid(), main: c.id, rect, toggleOff }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  /** duplo clique na alça da curva: o fade volta a ser linear */
  const onClipDouble = (e: React.MouseEvent, c: MontageClip) => {
    const role = (e.target as HTMLElement).dataset.role
    if (role !== 'curve-in' && role !== 'curve-out') return
    e.stopPropagation()
    p.change({ ...data, clips: data.clips.map((x) => (x.id === c.id ? { ...x, [role === 'curve-in' ? 'fadeInCurve' : 'fadeOutCurve']: undefined } : x)) })
  }

  /** arrastar a borda do X: muda a duração do crossfade (o corte fica no meio) */
  const onXfadeDown = (e: React.PointerEvent, c: MontageClip) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const role = (e.target as HTMLElement).dataset.role
    if (role !== 'xf-l' && role !== 'xf-r') return
    drag.current = { kind: role, x0: e.clientX, orig: data, ids: [c.id], gesture: uid(), main: c.id }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  /** botão direito perto da borda colada de um corte = menu da junção (crossfade) */
  const onClipContext = (e: React.MouseEvent, c: MontageClip) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const same = data.clips.filter((x) => x.track === c.track && x.id !== c.id)
    if (e.clientX - r.left <= JOIN_HIT_PX && same.some((x) => butted(x, c))) return p.onJoinMenu(e, c.id)
    const next = same.find((x) => butted(c, x))
    if (r.right - e.clientX <= JOIN_HIT_PX && next) return p.onJoinMenu(e, next.id)
    p.onClipMenu(e, c)
  }

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'scrub') return scrubTo(e.clientX, e.shiftKey)
    const dt = (e.clientX - d.x0) / pps
    if (Math.abs(e.clientX - d.x0) < 2 && d.kind === 'move' && !d.last) return
    const sh = e.shiftKey
    let hit: number | null = null
    const o = d.orig.clips.find((c) => c.id === d.main)!
    const m = p.media.get(o.media)
    let clips = d.orig.clips
    if (d.kind === 'move') {
      // o clipe pego decide o ímã (pela borda mais perto)
      let ns = o.start + dt
      const s1 = snap(ns, d.ids, sh)
      const s2 = snap(ns + clipDur(o), d.ids, sh) - clipDur(o)
      const first = Math.abs(s1 - ns) <= Math.abs(s2 - ns)
      if (first ? off(s1, ns) : off(s2, ns)) hit = first ? s1 : s2 + clipDur(o)
      ns = first ? s1 : s2
      const shift = Math.max(-Math.min(...d.ids.map((id) => d.orig.clips.find((c) => c.id === id)!.start)), ns - o.start)
      const tr = d.ids.length === 1 ? trackAt(e.clientY) : null
      const okTrack = tr && tr.kind === d.orig.tracks.find((t) => t.id === o.track)?.kind ? tr.id : null
      clips = clips.map((c) => (d.ids.includes(c.id) ? { ...c, start: c.start + shift, track: okTrack ?? c.track } : c))
    } else if (d.kind === 'trim-l') {
      let nin = Math.min(o.out - MIN_DUR, Math.max(0, o.in + dt))
      const raw = o.start + (nin - o.in)
      const st = snap(raw, [o.id], sh)
      if (off(st, raw)) hit = st
      nin = Math.min(o.out - MIN_DUR, Math.max(0, o.in + (st - o.start)))
      clips = clips.map((c) => (c.id === o.id ? { ...c, in: nin, start: o.start + (nin - o.in) } : c))
    } else if (d.kind === 'trim-r') {
      let nout = Math.max(o.in + MIN_DUR, Math.min(mediaLen(m), o.out + dt))
      const raw = o.start + (nout - o.in)
      const en = snap(raw, [o.id], sh)
      if (off(en, raw)) hit = en
      nout = Math.max(o.in + MIN_DUR, Math.min(mediaLen(m), en - o.start + o.in))
      clips = clips.map((c) => (c.id === o.id ? { ...c, out: nout } : c))
    } else if (d.kind === 'curve-in' || d.kind === 'curve-out') {
      // ponto de controle da curva, livre dentro da área do fade (tipo pen tool)
      const r = d.rect!
      const fin = d.kind === 'curve-in'
      const len = (fin ? o.fadeIn : o.fadeOut) ?? 0
      if (!len) return
      const left = fin ? r.left : r.right - len * pps
      const cx = Math.max(0, Math.min(1, (e.clientX - left) / (len * pps)))
      const cy = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height))
      const key = fin ? 'fadeInCurve' : 'fadeOutCurve'
      clips = clips.map((c) => (c.id === o.id ? { ...c, [key]: [Math.round(cx * 100) / 100, Math.round(cy * 100) / 100] } : c))
    } else if (d.kind === 'xf-l' || d.kind === 'xf-r') {
      const base = o.splice ?? 0
      const v = Math.max(0.002, Math.min(10, base + 2 * (d.kind === 'xf-r' ? dt : -dt)))
      clips = clips.map((c) => (c.id === o.id ? { ...c, splice: Math.round(v * 1000) / 1000 } : c))
    } else {
      const key = d.kind === 'fade-in' ? 'fadeIn' : 'fadeOut'
      const base = o[key] ?? 0
      const v = Math.max(0, Math.min(clipDur(o) / 2, base + (d.kind === 'fade-in' ? dt : -dt)))
      clips = clips.map((c) => (c.id === o.id ? { ...c, [key]: v < 0.01 ? 0 : v } : c))
    }
    showSnap(hit)
    d.last = { ...d.orig, clips }
    p.change(d.last, d.gesture)
  }

  const onUp = () => {
    const d = drag.current
    drag.current = null
    showSnap(null)
    if (d?.toggleOff && !d.last) p.onSelect(p.selected.filter((i) => i !== d.toggleOff))
    // terminou de mover/aparar: o que ficou por baixo é cortado (mesmo passo do desfazer)
    const cur = d?.last
    if (d && cur && (d.kind === 'move' || d.kind === 'trim-l' || d.kind === 'trim-r')) {
      const clips = overwrite(cur.clips, d.ids)
      if (clips.length !== cur.clips.length || clips.some((c, i) => c !== cur.clips[i])) p.change({ ...cur, clips }, d.gesture)
    }
  }

  // ---------- soltar mídia do painel ----------
  const onDrop = (e: React.DragEvent) => {
    const pc = e.dataTransfer.getData(PCFILE_MIME)
    if (pc) {
      e.preventDefault()
      const kind = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(pc) ? 'audio' : 'video'
      const over = trackAt(e.clientY)
      p.onDropFile(pc, kind, over?.kind === kind ? over.id : null, snap(timeAt(e.clientX), [], e.shiftKey))
      return
    }
    const id = e.dataTransfer.getData(MEDIA_MIME)
    const m = id && p.media.get(id)
    if (!m) return
    e.preventDefault()
    const want = m.kind === 'audio' ? 'audio' : 'video'
    const over = trackAt(e.clientY)
    const track = over?.kind === want ? over : data.tracks.find((t) => t.kind === want)
    if (!track) return
    const start = snap(timeAt(e.clientX), [], e.shiftKey)
    const clip: MontageClip = { id: uid(), track: track.id, media: m.id, start, in: 0, out: m.kind === 'image' ? 5 : m.duration }
    p.change({ ...data, clips: [...data.clips, clip] })
    p.onSelect([clip.id])
  }

  const step = rulerStep(pps)
  const ticks: number[] = []
  for (let t = 0; t <= end; t += step) ticks.push(t)

  const setTrack = (id: string, patch: Partial<MontageTrack>, gesture?: string) =>
    p.change({ ...data, tracks: data.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }, gesture)

  /** arrastar a borda de baixo do nome da faixa: muda a altura dela */
  const startResize = (e: React.PointerEvent, tr: MontageTrack) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const y0 = e.clientY
    const h0 = trackHeight(tr)
    const gesture = uid()
    // faixas de vídeo crescem pra cima (ficam em cima da divisória), as de áudio pra baixo
    const sign = tr.kind === 'video' ? -1 : 1
    const base = data
    const move = (ev: PointerEvent) => {
      const h = Math.round(Math.max(TRACK_MIN_H, Math.min(TRACK_MAX_H, h0 + sign * (ev.clientY - y0))))
      p.change({ ...base, tracks: base.tracks.map((t) => (t.id === tr.id ? { ...t, height: h } : t)) }, gesture)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  const addTrack = (kind: 'video' | 'audio') => {
    const n = data.tracks.filter((t) => t.kind === kind).length + 1
    const id = (kind === 'video' ? 'V' : 'A') + n + '-' + uid().slice(0, 4)
    const t: MontageTrack = { id, kind, name: `${kind === 'video' ? 'V' : 'A'}${n}` }
    // vídeo novo entra em cima dos outros vídeos; áudio novo no fim
    p.change({ ...data, tracks: kind === 'video' ? [t, ...data.tracks] : [...data.tracks, t] })
  }
  /** apaga a faixa com o que estiver nela (cortes e blocos); a última de cada tipo fica */
  const removeTrack = (tr: MontageTrack) => {
    const clips = data.clips.filter((c) => c.track === tr.id).length
    const blocks = (data.blocks ?? []).filter((b) => b.track === tr.id).length
    const what = [clips && `${clips} corte(s)`, blocks && `${blocks} bloco(s) de instrução`].filter(Boolean).join(' e ')
    if (what && !confirm(`Apagar a faixa "${tr.name}" com ${what}? (Ctrl+Z desfaz)`)) return
    p.change({
      ...data,
      tracks: data.tracks.filter((t) => t.id !== tr.id),
      clips: data.clips.filter((c) => c.track !== tr.id),
      blocks: (data.blocks ?? []).filter((b) => b.track !== tr.id)
    })
    p.onSelect(p.selected.filter((id) => data.clips.find((c) => c.id === id)?.track !== tr.id))
  }

  // ---------- menu de contexto (botão direito numa faixa ou no vazio) ----------
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'video' | 'audio'; track: MontageTrack | null; t: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])
  const openMenu = (e: React.MouseEvent, kind: 'video' | 'audio', track: MontageTrack | null) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, kind, track, t: timeAt(e.clientX) })
  }
  const DIVIDER_H = 6

  return (
    <div
      className="mt-scroll"
      ref={scrollRef}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MEDIA_MIME) || e.dataTransfer.types.includes(PCFILE_MIME)) e.preventDefault()
      }}
      onDrop={onDrop}
    >
      <div className="mt-inner" style={{ width: width + HEAD_W }}>
        <div
          className="mt-ruler"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            drag.current = { kind: 'scrub', x0: e.clientX, orig: data, ids: [], gesture: '', main: '' }
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
            scrubTo(e.clientX, e.shiftKey)
          }}
          onPointerMove={onMove}
          onPointerUp={onUp}
        >
          <div className="mt-corner" />
          {ticks.map((t) => (
            <span key={t} className="mt-tick" style={{ left: HEAD_W + t * pps }}>
              {tickLabel(t, step)}
            </span>
          ))}
        </div>
        {/* ---------- letterings dos capítulos: onde entram e quanto tempo ficam ---------- */}
        {!!data.markers?.length && (
          <div className="mt-track mt-marks">
            <div className="mt-head">
              <span>Lettering</span>
            </div>
            <div
              className="mt-lane"
              onPointerDown={(e) => {
                if (e.button === 0) p.seek(timeAt(e.clientX))
              }}
            >
              {data.markers.map((mk) => (
                <div
                  key={mk.id}
                  className="mt-mark"
                  data-marker={mk.id}
                  style={{ left: mk.t * pps, width: Math.max(6, mk.dur * pps) }}
                  title={`Lettering · ${mk.label}\n${formatTime(mk.t)} → ${formatTime(mk.t + mk.dur)} (${mk.dur.toFixed(1)} s)\nArraste pra mover; puxe a borda direita pra mudar o tempo; botão direito: opções`}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    p.onMarkerMenu(e, mk)
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    e.stopPropagation()
                    const resize = (e.target as HTMLElement).classList.contains('mt-mark-r')
                    const x0 = e.clientX
                    const orig = data
                    const gesture = 'mark-' + mk.id + '-' + Date.now()
                    const el = e.currentTarget
                    el.setPointerCapture(e.pointerId)
                    const move = (ev: PointerEvent) => {
                      const dt = (ev.clientX - x0) / pps
                      const sh = ev.shiftKey
                      let hit: number | null = null
                      let nt = Math.max(0, mk.t + dt)
                      let nd = Math.max(0.5, Math.round((mk.dur + dt) * 10) / 10)
                      if (resize) {
                        const en = snap(mk.t + mk.dur + dt, [mk.id], sh)
                        if (off(en, mk.t + mk.dur + dt)) {
                          hit = en
                          nd = Math.max(0.5, en - mk.t)
                        }
                      } else {
                        const a = snap(nt, [mk.id], sh)
                        const z = snap(nt + mk.dur, [mk.id], sh) - mk.dur
                        const first = Math.abs(a - nt) <= Math.abs(z - nt)
                        if (first ? off(a, nt) : off(z, nt)) hit = first ? a : z + mk.dur
                        nt = Math.max(0, first ? a : z)
                      }
                      showSnap(hit)
                      const markers = (orig.markers ?? []).map((x) => (x.id !== mk.id ? x : resize ? { ...x, dur: nd } : { ...x, t: nt }))
                      p.change({ ...orig, markers }, gesture)
                    }
                    const up = () => {
                      showSnap(null)
                      el.removeEventListener('pointermove', move)
                      el.removeEventListener('pointerup', up)
                    }
                    el.addEventListener('pointermove', move)
                    el.addEventListener('pointerup', up)
                  }}
                >
                  <span className="mt-mark-name">
                    {mk.label} · {mk.dur.toFixed(1)} s
                  </span>
                  <i className="mt-mark-r" />
                </div>
              ))}
            </div>
          </div>
        )}
        {(['video', 'audio'] as const).map((kind) => (
          <div
            key={kind}
            className={'mt-section k-' + kind}
            // cada metade ocupa pelo menos metade da altura; o vídeo encosta na divisória por cima
            style={{ minHeight: Math.max(0, (view.h - RULER_H - DIVIDER_H) / 2) }}
            onContextMenu={(e) => openMenu(e, kind, null)}
          >
            {kind === 'audio' && <div className="mt-divider" style={{ height: DIVIDER_H }} />}
            {kind === 'video' && <AddHint kind="video" onMenu={(e) => openMenu(e, 'video', null)} />}
            {data.tracks
              .filter((tr) => tr.kind === kind)
              .map((tr) => (
                <div key={tr.id} className={'mt-track k-' + tr.kind + (tr.muted ? ' muted' : '')} style={{ height: trackHeight(tr) }}>
                  <div className="mt-head" onContextMenu={(e) => openMenu(e, tr.kind, tr)} title="Botão direito: opções da faixa">
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
                    <div
                      className={'mt-resize ' + (tr.kind === 'video' ? 'top' : 'bottom')}
                      title="Arraste pra mudar a altura da faixa (duplo clique volta ao padrão)"
                      onPointerDown={(e) => startResize(e, tr)}
                      onDoubleClick={() => setTrack(tr.id, { height: undefined })}
                    />
                  </div>
                  <div
                    className="mt-lane"
                    data-track={tr.id}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return
                      startMarquee(e)
                    }}
                    onContextMenu={(e) => openMenu(e, tr.kind, tr)}
                  >
                    {data.clips
                      .filter((c) => c.track === tr.id)
                      .map((c) => (
                        <ClipView
                          key={c.id}
                          c={c}
                          m={p.media.get(c.media)}
                          pps={pps}
                          height={trackHeight(tr) - 8}
                          sel={p.selected.includes(c.id)}
                          blade={p.tool === 'blade'}
                          engine={p.engine}
                          wavesVersion={p.wavesVersion}
                          onDown={onClipDown}
                          onDouble={onClipDouble}
                          onMenu={onClipContext}
                        />
                      ))}
                    {data.clips
                      .filter((c) => c.track === tr.id && c.splice)
                      .map((c) => {
                        // só onde os cortes estão colados (com vão entre eles o crossfade não age, então não aparece)
                        const prev = data.clips.find((x) => x.id !== c.id && x.track === tr.id && butted(x, c))
                        if (!prev) return null
                        const half = xfadeHalf(prev, c, mediaDur)
                        const w = 2 * half * pps
                        const short = half * 2 < c.splice! - 0.001
                        return (
                          <div
                            key={'x' + c.id}
                            className={'mt-xfade' + (w < 10 ? ' thin' : '') + (p.selected.includes(c.id) ? ' sel' : '')}
                            style={{ left: c.start * pps - w / 2, width: w }}
                            title={
                              `Crossfade de ${Math.round(half * 2000)} ms` +
                              (short ? ` (pedido ${Math.round(c.splice! * 1000)} ms: não sobra arquivo pra mais)` : '') +
                              '\nArraste as bordas pra mudar · botão direito: opções'
                            }
                            onPointerDown={(e) => onXfadeDown(e, c)}
                            onContextMenu={(e) => p.onJoinMenu(e, c.id)}
                          >
                            {w >= 10 && (
                              <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                                <line x1="0" y1="10" x2="100" y2="90" vectorEffect="non-scaling-stroke" />
                                <line x1="0" y1="90" x2="100" y2="10" vectorEffect="non-scaling-stroke" />
                              </svg>
                            )}
                            <div className="mt-xf-h l" data-role="xf-l" />
                            <div className="mt-xf-h r" data-role="xf-r" />
                          </div>
                        )
                      })}
                    {tr.kind === 'video' && (
                      <BlockLayer
                        data={data}
                        track={tr.id}
                        pps={pps}
                        selected={p.blockSel}
                        onSelect={p.onBlockSel}
                        onOpen={p.onBlockOpen}
                        onMenu={p.onBlockMenu}
                        change={p.change}
                        snap={snap}
                        showSnap={showSnap}
                        trackAt={trackAt}
                        busy={p.blockBusy}
                      />
                    )}
                    {p.recording?.track === tr.id && (
                      <div className="mt-clip rec" ref={p.recClipRef} style={{ left: p.recording.start * pps, width: 2 }}>
                        <span className="mt-clip-name">● gravando…</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            {kind === 'audio' && <AddHint kind="audio" onMenu={(e) => openMenu(e, 'audio', null)} />}
          </div>
        ))}
        {box && (
          <div
            className="mt-marquee"
            style={{
              left: Math.min(box.x0, box.x1),
              top: Math.min(box.y0, box.y1),
              width: Math.abs(box.x1 - box.x0),
              height: Math.abs(box.y1 - box.y0)
            }}
          />
        )}
        {menu && (
          <TrackMenu
            menu={menu}
            canRemove={!!menu.track && data.tracks.filter((t) => t.kind === menu.kind).length > 1}
            armed={!!menu.track && p.armed === menu.track.id}
            close={() => setMenu(null)}
            addTrack={() => addTrack(menu.kind)}
            removeTrack={() => menu.track && removeTrack(menu.track)}
            addBlock={() => {
              const tr = menu.track ?? data.tracks.find((t) => t.kind === 'video')
              if (tr) p.onAddBlockAt(tr.id, menu.t)
            }}
            addLettering={() => p.onAddLetteringAt(menu.t)}
            arm={() => menu.track && p.onArm(menu.track.id)}
          />
        )}
        <div className="mt-snapline" ref={snapLineRef} style={{ display: 'none' }} />
        <div className="mt-playhead" ref={p.playheadRef} style={{ left: HEAD_W }} />
      </div>
    </div>
  )
}

/** no lugar dos botões de criar: lembra que o botão direito cria (e o clique abre o menu) */
function AddHint({ kind, onMenu }: { kind: 'video' | 'audio'; onMenu: (e: React.MouseEvent) => void }) {
  return (
    <div className="mt-add-track">
      <button className="mt-add-hint" title="Clique (ou botão direito em qualquer faixa) pra ver as opções de criação" onClick={onMenu}>
        <Plus size={11} /> {kind === 'video' ? 'botão direito: criar no vídeo' : 'botão direito: criar no áudio'}
      </button>
    </div>
  )
}

function TrackMenu(p: {
  menu: { x: number; y: number; kind: 'video' | 'audio'; track: MontageTrack | null; t: number }
  canRemove: boolean
  armed: boolean
  close: () => void
  addTrack: () => void
  removeTrack: () => void
  addBlock: () => void
  addLettering: () => void
  arm: () => void
}) {
  const { menu } = p
  const act = (fn: () => void) => () => {
    p.close()
    fn()
  }
  const video = menu.kind === 'video'
  return (
    <div
      className="ctx-menu"
      style={{ left: menu.x, top: menu.y }}
      ref={(el) => {
        if (!el) return
        const r = el.getBoundingClientRect()
        if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`
        if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="ctx-label">
        {menu.track ? menu.track.name : video ? 'Vídeo' : 'Áudio'} · {formatTime(menu.t)}
      </div>
      {video ? (
        <>
          <button onClick={act(p.addBlock)}>
            Bloco de instrução aqui <kbd>B</kbd>
          </button>
          <button onClick={act(p.addLettering)}>
            Lettering do capítulo aqui <kbd>L</kbd>
          </button>
        </>
      ) : (
        menu.track && <button onClick={act(p.arm)}>{p.armed ? 'Desarmar a gravação' : 'Gravar nesta faixa (armar)'}</button>
      )}
      <div className="ctx-sep" />
      <button onClick={act(p.addTrack)}>{video ? 'Nova faixa de vídeo' : 'Nova faixa de áudio'}</button>
      {menu.track && (
        <button className="danger" disabled={!p.canRemove} title={p.canRemove ? '' : 'Precisa sobrar pelo menos uma faixa desse tipo'} onClick={act(p.removeTrack)}>
          Apagar a faixa "{menu.track.name}"
        </button>
      )}
    </div>
  )
}

/** caminho do fade (no quadrado 0..100 do svg, y pra baixo) seguindo a curva */
function fadePath(fin: boolean, curve: MontageClip['fadeInCurve']) {
  const n = 24
  const pts: string[] = []
  for (let i = 0; i <= n; i++) {
    const x = i / n
    const g = fin ? fadeInGain(curve, x) : fadeOutGain(curve, x)
    pts.push(`${(x * 100).toFixed(2)},${((1 - g) * 100).toFixed(2)}`)
  }
  return pts
}

const ClipView = memo(function ClipView({
  c,
  m,
  pps,
  height,
  sel,
  blade,
  engine,
  wavesVersion,
  onDown,
  onDouble,
  onMenu
}: {
  c: MontageClip
  m?: MontageMedia
  pps: number
  height: number
  sel: boolean
  blade: boolean
  engine: MontageEngine
  wavesVersion: number
  onDown: (e: React.PointerEvent, c: MontageClip) => void
  onDouble: (e: React.MouseEvent, c: MontageClip) => void
  onMenu: (e: React.MouseEvent, c: MontageClip) => void
}) {
  const w = Math.max(2, clipDur(c) * pps)
  const kind = m?.kind ?? 'audio'
  return (
    <div
      className={'mt-clip k-' + kind + (sel ? ' sel' : '') + (blade ? ' blade' : '') + (!m ? ' missing' : '')}
      style={{ left: c.start * pps, width: w }}
      data-clip={c.id}
      onPointerDown={(e) => onDown(e, c)}
      onDoubleClick={(e) => onDouble(e, c)}
      onContextMenu={(e) => onMenu(e, c)}
      title={`${m?.name ?? 'mídia sumiu'}\n${formatTime(c.start)} → ${formatTime(clipEndT(c))} (${clipDur(c).toFixed(2)}s)`}
    >
      {m?.hasAudio && <Wave c={c} engine={engine} width={w} height={height} version={wavesVersion} />}
      <span className="mt-clip-name">{m?.name ?? '?'}</span>
      {!!c.fadeIn && (
        <svg className="mt-fade in" style={{ width: c.fadeIn * pps }} viewBox="0 0 100 100" preserveAspectRatio="none">
          <polygon points={['0,0', ...fadePath(true, c.fadeInCurve)].join(' ')} />
          <polyline points={fadePath(true, c.fadeInCurve).join(' ')} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {!!c.fadeOut && (
        <svg className="mt-fade out" style={{ width: c.fadeOut * pps }} viewBox="0 0 100 100" preserveAspectRatio="none">
          <polygon points={[...fadePath(false, c.fadeOutCurve), '100,0'].join(' ')} />
          <polyline points={fadePath(false, c.fadeOutCurve).join(' ')} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {!!c.fadeIn && c.fadeIn * pps >= 12 && (
        <div
          className="mt-curve"
          data-role="curve-in"
          style={{ left: (c.fadeInCurve?.[0] ?? 0.5) * c.fadeIn * pps, top: `${(1 - (c.fadeInCurve?.[1] ?? 0.5)) * 100}%` }}
          title="Curva do fade: arraste (duplo clique volta a linear)"
        />
      )}
      {!!c.fadeOut && c.fadeOut * pps >= 12 && (
        <div
          className="mt-curve"
          data-role="curve-out"
          style={{ left: w - c.fadeOut * pps + (c.fadeOutCurve?.[0] ?? 0.5) * c.fadeOut * pps, top: `${(1 - (c.fadeOutCurve?.[1] ?? 0.5)) * 100}%` }}
          title="Curva do fade: arraste (duplo clique volta a linear)"
        />
      )}
      <div className="mt-knob in" data-role="fade-in" style={{ left: (c.fadeIn ?? 0) * pps }} title="Fade de entrada" />
      <div className="mt-knob out" data-role="fade-out" style={{ right: (c.fadeOut ?? 0) * pps }} title="Fade de saída" />
      <div className="mt-trim l" data-role="trim-l" />
      <div className="mt-trim r" data-role="trim-r" />
    </div>
  )
})

/** forma de onda do trecho in→out (canvas limitado; o CSS estica se o clipe for enorme) */
function Wave({ c, engine, width, height, version }: { c: MontageClip; engine: MontageEngine; width: number; height: number; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const cv = ref.current
    const loaded = engine.get(c.media)
    if (!cv || !loaded) return
    const W = Math.min(4000, Math.ceil(width))
    // desenha na altura real (faixa alta = onda mais detalhada, sem esticar borrado)
    const H = Math.max(8, Math.round(height - 16))
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
  }, [c.in, c.out, c.media, width, height, version, engine])
  return <canvas className="mt-wave" ref={ref} />
}
