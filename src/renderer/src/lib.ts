import type { JSONContent } from '@tiptap/core'
import { blockPrompts } from './editor/promptMark'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Api } from '../../preload'

declare global {
  interface Window {
    api: Api
  }
}

/** padrão do roteiro: todo capítulo vira lettering capitular (cada um pode mudar) */
let letteringDefault = true
export const setLetteringDefault = (v: boolean) => {
  letteringDefault = v
}
export const letteringOn = (attrs?: Record<string, any>) => (attrs?.lettering ?? letteringDefault) as boolean
export const letteringAttr = (on: boolean) => (on === letteringDefault ? null : on)

export const api: typeof window.api = {
  ...window.api,
  aiText: (job) =>
    window.api.aiText({
      ...job,
      instruction:
        job.instruction +
        '\n\nTrechos entre **asteriscos duplos** estão em negrito no roteiro: é ênfase na fala (o narrador destaca). Mantenha e use **negrito** do mesmo jeito.' +
        '\n[CAPÍTULO + LETTERING] = esse capítulo abre com um lettering capitular no vídeo (transição de capítulo com o nome dele); [CAPÍTULO] sozinho = sem lettering.'
    })
}

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
  /** onde a prévia aparece: na margem esquerda (padrão) ou dentro do texto */
  place?: 'margin' | 'inline'
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
  /** instrução do estilo pro Claude: como é o visual/motion (vai no treino e em todo motion; nunca no Roteiro) */
  rules?: string
  /** prompt negativo do estilo: o que a IA nunca deve fazer no motion */
  negative?: string
  /** o formato tem referência visual de motion? (imagens/vídeos em userData/format-media) */
  motionRef?: boolean
  motionRefFiles?: string[]
  /** pastas de assets que esse formato sempre usa (aparecem nas Pastas quando ele está ativo); antigas, hoje espelha as pastas "visual" de styleFolders */
  assetFolders?: string[]
  /** pastas do PC ligadas ao estilo, com categoria (ver styleFoldersOf) */
  styleFolders?: StyleFolder[]
  /** treino de motion (workspace Estilo) */
  motion?: MotionStyle
  /** só na tela de Formatos: editado e ainda não salvo */
  __dirty?: boolean
}

/**
 * Categoria de uma pasta do estilo. visual: logo, pngtuber, molduras (o motion sempre pode usar);
 * raw, sfx e music: como as categorias da Montagem, entram junto do Material bruto do projeto
 * quando o bloco liga "Usar o Material bruto".
 */
export type StyleFolderRole = 'visual' | 'raw' | 'sfx' | 'music'
export interface StyleFolder {
  /** a pasta do PC (só a referência: nada é copiado) */
  path: string
  role: StyleFolderRole
  /** favorita: o Claude procura aqui primeiro, antes das outras pastas (e ela vem primeiro na lista) */
  star?: boolean
  /** o que tem nela ou quando usar (vai pro Claude) */
  note?: string
}
export const STYLE_FOLDER_ROLES: { role: StyleFolderRole; label: string }[] = [
  { role: 'visual', label: 'Visual do estilo' },
  { role: 'raw', label: 'Material bruto' },
  { role: 'sfx', label: 'SFX' },
  { role: 'music', label: 'Música' }
]
/** as pastas do estilo (estilos antigos só tinham assetFolders, todas visuais) */
export const styleFoldersOf = (f?: Format): StyleFolder[] => f?.styleFolders ?? (f?.assetFolders ?? []).map((path) => ({ path, role: 'visual' as const }))

/** perfil de um som (main/soundProfile.ts): impacto, começo, fim, volume e curva de energia */
export type SoundProfile = NonNullable<Awaited<ReturnType<typeof window.api.soundProfiles>>[number]>

/** o perfil em uma linha, como vai pro Claude */
export function profileText(p: SoundProfile) {
  const s = (x: number) => (x < 10 ? x.toFixed(2) : x.toFixed(1)).replace(/\.?0+$/, '') + ' s'
  return [
    `começa em ${s(p.attack)}`,
    `impacto em ${s(p.peakAt)}`,
    `some em ${s(p.tail)}`,
    p.lufs !== undefined ? `${Math.round(p.lufs)} LUFS` : `pico ${Math.round(p.peakDb)} dBFS`,
    `energia (0–9) a cada ${String(p.step).replace('.', ',')} s: ${p.env}`
  ].join(', ')
}

