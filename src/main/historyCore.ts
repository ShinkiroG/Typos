import { isAbsolute, relative, resolve } from 'path'

/**
 * Regras do histórico de versões (sem Electron, pra testar): nome dos arquivos, contagem de
 * palavras, quais cópias ficam e conserto de caminhos de pasta que mudou de lugar.
 */

/** por que a cópia foi feita */
export type Reason = 'auto' | 'abertura' | 'corte' | 'antes-de-voltar' | 'salvar-como' | 'importado'
const REASONS: Reason[] = ['auto', 'abertura', 'corte', 'antes-de-voltar', 'salvar-como', 'importado']

export interface VersionInfo {
  name: string
  /** quando o roteiro estava assim (ms) */
  at: number
  reason: Reason
  words: number
}

/** cópia normal no máximo a cada 2 min */
export const EVERY_MS = 2 * 60_000
/** sumiram tantas palavras desde a última cópia: guarda o que estava no disco na hora */
export const DROP_WORDS = 60

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** as mais novas ficam sempre, mesmo velhas (roteiro parado há meses ainda tem a última sessão) */
const KEEP_NEWEST = 20
/** sem tirar nada: das últimas 2 h ficam todas */
const ALL_FOR = 2 * HOUR
/** até 7 dias: uma por hora */
const HOURLY_FOR = 7 * DAY
/** até 90 dias: uma por dia */
const DAILY_FOR = 90 * DAY
/** "antes de apagar texto" e "antes de voltar versão" ficam 30 dias inteiras */
const PROTECTED_FOR = 30 * DAY
const PROTECTED: Reason[] = ['corte', 'antes-de-voltar']

const p2 = (n: number) => String(n).padStart(2, '0')
export const stamp = (d: Date) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`

/** 20261017-015338_corte_1234w.json (com -2, -3… se cair no mesmo segundo) */
export const NAME = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?_([a-z-]+)_(\d+)w\.json$/
/** nome das cópias antigas em <projeto>/.typos-versoes */
export const LEGACY_NAME = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.json$/

export const versionName = (at: number, reason: Reason, words: number, n = 1) =>
  `${stamp(new Date(at))}${n > 1 ? '-' + n : ''}_${reason}_${Math.max(0, Math.round(words))}w.json`

const stampTime = (m: RegExpMatchArray) => new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()

export function parseName(name: string): VersionInfo | null {
  const m = name.match(NAME)
  if (!m || !REASONS.includes(m[7] as Reason)) return null
  return { name, at: stampTime(m), reason: m[7] as Reason, words: +m[8] }
}

export function legacyTime(name: string): number | null {
  const m = name.match(LEGACY_NAME)
  return m ? stampTime(m) : null
}

/** palavras do texto do roteiro (o doc do editor) */
export const countWords = (n: any): number =>
  typeof n?.text === 'string' ? n.text.split(/\s+/).filter(Boolean).length : Array.isArray(n?.content) ? n.content.reduce((s: number, c: any) => s + countWords(c), 0) : 0

/** só deixa entrar no caminho o que veio do próprio Typos */
export const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id)

/**
 * Quais cópias ficam. Das últimas 2 h, todas; até 7 dias, a mais nova de cada hora; até 90 dias,
 * a mais nova de cada dia. As 20 mais novas e as de proteção (até 30 dias) ficam sempre.
 */
export function pickKeep(items: VersionInfo[], now: number): Set<string> {
  const sorted = [...items].sort((a, b) => b.at - a.at)
  const keep = new Set<string>()
  const buckets = new Set<string>()
  sorted.forEach((v, i) => {
    const age = now - v.at
    if (i < KEEP_NEWEST || age < ALL_FOR || (PROTECTED.includes(v.reason) && age < PROTECTED_FOR)) {
      keep.add(v.name)
      return
    }
    let bucket: string | null = null
    if (age < HOURLY_FOR) bucket = 'h' + Math.floor(v.at / HOUR)
    else if (age < DAILY_FOR) bucket = 'd' + new Date(v.at).toDateString()
    if (bucket && !buckets.has(bucket)) {
      buckets.add(bucket)
      keep.add(v.name)
    }
  })
  return keep
}

/** o que fazer antes de gravar por cima do roteiro.json (null: nada) */
export function snapshotReason(o: {
  firstSaveThisSession: boolean
  latest: VersionInfo | null
  /** quando a última cópia foi gravada (ms) */
  latestWrittenAt: number | null
  diskWords: number
  newWords: number
  now: number
}): Reason | null {
  if (o.firstSaveThisSession) return 'abertura'
  if (!o.latest) return 'auto'
  if (o.latest.words - o.newWords >= DROP_WORDS && o.diskWords - o.newWords > 0) return 'corte'
  if (o.latestWrittenAt == null || o.now - o.latestWrittenAt >= EVERY_MS) return 'auto'
  return null
}

/** troca cada texto do JSON (em qualquer profundidade) pelo que fn devolver */
export function mapStrings(v: any, fn: (s: string) => string): any {
  if (typeof v === 'string') return fn(v)
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]))
  return v
}

const inside = (dir: string, p: string) => {
  const r = relative(resolve(dir), resolve(p))
  return !!r && !r.startsWith('..') && !isAbsolute(r)
}

/** caminhos que apontavam pra dentro de `from` passam a apontar pro mesmo lugar dentro de `to` */
export function relocatePaths(data: any, from: string, to: string): any {
  return mapStrings(data, (s) => (s.length < 1000 && isAbsolute(s) && inside(from, s) ? resolve(to, relative(resolve(from), resolve(s))) : s))
}

/**
 * Roteiro salvo a partir de um rascunho em versões antigas: a mídia ainda aponta pra
 * <userData>/autosaves/rascunho-…/, que foi apagada. Se o arquivo existe no mesmo lugar dentro
 * da pasta do roteiro, o caminho passa a apontar pra lá.
 */
export function repairDraftPaths(data: any, dir: string, exists: (p: string) => boolean): { data: any; changed: boolean } {
  let changed = false
  const fixed = mapStrings(data, (s) => {
    const m = s.length < 1000 ? s.match(/[\\/]autosaves[\\/]rascunho-[^\\/]+[\\/](.+)$/) : null
    if (!m || exists(s)) return s
    const here = resolve(dir, ...m[1].split(/[\\/]/))
    if (!exists(here)) return s
    changed = true
    return here
  })
  return { data: changed ? fixed : data, changed }
}

export const sameDir = (a: string, b: string) => {
  const x = resolve(a)
  const y = resolve(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}
