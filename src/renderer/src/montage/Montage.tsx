import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  History,
  Redo2,
  ChevronLeft,
  ChevronRight,
  FileCheck2,
  Circle,
  Square,
  Settings2,
  Gauge,
  Folder,
  Download,
  Star,
  Link2,
  FolderOpen,
  Settings,
  ArrowUp,
  ArrowDown,
  Sparkles,
  AudioWaveform,
  FoldVertical,
  UnfoldVertical,
  Type,
  Trash2,
  ListPlus,
  SlidersHorizontal,
  Check
} from 'lucide-react'
import { api, clipDur, clipEndT, fileUrl, RESOLUTIONS, uid, type Attachment, type Format, type InstructionBlock, type MontageBin, type MontageClip, type MontageData, type MontageMarker, type MontageMedia } from '../lib'
import { MontageEngine } from './engine'
import { SILENCE_DEFAULT, silenceCut, silenceStats, suggestThreshold, type SilenceOpts } from './silence'
import { Recorder } from '../audio'
import { askText } from '../components/AskDialog'
import { YoutubeDownload } from '../components/YoutubeDownload'
import { EditTimeline, HEAD_W, MEDIA_MIME, PCFILE_MIME, TRACK_MAX_H, TRACK_MIN_H, findGap, mediaLen, splitClip, trackHeight, type GapSel, type Tool } from './EditTimeline'
import { autoCut, type AutoCutResult, type ScriptBlock, type Take } from './autocut'
import { blockDur, blockFromClip, blockLabel, generateClip, generatePreview, memoryFromBlock, newBlock, previewStale, rangeTweak } from './blocks'
import { MotionEditor } from './MotionEditor'
import { BlockInspector, BlockWindow, busyOverall, type BlockBusy } from './BlockPanel'
import { AudioReadButton, BlockHeardRow, useBlockHeard } from './AudioRead'
import { jobPct, recheckRead, runningLabel, watchJobs } from './transcripts'
import { describeChange } from './history'
import { isKey, keyOf } from '../keys'

const keyHint = (id: string) => keyOf(id) || '—'

