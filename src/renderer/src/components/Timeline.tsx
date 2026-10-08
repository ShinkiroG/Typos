import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { Play, Pause, SkipBack, Music, Sparkles, Scissors, Trash2, ZoomIn, ZoomOut, Eraser, Loader2, RotateCcw } from 'lucide-react'
import { AudioEngine, PEAKS_PER_SEC } from '../timeline/engine'
import { highlightKey, type HighlightRange } from '../editor/highlight'
import { api, clipEnd, envelopeAt, formatTime, uid, wordAt, TIMED_PAUSES, type Clip, type Timing, type Segment } from '../lib'
import { FILE_MIME } from './FoldersPanel'
import type { Transaction } from '@tiptap/pm/state'

const RULER_H = 22
const TEXT_H = 44
const PAUSE_H = 24
const LANE_H = 58
const SNAP_PX = 8

interface Props {
  editor: Editor | null
  dir: string
  timing: Timing
  clips: Clip[]
  onClipsChange: (clips: Clip[]) => void
  wpm: number
  formatWpm: number
  customWpm: boolean
  onWpmChange: (wpm: number | null) => void
}

type Drag =
  | { mode: 'move' | 'trimL' | 'trimR'; id: string; x0: number; y0: number; clip0: Clip }
  | { mode: 'key'; id: string; index: number; clip0: Clip; rect: DOMRect }
  | { mode: 'scrub'; rect: DOMRect }
  | { mode: 'pauseResize'; pos: number; x0: number; dur0: number }
  | { mode: 'pauseMove'; pos: number; x0: number; seg: Segment; moved: boolean }
  | { mode: 'pauseCreate'; rect: DOMRect; t0: number }

const fmtPrecise = (t: number) => `${formatTime(Math.floor(t))}.${Math.floor((t % 1) * 10)}`

function laneFree(clips: Clip[], lane: number, start: number, end: number, ignore?: string) {
  return !clips.some((c) => c.id !== ignore && c.lane === lane && c.start < end && clipEnd(c) > start)
}

/**
 * Onde um bloco que começa no tempo t entra no texto: antes da primeira palavra falada
 * a partir de t (quebrando o parágrafo se precisar), ou no fim do roteiro.
 */
function insertionPoint(timing: Timing, docSize: number, t: number, skipPos?: number) {
  const w = timing.words.find((x) => x.start >= t - 0.001 && (skipPos === undefined || x.from < skipPos || x.from > skipPos + 1))
  return w ? { pos: w.from, split: true } : { pos: docSize, split: false }
}

/** Coloca um bloco no ponto (quebrando o parágrafo no meio, sem deixar espaço sobrando). */
function placeBlock(tr: Transaction, point: { pos: number; split: boolean }, node: import('@tiptap/pm/model').Node) {
  let pos = point.pos
  if (point.split) {
    const $p = tr.doc.resolve(pos)
    if ($p.parentOffset === 0) return tr.insert($p.before(), node)
    if (tr.doc.textBetween(pos - 1, pos) === ' ') {
      tr.delete(pos - 1, pos)
      pos -= 1
    }
    tr.split(pos)
    return tr.insert(pos + 1, node)
  }
  return tr.insert(pos, node)
}

