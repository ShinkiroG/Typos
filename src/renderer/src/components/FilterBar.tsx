import { Eye, Clock } from 'lucide-react'
import { BLOCKS, type BlockType } from '../lib'

interface Props {
  hidden: BlockType[]
  onHidden: (h: BlockType[]) => void
  showTimes: boolean
  onShowTimes: (v: boolean) => void
}

const ALL = BLOCKS.map((b) => b.type)

/**
 * Filtros de visualização do texto. Clique liga/desliga; Shift+clique deixa só ele;
 * Ctrl+clique esconde só ele (e mostra todos os outros).
 */
export function FilterBar({ hidden, onHidden, showTimes, onShowTimes }: Props) {
  const click = (type: BlockType, e: React.MouseEvent) => {
    if (e.shiftKey) onHidden(ALL.filter((t) => t !== type))
    else if (e.ctrlKey || e.metaKey) onHidden([type])
    else onHidden(hidden.includes(type) ? hidden.filter((t) => t !== type) : [...hidden, type])
  }

  return (
    <div className="tb-filters" title="Filtros: clique liga/desliga · Shift+clique mostra só ele · Ctrl+clique esconde só ele">
      <button
        className={'filter-all' + (hidden.length ? '' : ' on')}
        title="Mostrar todos"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onHidden([])}
      >
        <Eye size={15} />
      </button>
      {BLOCKS.map((b) => (
        <button
          key={b.type}
          className={'filter-btn t-' + b.type + (hidden.includes(b.type) ? '' : ' on')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => click(b.type, e)}
        >
          <span className="filter-dot" />
          {b.label}
        </button>
      ))}
      <span className="filter-sep" />
      <button
        className={'filter-btn t-time' + (showTimes ? ' on' : '')}
        title="Mostrar os tempos no texto (os mesmos da timeline)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onShowTimes(!showTimes)}
      >
        <Clock size={13} /> Tempos
      </button>
    </div>
  )
}
