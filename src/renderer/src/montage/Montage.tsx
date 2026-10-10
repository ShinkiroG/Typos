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
  ChevronRight,
  FileCheck2,
  Circle,
  Square,
  Settings2
} from 'lucide-react'
import { api, clipDur, clipEndT, fileUrl, uid, type MontageBin, type MontageClip, type MontageData, type MontageMedia } from '../lib'
import { MontageEngine } from './engine'
import { Recorder } from '../audio'
import { EditTimeline, MEDIA_MIME, mediaLen, splitClip, type Tool } from './EditTimeline'
import { autoCut, type AutoCutResult, type ScriptBlock, type Take } from './autocut'

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
  /** idioma da narração pro Whisper ("pt", "en"…) */
  lang: string
  /** blocos do roteiro, na ordem (pro corte automático achar cada frase) */
  getBlocks: () => ScriptBlock[]
  /** grava os tempos da narração nos blocos do roteiro; devolve quantas falas mudaram */
  onSyncScript: (d: MontageData) => number
  /** pasta do projeto (as gravações vão pra assets/gravacoes) */
  dir: string
  /** velocidade de fala (rolagem do teleprompter) */
  wpm: number
  /** abre a configuração de entrada/saída de áudio */
  onAudioSettings: () => void
}

const LAYOUT_KEY = 'typos.montageLayout'
const loadLayout = () => {
  try {
    return { pool: 300, insp: 280, tl: 300, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') }
  } catch {
    return { pool: 300, insp: 280, tl: 300 }
  }
}

type WStatus = Awaited<ReturnType<typeof api.whisperStatus>>

export function Montage({ active, data, onChange, lang, getBlocks, onSyncScript, dir, wpm, onAudioSettings }: Props) {
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

  // tamanhos das áreas (arrastando as divisórias), lembrados neste PC
  const [layout, setLayout] = useState(loadLayout)
  const rootRef = useRef<HTMLDivElement>(null)
  const startSplit = (which: 'pool' | 'insp' | 'tl', e: React.PointerEvent) => {
    e.preventDefault()
    const box = rootRef.current!.getBoundingClientRect()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      setLayout((l: typeof layout) => {
        const next = { ...l }
        if (which === 'pool') next.pool = Math.max(200, Math.min(box.width * 0.45, ev.clientX - box.left))
        if (which === 'insp') next.insp = Math.max(200, Math.min(box.width * 0.4, box.right - ev.clientX))
        if (which === 'tl') next.tl = Math.max(120, Math.min(box.height - 200, box.bottom - ev.clientY - 40))
        return next
      })
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      setLayout((l: typeof layout) => {
        try {
          localStorage.setItem(LAYOUT_KEY, JSON.stringify(l))
        } catch {
          /* sem storage */
        }
        return l
      })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  // ---------- gravação ----------
  const recRef = useRef<Recorder | null>(null)
  const [armed, setArmed] = useState<string | null>(() => data.tracks.find((t) => t.kind === 'audio')?.id ?? null)
  const [rec, setRec] = useState<{ track: string; start: number } | null>(null)
  const recClipRef = useRef<HTMLDivElement>(null)
  const meterRef = useRef<HTMLDivElement>(null)
  const [prompter, setPrompter] = useState(() => localStorage.getItem('typos.prompter') !== '0')
  const prompterRef = useRef<HTMLDivElement>(null)
  // velocidade própria do teleprompter (palavras/min); começa no ppm do formato
  const [prompterWpm, setPrompterWpmState] = useState(() => Number(localStorage.getItem('typos.prompterWpm')) || wpm)
  const prompterWpmRef = useRef(prompterWpm)
  prompterWpmRef.current = prompterWpm
  const setPrompterWpm = (v: number) => {
    const n = Math.max(40, Math.min(400, Math.round(v)))
    setPrompterWpmState(n)
    try {
      localStorage.setItem('typos.prompterWpm', String(n))
    } catch {
      /* sem storage */
    }
  }
  /** ensaio: o teleprompter rola sem gravar */
  const [rehearse, setRehearse] = useState(false)
  const rehearseRef = useRef(false)
  rehearseRef.current = rehearse
  const scrollAcc = useRef(0)
  const lastFrame = useRef(0)

  const [wstatus, setWstatus] = useState<WStatus | null>(null)
  const [busy, setBusy] = useState<{ label: string; pct: number | null } | null>(null)
  const [report, setReport] = useState<AutoCutResult | null>(null)
  const busyLabel = useRef('')

  useEffect(() => {
    api.whisperStatus().then(setWstatus)
    api.onWhisperProgress((p) => setBusy((b) => (b ? { ...b, pct: p.pct } : b)))
  }, [])

  const model = wstatus?.models.find((m) => m.id === wstatus.model)

  const downloadModel = async () => {
    if (!model) return
    if (!confirm(`Baixar o modelo ${model.id} (~${(model.mb / 1024).toFixed(1)} GB) do repositório oficial do whisper.cpp? É uma vez só.`)) return
    setBusy({ label: `Baixando ${model.id}…`, pct: 0 })
    const r = await api.whisperDownload(model.id)
    setBusy(null)
    if ('error' in r) alert(r.error)
    setWstatus(await api.whisperStatus())
  }

  /** transcreve a narração, acha cada frase do roteiro e monta a timeline */
  const runAutoCut = async (b: MontageBin) => {
    const list = dataRef.current.media.filter((m) => m.bin === b.id && m.hasAudio)
    if (!list.length) return
    if (!model?.ready) return downloadModel()
    const hadAuto = dataRef.current.clips.some((c) => c.block !== undefined && list.some((m) => m.id === c.media))
    if (hadAuto && !confirm('Refazer o corte automático? Os cortes automáticos anteriores dessa narração são substituídos (o que você pôs à mão fica).')) return
    engine.pause()
    setPlaying(false)
    setReport(null)
    const takes: Take[] = []
    try {
      for (const [i, m] of list.entries()) {
        busyLabel.current = `Transcrevendo ${m.name} (${i + 1}/${list.length})`
        setBusy({ label: busyLabel.current, pct: 0 })
        const tr = await api.transcribe(m.path, lang)
        if ('error' in tr) throw new Error(tr.error)
        setBusy({ label: `Achando os silêncios de ${m.name}`, pct: null })
        const sil = await api.silences(m.path)
        if ('error' in sil) throw new Error(sil.error)
        takes.push({ media: m, words: tr.words, silences: sil })
      }
      setBusy({ label: 'Comparando com o roteiro…', pct: null })
      const r = autoCut(getBlocks(), takes, dataRef.current)
      if (!r.found) throw new Error('Não achei nenhuma frase do roteiro nessa narração. O idioma do formato está certo?')
      change(r.data)
      setReport(r)
      setSelected([])
      seek(0)
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

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
      const r = recRef.current
      if (r && meterRef.current) {
        const db = r.level()
        meterRef.current.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`
        meterRef.current.dataset.hot = db > -3 ? 'red' : db > -12 ? 'yellow' : 'green'
      }
      if (r && recClipRef.current) recClipRef.current.style.width = `${Math.max(2, (t - (recStart.current ?? t)) * pps)}px`
      const pr = prompterRef.current
      const now = performance.now()
      const dt = Math.min(0.1, (now - (lastFrame.current || now)) / 1000)
      lastFrame.current = now
      if (pr && (r || rehearseRef.current)) {
        // desce sozinho na velocidade escolhida: pixels por palavra × palavras por segundo
        const words = Math.max(1, (pr.textContent ?? '').split(/\s+/).filter(Boolean).length)
        const text = Math.max(1, pr.scrollHeight - pr.clientHeight * 0.9)
        scrollAcc.current += (text / words) * (prompterWpmRef.current / 60) * dt
        pr.scrollTop = scrollAcc.current
      }
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

  // ---------- botão direito num corte ----------
  const [clipMenu, setClipMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  useEffect(() => {
    if (!clipMenu) return
    const close = () => setClipMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [clipMenu])

  const onClipMenu = (e: React.MouseEvent, c: MontageClip) => {
    e.preventDefault()
    e.stopPropagation()
    if (!selected.includes(c.id)) setSelected([c.id])
    setClipMenu({ x: e.clientX, y: e.clientY, id: c.id })
  }

  /** os cortes que o menu atinge: a seleção (se o clicado faz parte dela) ou só ele */
  const menuTargets = () => {
    if (!clipMenu) return []
    const ids = selected.includes(clipMenu.id) ? selected : [clipMenu.id]
    return dataRef.current.clips.filter((c) => ids.includes(c.id))
  }

  const removeClips = (targets: MontageClip[], ripple: boolean) => {
    const ids = new Set(targets.map((c) => c.id))
    let clips = dataRef.current.clips.filter((c) => !ids.has(c.id))
    if (ripple)
      for (const r of [...targets].sort((a, b) => b.start - a.start))
        clips = clips.map((c) => (c.track === r.track && c.start >= clipEndT(r) - 0.001 ? { ...c, start: c.start - clipDur(r) } : c))
    setSelected([])
    change({ ...dataRef.current, clips })
  }

  /** gravação descartada: some da timeline, do projeto e o arquivo vai pra Lixeira */
  const discardRecording = async (targets: MontageClip[]) => {
    const d = dataRef.current
    const medias = [...new Set(targets.map((c) => c.media))].map((id) => d.media.find((m) => m.id === id)!).filter((m) => m && /[\\/]assets[\\/]gravacoes[\\/]/i.test(m.path))
    if (!medias.length) return
    const others = d.clips.filter((c) => medias.some((m) => m.id === c.media) && !targets.includes(c)).length
    if (!confirm(`Descartar ${medias.length === 1 ? 'a gravação ' + medias[0].name : medias.length + ' gravações'}?${others ? ` Ela também está em ${others} outro(s) corte(s), que saem junto.` : ''} O arquivo vai pra Lixeira.`)) return
    const gone = new Set(medias.map((m) => m.id))
    setSelected([])
    change({ ...d, media: d.media.filter((m) => !gone.has(m.id)), clips: d.clips.filter((c) => !gone.has(c.media)) })
    for (const m of medias) await api.trashRecording(m.path)
  }

  const recStart = useRef<number | null>(null)
  /** grava o microfone na faixa armada, a partir do playhead (a timeline toca junto) */
  const startRec = async () => {
    if (recRef.current) return stopRec()
    const track = armed ?? data.tracks.find((t) => t.kind === 'audio')?.id
    if (!track) return
    if (!armed) setArmed(track)
    setSource(null)
    const r = new Recorder()
    try {
      await r.open()
    } catch (err) {
      alert('Não deu pra abrir o microfone. Confira em Áudio → Configurar entrada e saída (e nas Configurações de privacidade do Windows → Microfone).\n\n' + (err as Error).message)
      return
    }
    recRef.current = r
    const t0 = posRef.current
    recStart.current = t0
    r.start()
    setRec({ track, start: t0 })
    if (prompterRef.current) prompterRef.current.scrollTop = 0
    scrollAcc.current = 0
    setRehearse(false)
    await engine.play(dataRef.current, dur)
    setPlaying(true)
  }

  const stopRec = async () => {
    const r = recRef.current
    const cur = rec ?? (recStart.current !== null && armed ? { track: armed, start: recStart.current } : null)
    if (!r || !cur) return
    const { wav, duration } = r.stop()
    r.close()
    recRef.current = null
    recStart.current = null
    engine.pause()
    setPlaying(false)
    setRec(null)
    if (duration < 0.3) return
    const path = await api.saveRecording(dir, wav)
    if (typeof path !== 'string') return alert(path.error)
    const bin = dataRef.current.bins.find((b) => b.role === 'narration') ?? dataRef.current.bins[0]
    const m: MontageMedia = { id: uid(), bin: bin.id, path, name: path.split(/[\\/]/).pop() || 'gravacao.wav', kind: 'audio', duration, hasAudio: true, hasVideo: false }
    const clip: MontageClip = { id: uid(), track: cur.track, media: m.id, start: cur.start, in: 0, out: duration }
    change({ ...dataRef.current, media: [...dataRef.current.media, m], clips: [...dataRef.current.clips, clip] })
    setSelected([clip.id])
  }

  // fechar a Montagem no meio da gravação não perde nada
  useEffect(() => {
    if (!active && recRef.current) stopRec()
  }, [active])

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
      if (k === ' ') run(recRef.current ? stopRec : rehearseRef.current ? () => setRehearse(false) : toggle)
      else if (k === 'r') run(startRec)
      else if ((k === 'arrowup' || k === 'arrowdown') && (recRef.current || rehearseRef.current))
        run(() => setPrompterWpm(prompterWpmRef.current + (k === 'arrowup' ? 10 : -10)))
      else if (k === 'v') run(() => setTool('select'))
      else if (k === 'c') run(() => setTool((t) => (t === 'blade' ? 'select' : 'blade')))
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
    <div
      className="montage"
      ref={rootRef}
      style={{ gridTemplateColumns: `${layout.pool}px minmax(0, 1fr) ${layout.insp}px`, gridTemplateRows: `minmax(120px, 1fr) 40px ${layout.tl}px` }}
    >
      <div className="mt-split v" style={{ left: layout.pool - 3, bottom: layout.tl + 40 }} onPointerDown={(e) => startSplit('pool', e)} title="Arraste pra mudar a largura" />
      <div className="mt-split v" style={{ right: layout.insp - 3, bottom: layout.tl + 40 }} onPointerDown={(e) => startSplit('insp', e)} title="Arraste pra mudar a largura" />
      <div className="mt-split h" style={{ bottom: layout.tl + 40 - 3 }} onPointerDown={(e) => startSplit('tl', e)} title="Arraste pra mudar a altura da timeline" />
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
              disabled={!items.length || !!busy || !ffmpeg}
              onClick={() => runAutoCut(curBin)}
              title="Transcreve a narração, compara com o roteiro e monta a timeline com os cortes"
            >
              {busy ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />} Corte automático
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
        {curBin?.role === 'narration' && wstatus && ffmpeg && (
          <div className="mt-whisper">
            <span>Transcrição</span>
            <select
              value={wstatus.model}
              disabled={!!busy}
              onChange={async (e) => {
                await api.whisperSetModel(e.target.value)
                setWstatus(await api.whisperStatus())
              }}
            >
              {wstatus.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.ready ? ' ✓' : ` (${(m.mb / 1024).toFixed(1)} GB)`}
                </option>
              ))}
            </select>
            {model && !model.ready && (
              <button className="btn small" disabled={!!busy} onClick={downloadModel}>
                Baixar
              </button>
            )}
          </div>
        )}
        {busy && (
          <div className="mt-progress">
            <span>
              <Loader2 size={12} className="spin" /> {busy.label}
              {busy.pct !== null ? ` · ${Math.round(busy.pct * 100)}%` : ''}
            </span>
            {busy.pct !== null && (
              <div className="mt-bar">
                <i style={{ width: `${Math.round(busy.pct * 100)}%` }} />
              </div>
            )}
          </div>
        )}
        {report && !busy && curBin?.role === 'narration' && (
          <div className="mt-report">
            <b>{report.found} frases montadas</b>
            {report.retakes > 0 && <span> · {report.retakes} regravadas (ficou a última tomada)</span>}
            {report.missing.length > 0 && (
              <details>
                <summary>{report.missing.length} não achadas na gravação</summary>
                {report.missing.map((m, i) => (
                  <p key={i}>{m}</p>
                ))}
              </details>
            )}
            <button className="icon-btn" title="Fechar" onClick={() => setReport(null)}>
              <X size={12} />
            </button>
          </div>
        )}
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
          {!source && prompter && (rec || rehearse) && (
            <>
              <div
                className="mt-prompter"
                ref={prompterRef}
                // a roda do mouse adianta/volta; a rolagem automática continua dali
                onWheel={() => requestAnimationFrame(() => (scrollAcc.current = prompterRef.current?.scrollTop ?? scrollAcc.current))}
              >
                {getBlocks()
                  .filter((b) => (b.type === 'paragraph' || b.type === 'chapter') && b.text.trim())
                  .map((b) => (b.type === 'chapter' ? <h4 key={b.index}>{b.text}</h4> : <p key={b.index}>{b.text}</p>))}
              </div>
              <div className="mt-prompter-guide" />
              <div className="mt-prompter-hud">
                {prompterWpm} ppm · ↑/↓ muda · roda do mouse adianta/volta{rehearse ? ' · Espaço para' : ''}
              </div>
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
          <button className={'mt-rec' + (rec ? ' on' : '')} title={rec ? 'Parar gravação (Espaço)' : 'Gravar na faixa armada (R)'} onClick={startRec}>
            {rec ? <Square size={12} /> : <Circle size={13} />}
          </button>
          <span className="mt-tc" ref={tcRef}>
            0:00.00
          </span>
          <span className="muted small">/ {fmtTc(Math.max(0, ...data.clips.map(clipEndT)))}</span>
          {rec && (
            <span className="mt-meter" title="Nível do microfone">
              <i ref={meterRef} />
            </span>
          )}
          <label className="mt-prompter-toggle" title="Mostra o roteiro no visualizador enquanto você grava">
            <input
              type="checkbox"
              checked={prompter}
              onChange={(e) => {
                setPrompter(e.target.checked)
                try {
                  localStorage.setItem('typos.prompter', e.target.checked ? '1' : '0')
                } catch {
                  /* sem storage */
                }
              }}
            />
            Teleprompter
          </label>
          {prompter && (
            <>
              <label className="mt-prompter-speed" title="Velocidade de leitura do teleprompter (palavras por minuto). Enquanto rola: ↑/↓">
                <input type="number" min={40} max={400} step={5} value={prompterWpm} onChange={(e) => setPrompterWpm(Number(e.target.value) || wpm)} />
                ppm
              </label>
              <button
                className={'btn small' + (rehearse ? ' primary' : '')}
                disabled={!!rec}
                title="Rola o teleprompter sem gravar, pra achar a velocidade"
                onClick={() => {
                  scrollAcc.current = 0
                  if (prompterRef.current) prompterRef.current.scrollTop = 0
                  setSource(null)
                  setRehearse((v) => !v)
                }}
              >
                {rehearse ? 'Parar ensaio' : 'Ensaiar'}
              </button>
            </>
          )}
          <button className="icon-btn" title="Áudio: microfone, saída e níveis" onClick={onAudioSettings}>
            <Settings2 size={15} />
          </button>
        </div>
      </section>

      {/* ---------- inspetor ---------- */}
      <section className="mt-inspector">
        {!one ? (
          <div className="mt-empty small">
            {sel.length > 1 ? `${sel.length} cortes selecionados. Delete apaga, Shift+Delete apaga e fecha o buraco, E aplica a Emenda.` : 'Clique num corte da timeline pra ver os detalhes.'}
            <div className="mt-keys">
              <b>Atalhos</b>
              <span>Espaço tocar · V seleção · C lâmina · S dividir no playhead · R gravar</span>
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
          <button className={tool === 'blade' ? 'on' : ''} title="Lâmina (C): clique no corte pra dividir" onClick={() => setTool('blade')}>
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
        <button
          className="btn small primary"
          disabled={!data.clips.some((c) => c.block !== undefined)}
          title="Grava o tempo real de cada fala (e das pausas) no roteiro. A timeline do roteiro passa a tocar esta narração."
          onClick={() => {
            const n = onSyncScript(dataRef.current)
            if (!n) alert('Nenhum corte está ligado a uma fala do roteiro. Use o Corte automático primeiro.')
          }}
        >
          <FileCheck2 size={13} /> Atualizar roteiro
        </button>
        <button className="icon-btn" title="Menos zoom (-)" onClick={() => setPps((p) => Math.max(2, p / 1.4))}>
          <ZoomOut size={15} />
        </button>
        <button className="icon-btn" title="Mais zoom (+)" onClick={() => setPps((p) => Math.min(800, p * 1.4))}>
          <ZoomIn size={15} />
        </button>
      </div>

      {clipMenu &&
        (() => {
          const targets = menuTargets()
          const one = targets.length === 1 ? targets[0] : null
          const m = one ? media.get(one.media) : null
          const tr = one ? data.tracks.find((t) => t.id === one.track) : null
          const sameKind = tr ? data.tracks.filter((t) => t.kind === tr.kind && t.id !== tr.id) : []
          const isRec = targets.some((c) => /[\\/]assets[\\/]gravacoes[\\/]/i.test(media.get(c.media)?.path ?? ''))
          const t = posRef.current
          const canSplit = targets.some((c) => c.start < t && clipEndT(c) > t)
          const act = (fn: () => void) => () => {
            setClipMenu(null)
            fn()
          }
          return (
            <div
              className="ctx-menu"
              style={{ left: Math.min(clipMenu.x, window.innerWidth - 260), top: Math.min(clipMenu.y, window.innerHeight - 380) }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="ctx-label">{one ? m?.name ?? 'corte' : `${targets.length} cortes`}</div>
              <button onClick={act(() => removeClips(targets, false))}>
                Excluir <kbd>Delete</kbd>
              </button>
              <button onClick={act(() => removeClips(targets, true))}>
                Excluir e juntar o resto <kbd>Shift+Delete</kbd>
              </button>
              <div className="ctx-sep" />
              <button disabled={!canSplit} onClick={act(splitAtPlayhead)}>
                Dividir no playhead <kbd>S</kbd>
              </button>
              <button
                onClick={act(() => {
                  const end = Math.max(...targets.map(clipEndT))
                  const first = Math.min(...targets.map((c) => c.start))
                  const copies = targets.map((c) => ({ ...c, id: uid(), start: c.start - first + end, splice: undefined }))
                  change({ ...dataRef.current, clips: [...dataRef.current.clips, ...copies] })
                  setSelected(copies.map((c) => c.id))
                })}
              >
                Duplicar logo depois
              </button>
              {one && prevOf(one) && (
                <button onClick={act(() => patchClip(one.id, { splice: one.splice ? undefined : spliceLen }))}>
                  {one.splice ? 'Tirar a Emenda' : 'Emenda com o corte anterior'} <kbd>E</kbd>
                </button>
              )}
              {one && sameKind.length > 0 && (
                <>
                  <div className="ctx-sep" />
                  <div className="ctx-label">Mover pra faixa</div>
                  {sameKind.map((k) => (
                    <button key={k.id} onClick={act(() => patchClip(one.id, { track: k.id }))}>
                      {k.name}
                    </button>
                  ))}
                </>
              )}
              <div className="ctx-sep" />
              {m && (
                <>
                  <button
                    onClick={act(() => {
                      setBin(m.bin)
                      engine.pause()
                      setPlaying(false)
                      setSource(m)
                    })}
                  >
                    Ver o arquivo inteiro no visualizador
                  </button>
                  <button onClick={act(() => api.showItem(m.path))}>Mostrar o arquivo na pasta</button>
                </>
              )}
              {isRec && (
                <button className="danger" onClick={act(() => discardRecording(targets))}>
                  Descartar gravação (arquivo vai pra Lixeira)
                </button>
              )}
            </div>
          )
        })()}

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
          onClipMenu={onClipMenu}
          armed={armed}
          onArm={(id) => setArmed((a) => (a === id ? null : id))}
          recording={rec}
          recClipRef={recClipRef}
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
