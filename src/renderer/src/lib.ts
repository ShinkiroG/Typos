import type { JSONContent } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Api } from '../../preload'

declare global {
  interface Window {
    api: Api
  }
}

export const api = window.api

export interface Attachment {
  id: string
  /** relativo à pasta do projeto ("assets/x.png"), ou absoluto quando vem da biblioteca */
  path: string
  name: string
  external?: boolean
  /** anexos antigos não têm: são imagens */
  kind?: MediaKind
  /** fluxo de aprovação: referência solta → aprovada → pedir recorte / pedir pra regerar */
  status?: AttachmentStatus
}

export type AttachmentStatus = 'ref' | 'aprovado' | 'recortar' | 'regerar'

export type MediaKind = 'image' | 'audio' | 'video'
export const mediaKindOf = (path: string): MediaKind => {
  const e = path.toLowerCase().split('.').pop() ?? ''
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'].includes(e)) return 'audio'
  if (['mp4', 'webm', 'mov', 'm4v'].includes(e)) return 'video'
  return 'image'
}
export const kindOf = (a: Attachment) => a.kind ?? mediaKindOf(a.path)

// ---------- prévia de áudio: um player só pro app inteiro ----------
const previewPlayer = typeof Audio !== 'undefined' ? new Audio() : null
let previewUrl = ''
const notifyAudio = () =>
  window.dispatchEvent(new CustomEvent('typos:audio', { detail: { url: previewUrl, playing: !!previewPlayer && !previewPlayer.paused } }))
previewPlayer?.addEventListener('ended', notifyAudio)
previewPlayer?.addEventListener('pause', notifyAudio)
previewPlayer?.addEventListener('play', notifyAudio)

export function toggleAudioPreview(url: string) {
  if (!previewPlayer) return
  if (previewUrl === url && !previewPlayer.paused) previewPlayer.pause()
  else {
    previewUrl = url
    previewPlayer.src = url
    previewPlayer.play().catch(() => null)
  }
}
export const isPreviewing = (url: string) => !!previewPlayer && previewUrl === url && !previewPlayer.paused

export const ATTACHMENT_STATUS: { id: AttachmentStatus; label: string; hint: string }[] = [
  { id: 'ref', label: 'Referência', hint: 'só referência visual' },
  { id: 'aprovado', label: 'Aprovada', hint: 'usar como está' },
  { id: 'recortar', label: 'Recortar', hint: 'o Claude recorta os elementos' },
  { id: 'regerar', label: 'Regerar', hint: 'refazer no ChatGPT' }
]

/** Clipe de áudio na timeline. Keyframes de volume ficam no tempo da FONTE, então cortar/aparar não mexe no envelope. */
export interface Clip {
  id: string
  /** '' = bloco de um asset ainda sem arquivo (placeholder) */
  path: string
  name: string
  kind: AssetKind
  /** veio de um asset do projeto (o nome e o arquivo seguem o asset) */
  assetId?: string
  lane: number
  /** início na timeline (s) */
  start: number
  /** a partir de onde o arquivo toca (s) */
  offset: number
  duration: number
  sourceDuration: number
  /** volume geral do clipe (1 = 100%) */
  gain: number
  keys: { t: number; v: number }[]
}

export type AssetKind = 'music' | 'soundUp' | 'sfx'

export const ASSET_KINDS: { id: AssetKind; label: string }[] = [
  { id: 'music', label: 'Música' },
  { id: 'soundUp', label: 'Sobe som' },
  { id: 'sfx', label: 'SFX' }
]

export const ASSET_COLORS = ['#7c8cff', '#f472b6', '#f7b955', '#4fe0c4', '#5eb3ff', '#a99bff', '#ff8a5c', '#9be15d']

/** cores por tipo: música em tons amarelados, SFX em ciano, sobe som em rosa */
export const KIND_PALETTE: Record<AssetKind, string[]> = {
  music: ['#f5c542', '#e8b230', '#ffd866', '#d9a521', '#f2d07a'],
  sfx: ['#22d3ee', '#5ee7f5', '#0fb5cc', '#67e8f9'],
  soundUp: ['#f472b6', '#f9a8d4', '#ec4899']
}

/** Asset do projeto: "Música 1", "Sobe som A"… pode existir sem arquivo e ganhar um depois. */
export interface TimelineAsset {
  id: string
  name: string
  kind: AssetKind
  color: string
  /** arquivo vinculado (relativo ao projeto), se já tiver */
  path?: string
}

/** Nome de cada faixa (linha) da timeline, na ordem. */
export interface Track {
  id: string
  name: string
}

