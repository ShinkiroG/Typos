import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Play,
  Pause,
  SkipBack,
  MousePointer2,
  Scissors,
  Combine,
  ZoomIn,
  ZoomOut,
  FolderPlus,
  Import,
  Wand2,
  Film,
  Music,
  Image as ImageIcon,
  X,
  Loader2,
  AlertTriangle,
  Undo2,
  Redo2,
  ChevronLeft,
  ChevronRight
} from 'lucide-react'
import { api, clipDur, clipEndT, fileUrl, uid, type MontageBin, type MontageClip, type MontageData, type MontageMedia } from '../lib'
import { MontageEngine } from './engine'
import { EditTimeline, MEDIA_MIME, mediaLen, splitClip, type Tool } from './EditTimeline'

export const fmtTc = (t: number) => {
  const s = Math.max(0, t)
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`
}

const kindOfPath = (p: string): MontageMedia['kind'] =>
  /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(p) ? 'audio' : /\.(png|jpe?g|webp)$/i.test(p) ? 'image' : 'video'

interface Props {
  active: boolean
  data: MontageData
  onChange: (d: MontageData) => void
  /** corte automático da narração (etapa de transcrição) */
  onAutoCut: (bin: MontageBin) => void
  autoCutBusy: string | null
}

export function Montage({ active, data, onChange, onAutoCut, autoCutBusy }: Props) {
  const engine = useMemo(() => new MontageEngine(), [])
  const [wavesVersion, setWavesVersion] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [tool, setTool] = useState<Tool>('select')
  const [pps, setPps] = useState(40)
  const [playing, setPlaying] = useState(false)
  const [bin, setBin] = useState(data.bins[0]?.id ?? 'narration')
  const [importing, setImporting] = useState(0)
  const [ffmpeg, setFfmpeg] = useState<{ path: string; version: string; whisper: boolean } | null | undefined>(undefined)
  const [source, setSource] = useState<MontageMedia | null>(null)
  const [missing, setMissing] = useState<Set<string>>(new Set())

  const posRef = useRef(0)
  const playheadRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tcRef = useRef<HTMLSpanElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dataRef = useRef(data)
  dataRef.current = data

  const media = useMemo(() => new Map(data.media.map((m) => [m.id, m])), [data.media])
  const mediaRef = useRef(media)
  mediaRef.current = media
  const dur = useCallback((id: string) => mediaLen(mediaRef.current.get(id)), [])

  useEffect(() => {
    api.ffmpegInfo().then(setFfmpeg)
    engine.onLoaded = () => setWavesVersion((v) => v + 1)
    return () => engine.dispose()
  }, [engine])

  // prévias de áudio de tudo que está no projeto (e confere se os arquivos ainda existem)
  useEffect(() => {
    if (!ffmpeg) return
    for (const m of data.media) engine.load(m).catch(() => null)
    api.mediaExists(data.media.map((m) => m.path)).then((ok) => setMissing(new Set(data.media.filter((_, i) => !ok[i]).map((m) => m.id))))
  }, [data.media, ffmpeg, engine])

  // ---------- desfazer ----------
  const past = useRef<MontageData[]>([])
  const future = useRef<MontageData[]>([])
  const lastGesture = useRef<string | null>(null)
  const change = useCallback(
    (next: MontageData, gesture?: string) => {
      if (!gesture || gesture !== lastGesture.current) {
        past.current.push(dataRef.current)
        if (past.current.length > 200) past.current.shift()
        future.current = []
      }
      lastGesture.current = gesture ?? null
      onChange(next)
    },
    [onChange]
  )
  const undo = () => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(dataRef.current)
    lastGesture.current = null
    onChange(prev)
  }
  const redo = () => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(dataRef.current)
    lastGesture.current = null
    onChange(next)
  }

  // mexeu na timeline tocando: reagenda o áudio
  useEffect(() => {
    engine.restart(data, dur)
  }, [data.clips, data.tracks, engine, dur])

  // ---------- transporte ----------
  const seek = useCallback(
    (t: number) => {
      engine.seek(t, dataRef.current, dur)
      posRef.current = Math.max(0, t)
    },
    [engine, dur]
  )
  const toggle = useCallback(async () => {
    if (engine.playing) {
      engine.pause()
      setPlaying(false)
    } else {
      setSource(null)
      await engine.play(dataRef.current, dur)
      setPlaying(true)
    }
  }, [engine, dur])

  useEffect(() => {
    // o cursor do roteiro fica escondido atrás: tira o foco dele pra não digitar lá
    if (active) (document.activeElement as HTMLElement | null)?.blur?.()
    if (!active && engine.playing) {
      engine.pause()
      setPlaying(false)
    }
  }, [active, engine])

  // relógio → playhead, timecode e vídeo (fora do React pra não pesar)
  useEffect(() => {
    if (!active) return
    let raf = 0
    const tick = () => {
      const t = engine.position()
      posRef.current = t
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${t * pps}px)`
      if (tcRef.current) tcRef.current.textContent = fmtTc(t)
      if (!source) syncPicture(t)
      const sc = scrollRef.current
      if (engine.playing && sc) {
        const x = 132 + t * pps - sc.scrollLeft
        if (x > sc.clientWidth - 40) sc.scrollLeft += sc.clientWidth * 0.7
      }
      const end = Math.max(0, ...dataRef.current.clips.map(clipEndT))
      if (engine.playing && t > end + 0.5) {
        engine.pause()
        setPlaying(false)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, pps, engine, source])

  /** quadro da faixa de vídeo mais de cima que tem algo nesse instante */
  const syncPicture = (t: number) => {
    const v = videoRef.current
    const img = imgRef.current
    if (!v || !img) return
    const d = dataRef.current
    let hit: MontageClip | undefined
    for (const tr of d.tracks) {
      if (tr.kind !== 'video' || tr.muted) continue
      hit = d.clips.find((c) => c.track === tr.id && c.start <= t && clipEndT(c) > t)
      if (hit) break
    }
    const m = hit && mediaRef.current.get(hit.media)
    if (!hit || !m) {
      v.style.visibility = 'hidden'
      img.style.visibility = 'hidden'
      if (!v.paused) v.pause()
      return
    }
    if (m.kind === 'image') {
      v.style.visibility = 'hidden'
      if (!v.paused) v.pause()
      const src = fileUrl(m.path)
      if (img.dataset.src !== src) {
        img.src = src
        img.dataset.src = src
      }
      img.style.visibility = 'visible'
      return
    }
    img.style.visibility = 'hidden'
    v.style.visibility = 'visible'
    const src = fileUrl(m.path)
    if (v.dataset.src !== src) {
      v.src = src
      v.dataset.src = src
    }
    const want = hit.in + (t - hit.start)
    if (engine.playing) {
      if (v.paused) v.play().catch(() => null)
      if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want
    } else {
      if (!v.paused) v.pause()
      if (Math.abs(v.currentTime - want) > 0.02) v.currentTime = want
    }
  }

  // ---------- edição ----------
  const sel = data.clips.filter((c) => selected.includes(c.id))
  const one = sel.length === 1 ? sel[0] : null
  const patchClip = (id: string, p: Partial<MontageClip>, gesture?: string) =>
    change({ ...data, clips: data.clips.map((c) => (c.id === id ? { ...c, ...p } : c)) }, gesture)

  const prevOf = (c: MontageClip) =>
    data.clips.find((x) => x.id !== c.id && x.track === c.track && Math.abs(clipEndT(x) - c.start) < 0.002)

  const splitAtPlayhead = () => {
    const t = posRef.current
    const targets = sel.length ? sel : data.clips.filter((c) => c.start < t && clipEndT(c) > t && !data.tracks.find((tr) => tr.id === c.track)?.muted)
    let clips = data.clips
    for (const c of targets) {
      const parts = splitClip(c, t)
      if (parts) clips = clips.flatMap((x) => (x.id === c.id ? parts : [x]))
    }
    if (clips !== data.clips) change({ ...data, clips })
  }

  const remove = (ripple: boolean) => {
    if (!sel.length) return
    let clips = data.clips.filter((c) => !selected.includes(c.id))
    if (ripple) {
      // fecha o buraco na mesma faixa (do fim pro começo pra não somar errado)
      for (const r of [...sel].sort((a, b) => b.start - a.start)) {
        clips = clips.map((c) => (c.track === r.track && c.start >= clipEndT(r) - 0.001 ? { ...c, start: c.start - clipDur(r) } : c))
      }
    }
    setSelected([])
    change({ ...data, clips })
  }

  /** Emenda: crossfade curtinho no corte, pra não estalar */
  const spliceLen = data.spliceDefault ?? 0.02
  const applySplice = (all: boolean) => {
    const targets = all ? data.clips : sel
    const joins = targets.filter((c) => prevOf(c))
    if (!joins.length) return
    const allOn = joins.every((c) => c.splice)
    const ids = new Set(joins.map((c) => c.id))
    change({ ...data, clips: data.clips.map((c) => (ids.has(c.id) ? { ...c, splice: allOn && !all ? undefined : spliceLen } : c)) })
  }

  const jumpCut = (dir: 1 | -1) => {
    const t = posRef.current
    const edges = [...new Set(data.clips.flatMap((c) => [c.start, clipEndT(c)]))].sort((a, b) => a - b)
    const n = dir > 0 ? edges.find((e) => e > t + 0.01) : [...edges].reverse().find((e) => e < t - 0.01)
    if (n !== undefined) seek(n)
  }

  // ---------- atalhos (só com a Montagem na frente) ----------
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      // campos da Montagem usam o teclado deles; o resto (até o texto escondido do roteiro) é nosso
      const el = e.target as HTMLElement
      if (el.closest?.('.montage') && el.closest('input, textarea, select')) return
      const k = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && k === 'z') {
        e.preventDefault()
        e.stopPropagation()
        return e.shiftKey ? redo() : undo()
      }
      if ((e.ctrlKey || e.metaKey) && k === 'y') {
        e.preventDefault()
        e.stopPropagation()
        return redo()
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const run = (fn: () => void) => {
        e.preventDefault()
        e.stopPropagation()
        fn()
      }
      if (k === ' ') run(toggle)
      else if (k === 'v') run(() => setTool('select'))
      else if (k === 'b') run(() => setTool((t) => (t === 'blade' ? 'select' : 'blade')))
      else if (k === 's') run(splitAtPlayhead)
      else if (k === 'e') run(() => applySplice(false))
      else if (k === 'delete' || k === 'backspace') run(() => remove(e.shiftKey))
      else if (k === 'arrowleft') run(() => (e.shiftKey ? jumpCut(-1) : seek(posRef.current - 1 / 30)))
      else if (k === 'arrowright') run(() => (e.shiftKey ? jumpCut(1) : seek(posRef.current + 1 / 30)))
      else if (k === 'home') run(() => seek(0))
      else if (k === '+' || k === '=') run(() => setPps((p) => Math.min(800, p * 1.4)))
      else if (k === '-') run(() => setPps((p) => Math.max(2, p / 1.4)))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // ---------- mídia ----------
  const importPaths = async (paths: string[], toBin: string) => {
    const fresh = paths.filter((p) => !data.media.some((m) => m.path === p && m.bin === toBin))
    if (!fresh.length) return
    setImporting((n) => n + fresh.length)
    const added: MontageMedia[] = []
    for (const p of fresh) {
      const info = await api.probeMedia(p)
      setImporting((n) => n - 1)
      if ('error' in info) continue
      const kind = kindOfPath(p)
      added.push({
        id: uid(),
        bin: toBin,
        path: p,
        name: p.split(/[\\/]/).pop() || p,
        kind,
        duration: info.duration || (kind === 'image' ? 5 : 0),
        hasAudio: info.hasAudio,
        hasVideo: info.hasVideo && kind !== 'audio',
        width: info.width,
        height: info.height,
        fps: info.fps
      })
    }
    if (added.length) change({ ...dataRef.current, media: [...dataRef.current.media, ...added] })
  }

  const addBin = () => {
    const name = prompt('Nome da pasta:', 'Nova pasta')
    if (!name?.trim()) return
    const b: MontageBin = { id: uid(), name: name.trim(), role: 'custom' }
    change({ ...data, bins: [...data.bins, b] })
    setBin(b.id)
  }

  const curBin = data.bins.find((b) => b.id === bin) ?? data.bins[0]
  const items = data.media.filter((m) => m.bin === curBin?.id)

  const dropFiles = (e: React.DragEvent, toBin: string) => {
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => api.pathForFile(f))
      .filter(Boolean)
    if (!paths.length) return
    e.preventDefault()
    importPaths(paths, toBin)
  }

  return (
    <div className="montage">
      {/* ---------- mídia do projeto ---------- */}
      <section className="mt-pool">
        <div className="mt-bins">
          {data.bins.map((b) => (
            <button
              key={b.id}
              className={'mt-bin' + (b.id === curBin?.id ? ' on' : '') + ' r-' + b.role}
              onClick={() => setBin(b.id)}
              onDoubleClick={() => {
                if (b.role !== 'custom') return
                const name = prompt('Nome da pasta:', b.name)
                if (name?.trim()) change({ ...data, bins: data.bins.map((x) => (x.id === b.id ? { ...x, name: name.trim() } : x)) })
              }}
              onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
              onDrop={(e) => dropFiles(e, b.id)}
              title={b.role === 'narration' ? 'Áudios e vídeos de narração: vão pro corte automático' : b.role === 'raw' ? 'Todo o material além da voz' : 'Duplo clique renomeia'}
            >
              {b.name}
              <small>{data.media.filter((m) => m.bin === b.id).length}</small>
            </button>
          ))}
          <button className="mt-bin add" onClick={addBin} title="Nova pasta">
            <FolderPlus size={13} />
          </button>
        </div>

        <div className="mt-pool-bar">
          <button className="btn small" onClick={async () => importPaths(await api.pickMedia(), curBin.id)} disabled={!ffmpeg}>
            <Import size={13} /> Importar
          </button>
          {curBin?.role === 'narration' && (
            <button
              className="btn small primary"
              disabled={!items.length || !!autoCutBusy || !ffmpeg}
              onClick={() => onAutoCut(curBin)}
              title="Transcreve a narração, compara com o roteiro e monta a timeline com os cortes"
            >
              {autoCutBusy ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />} Corte automático
            </button>
          )}
          {curBin?.role === 'custom' && (
            <button
              className="icon-btn danger"
              title="Apagar pasta (a mídia dela sai do projeto, os arquivos ficam no PC)"
              onClick={() => {
                if (!confirm(`Apagar a pasta "${curBin.name}"?`)) return
                const gone = new Set(items.map((m) => m.id))
                change({ ...data, bins: data.bins.filter((b) => b.id !== curBin.id), media: data.media.filter((m) => !gone.has(m.id)), clips: data.clips.filter((c) => !gone.has(c.media)) })
                setBin(data.bins[0].id)
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
        {autoCutBusy && <div className="mt-note">{autoCutBusy}</div>}
        {ffmpeg === null && (
          <div className="mt-note warn">
            <AlertTriangle size={13} /> A Montagem precisa do ffmpeg. Instale com <code>winget install ffmpeg</code> e reabra o Typos.
          </div>
        )}

        <div
          className="mt-items"
          onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
          onDrop={(e) => curBin && dropFiles(e, curBin.id)}
        >
          {items.length === 0 && (
            <div className="mt-empty">
              {curBin?.role === 'narration'
                ? 'Arraste aqui os áudios de narração ou os vídeos de talking head. Depois é só pedir o corte automático.'
                : 'Arraste arquivos do PC pra cá (ou use Importar). Eles ficam onde estão: o projeto só guarda o caminho.'}
            </div>
          )}
          {importing > 0 && (
            <div className="mt-note">
              <Loader2 size={13} className="spin" /> lendo {importing} arquivo(s)…
            </div>
          )}
          {items.map((m) => (
            <div
              key={m.id}
              className={'mt-item k-' + m.kind + (missing.has(m.id) ? ' missing' : '')}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(MEDIA_MIME, m.id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onDoubleClick={() => {
                engine.pause()
                setPlaying(false)
                setSource(m)
              }}
              title={`${m.path}\nArraste pra timeline · duplo clique abre no visualizador`}
            >
              <span className="mt-item-ico">{m.kind === 'audio' ? <Music size={14} /> : m.kind === 'image' ? <ImageIcon size={14} /> : <Film size={14} />}</span>
              <span className="mt-item-name">{m.name}</span>
              <span className="mt-item-dur">{missing.has(m.id) ? 'arquivo sumiu' : m.kind === 'image' ? 'imagem' : fmtTc(m.duration)}</span>
              {m.hasAudio && !engine.get(m.id) && ffmpeg && <Loader2 size={11} className="spin mt-item-load" />}
              <button
                className="icon-btn danger mt-item-x"
                title="Tirar do projeto (o arquivo fica no PC)"
                onClick={(e) => {
                  e.stopPropagation()
                  const used = data.clips.filter((c) => c.media === m.id).length
                  if (used && !confirm(`"${m.name}" está em ${used} corte(s) da timeline. Tirar mesmo assim?`)) return
                  change({ ...data, media: data.media.filter((x) => x.id !== m.id), clips: data.clips.filter((c) => c.media !== m.id) })
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- visualizador ---------- */}
      <section className="mt-viewer">
        <div className="mt-screen">
          {source ? (
            source.kind === 'image' ? (
              <img src={fileUrl(source.path)} />
            ) : (
              <video key={source.id} src={fileUrl(source.path)} controls autoPlay className={source.kind === 'audio' ? 'audio' : ''} />
            )
          ) : (
            <>
              <video ref={videoRef} muted playsInline />
              <img ref={imgRef} alt="" style={{ visibility: 'hidden' }} />
            </>
          )}
          {source && (
            <button className="btn small mt-source-back" onClick={() => setSource(null)}>
              <X size={12} /> {source.name} · voltar pra timeline
            </button>
          )}
        </div>
        <div className="mt-transport">
          <button className="icon-btn" title="Início (Home)" onClick={() => seek(0)}>
            <SkipBack size={15} />
          </button>
          <button className="icon-btn" title="Corte anterior (Shift+←)" onClick={() => jumpCut(-1)}>
            <ChevronLeft size={15} />
          </button>
          <button className="mt-play" title="Tocar/pausar (Espaço)" onClick={toggle}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button className="icon-btn" title="Próximo corte (Shift+→)" onClick={() => jumpCut(1)}>
            <ChevronRight size={15} />
          </button>
          <span className="mt-tc" ref={tcRef}>
            0:00.00
          </span>
          <span className="muted small">/ {fmtTc(Math.max(0, ...data.clips.map(clipEndT)))}</span>
        </div>
      </section>

      {/* ---------- inspetor ---------- */}
      <section className="mt-inspector">
        {!one ? (
          <div className="mt-empty small">
            {sel.length > 1 ? `${sel.length} cortes selecionados. Delete apaga, Shift+Delete apaga e fecha o buraco, E aplica a Emenda.` : 'Clique num corte da timeline pra ver os detalhes.'}
            <div className="mt-keys">
              <b>Atalhos</b>
              <span>Espaço tocar · V seleção · B lâmina · S dividir no playhead</span>
              <span>E Emenda · Delete apagar · Shift+Delete apagar e juntar</span>
              <span>←/→ quadro · Shift+←/→ corte · +/- zoom · Ctrl+Z desfazer</span>
            </div>
          </div>
        ) : (
          <ClipInspector
            c={one}
            m={media.get(one.media)}
            hasPrev={!!prevOf(one)}
            spliceLen={spliceLen}
            patch={(p, g) => patchClip(one.id, p, g)}
          />
        )}
      </section>

      {/* ---------- barra de ferramentas ---------- */}
      <div className="mt-toolbar">
        <div className="seg">
          <button className={tool === 'select' ? 'on' : ''} title="Seleção (V)" onClick={() => setTool('select')}>
            <MousePointer2 size={14} />
          </button>
          <button className={tool === 'blade' ? 'on' : ''} title="Lâmina (B): clique no corte pra dividir" onClick={() => setTool('blade')}>
            <Scissors size={14} />
          </button>
        </div>
        <button className="btn small" title="Dividir no playhead (S)" onClick={splitAtPlayhead}>
          <Scissors size={13} /> Dividir
        </button>
        <span className="mt-sep" />
        <button className="btn small emenda" title="Emenda (E): crossfade curto no corte selecionado, pra suavizar e evitar estalo" onClick={() => applySplice(false)} disabled={!sel.some((c) => prevOf(c))}>
          <Combine size={13} /> Emenda
        </button>
        <button className="btn small" title="Aplica a Emenda em todos os cortes colados da timeline" onClick={() => applySplice(true)}>
          Emenda em todos os cortes
        </button>
        <label className="mt-splice-len" title="Duração da Emenda">
          <input
            type="number"
            min={0.1}
            max={500}
            step={0.1}
            value={+(spliceLen * 1000).toFixed(1)}
            onChange={(e) => change({ ...data, spliceDefault: Math.max(0.0001, Number(e.target.value) / 1000) }, 'splice-len')}
          />
          ms
        </label>
        <span className="mt-sep" />
        <button className="icon-btn" title="Desfazer (Ctrl+Z)" onClick={undo}>
          <Undo2 size={15} />
        </button>
        <button className="icon-btn" title="Refazer (Ctrl+Shift+Z)" onClick={redo}>
          <Redo2 size={15} />
        </button>
        <span className="mt-grow" />
        <button className="icon-btn" title="Menos zoom (-)" onClick={() => setPps((p) => Math.max(2, p / 1.4))}>
          <ZoomOut size={15} />
        </button>
        <button className="icon-btn" title="Mais zoom (+)" onClick={() => setPps((p) => Math.min(800, p * 1.4))}>
          <ZoomIn size={15} />
        </button>
      </div>

      {/* ---------- timeline de edição ---------- */}
      <section className="mt-timeline">
        <EditTimeline
          data={data}
          change={change}
          engine={engine}
          media={media}
          selected={selected}
          onSelect={setSelected}
          tool={tool}
          pps={pps}
          posRef={posRef}
          seek={seek}
          playheadRef={playheadRef}
          scrollRef={scrollRef}
          wavesVersion={wavesVersion}
        />
      </section>
    </div>
  )
}

function ClipInspector({
  c,
  m,
  hasPrev,
  spliceLen,
  patch
}: {
  c: MontageClip
  m?: MontageMedia
  hasPrev: boolean
  spliceLen: number
  patch: (p: Partial<MontageClip>, gesture?: string) => void
}) {
  const num = (v: number) => +v.toFixed(3)
  const g = 'insp-' + c.id
  return (
    <div className="mt-insp">
      <div className="mt-insp-name" title={m?.path}>
        {m?.name ?? 'mídia sumiu'}
      </div>
      <div className="mt-insp-grid">
        <label>
          Início
          <input type="number" step={0.01} value={num(c.start)} onChange={(e) => patch({ start: Math.max(0, Number(e.target.value)) }, g + 's')} />
        </label>
        <label>
          Duração
          <input type="text" readOnly value={fmtTc(clipDur(c))} />
        </label>
        <label>
          Entrada (arquivo)
          <input type="number" step={0.01} value={num(c.in)} onChange={(e) => patch({ in: Math.min(c.out - 0.04, Math.max(0, Number(e.target.value))) }, g + 'i')} />
        </label>
        <label>
          Saída (arquivo)
          <input type="number" step={0.01} value={num(c.out)} onChange={(e) => patch({ out: Math.max(c.in + 0.04, Math.min(mediaLen(m), Number(e.target.value))) }, g + 'o')} />
        </label>
      </div>
      {m?.hasAudio && (
        <label className="mt-insp-row">
          Volume <b>{(c.gainDb ?? 0) > 0 ? '+' : ''}{(c.gainDb ?? 0).toFixed(1)} dB</b>
          <input type="range" min={-30} max={12} step={0.5} value={c.gainDb ?? 0} onChange={(e) => patch({ gainDb: Number(e.target.value) }, g + 'g')} onDoubleClick={() => patch({ gainDb: 0 })} />
        </label>
      )}
      <div className="mt-insp-grid">
        <label>
          Fade de entrada (ms)
          <input type="number" min={0} step={10} value={Math.round((c.fadeIn ?? 0) * 1000)} onChange={(e) => patch({ fadeIn: Math.max(0, Number(e.target.value) / 1000) }, g + 'fi')} />
        </label>
        <label>
          Fade de saída (ms)
          <input type="number" min={0} step={10} value={Math.round((c.fadeOut ?? 0) * 1000)} onChange={(e) => patch({ fadeOut: Math.max(0, Number(e.target.value) / 1000) }, g + 'fo')} />
        </label>
      </div>
      <label className={'toggle-row mt-insp-row' + (hasPrev ? '' : ' disabled')} title={hasPrev ? '' : 'A Emenda vale quando este corte está colado no anterior'}>
        <input type="checkbox" disabled={!hasPrev} checked={!!c.splice} onChange={(e) => patch({ splice: e.target.checked ? spliceLen : undefined })} />
        Emenda com o corte anterior
        {c.splice ? (
          <input
            type="number"
            className="mt-insp-ms"
            min={0.1}
            step={0.1}
            value={+(c.splice * 1000).toFixed(1)}
            onChange={(e) => patch({ splice: Math.max(0.0001, Number(e.target.value) / 1000) }, g + 'sp')}
          />
        ) : null}
        {c.splice ? 'ms' : null}
      </label>
    </div>
  )
}
