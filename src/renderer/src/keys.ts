/**
 * Atalhos que o usuário pode trocar (Ajuda → Atalhos do teclado, ou a tecla ?).
 * Ficam em settings.json (vão junto no "Exportar preferências"); o que não foi trocado
 * usa o padrão daqui.
 */

export interface KeyAction {
  id: string
  label: string
  group: 'Roteiro' | 'Montagem'
  def: string
}

export const KEY_ACTIONS: KeyAction[] = [
  { id: 'script.chapter', label: 'Capítulo', group: 'Roteiro', def: 'Ctrl+1' },
  { id: 'script.prompt', label: 'Prompt', group: 'Roteiro', def: 'Ctrl+2' },
  { id: 'script.speech', label: 'Fala', group: 'Roteiro', def: 'Ctrl+3' },
  { id: 'script.transition', label: 'Transição', group: 'Roteiro', def: 'Ctrl+4' },
  { id: 'script.soundUp', label: 'Sobe som', group: 'Roteiro', def: 'Ctrl+5' },
  { id: 'script.pause', label: 'Pausa', group: 'Roteiro', def: 'Ctrl+6' },
  { id: 'script.play', label: 'Tocar a timeline', group: 'Roteiro', def: 'Ctrl+P' },
  { id: 'mt.play', label: 'Tocar / parar (e parar a gravação)', group: 'Montagem', def: 'Space' },
  { id: 'mt.record', label: 'Gravar na faixa armada', group: 'Montagem', def: 'R' },
  { id: 'mt.select', label: 'Ferramenta de seleção', group: 'Montagem', def: 'V' },
  { id: 'mt.blade', label: 'Lâmina', group: 'Montagem', def: 'C' },
  { id: 'mt.split', label: 'Dividir no playhead', group: 'Montagem', def: 'S' },
  { id: 'mt.splice', label: 'Crossfade no corte', group: 'Montagem', def: 'E' },
  { id: 'mt.lettering', label: 'Lettering no cursor', group: 'Montagem', def: 'L' },
  { id: 'mt.block', label: 'Bloco de instrução', group: 'Montagem', def: 'B' },
  { id: 'mt.zoomIn', label: 'Mais zoom', group: 'Montagem', def: '+' },
  { id: 'mt.zoomOut', label: 'Menos zoom', group: 'Montagem', def: '-' }
]

let custom: Record<string, string> = {}
const listeners = new Set<() => void>()

export function setCustomKeys(k: Record<string, string> | undefined) {
  custom = { ...(k ?? {}) }
  listeners.forEach((f) => f())
}
export const customKeys = () => custom
export function onKeysChange(f: () => void) {
  listeners.add(f)
  return () => void listeners.delete(f)
}

export const keyOf = (id: string) => custom[id] ?? KEY_ACTIONS.find((a) => a.id === id)?.def ?? ''

const NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc'
}

/** a tecla apertada escrita do jeito que aparece na tela ("Ctrl+Shift+K", "Space", "+") */
export function comboOf(e: KeyboardEvent): string {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) return ''
  // Ctrl+número: o e.key muda com o Shift e o layout; o código físico não
  const digit = e.ctrlKey || e.metaKey ? e.code?.match(/^Digit(\d)$/)?.[1] : undefined
  const key = digit ?? NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
  // Shift só conta em letra/tecla nomeada: em símbolo ("+", "?") ele já mudou o caractere
  const symbol = !digit && e.key.length === 1 && !/[a-z0-9]/i.test(e.key) && e.key !== ' '
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey && !symbol ? 'Shift' : '', key].filter(Boolean).join('+')
}

export function isKey(e: KeyboardEvent, id: string) {
  const want = keyOf(id)
  if (!want) return false
  const got = comboOf(e)
  // "=" é o "+" sem Shift em muito teclado
  return got === want || (want === '+' && got === '=')
}

/** outra ação do mesmo grupo (ou Roteiro × Montagem com Ctrl) que já usa essa tecla */
export function conflictOf(id: string, combo: string): KeyAction | undefined {
  const me = KEY_ACTIONS.find((a) => a.id === id)
  return KEY_ACTIONS.find((a) => a.id !== id && keyOf(a.id) === combo && (a.group === me?.group || combo.startsWith('Ctrl+')))
}