export interface MotionRef {
  id: string
  kind: 'image' | 'video' | 'link'
  /** imagem: cópia em userData/format-media; vídeo: o arquivo original */
  path?: string
  url?: string
  name: string
  /** quadros-chave tirados do vídeo (o que a IA olha) */
  frames?: string[]
  /** antigo slider único (0 = só estética, 100 = só motion): vale só enquanto os dois pesos abaixo não existem */
  focus?: number
  /** peso da estética dessa referência (cores, tipografia, composição): 0 = ignora, 100 = segue à risca */
  aesthetic?: number
  /** peso do motion dessa referência (câmera, transições, ritmo): 0 = ignora, 100 = segue à risca */
  motion?: number
  /** com motion no máximo: manda sequências quadro a quadro (24/s), mais lento e caro */
  frameByFrame?: boolean
  /** o que observar nessa referência */
  note?: string
}

export interface FontCase {
  id: string
  name: string
  mode: 'dynamic' | 'favorites'
  favorites: string[]
}

/** os dois pesos de uma referência (referências antigas vêm do slider único) */
/** estilos antigos tinham "Regras do estilo" e "Instrução pro Claude" separadas: junta tudo em rules */
export function migrateFormat(f: Format): Format {
  const instr = f.motion?.instruction?.trim()
  if (!f.motion || f.motion.instruction === undefined) return f
  const { instruction: _, ...motion } = f.motion
  const rules = f.rules?.trim() ?? ''
  const merged = !instr || rules.includes(instr) ? rules : rules ? `${rules}\n\n${instr}` : instr
  return { ...f, rules: merged || undefined, motion }
}

export function refWeights(r: MotionRef) {
  const f = r.focus ?? 50
  return { aesthetic: r.aesthetic ?? 100 - f, motion: r.motion ?? f, frameByFrame: !!r.frameByFrame && (r.motion ?? f) >= 100 }
}

export const DEFAULT_FONT_CASES = (): FontCase[] =>
  ['Terror', 'Impacto', 'Lettering 1', 'Lettering 2', 'Console / código', 'Uso geral'].map((name, i) => ({ id: 'fc' + i, name, mode: 'dynamic', favorites: [] }))

