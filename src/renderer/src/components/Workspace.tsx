import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, useEditorState, EditorContent, type Editor } from '@tiptap/react'
import { undoDepth } from '@tiptap/pm/history'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { JSONContent } from '@tiptap/core'
import { Home, FolderOpen, PanelRightOpen, PanelRightClose, AlertTriangle, Clock, Check, Loader2, AudioLines, Settings, Send, Save, PanelLeftOpen, PanelLeftClose, PenLine, Film, FolderInput, Palette } from 'lucide-react'
import { Prompt, Transition, SoundUp, Sonora, Chapter, ScriptKeys, SpeechTiming, convertBracketLines } from '../editor/nodes'
import { Timestamps, setTimestamps } from '../editor/timestamps'
import { TimeGutter } from './TimeGutter'
import { Reference, referenceAt, allReferences, referencesText, type RefRange } from '../editor/reference'
import { PromptRange, promptAt, type PromptRangeInfo } from '../editor/promptMark'
import { FilterBar } from './FilterBar'
import { TrackGutter } from './TrackGutter'
import { AiLineAssist } from './AiLineAssist'
import { AiChatPanel } from './AiChatPanel'
import { ReviewPane } from './ReviewPane'
import { docToLines, requestDraft } from '../review'
import { InsertPanel } from './InsertPanel'
import { FoldersPanel, FILE_MIME } from './FoldersPanel'
import { PlaybackHighlight } from '../editor/highlight'
import { SpellCheck, misspelledAt, setSpellLanguage, spellSuggestions, acceptWord } from '../editor/spell'
import { Timeline } from './Timeline'
import {
  api,
  absPath,
  BLOCKS,
  blockLabel,
  buildTiming,
  computeStats,
  formatLang,
  formatTime,
  langLabel,
  setProjectDir,
  toMarkdown,
  uid,
  type Attachment,
  type BlockType,
  type Clip,
  type Track,
  type TimelineAsset,
  type Format,
  type LibraryItem,
  type ProjectData,
  type MontageData,
  defaultMontage,
  setAiStyle,
  inlineMd,
  mdToJson
} from '../lib'
import { LibraryPanel, SNIPPET_MIME } from './LibraryPanel'
import { StyleStudio } from '../style/StyleStudio'
import { Montage } from '../montage/Montage'
import { RefModal, RefsPanel } from './References'
import { MenuBar, type Menu } from './MenuBar'
import { AudioSettings } from './AudioSettings'
import { SnippetModal, type SnippetDraft } from './SnippetModal'

