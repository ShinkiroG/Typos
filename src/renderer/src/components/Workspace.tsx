import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, useEditorState, EditorContent, type Editor } from '@tiptap/react'
import { undoDepth } from '@tiptap/pm/history'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import type { EditorView } from '@tiptap/pm/view'
import type { JSONContent } from '@tiptap/core'
import { Home, FolderOpen, PanelRightOpen, PanelRightClose, AlertTriangle, Clock, Check, Loader2, AudioLines, Settings, Send, Save, PanelLeftOpen, PanelLeftClose } from 'lucide-react'
import { Prompt, Transition, SoundUp, Sonora, Chapter, ScriptKeys, SpeechTiming, convertBracketLines } from '../editor/nodes'
import { Timestamps, setTimestamps } from '../editor/timestamps'
import { FilterBar } from './FilterBar'
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
  type ProjectData
} from '../lib'
import { LibraryPanel, SNIPPET_MIME } from './LibraryPanel'
import { FormatsPanel } from './FormatsPanel'
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

export function Workspace({ dir, data, draft, onSavedAs, formats, onFormatsChange, library, onLibraryChange, onClose, onOpenSettings, registerFlush }: Props) {
  setProjectDir(dir)
  // a pasta muda depois do "Salvar…"; handlers criados uma vez leem daqui
  const dirRef = useRef(dir)
  dirRef.current = dir

  const [title, setTitle] = useState(data.title)
  const [formatId, setFormatId] = useState(data.formatId)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [panelOpen, setPanelOpen] = useState(true)
  const [tab, setTab] = useState<'library' | 'folders' | 'formats'>('library')
  const [leftOpen, setLeftOpen] = useState(() => stored('typos.left', true))
  const [hidden, setHidden] = useState<BlockType[]>(() => stored('typos.hidden', []))
  const [showTimes, setShowTimes] = useState(() => stored('typos.times', false))
  const [menu, setMenu] = useState<{ x: number; y: number; pos: number } | null>(null)
  const [snippet, setSnippet] = useState<(SnippetDraft & { node?: JSONContent }) | null>(null)

  const [clips, setClips] = useState<Clip[]>(data.timeline?.clips ?? [])
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

  const format = formats.find((f) => f.id === formatId) ?? formats[0]
  const wpm = customWpm ?? format?.wpm ?? 150

  // refs pros handlers do editor (que são criados uma vez só)
  const editorRef = useRef<Editor | null>(null)
  const libraryRef = useRef(library)
  libraryRef.current = library
  const metaRef = useRef({ title, formatId, format, clips, customWpm, wpm, tracks, assets })
  metaRef.current = { title, formatId, format, clips, customWpm, wpm, tracks, assets }

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
        api.importPaths(dirRef.current, paths).then((atts: Attachment[]) => attachTo(target, atts))
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
      e.preventDefault()
      e.stopPropagation()
      historyStep(k === 'y' || e.shiftKey ? 'redo' : 'undo')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [historyStep])

  useEffect(() => {
    if (timing) setTimestamps(editor, showTimes, timing.blockStarts)
  }, [editor, showTimes, timing])

  useEffect(() => {
    remember('typos.left', leftOpen)
    remember('typos.hidden', hidden)
    remember('typos.times', showTimes)
  }, [leftOpen, hidden, showTimes])

  /** clique num arquivo das Pastas: anexa no bloco atual (prompt/sonora) ou cria um prompt abaixo */
  const insertFile = async (path: string) => {
    const ed = editorRef.current
    if (!ed) return
    const atts: Attachment[] = await api.importPaths(dirRef.current, [path])
    const { $from } = ed.state.selection
    if ($from.depth < 1) return attachTo(ed.state.doc.content.size, atts)
    const holds = ['prompt', 'sonora'].includes($from.node(1).type.name)
    attachTo(holds ? $from.before(1) : $from.after(1), atts)
  }

  const snapshot = useCallback(() => {
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return null
    const { title, formatId, format, clips, customWpm, wpm, tracks, assets } = metaRef.current
    const out: ProjectData = {
      ...data,
      title,
      formatId,
      wpm: customWpm,
      timeline: { clips, tracks, assets },
      doc: ed.getJSON(),
      updatedAt: new Date().toISOString()
    }
    const md = toMarkdown(out, format, computeStats(ed.state.doc, wpm), buildTiming(ed.state.doc, wpm), wpm)
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
  }, [title, formatId, clips, customWpm, tracks, assets, save])

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
    if (!hit && !wrong) return setMenu(null)
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, pos: hit ? hit.pos : -1 })
  }

  const menuNode = menu && menu.pos >= 0 ? editor?.state.doc.nodeAt(menu.pos) : null

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
    <div className="workspace" style={gridLayout(leftOpen, panelOpen, timelineOpen)}>
      <header className="topbar">
        <div className="tb-left">
          <button className="icon-btn" title="Painel Inserir" onClick={() => setLeftOpen((o) => !o)}>
            {leftOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
          <button className="icon-btn" title="Voltar pros roteiros" onClick={async () => (await save(), onClose())}>
            <Home size={17} />
          </button>
          <input
            className="title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={(e) => draft && title === 'Sem título' && e.target.select()}
            spellCheck={false}
            placeholder="Nome do roteiro"
          />
        </div>
        <FilterBar hidden={hidden} onHidden={setHidden} showTimes={showTimes} onShowTimes={setShowTimes} />
        <div className="tb-right">
          <select className="format-select" value={formatId} onChange={(e) => setFormatId(e.target.value)} title={`Formato do vídeo · corretor: ${langLabel(lang)} (muda em Formatos)`}>
            {formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} · {f.aspect} · {formatLang(f) === 'off' ? 'sem corretor' : formatLang(f)}
              </option>
            ))}
          </select>
          {draft ? (
            <button className="btn small primary" title="Escolher onde salvar (Ctrl+S)" onClick={saveAs}>
              <Save size={14} /> Salvar…
            </button>
          ) : null}
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
          <button className="icon-btn" title="Abrir pasta do roteiro" onClick={() => api.openPath(dir)}>
            <FolderOpen size={17} />
          </button>
          <button className="icon-btn" title="Painel lateral" onClick={() => setPanelOpen((o) => !o)}>
            {panelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>
          <button className="icon-btn" title="Configurações" onClick={onOpenSettings}>
            <Settings size={17} />
          </button>
        </div>
      </header>

      {leftOpen && <InsertPanel editor={editor} />}

      <main className="editor-scroll" onContextMenu={onContextMenu}>
        <div className={'page aspect-' + (format?.aspect ?? '16:9').replace(':', 'x')}>
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
          <div className="tabs">
            <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>
              Biblioteca
            </button>
            <button className={tab === 'folders' ? 'active' : ''} onClick={() => setTab('folders')}>
              Pastas
            </button>
            <button className={tab === 'formats' ? 'active' : ''} onClick={() => setTab('formats')}>
              Formatos
            </button>
          </div>
          {tab === 'library' ? (
            <LibraryPanel
              items={library}
              onInsert={(i) => insertSnippet(i)}
              onEdit={(i) => setSnippet({ id: i.id, title: i.title, cover: i.cover })}
              onDelete={(i) => onLibraryChange(library.filter((x) => x.id !== i.id))}
            />
          ) : tab === 'folders' ? (
            <FoldersPanel onInsert={insertFile} />
          ) : (
            <FormatsPanel formats={formats} activeId={formatId} onChange={onFormatsChange} onSelect={setFormatId} />
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
            <span className="stat t-chapter">{stats.chapters} capítulos</span>
            <span className="stat t-prompt">{stats.prompts} prompts</span>
            <span className="stat t-transition">{stats.transitions} transições</span>
            <span className="stat t-soundUp">{stats.soundUps} sobe som</span>
            <span className="stat t-sonora">{stats.sonoras} pausas</span>
          </>
        )}
      </footer>

      {menu && (menuNode || spell) && (
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
function gridLayout(left: boolean, right: boolean, timeline: boolean): React.CSSProperties {
  const cols = [left && '230px', '1fr', right && '320px'].filter(Boolean) as string[]
  const mid = [left && 'left', 'main', right && 'side'].filter(Boolean) as string[]
  const row = (name: string) => '"' + cols.map(() => name).join(' ') + '"'
  return {
    gridTemplateColumns: cols.join(' '),
    gridTemplateRows: '52px 1fr ' + (timeline ? 'auto ' : '') + '30px',
    gridTemplateAreas: [row('top'), '"' + mid.join(' ') + '"', timeline && row('timeline'), row('status')].filter(Boolean).join(' ')
  }
}
