/**
 * Rascunho do "Pedir ajustes" de cada bloco: o texto e as imagens que você ainda
 * não enviou. Fechar o painel (ou trocar de bloco, ou fechar o app) não perde nada;
 * o rascunho só some quando o ajuste é enviado. Fica salvo neste PC (localStorage).
 */
import type { Attachment } from '../lib'

export interface AdjustDraft {
  text: string
  files: Attachment[]
}

const KEY = 'typos.adjustDrafts'
/** rascunhos guardados no máximo (os mais antigos saem) */
export const MAX_DRAFTS = 60

type Store = Record<string, AdjustDraft & { t: number }>

function load(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

function save(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* sem espaço: segue sem salvar */
  }
}

export function loadDraft(key: string): AdjustDraft {
  const d = load()[key]
  return {
    text: typeof d?.text === 'string' ? d.text : '',
    files: Array.isArray(d?.files) ? d.files.filter((a) => a && typeof a.id === 'string' && typeof a.path === 'string') : []
  }
}

/** guarda o rascunho; vazio, apaga */
export function saveDraft(key: string, d: AdjustDraft) {
  const s = load()
  if (!d.text.trim() && !d.files.length) {
    if (!(key in s)) return
    delete s[key]
  } else {
    s[key] = { text: d.text, files: d.files, t: Date.now() }
    // o que acabou de ser salvo nunca sai; dos outros, saem os mais antigos
    const old = Object.keys(s).filter((k) => k !== key).sort((a, b) => (s[b].t ?? 0) - (s[a].t ?? 0))
    for (const k of old.slice(MAX_DRAFTS - 1)) delete s[k]
  }
  save(s)
}

export const hasDraft = (key: string) => {
  const d = loadDraft(key)
  return !!d.text.trim() || !!d.files.length
}

export const clearDraft = (key: string) => saveDraft(key, { text: '', files: [] })