export const fmtTc = (t: number) => {
  const s = Math.max(0, t)
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`
}

/** pasta onde entram os clipes de motion aprovados */
const MOTION_BIN = 'motion'

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
  /** grava os tempos da narração nos blocos do roteiro; devolve quantas falas mudaram (sem = some o botão) */
  onSyncScript?: (d: MontageData) => Promise<number>
  /** pasta do projeto (as gravações vão pra assets/gravacoes) */
  dir: string
  /** velocidade de fala (rolagem do teleprompter) */
  wpm: number
  /** abre a configuração de entrada/saída de áudio */
  onAudioSettings: () => void
  /** formato do projeto (estilo e memória de motion dos blocos de instrução) */
  format?: Format
  onFormatChange?: (f: Format) => void
  /** botão "Preparar Clipes" (abre o workspace Criar Clipes) */
  onPrepareClips?: () => void
  /** rótulo do botão acima (ex.: já ativado) */
  prepareLabel?: string
  /** algo no topo da área de mídia (ex.: a pasta Recortes do Criar Clipes) */
  poolTop?: React.ReactNode
  /** botões a mais na barra de ferramentas, à direita */
  toolbarExtra?: React.ReactNode
  /** proporção do quadro do visualizador ("9:16"): o vídeo preenche e corta as sobras, igual ao export */
  frame?: string
  /** botão de destaque "Enviar pra fila de render" (põe o vídeo na fila do Render) */
  onQueueRender?: () => void
  /** arquivos usados fora desta timeline (recortes do Criar Clipes, vídeo principal): a limpeza não manda pra Lixeira */
  usedElsewhere?: () => Set<string>
  /** as outras timelines do projeto (pro "Ler todas as timelines" do áudio) */
  otherTimelines?: () => MontageData[]
}

/** zooms do visualizador (fração do tamanho real do vídeo final) */
const VIEW_ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.75, 1, 1.5, 2]

const LAYOUT_KEY = 'typos.montageLayout'
const loadLayout = () => {
  try {
    return { pool: 300, insp: 280, tl: 300, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') }
  } catch {
    return { pool: 300, insp: 280, tl: 300 }
  }
}

type WStatus = Awaited<ReturnType<typeof api.whisperStatus>>

export function Montage({
  active,
  data,
  onChange,
  lang,
  getBlocks,
  onSyncScript,
  dir,
  wpm,
  onAudioSettings,
  format,
  onFormatChange,
  onPrepareClips,
  prepareLabel,
  poolTop,
  toolbarExtra,
  frame,
  onQueueRender,
  usedElsewhere,
  otherTimelines
}: Props) {
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
  /** muda pra reconferir se os arquivos existem (ex.: baixou de novo um que tinha sumido) */
  const [recheck, setRecheck] = useState(0)

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
  // faixa armada foi apagada: a gravação passa pra primeira de áudio
  useEffect(() => {
    if (armed && !data.tracks.some((t) => t.id === armed)) setArmed(data.tracks.find((t) => t.kind === 'audio')?.id ?? null)
  }, [data.tracks, armed])
  const recClipRef = useRef<HTMLDivElement>(null)
  const meterRef = useRef<HTMLDivElement>(null)
  const [prompter, setPrompter] = useState(() => localStorage.getItem('typos.prompter') !== '0')
  // zoom do visualizador (igual ao do Premiere): "Ajustar" cabe na tela; a % é do tamanho real do vídeo final
  const [view, setViewState] = useState<number | 'fit'>(() => {
    const v = Number(localStorage.getItem('typos.viewerZoom'))
    return v > 0 ? v : 'fit'
  })
  const setView = (v: number | 'fit') => {
    setViewState(v)
    try {
      localStorage.setItem('typos.viewerZoom', String(v === 'fit' ? 0 : v))
    } catch {
      /* sem storage */
    }
  }
  const seqAspect = frame ?? format?.aspect ?? '16:9'
  const [seqW, seqH] = (RESOLUTIONS[seqAspect] ?? '1920×1080').split('×').map(Number)
  const screenRef = useRef<HTMLDivElement>(null)
  // barra de ferramentas: se não cabe numa linha, os rótulos secundários somem (fica o ícone com o título)
  const barRef = useRef<HTMLDivElement>(null)
  const [barCompact, setBarCompact] = useState(false)
  const barFull = useRef(0)
  const fitBar = useRef(() => {})
  fitBar.current = () => {
    const el = barRef.current
    if (!el) return
    if (!barCompact) {
      if (el.scrollWidth > el.clientWidth + 1) {
        barFull.current = el.scrollWidth
        setBarCompact(true)
      }
    } else if (el.clientWidth >= barFull.current) setBarCompact(false)
  }
  useLayoutEffect(() => fitBar.current())
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const ro = new ResizeObserver(() => fitBar.current())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const viewWheel = useRef<(e: WheelEvent) => void>(() => {})
  viewWheel.current = (e) => {
    // Ctrl+roda: aproxima/afasta o vídeo (sem Ctrl a roda rola a tela ampliada)
    if (!e.ctrlKey) return
    e.preventDefault()
    const box = screenRef.current!.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const cur = view === 'fit' ? Math.min(box.width / seqW, box.height / seqH) * dpr : view
    const next = e.deltaY < 0 ? VIEW_ZOOMS.find((z) => z > cur + 0.001) : [...VIEW_ZOOMS].reverse().find((z) => z < cur - 0.001)
    if (next) setView(next)
  }
  useEffect(() => {
    const el = screenRef.current
    if (!el) return
    const on = (e: WheelEvent) => viewWheel.current(e)
    el.addEventListener('wheel', on, { passive: false })
    return () => el.removeEventListener('wheel', on)
  }, [])
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
  /** de qual bloco do roteiro o teleprompter começa (null = do início) */
  const [prompterFrom, setPrompterFrom] = useState<number | null>(null)
  /** rola o teleprompter até o bloco ficar na faixa de leitura */
  const prompterTo = (index: number | null) => {
    const pr = prompterRef.current
    if (!pr) return
    const el = index === null ? null : pr.querySelector<HTMLElement>(`[data-block="${index}"]`)
    const top = el ? pr.scrollTop + el.getBoundingClientRect().top - pr.getBoundingClientRect().top - parseFloat(getComputedStyle(pr).paddingTop) : 0
    pr.scrollTop = Math.max(0, top)
    scrollAcc.current = pr.scrollTop
  }
  /** falas e capítulos que o teleprompter mostra */
  const prompterBlocks = prompter ? getBlocks().filter((b) => (b.type === 'paragraph' || b.type === 'chapter') && b.text.trim()) : []
  // ao aparecer (gravar/ensaiar), já começa no ponto escolhido
  const prompterShown = !source && prompter && (!!rec || rehearse)
  useEffect(() => {
    if (prompterShown) requestAnimationFrame(() => prompterTo(prompterFrom))
  }, [prompterShown])
  /** o bloco que está na faixa de leitura agora */
  const prompterAt = (): number | null => {
    const pr = prompterRef.current
    if (!pr) return null
    const line = pr.getBoundingClientRect().top + parseFloat(getComputedStyle(pr).paddingTop) + 8
    let at: number | null = null
    pr.querySelectorAll<HTMLElement>('[data-block]').forEach((el) => {
      if (el.getBoundingClientRect().top <= line) at = Number(el.dataset.block)
    })
    return at
  }

  const [wstatus, setWstatus] = useState<WStatus | null>(null)
  const [busy, setBusy] = useState<{ label: string; pct: number | null } | null>(null)
  const [report, setReport] = useState<AutoCutResult | null>(null)
  const busyLabel = useRef('')

  useEffect(() => {
    api.whisperStatus().then(setWstatus)
  }, [])
  // o aviso de progresso vai pra uma Montagem só (a do Criar Clipes também usa): fica com a da frente
  useEffect(() => {
    if (active) api.onWhisperProgress((p) => setBusy((b) => (b ? { ...b, pct: p.pct } : b)))
  }, [active])

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
    const inside = subtree(b.id)
    const list = dataRef.current.media.filter((m) => inside.has(m.bin) && m.hasAudio)
    if (!list.length) return
    if (!model?.ready) return downloadModel()
    const hadAuto = dataRef.current.clips.some((c) => c.block !== undefined && list.some((m) => m.id === c.media))
    if (hadAuto && !confirm('Refazer o corte automático? O corte anterior (faixa "Corte automático") é substituído; as gravações originais ficam como estão.')) return
    engine.pause()
    setPlaying(false)
    setReport(null)
    const takes: Take[] = []
    try {
      for (const [i, m] of list.entries()) {
        busyLabel.current = `Transcrevendo ${m.name} (${i + 1}/${list.length})`
        setBusy({ label: busyLabel.current, pct: 0 })
        // a leitura vai pra fila do Whisper (se já estava sendo lida em segundo plano, só espera ela)
        const stop = watchJobs(() => {
          const j = runningLabel(m.path, lang)
          setBusy({ label: busyLabel.current + (j ? ': ' + j : ''), pct: jobPct(m.path, lang) })
        })
        const tr = await api.transcribe(m.path, lang).finally(stop)
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

  // zoom (botões, +/- e Ctrl/Alt + roda do mouse) sempre focado na agulha: ela fica parada na tela
  // (se estiver fora da tela, vem pro meio)
  const zoomAnchor = useRef<{ t: number; x: number } | null>(null)
  const zoomBy = (f: number) => {
    const sc = scrollRef.current
    setPps((p) => {
      const n = Math.min(800, Math.max(2, p * f))
      if (sc) {
        const t = posRef.current
        let x = HEAD_W + t * p - sc.scrollLeft
        if (x < HEAD_W || x > sc.clientWidth) x = HEAD_W + (sc.clientWidth - HEAD_W) / 2
        zoomAnchor.current = { t, x }
      }
      return n
    })
  }
  const zoomRef = useRef(zoomBy)
  zoomRef.current = zoomBy
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.altKey) return
      e.preventDefault()
      zoomRef.current(e.deltaY < 0 ? 1.2 : 1 / 1.2)
    }
    sc.addEventListener('wheel', onWheel, { passive: false })
    return () => sc.removeEventListener('wheel', onWheel)
  }, [active])
  useLayoutEffect(() => {
    const a = zoomAnchor.current
    const sc = scrollRef.current
    if (!a || !sc) return
    sc.scrollLeft = Math.max(0, a.t * pps + HEAD_W - a.x)
    zoomAnchor.current = null
  }, [pps])
  const tcRef = useRef<HTMLSpanElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dataRef = useRef(data)
  dataRef.current = data

  const media = useMemo(() => new Map(data.media.map((m) => [m.id, m])), [data.media])
  const mediaRef = useRef(media)
  mediaRef.current = media
  // vídeo pesado (4K, HEVC, ProRes…) toca a cópia leve na prévia; o render usa o original
  const proxyRef = useRef(new Map<string, string>())
  const proxyAsked = useRef(new Set<string>())
  useEffect(() => {
    for (const m of data.media) {
      if (m.kind !== 'video' || !m.hasVideo || proxyAsked.current.has(m.path)) continue
      proxyAsked.current.add(m.path)
      api.proxyVideo(m.path).then((p) => p && proxyRef.current.set(m.path, p))
    }
  }, [data.media])
  const dur = useCallback((id: string) => mediaLen(mediaRef.current.get(id)), [])
  /**
   * formato dos blocos de instrução: o do quadro desta timeline. Numa timeline de Clipes em 9:16 o motion
   * sai vertical mesmo que o formato escolhido (estilo, memória) seja o horizontal da Montagem.
   */
  const blockFormat = useMemo<Format | undefined>(
    () => (frame ? { ...(format ?? { id: '', name: 'Clipes', wpm, maxSeconds: null }), aspect: frame } : format),
    [format, frame, wpm]
  )

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
  }, [data.media, ffmpeg, engine, recheck])

  // ---------- desfazer ----------
  const past = useRef<MontageData[]>([])
  const future = useRef<MontageData[]>([])
  const lastGesture = useRef<string | null>(null)
  /** quando cada passo aconteceu (chave: o estado de antes dele) */
  const stamps = useRef(new WeakMap<MontageData, number>())
  const [histOpen, setHistOpen] = useState(false)
  const change = useCallback(
    (next: MontageData, gesture?: string) => {
      if (!gesture || gesture !== lastGesture.current) {
        stamps.current.set(dataRef.current, Date.now())
        past.current.push(dataRef.current)
        if (past.current.length > 200) past.current.shift()
        future.current = []
      }
      lastGesture.current = gesture ?? null
      // quem chamar change de novo antes do React redesenhar já enxerga esta versão
      dataRef.current = next
      onChange(next)
    },
    [onChange]
  )
  const undo = () => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(dataRef.current)
    lastGesture.current = null
    dataRef.current = prev
    onChange(prev)
  }
  const redo = () => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(dataRef.current)
    lastGesture.current = null
    dataRef.current = next
    onChange(next)
  }
  /** pula vários passos de uma vez (clique no histórico): >0 refaz, <0 desfaz */
  const jump = (steps: number) => {
    for (let i = 0; i < Math.abs(steps); i++) steps < 0 ? undo() : redo()
  }
  // Editar → Desfazer/Refazer do menu do topo, com a Montagem na frente
  useEffect(() => {
    if (!active) return
    const on = (e: Event) => ((e as CustomEvent).detail === 'redo' ? redo() : undo())
    window.addEventListener('typos:montage-history', on)
    return () => window.removeEventListener('typos:montage-history', on)
  })

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
      if (playheadRef.current) {
        playheadRef.current.style.transform = `translateX(${t * pps}px)`
        // rolou a timeline: o cursor não passa por cima dos nomes das faixas
        const behind = t * pps < (scrollRef.current?.scrollLeft ?? 0) - 1
        playheadRef.current.style.visibility = behind ? 'hidden' : ''
      }
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
      // gravando, a timeline segue andando mesmo depois do último corte (ou com ela vazia)
      if (engine.playing && !r && t > end + 0.5) {
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
    const src = fileUrl(proxyRef.current.get(m.path) ?? m.path)
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
  /** controle de som dedicado (aberto pelo menu do corte) */
  const [soundFor, setSoundFor] = useState<{ x: number; y: number; ids: string[] } | null>(null)
  /** botão direito na junção de dois cortes (id = corte da direita): opções do crossfade */
  const [joinMenu, setJoinMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  useEffect(() => {
    if (!clipMenu && !joinMenu) return
    const close = () => {
      setClipMenu(null)
      setJoinMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [clipMenu, joinMenu])
  const onJoinMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    setClipMenu(null)
    setJoinMenu({ x: e.clientX, y: e.clientY, id })
  }

  const onClipMenu = (e: React.MouseEvent, c: MontageClip) => {
    e.preventDefault()
    e.stopPropagation()
    if (!selected.includes(c.id)) setSelected([c.id])
    setJoinMenu(null)
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

  // ---------- normalizar a narração ----------
  // alvo: pico (dBFS) ou volume percebido (LUFS)
  const normSpec = data.norm ?? 'peak:-6'
  const [normMode, normValue] = [normSpec.split(':')[0] as 'peak' | 'lufs', Number(normSpec.split(':')[1])]
  const [normMsg, setNormMsg] = useState('')
  /**
   * Mede o volume percebido (LUFS) de cada corte e acerta o volume dele pro alvo.
   * Sem corte selecionado: todos os cortes da narração (pasta Narração / faixas de narração).
   */
  const normalize = async (only?: MontageClip[]) => {
    const d = dataRef.current
    const narrBins = new Set(d.bins.filter((b) => b.role === 'narration').flatMap((b) => [...subtree(b.id)]))
    const sel = only ?? d.clips.filter((c) => selected.includes(c.id))
    const targets = (sel.length ? sel : d.clips.filter((c) => narrBins.has(mediaRef.current.get(c.media)?.bin ?? '') || c.block !== undefined)).filter(
      (c) => mediaRef.current.get(c.media)?.hasAudio
    )
    if (!targets.length) return setNormMsg('Nenhum corte de narração com áudio pra normalizar.')
    engine.pause()
    setPlaying(false)
    const gains = new Map<string, number>()
    let skipped = 0
    let limited = 0
    try {
      for (const [i, c] of targets.entries()) {
        setBusy({ label: `Medindo o volume (${i + 1}/${targets.length})`, pct: i / targets.length })
        const m = mediaRef.current.get(c.media)!
        const l = await api.loudness(m.path, c.in, c.out - c.in)
        if (!l) {
          skipped++
          continue
        }
        const g = Math.max(-24, Math.min(24, normMode === 'peak' ? normValue - l.tp : normValue - l.i))
        if (l.tp + g > -1) limited++
        gains.set(c.id, Math.round(g * 10) / 10)
      }
    } finally {
      setBusy(null)
    }
    if (!gains.size) return setNormMsg('Os cortes são curtos demais (ou mudos) pra medir.')
    change({ ...dataRef.current, clips: dataRef.current.clips.map((c) => (gains.has(c.id) ? { ...c, gainDb: gains.get(c.id) } : c)) })
    setNormMsg(
      `${gains.size} corte(s) com ${normMode === 'peak' ? `pico em ${normValue} dB` : `${normValue} LUFS`}` +
        (limited ? ` · em ${limited} o limitador segura os picos` : '') +
        (skipped ? ` · ${skipped} curto(s)/mudo(s) ficaram como estavam` : '') +
        ' · Ctrl+Z desfaz'
    )
  }
  useEffect(() => {
    if (!normMsg) return
    const t = setTimeout(() => setNormMsg(''), 7000)
    return () => clearTimeout(t)
  }, [normMsg])

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
    setRehearse(false)
    await engine.play(dataRef.current, dur)
    setPlaying(true)
  }

  const stopRec = async () => {
    const r = recRef.current
    const cur = rec ?? (recStart.current !== null && armed ? { track: armed, start: recStart.current } : null)
    if (!r || !cur) return
    // a próxima tomada continua do parágrafo onde parou
    const at = prompterAt()
    if (at !== null) setPrompterFrom(at)
    recRef.current = null
    recStart.current = null
    engine.pause()
    setPlaying(false)
    setRec(null)
    const { wav, duration } = await r.stop()
    r.close()
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

  /** crossfade curtinho no corte, pra não estalar */
  const spliceLen = data.spliceDefault ?? 0.02
  const applySplice = (all: boolean) => {
    const targets = all ? data.clips : sel
    const joins = targets.filter((c) => prevOf(c))
    if (!joins.length) return
    const allOn = joins.every((c) => c.splice)
    const ids = new Set(joins.map((c) => c.id))
    change({ ...data, clips: data.clips.map((c) => (ids.has(c.id) ? { ...c, splice: allOn && !all ? undefined : spliceLen } : c)) })
  }

  // ---------- corte por silêncio (rápido, sem transcrever) ----------
  const [silOpts, setSilOptsState] = useState<SilenceOpts>(() => {
    try {
      return { ...SILENCE_DEFAULT, ...JSON.parse(localStorage.getItem('typos.silence') ?? '{}') }
    } catch {
      return SILENCE_DEFAULT
    }
  })
  const setSilOpts = (o: Partial<SilenceOpts>) =>
    setSilOptsState((cur) => {
      const n = { ...cur, ...o }
      try {
        localStorage.setItem('typos.silence', JSON.stringify(n))
      } catch {
        /* sem storage */
      }
      return n
    })
  const [silOpen, setSilOpen] = useState(false)

  /**
   * Tira os silêncios. Com cortes selecionados: só neles. Sem seleção: a narração inteira
   * (os cortes dela na timeline ou, se ainda não tem nenhum, os arquivos da pasta Narração).
   * Narração vai pra faixa "Corte automático" (a original fica silenciada pra comparar);
   * o que já está nela (ou é vídeo) é cortado no lugar, puxando o resto da faixa.
   */
  /** o que o corte por silêncio atinge: a seleção, a narração da timeline ou os arquivos da pasta Narração */
  const silenceSources = () => {
    const d = dataRef.current
    const isAuto = (id: string) => !!d.tracks.find((t) => t.id === id)?.auto
    const narrBins = new Set(d.bins.filter((b) => b.role === 'narration').flatMap((b) => [...subtree(b.id)]))
    const hasAudio = (c: MontageClip) => !!mediaRef.current.get(c.media)?.hasAudio
    let sources = d.clips.filter((c) => selected.includes(c.id) && hasAudio(c))
    let scope = `${sources.length} corte${sources.length > 1 ? 's' : ''} selecionado${sources.length > 1 ? 's' : ''}`
    if (!sources.length) {
      scope = 'a narração toda da timeline'
      sources = d.clips.filter((c) => hasAudio(c) && !isAuto(c.track) && narrBins.has(mediaRef.current.get(c.media)?.bin ?? ''))
      if (!sources.length) {
        scope = 'os arquivos da pasta Narração'
        let t = 0
        sources = d.media
          .filter((m) => narrBins.has(m.bin) && m.hasAudio)
          .map((m) => {
            const c: MontageClip = { id: uid(), track: '', media: m.id, start: t, in: 0, out: m.duration }
            t += m.duration
            return c
          })
      }
    }
    return { sources, scope, isAuto }
  }
  /** carrega as ondas (o corte e a calibração olham pra elas) */
  const loadWaves = async (sources: MontageClip[]) => {
    setBusy({ label: 'Lendo as ondas…', pct: null })
    try {
      for (const id of new Set(sources.map((c) => c.media))) {
        const m = mediaRef.current.get(id)
        if (m) await engine.load(m).catch(() => null)
      }
    } finally {
      setBusy(null)
    }
  }
  // painel de calibração: carrega as ondas ao abrir e mostra quanto sairia com os ajustes atuais
  const [silWaves, setSilWaves] = useState(0)
  useEffect(() => {
    if (!silOpen) return
    const { sources } = silenceSources()
    if (!sources.length || sources.every((c) => engine.get(c.media)?.peaks)) return
    loadWaves(sources).then(() => setSilWaves((v) => v + 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [silOpen])
  /** calibração ao vivo (chamada no desenho do painel; silWaves muda quando as ondas chegam) */
  const silenceInfo = () => {
    const { sources, scope } = silenceSources()
    const peaksOf = (id: string) => engine.get(id)?.peaks
    return { scope, n: sources.length, waves: silWaves, stats: silenceStats(sources, peaksOf, silOpts), suggest: suggestThreshold(sources, peaksOf) }
  }

  const cutSilence = async () => {
    const { sources, isAuto } = silenceSources()
    if (!sources.length) return setNormMsg('Nada pra cortar: selecione cortes com áudio ou ponha a narração na pasta Narração.')
    engine.pause()
    setPlaying(false)
    await loadWaves(sources)
    const peaksOf = (id: string) => engine.get(id)?.peaks
    if (!sources.some((c) => peaksOf(c.media))) return setNormMsg('As ondas ainda não carregaram (o ffmpeg está instalado?).')
    const cur = dataRef.current
    const inPlace = sources.every((c) => c.track && (isAuto(c.track) || mediaRef.current.get(c.media)?.kind === 'video'))
    let tracks = cur.tracks
    let clips: MontageClip[]
    let removed = 0
    if (inPlace) {
      // corta no lugar, faixa por faixa, e puxa o que vem depois
      const ids = new Set(sources.map((c) => c.id))
      clips = cur.clips.filter((c) => !ids.has(c.id))
      for (const track of new Set(sources.map((c) => c.track))) {
        const src = sources.filter((c) => c.track === track)
        const r = silenceCut(cur, src, track, peaksOf, silOpts)
        removed += r.removed
        const last = Math.max(...src.map(clipEndT))
        const newEnd = r.clips.length ? clipEndT(r.clips[r.clips.length - 1]) : Math.min(...src.map((c) => c.start))
        const shift = newEnd - last
        clips = clips.map((c) => (c.track === track && c.start >= last - 0.001 ? { ...c, start: c.start + shift } : c))
        clips.push(...r.clips)
      }
    } else {
      let dest = tracks.find((t) => t.auto)
      if (dest && cur.clips.some((c) => c.track === dest!.id) && !confirm('Substituir o que está na faixa "Corte automático" pelo corte por silêncio? As gravações originais ficam como estão.')) return
      if (!dest) {
        dest = { id: uid(), kind: 'audio', name: 'Corte automático', auto: true }
        const srcTrack = sources.find((c) => c.track)?.track
        const at = srcTrack ? tracks.findIndex((t) => t.id === srcTrack) + 1 : tracks.length
        tracks = [...tracks.slice(0, at), dest, ...tracks.slice(at)]
      }
      const srcTracks = new Set(sources.map((c) => c.track).filter(Boolean))
      tracks = tracks.map((t) => (srcTracks.has(t.id) ? { ...t, muted: true } : t.id === dest!.id ? { ...t, muted: false } : t))
      const r = silenceCut(cur, sources, dest.id, peaksOf, silOpts)
      removed = r.removed
      clips = [...cur.clips.filter((c) => c.track !== dest!.id), ...r.clips]
    }
    change({ ...cur, tracks, clips })
    setSelected([])
    setNormMsg(`Corte por silêncio: ${removed.toFixed(1)}s de silêncio fora · Ctrl+Z desfaz`)
  }

  /** altura de todas as faixas de áudio (pra enxergar melhor os picos) */
  const resizeAudio = (f: number) => {
    const d = dataRef.current
    change(
      { ...d, tracks: d.tracks.map((t) => (t.kind === 'audio' ? { ...t, height: Math.round(Math.max(TRACK_MIN_H, Math.min(TRACK_MAX_H, trackHeight(t) * f))) } : t)) },
      'audio-h'
    )
  }

  const jumpCut = (dir: 1 | -1) => {
    const t = posRef.current
    const edges = [...new Set(data.clips.flatMap((c) => [c.start, clipEndT(c)]))].sort((a, b) => a - b)
    const n = dir > 0 ? edges.find((e) => e > t + 0.01) : [...edges].reverse().find((e) => e < t - 0.01)
    if (n !== undefined) seek(n)
  }

  // ---------- blocos de instrução ----------
  const [blockSel, setBlockSel] = useState<string | null>(null)
  const [blockOpen, setBlockOpen] = useState<string | null>(null)
  const [blockBusy, setBlockBusy] = useState<BlockBusy | null>(null)
  const [blockMenu, setBlockMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  useEffect(() => {
    if (!blockMenu) return
    const close = () => setBlockMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [blockMenu])

  const selectClips = (ids: string[]) => {
    setSelected(ids)
    setBlockSel(null)
    setGap(null)
  }
  const selectBlock = (id: string | null) => {
    setBlockSel(id)
    if (id) {
      setSelected([])
      setGap(null)
    }
  }
  // ---------- vão vazio entre cortes: clique seleciona, Delete fecha ----------
  const [gap, setGap] = useState<GapSel | null>(null)
  /** fecha o vão: tudo o que vem depois dele na faixa (cortes e blocos) anda pra trás junto */
  const closeGap = (g: GapSel) => {
    const d = dataRef.current
    const span = findGap(d, g.track, g.t)
    setGap(null)
    if (!span) return
    const len = span.end - span.start
    const after = (track: string, start: number) => track === g.track && start >= span.end - 0.001
    change({
      ...d,
      clips: d.clips.map((c) => (after(c.track, c.start) ? { ...c, start: Math.max(0, c.start - len) } : c)),
      blocks: (d.blocks ?? []).map((b) => (after(b.track, b.start) ? { ...b, start: Math.max(0, b.start - len), end: Math.max(0, b.end - len) } : b))
    })
  }
  const blocks = data.blocks ?? []
  const curBlock = blocks.find((b) => b.id === blockSel) ?? null
  const openBlock = blocks.find((b) => b.id === blockOpen) ?? null
  const patchBlock = (id: string, p: Partial<InstructionBlock>, gesture?: string) => {
    const d = dataRef.current
    change({ ...d, blocks: (d.blocks ?? []).map((b) => (b.id === id ? { ...b, ...p } : b)) }, gesture)
  }
  /** bloco novo: no tempo dos cortes selecionados, ou 5 s a partir do playhead, na faixa de vídeo de cima */
  const addBlock = (at?: { track: string; t: number }) => {
    const d = dataRef.current
    const tr = at ? d.tracks.find((t) => t.id === at.track) : d.tracks.find((t) => t.kind === 'video')
    if (!tr) return
    const picked = at ? [] : d.clips.filter((c) => selected.includes(c.id))
    const s = picked.length ? Math.min(...picked.map((c) => c.start)) : (at?.t ?? posRef.current)
    const e = picked.length ? Math.max(...picked.map(clipEndT)) : s + 5
    const b = newBlock(tr.id, s, e)
    change({ ...d, blocks: [...(d.blocks ?? []), b] })
    selectBlock(b.id)
  }
  const removeBlock = (id: string) => {
    const d = dataRef.current
    change({ ...d, blocks: (d.blocks ?? []).filter((b) => b.id !== id) })
    if (blockSel === id) setBlockSel(null)
    if (blockOpen === id) setBlockOpen(null)
  }
  useEffect(() => {
    if (active) api.onMotionPreviewProgress((p) => setBlockBusy((b) => (b && b.id === p.block ? { ...b, label: p.stage === 'vídeo' ? 'Montando o vídeo…' : b.label, pct: p.pct } : b)))
  }, [active])
  const blockHeard = useBlockHeard(data, lang)
  /** Cancelar da prévia: para de esperar o Whisper (a leitura continua na fila), corta o pedido ao Claude e para a gravação */
  const blockAbort = useRef<AbortController | null>(null)
  const cancelBlock = () => {
    blockAbort.current?.abort()
    if (blockBusy) api.motionTrainCancel(blockBusy.id)
    api.motionPreviewCancel()
    setBlockBusy((b) => (b ? { ...b, label: 'Cancelando…', pct: null } : b))
  }
  /** janela do bloco aberta agora (a prévia continua com ela fechada; aí avisa quando fica pronta) */
  const blockOpenRef = useRef(blockOpen)
  blockOpenRef.current = blockOpen
  const [blockNote, setBlockNote] = useState<{ id: string; text: string } | null>(null)
  useEffect(() => {
    if (!blockNote) return
    const t = setTimeout(() => setBlockNote(null), 12000)
    return () => clearTimeout(t)
  }, [blockNote])
  /** prévia do bloco; com `tweak`, pede um ajuste em cima da prévia atual (a conversa fica no bloco) */
  const makePreview = async (id: string, tweak?: { text: string; files: Attachment[] }) => {
    const b = (dataRef.current.blocks ?? []).find((x) => x.id === id)
    if (!b || blockBusy) return
    const tweaks = tweak ? [...(b.tweaks ?? []), { id: uid(), at: new Date().toISOString(), ...tweak }] : undefined
    const t0 = Date.now()
    setBlockBusy({ id, label: 'Preparando…', pct: null, t0 })
    const ac = new AbortController()
    blockAbort.current = ac
    try {
      const preview = await generatePreview({
        block: b,
        data: dataRef.current,
        engine,
        dur,
        script: getBlocks(),
        lang,
        format: blockFormat,
        dir,
        onStage: (label, pct, span, frames) => setBlockBusy((cur) => (cur?.label === 'Cancelando…' ? cur : { id, label, pct, span, t0, frames })),
        signal: ac.signal,
        adjust: tweaks ? { tweaks } : undefined
      })
      // refazer do zero esquece a conversa de ajustes
      patchBlock(id, { preview, approved: false, tweaks })
      if (blockOpenRef.current !== id) setBlockNote({ id, text: `Prévia de ${blockLabel(b)} pronta` })
    } catch (e) {
      const msg = (e as Error).message
      if (msg !== 'Cancelado.') alert('Não deu pra fazer a prévia: ' + msg)
    } finally {
      blockAbort.current = null
      setBlockBusy(null)
    }
  }
  // ---------- editor do motion aprovado (duplo clique no clipe) ----------
  const [motionEdit, setMotionEdit] = useState<{ clipId: string; block: InstructionBlock; pending: boolean } | null>(null)
  const openMotionEdit = async (c: MontageClip) => {
    let d = dataRef.current
    const m = d.media.find((x) => x.id === c.media)
    if (!m || m.kind !== 'video') return
    // motion aprovado antes de o Typos guardar o HTML no clipe: procura na pasta da prévia dele e guarda
    if (!m.motionHtml && !m.motionBlock && /[\\/]previas[\\/][^\\/]+[\\/][^\\/]+\.mp4$/i.test(m.path)) {
      const html = await api.motionFindHtml(m.path)
      if (!html) return alert('Não achei a animação (o HTML) deste motion na pasta da prévia dele, então não dá pra editar. Refaça o bloco pra editar.')
      d = dataRef.current
      d = { ...d, media: d.media.map((x) => (x.id === m.id ? { ...x, motionHtml: html } : x)) }
      change(d)
    }
    const r = blockFromClip(d, c.id, blockFormat)
    if (r) setMotionEdit({ clipId: c.id, block: r.block, pending: false })
  }
  /** pede a alteração (do trecho marcado ou do clipe todo): sai uma prévia nova, o clipe ainda não muda */
  const motionEditAdjust = async (tweak: { text: string; files: Attachment[] }, range: [number, number] | null) => {
    const me = motionEdit
    const base = me && blockFromClip(dataRef.current, me.clipId, blockFormat)
    if (!me || !base || blockBusy) return
    const b = me.block
    const tweaks = [...(b.tweaks ?? []), { id: uid(), at: new Date().toISOString(), text: rangeTweak(tweak.text, range), files: tweak.files }]
    const t0 = Date.now()
    setBlockBusy({ id: b.id, label: 'Preparando…', pct: null, t0 })
    const ac = new AbortController()
    blockAbort.current = ac
    try {
      const preview = await generatePreview({
        block: b,
        data: base.data,
        engine,
        dur,
        script: getBlocks(),
        lang,
        format: blockFormat,
        dir,
        onStage: (label, pct, span, frames) => setBlockBusy((cur) => (cur?.label === 'Cancelando…' ? cur : { id: b.id, label, pct, span, t0, frames })),
        signal: ac.signal,
        adjust: { tweaks }
      })
      setMotionEdit((m) => (m && m.clipId === me.clipId ? { ...m, block: { ...m.block, preview, tweaks }, pending: true } : m))
    } catch (e) {
      const msg = (e as Error).message
      if (msg !== 'Cancelado.') alert('Não deu pra fazer a alteração: ' + msg)
    } finally {
      blockAbort.current = null
      setBlockBusy(null)
    }
  }
  /** aplica: grava a animação alterada na resolução do projeto e troca o clipe na timeline (Ctrl+Z desfaz) */
  const motionEditApply = async () => {
    const me = motionEdit
    const base = me && blockFromClip(dataRef.current, me.clipId, blockFormat)
    if (!me || !base || !me.block.preview || blockBusy) return
    const b = me.block
    const t0 = Date.now()
    setBlockBusy({ id: b.id, label: 'Preparando o clipe…', pct: null, t0 })
    try {
      const video = await generateClip({ block: b, data: base.data, engine, dur, format: blockFormat, dir, onStage: (label, pct, span, frames) => setBlockBusy({ id: b.id, label, pct, span, t0, frames }) })
      const info = await api.probeMedia(video)
      if ('error' in info) throw new Error(info.error)
      const d = dataRef.current
      const c = d.clips.find((x) => x.id === me.clipId)
      const old = c && d.media.find((x) => x.id === c.media)
      if (!c || !old) throw new Error('O clipe saiu da timeline enquanto a alteração era gravada.')
      const m: MontageMedia = {
        ...old,
        id: uid(),
        path: video,
        duration: info.duration || old.duration,
        hasAudio: info.hasAudio,
        width: info.width,
        height: info.height,
        fps: info.fps,
        motionHtml: b.preview!.html,
        motionBlock: { ...b, approved: true }
      }
      change({ ...d, media: [...d.media, m], clips: d.clips.map((x) => (x.id === c.id ? { ...x, media: m.id, out: Math.min(x.out, m.duration) } : x)) })
      const r = blockFromClip({ ...d, media: [...d.media, m], clips: d.clips.map((x) => (x.id === c.id ? { ...x, media: m.id } : x)) }, c.id, blockFormat)
      setMotionEdit((cur) => (cur && cur.clipId === me.clipId && r ? { ...cur, block: r.block, pending: false } : cur))
    } catch (e) {
      const msg = (e as Error).message
      if (msg !== 'Cancelado.') alert('Não deu pra aplicar a alteração: ' + msg)
    } finally {
      setBlockBusy(null)
    }
  }
  const motionEditDiscard = () => {
    const me = motionEdit
    const r = me && blockFromClip(dataRef.current, me.clipId, blockFormat)
    if (me && r) setMotionEdit({ ...me, block: r.block, pending: false })
  }

  /**
   * Aprova a prévia: grava a mesma animação na resolução do projeto (com o áudio do trecho), põe o clipe
   * na timeline no lugar do bloco e guarda o motion na memória do formato. Ctrl+Z traz o bloco de volta.
   */
  const approveBlock = async (id: string) => {
    const b = (dataRef.current.blocks ?? []).find((x) => x.id === id)
    if (!b?.preview || blockBusy) return
    if (previewStale(b) && !confirm('O bloco mudou depois desta prévia. Importar a prévia assim mesmo, com o tempo atual do bloco?')) return
    const t0 = Date.now()
    setBlockBusy({ id, label: 'Preparando o clipe…', pct: null, t0 })
    try {
      const video = await generateClip({ block: b, data: dataRef.current, engine, dur, format: blockFormat, dir, onStage: (label, pct, span, frames) => setBlockBusy({ id, label, pct, span, t0, frames }) })
      const info = await api.probeMedia(video)
      if ('error' in info) throw new Error(info.error)
      const d = dataRef.current
      const len = blockDur(b)
      const bins = d.bins.some((x) => x.id === MOTION_BIN) ? d.bins : [...d.bins, { id: MOTION_BIN, name: 'Motion aprovado', role: 'custom' as const }]
      const m: MontageMedia = {
        id: uid(),
        bin: MOTION_BIN,
        path: video,
        name: blockLabel(b) + '.mp4',
        kind: 'video',
        duration: info.duration || len,
        hasAudio: info.hasAudio,
        hasVideo: true,
        width: info.width,
        height: info.height,
        fps: info.fps,
        motionHtml: b.preview.html,
        motionBlock: { ...b, approved: true }
      }
      // na faixa do bloco; se já tem corte ali, na primeira faixa de vídeo livre acima (ou numa nova, em cima de tudo)
      const free = (tid: string) => !d.clips.some((c) => c.track === tid && c.start < b.end - 0.001 && clipEndT(c) > b.start + 0.001)
      const vids = d.tracks.filter((t) => t.kind === 'video')
      const at = Math.max(0, vids.findIndex((t) => t.id === b.track))
      let tracks = d.tracks
      let track = [vids[at], ...vids.slice(0, at).reverse()].find((t) => t && free(t.id))?.id
      if (!track) {
        const n = vids.length + 1
        const t = { id: 'V' + n + '-' + uid().slice(0, 4), kind: 'video' as const, name: `V${n} · Motion` }
        tracks = [t, ...tracks]
        track = t.id
      }
      // o som do clipe é a narração do trecho, que já está nas faixas de áudio: fica desligado (dá pra ligar no inspetor)
      const clip: MontageClip = { id: uid(), track, media: m.id, start: b.start, in: 0, out: Math.min(m.duration, len), audioOff: true }
      change({ ...d, bins, tracks, media: [...d.media, m], clips: [...d.clips, clip], blocks: (d.blocks ?? []).filter((x) => x.id !== id) })
      setBlockSel((s) => (s === id ? null : s))
      setBlockOpen((s) => (s === id ? null : s))
      setSelected([clip.id])
      if (format && onFormatChange) {
        const html = await fetch(fileUrl(b.preview.html))
          .then((r) => r.text())
          .catch(() => '')
        const item = await memoryFromBlock(b, html)
        const motion = format.motion ?? { refs: [] }
        onFormatChange({ ...format, motion: { ...motion, memory: [...(motion.memory ?? []), item] } })
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg !== 'Cancelado.') alert('Não deu pra gerar o clipe: ' + msg)
    } finally {
      setBlockBusy(null)
    }
  }

  // ---------- atalhos (só com a Montagem na frente) ----------
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      // qualquer campo de texto ou janelinha (nome de pasta, configurações…) usa o teclado dele;
      // o resto (até o texto escondido do roteiro) é nosso
      const el = e.target as HTMLElement
      if (el.closest?.('input, textarea, select, [role="dialog"], .ask-modal, .modal, .modal-backdrop')) return
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
      if ((e.ctrlKey || e.metaKey) && k === 'a') {
        e.preventDefault()
        e.stopPropagation()
        return setSelected(dataRef.current.clips.map((c) => c.id))
      }
      const run = (fn: () => void) => {
        e.preventDefault()
        e.stopPropagation()
        fn()
      }
      // as teclas trocáveis (Ajuda → Atalhos do teclado)
      if (isKey(e, 'mt.play')) return run(recRef.current ? stopRec : rehearseRef.current ? () => setRehearse(false) : toggle)
      if (isKey(e, 'mt.record')) return run(startRec)
      if (isKey(e, 'mt.select')) return run(() => setTool('select'))
      if (isKey(e, 'mt.blade')) return run(() => setTool((t) => (t === 'blade' ? 'select' : 'blade')))
      if (isKey(e, 'mt.split')) return run(splitAtPlayhead)
      if (isKey(e, 'mt.lettering')) return run(addLettering)
      if (isKey(e, 'mt.splice')) return run(() => applySplice(false))
      if (isKey(e, 'mt.block')) return run(addBlock)
      if (isKey(e, 'mt.zoomIn')) return run(() => zoomBy(1.4))
      if (isKey(e, 'mt.zoomOut')) return run(() => zoomBy(1 / 1.4))
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if ((k === 'arrowup' || k === 'arrowdown') && (recRef.current || rehearseRef.current))
        run(() => setPrompterWpm(prompterWpmRef.current + (k === 'arrowup' ? 10 : -10)))
      else if ((k === 'delete' || k === 'backspace') && blockSel) run(() => removeBlock(blockSel))
      else if ((k === 'delete' || k === 'backspace') && gap && !selected.length) run(() => closeGap(gap))
      else if (k === 'escape' && gap) run(() => setGap(null))
      else if (k === 'delete' || k === 'backspace') run(() => remove(e.shiftKey))
      else if (k === 'arrowleft') run(() => (e.shiftKey ? jumpCut(-1) : seek(posRef.current - 1 / 30)))
      else if (k === 'arrowright') run(() => (e.shiftKey ? jumpCut(1) : seek(posRef.current + 1 / 30)))
      else if (k === 'home') run(() => seek(0))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // ---------- mídia ----------
  const importPaths = async (paths: string[], toBin: string): Promise<MontageMedia[]> => {
    const already = dataRef.current.media.filter((m) => paths.includes(m.path) && m.bin === toBin)
    const fresh = paths.filter((p) => !already.some((m) => m.path === p))
    if (!fresh.length) return already
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
    return [...already, ...added]
  }

  const addBin = async () => {
    const name = await askText('Nome da pasta:', 'Nova pasta')
    if (!name?.trim()) return
    const b: MontageBin = { id: uid(), name: name.trim(), role: 'custom' }
    change({ ...data, bins: [...data.bins, b] })
    setBin(b.id)
  }

  const curBin = data.bins.find((b) => b.id === bin) ?? data.bins[0]
  const items = data.media.filter((m) => m.bin === curBin?.id)
  /** caminho da aba do topo até a pasta atual */
  const pathOf = (id: string) => {
    const out: MontageBin[] = []
    let b = data.bins.find((x) => x.id === id)
    while (b) {
      out.unshift(b)
      b = b.parent ? data.bins.find((x) => x.id === b!.parent) : undefined
    }
    return out
  }
  const curPath = curBin ? pathOf(curBin.id) : []
  const curRoot = curPath[0] ?? curBin
  /** a pasta e todas as de dentro dela */
  const subtree = (id: string) => {
    const ids = new Set([id])
    let grew = true
    while (grew) {
      grew = false
      for (const b of data.bins) if (b.parent && ids.has(b.parent) && !ids.has(b.id)) (ids.add(b.id), (grew = true))
    }
    return ids
  }
  const children = data.bins.filter((b) => b.parent === curBin?.id)
  const countIn = (id: string) => {
    const ids = subtree(id)
    return data.media.filter((m) => ids.has(m.bin)).length
  }
  // ---------- limpar arquivos que a timeline não usa ----------
  const usedMedia = new Set(data.clips.map((c) => c.media))
  /** os arquivos não usados da pasta (e das de dentro), ou de todas */
  const unusedIn = (binId: string | null) => {
    const scope = binId ? subtree(binId) : null
    return data.media.filter((m) => !usedMedia.has(m.id) && (!scope || scope.has(m.bin)))
  }
  const cleanUnused = async (binId: string | null) => {
    const d = dataRef.current
    const scope = binId ? subtree(binId) : null
    const used = new Set(d.clips.map((c) => c.media))
    const gone = d.media.filter((m) => !used.has(m.id) && (!scope || scope.has(m.bin)))
    if (!gone.length) return
    const norm = (x: string) => x.replace(/\\/g, '/').toLowerCase()
    const root = norm(dir).replace(/\/$/, '') + '/'
    // nunca vai pra Lixeira: o que está fora da pasta do projeto, o que outra timeline (recortes) usa,
    // o mesmo arquivo importado de novo e usado, e anexo de bloco de instrução
    const keep = new Set([...(usedElsewhere?.() ?? [])].map(norm))
    for (const m of d.media) if (used.has(m.id)) keep.add(norm(m.path))
    const atts = (d.blocks ?? []).flatMap((b) => b.attachments.map((a) => norm(a.path)))
    const toTrash = gone.filter((m) => {
      const p = norm(m.path)
      return p.startsWith(root) && !keep.has(p) && !atts.some((a) => p.endsWith(a))
    })
    const where = binId ? `da pasta "${d.bins.find((b) => b.id === binId)?.name}"` : 'de todas as pastas'
    const msg =
      `Tirar ${gone.length} arquivo(s) que a timeline não usa ${where}?\n\n` +
      (toTrash.length ? `${toTrash.length} estão dentro da pasta do projeto e vão pra Lixeira (dá pra recuperar por lá).\n` : '') +
      (gone.length - toTrash.length ? `${gone.length - toTrash.length} ficam onde estão no PC: só saem da lista.\n` : '')
    if (!confirm(msg)) return
    const ids = new Set(gone.map((m) => m.id))
    change({ ...d, media: d.media.filter((m) => !ids.has(m.id)) })
    if (source && ids.has(source.id)) setSource(null)
    if (!toTrash.length) return
    const r = await api.trashProjectFiles(dir, toTrash.map((m) => m.path))
    if (r.errors.length) alert(`${r.errors.length} arquivo(s) não foram pra Lixeira (saíram só da lista):\n` + r.errors.slice(0, 8).join('\n'))
  }
  const moveMedia = (mediaId: string, toBin: string) =>
    change({ ...dataRef.current, media: dataRef.current.media.map((m) => (m.id === mediaId ? { ...m, bin: toBin } : m)) })
  /** solta arquivo do Explorer (importa) ou item da lista (move) numa pasta */
  const dropOn = (e: React.DragEvent, toBin: string) => {
    const id = e.dataTransfer.getData(MEDIA_MIME)
    if (id) {
      e.preventDefault()
      e.stopPropagation()
      return moveMedia(id, toBin)
    }
    dropFiles(e, toBin)
  }
  const accepts = (e: React.DragEvent) => (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(MEDIA_MIME)) && e.preventDefault()
  const newFolder = async () => {
    const name = await askText('Nome da pasta:', 'Nova pasta')
    if (!name?.trim() || !curBin) return
    const b: MontageBin = { id: uid(), name: name.trim(), role: 'custom', parent: curBin.id }
    change({ ...dataRef.current, bins: [...dataRef.current.bins, b] })
  }
  // ---------- baixar do YouTube (yt-dlp) pro Material bruto ----------
  const [ytOpen, setYtOpen] = useState(false)
  // ---------- letterings dos capítulos (marcações na timeline) ----------
  const letteringDur = data.letteringDur ?? 3
  const chapters = () => getBlocks().filter((b) => b.type === 'chapter' && b.text.trim())
  const [markMenu, setMarkMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  useEffect(() => {
    if (!markMenu) return
    const close = () => setMarkMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [markMenu])
  /** marca no cursor o lettering do próximo capítulo que ainda não tem */
  const addLettering = (at?: number) => {
    const chs = chapters()
    if (!chs.length) return alert('O roteiro não tem capítulos. Crie um capítulo (Ctrl+1) pra marcar o lettering dele.')
    const cur = dataRef.current
    const marked = new Set((cur.markers ?? []).map((m) => m.block))
    const ch = chs.find((c) => !marked.has(c.index)) ?? chs[0]
    const mk: MontageMarker = { id: uid(), kind: 'lettering', t: at ?? posRef.current, dur: cur.letteringDur ?? 3, block: ch.index, label: ch.text.trim() }
    change({ ...cur, markers: [...(cur.markers ?? []), mk].sort((a, b) => a.t - b.t) })
  }
  const patchMarker = (id: string, patch: Partial<MontageMarker>) =>
    change({ ...dataRef.current, markers: (dataRef.current.markers ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)) })
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [areaMenu, setAreaMenu] = useState<{ x: number; y: number } | null>(null)
  // ---------- o Claude procura bibliotecas de som no PC ----------
  type SfxLib = { path: string; name: string; program: string; why: string; files: number }
  const [sfxFind, setSfxFind] = useState<{ busy: boolean; libs?: SfxLib[]; pick?: Set<string>; error?: string; t0?: number } | null>(null)
  const [sfxElapsed, setSfxElapsed] = useState(0)
  useEffect(() => {
    if (!sfxFind?.busy) return
    const t = setInterval(() => setSfxElapsed(Math.round((Date.now() - (sfxFind.t0 ?? Date.now())) / 1000)), 1000)
    return () => clearInterval(t)
  }, [sfxFind?.busy])
  const findSfx = async () => {
    setSfxFind({ busy: true, t0: Date.now() })
    const r = await api.findSfxLibraries()
    if ('error' in r) return setSfxFind({ busy: false, error: r.error })
    const linked = new Set(dataRef.current.bins.map((b) => b.linked).filter(Boolean))
    const libs = r.libs.filter((l) => !linked.has(l.path))
    setSfxFind({ busy: false, libs, pick: new Set(libs.map((l) => l.path)) })
  }
  /** as escolhidas viram pastas do PC favoritas dentro da categoria SFX (referências essenciais de som) */
  const linkSfx = () => {
    const sfxRoot = dataRef.current.bins.find((b) => b.role === 'sfx' && !b.parent)
    if (!sfxRoot || !sfxFind?.libs) return
    const add: MontageBin[] = sfxFind.libs
      .filter((l) => sfxFind.pick?.has(l.path))
      .map((l) => ({ id: uid(), name: l.program && !l.name.includes(l.program) ? `${l.name} · ${l.program}` : l.name, role: 'custom', parent: sfxRoot.id, linked: l.path, star: true }))
    change({ ...dataRef.current, bins: [...dataRef.current.bins, ...add] })
    setSfxFind(null)
  }
  const [catsOpen, setCatsOpen] = useState(false)
  useEffect(() => {
    if (!areaMenu) return
    const close = () => setAreaMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [areaMenu])

  // projetos antigos ganham a categoria SFX
  useEffect(() => {
    if (!data.bins.some((b) => b.role === 'sfx' && !b.parent)) change({ ...data, bins: [...data.bins, { id: 'sfx', name: 'SFX', role: 'sfx' }] })
  }, [])

  const toggleStar = (id: string) => change({ ...dataRef.current, bins: dataRef.current.bins.map((b) => (b.id === id ? { ...b, star: !b.star } : b)) })

  /** vincula uma pasta do PC dentro da pasta atual: navega nela sem copiar nada */
  const linkPcFolder = async () => {
    const p = await api.pickFolder()
    if (!p || !curBin) return
    const b: MontageBin = { id: uid(), name: p.split(/[\\/]/).pop() || p, role: 'custom', parent: curBin.id, linked: p }
    change({ ...dataRef.current, bins: [...dataRef.current.bins, b] })
    setBin(b.id)
  }

  // ---------- navegando dentro de uma pasta do PC ----------
  const [pcPath, setPcPath] = useState<string | null>(null)
  const [pcList, setPcList] = useState<{ dirs: { name: string; path: string }[]; files: { name: string; path: string; kind: 'image' | 'audio' | 'video' }[] } | { error: string } | null>(null)
  useEffect(() => {
    setPcPath(curBin?.linked ?? null)
  }, [curBin?.id])
  useEffect(() => {
    setPcList(null)
    if (pcPath) api.listDir(pcPath).then(setPcList)
  }, [pcPath])

  /** soltou um arquivo do PC na timeline: entra no projeto (na pasta atual) e vira corte */
  const dropPcFile = async (path: string, kind: 'video' | 'audio', trackId: string | null, start: number) => {
    const [m] = await importPaths([path], curBin?.id ?? data.bins[0].id)
    if (!m) return
    const d = dataRef.current
    const track = trackId ?? d.tracks.find((t) => t.kind === kind)?.id
    if (!track) return
    const clip: MontageClip = { id: uid(), track, media: m.id, start, in: 0, out: m.kind === 'image' ? 5 : m.duration }
    change({ ...d, clips: [...d.clips, clip] })
    setSelected([clip.id])
  }
  useEffect(() => {
    if (!folderMenu) return
    const close = () => setFolderMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [folderMenu])
  const renameFolder = async (id: string) => {
    const b = data.bins.find((x) => x.id === id)
    const name = b && await askText('Nome da pasta:', b.name)
    if (name?.trim()) change({ ...dataRef.current, bins: dataRef.current.bins.map((x) => (x.id === id ? { ...x, name: name.trim() } : x)) })
  }
  /** apagar subpasta: o que tinha dentro (arquivos e pastas) sobe pra pasta de cima */
  const deleteFolder = (id: string) => {
    const d = dataRef.current
    const b = d.bins.find((x) => x.id === id)
    if (!b?.parent) return
    if (!confirm(`Apagar a pasta "${b.name}"? O que tem dentro sobe pra "${d.bins.find((x) => x.id === b.parent)?.name}".`)) return
    change({
      ...d,
      bins: d.bins.filter((x) => x.id !== id).map((x) => (x.parent === id ? { ...x, parent: b.parent } : x)),
      media: d.media.map((m) => (m.bin === id ? { ...m, bin: b.parent! } : m))
    })
    if (bin === id) setBin(b.parent)
  }

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
        {poolTop}
        <div className="mt-bins">
          {data.bins.filter((b) => !b.parent).map((b) => (
            <button
              key={b.id}
              className={'mt-bin' + (b.id === curRoot?.id ? ' on' : '') + ' r-' + b.role}
              style={b.color ? ({ ['--cc' as any]: b.color } as React.CSSProperties) : undefined}
              onClick={() => setBin(b.id)}
              onDoubleClick={async () => {
                if (b.role !== 'custom') return
                const name = await askText('Nome da pasta:', b.name)
                if (name?.trim()) change({ ...data, bins: data.bins.map((x) => (x.id === b.id ? { ...x, name: name.trim() } : x)) })
              }}
              onDragOver={accepts}
              onDrop={(e) => dropOn(e, b.id)}
              title={b.role === 'narration' ? 'Áudios e vídeos de narração: vão pro corte automático' : b.role === 'raw' ? 'Todo o material além da voz' : 'Duplo clique renomeia'}
            >
              {b.name}
              <small>{countIn(b.id)}</small>
            </button>
          ))}
          <button className="mt-bin add" onClick={() => setCatsOpen(true)} title="Categorias: quantas, nome, cor e ordem">
            <Settings size={13} />
          </button>
          {(() => {
            const n = unusedIn(null).length
            return (
              <button
                className="mt-bin add mt-clean-all"
                disabled={!n}
                onClick={() => cleanUnused(null)}
                title={n ? `Limpar os ${n} arquivo(s) que a timeline não usa, em todas as pastas` : 'Todos os arquivos estão na timeline'}
              >
                <Trash2 size={13} /> {n ? `Limpar não usados (${n})` : ''}
              </button>
            )
          })()}
        </div>

        <div className="mt-pool-bar">
          <button className="btn small" onClick={async () => importPaths(await api.pickMedia(), curBin.id)} disabled={!ffmpeg}>
            <Import size={13} /> Importar
          </button>
          <button className="btn small" onClick={newFolder} title={`Nova pasta dentro de "${curBin?.name}"`}>
            <FolderPlus size={13} /> Nova pasta
          </button>
          {curRoot?.role === 'sfx' && (
            <button className="btn small primary" disabled={!!sfxFind?.busy} onClick={findSfx} title="O Claude procura no PC as bibliotecas de som (Mister Horse, Motion Bro e outras) e vincula aqui como favoritas">
              {sfxFind?.busy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} Procurar bibliotecas de som
            </button>
          )}
          {curRoot?.role !== 'narration' && (
            <button className={'btn small' + (ytOpen ? ' primary' : '')} onClick={() => setYtOpen((o) => !o)} title="Baixar vídeo do YouTube (ou outro site) pra esta pasta">
              <Download size={13} /> YouTube
            </button>
          )}
          {curRoot?.role === 'narration' && (
            <button
              className="btn small primary"
              disabled={!countIn(curRoot.id) || !!busy || !ffmpeg}
              onClick={() => runAutoCut(curRoot)}
              title="Transcreve a narração, compara com o roteiro e monta a timeline com os cortes"
            >
              {busy ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />} Corte automático
            </button>
          )}
          {curBin &&
            (() => {
              const n = unusedIn(curBin.id).length
              return (
                <button
                  className="icon-btn mt-clean"
                  disabled={!n}
                  onClick={() => cleanUnused(curBin.id)}
                  title={n ? `Limpar ${n} arquivo(s) desta pasta que a timeline não usa` : 'Nenhum arquivo sem uso nesta pasta'}
                >
                  <Trash2 size={14} />
                  {n > 0 && <small>{n}</small>}
                </button>
              )
            })()}
          {curBin?.role === 'custom' && !curBin.parent && (
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
        {sfxFind && curRoot?.role === 'sfx' && (
          <div className="mt-sfxfind">
            {sfxFind.busy ? (
              <span className="small">
                <Loader2 size={12} className="spin" /> O Claude está procurando bibliotecas de som no seu PC… {sfxElapsed}s (só lendo pastas, não muda nada)
              </span>
            ) : sfxFind.error ? (
              <span className="small error">{sfxFind.error}</span>
            ) : !sfxFind.libs?.length ? (
              <span className="small muted">Nenhuma biblioteca nova achada (as que já estão vinculadas não aparecem).</span>
            ) : (
              <>
                <span className="small">
                  <b>{sfxFind.libs.length}</b> biblioteca(s) achada(s). Marque as que vão virar referência de som:
                </span>
                {sfxFind.libs.map((l) => (
                  <label key={l.path} className="mt-sfxlib" title={l.path}>
                    <input
                      type="checkbox"
                      checked={!!sfxFind.pick?.has(l.path)}
                      onChange={(e) =>
                        setSfxFind((f) => {
                          if (!f) return f
                          const pick = new Set(f.pick)
                          if (e.target.checked) pick.add(l.path)
                          else pick.delete(l.path)
                          return { ...f, pick }
                        })
                      }
                    />
                    <span>
                      <b>{l.name}</b> <i>{l.program}</i> · {l.files >= 5000 ? '5000+' : l.files} sons
                      <small>{l.why}</small>
                      <small className="mt-sfxpath">{l.path}</small>
                    </span>
                  </label>
                ))}
                <div className="mt-sfxbtns">
                  <button className="btn small primary" disabled={!sfxFind.pick?.size} onClick={linkSfx}>
                    <Star size={12} /> Vincular {sfxFind.pick?.size ?? 0} como favoritas
                  </button>
                  <button className="btn small" onClick={() => setSfxFind(null)}>
                    Fechar
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {ytOpen && curRoot?.role !== 'narration' && curBin && (
          <YoutubeDownload
            dir={dir}
            hint="Vai pra assets/material-bruto do projeto. Use só o que você tem direito de usar (licença, fair use, comentário)."
            onDone={((toBin) => async (path: string) => {
              await importPaths([path], toBin)
              setRecheck((n) => n + 1)
            })(curBin.id)}
          />
        )}
        {curRoot?.role === 'narration' && wstatus && ffmpeg && (
          <div className="mt-whisper">
            <span>Transcrição</span>
            <select
              value={wstatus.model}
              disabled={!!busy}
              onChange={async (e) => {
                await api.whisperSetModel(e.target.value)
                setWstatus(await api.whisperStatus())
                recheckRead()
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
        {report && !busy && curRoot?.role === 'narration' && (
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
          onContextMenu={(e) => {
            // botão direito no vazio: criar pasta, vincular pasta do PC, importar
            if ((e.target as HTMLElement).closest('.mt-item, .mt-folder, .mt-pc-row')) return
            e.preventDefault()
            setAreaMenu({ x: e.clientX, y: e.clientY })
          }}
        >
          {curPath.length > 1 && (
            <div className="mt-crumbs">
              {curPath.map((b, i) => (
                <span key={b.id}>
                  {i > 0 && <ChevronRight size={11} />}
                  <button className={i === curPath.length - 1 ? 'on' : ''} onClick={() => setBin(b.id)} onDragOver={accepts} onDrop={(e) => dropOn(e, b.id)}>
                    {b.name}
                  </button>
                </span>
              ))}
            </div>
          )}
          {children.map((f) => (
            <div
              key={f.id}
              className="mt-folder"
              onClick={() => setBin(f.id)}
              onDragOver={accepts}
              onDrop={(e) => dropOn(e, f.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setFolderMenu({ x: e.clientX, y: e.clientY, id: f.id })
              }}
              title="Clique pra abrir · arraste arquivos pra cá · botão direito: renomear/apagar"
            >
              <Folder size={15} />
              <span className="mt-item-name">
                {f.name}
                {f.linked && <span className="mt-pc-badge" title={f.linked}>PC</span>}
              </span>
              <span className="mt-item-dur">{f.linked ? '' : countIn(f.id)}</span>
              <button
                className={'mt-star' + (f.star ? ' on' : '')}
                title={f.star ? 'Favorita: o Claude usa com mais frequência' : 'Marcar como favorita (o Claude usa com mais frequência)'}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleStar(f.id)
                }}
              >
                <Star size={13} />
              </button>
            </div>
          ))}
          {curBin?.linked && (
            <div className="mt-pc">
              <div className="mt-pc-head">
                <button
                  className={'mt-star' + (curBin.star ? ' on' : '')}
                  title="Favorita: o Claude usa com mais frequência"
                  onClick={() => toggleStar(curBin.id)}
                >
                  <Star size={13} />
                </button>
                <span title={pcPath ?? ''}>{pcPath && pcPath !== curBin.linked ? pcPath.slice(curBin.linked.length + 1) : 'pasta do PC'}</span>
                {pcPath && pcPath !== curBin.linked && (
                  <button className="btn small" onClick={() => setPcPath(pcPath.replace(/[\\/][^\\/]+$/, ''))}>
                    ↑ voltar
                  </button>
                )}
                <button className="icon-btn" title="Abrir no Explorer" onClick={() => pcPath && api.openPath(pcPath)}>
                  <FolderOpen size={13} />
                </button>
              </div>
              {!pcList ? (
                <div className="mt-note">
                  <Loader2 size={12} className="spin" /> lendo a pasta…
                </div>
              ) : 'error' in pcList ? (
                <div className="mt-note warn">{pcList.error}</div>
              ) : (
                <>
                  {pcList.dirs.map((d) => (
                    <div key={d.path} className="mt-folder mt-pc-row" onClick={() => setPcPath(d.path)}>
                      <Folder size={15} />
                      <span className="mt-item-name">{d.name}</span>
                      <span />
                    </div>
                  ))}
                  {pcList.files.map((f) => (
                    <div
                      key={f.path}
                      className={'mt-item mt-pc-row k-' + f.kind}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(PCFILE_MIME, f.path)
                        e.dataTransfer.effectAllowed = 'copy'
                      }}
                      onDoubleClick={() => setSource({ id: 'pc', bin: curBin.id, path: f.path, name: f.name, kind: f.kind, duration: 0, hasAudio: f.kind !== 'image', hasVideo: f.kind === 'video' })}
                      title={`${f.path}\nArraste pra timeline · duplo clique ouve/vê`}
                    >
                      <span className="mt-item-ico">{f.kind === 'audio' ? <Music size={14} /> : f.kind === 'image' ? <ImageIcon size={14} /> : <Film size={14} />}</span>
                      <span className="mt-item-name">{f.name}</span>
                      <span className="mt-item-dur" />
                    </div>
                  ))}
                  {!pcList.dirs.length && !pcList.files.length && <div className="mt-empty">Pasta vazia (ou sem áudio, vídeo ou imagem).</div>}
                </>
              )}
            </div>
          )}
          {items.length === 0 && children.length === 0 && (
            <div className="mt-empty">
              {curRoot?.role === 'narration'
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
              className={'mt-item k-' + m.kind + (missing.has(m.id) ? ' missing' : '') + (usedMedia.has(m.id) ? '' : ' unused')}
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
              title={`${m.path}\nArraste pra timeline · duplo clique abre no visualizador${usedMedia.has(m.id) ? '' : '\n(não está na timeline)'}`}
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

      {areaMenu && (
        <div className="ctx-menu" style={{ left: areaMenu.x, top: areaMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="ctx-label">{curBin?.name}</div>
          <button
            onClick={() => {
              setAreaMenu(null)
              newFolder()
            }}
          >
            <FolderPlus size={13} /> Nova pasta
          </button>
          <button
            onClick={() => {
              setAreaMenu(null)
              linkPcFolder()
            }}
          >
            <Link2 size={13} /> Vincular pasta do PC…
          </button>
          <button
            onClick={async () => {
              setAreaMenu(null)
              if (curBin) importPaths(await api.pickMedia(), curBin.id)
            }}
          >
            <Import size={13} /> Importar arquivos…
          </button>
        </div>
      )}
      {catsOpen && <CategoriesModal data={data} onClose={() => setCatsOpen(false)} onSave={(bins, media) => change({ ...dataRef.current, bins, media })} />}
      {folderMenu && (
        <div className="ctx-menu" style={{ left: folderMenu.x, top: folderMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button
            onClick={() => {
              renameFolder(folderMenu.id)
              setFolderMenu(null)
            }}
          >
            Renomear
          </button>
          <button
            onClick={() => {
              toggleStar(folderMenu.id)
              setFolderMenu(null)
            }}
          >
            {data.bins.find((b) => b.id === folderMenu.id)?.star ? '☆ Tirar dos favoritos' : '★ Favorita (o Claude usa mais)'}
          </button>
          <button
            className="danger"
            onClick={() => {
              deleteFolder(folderMenu.id)
              setFolderMenu(null)
            }}
          >
            Apagar pasta (o conteúdo sobe)
          </button>
        </div>
      )}

      {/* ---------- visualizador ---------- */}
      <section className="mt-viewer">
        <div
          className={'mt-screen' + (frame ? ' framed' : '') + (view !== 'fit' ? ' zoomed' : '')}
          style={
            {
              ...(frame ? { ['--frame' as any]: frame.replace(':', ' / ') } : {}),
              ['--seq' as any]: `${seqW} / ${seqH}`,
              ['--zh' as any]: view === 'fit' ? undefined : `${Math.round((seqH * view) / (window.devicePixelRatio || 1))}px`
            } as React.CSSProperties
          }
          ref={screenRef}
        >
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
                {prompterBlocks.map((b) => {
                  const props = {
                    'data-block': b.index,
                    className: b.index === prompterFrom ? 'from' : undefined,
                    title: 'Clique pra continuar daqui',
                    onClick: () => {
                      setPrompterFrom(b.index)
                      prompterTo(b.index)
                    }
                  }
                  return b.type === 'chapter' ? (
                    <h4 key={b.index} {...props}>
                      {b.text}
                    </h4>
                  ) : (
                    <p key={b.index} {...props}>
                      {b.text}
                    </p>
                  )
                })}
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
                  setSource(null)
                  if (rehearse) {
                    const at = prompterAt()
                    if (at !== null) setPrompterFrom(at)
                  }
                  setRehearse((v) => !v)
                }}
              >
                {rehearse ? 'Parar ensaio' : 'Ensaiar'}
              </button>
              <label className="mt-prompter-from" title="De onde o teleprompter começa (também dá pra clicar num parágrafo dele enquanto rola)">
                Começar em
                <select value={prompterFrom ?? ''} onChange={(e) => setPrompterFrom(e.target.value === '' ? null : Number(e.target.value))}>
                  <option value="">Início</option>
                  {prompterBlocks.map((b) => (
                    <option key={b.index} value={b.index}>
                      {b.type === 'chapter' ? '■ ' : ''}
                      {b.text.length > 48 ? b.text.slice(0, 48) + '…' : b.text}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <select
            className="mt-view-zoom"
            value={String(view)}
            title={`Tamanho do vídeo no visualizador (${seqW}×${seqH}). Ajustar cabe na tela; 100% é o tamanho real. Ctrl+roda do mouse em cima do vídeo também muda.`}
            onChange={(e) => setView(e.target.value === 'fit' ? 'fit' : Number(e.target.value))}
          >
            <option value="fit">Ajustar</option>
            {VIEW_ZOOMS.map((z) => (
              <option key={z} value={String(z)}>
                {Math.round(z * 100)}%
              </option>
            ))}
          </select>
          <button className="icon-btn" title="Áudio: microfone, saída e níveis" onClick={onAudioSettings}>
            <Settings2 size={15} />
          </button>
        </div>
      </section>

      {/* ---------- inspetor ---------- */}
      <section className="mt-inspector">
        {curBlock ? (
          <BlockInspector
            b={curBlock}
            data={data}
            dir={dir}
            patch={(p, g) => patchBlock(curBlock.id, p, g)}
            busy={blockBusy}
            onGenerate={() => makePreview(curBlock.id)}
            onAdjust={(t) => makePreview(curBlock.id, t)}
            onCancel={cancelBlock}
            onApprove={() => approveBlock(curBlock.id)}
            heard={<BlockHeardRow data={data} b={curBlock} lang={lang} />}
            onOpen={() => setBlockOpen(curBlock.id)}
            onRemove={() => removeBlock(curBlock.id)}
          />
        ) : !one ? (
          <div className="mt-empty small">
            {sel.length > 1 ? `${sel.length} cortes selecionados. Delete apaga, Shift+Delete apaga e fecha o buraco, E aplica o crossfade.` : 'Clique num corte da timeline pra ver os detalhes.'}
            <div className="mt-keys">
              <b>Atalhos</b>
              <span>
                {keyHint('mt.play')} tocar · {keyHint('mt.select')} seleção · {keyHint('mt.blade')} lâmina · {keyHint('mt.split')} dividir no playhead · {keyHint('mt.record')} gravar
              </span>
              <span>{keyHint('mt.splice')} crossfade · Delete apagar · Shift+Delete apagar e juntar</span>
              <span>Botão direito na junção: crossfade · arraste a borda de baixo do nome da faixa: altura</span>
              <span>{keyHint('mt.block')} bloco de instrução (duplo clique abre)</span>
              <span>
                ←/→ quadro · Shift+←/→ corte · {keyHint('mt.zoomIn')}/{keyHint('mt.zoomOut')} zoom · Ctrl+Z desfazer · ? todos os atalhos
              </span>
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
      <div className={'mt-toolbar' + (barCompact ? ' compact' : '')} ref={barRef}>
        <div className="seg">
          <button className={tool === 'select' ? 'on' : ''} title="Seleção (V)" onClick={() => setTool('select')}>
            <MousePointer2 size={14} />
          </button>
          <button className={tool === 'blade' ? 'on' : ''} title="Lâmina (C): clique no corte pra dividir" onClick={() => setTool('blade')}>
            <Scissors size={14} />
          </button>
        </div>
        <button className="btn small" title="Dividir no playhead (S)" onClick={splitAtPlayhead}>
          <Scissors size={13} /> <span className="lbl">Dividir</span>
        </button>
        <span className="mt-sep" />
        <button className="btn small emenda" title="Crossfade (E): no corte selecionado, pra suavizar e evitar estalo" onClick={() => applySplice(false)} disabled={!sel.some((c) => prevOf(c))}>
          <Combine size={13} /> Crossfade
        </button>
        <button className="btn small" title="Aplica o crossfade em todos os cortes colados da timeline" onClick={() => applySplice(true)}>
          Crossfade em todos
        </button>
        <label className="mt-splice-len" title="Duração do crossfade">
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
        <button className="btn small mt-mark-btn" title="Marca no cursor onde entra o lettering do capítulo (L)" onClick={() => addLettering()}>
          <Type size={13} /> <span className="lbl">Lettering</span>
        </button>
        <label className="mt-splice-len" title="Tempo fixo de cada lettering novo (segundos)">
          <input
            type="number"
            min={0.5}
            max={30}
            step={0.5}
            value={letteringDur}
            onChange={(e) => change({ ...data, letteringDur: Math.max(0.5, Number(e.target.value) || 3) }, 'lettering-dur')}
          />
          s
        </label>
        <div className="mt-sil">
          <button
            className={'btn small' + (silOpen ? ' on' : '')}
            disabled={!!busy && !silOpen}
            title="Corte por silêncio (rápido, sem transcrever): abre o painel pra calibrar e cortar"
            onClick={() => setSilOpen((o) => !o)}
          >
            <AudioWaveform size={13} /> Cortar silêncios
          </button>
          {silOpen &&
            (() => {
              const info = silenceInfo()
              const st = info.stats
              const pct = st.total ? Math.round((st.removed / st.total) * 100) : 0
              return (
                <div className="mt-sil-pop" onMouseDown={(e) => e.stopPropagation()}>
                  <header>
                    <b>Cortar silêncios</b>
                    <button className="icon-btn" title="Fechar" onClick={() => setSilOpen(false)}>
                      <X size={13} />
                    </button>
                  </header>
                  <small className="muted">Vai cortar: {info.n ? info.scope : 'nada (selecione cortes com áudio ou ponha a narração na pasta Narração)'}</small>
                  <label title="Tudo que fica abaixo desse volume conta como silêncio. Mais perto de 0 corta mais; mais negativo corta menos.">
                    <span>
                      Silêncio abaixo de <b>{silOpts.threshold} dB</b>
                      {info.suggest !== null && (
                        <button className="link-btn" title="Mede o ruído de fundo e a fala e põe o limiar entre os dois" onClick={() => setSilOpts({ threshold: info.suggest! })}>
                          detectar ({info.suggest} dB)
                        </button>
                      )}
                    </span>
                    <input type="range" min={-70} max={-15} step={1} value={silOpts.threshold} onChange={(e) => setSilOpts({ threshold: Number(e.target.value) })} />
                  </label>
                  <label title="Pausas mais curtas que isso ficam (respiração entre palavras). Menor deixa o ritmo mais acelerado.">
                    <span>
                      Duração mínima do silêncio <b>{Math.round(silOpts.minSilence * 1000)} ms</b>
                    </span>
                    <input type="range" min={100} max={3000} step={50} value={silOpts.minSilence * 1000} onChange={(e) => setSilOpts({ minSilence: Number(e.target.value) / 1000 })} />
                  </label>
                  <label title="Quanto de respiro fica antes e depois de cada fala. Aumente se o começo ou o fim das palavras estiver sendo comido.">
                    <span>
                      Folga antes/depois da fala <b>{Math.round(silOpts.pad * 1000)} ms</b>
                    </span>
                    <input type="range" min={0} max={600} step={10} value={silOpts.pad * 1000} onChange={(e) => setSilOpts({ pad: Number(e.target.value) / 1000 })} />
                  </label>
                  <label title="Sons mais curtos que isso no meio do silêncio (estalo de boca, clique, batida na mesa) saem junto.">
                    <span>
                      Ignorar ruídos mais curtos que <b>{Math.round((silOpts.minVoice ?? 0.05) * 1000)} ms</b>
                    </span>
                    <input
                      type="range"
                      min={50}
                      max={600}
                      step={10}
                      value={(silOpts.minVoice ?? 0.05) * 1000}
                      onChange={(e) => setSilOpts({ minVoice: Number(e.target.value) / 1000 })}
                    />
                  </label>
                  <div className="mt-sil-est">
                    {busy ? (
                      <>
                        <Loader2 size={12} className="spin" /> {busy.label}
                      </>
                    ) : st.total ? (
                      <>
                        Com esses ajustes: <b>{st.removed.toFixed(1)} s</b> de silêncio saem ({pct}% de {fmtTc(st.total)}), ficam <b>{st.pieces}</b> trechos de fala.
                      </>
                    ) : (
                      'As ondas ainda não carregaram.'
                    )}
                  </div>
                  <details className="mt-sil-help">
                    <summary>Como calibrar</summary>
                    <ol>
                      <li>Clique em detectar: o Typos mede o ruído de fundo e a sua voz e sugere o limiar.</li>
                      <li>Está comendo o começo ou o fim das palavras? Deixe o limiar mais negativo ou aumente a folga.</li>
                      <li>Ainda sobram pausas? Suba o limiar (mais perto de 0) ou diminua a duração mínima do silêncio.</li>
                      <li>Ficou corrido demais? Aumente a duração mínima: pausas curtas de respiração ficam.</li>
                      <li>Cortou e não gostou? Ctrl+Z desfaz, mude e corte de novo.</li>
                    </ol>
                  </details>
                  <footer>
                    <button className="btn small" onClick={() => setSilOpts(SILENCE_DEFAULT)}>
                      Padrão
                    </button>
                    <span className="mt-grow" />
                    <button
                      className="btn small primary"
                      disabled={!!busy || !info.n}
                      onClick={() => {
                        setSilOpen(false)
                        cutSilence()
                      }}
                    >
                      <AudioWaveform size={13} /> Cortar
                    </button>
                  </footer>
                </div>
              )
            })()}
        </div>
        <span className="mt-sep" />
        <button
          className="btn small"
          disabled={!!busy}
          title="Deixa a narração no volume ideal: mede cada corte (LUFS) e ajusta o volume dele. Com cortes selecionados, só neles."
          onClick={() => normalize()}
        >
          <Gauge size={13} /> <span className="lbl">Normalizar</span>
        </button>
        <select className="mt-loud" value={normSpec} title="Alvo da normalização" onChange={(e) => change({ ...data, norm: e.target.value }, 'norm-target')}>
          <optgroup label="Pico (voz: −4 a −8 dB)">
            <option value="peak:-4">pico −4 dB</option>
            <option value="peak:-6">pico −6 dB</option>
            <option value="peak:-8">pico −8 dB</option>
          </optgroup>
          <optgroup label="Volume percebido (LUFS)">
            <option value="lufs:-14">−14 LUFS · YouTube</option>
            <option value="lufs:-16">−16 LUFS · com trilha</option>
            <option value="lufs:-19">−19 LUFS · podcast</option>
          </optgroup>
        </select>
        {normMsg && <span className="mt-norm-msg">{normMsg}</span>}
        {busy && !normMsg && (
          <span className="mt-norm-msg">
            <Loader2 size={12} className="spin" /> {busy.label}
          </span>
        )}
        <span className="mt-sep" />
        <button className="icon-btn" title="Desfazer (Ctrl+Z)" onClick={undo}>
          <Undo2 size={15} />
        </button>
        <button className="icon-btn" title="Refazer (Ctrl+Shift+Z)" onClick={redo}>
          <Redo2 size={15} />
        </button>
        <div className="mt-hist-wrap">
          <button className={'icon-btn' + (histOpen ? ' on' : '')} title="Histórico: tudo que você fez na Montagem; clique num passo pra voltar até ele" onClick={() => setHistOpen((o) => !o)}>
            <History size={15} />
          </button>
          {histOpen && <HistoryList past={past.current} future={future.current} now={data} stamps={stamps.current} onJump={jump} onClose={() => setHistOpen(false)} />}
        </div>
        <span className="mt-grow" />
        {blockNote && (
          <button
            className="btn small mt-block-note"
            title="Abrir o bloco"
            onClick={() => {
              selectBlock(blockNote.id)
              setBlockOpen(blockNote.id)
              setBlockNote(null)
            }}
          >
            <Check size={13} /> {blockNote.text} · abrir
          </button>
        )}
        {wstatus && ffmpeg?.whisper && (
          <AudioReadButton data={data} lang={lang} ready={!!model?.ready} onNeedModel={downloadModel} others={otherTimelines} />
        )}
        {onSyncScript && (
          <button
            className="btn small"
            disabled={!data.clips.length}
            title="Troca o texto escrito das falas pelo que foi falado na narração (improvisos entram, o que não foi dito sai). Só o texto."
            onClick={() => onSyncScript(dataRef.current)}
          >
            <FileCheck2 size={13} /> <span className="lbl">Atualizar roteiro</span>
          </button>
        )}
        {onPrepareClips && (
          <button
            className="btn small mt-clips-btn"
            disabled={!data.clips.length}
            title="Criar Clipes: o Claude lê a transcrição e sugere os melhores trechos pra Reels, TikTok e Shorts; cada recorte ganha a timeline dele"
            onClick={onPrepareClips}
          >
            <Scissors size={13} /> <span className="lbl">{prepareLabel ?? 'Preparar Clipes'}</span>
          </button>
        )}
        {onQueueRender && (
          <button
            className="btn small primary"
            disabled={!data.clips.length}
            title="Põe o vídeo desta timeline na fila do Render. Você continua editando; o render sai de lá."
            onClick={onQueueRender}
          >
            <ListPlus size={13} /> Fila de render
          </button>
        )}
        {toolbarExtra}
        <button className="icon-btn" title="Faixas de áudio mais baixas" onClick={() => resizeAudio(1 / 1.3)}>
          <FoldVertical size={15} />
        </button>
        <button className="icon-btn" title="Faixas de áudio mais altas (pra ver os picos)" onClick={() => resizeAudio(1.3)}>
          <UnfoldVertical size={15} />
        </button>
        <button className="icon-btn" title="Menos zoom (- ou Ctrl+roda do mouse), focado na agulha" onClick={() => zoomBy(1 / 1.4)}>
          <ZoomOut size={15} />
        </button>
        <button className="icon-btn" title="Mais zoom (+ ou Ctrl+roda do mouse), focado na agulha" onClick={() => zoomBy(1.4)}>
          <ZoomIn size={15} />
        </button>
      </div>

      {markMenu &&
        (() => {
          const mk = (data.markers ?? []).find((m) => m.id === markMenu.id)
          if (!mk) return null
          const act = (fn: () => void) => () => {
            setMarkMenu(null)
            fn()
          }
          return (
            <div className="ctx-menu" style={{ left: markMenu.x, top: markMenu.y, maxHeight: window.innerHeight - 16, overflowY: 'auto' }} onMouseDown={(e) => e.stopPropagation()}>
              <div className="ctx-label">Lettering de qual capítulo?</div>
              {chapters().map((c) => (
                <button key={c.index} className={c.index === mk.block ? 'on' : ''} onClick={act(() => patchMarker(mk.id, { block: c.index, label: c.text.trim() }))}>
                  {c.index === mk.block ? '✓ ' : ''}
                  {c.text.trim().slice(0, 50)}
                </button>
              ))}
              <div className="ctx-sep" />
              <button
                onClick={act(async () => {
                  const v = await askText('Duração do lettering (segundos):', String(mk.dur))
                  const n = Number(String(v ?? '').replace(',', '.'))
                  if (v !== null && n > 0) patchMarker(mk.id, { dur: Math.round(n * 10) / 10 })
                })}
              >
                Duração… ({mk.dur.toFixed(1)} s)
              </button>
              <button onClick={act(() => patchMarker(mk.id, { t: posRef.current }))}>Mover pro cursor</button>
              <button onClick={act(() => seek(mk.t))}>Ir pro começo dele</button>
              <div className="ctx-sep" />
              <button className="danger" onClick={act(() => change({ ...dataRef.current, markers: (dataRef.current.markers ?? []).filter((m) => m.id !== mk.id) }))}>
                Remover marcação
              </button>
            </div>
          )
        })()}
      {clipMenu &&
        (() => {
          const targets = menuTargets()
          const one = targets.length === 1 ? targets[0] : null
          const m = one ? media.get(one.media) : null
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
              style={{ left: clipMenu.x, top: clipMenu.y, maxHeight: window.innerHeight - 16, overflowY: 'auto' }}
              ref={(el) => {
                // mede o menu de verdade: se não couber embaixo, sobe (e nunca sai da tela)
                if (!el) return
                const r = el.getBoundingClientRect()
                if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`
                if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`
              }}
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
                  {one.splice ? 'Tirar o crossfade com o anterior' : 'Crossfade com o corte anterior'} <kbd>E</kbd>
                </button>
              )}
              {targets.some((c) => media.get(c.media)?.hasAudio) && (
                <>
                  <div className="ctx-sep" />
                  <button onClick={act(() => setSoundFor({ x: clipMenu.x, y: clipMenu.y, ids: targets.map((c) => c.id) }))}>
                    Controle de som…
                    {one && one.gainDb ? <kbd>{(one.gainDb > 0 ? '+' : '') + one.gainDb.toFixed(1)} dB</kbd> : null}
                  </button>
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

      {soundFor && (
        <SoundPanel
          at={soundFor}
          data={data}
          media={media}
          change={change}
          normLabel={normMode === 'peak' ? `pico ${normValue} dB` : `${normValue} LUFS`}
          onNormalize={(cs) => normalize(cs)}
          onClose={() => setSoundFor(null)}
        />
      )}
      {blockMenu &&
        (() => {
          const b = blocks.find((x) => x.id === blockMenu.id)
          if (!b) return null
          const act = (fn: () => void) => () => {
            setBlockMenu(null)
            fn()
          }
          return (
            <div
              className="ctx-menu"
              style={{ left: blockMenu.x, top: blockMenu.y }}
              ref={(el) => {
                if (!el) return
                const r = el.getBoundingClientRect()
                if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`
                if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="ctx-label">{blockLabel(b)}</div>
              <button onClick={act(() => setBlockOpen(b.id))}>Abrir bloco (duplo clique)</button>
              <button disabled={!!blockBusy} onClick={act(() => makePreview(b.id))}>
                {b.preview ? 'Refazer prévia' : 'Gerar prévia'}
              </button>
              <button onClick={act(() => patchBlock(b.id, { dynamic: !b.dynamic }))}>{b.dynamic ? 'Passar pra instruções escritas' : 'Passar pra dinâmico (pela fala)'}</button>
              <div className="ctx-sep" />
              <button
                onClick={act(() => {
                  const copy: InstructionBlock = { ...b, id: newBlock(b.track, 0, 1).id, start: b.end, end: b.end + (b.end - b.start), preview: undefined, approved: false }
                  change({ ...dataRef.current, blocks: [...(dataRef.current.blocks ?? []), copy] })
                  selectBlock(copy.id)
                })}
              >
                Duplicar logo depois
              </button>
              <button className="danger" onClick={act(() => removeBlock(b.id))}>
                Excluir <kbd>Delete</kbd>
              </button>
            </div>
          )
        })()}
      {joinMenu &&
        (() => {
          const right = data.clips.find((c) => c.id === joinMenu.id)
          const left = right && prevOf(right)
          if (!right || !left) return null
          const act = (fn: () => void) => () => {
            setJoinMenu(null)
            fn()
          }
          const cur = right.splice
          return (
            <div
              className="ctx-menu"
              style={{ left: joinMenu.x, top: joinMenu.y }}
              ref={(el) => {
                if (!el) return
                const r = el.getBoundingClientRect()
                if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`
                if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="ctx-label">Crossfade{cur ? ` · agora ${Math.round(cur * 1000)} ms` : ''}</div>
              <button onClick={act(() => patchClip(right.id, { splice: cur ? undefined : spliceLen }))}>
                {cur ? 'Tirar o crossfade' : `Adicionar crossfade (${Math.round(spliceLen * 1000)} ms)`} <kbd>E</kbd>
              </button>
              <div className="ctx-sep" />
              <div className="ctx-label">Duração</div>
              {[0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1].map((v) => (
                <button key={v} className={cur && Math.abs(cur - v) < 0.0005 ? 'on' : ''} onClick={act(() => patchClip(right.id, { splice: v }))}>
                  {v < 1 ? `${Math.round(v * 1000)} ms` : `${v} s`}
                  {cur && Math.abs(cur - v) < 0.0005 ? ' ✓' : ''}
                </button>
              ))}
              <div className="ctx-sep" />
              <button onClick={act(() => applySplice(true))}>Crossfade em todos os cortes colados</button>
            </div>
          )
        })()}
      {motionEdit && (
        <MotionEditor
          block={motionEdit.block}
          pending={motionEdit.pending}
          dir={dir}
          busy={blockBusy}
          onAdjust={motionEditAdjust}
          onCancel={cancelBlock}
          onApply={motionEditApply}
          onDiscard={motionEditDiscard}
          onClose={() => {
            if (motionEdit.pending && !confirm('A alteração ainda não foi aplicada no vídeo. Fechar e perder essa prévia?')) return
            setMotionEdit(null)
          }}
        />
      )}
      {openBlock && (
        <BlockWindow
          b={openBlock}
          data={data}
          dir={dir}
          patch={(p, g) => patchBlock(openBlock.id, p, g)}
          busy={blockBusy}
          onGenerate={() => makePreview(openBlock.id)}
          onAdjust={(t) => makePreview(openBlock.id, t)}
          onCancel={cancelBlock}
          onApprove={() => approveBlock(openBlock.id)}
          heard={<BlockHeardRow data={data} b={openBlock} lang={lang} />}
          onClose={() => setBlockOpen(null)}
        />
      )}

      {/* ---------- timeline de edição ---------- */}
      <section className="mt-timeline">
        <EditTimeline
          data={data}
          change={change}
          engine={engine}
          media={media}
          selected={selected}
          onSelect={selectClips}
          tool={tool}
          pps={pps}
          posRef={posRef}
          seek={seek}
          playheadRef={playheadRef}
          scrollRef={scrollRef}
          wavesVersion={wavesVersion}
          onClipMenu={onClipMenu}
          onClipOpen={openMotionEdit}
          onJoinMenu={onJoinMenu}
          onDropFile={dropPcFile}
          onMarkerMenu={(e, mk) => setMarkMenu({ x: e.clientX, y: e.clientY, id: mk.id })}
          onAddBlockAt={(track, t) => addBlock({ track, t })}
          onAddLetteringAt={(t) => addLettering(t)}
          armed={armed}
          onArm={(id) => setArmed((a) => (a === id ? null : id))}
          recording={rec}
          recClipRef={recClipRef}
          blockSel={blockSel}
          onBlockSel={selectBlock}
          onBlockOpen={setBlockOpen}
          onBlockMenu={(e, id) => setBlockMenu({ x: e.clientX, y: e.clientY, id })}
          blockBusy={blockBusy?.id ?? null}
          blockPct={blockBusy ? busyOverall(blockBusy) : null}
          onBlockCancel={cancelBlock}
          blockHeard={blockHeard}
          gap={gap}
          onGap={setGap}
        />
      </section>
    </div>
  )
}

/**
 * Controle de som de um corte (ou da seleção): volume com ajuste fino, som ligado/desligado, fades,
 * normalizar e, com um clique, o mesmo ajuste pra faixa inteira. Fica aberto enquanto mexe.
 */
function SoundPanel({
  at,
  data,
  media,
  change,
  normLabel,
  onNormalize,
  onClose
}: {
  at: { x: number; y: number; ids: string[] }
  data: MontageData
  media: Map<string, MontageMedia>
  change: (next: MontageData, gesture?: string) => void
  normLabel: string
  onNormalize: (clips: MontageClip[]) => void
  onClose: () => void
}) {
  const [scope, setScope] = useState<'clips' | 'track'>('clips')
  const gesture = useRef(uid())
  const picked = data.clips.filter((c) => at.ids.includes(c.id))
  const tracks = [...new Set(picked.map((c) => c.track))]
  const track = tracks.length === 1 ? data.tracks.find((t) => t.id === tracks[0]) : undefined
  const targets = (scope === 'track' && track ? data.clips.filter((c) => c.track === track.id) : picked).filter((c) => media.get(c.media)?.hasAudio)
  useEffect(() => {
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest?.('.mt-sound') && onClose()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [onClose])
  if (!picked.length) return null
  const ids = new Set(targets.map((c) => c.id))
  const gains = targets.map((c) => c.gainDb ?? 0)
  const mixed = gains.some((g) => Math.abs(g - gains[0]) > 0.05)
  const gain = gains[0] ?? 0
  const clampDb = (v: number) => Math.round(Math.max(-30, Math.min(24, v)) * 10) / 10
  const patchAll = (fn: (c: MontageClip) => Partial<MontageClip>, g?: string) =>
    change({ ...data, clips: data.clips.map((c) => (ids.has(c.id) ? { ...c, ...fn(c) } : c)) }, g)
  const one = targets.length === 1 ? targets[0] : null
  const m = one ? media.get(one.media) : picked.length === 1 ? media.get(picked[0].media) : undefined
  const fmtDb = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
  const fadeIn = one?.fadeIn ?? 0
  const fadeOut = one?.fadeOut ?? 0
  return (
    <div
      className="mt-sound"
      style={{ left: at.x, top: at.y }}
      ref={(el) => {
        if (!el) return
        const r = el.getBoundingClientRect()
        if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`
        if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`
      }}
    >
      <div className="mt-sound-head">
        <SlidersHorizontal size={13} />
        <b>Controle de som</b>
        <button className="icon-btn" title="Fechar (Esc)" onClick={onClose}>
          <X size={12} />
        </button>
      </div>
      <div className="mt-sound-scope seg">
        <button className={scope === 'clips' ? 'on' : ''} onClick={() => setScope('clips')} title={m?.name}>
          {picked.length === 1 ? 'Este corte' : `${picked.length} cortes`}
        </button>
        <button
          className={scope === 'track' ? 'on' : ''}
          disabled={!track}
          title={track ? `Todos os cortes da faixa ${track.name}` : 'Os cortes estão em faixas diferentes'}
          onClick={() => setScope('track')}
        >
          Faixa {track?.name ?? ''} inteira
        </button>
      </div>
      {!targets.length ? (
        <p className="muted small">Nada com som aqui.</p>
      ) : (
        <>
          <label className="mt-sound-row">
            <span>
              Volume <b>{mixed ? 'vários' : fmtDb(gain)}</b>
            </span>
            <input
              type="range"
              min={-30}
              max={12}
              step={0.5}
              value={gain}
              title="Duplo clique volta a 0 dB"
              onChange={(e) => patchAll(() => ({ gainDb: clampDb(Number(e.target.value)) }), gesture.current + 'g')}
              onDoubleClick={() => patchAll(() => ({ gainDb: 0 }))}
            />
          </label>
          <div className="mt-sound-btns">
            {[-3, -1, 1, 3].map((d) => (
              <button key={d} className="btn small" title={mixed ? 'Mexe em todos por igual (mantém a diferença entre eles)' : ''} onClick={() => patchAll((c) => ({ gainDb: clampDb((c.gainDb ?? 0) + d) }))}>
                {d > 0 ? '+' : '−'}
                {Math.abs(d)} dB
              </button>
            ))}
            <button className="btn small" disabled={!gains.some((g) => g)} onClick={() => patchAll(() => ({ gainDb: 0 }))}>
              0 dB
            </button>
          </div>
          <button className="btn small mt-sound-wide" onClick={() => onNormalize(targets)} title="Mede o volume de cada corte e acerta pro alvo da barra de ferramentas">
            Normalizar ({normLabel})
          </button>
          <label className="toggle-row mt-sound-row">
            <input
              type="checkbox"
              checked={targets.some((c) => !c.audioOff)}
              onChange={(e) => patchAll(() => ({ audioOff: e.target.checked ? undefined : true }))}
            />
            Tocar o som {targets.length > 1 ? 'destes cortes' : 'deste corte'}
          </label>
          {one && (
            <div className="mt-sound-grid">
              <label>
                Fade de entrada (ms)
                <input type="number" min={0} step={10} value={Math.round(fadeIn * 1000)} onChange={(e) => patchAll(() => ({ fadeIn: Math.max(0, Number(e.target.value) / 1000) }), gesture.current + 'fi')} />
              </label>
              <label>
                Fade de saída (ms)
                <input type="number" min={0} step={10} value={Math.round(fadeOut * 1000)} onChange={(e) => patchAll(() => ({ fadeOut: Math.max(0, Number(e.target.value) / 1000) }), gesture.current + 'fo')} />
              </label>
            </div>
          )}
          {track && (
            <label className="toggle-row mt-sound-row">
              <input
                type="checkbox"
                checked={!!track.muted}
                onChange={(e) => change({ ...data, tracks: data.tracks.map((t) => (t.id === track.id ? { ...t, muted: e.target.checked || undefined } : t)) })}
              />
              Silenciar a faixa {track.name}
            </label>
          )}
        </>
      )}
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
        <label className="toggle-row mt-insp-row" title="Desligado, o som do arquivo não toca nem entra no render (clipes de motion aprovados já trazem a narração, que continua nas faixas de áudio)">
          <input type="checkbox" checked={!c.audioOff} onChange={(e) => patch({ audioOff: e.target.checked ? undefined : true })} />
          Tocar o som deste clipe
        </label>
      )}
      {m?.hasAudio && !c.audioOff && (
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
      <label className={'toggle-row mt-insp-row' + (hasPrev ? '' : ' disabled')} title={hasPrev ? '' : 'O crossfade vale quando este corte está colado no anterior'}>
        <input type="checkbox" disabled={!hasPrev} checked={!!c.splice} onChange={(e) => patch({ splice: e.target.checked ? spliceLen : undefined })} />
        Crossfade com o corte anterior
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

const ROLE_LABEL: Record<string, string> = { narration: 'narração (corte automático)', raw: 'material bruto', sfx: 'efeitos sonoros', custom: 'categoria' }
const ROLE_COLOR: Record<string, string> = { narration: '#4fe0c4', raw: '#f7b955', sfx: '#22d3ee', custom: '#a26bff' }

/** Categorias (as abas do topo da mídia): quantas, nome, cor e ordem. */
function CategoriesModal({ data, onClose, onSave }: { data: MontageData; onClose: () => void; onSave: (bins: MontageBin[], media: MontageMedia[]) => void }) {
  const [cats, setCats] = useState(() => data.bins.filter((b) => !b.parent).map((b) => ({ ...b, color: b.color ?? ROLE_COLOR[b.role] })))
  const patch = (id: string, p: Partial<MontageBin>) => setCats((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)))
  const move = (i: number, d: number) =>
    setCats((cs) => {
      const n = [...cs]
      const j = i + d
      if (j < 0 || j >= n.length) return cs
      ;[n[i], n[j]] = [n[j], n[i]]
      return n
    })
  const save = () => {
    const keep = new Set(cats.map((c) => c.id))
    const fallback = cats[0].id
    // categoria apagada: as pastas e os arquivos dela vão pra primeira categoria
    const removed = new Set(data.bins.filter((b) => !b.parent && !keep.has(b.id)).map((b) => b.id))
    const sub = data.bins.filter((b) => b.parent).map((b) => (b.parent && removed.has(b.parent) ? { ...b, parent: fallback } : b))
    const media = data.media.map((m) => (removed.has(m.bin) ? { ...m, bin: fallback } : m))
    onSave([...cats, ...sub], media)
    onClose()
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal cats-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Categorias da mídia</h3>
        <p className="muted small">São as abas do topo. Dentro de cada uma você cria pastas, vincula pastas do PC e marca favoritas.</p>
        <div className="cats-list">
          {cats.map((c, i) => (
            <div key={c.id} className="cats-row">
              <input type="color" value={c.color} onChange={(e) => patch(c.id, { color: e.target.value })} title="Cor" />
              <input className="cats-name" value={c.name} onChange={(e) => patch(c.id, { name: e.target.value })} />
              <span className="cats-role">{ROLE_LABEL[c.role]}</span>
              <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Subir">
                <ArrowUp size={13} />
              </button>
              <button className="icon-btn" disabled={i === cats.length - 1} onClick={() => move(i, 1)} title="Descer">
                <ArrowDown size={13} />
              </button>
              <button
                className="icon-btn danger"
                disabled={cats.length <= 1 || c.role === 'narration'}
                title={c.role === 'narration' ? 'A narração não sai (é dela que sai o corte automático)' : 'Tirar categoria (o conteúdo vai pra primeira)'}
                onClick={() => setCats((cs) => cs.filter((x) => x.id !== c.id))}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
        <button className="btn small" onClick={() => setCats((cs) => [...cs, { id: uid(), name: 'Nova categoria', role: 'custom', color: ROLE_COLOR.custom }])}>
          <FolderPlus size={13} /> Nova categoria
        </button>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={cats.some((c) => !c.name.trim())} onClick={save}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  )
}

/** lista do desfazer: cada passo com nome e hora; clicar volta (ou avança) até ele */
function HistoryList(p: {
  past: MontageData[]
  future: MontageData[]
  now: MontageData
  stamps: WeakMap<MontageData, number>
  onJump: (steps: number) => void
  onClose: () => void
}) {
  useEffect(() => {
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest?.('.mt-hist-wrap') && p.onClose()
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  })
  const hour = (t?: number) => (t ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '')
  // passos feitos (o mais antigo primeiro): o estado depois do passo i é past[i+1] (ou o de agora)
  const done = p.past.map((before, i) => ({ label: describeChange(before, p.past[i + 1] ?? p.now), at: p.stamps.get(before), steps: -(p.past.length - 1 - i) }))
  // passos desfeitos, na ordem em que seriam refeitos
  const ahead = [...p.future].reverse()
  const undone = ahead.map((after, j) => ({ label: describeChange(ahead[j - 1] ?? p.now, after), at: undefined as number | undefined, steps: j + 1 }))
  return (
    <div className="mt-hist" onMouseDown={(e) => e.stopPropagation()}>
      <div className="mt-hist-head">Histórico da Montagem</div>
      <div className="mt-hist-list">
        <button className={'mt-hist-row' + (p.past.length ? '' : ' cur')} onClick={() => p.onJump(-p.past.length)}>
          <span>Início</span>
        </button>
        {done.map((h, i) => (
          <button key={'d' + i} className={'mt-hist-row' + (h.steps === 0 ? ' cur' : '')} onClick={() => p.onJump(h.steps)}>
            <span>{h.label}</span>
            <span className="muted">{hour(h.at)}</span>
          </button>
        ))}
        {undone.map((h, j) => (
          <button key={'u' + j} className="mt-hist-row undone" title="Desfeito: clique pra refazer até aqui" onClick={() => p.onJump(h.steps)}>
            <span>{h.label}</span>
          </button>
        ))}
      </div>
      {!p.past.length && !p.future.length && <div className="muted small mt-hist-empty">Nada feito ainda nesta Montagem.</div>}
    </div>
  )
}
