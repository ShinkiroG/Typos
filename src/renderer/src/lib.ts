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
}

export interface Format {
  id: string
  name: string
  aspect: string
  wpm: number
  maxSeconds: number | null
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
  createdAt: string
  updatedAt: string
}

export type BlockType = 'paragraph' | 'prompt' | 'transition' | 'soundUp' | 'chapter'

export const BLOCKS: { type: BlockType; label: string; key: string }[] = [
  { type: 'paragraph', label: 'Fala', key: 'Ctrl+1' },
  { type: 'prompt', label: 'Prompt', key: 'Ctrl+2' },
  { type: 'transition', label: 'Transição', key: 'Ctrl+3' },
  { type: 'soundUp', label: 'Sobe som', key: 'Ctrl+4' },
  { type: 'chapter', label: 'Capítulo', key: 'Ctrl+5' }
]

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
}

export const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

export function computeStats(doc: PMNode, wpm: number): Stats {
  const s: Stats = { words: 0, seconds: 0, chapters: 0, prompts: 0, transitions: 0, soundUps: 0 }
  let pause = 0
  doc.forEach((n) => {
    switch (n.type.name) {
      case 'paragraph':
        s.words += countWords(n.textContent)
        break
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
    }
  })
  s.seconds = (s.words / Math.max(wpm, 1)) * 60 + pause
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

export function toMarkdown(data: ProjectData, format: Format | undefined, stats: Stats): string {
  const out: string[] = []
  out.push(`# ${data.title}`, '')
  if (format) out.push(`- Formato: ${format.name} (${format.aspect}, ${RESOLUTIONS[format.aspect] ?? ''})`)
  out.push(`- Duração estimada: ${formatTime(stats.seconds)} (${stats.words} palavras faladas${format ? ` a ${format.wpm} ppm` : ''})`)
  out.push(`- Gerado pelo Typos em ${new Date().toLocaleString('pt-BR')}. Não edite este arquivo; a fonte é o roteiro.json.`, '')
  out.push('Legenda: linhas sem marcação = fala/narração. [PROMPT] = instrução de motion. [TRANSIÇÃO] e [SOBE SOM] = edição.', '')

  let chapter = 0
  for (const n of data.doc.content ?? []) {
    const text = jsonText(n).trim()
    switch (n.type) {
      case 'chapter':
        chapter++
        out.push('', `## ${chapter}. ${text}`, '')
        break
      case 'paragraph':
        if (text) out.push(text, '')
        break
      case 'prompt': {
        out.push(`[PROMPT] ${text}`)
        for (const a of (n.attrs?.attachments ?? []) as Attachment[]) out.push(`  - anexo: ${a.path}`)
        out.push('')
        break
      }
      case 'transition':
        out.push(`[TRANSIÇÃO: ${n.attrs?.kind}] ${text}`, '')
        break
      case 'soundUp':
        out.push(`[SOBE SOM ${n.attrs?.seconds}s] ${text}`, '')
        break
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

export const uid = () => Math.random().toString(36).slice(2, 10)