interface Props {
  dir: string
  data: ProjectData
  /** rascunho em autosaves/ (ainda não foi salvo num lugar escolhido) */
  draft: boolean
  onSavedAs: (dir: string) => void
  formats: Format[]
  onFormatsChange: (f: Format[]) => void
  library: LibraryItem[]
  onLibraryChange: (l: LibraryItem[]) => void
  onClose: () => void
  onOpenSettings: () => void
  registerFlush: (fn: (() => Promise<void>) | null) => void
  /** trocar de roteiro pelo menu Arquivo (novo / abrir / recente) */
  onSwitchProject: (kind: 'new' | 'open', dir?: string) => void
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

/** Bloco de nível superior sob a coordenada (pos = início do bloco). */
function blockAtCoords(view: EditorView, x: number, y: number) {
  const r = view.posAtCoords({ left: x, top: y })
  if (!r) return null
  const p = r.inside >= 0 ? r.inside : r.pos
  const $p = view.state.doc.resolve(p)
  if ($p.depth >= 1) return { pos: $p.before(1), node: $p.node(1) }
  const node = view.state.doc.nodeAt(p)
  return node ? { pos: p, node } : null
}

/** Posição entre blocos mais próxima do ponto (antes/depois do bloco sob o mouse). */
function dropPosition(view: EditorView, x: number, y: number) {
  const hit = blockAtCoords(view, x, y)
  if (!hit) return view.state.doc.content.size
  const dom = view.nodeDOM(hit.pos) as HTMLElement | null
  const rect = dom?.getBoundingClientRect()
  if (rect && y < rect.top + rect.height / 2) return hit.pos
  return hit.pos + hit.node.nodeSize
}

const afterCurrentBlock = (editor: Editor) => {
  const { $from } = editor.state.selection
  return $from.depth >= 1 ? $from.after(1) : editor.state.doc.content.size
}

export function Workspace({ dir, data, draft, onSavedAs, formats, onFormatsChange, library, onLibraryChange, onClose, onOpenSettings, registerFlush, onSwitchProject }: Props) {
  setProjectDir(dir)
  // a pasta muda depois do "Salvar…"; handlers criados uma vez leem daqui
  const dirRef = useRef(dir)
  dirRef.current = dir

  const [title, setTitle] = useState(data.title)
  const [formatId, setFormatId] = useState(data.formatId)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [panelOpen, setPanelOpen] = useState(true)
  const [tab, setTab] = useState<'ai' | 'library' | 'folders'>('library')
  const [leftOpen, setLeftOpen] = useState(() => stored('typos.left', true))
  const [hidden, setHidden] = useState<BlockType[]>(() => stored('typos.hidden', []))
  const [showTimes, setShowTimes] = useState(() => stored('typos.times', false))
  const [showTrack, setShowTrack] = useState(() => stored('typos.trackGutter', true))
  // elementos da área do texto (o ícone de IA se posiciona na página e segue o mouse no scroll)
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    pos: number
    sel?: { from: number; to: number }
    ref?: RefRange | null
    prompt?: PromptRangeInfo | null
  } | null>(null)
  const [promptEdit, setPromptEdit] = useState<{ from: number; to: number; text: string; id?: string; excerpt: string } | null>(null)
  // referência bibliográfica sendo criada/editada, dica ao passar o mouse e a lista inteira
  const [refEdit, setRefEdit] = useState<{ from: number; to: number; text: string; id?: string; excerpt: string } | null>(null)
  const [refTip, setRefTip] = useState<{ x: number; y: number; text: string; prompt?: string } | null>(null)
  const [refsOpen, setRefsOpen] = useState(false)
  const [audioOpen, setAudioOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState<'keys' | 'about' | null>(null)
  const [snippet, setSnippet] = useState<(SnippetDraft & { node?: JSONContent }) | null>(null)

  const [clips, setClips] = useState<Clip[]>(data.timeline?.clips ?? [])
  const [notes, setNotes] = useState(data.notes ?? '')
  const [montage, setMontage] = useState<MontageData>(() => data.montage ?? defaultMontage())
  const [montageVisited, setMontageVisited] = useState(false)
  // áudio da Montagem tocando junto na timeline do roteiro (pelas prévias do ffmpeg)
  const [voice, setVoice] = useState<Clip[]>([])
  useEffect(() => {
    let alive = true
    const muted = new Set(montage.tracks.filter((t) => t.muted).map((t) => t.id))
    const used = montage.clips.filter((c) => !muted.has(c.track))
    const media = new Map(montage.media.map((m) => [m.id, m]))
    ;(async () => {
      const proxies = new Map<string, string>()
      for (const id of new Set(used.map((c) => c.media))) {
        const m = media.get(id)
        if (!m?.hasAudio) continue
        const p = await api.proxyAudio(m.path)
        if (typeof p === 'string') proxies.set(id, p)
      }
      if (!alive) return
      setVoice(
        used
          .filter((c) => proxies.has(c.media))
          .map((c) => {
            const fi = c.fadeIn ?? 0
            const fo = c.fadeOut ?? 0
            const keys = [
              ...(fi ? [{ t: c.in, v: 0 }, { t: c.in + fi, v: 1 }] : []),
              ...(fo ? [{ t: c.out - fo, v: 1 }, { t: c.out, v: 0 }] : [])
            ]
            return {
              id: 'voice-' + c.id,
              path: proxies.get(c.media)!,
              name: media.get(c.media)?.name ?? '',
              kind: 'music' as const,
              lane: -1,
              start: c.start,
              offset: c.in,
              duration: c.out - c.in,
              sourceDuration: media.get(c.media)?.duration ?? c.out,
              gain: Math.pow(10, (c.gainDb ?? 0) / 20),
              keys
            }
          })
      )
    })()
    return () => {
      alive = false
    }
  }, [montage.clips, montage.media, montage.tracks])
  // Trilha ao lado do texto: música/SFX da timeline + áudio da Montagem que não é a narração
  const trackClips = useMemo(() => {
    const narration = new Set(montage.clips.filter((c) => c.block !== undefined).map((c) => 'voice-' + c.id))
    const narrBins = new Set(montage.bins.filter((b) => b.role === 'narration').map((b) => b.id))
    const media = new Map(montage.media.map((m) => [m.id, m]))
    const extra = voice
      .filter((v) => !narration.has(v.id))
      .filter((v) => {
        const c = montage.clips.find((x) => 'voice-' + x.id === v.id)
        const m = c && media.get(c.media)
        // gravação/narração solta também não entra (a fala já é o texto)
        return !!m && !narrBins.has(m.bin) && montage.tracks.find((t) => t.id === c!.track)?.kind === 'audio'
      })
    return [...clips, ...extra]
  }, [clips, voice, montage.clips, montage.bins, montage.media, montage.tracks])
  // revisão lado a lado (rascunho da IA × roteiro atual)
  const [review, setReview] = useState<{ original: JSONContent[]; draft: JSONContent[]; request: string; provider?: string; busy: boolean } | null>(null)
  // larguras dos painéis (arrastando a borda)
  const [leftW, setLeftW] = useState(() => stored('typos.leftW', 230))
  const [rightW, setRightW] = useState(() => stored('typos.rightW', 320))
  const [tracks, setTracks] = useState<Track[]>(data.timeline?.tracks ?? [])
  const [assets, setAssets] = useState<TimelineAsset[]>(data.timeline?.assets ?? [])
  const [customWpm, setCustomWpm] = useState<number | null>(data.wpm ?? null)
  const [timelineOpen, setTimelineOpen] = useState(() => {
    try {
      return localStorage.getItem('typos.timeline') !== '0'
    } catch {
      return true
    }
  })
  const [toast, setToast] = useState('')
  const [spell, setSpell] = useState<{ word: string; from: number; to: number; suggestions: string[] | null } | null>(null)

  const [mode, setMode] = useState<'script' | 'montage' | 'style'>('script')
  const [styleVisited, setStyleVisited] = useState(false)
  const format = formats.find((f) => f.id === formatId) ?? formats[0]
  const wpm = customWpm ?? format?.wpm ?? 150
  useEffect(() => {
    const guide = format?.motion?.learned?.guide
    setAiStyle([format?.rules ?? '', guide ? `Guia de motion deste formato (siga nos prompts de motion):\n${guide}` : ''].filter(Boolean).join('\n\n'))
  }, [format?.rules, format?.motion?.learned?.guide])

  // refs pros handlers do editor (que são criados uma vez só)
  const editorRef = useRef<Editor | null>(null)
  const libraryRef = useRef(library)
  libraryRef.current = library
  const metaRef = useRef({ title, formatId, format, clips, customWpm, wpm, tracks, assets, notes, montage, mode })
  metaRef.current = { title, formatId, format, clips, customWpm, wpm, tracks, assets, notes, montage, mode }

  // ---------- desfazer/refazer da tela inteira (texto + timeline) ----------
  // O texto usa o histórico do editor; os clipes de áudio guardam cópias. A pilha "ordem"
  // diz de quem foi a última ação, pra Ctrl+Z desfazer na ordem certa.
  const undoOrder = useRef<('doc' | 'clips')[]>([])
  const redoOrder = useRef<('doc' | 'clips')[]>([])
  type TlSnap = { clips: Clip[]; tracks: Track[]; assets: TimelineAsset[] }
  const clipPast = useRef<TlSnap[]>([])
  const clipFuture = useRef<TlSnap[]>([])
  const tlSnap = (): TlSnap => ({ clips: metaRef.current.clips, tracks: metaRef.current.tracks, assets: metaRef.current.assets })
  // cada clique/arraste (ou cada campo digitado) é um "gesto"; mudanças no mesmo gesto viram um passo só
  const gesture = useRef({ id: 0, kind: '', target: null as EventTarget | null, at: 0 })
  const recordedGesture = useRef(-1)
  useEffect(() => {
    const onPointer = () => {
      gesture.current = { id: gesture.current.id + 1, kind: 'pointer', target: null, at: Date.now() }
    }
    const onKey = (e: KeyboardEvent) => {
      const g = gesture.current
      const now = Date.now()
      if (g.kind === 'key' && g.target === e.target && now - g.at < 1500) {
        g.at = now
        return
      }
      gesture.current = { id: g.id + 1, kind: 'key', target: e.target, at: now }
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])
  const applyingHistory = useRef(false)

  /** guarda o estado da timeline antes de mudar (um arraste inteiro vira um passo só) */
  const recordTimeline = useCallback(() => {
    const sameGesture = undoOrder.current[undoOrder.current.length - 1] === 'clips' && recordedGesture.current === gesture.current.id
    if (!sameGesture) {
      clipPast.current.push(tlSnap())
      undoOrder.current.push('clips')
    }
    recordedGesture.current = gesture.current.id
    clipFuture.current = []
    redoOrder.current = []
  }, [])
  const changeClips = useCallback((next: Clip[]) => {
    recordTimeline()
    metaRef.current.clips = next // chamadas seguidas no mesmo gesto enxergam o valor novo
    setClips(next)
  }, [recordTimeline])
  const changeTracks = useCallback((next: Track[]) => {
    recordTimeline()
    metaRef.current.tracks = next
    setTracks(next)
  }, [recordTimeline])
  const changeAssets = useCallback((next: TimelineAsset[]) => {
    recordTimeline()
    metaRef.current.assets = next
    setAssets(next)
  }, [recordTimeline])
  const timer = useRef<number | undefined>(undefined)
  const saveRef = useRef<() => Promise<void>>(async () => {})

  const attachTo = useCallback((pos: number, atts: Attachment[]) => {
    const ed = editorRef.current
    if (!ed || !atts.length) return
    const node = ed.state.doc.nodeAt(pos)
    if (node?.type.name === 'prompt' || node?.type.name === 'sonora') {
      ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, attachments: [...node.attrs.attachments, ...atts] }))
    } else {
      ed.chain().insertContentAt(pos, { type: 'prompt', attrs: { attachments: atts } }).run()
    }
  }, [])

  const insertSnippet = useCallback(
    async (item: LibraryItem, at?: number) => {
      const ed = editorRef.current
      if (!ed) return
      const node: JSONContent = structuredClone(item.node)
      const ext = ((node.attrs?.attachments ?? []) as Attachment[]).filter((a) => a.external)
      if (ext.length) node.attrs!.attachments = await api.importPaths(dirRef.current, ext.map((a) => a.path))
      ed.chain()
        .insertContentAt(at ?? afterCurrentBlock(ed), node)
        .focus()
        .run()
    },
    []
  )

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        code: false,
        blockquote: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        link: false
      }),
      Placeholder.configure({
        placeholder: ({ node, editor }) => {
          if (node.type.name === 'chapter') return 'Nome do capítulo'
          return editor.isEmpty ? 'Comece a escrever… [entre colchetes] vira prompt' : 'Fala…'
        }
      }),
      Prompt,
      Transition,
      SoundUp,
      Chapter,
      Sonora,
      SpeechTiming,
      ScriptKeys,
      Timestamps,
      Reference,
      PromptRange,
      PlaybackHighlight,
      SpellCheck
    ],
    content: data.doc,
    autofocus: 'end',
    onUpdate: () => {
      setSaveState('dirty')
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => saveRef.current(), 1000)
    },
    editorProps: {
      // o corretor nativo fica desligado; quem sublinha é o plugin (editor/spell.ts)
      attributes: { spellcheck: 'false' },
      handleDrop: (view, event) => {
        const dt = event.dataTransfer
        if (!dt) return false
        const snippetId = dt.getData(SNIPPET_MIME)
        if (snippetId) {
          event.preventDefault()
          const item = libraryRef.current.find((i) => i.id === snippetId)
          if (item) insertSnippet(item, dropPosition(view, event.clientX, event.clientY))
          return true
        }
        // arquivo arrastado das Pastas, ou imagem/áudio/vídeo do Explorer
        const folderFile = dt.getData(FILE_MIME)
        const paths = folderFile
          ? [folderFile]
          : Array.from(dt.files)
              .filter((f) => /^(image|audio|video)\//.test(f.type))
              .map((f) => api.pathForFile(f))
        if (!paths.length) return false
        event.preventDefault()
        const hit = blockAtCoords(view, event.clientX, event.clientY)
        const holds = hit && (hit.node.type.name === 'prompt' || hit.node.type.name === 'sonora')
        const target = holds ? hit.pos : dropPosition(view, event.clientX, event.clientY)
        api.importPaths(dirRef.current, paths).then((atts: Attachment[]) => attachTo(target, atts.map((a) => ({ ...a, place: 'inline' as const }))))
        return true
      },
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
        if (files.length) {
          event.preventDefault()
          const { $from } = view.state.selection
          const inPrompt = $from.depth >= 1 && $from.node(1).type.name === 'prompt'
          const target = inPrompt ? $from.before(1) : $from.depth >= 1 ? $from.after(1) : view.state.doc.content.size
          ;(async () => {
            const atts: Attachment[] = []
            for (const f of files) atts.push(await api.importBuffer(dirRef.current, f.name || 'colado.png', new Uint8Array(await f.arrayBuffer())))
            attachTo(target, atts)
          })()
          return true
        }
        setTimeout(() => convertBracketLines(editorRef.current), 0)
        return false
      }
    }
  })
  editorRef.current = editor

  const doc = useEditorState({ editor, selector: ({ editor }) => editor?.state.doc })
  const currentBlock = useEditorState({
    editor,
    selector: ({ editor }) => {
      const $from = editor?.state.selection.$from
      return $from && $from.depth >= 1 ? $from.node(1).type.name : 'paragraph'
    }
  })
  const stats = useMemo(() => (doc ? computeStats(doc, wpm) : null), [doc, wpm])
  const refCount = useMemo(() => (doc && editor ? new Set(allReferences(editor).map((r) => r.text.trim())).size : 0), [doc, editor])
  const timing = useMemo(() => (doc ? buildTiming(doc, wpm) : null), [doc, wpm])
  const overLimit = !!(stats && format?.maxSeconds && stats.seconds > format.maxSeconds)

  // cada passo novo no histórico do texto entra na ordem de desfazer
  useEffect(() => {
    if (!editor) return
    let depth = undoDepth(editor.state)
    const onTr = () => {
      const d = undoDepth(editor.state)
      if (d > depth && !applyingHistory.current) {
        undoOrder.current.push('doc')
        redoOrder.current = []
      }
      depth = d
    }
    editor.on('transaction', onTr)
    return () => {
      editor.off('transaction', onTr)
    }
  }, [editor])

  const historyStep = useCallback(
    (dir: 'undo' | 'redo') => {
      if (!editor) return
      const from = dir === 'undo' ? undoOrder : redoOrder
      const to = dir === 'undo' ? redoOrder : undoOrder
      const kind = from.current.pop() ?? (dir === 'undo' && undoDepth(editor.state) > 0 ? 'doc' : null)
      if (!kind) return
      applyingHistory.current = true
      try {
        if (kind === 'doc') {
          if (dir === 'undo') editor.commands.undo()
          else editor.commands.redo()
        } else {
          const src = dir === 'undo' ? clipPast : clipFuture
          const dst = dir === 'undo' ? clipFuture : clipPast
          const snap = src.current.pop()
          if (snap) {
            dst.current.push(tlSnap())
            setClips(snap.clips)
            setTracks(snap.tracks)
            setAssets(snap.assets)
          }
        }
      } finally {
        applyingHistory.current = false
      }
      to.current.push(kind)
      recordedGesture.current = -1
    },
    [editor]
  )

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y valem na tela toda (não só com o cursor no texto)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k !== 'z' && k !== 'y') return
      if ((e.target as HTMLElement)?.matches?.('input, textarea, select')) return // campos comuns usam o desfazer deles
      if (metaRef.current.mode !== 'script') return // Montagem/Estilo têm o desfazer deles
      e.preventDefault()
      e.stopPropagation()
      historyStep(k === 'y' || e.shiftKey ? 'redo' : 'undo')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [historyStep])

  useEffect(() => {
    if (timing) setTimestamps(editor, false, timing.blockStarts)
  }, [editor, showTimes, timing])

  useEffect(() => {
    remember('typos.left', leftOpen)
    remember('typos.hidden', hidden)
    remember('typos.times', showTimes)
    remember('typos.trackGutter', showTrack)
    remember('typos.leftW', leftW)
    remember('typos.rightW', rightW)
  }, [leftOpen, hidden, showTimes, showTrack, leftW, rightW])

  /** arrastar a borda de um painel muda a largura dele */
  const startResize = (side: 'left' | 'right', e: React.PointerEvent) => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = side === 'left' ? leftW : rightW
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0
      if (side === 'left') setLeftW(Math.min(520, Math.max(170, w0 + dx)))
      else setRightW(Math.min(720, Math.max(260, w0 - dx)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---------- revisão lado a lado ----------
  const currentBlocks = () => (editorRef.current?.getJSON().content ?? []) as JSONContent[]
  const openReview = (draftBlocks: JSONContent[], request: string, provider?: string) =>
    setReview({ original: currentBlocks(), draft: draftBlocks, request, provider, busy: false })

  /** troca o roteiro inteiro pela versão unificada, numa transação só (Ctrl+Z desfaz) */
  const applyReview = (blocks: JSONContent[]) => {
    const ed = editorRef.current
    if (!ed) return
    const nodes = blocks.map((b) => ed.schema.nodeFromJSON(b))
    ed.view.dispatch(ed.state.tr.replaceWith(0, ed.state.doc.content.size, nodes))
    setReview(null)
    setToast('Revisão unificada. Ctrl+Z desfaz.')
  }

  const reviseDraft = async (request: string) => {
    if (!review) return
    setReview({ ...review, busy: true })
    const r = await requestDraft(docToLines(review.draft), request, dirRef.current, true)
    if ('error' in r) {
      setReview((v) => v && { ...v, busy: false })
      setToast(r.error)
    } else setReview((v) => v && { ...v, draft: r.blocks, request, provider: r.provider, busy: false })
  }

  // arquivo solto na margem esquerda (fora do texto): prévia na margem, ao lado do bloco
  const [marginHint, setMarginHint] = useState<{ left: number; top: number; height: number; width: number } | null>(null)
  const [dragFile, setDragFile] = useState(false)
  useEffect(() => {
    // arrasto cancelado (Esc ou soltou fora): some com a margem aberta
    const end = () => {
      setDragFile(false)
      setMarginHint(null)
    }
    window.addEventListener('dragend', end)
    return () => window.removeEventListener('dragend', end)
  }, [])
  const marginTarget = (e: React.DragEvent) => {
    const ed = editorRef.current
    const types = Array.from(e.dataTransfer.types)
    if (!ed || review || !(types.includes(FILE_MIME) || types.includes('Files'))) return null
    const pm = ed.view.dom.getBoundingClientRect()
    if (e.clientX >= pm.left) return null
    const hit = blockAtCoords(ed.view, pm.left + 40, Math.min(Math.max(e.clientY, pm.top + 2), pm.bottom - 2))
    const rect = hit && (ed.view.nodeDOM(hit.pos) as HTMLElement | null)?.getBoundingClientRect()
    return { hit, pm, rect }
  }
  const onMarginDragOver = (e: React.DragEvent) => {
    const t = marginTarget(e)
    if (!t) return setMarginHint(null)
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const top = t.rect ? t.rect.top : e.clientY - 30
    const box = e.currentTarget.getBoundingClientRect()
    const left = Math.max(box.left + 4, t.pm.left - 230)
    setMarginHint({ left, width: Math.min(150, t.pm.left - left - 8), top, height: Math.min(Math.max(t.rect?.height ?? 60, 56), 100) })
  }
  const onMarginDrop = (e: React.DragEvent) => {
    setMarginHint(null)
    setDragFile(false)
    if (e.defaultPrevented) return
    const t = marginTarget(e)
    if (!t) return
    e.preventDefault()
    const dt = e.dataTransfer
    const folderFile = dt.getData(FILE_MIME)
    const paths = folderFile
      ? [folderFile]
      : Array.from(dt.files)
          .filter((f) => /^(image|audio|video)\//.test(f.type))
          .map((f) => api.pathForFile(f))
    if (!paths.length) return
    const ed = editorRef.current!
    const holds = t.hit && ['prompt', 'sonora'].includes(t.hit.node.type.name)
    const target = !t.hit ? ed.state.doc.content.size : holds ? t.hit.pos : dropPosition(ed.view, t.pm.left + 40, e.clientY)
    api.importPaths(dirRef.current, paths).then((atts: Attachment[]) => attachTo(target, atts.map((a) => ({ ...a, place: 'margin' as const }))))
  }

  /**
   * Montagem → roteiro: cada Fala ganha o tempo real dos cortes dela e as pausas entre as falas
   * ganham o espaço que ficou na timeline. Dá pra desfazer no roteiro (Ctrl+Z).
   */
  const syncFromMontage = (m: MontageData) => {
    const ed = editorRef.current
    if (!ed) return 0
    const muted = new Set(m.tracks.filter((t) => t.muted).map((t) => t.id))
    const span = new Map<number, { s: number; e: number }>()
    for (const c of m.clips) {
      if (c.block === undefined || muted.has(c.track)) continue
      const e = c.start + c.out - c.in
      const cur = span.get(c.block)
      span.set(c.block, cur ? { s: Math.min(cur.s, c.start), e: Math.max(cur.e, e) } : { s: c.start, e })
    }
    const nodes: { node: PMNode; pos: number; i: number }[] = []
    ed.state.doc.forEach((node, pos, i) => nodes.push({ node, pos, i }))
    const withTime = nodes.filter((n) => n.node.type.name === 'paragraph' && span.has(n.i))
    if (!withTime.length) return 0
    const tr = ed.state.tr
    const r3 = (x: number) => Math.round(x * 1000) / 1000
    withTime.forEach((cur, k) => {
      const a = span.get(cur.i)!
      let dur = a.e - a.s
      const next = withTime[k + 1]
      if (next) {
        const gap = span.get(next.i)!.s - a.e
        const pauses = nodes.filter((n) => n.i > cur.i && n.i < next.i && (n.node.type.name === 'sonora' || n.node.type.name === 'soundUp'))
        if (pauses.length && gap > 0) {
          // o espaço vai pras pausas que já existem, na proporção de antes
          const old = pauses.reduce((s, p) => s + (Number(p.node.attrs.seconds) || 1), 0)
          for (const p of pauses) tr.setNodeMarkup(p.pos, undefined, { ...p.node.attrs, seconds: r3((gap * (Number(p.node.attrs.seconds) || 1)) / old) })
        } else if (gap > 0) dur += gap
      }
      tr.setNodeMarkup(cur.pos, undefined, { ...cur.node.attrs, seconds: r3(dur) })
    })
    ed.view.dispatch(tr)
    setToast(`Roteiro sincronizado: ${withTime.length} falas com o tempo da narração.`)
    return withTime.length
  }

  const goMode = (m: 'script' | 'montage' | 'style') => {
    setMode(m)
    if (m === 'montage') setMontageVisited(true)
    if (m === 'style') setStyleVisited(true)
  }

  // ---------- menus do topo ----------
  const menus: Menu[] = [
    {
      label: 'Arquivo',
      items: [
        { label: 'Novo roteiro', shortcut: 'Ctrl+N', onClick: () => onSwitchProject('new') },
        { label: 'Abrir pasta…', shortcut: 'Ctrl+O', onClick: () => onSwitchProject('open') },
        {
          label: 'Abrir recente',
          items: async () =>
            (await api.recentProjects())
              .filter((r: { dir: string }) => r.dir !== dir)
              .slice(0, 12)
              .map((r: { dir: string; title: string }) => ({ label: r.title, onClick: () => onSwitchProject('open', r.dir) }))
        },
        { sep: true },
        { label: 'Salvar', shortcut: 'Ctrl+S', onClick: () => (draft ? saveAs() : save()) },
        { label: draft ? 'Salvar…' : 'Salvar como…', shortcut: 'Ctrl+Shift+S', onClick: () => saveAs() },
        { label: 'Mudar pasta do projeto…', onClick: () => moveProject() },
        { label: 'Abrir pasta do projeto', onClick: () => api.openPath(dir) },
        { sep: true },
        { label: 'Copiar referências pro rodapé', onClick: () => setRefsOpen(true) },
        { label: 'Copiar pedido pro Claude', onClick: () => sendToClaude() },
        { sep: true },
        { label: 'Voltar pro início', onClick: async () => (await save(), onClose()) }
      ]
    },
    {
      label: 'Editar',
      items: [
        { label: 'Desfazer', shortcut: 'Ctrl+Z', onClick: () => historyStep('undo') },
        { label: 'Refazer', shortcut: 'Ctrl+Shift+Z', onClick: () => historyStep('redo') },
        { sep: true },
        { label: 'Recortar', shortcut: 'Ctrl+X', onClick: () => document.execCommand('cut') },
        { label: 'Copiar', shortcut: 'Ctrl+C', onClick: () => document.execCommand('copy') },
        { label: 'Colar', shortcut: 'Ctrl+V', onClick: () => navigator.clipboard.readText().then((t) => editor?.chain().focus().insertContent(t).run()) },
        { label: 'Selecionar tudo', shortcut: 'Ctrl+A', onClick: () => editor?.chain().focus().selectAll().run() },
        { sep: true },
        { label: 'Configurações…', shortcut: 'Ctrl+,', onClick: onOpenSettings }
      ]
    },
    {
      label: 'Exibir',
      items: [
        { label: 'Roteiro', checked: mode === 'script', onClick: () => goMode('script') },
        { label: 'Montagem', checked: mode === 'montage', onClick: () => goMode('montage') },
        { label: 'Estilo (treinar motion e formato)', checked: mode === 'style', onClick: () => goMode('style') },
        { sep: true },
        { label: 'Painel Inserir', checked: leftOpen, onClick: () => setLeftOpen((o) => !o) },
        { label: 'Painel lateral', checked: panelOpen, onClick: () => setPanelOpen((o) => !o) },
        { label: 'Timeline', checked: timelineOpen, onClick: () => setTimelineOpen((o) => !o) },
        { sep: true },
        { label: 'Tempos no texto', checked: showTimes, onClick: () => setShowTimes(!showTimes) },
        { label: 'Trilha ao lado do texto', checked: showTrack, onClick: () => setShowTrack(!showTrack) },
        { sep: true },
        { label: 'Referências bibliográficas…', onClick: () => setRefsOpen(true) }
      ]
    },
    {
      label: 'Áudio',
      items: [
        { label: 'Configurar entrada e saída…', onClick: () => setAudioOpen(true) },
        { sep: true },
        { label: 'Gravar narração (na Montagem)', shortcut: 'R', onClick: () => goMode('montage') }
      ]
    },
    {
      label: 'Ajuda',
      items: [
        { label: 'Atalhos do teclado', onClick: () => setHelpOpen('keys') },
        { label: 'Checar atualizações', onClick: () => api.checkUpdates() },
        { sep: true },
        { label: 'Sobre o Typos', onClick: () => setHelpOpen('about') }
      ]
    }
  ]

  /** move a pasta do roteiro pra outro lugar (rascunho: é o mesmo que salvar) */
  const moveProject = async () => {
    if (draft) return saveAs()
    await save()
    const r = await api.moveProject(dirRef.current, title)
    if (!r) return
    if ('error' in r) return setToast(r.error)
    onSavedAs(r.dir)
    setToast('Roteiro movido pra ' + r.dir)
  }

  const snapshot = useCallback(() => {
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return null
    const { title, formatId, format, clips, customWpm, wpm, tracks, assets, notes, montage } = metaRef.current
    const out: ProjectData = {
      ...data,
      title,
      formatId,
      wpm: customWpm,
      timeline: { clips, tracks, assets },
      notes,
      montage,
      doc: ed.getJSON(),
      updatedAt: new Date().toISOString()
    }
    const refs = referencesText(allReferences(ed))
    const md = toMarkdown(out, format, computeStats(ed.state.doc, wpm), buildTiming(ed.state.doc, wpm), wpm) + (refs ? '\n\n## ' + refs.replace(/^Referências:/, 'Referências') + '\n' : '')
    return { out, md }
  }, [data])

  const save = useCallback(async () => {
    window.clearTimeout(timer.current)
    const snap = snapshot()
    if (!snap) return
    setSaveState('saving')
    const r = await api.saveProject(dirRef.current, snap.out, snap.md)
    setSaveState(r && typeof r === 'object' && 'error' in r ? 'error' : 'saved')
  }, [snapshot])
  saveRef.current = save

  const saveAs = useCallback(async () => {
    await save()
    const snap = snapshot()
    if (!snap) return
    const r = await api.saveProjectAs(dirRef.current, snap.out, snap.md)
    if (!r) return
    if ('error' in r) return setToast(r.error)
    onSavedAs(r.dir)
    setToast('Salvo em ' + r.dir)
  }, [save, snapshot, onSavedAs])

  // título/formato também salvam
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    setSaveState('dirty')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => save(), 800)
  }, [title, formatId, clips, customWpm, tracks, assets, notes, montage, save])

  useEffect(() => {
    try {
      localStorage.setItem('typos.timeline', timelineOpen ? '1' : '0')
    } catch {
      /* sem storage */
    }
  }, [timelineOpen])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 3500)
    return () => clearTimeout(t)
  }, [toast])

  const sendToClaude = async () => {
    await save()
    const sep = dir.includes('\\') ? '\\' : '/'
    const msg = [
      `Roteiro do Typos pronto pra trabalhar: "${dir}"`,
      `Leia ${dir}${sep}roteiro.md (as imagens e áudios estão em assets/).`,
      '- Use os [PROMPT], [TRANSIÇÃO] e [SOBE SOM] como instruções de motion/edição, nos tempos indicados.',
      '- Imagens [RECORTAR]: recorte os elementos e salve PNG transparente em assets/recortes/ com o mesmo nome do arquivo. Se alguma não der pra recortar bem, me diga o que pedir pro ChatGPT regerar.',
      '- Imagens [REGERAR]: me sugira um prompt melhor pro ChatGPT.'
    ].join('\n')
    await navigator.clipboard.writeText(msg)
    setToast('Pedido copiado! Cole no Claude (Ctrl+V).')
  }

  useEffect(() => {
    registerFlush(save)
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        onSwitchProject('new')
      }
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        onSwitchProject('open')
      }
      if (e.ctrlKey && e.key === ',') {
        e.preventDefault()
        onOpenSettings()
      }
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (draft || e.shiftKey) saveAs()
        else save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      registerFlush(null)
    }
  }, [save, saveAs, draft, registerFlush])

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

  // idioma do corretor segue o formato do roteiro
  const lang = formatLang(format)
  useEffect(() => {
    setSpellLanguage(editorRef.current, lang)
  }, [lang, editor])

  const setBlock = (type: string) => editor?.chain().focus().setNode(type).run()

  const onContextMenu = (e: React.MouseEvent) => {
    if (!editor) return
    const hit = blockAtCoords(editor.view, e.clientX, e.clientY)
    const at = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
    const wrong = at ? misspelledAt(editor.state.doc, at.pos) : null
    setSpell(wrong ? { ...wrong, suggestions: null } : null)
    if (wrong)
      spellSuggestions(wrong.word).then((suggestions) =>
        setSpell((cur) => (cur && cur.from === wrong.from && cur.word === wrong.word ? { ...cur, suggestions } : cur))
      )
    const { from, to, empty } = editor.state.selection
    const sel = !empty && editor.state.doc.textBetween(from, to).trim() ? { from, to } : undefined
    const ref = at ? referenceAt(editor, at.inside >= 0 ? at.pos : at.pos) : null
    const prompt = at ? promptAt(editor, at.pos) : null
    if (!hit && !wrong && !sel && !ref && !prompt) return setMenu(null)
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, pos: hit ? hit.pos : -1, sel, ref, prompt })
  }

  const menuNode = menu && menu.pos >= 0 ? editor?.state.doc.nodeAt(menu.pos) : null
  // a seleção já está toda em negrito?
  const selIsBold = !!(menu?.sel && editor && editor.state.doc.rangeHasMark(menu.sel.from, menu.sel.to, editor.schema.marks.bold) &&
    (() => {
      let all = true
      editor.state.doc.nodesBetween(menu.sel!.from, menu.sel!.to, (n) => {
        if (n.isText && !n.marks.some((m) => m.type.name === 'bold')) all = false
      })
      return all
    })())

  // ---------- IA: o app pede a tarefa; quem responde é a conexão escolhida em Configurações → IA ----------
  type AiJob = {
    kind: 'revise' | 'image'
    pos: number
    original: string
    status: 'running' | 'done' | 'error'
    result?: string
    error?: string
    provider?: string
  }
  const [aiJob, setAiJob] = useState<AiJob | null>(null)
  const PROVIDER_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', anthropic: 'Claude (API)', openai: 'ChatGPT (API)' }

  const neighborText = (pos: number, dir: -1 | 1) => {
    const ed = editorRef.current
    if (!ed) return ''
    const list: string[] = []
    let idx = -1
    ed.state.doc.forEach((n, off) => {
      if (off === pos) idx = list.length
      list.push(n.type.name === 'paragraph' ? n.textContent : '')
    })
    for (let i = idx + dir; i >= 0 && i < list.length; i += dir) if (list[i].trim()) return list[i]
    return ''
  }

  const aiRevise = async (pos: number) => {
    const node = editorRef.current?.state.doc.nodeAt(pos)
    if (!node) return
    const original = inlineMd(node.toJSON())
    setAiJob({ kind: 'revise', pos, original, status: 'running' })
    await save()
    const r = await api.aiText({
      instruction:
        'Você é editor de roteiro de YouTube. Reescreva a FALA abaixo pra soar natural quando narrada: mais clara, com ritmo e gancho, mantendo o sentido, o tom e o tamanho parecido. Não invente fatos. Devolva só a fala reescrita.',
      input: `FALA:\n${original}\n\nCONTEXTO (não reescrever):\nantes: ${neighborText(pos, -1) || '(início)'}\ndepois: ${neighborText(pos, 1) || '(fim)'}`,
      dir: dirRef.current
    })
    setAiJob((j) => (j && j.pos === pos ? ('error' in r ? { ...j, status: 'error', error: r.error } : { ...j, status: 'done', result: r.text, provider: r.provider }) : j))
  }

  const aiImage = async (pos: number) => {
    const node = editorRef.current?.state.doc.nodeAt(pos)
    if (!node) return
    const original = node.textContent.trim()
    setAiJob({ kind: 'image', pos, original, status: 'running' })
    if (!original) {
      setAiJob({ kind: 'image', pos, original, status: 'error', error: 'Escreva no prompt o que a imagem deve mostrar.' })
      return
    }
    const r = await api.aiImage(dirRef.current, original, format?.aspect ?? '16:9')
    if ('error' in r) return setAiJob((j) => j && { ...j, status: 'error', error: r.error })
    attachTo(pos, [r.attachment as Attachment])
    setAiJob((j) => j && { ...j, status: 'done', result: r.attachment.path, provider: r.provider })
  }

  /** troca o texto do bloco pela sugestão (se o bloco não mudou enquanto a IA pensava) */
  const applyRevision = () => {
    const ed = editorRef.current
    if (!ed || !aiJob?.result) return
    const node = ed.state.doc.nodeAt(aiJob.pos)
    if (!node || inlineMd(node.toJSON()) !== aiJob.original) {
      setToast('A fala mudou enquanto a IA respondia; copie a sugestão e cole você mesmo.')
      return
    }
    ed.view.dispatch(ed.state.tr.replaceWith(aiJob.pos + 1, aiJob.pos + node.nodeSize - 1, mdToJson(aiJob.result).map((j) => ed.schema.nodeFromJSON(j))))
    setAiJob(null)
  }

  const startSaveSnippet = () => {
    if (!menuNode) return
    const atts = (menuNode.attrs.attachments ?? []) as Attachment[]
    const text = menuNode.textContent.trim()
    setSnippet({
      title: text ? (text.length > 32 ? text.slice(0, 32) + '…' : text) : blockLabel(menuNode.type.name),
      cover: null,
      suggestedCover: atts[0] ? absPath(atts[0]) : undefined,
      node: menuNode.toJSON()
    })
    setMenu(null)
  }

  const saveSnippet = async (d: SnippetDraft & { node?: JSONContent }) => {
    setSnippet(null)
    if (d.id) {
      onLibraryChange(library.map((i) => (i.id === d.id ? { ...i, title: d.title, cover: d.cover } : i)))
      return
    }
    const node = structuredClone(d.node!)
    const atts = (node.attrs?.attachments ?? []) as Attachment[]
    if (atts.length) {
      const stored = await api.storeLibraryFiles(atts.map(absPath))
      node.attrs!.attachments = atts.map((a, i) => ({ id: uid(), name: a.name, path: stored[i], external: true }))
    }
    onLibraryChange([...library, { id: uid(), title: d.title, cover: d.cover, node }])
    setPanelOpen(true)
    setTab('library')
  }

  const convertTo = (type: string) => {
    if (!editor || !menuNode || !menu) return
    const t = editor.schema.nodes[type]
    editor.view.dispatch(editor.state.tr.setBlockType(menu.pos + 1, menu.pos + menuNode.nodeSize - 1, t))
    setMenu(null)
  }

  return (
    <div className="workspace" style={gridLayout(leftOpen, panelOpen, timelineOpen, leftW, rightW)}>
      <header className="topbar">
        <div className="tb-left">
          <MenuBar menus={menus} />
          <button className="icon-btn" title="Painel Inserir" onClick={() => setLeftOpen((o) => !o)}>
            {leftOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
          <button className="icon-btn" title="Voltar pros roteiros" onClick={async () => (await save(), onClose())}>
            <Home size={17} />
          </button>
          <div className="ws-switch">
            <button className={mode === 'script' ? 'on' : ''} title="Roteiro: escrever" onClick={() => goMode('script')}>
              <PenLine size={16} />
            </button>
            <button className={mode === 'montage' ? 'on' : ''} title="Montagem: mídia, cortes da narração e timeline de edição" onClick={() => goMode('montage')}>
              <Film size={16} />
            </button>
            <button className={mode === 'style' ? 'on' : ''} title="Estilo: treinar o motion com o Claude e configurar o formato" onClick={() => goMode('style')}>
              <Palette size={16} />
            </button>
          </div>
          <input
            className="title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={(e) => draft && title === 'Sem título' && e.target.select()}
            spellCheck={false}
            placeholder="Nome do roteiro"
          />
        </div>
        {mode === 'script' ? (
        <FilterBar
          hidden={hidden}
          onHidden={setHidden}
          showTimes={showTimes}
          onShowTimes={setShowTimes}
          showTrack={showTrack}
          onShowTrack={(v) => {
            setShowTrack(v)
            if (v && !trackClips.length) setToast('A trilha está vazia: ponha música/SFX na timeline (ou na Montagem) que as barras aparecem ao lado do texto.')
          }}
        />
        ) : (
          <div className="ws-title">{mode === 'montage' ? 'Montagem' : 'Estilo · treinar motion'}</div>
        )}
        <div className="tb-right">
          <select className="format-select" value={formatId} onChange={(e) => setFormatId(e.target.value)} title={`Formato: ${format?.name} · ${format?.aspect} · corretor ${langLabel(lang)} (muda em Formatos)`}>
            {formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <div className="save-group">
            {draft ? (
              <button className="btn small primary" title="Escolher onde salvar (Ctrl+S)" onClick={saveAs}>
                <Save size={14} /> Salvar…
              </button>
            ) : (
              <button className="icon-btn" title="Salvar como… (Ctrl+Shift+S): uma cópia em outra pasta, e continua nela" onClick={saveAs}>
                <Save size={16} />
              </button>
            )}
            <button className="icon-btn" title="Abrir pasta do projeto" onClick={() => api.openPath(dir)}>
              <FolderOpen size={16} />
            </button>
            <button className="icon-btn" title="Mudar pasta do projeto (move o roteiro e os arquivos dele)" onClick={moveProject}>
              <FolderInput size={16} />
            </button>
          </div>
          <span
            className={'save-state ' + saveState + (draft ? ' draft' : '')}
            title={draft ? 'Rascunho: salva sozinho; use "Salvar…" pra escolher a pasta' : 'Salva sozinho (Ctrl+S força · Ctrl+Shift+S salva como)'}
          >
            {saveState === 'saving' && <Loader2 size={13} className="spin" />}
            {saveState === 'saved' && <Check size={13} />}
            {draft && saveState === 'saved' ? 'Rascunho' : { saved: 'Salvo', dirty: 'Editando…', saving: 'Salvando', error: 'Erro ao salvar' }[saveState]}
          </span>
          <button className="btn small claude-btn" title="Salva e copia um pedido pronto pra colar no Claude" onClick={sendToClaude}>
            <Send size={14} /> Claude
          </button>
          <button className={'icon-btn' + (timelineOpen ? ' on' : '')} title="Timeline (áudio + texto)" onClick={() => setTimelineOpen((o) => !o)}>
            <AudioLines size={17} />
          </button>
          <button className="icon-btn" title="Painel lateral" onClick={() => setPanelOpen((o) => !o)}>
            {panelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>
        </div>
      </header>

      {styleVisited && (
        <div className="montage-layer" style={mode === 'style' ? undefined : { display: 'none' }}>
          <StyleStudio active={mode === 'style'} formats={formats} activeId={formatId} onChange={onFormatsChange} onSelect={setFormatId} />
        </div>
      )}
      {montageVisited && (
        <div className="montage-layer" style={mode === 'montage' ? undefined : { display: 'none' }}>
          <Montage
            active={mode === 'montage'}
            data={montage}
            onChange={setMontage}
            onSyncScript={syncFromMontage}
            dir={dir}
            wpm={wpm}
            onAudioSettings={() => setAudioOpen(true)}
            lang={(formatLang(format) === 'off' ? 'pt-BR' : formatLang(format)).split('-')[0]}
            getBlocks={() => {
              const out: { index: number; type: string; text: string; seconds?: number }[] = []
              editorRef.current?.state.doc.forEach((n, _o, i) =>
                out.push({ index: i, type: n.type.name, text: n.textContent, seconds: Number(n.attrs.seconds) || undefined })
              )
              return out
            }}
          />
        </div>
      )}

      {leftOpen && <InsertPanel editor={editor} notes={notes} onNotes={setNotes} onResizeStart={(e) => startResize('left', e)} />}

      <main
        className={'editor-scroll' + (dragFile ? ' drag-file' : '')}
        onDragEnter={(e) => {
          const types = Array.from(e.dataTransfer.types)
          if (types.includes(FILE_MIME) || types.includes('Files')) setDragFile(true)
        }}
        onContextMenu={onContextMenu}
        ref={setScrollEl}
        onDragOver={onMarginDragOver}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          setMarginHint(null)
          setDragFile(false)
        }}
        onDrop={onMarginDrop}
        onMouseOver={(e) => {
          // passar o mouse num trecho com referência mostra a fonte
          const el = (e.target as HTMLElement).closest?.('.ref-mark, .prompt-mark') as HTMLElement | null
          if (!el) return refTip && setRefTip(null)
          const r = el.getBoundingClientRect()
          // trecho com prompt e referência ao mesmo tempo: mostra os dois
          const pr = (e.target as HTMLElement).closest?.('.prompt-mark') as HTMLElement | null
          const rf = (e.target as HTMLElement).closest?.('.ref-mark') as HTMLElement | null
          setRefTip({ x: Math.min(r.left, window.innerWidth - 380), y: r.bottom + 6, text: rf?.dataset.ref ?? '', prompt: pr?.dataset.prompt })
        }}
        onMouseLeave={() => setRefTip(null)}
        onScroll={() => refTip && setRefTip(null)}
      >
        {marginHint && (
          <div className="drop-margin-hint" style={{ position: 'fixed', left: marginHint.left, top: marginHint.top, height: marginHint.height, width: marginHint.width }}>
            soltar na margem
          </div>
        )}
        {review && (
          <ReviewPane
            original={review.original}
            draft={review.draft}
            wpm={wpm}
            request={review.request}
            provider={review.provider}
            busy={review.busy}
            onApply={applyReview}
            onDiscard={() => setReview(null)}
            onRequestChanges={reviseDraft}
          />
        )}
        <div className={'page aspect-' + (format?.aspect ?? '16:9').replace(':', 'x') + (showTimes ? ' with-times' : '')} ref={setPageEl} style={review ? { display: 'none' } : undefined}>
          <AiLineAssist
            editor={editor}
            dir={dir}
            aspect={format?.aspect ?? '16:9'}
            save={save}
            onImage={(pos) => aiImage(pos)}
            scrollEl={scrollEl}
            pageEl={pageEl}
          />
          {showTrack && timing && <TrackGutter editor={editor} timing={timing} clips={trackClips} assets={assets} />}
          {showTimes && timing && <TimeGutter editor={editor} timing={timing} />}
          {/* título do roteiro no topo da página (o mesmo do campo lá em cima) */}
          <input
            className="page-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={(e) => draft && title === 'Sem título' && e.target.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.preventDefault()
                editor?.commands.focus('start')
              }
            }}
            placeholder="Título do vídeo"
            spellCheck={false}
          />
          <EditorContent editor={editor} className={'script' + hidden.map((h) => ' hide-' + h).join('')} />
        </div>
      </main>

      {panelOpen && (
        <aside className="side">
          <div className="panel-resize left" onPointerDown={(e) => startResize('right', e)} title="Arraste pra mudar a largura" />
          <div className="tabs">
            <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')} title="Conversar com a IA sobre o roteiro inteiro">
              ✨ IA
            </button>
            <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>
              Biblioteca
            </button>
            <button className={tab === 'folders' ? 'active' : ''} onClick={() => setTab('folders')}>
              Pastas
            </button>
            <button onClick={() => goMode('style')} title="Formatos e estilo de motion ficam no workspace Estilo">
              Estilo ↗
            </button>
          </div>
          {tab === 'ai' ? (
            <AiChatPanel dir={dir} getLines={() => docToLines(currentBlocks())} save={save} onDraft={openReview} />
          ) : tab === 'library' ? (
            <LibraryPanel
              items={library}
              onInsert={(i) => insertSnippet(i)}
              onEdit={(i) => setSnippet({ id: i.id, title: i.title, cover: i.cover })}
              onDelete={(i) => onLibraryChange(library.filter((x) => x.id !== i.id))}
            />
          ) : (
            <FoldersPanel extra={format?.assetFolders ?? []} />
          )}
        </aside>
      )}

      {timelineOpen && timing && (
        <div className="timeline-area">
          <Timeline
            editor={editor}
            dir={dir}
            timing={timing}
            clips={clips}
            onClipsChange={changeClips}
            tracks={tracks}
            onTracksChange={changeTracks}
            assets={assets}
            onAssetsChange={changeAssets}
            voice={voice}
            wpm={wpm}
            formatWpm={format?.wpm ?? 150}
            customWpm={customWpm !== null}
            onWpmChange={setCustomWpm}
          />
        </div>
      )}

      <footer className="statusbar">
        {stats && (
          <>
            <span className={'stat time' + (overLimit ? ' over' : '')}>
              <Clock size={13} /> ~{formatTime(stats.seconds)}
              {format?.maxSeconds ? <span className="muted"> / {formatTime(format.maxSeconds)}</span> : null}
            </span>
            {overLimit && (
              <span className="stat warn">
                <AlertTriangle size={13} /> passou do limite do formato
              </span>
            )}
            <span className="stat">{stats.words} palavras faladas</span>
            <span className="stat">{wpm} ppm</span>
            <button className={'stat stat-btn' + (refCount ? ' has' : '')} title="Ver e conferir as referências bibliográficas (vão pro rodapé/descrição)" onClick={() => setRefsOpen(true)}>
              📚 {refCount} {refCount === 1 ? 'referência' : 'referências'}
            </button>
            <span className="stat t-chapter">{stats.chapters} capítulos</span>
            <span className="stat t-prompt">{stats.prompts} prompts</span>
            <span className="stat t-transition">{stats.transitions} transições</span>
            <span className="stat t-soundUp">{stats.soundUps} sobe som</span>
            <span className="stat t-sonora">{stats.sonoras} pausas</span>
          </>
        )}
      </footer>

      {menu && (menuNode || spell || menu.sel || menu.ref || menu.prompt) && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          ref={(el) => {
            // não deixa o menu sair da tela
            if (!el) return
            const r = el.getBoundingClientRect()
            if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`
            if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`
          }}
          onMouseDown={(e) => {
            // mantém o foco no texto (a troca da palavra acontece onde está o cursor)
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          {(menu.sel || menu.ref || menu.prompt) && (
            <>
              {menu.sel && (
                <button
                  onClick={() => {
                    editor!.chain().focus().setTextSelection(menu.sel!).toggleBold().run()
                    setMenu(null)
                  }}
                >
                  {selIsBold ? <><b>N</b> Tirar negrito</> : <><b>N</b> Negritar</>} <kbd>Ctrl+B</kbd>
                </button>
              )}
              {menu.sel && !menu.prompt && (
                <button
                  onClick={() => {
                    setPromptEdit({ ...menu.sel!, text: '', excerpt: editor!.state.doc.textBetween(menu.sel!.from, menu.sel!.to, ' ') })
                    setMenu(null)
                  }}
                >
                  🎬 Criar prompt pra este trecho
                </button>
              )}
              {menu.prompt && (
                <>
                  <div className="ctx-label ctx-prompt">🎬 {menu.prompt.text.length > 60 ? menu.prompt.text.slice(0, 60) + '…' : menu.prompt.text}</div>
                  <button
                    onClick={() => {
                      const p = menu.prompt!
                      setPromptEdit({ from: p.from, to: p.to, text: p.text, id: p.id, excerpt: editor!.state.doc.textBetween(p.from, p.to, ' ') })
                      setMenu(null)
                    }}
                  >
                    Editar prompt do trecho
                  </button>
                  <button
                    onClick={() => {
                      // vira um bloco de prompt logo antes da fala (o jeito antigo)
                      const p = menu.prompt!
                      const ed = editor!
                      const $p = ed.state.doc.resolve(p.from)
                      const before = $p.before(1)
                      const excerpt = ed.state.doc.textBetween(p.from, p.to, ' ')
                      ed.chain()
                        .focus()
                        .command(({ tr }) => {
                          tr.removeMark(p.from, p.to, ed.schema.marks.promptRange)
                          tr.insert(before, ed.schema.nodes.prompt.create({}, ed.schema.text(`${p.text} (sobre "${excerpt}")`)))
                          return true
                        })
                        .run()
                      setMenu(null)
                    }}
                  >
                    Virar bloco de prompt
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      const p = menu.prompt!
                      editor!
                        .chain()
                        .focus()
                        .command(({ tr }) => {
                          tr.removeMark(p.from, p.to, editor!.schema.marks.promptRange)
                          return true
                        })
                        .run()
                      setMenu(null)
                    }}
                  >
                    Apagar prompt do trecho
                  </button>
                </>
              )}
              {menu.sel && !menu.ref && (
                <button
                  onClick={() => {
                    setRefEdit({ ...menu.sel!, text: '', excerpt: editor!.state.doc.textBetween(menu.sel!.from, menu.sel!.to, ' ') })
                    setMenu(null)
                  }}
                >
                  📚 Criar referência
                </button>
              )}
              {menu.ref && (
                <>
                  <div className="ctx-label ctx-ref">📚 {menu.ref.text.length > 60 ? menu.ref.text.slice(0, 60) + '…' : menu.ref.text}</div>
                  <button
                    onClick={() => {
                      const r = menu.ref!
                      setRefEdit({ from: r.from, to: r.to, text: r.text, id: r.id, excerpt: editor!.state.doc.textBetween(r.from, r.to, ' ') })
                      setMenu(null)
                    }}
                  >
                    Editar referência
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      const r = menu.ref!
                      editor!.chain().focus().command(({ tr }) => {
                        tr.removeMark(r.from, r.to, editor!.schema.marks.reference)
                        return true
                      }).run()
                      setMenu(null)
                    }}
                  >
                    Apagar referência
                  </button>
                </>
              )}
              {(spell || menuNode) && <div className="ctx-sep" />}
            </>
          )}
          {spell && (
            <>
              <div className="ctx-label">
                Corretor · <i>{spell.word}</i>
              </div>
              {spell.suggestions === null ? (
                <div className="ctx-label">buscando sugestões…</div>
              ) : spell.suggestions.length ? (
                spell.suggestions.slice(0, 6).map((w) => (
                  <button
                    key={w}
                    className="ctx-suggest"
                    onClick={() => {
                      editor?.view.dispatch(editor.state.tr.insertText(w, spell.from, spell.to))
                      setMenu(null)
                      setSpell(null)
                    }}
                  >
                    {w}
                  </button>
                ))
              ) : (
                <div className="ctx-label">sem sugestões</div>
              )}
              <button
                onClick={() => {
                  acceptWord(editor, spell.word)
                  setMenu(null)
                  setSpell(null)
                }}
              >
                Adicionar "{spell.word}" ao dicionário
              </button>
              {menuNode && <div className="ctx-sep" />}
            </>
          )}
          {menuNode && (
            <>
          {menuNode.type.name === 'paragraph' && menuNode.textContent.trim() && (
            <button
              className="ctx-ai"
              onClick={() => {
                aiRevise(menu.pos)
                setMenu(null)
              }}
            >
              ✨ Revisar fala com IA
            </button>
          )}
          {(menuNode.type.name === 'prompt' || menuNode.type.name === 'sonora') && (
            <button
              className="ctx-ai"
              onClick={() => {
                aiImage(menu.pos)
                setMenu(null)
              }}
            >
              ✨ Gerar imagem de referência com IA
            </button>
          )}
          <button onClick={startSaveSnippet}>Salvar na biblioteca…</button>
          <div className="ctx-sep" />
          <div className="ctx-label">Transformar em</div>
          {BLOCKS.filter((b) => b.type !== menuNode.type.name).map((b) => (
            <button key={b.type} className={'t-' + b.type} onClick={() => convertTo(b.type)}>
              {b.label}
              <span className="ctx-key">{b.key}</span>
            </button>
          ))}
          <div className="ctx-sep" />
          <button
            className="danger"
            onClick={() => {
              editor?.view.dispatch(editor.state.tr.delete(menu.pos, menu.pos + menuNode.nodeSize))
              setMenu(null)
            }}
          >
            Excluir bloco
          </button>
            </>
          )}
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
      {audioOpen && <AudioSettings onClose={() => setAudioOpen(false)} />}
      {helpOpen && (
        <div className="modal-backdrop" onMouseDown={() => setHelpOpen(null)}>
          <div className="modal help-modal" onMouseDown={(e) => e.stopPropagation()}>
            {helpOpen === 'keys' ? (
              <>
                <h3>Atalhos do teclado</h3>
                <div className="keys-grid">
                  <b>Roteiro</b>
                  <span>Ctrl+1…6</span><span>Capítulo, Prompt, Fala, Transição, Sobe som, Pausa</span>
                  <span>Ctrl+P</span><span>tocar a timeline</span>
                  <span>Ctrl+Z / Ctrl+Shift+Z</span><span>desfazer / refazer</span>
                  <span>Botão direito</span><span>corretor, referência, IA, biblioteca, trocar tipo</span>
                  <b>Arquivo</b>
                  <span>Ctrl+N / Ctrl+O</span><span>novo roteiro / abrir pasta</span>
                  <span>Ctrl+S / Ctrl+Shift+S</span><span>salvar / salvar como</span>
                  <span>Ctrl+,</span><span>configurações</span>
                  <b>Montagem</b>
                  <span>Espaço</span><span>tocar / parar (e parar a gravação)</span>
                  <span>R</span><span>gravar na faixa armada</span>
                  <span>V / C</span><span>seleção / lâmina</span>
                  <span>S</span><span>dividir no playhead</span>
                  <span>E</span><span>Emenda no corte</span>
                  <span>Delete / Shift+Delete</span><span>apagar / apagar e juntar</span>
                  <span>← → / Shift+← →</span><span>quadro a quadro / de corte em corte</span>
                  <span>+ / -</span><span>zoom</span>
                </div>
              </>
            ) : (
              <>
                <h3>Typos</h3>
                <p>Editor de roteiro pra YouTube: fala, prompts de motion, transições, sobe som, pausas, montagem da narração e referências.</p>
                <p className="muted small">github.com/ShinkiroG/Typos</p>
              </>
            )}
            <div className="modal-actions">
              <button className="btn primary" onClick={() => setHelpOpen(null)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
      {refTip && (
        <div className="ref-tip" style={{ left: refTip.x, top: refTip.y }}>
          {refTip.prompt && (
            <>
              <b className="k-prompt">🎬 Prompt do trecho</b>
              {refTip.prompt}
            </>
          )}
          {refTip.text && (
            <>
              <b>📚 Referência</b>
              {refTip.text}
            </>
          )}
        </div>
      )}
      {refEdit && (
        <RefModal
          edit={refEdit}
          onCancel={() => setRefEdit(null)}
          onSave={(text) => {
            const ed = editor!
            const mark = ed.schema.marks.reference.create({ id: refEdit.id ?? uid(), text: text.trim() })
            ed.chain()
              .focus()
              .command(({ tr }) => {
                tr.removeMark(refEdit.from, refEdit.to, ed.schema.marks.reference)
                tr.addMark(refEdit.from, refEdit.to, mark)
                return true
              })
              .run()
            setRefEdit(null)
          }}
        />
      )}
      {promptEdit && (
        <RefModal
          kind="prompt"
          edit={promptEdit}
          onCancel={() => setPromptEdit(null)}
          onSave={(text) => {
            const ed = editor!
            const mark = ed.schema.marks.promptRange.create({ id: promptEdit.id ?? uid(), text: text.trim() })
            ed.chain()
              .focus()
              .command(({ tr }) => {
                tr.removeMark(promptEdit.from, promptEdit.to, ed.schema.marks.promptRange)
                tr.addMark(promptEdit.from, promptEdit.to, mark)
                return true
              })
              .run()
            setPromptEdit(null)
          }}
        />
      )}
      {refsOpen && editor && (
        <RefsPanel
          refs={allReferences(editor)}
          onClose={() => setRefsOpen(false)}
          onJump={(r) => {
            setRefsOpen(false)
            editor.chain().focus().setTextSelection({ from: r.from, to: r.to }).scrollIntoView().run()
          }}
          onEdit={(r) => {
            setRefsOpen(false)
            setRefEdit({ from: r.from, to: r.to, text: r.text, id: r.id, excerpt: r.excerpt })
          }}
          onCopy={async (txt) => {
            await navigator.clipboard.writeText(txt)
            setToast('Referências copiadas! Cole na descrição do vídeo.')
          }}
        />
      )}
      {aiJob && (
        <div className="modal-backdrop" onMouseDown={() => aiJob.status !== 'running' && setAiJob(null)}>
          <div className="modal ai-modal" onMouseDown={(e) => e.stopPropagation()}>
            <h3>{aiJob.kind === 'revise' ? '✨ Revisar fala' : '✨ Imagem de referência'}</h3>
            {aiJob.status === 'running' && (
              <p className="muted">
                <Loader2 size={14} className="spin" /> A IA está trabalhando… (pode levar alguns segundos)
              </p>
            )}
            {aiJob.status === 'error' && (
              <>
                <p className="error">{aiJob.error}</p>
                <p className="muted small">Configure as conexões em ⚙ Configurações → IA.</p>
              </>
            )}
            {aiJob.status === 'done' && aiJob.kind === 'revise' && (
              <div className="ai-compare">
                <div>
                  <small>Original</small>
                  <p>{aiJob.original}</p>
                </div>
                <div>
                  <small>Sugestão · {PROVIDER_LABEL[aiJob.provider ?? ''] ?? aiJob.provider}</small>
                  <p className="ai-new">{aiJob.result}</p>
                </div>
              </div>
            )}
            {aiJob.status === 'done' && aiJob.kind === 'image' && (
              <p className="ok">Imagem gerada por {PROVIDER_LABEL[aiJob.provider ?? ''] ?? aiJob.provider} e anexada ao bloco ({aiJob.result}).</p>
            )}
            <div className="modal-actions">
              {aiJob.status === 'done' && aiJob.kind === 'revise' && (
                <>
                  <button className="btn" onClick={() => navigator.clipboard.writeText(aiJob.result ?? '')}>
                    Copiar
                  </button>
                  <button className="btn" onClick={() => (aiJob.kind === 'revise' ? aiRevise(aiJob.pos) : aiImage(aiJob.pos))}>
                    Tentar de novo
                  </button>
                  <button className="btn primary" onClick={applyRevision}>
                    Aplicar
                  </button>
                </>
              )}
              {aiJob.status !== 'running' && (
                <button className="btn" onClick={() => setAiJob(null)}>
                  Fechar
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {snippet && <SnippetModal draft={snippet} onCancel={() => setSnippet(null)} onSave={(d) => saveSnippet({ ...snippet, ...d })} />}
    </div>
  )
}

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* sem storage */
  }
}

/** grade da tela: [Inserir] | texto | [painel direito], com timeline opcional embaixo */
function gridLayout(left: boolean, right: boolean, timeline: boolean, leftW = 230, rightW = 320): React.CSSProperties {
  const cols = [left && `${leftW}px`, 'minmax(0, 1fr)', right && `${rightW}px`].filter(Boolean) as string[]
  const mid = [left && 'left', 'main', right && 'side'].filter(Boolean) as string[]
  const row = (name: string) => '"' + cols.map(() => name).join(' ') + '"'
  return {
    gridTemplateColumns: cols.join(' '),
    gridTemplateRows: '52px 1fr ' + (timeline ? 'auto ' : '') + '30px',
    gridTemplateAreas: [row('top'), '"' + mid.join(' ') + '"', timeline && row('timeline'), row('status')].filter(Boolean).join(' ')
  }
}