export interface TimelineData {
  clips: Clip[]
  tracks?: Track[]
  assets?: TimelineAsset[]
}

export const DEFAULT_TRACKS = ['Música', 'Sobe som']

export interface Format {
  id: string
  name: string
  aspect: string
  wpm: number
  maxSeconds: number | null
  /** idioma do corretor ortográfico ("pt-BR", "en-US"… ou "off"); vazio = pt-BR */
  lang?: string
}

export const formatLang = (f?: Format) => f?.lang || 'pt-BR'

/** "pt-BR" → "português (Brasil)" */
export function langLabel(code: string) {
  if (code === 'off') return 'desligado'
  try {
    return new Intl.DisplayNames(['pt-BR'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

export interface LibraryItem {
  id: string
  title: string
  cover: string | null
  node: JSONContent
}

export interface ProjectData {
  version: 1
  title: string
  formatId: string
  doc: JSONContent
  /** palavras/min deste roteiro; vazio = usa o do formato */
  wpm?: number | null
  timeline?: TimelineData
  createdAt: string
  updatedAt: string
}

export type BlockType = 'paragraph' | 'prompt' | 'transition' | 'soundUp' | 'sonora' | 'chapter'

export const BLOCKS: { type: BlockType; label: string; key: string }[] = [
  { type: 'chapter', label: 'Capítulo', key: 'Ctrl+1' },
  { type: 'prompt', label: 'Prompt', key: 'Ctrl+2' },
  { type: 'paragraph', label: 'Fala', key: 'Ctrl+3' },
  { type: 'transition', label: 'Transição', key: 'Ctrl+4' },
  { type: 'soundUp', label: 'Sobe som', key: 'Ctrl+5' },
  { type: 'sonora', label: 'Pausa', key: 'Ctrl+6' }
]

/** blocos que não são fala mas ocupam tempo no vídeo */
export const TIMED_PAUSES = ['soundUp', 'sonora']

export const blockLabel = (type: string) => BLOCKS.find((b) => b.type === type)?.label ?? type

export const TRANSITIONS = [
  'Corte seco',
  'Crossfade',
  'Fade preto',
  'Fade branco',
  'Whip pan',
  'Zoom in',
  'Zoom out',
  'Glitch',
  'Wipe',
  'Match cut',
  'Flash',
  'Personalizada'
]

export const RESOLUTIONS: Record<string, string> = {
  '16:9': '1920×1080',
  '9:16': '1080×1920',
  '1:1': '1080×1080',
  '4:5': '1080×1350'
}

// ---------- caminhos de arquivo ----------
let projectDir = ''
export const setProjectDir = (dir: string) => (projectDir = dir)
export const getProjectDir = () => projectDir

export const fileUrl = (abs: string) => 'rs://local/' + encodeURIComponent(abs)
export const absPath = (a: Attachment) => (a.external ? a.path : `${projectDir}\\${a.path.replace(/\//g, '\\')}`)
export const attachmentUrl = (a: Attachment) => fileUrl(absPath(a))

/** Lê uma imagem da área de transferência e salva em assets/. */
export async function pasteClipboardImage(dir: string): Promise<Attachment | null> {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (!type) continue
      const blob = await item.getType(type)
      return api.importBuffer(dir, `colado.${type.split('/')[1]}`, new Uint8Array(await blob.arrayBuffer()))
    }
  } catch {
    /* sem permissão ou vazio */
  }
  return null
}

export const openPreview = (src: string) => window.dispatchEvent(new CustomEvent('rs:preview', { detail: src }))

// ---------- estatísticas ----------
export interface Stats {
  words: number
  seconds: number
  chapters: number
  prompts: number
  transitions: number
  soundUps: number
  sonoras: number
}

export const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

export function computeStats(doc: PMNode, wpm: number): Stats {
  const s: Stats = { words: 0, seconds: 0, chapters: 0, prompts: 0, transitions: 0, soundUps: 0, sonoras: 0 }
  let pause = 0
  let speech = 0
  doc.forEach((n) => {
    switch (n.type.name) {
      case 'paragraph': {
        const words = countWords(n.textContent)
        s.words += words
        // fala com ritmo próprio (esticada/encolhida na timeline) usa a duração dela
        speech += Number(n.attrs.seconds) || (words / Math.max(wpm, 1)) * 60
        break
      }
      case 'chapter':
        s.chapters++
        break
      case 'prompt':
        s.prompts++
        break
      case 'transition':
        s.transitions++
        break
      case 'soundUp':
        s.soundUps++
        pause += Number(n.attrs.seconds) || 0
        break
      case 'sonora':
        s.sonoras++
        pause += Number(n.attrs.seconds) || 0
        break
    }
  })
  s.seconds = speech + pause
  return s
}

export function formatTime(totalSeconds: number) {
  const t = Math.round(totalSeconds)
  const m = Math.floor(t / 60)
  const sec = t % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

// ---------- export em Markdown (é o arquivo que o Claude lê) ----------
const jsonText = (n: JSONContent): string =>
  (n.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : c.type === 'hardBreak' ? '\n' : jsonText(c))).join('')

const STATUS_TAG: Record<string, string> = { aprovado: ' [APROVADA]', recortar: ' [RECORTAR]', regerar: ' [REGERAR]' }

export function toMarkdown(data: ProjectData, format: Format | undefined, stats: Stats, timing: Timing, wpm: number): string {
  const out: string[] = []
  out.push(`# ${data.title}`, '')
  if (format) out.push(`- Formato: ${format.name} (${format.aspect}, ${RESOLUTIONS[format.aspect] ?? ''})`)
  out.push(`- Duração estimada: ${formatTime(stats.seconds)} (${stats.words} palavras faladas a ${wpm} ppm)`)
  out.push(`- Pasta do roteiro: os caminhos abaixo são relativos a esta pasta.`)
  out.push(`- Gerado pelo Typos em ${new Date().toLocaleString('pt-BR')}. Não edite este arquivo; a fonte é o roteiro.json.`, '')
  out.push('Legenda: linhas sem marcação = fala/narração. [PROMPT] = instrução de motion. [TRANSIÇÃO] e [SOBE SOM] = edição. [PAUSA] = a narração para (respiro ou trecho mostrado com som original). `(m:ss)` = tempo estimado na timeline.')
  out.push('Imagens: [APROVADA] usar como está · [RECORTAR] recortar os elementos (salvar PNG transparente em assets/recortes/ com o mesmo nome) · [REGERAR] refazer no ChatGPT.', '')

  // cada música/SFX é anotada no bloco em que começa (o último bloco que começa antes dela)
  const blocks = data.doc.content ?? []
  const allClips = data.timeline?.clips ?? []
  const trackNames = data.timeline?.tracks ?? []
  const cues = new Map<number, string[]>()
  for (const c of [...allClips].sort((a, b) => a.start - b.start)) {
    let idx = 0
    blocks.forEach((b, i) => {
      const timed = b.type === 'paragraph' || b.type === 'sonora' || b.type === 'soundUp'
      if (timed && (timing.blockStarts[i] ?? 0) <= c.start + 1e-6) idx = i
    })
    const kind = ASSET_KINDS.find((k) => k.id === c.kind)?.label.toUpperCase() ?? 'ÁUDIO'
    const track = trackNames[c.lane]?.name ?? DEFAULT_TRACKS[c.lane] ?? `Faixa ${c.lane + 1}`
    const line = `  ♪ [${kind}] "${c.name}" começa aqui (${formatTime(c.start)} → ${formatTime(c.start + c.duration)}, faixa "${track}"${c.path ? '' : ', ainda sem arquivo'})`
    cues.set(idx, [...(cues.get(idx) ?? []), line])
  }

  let chapter = 0
  ;(data.doc.content ?? []).forEach((n, i) => {
    // música/SFX que começa neste trecho aparece logo antes da fala
    const cue = cues.get(i)
    if (cue) out.push(...cue)
    const text = jsonText(n).trim()
    const at = `(${formatTime(timing.blockStarts[i] ?? 0)})`
    switch (n.type) {
      case 'chapter':
        chapter++
        out.push('', `## ${chapter}. ${text} ${at}`, '')
        break
      case 'paragraph':
        if (text) out.push(`${at} ${text}${n.attrs?.seconds ? ` (ritmo: ${n.attrs.seconds}s)` : ''}`, '')
        break
      case 'prompt': {
        out.push(`${at} [PROMPT] ${text}`)
        for (const a of (n.attrs?.attachments ?? []) as Attachment[]) out.push(`  - anexo: ${a.path}${STATUS_TAG[a.status ?? ''] ?? ''}`)
        out.push('')
        break
      }
      case 'transition':
        out.push(`${at} [TRANSIÇÃO: ${n.attrs?.kind}] ${text}`, '')
        break
      case 'soundUp':
        out.push(`${at} [SOBE SOM ${n.attrs?.seconds}s] ${text}`, '')
        break
      case 'sonora': {
        out.push(`${at} [PAUSA ${n.attrs?.seconds}s, sem narração] ${text}`)
        for (const a of (n.attrs?.attachments ?? []) as Attachment[]) out.push(`  - anexo: ${a.path}${STATUS_TAG[a.status ?? ''] ?? ''}`)
        out.push('')
        break
      }
    }
  })

  const clips = [...(data.timeline?.clips ?? [])].sort((a, b) => a.start - b.start)
  if (clips.length) {
    out.push('', '## Trilha de áudio', '')
    const tracks = data.timeline?.tracks ?? []
    for (const c of clips) {
      const kindLabel = ASSET_KINDS.find((k) => k.id === c.kind)?.label ?? 'Áudio'
      const where = ` · faixa "${tracks[c.lane]?.name ?? DEFAULT_TRACKS[c.lane] ?? `Faixa ${c.lane + 1}`}"`
      if (!c.path) {
        out.push(`- ${kindLabel} "${c.name}" (ainda sem arquivo)${where} · entra ${formatTime(c.start)} · dura ${c.duration.toFixed(1)}s`)
        continue
      }
      const keys = c.keys.length
        ? ' · volume: ' + c.keys.map((k) => `${formatTime(c.start + k.t - c.offset)}→${Math.round(k.v * 100)}%`).join(', ')
        : ''
      out.push(
        `- ${kindLabel} "${c.name}" (${c.path})${where} · entra ${formatTime(c.start)} · dura ${c.duration.toFixed(1)}s · começa em ${c.offset.toFixed(1)}s do arquivo · volume ${Math.round(c.gain * 100)}%${keys}`
      )
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

// ---------- timing: texto → tempo (por palavras/min) ----------
export interface WordTime {
  from: number
  to: number
  start: number
  end: number
  text: string
}

export interface Segment {
  kind: string
  pos: number
  start: number
  end: number
  label: string
}

export interface Timing {
  words: WordTime[]
  segments: Segment[]
  /** tempo de início de cada bloco de nível superior, na ordem do documento */
  blockStarts: number[]
  total: number
}

export function buildTiming(doc: PMNode, wpm: number): Timing {
  const perWord = 60 / Math.max(wpm, 1)
  const words: WordTime[] = []
  const segments: Segment[] = []
  const blockStarts: number[] = []
  let t = 0

  doc.forEach((node, offset) => {
    blockStarts.push(t)
    const name = node.type.name
    const label = node.textContent.trim()
    if (name === 'paragraph') {
      // cada palavra ganha um pedaço proporcional ao tamanho, mas o total respeita o ppm
      const local: { from: number; to: number; text: string; w: number }[] = []
      node.descendants((child, pos) => {
        if (!child.isText) return
        for (const m of child.text!.matchAll(/\S+/g)) {
          const from = offset + 1 + pos + m.index!
          local.push({ from, to: from + m[0].length, text: m[0], w: m[0].length + 3 })
        }
      })
      if (!local.length) return
      const dur = Number(node.attrs.seconds) || local.length * perWord
      const sumW = local.reduce((s, x) => s + x.w, 0)
      const start = t
      for (const x of local) {
        const d = (x.w / sumW) * dur
        words.push({ from: x.from, to: x.to, start: t, end: t + d, text: x.text })
        t += d
      }
      segments.push({ kind: name, pos: offset, start, end: t, label })
    } else if (name === 'soundUp' || name === 'sonora') {
      const d = Number(node.attrs.seconds) || 0
      segments.push({ kind: name, pos: offset, start: t, end: t + d, label: label || (name === 'sonora' ? 'pausa' : 'sobe som') })
      t += d
    } else {
      segments.push({ kind: name, pos: offset, start: t, end: t, label })
    }
  })
  return { words, segments, blockStarts, total: t }
}

/** Índice da palavra tocando no tempo t (busca binária); -1 se nenhuma. */
export function wordAt(words: WordTime[], t: number) {
  let lo = 0
  let hi = words.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].start <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found >= 0 && t < words[found].end + 0.05 ? found : -1
}

// ---------- envelope de volume ----------
/** Volume (0..1) do envelope no tempo da fonte; sem keyframes = 1. */
export function envelopeAt(keys: Clip['keys'], srcT: number) {
  if (!keys.length) return 1
  if (srcT <= keys[0].t) return keys[0].v
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]
    const b = keys[i]
    if (srcT <= b.t) return a.v + ((b.v - a.v) * (srcT - a.t)) / Math.max(b.t - a.t, 1e-6)
  }
  return keys[keys.length - 1].v
}

export const clipEnd = (c: Clip) => c.start + c.duration

export const uid = () => Math.random().toString(36).slice(2, 10)