export interface MotionStyle {
  refs: MotionRef[]
  /** antigo: a instrução pro Claude separada; hoje vive em Format.rules (ver migrateFormat) */
  instruction?: string
  /** as 4 fontes principais do projeto */
  fonts?: { title?: string; subtitle?: string; body?: string; accent?: string }
  /** fontes por situação (terror, impacto, lettering…): o Claude escolhe (dinâmica) ou vem das favoritas */
  fontCases?: FontCase[]
  colors?: string[]
  background?: string
  camera?: string[]
  transitions?: string[]
  pace?: 'calmo' | 'médio' | 'frenético'
  /** memória de motion: exemplos aprovados que as prévias e o render seguem */
  memory?: MotionMemoryItem[]
  /** o que o Claude estudou nas pastas do estilo: como usar cada asset (markdown); vai junto pros blocos */
  assetsGuide?: {
    at: string
    provider: string
    guide: string
    /** as pastas estudadas (pra avisar quando mudarem) */
    folders: string[]
  }
  /** o que a IA aprendeu: guia do estilo + demo animada */
  learned?: {
    at: string
    provider: string
    guide: string
    demoHtml: string
  }
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
  /** anotações livres do autor (painel da esquerda) */
  notes?: string
  /** workspace de Montagem: mídia, cortes da narração e timeline de edição */
  montage?: MontageData
  /** todo capítulo vira lettering capitular (padrão: sim) */
  chapterLettering?: boolean
  /** workspace Criar Clipes (recortes curtos pra Reels/TikTok/Shorts); some até ser ativado */
  shorts?: ShortsData
  /** workspace Render: a fila e a pasta de export */
  render?: RenderSettings
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
const jsonText = (n: JSONContent): string => inlineMd(n, '\n')

/**
 * Texto de um bloco com o negrito em **markdown** (é ênfase na fala: a IA precisa saber).
 * Trechos vizinhos em negrito viram um só.
 */
export function inlineMd(n: JSONContent, br = ' '): string {
  // pedaços seguidos com o mesmo "negrito ou não" viram um só
  const segs: { text: string; bold: boolean }[] = []
  const walk = (node: JSONContent) => {
    for (const c of node.content ?? []) {
      const piece = c.type === 'text' ? { text: c.text ?? '', bold: !!c.marks?.some((m) => m.type === 'bold') } : c.type === 'hardBreak' ? { text: br, bold: false } : null
      if (!piece) {
        walk(c)
        continue
      }
      const last = segs[segs.length - 1]
      if (last && last.bold === piece.bold) last.text += piece.text
      else segs.push(piece)
    }
  }
  walk(n)
  // espaço da borda fica fora dos ** ("**palavra** fim", nunca "**palavra **fim")
  return segs
    .map((s) => {
      if (!s.bold) return s.text
      const m = s.text.match(/^(\s*)([\s\S]*?)(\s*)$/)!
      return m[2] ? `${m[1]}**${m[2]}**${m[3]}` : s.text
    })
    .join('')
}

/** o contrário: "texto com **negrito**" → nós de texto com a marca bold */
export function mdToJson(text: string): JSONContent[] {
  const out: JSONContent[] = []
  text.split(/(\*\*[^*]+?\*\*)/g).forEach((part) => {
    if (!part) return
    const m = part.match(/^\*\*([^*]+)\*\*$/)
    out.push(m ? { type: 'text', text: m[1], marks: [{ type: 'bold' }] } : { type: 'text', text: part })
  })
  return out
}

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
        out.push('', `## ${chapter}. ${text} ${at}${letteringOn(n.attrs) ? ' — lettering capitular' : ''}`, '')
        break
      case 'paragraph':
        if (text) {
          out.push(`${at} ${text}${n.attrs?.seconds ? ` (ritmo: ${n.attrs.seconds}s)` : ''}`)
          // prompts presos a trechos dessa fala
          for (const p of blockPrompts(n)) out.push(`> [PROMPT em "${p.excerpt}"] ${p.text}`)
          out.push('')
        }
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
  if (data.notes?.trim()) out.push('', '## Anotações do autor', '', data.notes.trim())
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

// ---------- Montagem ----------
/** narração = vai pro corte automático; bruto = material do vídeo; custom = pasta criada pelo usuário */
export type BinRole = 'narration' | 'raw' | 'sfx' | 'custom'
export interface MontageBin {
  id: string
  name: string
  role: BinRole
  /** pasta dentro de outra (organização); sem parent = categoria (aba do topo) */
  parent?: string
  /** cor da categoria */
  color?: string
  /** favorita: o Claude procura aqui primeiro, antes das outras pastas */
  star?: boolean
  /** pasta do PC vinculada: mostra o que tem lá, ao vivo (sem copiar) */
  linked?: string
}
export interface MontageMedia {
  id: string
  bin: string
  /** caminho absoluto: o arquivo fica onde está (não é copiado) */
  path: string
  name: string
  kind: MediaKind
  duration: number
  hasAudio: boolean
  hasVideo: boolean
  width?: number
  height?: number
  fps?: number
  /** motion aprovado de um bloco: o HTML que gerou o clipe (o bloco seguinte continua dele) */
  motionHtml?: string
  /** o bloco que gerou o clipe (instruções, anexos, ajustes): o editor do motion parte dele */
  motionBlock?: InstructionBlock
  /** qualidade com que o clipe de motion foi gravado (ver CLIP_ENC); sem isso, gravado antes da v3 */
  motionEnc?: number
}
export interface MontageTrack {
  id: string
  kind: 'video' | 'audio'
  name: string
  muted?: boolean
  /** faixa onde o corte automático põe a narração editada (fica logo abaixo da original) */
  auto?: boolean
  /** altura da faixa na timeline (px); sem valor = padrão do tipo */
  height?: number
}
/** curva do fade: ponto de controle (bezier quadrática) no quadrado 0..1; [0.5, 0.5] = linear */
export type FadeCurve = [number, number]
export interface MontageClip {
  id: string
  track: string
  media: string
  /** início na timeline (s) */
  start: number
  /** trecho do arquivo usado (s) */
  in: number
  out: number
  /** volume em dB (0 = original) */
  gainDb?: number
  fadeIn?: number
  fadeOut?: number
  /** formato dos fades (sem valor = linear) */
  fadeInCurve?: FadeCurve
  fadeOutCurve?: FadeCurve
  /** crossfade com o clipe imediatamente antes, na mesma faixa (s); o nome antigo era Emenda */
  splice?: number
  /** bloco do roteiro (índice no documento) que esse trecho fala */
  block?: number
  /** o som do próprio clipe não toca nem entra no render (ex.: clipe de motion que já traz a narração do trecho) */
  audioOff?: boolean
}
export interface MontageData {
  bins: MontageBin[]
  media: MontageMedia[]
  tracks: MontageTrack[]
  clips: MontageClip[]
  /** duração padrão do crossfade (s) */
  spliceDefault?: number
  /** alvo da normalização da narração: "peak:-6" (pico em dBFS) ou "lufs:-16" (volume percebido) */
  norm?: string
  /** marcações na timeline: onde entra o lettering de cada capítulo e quanto tempo fica */
  markers?: MontageMarker[]
  /** duração padrão de um lettering novo (s) */
  letteringDur?: number
  /** blocos de instrução de motion (como um sólido do Premiere, nas faixas de vídeo) */
  blocks?: InstructionBlock[]
}
export interface MontageMarker {
  id: string
  kind: 'lettering'
  /** começo na timeline (s) */
  t: number
  /** duração fixa (s) */
  dur: number
  /** bloco do capítulo no roteiro */
  block: number
  /** título do capítulo (pra mostrar e mandar pro Claude) */
  label: string
}

/** anexo de um bloco: entra no vídeo (insert, anotado com setas etc.) ou é só referência pra recriar em motion */
export interface BlockAttachment extends Attachment {
  use: 'insert' | 'ref'
  /** o que fazer com ele (opcional) */
  note?: string
}

export interface BlockPreview {
  /** vídeo da prévia (12 fps, baixa resolução) e o HTML que gerou ela (caminhos absolutos) */
  video: string
  html: string
  at: string
  provider: string
  /** o que foi ouvido no trecho (Whisper) */
  transcript: string
  /** impressão digital do bloco quando a prévia foi feita (muda = prévia desatualizada) */
  key: string
  /** o que continuou fora da safe zone depois da correção automática */
  safeIssues?: string[]
  /** tamanho (px) em que o HTML foi escrito; o clipe final amplia a partir dele */
  size?: { w: number; h: number }
  /** sons do Material bruto que o Claude pôs no motion (tempo a partir do começo do bloco); viram cortes de áudio ao aprovar */
  sounds?: BlockSound[]
}

/** um som posto pelo Claude no motion de um bloco */
export interface BlockSound {
  path: string
  name: string
  /** começo (s) a partir do começo do bloco */
  at: number
  /** volume 0–1 */
  vol: number
  /** duração do arquivo (s), lida ao mixar a prévia */
  duration?: number
  /** a pasta da Montagem de onde ele veio (pra virar mídia ao aprovar) */
  bin?: string
}

/** Bloco de instrução: um pedaço de tempo da faixa de vídeo com instruções de motion pro Claude. */
export interface InstructionBlock {
  id: string
  /** faixa de vídeo */
  track: string
  start: number
  end: number
  name?: string
  /** dinâmico: o Claude deduz o motion pela fala do trecho (o texto vira só dica) */
  dynamic?: boolean
  /** como o autor imagina o motion */
  text: string
  /** prompt negativo do bloco: o que evitar neste motion (soma com o do estilo) */
  negative?: string
  attachments: BlockAttachment[]
  preview?: BlockPreview
  /** o autor aprovou a prévia (o render reaproveita a ideia) */
  approved?: boolean
  /** quanto o motion acompanha a fala: 0 = não sincroniza, 1 = sincroniza tudo (sem valor = 0,3) */
  sync?: number
  /** ajustes pedidos sobre a prévia atual (a conversa com o Claude); some quando a prévia é refeita do zero */
  tweaks?: BlockTweak[]
  /** começa no último quadro do que toca logo antes (bloco encostado ou o vídeo da timeline): sem corte seco */
  fromPrev?: boolean
  /** termina chegando no primeiro quadro do que toca logo depois (motion até o próximo) */
  toNext?: boolean
  /** estilo (formato) só deste bloco; vazio = o estilo do vídeo */
  formatId?: string
  /** o Claude pode usar o Material bruto do projeto (imagens, vídeos e sons, mais os sons da pasta SFX) */
  useRaw?: boolean
}

/** um pedido de ajuste na prévia de um bloco */
export interface BlockTweak {
  id: string
  at: string
  text: string
  /** imagens mandadas junto (prints, referências, algo pra pôr no vídeo) */
  files: Attachment[]
}

/** memória de motion: o que o autor aprovou (demo do Estilo, prévias de blocos, notas) */
export interface MotionMemoryItem {
  id: string
  at: string
  source: 'estilo' | 'bloco' | 'nota'
  title: string
  /** o que deu certo, em palavras */
  text: string
  /** código da animação aprovada (resumido), pra servir de exemplo */
  html?: string
}

export const clipDur = (c: MontageClip) => c.out - c.in
export const clipEndT = (c: MontageClip) => c.start + c.out - c.in

export function defaultMontage(): MontageData {
  return {
    bins: [
      { id: 'narration', name: 'Narração / Talking head', role: 'narration' },
      { id: 'raw', name: 'Material bruto', role: 'raw' },
      { id: 'sfx', name: 'SFX', role: 'sfx' }
    ],
    media: [],
    tracks: [
      { id: 'V1', kind: 'video', name: 'V1 · Vídeo' },
      { id: 'A1', kind: 'audio', name: 'A1 · Narração' },
      { id: 'A2', kind: 'audio', name: 'A2 · Música/SFX' }
    ],
    clips: [],
    spliceDefault: 0.02
  }
}

// ---------- Criar Clipes (recortes curtos) ----------
/** tempos alvo dos recortes (s): sempre mira o ideal; o máximo é folga pra não cortar uma ideia no meio */
export interface ShortTarget {
  min: number
  ideal: number
  max: number
}
export interface ShortClip {
  id: string
  title: string
  /** por que o Claude escolheu esse trecho */
  reason?: string
  /** trecho da timeline principal de onde ele saiu (s) */
  from: number
  to: number
  /** a timeline própria do recorte (começa em 0) */
  montage: MontageData
  /** aprovado: entra na fila de render */
  approved?: boolean
  /** último export: arquivo e a impressão digital da timeline quando saiu (mudou = exporta de novo) */
  exported?: { path: string; key: string; at: string }
}
export interface ShortsData {
  target: ShortTarget
  /** proporção dos recortes ("9:16" pra Reels/TikTok/Shorts) */
  aspect: string
  items: ShortClip[]
  /** formato (estilo) dos recortes; vazio = o mesmo da Montagem */
  formatId?: string
  analyzedAt?: string
  provider?: string
}
export const SHORT_TARGET_DEFAULT: ShortTarget = { min: 25, ideal: 45, max: 60 }

// ---------- Render: fila e pasta de export ----------
/** item da fila: "main" (o vídeo da Montagem) ou "short-<id>" (um recorte do Criar Clipes) */
export type RenderItemId = 'main' | `short-${string}`
export const shortRenderId = (shortId: string): RenderItemId => `short-${shortId}`
export interface RenderSettings {
  /** o que está esperando pra renderizar, na ordem */
  queue?: RenderItemId[]
  /** pasta onde os vídeos prontos são copiados; vazio = só fica em render/ dentro do projeto */
  exportDir?: string
  /** último render do vídeo principal (pra prévia) */
  mainExport?: { path: string; at: string }
}
/** põe (ou tira) itens na fila de render, sem repetir */
export function queueRenderItems(r: RenderSettings, ids: RenderItemId[], on = true): RenderSettings {
  const q = r.queue ?? []
  return { ...r, queue: on ? [...q, ...ids.filter((id, i) => !q.includes(id) && ids.indexOf(id) === i)] : q.filter((x) => !ids.includes(x)) }
}
