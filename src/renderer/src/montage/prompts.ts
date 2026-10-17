/**
 * Prompts de motion já usados ("Como você imagina o motion"), pra reaproveitar
 * em outros blocos. Fica salvo neste PC (localStorage) e vale pro app inteiro:
 * os recentes entram sozinhos; os favoritos ficam até você tirar.
 */
export interface SavedPrompts {
  recent: string[]
  pinned: string[]
}

const KEY = 'typos.motionPrompts'
export const MAX_RECENT = 15

const norm = (t: string) => t.trim()

/** põe o texto no topo dos recentes (sem repetir; favoritos não entram nos recentes) */
export function pushRecent(s: SavedPrompts, text: string): SavedPrompts {
  const t = norm(text)
  if (!t || s.pinned.includes(t) || s.recent[0] === t) return s
  return { ...s, recent: [t, ...s.recent.filter((x) => x !== t)].slice(0, MAX_RECENT) }
}

/** fixa (ou desafixa) um texto como favorito; desafixado, volta pro topo dos recentes */
export function togglePin(s: SavedPrompts, text: string): SavedPrompts {
  const t = norm(text)
  if (!t) return s
  if (s.pinned.includes(t)) return pushRecent({ ...s, pinned: s.pinned.filter((x) => x !== t) }, t)
  return { recent: s.recent.filter((x) => x !== t), pinned: [t, ...s.pinned] }
}

/** esquece o texto (dos recentes e dos favoritos) */
export function forgetPrompt(s: SavedPrompts, text: string): SavedPrompts {
  const t = norm(text)
  return { recent: s.recent.filter((x) => x !== t), pinned: s.pinned.filter((x) => x !== t) }
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [])

export function loadPrompts(): SavedPrompts {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return { recent: strings(v?.recent).slice(0, MAX_RECENT), pinned: strings(v?.pinned) }
  } catch {
    return { recent: [], pinned: [] }
  }
}

export function savePrompts(s: SavedPrompts) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* sem espaço: segue sem salvar */
  }
}

/** muda os prompts salvos (lendo o que está salvo agora: a janela e o painel podem estar abertos juntos) */
export function updatePrompts(fn: (s: SavedPrompts) => SavedPrompts): SavedPrompts {
  const next = fn(loadPrompts())
  savePrompts(next)
  return next
}

/** guarda o texto nos recentes (ao gerar a prévia) */
export const rememberPrompt = (text: string) => {
  if (text.trim()) updatePrompts((s) => pushRecent(s, text))
}
