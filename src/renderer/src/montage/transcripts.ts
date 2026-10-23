import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, type MontageData } from '../lib'
import type { WhisperJob } from '../../../preload'

/**
 * Leitura do áudio (Whisper) em segundo plano: o main tem a fila e o cache por arquivo; aqui fica o
 * espelho da fila (todas as partes do app enxergam a mesma) e o "já foi lido?" de cada arquivo.
 */

export type { WhisperJob }

let jobs: WhisperJob[] = []
/** muda quando algum arquivo termina de ser lido (ou o modelo muda): o "lido?" é perguntado de novo */
let version = 0
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

const live = (j: WhisperJob) => j.state === 'queued' || j.state === 'running'

function receive(next: WhisperJob[]) {
  const ended = jobs.some((j) => live(j) && !next.some((n) => n.path === j.path && n.lang === j.lang && live(n)))
  jobs = next
  if (ended) version++
  emit()
}
// (nos testes não tem preload)
api.onWhisperJobs?.(receive)
api.whisperJobs?.().then(receive)

const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

/** a fila do Whisper inteira, ao vivo */
export const useWhisperJobs = () => useSyncExternalStore(subscribe, () => jobs)

/** pergunta de novo o que já foi lido (ex.: trocou o modelo) */
export function recheckRead() {
  version++
  emit()
}

/** manda ler (e guardar) o áudio desses arquivos, em segundo plano */
export const readAudio = (paths: string[], lang: string) => (paths.length ? api.whisperQueue([...new Set(paths)], lang) : Promise.resolve())

/** quais desses arquivos já têm a transcrição guardada (null = ainda perguntando) */
export function useReadCache(paths: string[], lang: string) {
  const v = useSyncExternalStore(subscribe, () => version)
  const key = [...new Set(paths)].sort().join('\n')
  const [read, setRead] = useState<{ key: string; map: Record<string, boolean> } | null>(null)
  useEffect(() => {
    let off = false
    if (!key) return setRead({ key: `${lang}|`, map: {} })
    api.whisperCached(key.split('\n'), lang).then((map) => !off && setRead({ key: `${lang}|${key}`, map }))
    return () => {
      off = true
    }
  }, [key, lang, v])
  return read?.key === `${lang}|${key}` ? read.map : null
}

export type ReadState = { kind: 'done' } | { kind: 'running'; job: WhisperJob } | { kind: 'queued' } | { kind: 'error'; error: string } | { kind: 'todo' }

export function readState(path: string, lang: string, cache: Record<string, boolean> | null, list: WhisperJob[]): ReadState {
  const j = list.find((x) => x.path === path && x.lang === lang)
  if (j?.state === 'running') return { kind: 'running', job: j }
  if (j?.state === 'queued') return { kind: 'queued' }
  if (cache?.[path]) return { kind: 'done' }
  if (j?.state === 'error') return { kind: 'error', error: j.error ?? 'falhou' }
  return { kind: 'todo' }
}

/** o que dizer de um arquivo sendo lido: etapa, % e quanto falta */
export function jobLabel(j: WhisperJob) {
  if (j.stage === 'audio') return 'extraindo o áudio…'
  if (j.stage === 'model' || !j.pct) return 'carregando o modelo…'
  const pct = Math.round(j.pct * 100)
  if (!j.since || j.pct < 0.03) return `${pct}%`
  const left = ((Date.now() - j.since) / j.pct) * (1 - j.pct) / 1000
  return `${pct}% · ${left < 60 ? 'menos de 1 min' : `~${Math.round(left / 60)} min`}`
}

/** % de um arquivo na fila (null = não está sendo lido) */
export const jobPct = (path: string, lang: string) => {
  const j = jobs.find((x) => x.path === path && x.lang === lang && x.state === 'running')
  return j ? (j.stage === 'listen' ? j.pct : 0) : null
}

/** como vai a leitura de um arquivo ('' = não está na fila) */
export const runningLabel = (path: string, lang: string) => {
  const j = jobs.find((x) => x.path === path && x.lang === lang && live(x))
  return !j ? '' : j.state === 'queued' ? 'na fila…' : jobLabel(j)
}

/** espera mudanças na fila (devolve como parar) */
export const watchJobs = (f: () => void) => subscribe(f)

const nameOf = (p: string) => p.split(/[\\/]/).pop() ?? p

/**
 * Arquivos com fala de uma timeline: cortes com som em faixas ligadas e armadas pra escuta, menos os da pasta SFX.
 * É o que o corte automático, os blocos e o Criar Clipes vão precisar transcrever.
 */
export function speechFiles(d: MontageData): { path: string; name: string }[] {
  const binById = new Map(d.bins.map((b) => [b.id, b]))
  const roleOf = (id: string) => {
    let cur = binById.get(id)
    for (let i = 0; cur?.parent && i < 20; i++) cur = binById.get(cur.parent)
    return cur?.role
  }
  const muted = new Set(d.tracks.filter((t) => t.muted || t.deaf).map((t) => t.id))
  const media = new Map(d.media.map((m) => [m.id, m]))
  const out = new Map<string, string>()
  for (const c of d.clips) {
    const m = media.get(c.media)
    if (!m?.hasAudio || muted.has(c.track) || c.audioOff || roleOf(m.bin) === 'sfx') continue
    out.set(m.path, m.name || nameOf(m.path))
  }
  return [...out].map(([path, name]) => ({ path, name }))
}
