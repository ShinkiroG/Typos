import type { HistoryVersion } from '../../preload'

/** o que a tela de Histórico mostra de cada versão (sem React, pra testar) */

export const REASON_LABEL: Record<HistoryVersion['reason'], string> = {
  auto: '',
  abertura: 'ao abrir',
  corte: 'antes de apagar texto',
  'antes-de-voltar': 'antes de voltar versão',
  'salvar-como': 'antes de salvar como',
  importado: 'cópia antiga'
}

const nodeText = (n: any): string => (typeof n?.text === 'string' ? n.text : Array.isArray(n?.content) ? n.content.map(nodeText).join('') : '')
const words = (s: string) => s.split(/\s+/).filter(Boolean).length

export interface ChapterInfo {
  title: string
  words: number
  /** o texto dos blocos do capítulo, um por parágrafo */
  text: string
}

/** capítulos do roteiro com o texto de cada um (o que vem antes do 1º capítulo entra como "Início") */
export function docChapters(doc: any): ChapterInfo[] {
  const out: ChapterInfo[] = []
  let cur: { title: string; parts: string[] } | null = null
  const close = () => {
    if (!cur) return
    const text = cur.parts.join('\n\n')
    if (cur.title !== '' || words(text)) out.push({ title: cur.title || 'Início', words: words(text), text })
  }
  for (const node of doc?.content ?? []) {
    if (node?.type === 'chapter') {
      close()
      cur = { title: nodeText(node).trim() || 'Capítulo sem nome', parts: [] }
      continue
    }
    if (!cur) cur = { title: '', parts: [] }
    const t = nodeText(node).trim()
    if (t) cur.parts.push(t)
  }
  close()
  return out
}

/** diferença de palavras de cada capítulo da versão pro roteiro de agora (pelo nome do capítulo) */
export function chapterDiff(version: ChapterInfo[], current: ChapterInfo[] | null): (number | null)[] {
  if (!current) return version.map(() => null)
  const now = new Map<string, number>()
  for (const c of current) now.set(c.title, (now.get(c.title) ?? 0) + c.words)
  return version.map((c) => c.words - (now.get(c.title) ?? 0))
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

export function dayLabel(at: number, now = Date.now()) {
  const d = new Date(at)
  const today = new Date(now)
  if (sameDay(d, today)) return 'Hoje'
  if (sameDay(d, new Date(now - 86_400_000))) return 'Ontem'
  const wd = d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')
  return `${wd}, ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })}`
}

export const timeLabel = (at: number) => new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

export interface VersionRow extends HistoryVersion {
  /** palavras a mais (ou a menos) que a versão anterior */
  delta: number | null
}

/** versões agrupadas por dia, da mais nova pra mais velha */
export function groupByDay(versions: HistoryVersion[], now = Date.now()): { label: string; items: VersionRow[] }[] {
  const sorted = [...versions].sort((a, b) => b.at - a.at)
  const groups: { label: string; items: VersionRow[] }[] = []
  sorted.forEach((v, i) => {
    const prev = sorted[i + 1]
    const label = dayLabel(v.at, now)
    let g = groups[groups.length - 1]
    if (!g || g.label !== label) groups.push((g = { label, items: [] }))
    g.items.push({ ...v, delta: prev ? v.words - prev.words : null })
  })
  return groups
}

export const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toLocaleString('pt-BR')
