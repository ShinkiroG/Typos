import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, useEditorState, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import type { EditorView } from '@tiptap/pm/view'
import type { JSONContent } from '@tiptap/core'
import { Home, FolderOpen, PanelRightOpen, PanelRightClose, AlertTriangle, Clock, Check, Loader2 } from 'lucide-react'
import { Prompt, Transition, SoundUp, Chapter, ScriptKeys, convertBracketLines } from '../editor/nodes'
import {
  api,
  absPath,
  BLOCKS,
  blockLabel,
  computeStats,
  formatTime,
  setProjectDir,
  toMarkdown,
  uid,
  type Attachment,
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
  formats: Format[]
  onFormatsChange: (f: Format[]) => void
  library: LibraryItem[]
  onLibraryChange: (l: LibraryItem[]) => void
  onClose: () => void
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

export function Workspace({ dir, data, formats, onFormatsChange, library, onLibraryChange, onClose, registerFlush }: Props) {
  setProjectDir(dir)

  const [title, setTitle] = useState(data.title)
  const [formatId, setFormatId] = useState(data.formatId)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [panelOpen, setPanelOpen] = useState(true)
  const [tab, setTab] = useState<'library' | 'formats'>('library')
  const [menu, setMenu] = useState<{ x: number; y: number; pos: number } | null>(null)
  const [snippet, setSnippet] = useState<(SnippetDraft & { node?: JSONContent }) | null>(null)

  const format = formats.find((f) => f.id === formatId) ?? formats[0]

  // refs pros handlers do editor (que são criados uma vez só)
  const editorRef = useRef<Editor | null>(null)
  const libraryRef = useRef(library)
  libraryRef.current = library
  const metaRef = useRef({ title, formatId, format })
  metaRef.current = { title, formatId, format }
  const timer = useRef<number | undefined>(undefined)

  const attachTo = useCallback((pos: number, atts: Attachment[]) => {
    const ed = editorRef.current
    if (!ed || !atts.length) return
    const node = ed.state.doc.nodeAt(pos)
    if (node?.type.name === 'prompt') {
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
      if (ext.length) node.attrs!.attachments = await api.importPaths(dir, ext.map((a) => a.path))
      ed.chain()
        .insertContentAt(at ?? afterCurrentBlock(ed), node)
        .focus()
        .run()
    },
    [dir]
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
      ScriptKeys
    ],
    content: data.doc,
    autofocus: 'end',
    onUpdate: () => {
      setSaveState('dirty')
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => save(), 1000)
    },
    editorProps: {
      attributes: { spellcheck: 'true' },
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
        const files = Array.from(dt.files).filter((f) => f.type.startsWith('image/'))
        if (!files.length) return false
        event.preventDefault()
        const hit = blockAtCoords(view, event.clientX, event.clientY)
        const target = hit?.node.type.name === 'prompt' ? hit.pos : dropPosition(view, event.clientX, event.clientY)
        api.importPaths(dir, files.map((f) => api.pathForFile(f))).then((atts: Attachment[]) => attachTo(target, atts))
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
            for (const f of files) atts.push(await api.importBuffer(dir, f.name || 'colado.png', new Uint8Array(await f.arrayBuffer())))
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
  const stats = useMemo(() => (doc ? computeStats(doc, format?.wpm ?? 150) : null), [doc, format?.wpm])
  const overLimit = !!(stats && format?.maxSeconds && stats.seconds > format.maxSeconds)

  const save = useCallback(async () => {
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return
    window.clearTimeout(timer.current)
    const { title, formatId, format } = metaRef.current
    const out: ProjectData = { ...data, title, formatId, doc: ed.getJSON(), updatedAt: new Date().toISOString() }
    setSaveState('saving')
    const md = toMarkdown(out, format, computeStats(ed.state.doc, format?.wpm ?? 150))
    const r = await api.saveProject(dir, out, md)
    setSaveState(r && typeof r === 'object' && 'error' in r ? 'error' : 'saved')
  }, [data, dir])

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
  }, [title, formatId, save])

  useEffect(() => {
    registerFlush(save)
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      registerFlush(null)
    }
  }, [save, registerFlush])

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

  const setBlock = (type: string) => editor?.chain().focus().setNode(type).run()

  const onContextMenu = (e: React.MouseEvent) => {
    if (!editor) return
    const hit = blockAtCoords(editor.view, e.clientX, e.clientY)
    if (!hit) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, pos: hit.pos })
  }

  const menuNode = menu ? editor?.state.doc.nodeAt(menu.pos) : null

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
    <div className={'workspace' + (panelOpen ? ' with-panel' : '')}>
      <header className="topbar">
        <div className="tb-left">
          <button className="icon-btn" title="Voltar pros roteiros" onClick={async () => (await save(), onClose())}>
            <Home size={17} />
          </button>
          <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} spellCheck={false} />
        </div>
        <div className="tb-blocks">
          {BLOCKS.map((b) => (
            <button
              key={b.type}
              className={'blk-btn t-' + b.type + (currentBlock === b.type ? ' active' : '')}
              title={`${b.label} (${b.key})`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setBlock(b.type)}
            >
              {b.label}
            </button>
          ))}
        </div>
        <div className="tb-right">
          <select className="format-select" value={formatId} onChange={(e) => setFormatId(e.target.value)} title="Formato do vídeo">
            {formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} · {f.aspect}
              </option>
            ))}
          </select>
          <span className={'save-state ' + saveState} title="Salva sozinho (Ctrl+S força)">
            {saveState === 'saving' && <Loader2 size={13} className="spin" />}
            {saveState === 'saved' && <Check size={13} />}
            {{ saved: 'Salvo', dirty: 'Editando…', saving: 'Salvando', error: 'Erro ao salvar' }[saveState]}
          </span>
          <button className="icon-btn" title="Abrir pasta do roteiro" onClick={() => api.openPath(dir)}>
            <FolderOpen size={17} />
          </button>
          <button className="icon-btn" title="Painel lateral" onClick={() => setPanelOpen((o) => !o)}>
            {panelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>
        </div>
      </header>

      <main className="editor-scroll" onContextMenu={onContextMenu}>
        <div className={'page aspect-' + (format?.aspect ?? '16:9').replace(':', 'x')}>
          <EditorContent editor={editor} className="script" />
        </div>
      </main>

      {panelOpen && (
        <aside className="side">
          <div className="tabs">
            <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>
              Biblioteca
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
          ) : (
            <FormatsPanel formats={formats} activeId={formatId} onChange={onFormatsChange} onSelect={setFormatId} />
          )}
        </aside>
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
            <span className="stat">{format?.wpm} ppm</span>
            <span className="stat t-chapter">{stats.chapters} capítulos</span>
            <span className="stat t-prompt">{stats.prompts} prompts</span>
            <span className="stat t-transition">{stats.transitions} transições</span>
            <span className="stat t-soundUp">{stats.soundUps} sobe som</span>
          </>
        )}
      </footer>

      {menu && menuNode && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
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
        </div>
      )}

      {snippet && <SnippetModal draft={snippet} onCancel={() => setSnippet(null)} onSave={(d) => saveSnippet({ ...snippet, ...d })} />}
    </div>
  )
}