export function Timeline({ editor, dir, timing, clips, onClipsChange, wpm, formatWpm, customWpm, onWpmChange }: Props) {
  const engine = useMemo(() => new AudioEngine(), [])
  const [pps, setPps] = useState(() => Number(localStorage.getItem('typos.pps')) || 40)
  const [height, setHeight] = useState(() => Number(localStorage.getItem('typos.tlHeight')) || 300)
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [loadedTick, setLoadedTick] = useState(0)
  const [wordIdx, setWordIdx] = useState(-1)
  const [sfxOpen, setSfxOpen] = useState(false)
  const [error, setError] = useState('')
  const [ghost, setGhost] = useState<{ start: number; end: number } | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const drag = useRef<Drag | null>(null)
  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const timingRef = useRef(timing)
  timingRef.current = timing
  const ppsRef = useRef(pps)
  ppsRef.current = pps
  const lastWord = useRef(-1)

  useEffect(() => {
    try {
      localStorage.setItem('typos.pps', String(pps))
      localStorage.setItem('typos.tlHeight', String(height))
    } catch {
      /* sem storage */
    }
  }, [pps, height])

  // carrega os áudios (e desenha as ondas quando chegam)
  useEffect(() => {
    for (const c of clips)
      if (!engine.get(c.path))
        engine
          .load(c)
          .then(() => setLoadedTick((n) => n + 1))
          .catch((e) => setError(String(e.message ?? e)))
  }, [clips, engine])

  useEffect(() => () => engine.dispose(), [engine])

  // mexeu nos clipes durante o play → reagenda
  useEffect(() => {
    engine.restart(clips)
  }, [clips, engine])

  const contentEnd = Math.max(timing.total, ...clips.map(clipEnd), 10)
  const width = (contentEnd + 15) * pps
  const lanes = Math.max(2, ...clips.map((c) => c.lane + 2))

  // ---------- destaque no texto ----------
  const highlight = useCallback(
    (idx: number, scroll: boolean) => {
      if (!editor || editor.isDestroyed) return
      const w = timingRef.current.words[idx]
      let range: HighlightRange = { word: null, spoken: null, block: null }
      if (w) {
        const $p = editor.state.doc.resolve(w.from)
        const blockFrom = $p.before(1)
        range = { word: { from: w.from, to: w.to }, spoken: { from: blockFrom + 1, to: w.from }, block: { from: blockFrom, to: $p.after(1) } }
      }
      editor.view.dispatch(editor.state.tr.setMeta(highlightKey, range).setMeta('addToHistory', false))
      if (w && scroll) {
        const box = document.querySelector('.editor-scroll')
        const c = editor.view.coordsAtPos(w.from)
        if (box) {
          const r = box.getBoundingClientRect()
          if (c.top < r.top + 60 || c.bottom > r.bottom - 80) box.scrollBy({ top: c.top - r.top - r.height * 0.35, behavior: 'smooth' })
        }
      }
    },
    [editor]
  )

  const paint = useCallback(
    (t: number, showWord: boolean, scrollText: boolean) => {
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${t * ppsRef.current}px)`
      if (timeRef.current) timeRef.current.textContent = fmtPrecise(t)
      const idx = showWord ? wordAt(timingRef.current.words, t) : -1
      if (idx !== lastWord.current) {
        lastWord.current = idx
        setWordIdx(idx)
        highlight(idx, scrollText)
      }
    },
    [highlight]
  )

  // loop de reprodução
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const t = engine.position()
      const end = Math.max(timingRef.current.total, ...clipsRef.current.map(clipEnd))
      if (t > end + 0.5) {
        engine.pause()
        setPlaying(false)
        return
      }
      paint(t, true, true)
      // mantém o playhead visível na timeline
      const sc = scrollRef.current
      if (sc) {
        const x = t * ppsRef.current
        if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 60) sc.scrollLeft = x - 80
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, engine, paint])

  useLayoutEffect(() => paint(engine.position(), engine.playing || lastWord.current >= 0, false), [pps, paint, engine])

  // limpa o destaque ao desmontar
  useEffect(() => () => highlight(-1, false), [highlight])

  const seek = useCallback(
    (t: number, showWord = true) => {
      engine.seek(Math.max(0, t), clipsRef.current)
      paint(engine.position(), showWord, false)
    },
    [engine, paint]
  )

  const togglePlay = useCallback(async () => {
    if (engine.playing) {
      engine.pause()
      setPlaying(false)
    } else {
      await Promise.all(clipsRef.current.map((c) => engine.load(c).catch(() => null)))
      await engine.play(clipsRef.current)
      setPlaying(true)
    }
  }, [engine])

  // clicar no texto (parado) leva o playhead pra lá
  useEffect(() => {
    if (!editor) return
    const onSel = () => {
      if (engine.playing) return
      const { from, empty } = editor.state.selection
      if (!empty) return
      const words = timingRef.current.words
      let i = words.findIndex((w) => w.to >= from)
      if (i < 0) i = words.length - 1
      if (i < 0) return
      const t = words[i].from <= from ? words[i].start : (words[i - 1]?.end ?? 0)
      setTimeout(() => {
        engine.seek(t, clipsRef.current)
        paint(t, false, false)
      }, 0)
    }
    editor.on('selectionUpdate', onSel)
    return () => {
      editor.off('selectionUpdate', onSel)
    }
  }, [editor, engine, paint])

  // clicar num tempo no texto leva o playhead pra lá
  useEffect(() => {
    const on = (e: Event) => seek((e as CustomEvent<number>).detail)
    window.addEventListener('typos:seek', on)
    return () => window.removeEventListener('typos:seek', on)
  }, [seek])

  // ---------- sonoras / pausas no texto ----------
  const setPauseSeconds = (pos: number, seconds: number) => {
    if (!editor) return
    const node = editor.state.doc.nodeAt(pos)
    if (!node || !TIMED_PAUSES.includes(node.type.name)) return
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, seconds: Math.round(seconds * 10) / 10 }))
  }

  const createSonora = (start: number, seconds: number) => {
    if (!editor) return
    const node = editor.schema.nodes.sonora.create({ seconds: Math.round(seconds * 10) / 10 })
    const tr = placeBlock(editor.state.tr, insertionPoint(timingRef.current, editor.state.doc.content.size, start), node)
    // cursor dentro da sonora nova pra já descrever o que aparece
    const at = tr.mapping.map(insertionPoint(timingRef.current, editor.state.doc.content.size, start).pos)
    editor.view.dispatch(tr)
    const pos = findBlockNear(editor.state.doc, at, 'sonora')
    if (pos !== null) editor.chain().focus().setTextSelection(pos + 1).scrollIntoView().run()
  }

  const movePause = (seg: Segment, start: number) => {
    if (!editor) return
    const node = editor.state.doc.nodeAt(seg.pos)
    if (!node) return
    const point = insertionPoint(timingRef.current, editor.state.doc.content.size, start, seg.pos)
    const tr = editor.state.tr.delete(seg.pos, seg.pos + node.nodeSize)
    placeBlock(tr, { pos: tr.mapping.map(point.pos), split: point.split }, node)
    editor.view.dispatch(tr)
  }

  // ---------- edição de clipes ----------
  const update = (id: string, patch: Partial<Clip>) => onClipsChange(clipsRef.current.map((c) => (c.id === id ? { ...c, ...patch } : c)))

  const addAudio = async (files: { path: string; name: string }[], kind: Clip['kind'], at = engine.position()) => {
    const added: Clip[] = []
    for (const f of files) {
      try {
        const { buffer } = await engine.load(f)
        let lane = 0
        const all = [...clipsRef.current, ...added]
        while (!laneFree(all, lane, at, at + buffer.duration)) lane++
        added.push({
          id: uid(),
          path: f.path,
          name: f.name,
          kind,
          lane,
          start: at,
          offset: 0,
          duration: buffer.duration,
          sourceDuration: buffer.duration,
          // música entra baixa por padrão (fica embaixo da narração)
          gain: kind === 'music' ? 0.2 : 1,
          keys: []
        })
      } catch (e: any) {
        setError(String(e.message ?? e))
      }
    }
    if (added.length) {
      onClipsChange([...clipsRef.current, ...added])
      setSelected(added[added.length - 1].id)
    }
  }

  const split = () => {
    const t = engine.position()
    const targets = clipsRef.current.filter((c) => (selected ? c.id === selected : true) && c.start < t && clipEnd(c) > t)
    if (!targets.length) return
    const next: Clip[] = []
    for (const c of clipsRef.current) {
      if (!targets.includes(c)) {
        next.push(c)
        continue
      }
      const cut = t - c.start
      next.push({ ...c, duration: cut })
      next.push({ ...c, id: uid(), start: t, offset: c.offset + cut, duration: c.duration - cut })
    }
    onClipsChange(next)
  }

  const remove = (id = selected) => {
    if (!id) return
    onClipsChange(clipsRef.current.filter((c) => c.id !== id))
    setSelected(null)
  }

  const fade = (id: string, edge: 'in' | 'out', secs: number) => {
    const c = clipsRef.current.find((x) => x.id === id)
    if (!c) return
    const s = Math.min(Math.max(secs, 0.05), c.duration)
    const a = edge === 'in' ? c.offset : c.offset + c.duration - s
    const b = a + s
    const level = envelopeAt(c.keys, edge === 'in' ? b : a) || 1
    const keys = c.keys.filter((k) => k.t < a - 0.001 || k.t > b + 0.001)
    keys.push(edge === 'in' ? { t: a, v: 0 } : { t: a, v: level }, edge === 'in' ? { t: b, v: level } : { t: b, v: 0 })
    update(id, { keys: keys.sort((x, y) => x.t - y.t) })
  }

  // ---------- arrastar ----------
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const p = ppsRef.current
      if (d.mode === 'scrub') {
        seek((e.clientX - d.rect.left) / p)
        return
      }
      if (d.mode === 'pauseResize') {
        setPauseSeconds(d.pos, Math.max(0.5, d.dur0 + (e.clientX - d.x0) / p))
        return
      }
      if (d.mode === 'pauseMove') {
        const dx = (e.clientX - d.x0) / p
        if (Math.abs(e.clientX - d.x0) > 4) d.moved = true
        if (d.moved) setGhost({ start: Math.max(0, d.seg.start + dx), end: Math.max(0, d.seg.start + dx) + (d.seg.end - d.seg.start) })
        return
      }
      if (d.mode === 'pauseCreate') {
        const t = Math.max(0, (e.clientX - d.rect.left) / p)
        setGhost({ start: Math.min(d.t0, t), end: Math.max(d.t0, t) })
        return
      }
      if (d.mode === 'key') {
        const c = d.clip0
        const keys = [...c.keys]
        const prev = keys[d.index - 1]
        const next = keys[d.index + 1]
        let t = c.offset + (e.clientX - d.rect.left) / p
        t = Math.min(Math.max(t, prev ? prev.t + 0.01 : c.offset), next ? next.t - 0.01 : c.offset + c.duration)
        const v = Math.min(1, Math.max(0, 1 - (e.clientY - d.rect.top) / d.rect.height))
        keys[d.index] = { t, v }
        update(d.id, { keys })
        return
      }
      const c = d.clip0
      let dx = (e.clientX - d.x0) / p
      if (d.mode === 'move') {
        let start = Math.max(0, c.start + dx)
        // ímã: playhead, zero e bordas de outros clipes
        const snaps = [0, engine.position(), ...clipsRef.current.filter((o) => o.id !== c.id).flatMap((o) => [o.start, clipEnd(o)])]
        for (const s of snaps) {
          if (Math.abs((start - s) * p) < SNAP_PX) start = s
          else if (Math.abs((start + c.duration - s) * p) < SNAP_PX) start = s - c.duration
        }
        const lane = Math.min(12, Math.max(0, c.lane + Math.round((e.clientY - d.y0) / LANE_H)))
        update(c.id, { start: Math.max(0, start), lane })
      } else if (d.mode === 'trimL') {
        dx = Math.min(Math.max(dx, -c.offset, -c.start), c.duration - 0.1)
        update(c.id, { start: c.start + dx, offset: c.offset + dx, duration: c.duration - dx })
      } else {
        const duration = Math.min(Math.max(c.duration + dx, 0.1), c.sourceDuration - c.offset)
        update(c.id, { duration })
      }
    }
    const onUp = (e: PointerEvent) => {
      const d = drag.current
      drag.current = null
      if (!d) return
      const p = ppsRef.current
      if (d.mode === 'pauseMove') {
        setGhost(null)
        if (d.moved) movePause(d.seg, Math.max(0, d.seg.start + (e.clientX - d.x0) / p))
        else {
          seek(d.seg.start)
          editor?.chain().setTextSelection(d.seg.pos + 1).scrollIntoView().run()
        }
      } else if (d.mode === 'pauseCreate') {
        setGhost(null)
        const t = Math.max(0, (e.clientX - d.rect.left) / p)
        const start = Math.min(d.t0, t)
        const len = Math.abs(t - d.t0)
        createSonora(start, len < 0.3 ? 5 : len) // clique sem arrastar = 5s
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  })

  // ---------- atalhos ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inTimeline = (e.target as HTMLElement)?.closest?.('.timeline')
      const typing = (e.target as HTMLElement)?.matches?.('input, textarea, select')
      if (e.ctrlKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        togglePlay()
      } else if (inTimeline && !typing) {
        if (e.key === ' ') {
          e.preventDefault()
          togglePlay()
        } else if (e.key.toLowerCase() === 's' && !e.ctrlKey) split()
        else if (e.key === 'Delete' || e.key === 'Backspace') remove()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const sel = clips.find((c) => c.id === selected)
  const ticker = wordIdx >= 0 ? timing.words.slice(Math.max(0, wordIdx - 9), wordIdx + 1) : []
  const step = [1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pps >= 64) ?? 120

  return (
    <section className="timeline" style={{ height }} tabIndex={-1}>
      <div
        className="tl-resize"
        onPointerDown={(e) => {
          const y0 = e.clientY
          const h0 = height
          const move = (ev: PointerEvent) => setHeight(Math.min(window.innerHeight * 0.7, Math.max(170, h0 - (ev.clientY - y0))))
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }}
      />
      <div className="tl-head">
        <div className="tl-transport">
          <button className="icon-btn" title="Voltar pro início" onClick={() => seek(0)}>
            <SkipBack size={16} />
          </button>
          <button className="play-btn" title="Play / pausa (Ctrl+P · Espaço na timeline)" onClick={togglePlay}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <span className="tl-time">
            <span ref={timeRef}>0:00.0</span>
            <span className="muted"> / {formatTime(contentEnd)}</span>
          </span>
        </div>

        <label className="tl-wpm" title="Palavras por minuto da narração (sem áudio de voz, o tempo do texto sai daqui)">
          <input type="number" min={60} max={320} value={wpm} onChange={(e) => onWpmChange(Number(e.target.value) || null)} />
          ppm
          {customWpm && (
            <button className="icon-btn" title={`Voltar pro ppm do formato (${formatWpm})`} onClick={() => onWpmChange(null)}>
              <RotateCcw size={12} />
            </button>
          )}
        </label>

        <div className="tl-ticker" title="Últimas palavras">
          {ticker.map((w, i) => (
            <span key={w.from} className={i === ticker.length - 1 ? 'now' : ''}>
              {w.text}{' '}
            </span>
          ))}
        </div>

        <div className="tl-tools">
          <button className="btn small" onClick={async () => addAudio(await api.pickAudio(dir), 'music')} title="Adicionar música (entra a 20% do volume)">
            <Music size={14} /> Música
          </button>
          <button className="btn small" onClick={() => setSfxOpen(true)} title="Gerar efeito sonoro com a ElevenLabs">
            <Sparkles size={14} /> SFX
          </button>
          <button className="icon-btn" title="Cortar no playhead (S)" onClick={split}>
            <Scissors size={15} />
          </button>
          <button className="icon-btn" title="Diminuir zoom" onClick={() => setPps((p) => Math.max(4, p / 1.5))}>
            <ZoomOut size={15} />
          </button>
          <button className="icon-btn" title="Aumentar zoom" onClick={() => setPps((p) => Math.min(400, p * 1.5))}>
            <ZoomIn size={15} />
          </button>
        </div>
      </div>

      {sel && (
        <ClipInspector
          clip={sel}
          onGain={(gain) => update(sel.id, { gain })}
          onFade={(edge, s) => fade(sel.id, edge, s)}
          onClearKeys={() => update(sel.id, { keys: [] })}
          onRemove={() => remove(sel.id)}
        />
      )}
      {error && (
        <div className="tl-error" onClick={() => setError('')}>
          {error} (clique pra fechar)
        </div>
      )}

      <div
        className="tl-scroll"
        ref={scrollRef}
        onWheel={(e) => {
          if (!e.ctrlKey) return
          setPps((p) => Math.min(400, Math.max(4, p * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={async (e) => {
          e.preventDefault()
          const folderFile = e.dataTransfer.getData(FILE_MIME)
          const paths = folderFile ? [folderFile] : Array.from(e.dataTransfer.files).map((f) => api.pathForFile(f))
          const rect = (e.currentTarget.firstElementChild as HTMLElement).getBoundingClientRect()
          const at = Math.max(0, (e.clientX - rect.left) / pps)
          addAudio(await api.importAudioPaths(dir, paths), folderFile ? 'sfx' : 'music', at)
        }}
      >
        <div className="tl-content" style={{ width, height: RULER_H + TEXT_H + PAUSE_H + lanes * LANE_H }}>
          <div
            className="tl-ruler"
            style={{ height: RULER_H }}
            onPointerDown={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              drag.current = { mode: 'scrub', rect }
              seek((e.clientX - rect.left) / pps)
            }}
          >
            {Array.from({ length: Math.ceil(contentEnd / step) + 3 }, (_, i) => (
              <span key={i} className="tl-tick" style={{ left: i * step * pps }}>
                {formatTime(i * step)}
              </span>
            ))}
          </div>

          <div className="tl-textlane" style={{ top: RULER_H, height: TEXT_H }}>
            {timing.segments.map((s) =>
              s.end > s.start ? (
                <div
                  key={s.pos}
                  className={'tl-seg t-' + s.kind}
                  style={{ left: s.start * pps, width: Math.max(2, (s.end - s.start) * pps) }}
                  title={s.label}
                  onClick={() => {
                    if (TIMED_PAUSES.includes(s.kind)) return // tratado no pointerdown (mover/clicar)
                    seek(s.start)
                    editor?.chain().setTextSelection(s.pos + 1).scrollIntoView().run()
                  }}
                  onPointerDown={(e) => {
                    if (!TIMED_PAUSES.includes(s.kind) || e.button !== 0) return
                    e.stopPropagation()
                    drag.current = { mode: 'pauseMove', pos: s.pos, x0: e.clientX, seg: s, moved: false }
                  }}
                >
                  {s.label}
                  {TIMED_PAUSES.includes(s.kind) && (
                    <span
                      className="tl-seg-handle"
                      title="Arraste pra mudar a duração"
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        drag.current = { mode: 'pauseResize', pos: s.pos, x0: e.clientX, dur0: s.end - s.start }
                      }}
                    />
                  )}
                </div>
              ) : (
                <div key={s.pos} className={'tl-marker t-' + s.kind} style={{ left: s.start * pps }} title={s.label} onClick={() => seek(s.start)}>
                  {s.kind === 'chapter' && <span>{s.label}</span>}
                </div>
              )
            )}
          </div>

          <div
            className="tl-pauselane"
            style={{ top: RULER_H + TEXT_H, height: PAUSE_H }}
            title="Arraste aqui pra criar uma sonora: o trecho em que a narração para e aparece outra coisa"
            onPointerDown={(e) => {
              if (e.button !== 0) return
              const rect = e.currentTarget.getBoundingClientRect()
              const t0 = Math.max(0, (e.clientX - rect.left) / pps)
              drag.current = { mode: 'pauseCreate', rect, t0 }
              setGhost({ start: t0, end: t0 })
            }}
          >
            <span className="tl-pauselane-hint">arraste aqui pra criar uma sonora (pausa na narração)</span>
          </div>
          {ghost && (
            <div className="tl-ghost" style={{ left: ghost.start * pps, width: Math.max(4, (ghost.end - ghost.start) * pps), top: RULER_H + 4, height: TEXT_H + PAUSE_H - 8 }}>
              {(ghost.end - ghost.start).toFixed(1)}s
            </div>
          )}

          {Array.from({ length: lanes }, (_, i) => (
            <div key={i} className="tl-lane" style={{ top: RULER_H + TEXT_H + PAUSE_H + i * LANE_H, height: LANE_H }} onPointerDown={() => setSelected(null)} />
          ))}

          {clips.map((c) => (
            <ClipView
              key={c.id}
              clip={c}
              pps={pps}
              top={RULER_H + TEXT_H + PAUSE_H + c.lane * LANE_H + 3}
              height={LANE_H - 6}
              selected={c.id === selected}
              peaks={engine.get(c.path)?.peaks}
              loadedTick={loadedTick}
              onPointerDown={(e, mode) => {
                e.stopPropagation()
                setSelected(c.id)
                drag.current = { mode, id: c.id, x0: e.clientX, y0: e.clientY, clip0: c }
              }}
              onKeyDown={(e, index, rect) => {
                e.stopPropagation()
                setSelected(c.id)
                drag.current = { mode: 'key', id: c.id, index, clip0: c, rect }
              }}
              onAddKey={(t, v) => update(c.id, { keys: [...c.keys, { t, v }].sort((a, b) => a.t - b.t) })}
              onRemoveKey={(index) => update(c.id, { keys: c.keys.filter((_, i) => i !== index) })}
            />
          ))}

          <div className="tl-playhead" ref={playheadRef} />
        </div>
      </div>

      {sfxOpen && (
        <SfxModal
          dir={dir}
          onClose={() => setSfxOpen(false)}
          onDone={(f) => {
            setSfxOpen(false)
            addAudio([f], 'sfx')
          }}
        />
      )}
    </section>
  )
}

// ---------- clipe ----------
interface ClipViewProps {
  clip: Clip
  pps: number
  top: number
  height: number
  selected: boolean
  peaks?: Float32Array
  loadedTick: number
  onPointerDown: (e: React.PointerEvent, mode: 'move' | 'trimL' | 'trimR') => void
  onKeyDown: (e: React.PointerEvent, index: number, rect: DOMRect) => void
  onAddKey: (t: number, v: number) => void
  onRemoveKey: (index: number) => void
}

function ClipView({ clip: c, pps, top, height, selected, peaks, loadedTick, onPointerDown, onKeyDown, onAddKey, onRemoveKey }: ClipViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const w = Math.max(4, c.duration * pps)
  const h = height - 16

  useEffect(() => {
    const cv = canvas.current
    if (!cv || !peaks) return
    const cw = Math.min(4096, Math.ceil(w))
    cv.width = cw
    cv.height = h
    const g = cv.getContext('2d')!
    g.clearRect(0, 0, cw, h)
    g.fillStyle = c.kind === 'sfx' ? 'rgba(255, 170, 120, 0.55)' : 'rgba(140, 170, 255, 0.55)'
    const from = c.offset * PEAKS_PER_SEC
    const span = c.duration * PEAKS_PER_SEC
    for (let x = 0; x < cw; x++) {
      const a = Math.floor(from + (x / cw) * span)
      const b = Math.max(a + 1, Math.floor(from + ((x + 1) / cw) * span))
      let m = 0
      for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i]
      const bar = Math.max(1, m * h * c.gain * envelopeAt(c.keys, c.offset + (x / cw) * c.duration))
      g.fillRect(x, (h - bar) / 2, 1, bar)
    }
  }, [peaks, w, h, c.offset, c.duration, c.gain, c.keys, c.kind, loadedTick])

  // linha do envelope de volume
  const visible = c.keys.map((k, i) => ({ ...k, i })).filter((k) => k.t >= c.offset - 1e-6 && k.t <= c.offset + c.duration + 1e-6)
  const xOf = (t: number) => (t - c.offset) * pps
  const yOf = (v: number) => (1 - v) * h
  const pts = [
    [0, yOf(envelopeAt(c.keys, c.offset))],
    ...visible.map((k) => [xOf(k.t), yOf(k.v)]),
    [w, yOf(envelopeAt(c.keys, c.offset + c.duration))]
  ]

  return (
    <div
      className={'tl-clip k-' + c.kind + (selected ? ' selected' : '')}
      style={{ left: c.start * pps, top, width: w, height }}
      onPointerDown={(e) => e.button === 0 && onPointerDown(e, 'move')}
    >
      <div className="tl-clip-name">
        {c.name} <span className="muted">· {Math.round(c.gain * 100)}%</span>
      </div>
      <div
        className="tl-clip-body"
        ref={bodyRef}
        style={{ height: h }}
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          onAddKey(c.offset + (e.clientX - r.left) / pps, Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)))
        }}
        title="Duplo clique: keyframe de volume · arraste o ponto · botão direito apaga"
      >
        <canvas ref={canvas} style={{ width: w, height: h }} />
        <svg width={w} height={h}>
          <polyline points={pts.map((p) => p.join(',')).join(' ')} />
          {visible.map((k) => (
            <circle
              key={k.i}
              cx={xOf(k.t)}
              cy={yOf(k.v)}
              r={5}
              onPointerDown={(e) => e.button === 0 && onKeyDown(e, k.i, bodyRef.current!.getBoundingClientRect())}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onRemoveKey(k.i)
              }}
            >
              <title>{Math.round(k.v * 100)}%</title>
            </circle>
          ))}
        </svg>
      </div>
      <div className="tl-handle l" onPointerDown={(e) => onPointerDown(e, 'trimL')} />
      <div className="tl-handle r" onPointerDown={(e) => onPointerDown(e, 'trimR')} />
    </div>
  )
}

function ClipInspector({
  clip,
  onGain,
  onFade,
  onClearKeys,
  onRemove
}: {
  clip: Clip
  onGain: (g: number) => void
  onFade: (edge: 'in' | 'out', s: number) => void
  onClearKeys: () => void
  onRemove: () => void
}) {
  const [fin, setFin] = useState(2)
  const [fout, setFout] = useState(2)
  return (
    <div className="tl-inspector">
      <span className="tl-insp-name">{clip.name}</span>
      <label>
        Volume
        <input type="range" min={0} max={2} step={0.01} value={clip.gain} onChange={(e) => onGain(Number(e.target.value))} />
        <span className="num">{Math.round(clip.gain * 100)}%</span>
      </label>
      <label>
        Fade in
        <input type="number" min={0.1} step={0.5} value={fin} onChange={(e) => setFin(Number(e.target.value))} />s
        <button className="btn small" onClick={() => onFade('in', fin)}>
          aplicar
        </button>
      </label>
      <label>
        Fade out
        <input type="number" min={0.1} step={0.5} value={fout} onChange={(e) => setFout(Number(e.target.value))} />s
        <button className="btn small" onClick={() => onFade('out', fout)}>
          aplicar
        </button>
      </label>
      <button className="icon-btn" title="Limpar keyframes" onClick={onClearKeys}>
        <Eraser size={14} />
      </button>
      <button className="icon-btn danger" title="Excluir clipe (Delete)" onClick={onRemove}>
        <Trash2 size={14} />
      </button>
    </div>
  )
}

function SfxModal({ dir, onClose, onDone }: { dir: string; onClose: () => void; onDone: (f: { path: string; name: string }) => void }) {
  const [text, setText] = useState('')
  const [secs, setSecs] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const go = async () => {
    if (!text.trim()) return
    setBusy(true)
    setErr('')
    const r = await api.generateSfx(dir, text.trim(), secs ? Number(secs) : null)
    setBusy(false)
    if ('error' in r) setErr(r.error)
    else onDone(r)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Gerar efeito sonoro (ElevenLabs)</h3>
        <label className="field">
          Descreva o som (em inglês costuma sair melhor)
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="ex.: anime sword slash whoosh, cinematic" onKeyDown={(e) => e.key === 'Enter' && go()} />
        </label>
        <label className="field">
          Duração em segundos (vazio = automático, máx. 30)
          <input type="number" min={0.5} max={30} step={0.5} value={secs} onChange={(e) => setSecs(e.target.value)} />
        </label>
        {err && <div className="error">{err}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !text.trim()} onClick={go}>
            {busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Gerar e pôr no playhead
          </button>
        </div>
      </div>
    </div>
  )
}

/** Acha o bloco do tipo pedido mais perto da posição (depois de inserir, as posições mudam um pouco). */
function findBlockNear(doc: import('@tiptap/pm/model').Node, pos: number, type: string): number | null {
  let best: number | null = null
  doc.forEach((node, offset) => {
    if (node.type.name === type && (best === null || Math.abs(offset - pos) < Math.abs(best - pos))) best = offset
  })
  return best
}
