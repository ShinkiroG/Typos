import { Heading, MessageSquareText, Brackets, ArrowLeftRight, Music, Tv } from 'lucide-react'
import type { Editor } from '@tiptap/react'
import { BLOCKS, type BlockType } from '../lib'

const ITEMS: { type: BlockType; icon: React.ReactNode; hint: string }[] = [
  { type: 'chapter', icon: <Heading size={16} />, hint: 'divide o vídeo em partes' },
  { type: 'prompt', icon: <Brackets size={16} />, hint: 'instrução de motion / imagem' },
  { type: 'paragraph', icon: <MessageSquareText size={16} />, hint: 'o texto narrado' },
  { type: 'transition', icon: <ArrowLeftRight size={16} />, hint: 'troca de cena' },
  { type: 'soundUp', icon: <Music size={16} />, hint: 'a trilha sobe, narração pausa' },
  { type: 'sonora', icon: <Tv size={16} />, hint: 'a narração para: respiro ou trecho mostrado' }
]

/** Linha atual vazia vira o bloco; senão cria um bloco novo logo abaixo. */
export function insertBlock(editor: Editor | null, type: BlockType) {
  if (!editor) return
  const { $from } = editor.state.selection
  if ($from.depth < 1) {
    editor.chain().focus().insertContentAt(editor.state.doc.content.size, { type }).run()
    return
  }
  if ($from.node(1).content.size === 0) {
    editor.chain().focus().setNode(type).run()
    return
  }
  const pos = $from.after(1)
  editor
    .chain()
    .focus()
    .insertContentAt(pos, { type })
    .setTextSelection(pos + 1)
    .scrollIntoView()
    .run()
}

export function InsertPanel({ editor }: { editor: Editor | null }) {
  return (
    <aside className="left-panel">
      <div className="lp-title">Inserir</div>
      {ITEMS.map((it) => {
        const b = BLOCKS.find((x) => x.type === it.type)!
        return (
          <button
            key={it.type}
            className={'insert-btn t-' + it.type}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insertBlock(editor, it.type)}
            title={`Insere na linha atual (${b.key})`}
          >
            <span className="insert-icon">{it.icon}</span>
            <span className="insert-text">
              <b>{b.label}</b>
              <small>{it.hint}</small>
            </span>
            <kbd>{b.key.replace('Ctrl+', '^')}</kbd>
          </button>
        )
      })}

      <div className="lp-title">Dicas</div>
      <ul className="lp-tips">
        <li>
          <code>[texto]</code> numa linha vira prompt
        </li>
        <li>
          <code>#</code> + espaço vira capítulo
        </li>
        <li>
          <kbd>Ctrl+V</kbd> no prompt cola imagem
        </li>
        <li>
          <kbd>Ctrl+P</kbd> toca a timeline
        </li>
        <li>Botão direito: corretor, salvar na biblioteca, trocar tipo</li>
        <li>Na timeline: arraste a fala pra direita e o vão vira pausa; estique a borda pra mudar o ritmo</li>
        <li>Botão direito nas faixas da timeline: criar pausa, bloco de música ou SFX</li>
      </ul>
    </aside>
  )
}
