import {
  absPath,
  api,
  fileUrl,
  clipEndT,
  formatTime,
  RESOLUTIONS,
  uid,
  type Attachment,
  type BlockAttachment,
  type BlockSound,
  type BlockTweak,
  type Format,
  type InstructionBlock,
  type MediaKind,
  type MontageData,
  type MotionMemoryItem,
  type SoundProfile,
  profileText,
  styleFoldersOf,
  type StyleFolderRole
} from '../lib'
import { roleLabel } from '../style/assets'
import { envAt, envPoints, spans, type MontageEngine } from './engine'
import type { ScriptBlock } from './autocut'
import { jobPct, runningLabel, speechFiles, watchJobs } from './transcripts'
import { applyFixes, inPrompt } from './transcriptEdits'
import { planRender, type VLayer } from '../render/plan'
import { issuesTweak, layoutProbe, safeZoneDirection, safeZones, type LayoutIssue } from './safezone'

/**
 * Blocos de instrução: pedaços de tempo na faixa de vídeo com instruções de motion.
 * Aqui fica o modelo (criar, mexer), a prévia (ouvir o trecho, pedir o HTML à IA, virar MP4),
 * o clipe final (a prévia aprovada gravada na resolução do projeto, que entra na timeline)
 * e o texto que vai pra memória de motion.
 */

export const BLOCK_MIN = 0.5
export const PREVIEW_FPS = 12

export const blockDur = (b: InstructionBlock) => b.end - b.start
export const blockLabel = (b: InstructionBlock) => b.name?.trim() || `Bloco ${formatTime(b.start)}`

export function newBlock(track: string, start: number, end: number): InstructionBlock {
  return { id: 'b' + uid(), track, start: Math.max(0, start), end: Math.max(start + BLOCK_MIN, end), text: '', attachments: [], dynamic: false }
}

/** impressão digital: se mudar, a prévia que existe ficou velha */
export function blockKey(b: InstructionBlock) {
  const chain = b.fromPrev || b.toNext ? [[!!b.fromPrev, !!b.toNext]] : []
  const style = b.formatId ? [['estilo', b.formatId]] : []
  const raw = b.useRaw ? [['bruto']] : []
  const neg = b.negative?.trim() ? [['evitar', b.negative.trim()]] : []
  const s = JSON.stringify([b.start.toFixed(2), b.end.toFixed(2), b.text.trim(), !!b.dynamic, b.attachments.map((a) => [a.path, a.use, a.note ?? '']), blockSync(b), ...chain, ...style, ...raw, ...neg])
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** sincronia do motion com a fala (0–1); blocos antigos ficam no meio-termo de antes */
export const SYNC_DEFAULT = 0.3
export const blockSync = (b: InstructionBlock) => Math.max(0, Math.min(1, b.sync ?? SYNC_DEFAULT))

/** como o motion acompanha a fala, conforme o slider */
export function syncDirection(v: number) {
  const pct = Math.round(v * 100)
  if (v <= 0.05)
    return `- Sincronia com a fala: ${pct}% (NENHUMA). Ignore o tempo da fala: ela só dá o tema. O motion tem ritmo próprio, contínuo, sem nenhum evento marcado em palavra ou frase.`
  if (v < 0.4)
    return `- Sincronia com a fala: ${pct}% (pouca). NÃO sincronize cada frase. A fala dá o tema e só 1 a 3 momentos-chave (um número, um nome, uma virada) casam com o áudio, no tempo exato. O resto respira com movimento contínuo.`
  if (v < 0.75)
    return `- Sincronia com a fala: ${pct}% (meio-termo). Cada ideia nova da fala ganha uma mudança visual no tempo em que é dita (troca de composição, entrada de elemento), e os números, nomes e viradas caem no tempo exato. Entre essas marcas, movimento contínuo; não precisa seguir palavra por palavra.`
  if (v < 0.95)
    return `- Sincronia com a fala: ${pct}% (bastante). Quase toda frase tem um acontecimento visual no tempo em que é dita: elementos entram, mudam e saem acompanhando a narração, e as palavras-chave aparecem na tela no instante em que são faladas.`
  return `- Sincronia com a fala: ${pct}% (TOTAL). Siga a narração frase a frase e palavra-chave por palavra-chave, usando os tempos da transcrição: cada fala tem seu evento visual exatamente no tempo dela (entra quando começa, troca quando a próxima começa). Texto na tela continua curto (palavras-chave), não a frase inteira.`
}

export const previewStale = (b: InstructionBlock) => !!b.preview && b.preview.key !== blockKey(b)

export const isImage = (a: Attachment) => (a.kind ?? 'image') === 'image' || /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.path)

// ---------- o que se fala no trecho ----------
export interface HeardWord {
  /** segundos desde o começo do bloco */
  t: number
  w: string
}

/** narração que toca dentro do bloco: os cortes de áudio (faixas ligadas) que encostam no intervalo */
export function audioIn(data: MontageData, b: InstructionBlock) {
  const muted = new Set(data.tracks.filter((t) => t.muted || t.kind !== 'audio').map((t) => t.id))
  const media = new Map(data.media.map((m) => [m.id, m]))
  return data.clips.filter((c) => !muted.has(c.track) && media.get(c.media)?.hasAudio && c.start < b.end && clipEndT(c) > b.start)
}

/** cortes que o bloco ouve: os de `audioIn` menos os das faixas desarmadas pra escuta */
export function heardClips(data: MontageData, b: InstructionBlock) {
  const deaf = new Set(data.tracks.filter((t) => t.deaf).map((t) => t.id))
  return audioIn(data, b).filter((c) => !deaf.has(c.track))
}

/** pedaços de cada arquivo (tempos do arquivo) que tocam dentro do bloco: o que a transcrição do bloco mostra */
export function blockWindows(data: MontageData, b: InstructionBlock): Map<string, [number, number][]> {
  const media = new Map(data.media.map((m) => [m.id, m]))
  const speech = new Set(blockSpeech(data, b))
  const out = new Map<string, [number, number][]>()
  for (const c of heardClips(data, b)) {
    const path = media.get(c.media)!.path
    if (!speech.has(path)) continue
    const a = c.in + Math.max(0, b.start - c.start)
    const z = c.in + Math.min(clipEndT(c), b.end) - c.start
    if (z > a) out.set(path, [...(out.get(path) ?? []), [a, z] as [number, number]].sort((x, y) => x[0] - y[0]))
  }
  return out
}

/** prompt do autor preso a palavras faladas dentro do bloco (tempos a partir do começo do bloco) */
export interface HeardPrompt {
  t0: number
  t1: number
  /** as palavras do trecho (já corrigidas) */
  words: string
  text: string
}

/** arquivos com fala que tocam no bloco (o que precisa estar lido pra prévia sair sem esperar o Whisper) */
export function blockSpeech(data: MontageData, b: InstructionBlock) {
  const speech = new Set(speechFiles(data).map((f) => f.path))
  const media = new Map(data.media.map((m) => [m.id, m]))
  return [...new Set(heardClips(data, b).map((c) => media.get(c.media)!.path))].filter((p) => speech.has(p))
}

/**
 * Transcreve (Whisper, na fila com cache por arquivo) e devolve só as palavras que caem dentro do bloco,
 * já com as correções do autor, e os prompts que ele prendeu nas falas do trecho.
 * `onWait` conta como vai a leitura; `signal` para de esperar (a leitura continua na fila e fica guardada).
 */
export async function heardIn(
  data: MontageData,
  b: InstructionBlock,
  lang: string,
  opts: { signal?: AbortSignal; onWait?: (label: string, pct: number | null) => void } = {}
): Promise<{ words: HeardWord[]; prompts: HeardPrompt[]; error?: string }> {
  const clips = heardClips(data, b)
  const media = new Map(data.media.map((m) => [m.id, m]))
  const words: HeardWord[] = []
  const prompts = new Map<string, HeardPrompt>()
  let error: string | undefined
  const paths = blockSpeech(data, b)
  for (const [i, path] of paths.entries()) {
    const of = paths.length > 1 ? ` (${i + 1}/${paths.length})` : ''
    const tell = () => {
      const pct = jobPct(path, lang)
      const j = runningLabel(path, lang)
      opts.onWait?.(`Ouvindo o trecho (Whisper)${of}${j ? ': ' + j : '…'}`, pct)
    }
    const stop = watchJobs(tell)
    tell()
    let r: Awaited<ReturnType<typeof api.transcribe>>
    try {
      r = await new Promise((res, rej) => {
        if (opts.signal?.aborted) return rej(new Error('Cancelado.'))
        opts.signal?.addEventListener('abort', () => rej(new Error('Cancelado.')), { once: true })
        api.transcribe(path, lang).then(res, rej)
      })
    } finally {
      stop()
    }
    if ('error' in r) {
      error = r.error
      continue
    }
    const edit = data.transcriptEdits?.[path]
    const fixed = applyFixes(r.words, edit)
    for (const c of clips.filter((x) => media.get(x.media)!.path === path)) {
      const here = fixed.filter((w) => {
        if (w.s < c.in || w.s >= c.out) return false
        const t = c.start + (w.s - c.in)
        return t >= b.start && t < b.end
      })
      const rel = (s: number) => c.start + (s - c.in) - b.start
      for (const w of here) words.push({ t: rel(w.s), w: w.w })
      for (const p of edit?.prompts ?? []) {
        const ws = here.filter((w) => inPrompt(w, p))
        if (!ws.length || !p.text.trim()) continue
        const t0 = rel(ws[0].s)
        const t1 = Math.min(blockDur(b), rel(ws[ws.length - 1].e))
        const prev = prompts.get(p.id)
        // o mesmo trecho em dois cortes do bloco: fica a primeira vez que ele toca
        if (!prev || t0 < prev.t0) prompts.set(p.id, { t0, t1, words: ws.map((w) => w.w).join(' '), text: p.text.trim() })
      }
    }
  }
  return { words: words.sort((a, z) => a.t - z.t), prompts: [...prompts.values()].sort((a, z) => a.t0 - z.t0), error }
}

/** "[0.0s] frase… [3.2s] frase…": quebra nas pausas (ou a cada ~12 palavras) */
export function phrases(words: HeardWord[]) {
  const out: string[] = []
  let cur: HeardWord[] = []
  const flush = () => {
    if (cur.length) out.push(`[${cur[0].t.toFixed(1)}s] ${cur.map((w) => w.w).join(' ')}`)
    cur = []
  }
  words.forEach((w, i) => {
    const prev = words[i - 1]
    if (prev && (w.t - prev.t > 0.7 || cur.length >= 12)) flush()
    cur.push(w)
  })
  flush()
  return out.join('\n')
}

/** falas do roteiro ligadas aos cortes que tocam no bloco (pelo corte automático) */
function scriptIn(data: MontageData, b: InstructionBlock, script: ScriptBlock[]) {
  const idx = new Set(audioIn(data, b).map((c) => c.block).filter((i): i is number => i !== undefined))
  return script.filter((s) => idx.has(s.index) && s.text.trim()).map((s) => s.text.trim())
}

/** as falas do roteiro (sem prompts nem instruções), com os capítulos como "# título": é o tema e a estrutura do vídeo */
export const scriptFalas = (script: ScriptBlock[]) =>
  script
    .filter((s) => (s.type === 'paragraph' || s.type === 'chapter') && s.text.trim())
    .map((s) => (s.type === 'chapter' ? '# ' + s.text.trim() : s.text.trim()))
    .join('\n')

/** em que capítulo o bloco está e os letterings capitulares que passam por ele (tempos a partir do começo do bloco) */
export interface ChapterInfo {
  title: string
  letterings: { label: string; t0: number; t1: number }[]
}

/**
 * Capítulo do bloco: o último capítulo do roteiro antes das falas que tocam nele (pelo corte automático);
 * sem falas ligadas, o último lettering que começa antes do fim do bloco.
 */
export function chapterAt(data: MontageData, b: InstructionBlock, script: ScriptBlock[]): ChapterInfo | null {
  const markers = (data.markers ?? []).filter((m) => m.kind === 'lettering')
  const letterings = markers
    .filter((m) => m.dur > 0 && m.t < b.end && m.t + m.dur > b.start)
    .map((m) => ({ label: m.label, t0: Math.max(0, m.t - b.start), t1: Math.min(blockDur(b), m.t + m.dur - b.start) }))
  const idx = audioIn(data, b)
    .map((c) => c.block)
    .filter((i): i is number => i !== undefined)
  let title = ''
  if (idx.length) {
    const first = Math.min(...idx)
    title = script.filter((s) => s.type === 'chapter' && s.index < first && s.text.trim()).pop()?.text.trim() ?? ''
  }
  if (!title) title = markers.filter((m) => m.t < b.end).pop()?.label.trim() ?? ''
  return title || letterings.length ? { title, letterings } : null
}

// ---------- o vídeo que está embaixo do bloco ----------
/** a timeline só com as faixas de vídeo do bloco pra baixo (a primeira faixa da lista é a de cima); `all` = todas */
function belowMontage(data: MontageData, b: InstructionBlock, all = false): MontageData {
  const vids = data.tracks.filter((t) => t.kind === 'video')
  const at = all ? 0 : vids.findIndex((t) => t.id === b.track)
  const keep = new Set(vids.slice(Math.max(0, at)).map((t) => t.id))
  const tracks = data.tracks.filter((t) => t.kind === 'video' && keep.has(t.id))
  const ids = new Set(tracks.map((t) => t.id))
  return { ...data, tracks, clips: data.clips.filter((c) => ids.has(c.track)), markers: [], blocks: [] }
}

/** o que aparece nas faixas de vídeo embaixo do bloco (de baixo pra cima, como no render), e de que arquivos vem */
export function videoUnder(data: MontageData, b: InstructionBlock) {
  const below = belowMontage(data, b)
  const plan = planRender(below, { from: b.start, to: b.end, width: 2, height: 2, fps: 30 })
  const seen = new Set<string>()
  const layers: VLayer[] = []
  for (const p of plan.parts)
    for (const v of p.video) {
      const k = JSON.stringify(v)
      if (!seen.has(k) && v.t0 < b.end && v.t1 > b.start) (seen.add(k), layers.push(v))
    }
  // de que arquivos vem (pra contar pro Claude), em ordem de tempo
  const names = new Map(data.media.map((m) => [m.path, m.name]))
  const parts = [...layers]
    .sort((x, y) => x.t0 - y.t0)
    .map((v) => ({ name: names.get(v.path) ?? v.path.split(/[\\/]/).pop() ?? v.path, image: v.image, t0: Math.max(0, v.t0 - b.start), t1: Math.min(blockDur(b), v.t1 - b.start) }))
  return { layers, parts }
}

export interface UnderInfo {
  /** MP4 sem som do tamanho do bloco (0 s = começo do bloco) */
  video: string
  parts: { name: string; image: boolean; t0: number; t1: number }[]
  /** quadros dele que vão como imagem pro Claude */
  frames: { t: number; path: string }[]
}

/** recorta o vídeo de baixo no tamanho pedido e tira uns quadros pra mostrar ao Claude */
export async function underFor(data: MontageData, b: InstructionBlock, dir: string, size: { w: number; h: number }, withFrames: boolean): Promise<UnderInfo | null> {
  const u = videoUnder(data, b)
  if (!u.layers.length) return null
  const r = await api.motionUnderVideo({ dir, block: b.id, from: b.start, to: b.end, width: size.w, height: size.h, video: u.layers })
  if ('error' in r) throw new Error(r.error)
  const frames: { t: number; path: string }[] = []
  if (withFrames) {
    const d = blockDur(b)
    const n = Math.max(3, Math.min(10, Math.round(d)))
    const times = Array.from({ length: n }, (_, i) => +((d * (i + 0.5)) / n).toFixed(2))
    const got = await api.motionFramesAt(r.video, times)
    got.forEach((p, i) => p && frames.push({ t: times[i], path: p }))
  }
  return { video: r.video, parts: u.parts, frames }
}

export const UNDER_NAME = 'embaixo.mp4'

// ---------- continuidade: o que toca logo antes e logo depois do bloco ----------
/** até quanto de vão (s) um bloco ainda conta como encostado no outro */
export const TOUCH = 0.12
export const PREV_NAME = 'antes.jpg'
export const NEXT_NAME = 'depois.jpg'

export type Side = 'prev' | 'next'
export type Neighbor =
  | { kind: 'block'; block: InstructionBlock; label: string }
  /** o que a timeline mostra nesse instante (cortes de vídeo, inserts, motion já aprovado) */
  | { kind: 'video'; label: string; t: number; html?: string; htmlT?: number }

/**
 * Vizinho do bloco: um bloco encostado (de preferência na mesma faixa) ou, sem bloco, o que as
 * faixas de vídeo mostram no instante da emenda. null = não tem nada (começo ou fim do vídeo).
 */
export function neighborOf(data: MontageData, b: InstructionBlock, side: Side): Neighbor | null {
  const t = side === 'prev' ? b.start : b.end
  const touching = (data.blocks ?? []).filter((x) => x.id !== b.id && Math.abs((side === 'prev' ? x.end : x.start) - t) <= TOUCH)
  const blk = touching.find((x) => x.track === b.track) ?? touching[0]
  if (blk) return { kind: 'block', block: blk, label: blockLabel(blk) }
  if (side === 'prev' && t <= 0.001) return null
  // o instante que aparece na tela: o último quadro antes do bloco, ou o primeiro depois
  const at = side === 'prev' ? Math.max(0, t - 1 / CLIP_FPS) : t + 0.001
  const media = new Map(data.media.map((m) => [m.id, m]))
  for (const tr of data.tracks.filter((x) => x.kind === 'video' && !x.muted)) {
    const c = data.clips.find((x) => x.track === tr.id && x.start <= at && clipEndT(x) > at && media.get(x.media)?.kind !== 'audio')
    if (!c) continue
    const m = media.get(c.media)!
    return { kind: 'video', label: m.name, t, html: m.motionHtml, htmlT: m.motionHtml ? Math.max(0, c.in + (t - c.start)) : undefined }
  }
  return null
}

export const neighborText = (n: Neighbor | null) =>
  !n ? 'nada' : n.kind === 'block' ? `${n.label}${n.block.preview ? '' : ' (sem prévia ainda)'}` : `${n.label}${n.html ? ' (motion)' : ''}`

export interface EdgeInfo {
  side: Side
  label: string
  /** quadro da emenda (jpg), no tamanho pedido */
  frame: string
  /** HTML da animação vizinha e o instante dela que encosta neste bloco */
  html?: string
  htmlT?: number
}

/** quadro (e, se for motion, o HTML) do que encosta no bloco do lado pedido */
export async function edgeFor(data: MontageData, b: InstructionBlock, side: Side, dir: string, size: { w: number; h: number }): Promise<EdgeInfo | null> {
  const n = neighborOf(data, b, side)
  if (!n) return null
  const readHtml = (p?: string) =>
    p
      ? fetch(fileUrl(p))
          .then((r) => (r.ok ? r.text() : ''))
          .catch(() => '')
      : Promise.resolve('')
  if (n.kind === 'block') {
    const p = n.block.preview
    if (!p)
      throw new Error(
        `${n.label} ainda não tem prévia. Gere a prévia dele antes: é ${side === 'prev' ? 'do último quadro dela que este bloco continua' : 'no primeiro quadro dela que este bloco termina'}.`
      )
    const d = blockDur(n.block)
    const [frame] = await api.motionFramesAt(p.video, [side === 'prev' ? Math.max(0, d - 0.1) : 0], size.w)
    if (!frame) throw new Error(`Não deu pra tirar o quadro da prévia de ${n.label}.`)
    const html = await readHtml(p.html)
    return { side, label: n.label, frame, html: html || undefined, htmlT: side === 'prev' ? d : 0 }
  }
  // o que a timeline mostra na emenda: recorta um pedacinho (todas as faixas de vídeo) e tira o quadro
  const from = side === 'prev' ? Math.max(0, n.t - 0.2) : n.t
  const to = side === 'prev' ? n.t : n.t + 0.2
  const all = belowMontage(data, b, true)
  const plan = planRender(all, { from, to, width: 2, height: 2, fps: 30 })
  const layers = plan.parts.flatMap((p) => p.video).filter((v) => v.t0 < to && v.t1 > from)
  if (!layers.length) return null
  const r = await api.motionUnderVideo({ dir, block: b.id, from, to, width: size.w, height: size.h, video: layers })
  if ('error' in r) throw new Error(r.error)
  const [frame] = await api.motionFramesAt(r.video, [side === 'prev' ? Math.max(0, to - from - 0.05) : 0], size.w)
  if (!frame) throw new Error(`Não deu pra tirar o quadro ${side === 'prev' ? 'de antes' : 'de depois'} do bloco.`)
  const html = await readHtml(n.html)
  return { side, label: n.label, frame, html: html || undefined, htmlT: n.htmlT }
}

/** as emendas que o bloco pediu (continuar do anterior / chegar no próximo) */
export async function edgesFor(data: MontageData, b: InstructionBlock, dir: string, size: { w: number; h: number }) {
  const out: EdgeInfo[] = []
  for (const side of ['prev', 'next'] as const) {
    if (!(side === 'prev' ? b.fromPrev : b.toNext)) continue
    const e = await edgeFor(data, b, side, dir, size)
    if (e) out.push(e)
  }
  return out
}

const edgeName = (e: EdgeInfo) => (e.side === 'prev' ? PREV_NAME : NEXT_NAME)
export const edgeFiles = (edges: EdgeInfo[]) => edges.map((e) => ({ src: e.frame, name: edgeName(e) }))

/** HTML do vizinho enxuto pro prompt: sem imagens/fontes embutidas (data:) e com limite de tamanho */
export function slimHtml(html: string, max = 12000) {
  const s = html.replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]{100,}/g, 'data:…').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  return s.length > max ? s.slice(0, max) + '\n<!-- … cortado -->' : s
}

/** a parte do prompt que pede a emenda sem corte (as imagens chegam a partir de `first`) */
function continuityPrompt(edges: EdgeInfo[], first: number) {
  if (!edges.length) return []
  const L = ['## Continuidade (sem corte seco)']
  edges.forEach((e, i) => {
    const img = `a imagem ${first + i} (também está na pasta do HTML como ${edgeName(e)})`
    if (e.side === 'prev') {
      L.push(
        `- COMEÇO: este bloco continua o que toca logo antes dele ("${e.label}"). O quadro 0 desta animação tem que ser IGUAL ao último quadro de antes: ${img}. Quem assiste não pode perceber emenda.`,
        e.html
          ? `  Esse trecho de antes é uma animação; o HTML dela está abaixo. Recrie em t = 0 o estado em que ela está em ${(e.htmlT ?? 0).toFixed(2)} s (mesmos elementos, posições, tamanhos, cores, fundo e fontes) e transforme a partir daí: os elementos de antes saem, mudam ou viram parte da cena nova, com movimento.`
          : `  Esse trecho de antes é vídeo ou imagem. Comece mostrando <img src="${PREV_NAME}"> cobrindo a tela inteira (object-fit: cover) e saia dele com movimento (câmera entrando, zoom, o quadro encolhendo pra uma moldura, deslize, elementos novos tomando a tela).`
      )
    } else {
      L.push(
        `- FIM: este bloco desemboca no que toca logo depois dele ("${e.label}"). O último quadro desta animação tem que ser IGUAL ao primeiro quadro de depois: ${img}.`,
        e.html
          ? `  Esse trecho de depois é uma animação; o HTML dela está abaixo. Termine chegando exatamente ao estado em que ela está em ${(e.htmlT ?? 0).toFixed(2)} s (mesmos elementos, posições, tamanhos, cores, fundo e fontes) e segure esse quadro no fim.`
          : `  Esse trecho de depois é vídeo ou imagem. Nos últimos ~0,5 s leve a composição até <img src="${NEXT_NAME}"> cobrindo a tela inteira (object-fit: cover), exatamente como ele é (ex.: a cena vira uma moldura que cresce até a tela cheia, ou a câmera recua até ele), e segure até o fim.`
      )
    }
    if (e.html) L.push('```html', slimHtml(e.html), '```')
  })
  L.push('- A emenda é feita DENTRO deste bloco: nada de corte, flash, fade pro preto ou tela vazia nas pontas. Use a duração toda com movimento contínuo.', '')
  return L
}

// ---------- áudio do trecho (mixado como a Montagem toca) ----------
export async function rangeWav(engine: MontageEngine, data: MontageData, dur: (id: string) => number, t0: number, t1: number): Promise<Uint8Array | undefined> {
  const rate = 44100
  const len = Math.ceil((t1 - t0) * rate)
  if (len <= 0) return
  const ctx = new OfflineAudioContext(1, len, rate)
  let any = false
  for (const s of spans(data, dur)) {
    if (s.t1 <= t0 || s.t0 >= t1 || s.clip.audioOff) continue
    const loaded = engine.get(s.clip.media)
    if (!loaded) continue
    const rel0 = Math.max(0, t0 - s.t0)
    const when = Math.max(0, s.t0 - t0)
    const from = s.src0 + rel0
    const playLen = Math.min(s.t1 - s.t0 - rel0, t1 - t0 - when)
    if (playLen <= 0 || from >= loaded.buffer.duration) continue
    const src = ctx.createBufferSource()
    src.buffer = loaded.buffer
    const g = ctx.createGain()
    const d = s.t1 - s.t0
    // mesmo envelope da Montagem (crossfades e curvas dos fades)
    g.gain.setValueAtTime(s.gain * envAt(s, rel0), when)
    for (const p of envPoints(s)) if (p > rel0 && p <= d) g.gain.linearRampToValueAtTime(s.gain * envAt(s, p), when + (p - rel0))
    src.connect(g).connect(ctx.destination)
    src.start(when, Math.max(0, from), playLen)
    any = true
  }
  if (!any) return
  const buf = await ctx.startRendering()
  return wav16(buf.getChannelData(0), rate)
}

function wav16(ch: Float32Array, rate: number) {
  const out = new DataView(new ArrayBuffer(44 + ch.length * 2))
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  out.setUint32(4, 36 + ch.length * 2, true)
  str(8, 'WAVEfmt ')
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true)
  out.setUint16(22, 1, true)
  out.setUint32(24, rate, true)
  out.setUint32(28, rate * 2, true)
  out.setUint16(32, 2, true)
  out.setUint16(34, 16, true)
  str(36, 'data')
  out.setUint32(40, ch.length * 2, true)
  for (let i = 0; i < ch.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, ch[i])) * 0x7fff, true)
  return new Uint8Array(out.buffer)
}

// ---------- direção de motion (vale pras prévias) ----------
export const MOTION_DIRECTION = [
  '- Pense como motion designer, não como apresentador de slides: nada de lista de tópicos surgindo um embaixo do outro, nada de "cartão com título + bullets".',
  '- Antes de animar, imagine de 3 a 7 ideias de apresentação bem diferentes pro trecho (gráfico que se monta, objeto isométrico, mapa, linha do tempo, comparação lado a lado, tipografia gigante em close, colagem, interface recriada, câmera viajando por um cenário, contador, metáfora visual…) e escolha a mais forte. Em trechos longos, encadeie 2 ou 3 composições diferentes.',
  '- Varie a composição de cena de um momento pro outro: escala (close × aberto), centro × terços, camadas com profundidade, movimento de câmera, ritmo.',
  '- Texto na tela é curto (palavra-chave, número, título), nunca a frase falada inteira.',
  '- Siga o guia de estilo e a memória de motion (o que o autor já aprovou).'
].join('\n')

const ATTACH_RULES = {
  insert: 'INSERT: a imagem ENTRA no vídeo. Mostre ela de verdade e anime por cima (setas, círculos, zoom em detalhes, destaques, recortes) seguindo as instruções.',
  ref: 'REFERÊNCIA: a imagem NÃO aparece no vídeo. Recrie em HTML/CSS, com design bonito e no estilo do formato (um clone estilizado, ex.: a página do SteamDB redesenhada), e anime essa recriação.'
}

// ---------- assets do estilo (as pastas fixas do formato: pngtuber, logo, molduras…) ----------
export interface StyleAsset {
  path: string
  /** pasta/caminho dentro dela (o que o Claude lê pra escolher) */
  rel: string
  kind: 'image' | 'video'
  /** nome do arquivo na pasta da prévia */
  name: string
}
const MAX_STYLE_ASSETS = 60
/** quantos assets vão também como imagem pro Claude olhar */
export const MAX_STYLE_IMAGES = 12

/** imagens e vídeos das pastas visuais do estilo (o áudio fica de fora; sons vêm das pastas de SFX e Música com o Material bruto) */
export async function styleAssets(format?: Format): Promise<StyleAsset[]> {
  const out: StyleAsset[] = []
  for (const dir of styleFoldersOf(format)
    .filter((x) => x.role === 'visual')
    .map((x) => x.path)) {
    const list = await api.scanFolder(dir).catch(() => ({ error: '' }))
    if ('error' in list) continue
    const folder = dir.split(/[\\/]/).filter(Boolean).pop() ?? 'pasta'
    for (const f of list) {
      if (f.kind === 'audio') continue
      if (out.length >= MAX_STYLE_ASSETS) return out
      const ext = f.name.match(/\.\w+$/)?.[0]?.toLowerCase() ?? ''
      const base = f.rel.replace(/\.\w+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 40)
      out.push({ path: f.path, rel: `${folder}/${f.rel.replace(/\\/g, '/')}`, kind: f.kind, name: `estilo-${out.length + 1}-${base}${ext}` })
    }
  }
  return out
}

/** os assets do estilo que a animação usa (vão pra pasta da prévia/clipe com o nome que ela pede) */
export const assetFiles = (assets: { path: string; name: string }[], html: string) => assets.filter((a) => html.includes(a.name)).map((a) => ({ src: a.path, name: a.name }))

// ---------- material bruto do projeto (checkbox "Usar o Material bruto" do bloco) ----------
export interface RawFile {
  path: string
  /** categoria/pasta/arquivo na Montagem (o que o Claude lê pra escolher) */
  rel: string
  kind: MediaKind
  /** nome do arquivo na pasta da prévia */
  name: string
  duration?: number
  /** pasta da Montagem de onde vem (os das pastas do estilo: a categoria da Montagem que combina) */
  bin: string
  /** veio de uma pasta do estilo (não do projeto) */
  style?: StyleFolderRole
  /** análise do som (impacto, volume, energia), quando deu pra ler */
  profile?: SoundProfile
  /** veio de uma pasta ⭐: o Claude prefere antes dos outros */
  star?: boolean
}
const MAX_RAW = 120
/** das pastas do estilo (contam à parte, pra o bruto do projeto não tomar o lugar delas) */
const MAX_STYLE_RAW = 60
/** de uma pasta vinculada do PC (bibliotecas de som podem ter milhares de arquivos) */
const MAX_RAW_PER_LINK = 40
/** quantas imagens do bruto vão também como imagem pro Claude olhar */
export const MAX_RAW_IMAGES = 8

/** o que entra de cada categoria: SFX e Música só som; Material bruto tudo */
const roleWants = (role: string | undefined, kind: MediaKind) => role === 'raw' || ((role === 'sfx' || role === 'music') && kind === 'audio')

/**
 * O Material bruto do projeto (imagens, vídeos e sons, inclusive das pastas vinculadas do PC) e os sons da pasta SFX.
 * Primeiro o que já foi importado na Montagem; depois as pastas vinculadas, as ⭐ antes. Por último as pastas
 * do estilo (Material bruto, SFX e Música), que valem pra todo roteiro com esse estilo.
 */
export async function rawFiles(data: MontageData, format?: Format): Promise<RawFile[]> {
  const bins = new Map(data.bins.map((x) => [x.id, x]))
  const chain = (id: string) => {
    const out: MontageData['bins'] = []
    for (let cur = bins.get(id); cur && out.length < 20; cur = cur.parent ? bins.get(cur.parent) : undefined) out.unshift(cur)
    return out
  }
  const roleOf = (id: string) => chain(id)[0]?.role
  const out: RawFile[] = []
  const seen = new Set<string>()
  const add = (f: Omit<RawFile, 'name'>, fromStyle = false) => {
    if (seen.has(f.path) || (!fromStyle && out.length >= MAX_RAW)) return
    seen.add(f.path)
    const ext = f.path.match(/\.\w+$/)?.[0]?.toLowerCase() ?? ''
    const base = (f.path.split(/[\\/]/).pop() ?? 'arquivo').replace(/\.\w+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 40)
    out.push({ ...f, name: `bruto-${out.length + 1}-${base}${ext}` })
  }
  const wanted = (bin: string, kind: MediaKind) => roleWants(roleOf(bin), kind)
  for (const m of data.media) {
    if (m.motionHtml || m.motionBlock || !wanted(m.bin, m.kind)) continue
    add({ path: m.path, rel: [...chain(m.bin).map((x) => x.name), m.name].join('/'), kind: m.kind, duration: m.duration, bin: m.bin })
  }
  const links = data.bins.filter((x) => x.linked && (roleOf(x.id) === 'raw' || roleOf(x.id) === 'sfx')).sort((a, z) => Number(!!z.star) - Number(!!a.star))
  for (const x of links) {
    if (out.length >= MAX_RAW) break
    const list = await api.scanFolder(x.linked!).catch(() => ({ error: '' }))
    if ('error' in list) continue
    const where = chain(x.id).map((y) => y.name)
    for (const f of list.filter((f) => wanted(x.id, f.kind)).slice(0, MAX_RAW_PER_LINK)) add({ path: f.path, rel: [...where, f.rel.replace(/\\/g, '/')].join('/'), kind: f.kind, bin: x.id, star: !!chain(x.id).some((y) => y.star) || undefined })
  }
  const project = out.length
  const folders = styleFoldersOf(format)
    .filter((x) => x.role !== 'visual')
    .sort((a, z) => Number(!!z.star) - Number(!!a.star))
  for (const x of folders) {
    if (out.length - project >= MAX_STYLE_RAW) break
    const list = await api.scanFolder(x.path).catch(() => ({ error: '' }))
    if ('error' in list) continue
    // ao aprovar, o som vira mídia na categoria da Montagem que combina (SFX ou Material bruto)
    const bin = data.bins.find((y) => !y.parent && y.role === (x.role === 'sfx' ? 'sfx' : 'raw'))?.id ?? ''
    const folder = x.path.split(/[\\/]/).filter(Boolean).pop() ?? 'pasta'
    const room = MAX_STYLE_RAW - (out.length - project)
    for (const f of list.filter((f) => roleWants(x.role, f.kind)).slice(0, Math.min(MAX_RAW_PER_LINK, room)))
      add({ path: f.path, rel: ['Estilo', roleLabel(x.role), folder, f.rel.replace(/\\/g, '/')].join('/'), kind: f.kind, bin, style: x.role, star: x.star || undefined }, true)
  }
  return out
}

/** lê o perfil dos sons da lista (impacto, volume, energia); o que não der fica sem */
export async function withProfiles(list: RawFile[]): Promise<RawFile[]> {
  const audio = list.filter((f) => f.kind === 'audio')
  if (!audio.length || !api.soundProfiles) return list
  const got = await api.soundProfiles(audio.map((f) => f.path)).catch(() => [])
  const by = new Map(audio.map((f, i) => [f.path, got[i] ?? undefined]))
  return list.map((f) => (by.get(f.path) ? { ...f, profile: by.get(f.path) } : f))
}

/** os sons que o Claude pediu na tag <sons> (só arquivos da lista, dentro do bloco) */
export function parseSounds(text: string, raw: RawFile[], dur: number): BlockSound[] | null {
  const body = text.match(/<sons>([\s\S]*?)<\/sons>/i)?.[1]
  if (body === undefined) return null
  let list: unknown
  try {
    list = JSON.parse(body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim() || '[]')
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const byName = new Map(raw.filter((f) => f.kind === 'audio' || f.kind === 'video').map((f) => [f.name, f]))
  const out: BlockSound[] = []
  for (const it of list as Record<string, unknown>[]) {
    const f = byName.get(String(it?.arquivo ?? ''))
    const at = Number(it?.em)
    if (!f || !Number.isFinite(at) || at < 0 || at >= dur) continue
    const v = Number(it?.volume)
    out.push({ path: f.path, name: f.name, at, vol: Number.isFinite(v) ? Math.max(0.05, Math.min(1, v)) : 0.8, duration: f.duration, bin: f.bin })
  }
  return out
}

/** faixas de áudio onde os sons dos motions aprovados entram */
export const SOUND_TRACK = 'Sons do motion'

/**
 * Ao aprovar: os sons do bloco viram cortes de áudio na timeline, nas faixas "Sons do motion" (cria quantas
 * precisar pra um som não ficar por cima do outro). O arquivo que ainda não é mídia da Montagem vira, na pasta de onde veio.
 */
export function soundsToTimeline(d: MontageData, b: InstructionBlock, sounds: BlockSound[]): Pick<MontageData, 'media' | 'tracks' | 'clips'> {
  let { media, tracks, clips } = d
  for (const s of [...sounds].sort((x, z) => x.at - z.at)) {
    let m = media.find((x) => x.path === s.path && !x.motionHtml)
    const len = Math.min(s.duration ?? m?.duration ?? 0, blockDur(b) - s.at)
    if (len <= 0.01) continue
    if (!m) {
      const video = /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(s.path)
      m = { id: uid(), bin: s.bin ?? '', path: s.path, name: s.path.split(/[\\/]/).pop() ?? s.name, kind: video ? 'video' : 'audio', duration: s.duration ?? len, hasAudio: true, hasVideo: video }
      media = [...media, m]
    }
    const start = b.start + s.at
    const free = (tid: string) => !clips.some((c) => c.track === tid && c.start < start + len - 0.001 && clipEndT(c) > start + 0.001)
    let track = tracks.find((t) => t.kind === 'audio' && t.name.startsWith(SOUND_TRACK) && free(t.id))
    if (!track) {
      const n = tracks.filter((t) => t.kind === 'audio' && t.name.startsWith(SOUND_TRACK)).length
      track = { id: 'A-sons-' + uid().slice(0, 6), kind: 'audio', name: n ? `${SOUND_TRACK} ${n + 1}` : SOUND_TRACK }
      tracks = [...tracks, track]
    }
    clips = [...clips, { id: uid(), track: track.id, media: m.id, start, in: 0, out: len, gainDb: Math.round(20 * Math.log10(s.vol) * 10) / 10 }]
  }
  return { media, tracks, clips }
}

/** id da mídia de um som do bloco no motor de áudio (a mesma pra o mesmo arquivo) */
const soundMediaId = (path: string) => 'som:' + path

/**
 * A timeline com os sons do bloco por cima (numa faixa de áudio a mais), pra mixar a prévia e o clipe.
 * Carrega os arquivos no motor de áudio; `sounds` volta com a duração de cada som (os que não carregaram ficam de fora).
 */
export async function withSounds(engine: MontageEngine, data: MontageData, dur: (id: string) => number, b: InstructionBlock, list: BlockSound[]) {
  const sounds: BlockSound[] = []
  if (!list.length) return { data, dur, sounds }
  const media: MontageData['media'] = []
  const clips: MontageData['clips'] = []
  const lens = new Map<string, number>()
  for (const [i, x] of list.entries()) {
    const m = { id: soundMediaId(x.path), bin: x.bin ?? '', path: x.path, name: x.name, kind: 'audio' as const, duration: x.duration ?? 0, hasAudio: true, hasVideo: false }
    const loaded = await engine.load(m).catch(() => null)
    if (!loaded) continue
    const s = { ...x, duration: loaded.buffer.duration }
    sounds.push(s)
    lens.set(m.id, s.duration)
    if (!media.some((y) => y.id === m.id)) media.push({ ...m, duration: s.duration })
    clips.push({ id: 'som-' + i, track: 'sons-do-bloco', media: m.id, start: b.start + s.at, in: 0, out: Math.min(s.duration, b.end - b.start - s.at), gainDb: 20 * Math.log10(s.vol) })
  }
  return {
    sounds,
    data: { ...data, tracks: [...data.tracks, { id: 'sons-do-bloco', kind: 'audio' as const, name: 'Sons do bloco' }], media: [...data.media, ...media], clips: [...data.clips, ...clips] },
    dur: (id: string) => lens.get(id) ?? dur(id)
  }
}

/** memória de motion em texto (mais novas primeiro, com limite de tamanho) */
export function memorySection(memory: MotionMemoryItem[] | undefined, max = 14000) {
  if (!memory?.length) return ''
  const out = ['## Memória de motion (o autor aprovou isto: siga essa linguagem, sem copiar)']
  let used = 0
  for (const m of [...memory].sort((a, b) => b.at.localeCompare(a.at))) {
    const html = m.html ? '\n```html\n' + m.html.slice(0, 5000) + '\n```' : ''
    const item = `### ${m.title} (${m.source}, ${m.at.slice(0, 10)})\n${m.text.trim()}${html}`
    if (used + item.length > max && used > 0) break
    out.push(item)
    used += item.length
  }
  return out.join('\n\n')
}

export function previewSize(format?: Format) {
  const [w, h] = (RESOLUTIONS[format?.aspect ?? '16:9'] ?? '1920×1080').split('×').map(Number)
  const k = 480 / Math.max(w, h)
  return { w: Math.round((w * k) / 2) * 2, h: Math.round((h * k) / 2) * 2 }
}

/** tamanho final do vídeo: o formato com o lado menor em 1080 (o mesmo do render em Full HD) */
export function projectSize(format?: Format) {
  const [w, h] = (RESOLUTIONS[format?.aspect ?? '16:9'] ?? '1920×1080').split('×').map(Number)
  const k = 1080 / Math.min(w, h)
  return { w: Math.round((w * k) / 2) * 2, h: Math.round((h * k) / 2) * 2 }
}

export const CLIP_FPS = 30
/** versão da gravação do clipe (sobe junto com ENCODE_V do main): clipes mais velhos podem ser regravados */
export const CLIP_ENC = 2

/** prompt negativo: o do estilo vale sempre e o do bloco soma em cima */
export function negativePrompt(style?: string, block?: string) {
  const s = style?.trim()
  const b = block?.trim()
  if (!s && !b) return []
  return [
    '## O que EVITAR (prompt negativo: nada disso pode aparecer no motion)',
    ...(s ? ['Do estilo:', s] : []),
    ...(b ? ['Deste bloco:', b] : []),
    ''
  ]
}

export function blockPrompt(o: {
  block: InstructionBlock
  format?: Format
  heard: HeardWord[]
  heardError?: string
  /** prompts do autor presos a falas do trecho (na transcrição) */
  heardPrompts?: HeardPrompt[]
  /** o áudio do trecho está só em faixas desarmadas pra escuta */
  deaf?: boolean
  hasAudio: boolean
  scriptHere: string[]
  falas: string
  /** capítulo do bloco e letterings capitulares que passam por ele */
  chapter?: ChapterInfo | null
  files: { a: BlockAttachment; name: string }[]
  size: { w: number; h: number }
  under?: UnderInfo | null
  /** emendas pedidas (continuar do anterior / chegar no próximo); as imagens vêm depois dos quadros de baixo */
  edges?: EdgeInfo[]
  /** ajuste em cima da prévia atual: o HTML dela e os pedidos (o último é o novo) */
  adjust?: { html: string; tweaks: { text: string; names: string[] }[] }
  /** assets das pastas do estilo; os `shown` primeiros chegam como imagem a partir da imagem `first` */
  assets?: { list: StyleAsset[]; first: number; shown: number }
  /** Material bruto do projeto (checkbox do bloco); as `shown` primeiras imagens chegam a partir da imagem `first` */
  raw?: { list: RawFile[]; first: number; shown: number; sounds?: BlockSound[] }
}) {
  const b = o.block
  const d = blockDur(b)
  const L: string[] = [
    'Você é o motion designer do canal. Tarefa: criar a PRÉVIA do motion de UM bloco da timeline do vídeo.',
    '',
    '## O bloco',
    `- Duração: ${d.toFixed(2)} s (de ${formatTime(b.start)} a ${formatTime(b.end)} do vídeo)`,
    b.dynamic
      ? '- Modo DINÂMICO: você decide o motion a partir do que é falado no trecho. O texto do autor abaixo (se houver) é só dica.'
      : '- Modo ESCRITO: siga as instruções do autor. O roteiro serve só pra entender o tema, não pra mudar o que ele pediu.',
    '',
    '## Instruções do autor',
    b.text.trim() || (b.dynamic ? '(nenhuma: deduza da fala)' : '(vazio: deduza da fala)'),
    ''
  ]
  L.push(...negativePrompt(o.format?.negative, b.negative))
  const ch = o.chapter
  if (ch) {
    L.push('## Capítulo')
    if (ch.title) L.push(`Este bloco está no capítulo "${ch.title}". Use pra entender do que esta parte do vídeo trata.`)
    for (const l of ch.letterings)
      L.push(
        `- De ${l.t0.toFixed(1)}s a ${l.t1.toFixed(1)}s (a partir do começo do bloco) o vídeo mostra o lettering capitular "${l.label}" (a transição de capítulo, feita à parte, por cima de tudo). Não repita esse título nem ponha texto que dispute com ele nesse intervalo: deixe o centro da tela livre ou faça o motion emendar com ele (entrando quando ele sai).`
      )
    L.push('')
  }
  if (o.files.length) {
    L.push('## Anexos (as imagens chegam pra você na mesma ordem: a 1ª imagem é o anexo 1, e assim por diante)')
    o.files.forEach(({ a, name }, i) => {
      L.push(`${i + 1}. ${name}: ${ATTACH_RULES[a.use]}${a.use === 'insert' ? ` No HTML use exatamente <img src="${name}">.` : ''}${a.note?.trim() ? ` Nota do autor: ${a.note.trim()}` : ''}`)
    })
    L.push('')
  }
  if (o.under) {
    const first = o.files.length + 1
    L.push(
      '## O vídeo que está embaixo deste bloco na timeline',
      ...o.under.parts.map((p) => `- de ${p.t0.toFixed(1)}s a ${p.t1.toFixed(1)}s: ${p.image ? 'imagem' : 'vídeo'} "${p.name}"`),
      `O arquivo ${UNDER_NAME}, na mesma pasta do HTML, é exatamente esse vídeo já recortado: o segundo 0 dele é o começo do bloco, e ele tem a mesma duração. O clipe do motion vai POR CIMA e cobre o que está embaixo, então, pra ele aparecer, ponha no HTML <video src="${UNDER_NAME}" muted playsinline></video>. O Typos sincroniza o tempo do vídeo com o do bloco sozinho: não use autoplay, loop nem mexa em currentTime, e não repita ou corte o vídeo (ele é o insert e tem que bater com o tempo da timeline).`,
      'Use esse vídeo pra encaixar o motion no momento certo: o que acontece nele (ex.: um lance da gameplay) dita quando os elementos entram. Se as instruções não disserem outra coisa, mantenha ele visível (tela cheia, ou enquadrado numa moldura, com destaques, setas, zoom ou textos por cima, no estilo do formato).',
      o.under.frames.length
        ? `As imagens ${first} a ${first + o.under.frames.length - 1} são quadros dele, nesta ordem: ${o.under.frames.map((f) => f.t.toFixed(1) + 's').join(', ')} (a partir do começo do bloco).`
        : '',
      ''
    )
  }
  L.push(...continuityPrompt(o.edges ?? [], o.files.length + (o.under?.frames.length ?? 0) + 1))
  L.push('## O que é falado neste trecho (tempos a partir do começo do bloco)')
  if (!o.hasAudio) L.push('(não há áudio neste trecho: o motion carrega o momento sozinho)')
  else if (o.heard.length) L.push(phrases(o.heard))
  else if (o.deaf) L.push('(o autor desligou a escuta das faixas de áudio deste trecho: não use a fala; siga as instruções)')
  else L.push(o.heardError ? `(não deu pra transcrever: ${o.heardError})` : '(só silêncio ou música)')
  if (o.heardPrompts?.length)
    L.push(
      '',
      '## Prompts do autor em falas específicas (o principal do trecho onde cada um cai: siga à risca, no tempo dessas palavras)',
      ...o.heardPrompts.map((p) => `- De ${p.t0.toFixed(1)}s a ${p.t1.toFixed(1)}s, quando é dito "${p.words}": ${p.text}`)
    )
  if (o.scriptHere.length) L.push('', 'Falas do roteiro que caem aqui (use pra acertar nomes e termos; a fala gravada manda, inclusive improvisos):', ...o.scriptHere.map((s) => '> ' + s))
  L.push('')
  if (o.falas) L.push('## Roteiro do vídeo (só as falas, com os capítulos como "# título", pra entender o tema)', o.falas.slice(0, 12000), '')
  L.push('## Direção de motion', MOTION_DIRECTION, syncDirection(blockSync(b)), '')
  L.push(safeZoneDirection(safeZones(o.format?.aspect, o.size.w, o.size.h), o.size), '')
  const rules = o.format?.rules?.trim()
  if (rules) L.push('## Regras do estilo (respeite)', rules, '')
  const guide = o.format?.motion?.learned?.guide
  if (guide) L.push('## Guia de estilo do formato', guide, '')
  if (o.assets?.list.length) {
    const a = o.assets
    L.push(
      '## Assets do estilo (as pastas fixas deste formato)',
      'São os arquivos que este estilo sempre usa (ex.: pngtuber, logo, molduras, fundos). Quando as regras, o guia ou as instruções pedirem algum deles (ex.: o pngtuber no canto), USE o arquivo de verdade, nunca um desenho inventado no lugar: ele está na mesma pasta do HTML com o nome abaixo. Imagem: <img src="nome">. Vídeo: <video src="nome" muted playsinline></video> (o Typos sincroniza o tempo; não use autoplay nem mexa em currentTime). Escolha pela pasta e pelo nome o que combina com o momento (ex.: a expressão do pngtuber que casa com a fala).',
      ...a.list.map((x) => `- ${x.name} ← ${x.rel} (${x.kind === 'image' ? 'imagem' : 'vídeo'})`),
      a.shown ? `As imagens ${a.first} a ${a.first + a.shown - 1} são as ${a.shown} primeiras imagens desta lista, na mesma ordem.` : '',
      ''
    )
  }
  const assetsGuide = o.format?.motion?.assetsGuide?.guide
  if (assetsGuide && (o.assets?.list.length || o.raw?.list.some((f) => f.style))) L.push('## Como usar os assets do estilo (o que você estudou no treino do estilo)', assetsGuide, '')
  const raw = o.raw?.list.length ? o.raw : null
  const rawSounds = !!raw?.list.some((f) => f.kind === 'audio' || f.kind === 'video')
  if (raw) {
    const kind = (f: RawFile) =>
      (f.kind === 'image' ? 'imagem' : f.kind === 'video' ? 'vídeo' : f.style === 'music' ? 'música' : 'som') +
      (f.profile ? `, ${f.profile.duration.toFixed(1)} s; ${profileText(f.profile)}` : f.duration ? `, ${f.duration.toFixed(1)} s` : '')
    const fromStyle = raw.list.some((f) => f.style)
    const notes = styleFoldersOf(o.format).filter((x) => x.role !== 'visual' && (x.note?.trim() || x.star))
    L.push(
      fromStyle ? '## Material bruto do projeto e pastas do estilo (o autor pediu pra você usar)' : '## Material bruto do projeto (o autor pediu pra você usar)',
      'São os arquivos deste vídeo: gravações, prints, imagens, vídeos e sons. Use o que combinar com a fala e as instruções deste trecho, de verdade (o arquivo, não um desenho inventado no lugar), sem forçar: se nada combinar, não use. Eles estão na mesma pasta do HTML com o nome abaixo. Imagem: <img src="nome">. Vídeo: <video src="nome" muted playsinline></video> (o Typos sincroniza o tempo; não use autoplay nem mexa em currentTime).',
      fromStyle ? 'Os que começam com "Estilo/" são a biblioteca fixa deste estilo (trilhas, efeitos, materiais que o autor usa em todo vídeo dele), não só deste roteiro.' : '',
      ...(notes.length ? ['Pastas do estilo:', ...notes.map((x) => `- Estilo/${roleLabel(x.role)}/${x.path.split(/[\\/]/).filter(Boolean).pop()}${x.star ? ' ⭐ favorita (procure aqui primeiro: prefira o que tem nela antes das outras pastas)' : ''}${x.note?.trim() ? ': ' + x.note.trim() : ''}`)] : []),
      rawSounds
        ? 'Som (efeito, trilha, ou o som de um vídeo da lista): NÃO ponha <audio> no HTML (ele não é gravado). Liste na tag <sons> do fim da resposta, com o segundo em que entra; o Typos mixa com a narração e, quando o autor aprovar, vira um corte de áudio na timeline. Som é tempero: poucos, nos momentos certos (uma entrada, um impacto, um número), com volume que não cubra a fala.'
        : '',
      raw.list.some((f) => f.profile)
        ? 'Nos sons analisados, "impacto" é quanto tempo depois do começo do arquivo vem o momento mais forte, e a energia vai de 0 (silêncio) a 9 (o mais alto do arquivo). O "em" da tag <sons> é onde o ARQUIVO começa: pra o impacto cair no segundo X do bloco (o número aparecendo, o corte, a batida), use em = X − impacto. Trilha com começo calmo pode entrar antes e crescer junto com o motion.'
        : '',
      raw.list.some((f) => f.star) ? 'Os marcados com ⭐ vêm de pastas favoritas do autor: procure neles primeiro e prefira-os antes dos outros quando combinarem.' : '',
      ...raw.list.map((f) => `- ${f.star ? '⭐ ' : ''}${f.name} ← ${f.rel} (${kind(f)})`),
      raw.shown ? `As imagens ${raw.first} a ${raw.first + raw.shown - 1} são as ${raw.shown} primeiras imagens desta lista, na mesma ordem.` : '',
      raw.sounds?.length ? 'Sons que você já tinha posto na prévia atual (repita na tag <sons> os que continuam): ' + JSON.stringify(raw.sounds.map((x) => ({ arquivo: x.name, em: x.at, volume: x.vol }))) : '',
      ''
    )
  }
  const m = o.format?.motion
  if (m?.colors?.length) L.push('Cores: ' + m.colors.join(', '))
  if (m?.fonts) L.push(`Fontes: título ${m.fonts.title ?? '-'}, subtítulo ${m.fonts.subtitle ?? '-'}, texto ${m.fonts.body ?? '-'}, destaque ${m.fonts.accent ?? '-'}`)
  const mem = memorySection(m?.memory)
  if (mem) L.push('', mem, '')
  if (o.adjust) {
    L.push(
      '## AJUSTE na prévia atual (o principal deste pedido)',
      'Você já fez a animação abaixo pra este bloco e o autor viu a prévia. NÃO recomece do zero: parta deste HTML, mantenha tudo que o autor não pediu pra mudar e aplique os ajustes. Os pedidos anteriores já estão nele; o último é o novo.',
      '```html',
      o.adjust.html.slice(0, 60000),
      '```',
      '',
      'Ajustes pedidos (em ordem):'
    )
    o.adjust.tweaks.forEach((t, i) =>
      L.push(`${i + 1}. ${t.text.trim() || '(só imagens)'}${t.names.length ? ` [imagens: ${t.names.join(', ')}; estão na pasta do HTML com esses nomes e chegam pra você depois das outras, nessa ordem. Use no vídeo com <img src="nome"> se o pedido for pra mostrar; senão, são referência]` : ''}`)
    )
    L.push('')
  }
  L.push(
    '## Responda EXATAMENTE neste formato (nada fora das tags)',
    '<demo>',
    `Um arquivo HTML completo e autocontido (CSS e JS inline, sem internet), em ${o.size.w}x${o.size.h} px preenchendo a página (body sem margem, overflow hidden), que toca o motion deste bloco UMA vez, começando em 0 s e durando exatamente ${d.toFixed(2)} s (sem loop; segure o último quadro). Anime com CSS keyframes, Web Animations ou requestAnimationFrame com performance.now(): o Typos controla o relógio e grava quadro a quadro. Use as fontes pelo nome (font-family) e as cores do estilo. O clipe final é gravado ampliado (mesma composição, mais pixels): prefira texto, SVG e CSS, que ficam nítidos; se usar <canvas>, crie ele em largura×devicePixelRatio por altura×devicePixelRatio (com o tamanho CSS normal) e dê ctx.scale(devicePixelRatio, devicePixelRatio), senão ele sai borrado.${o.files.some((f) => f.a.use === 'insert') ? ' As imagens de insert estão na mesma pasta do HTML, pelo nome indicado.' : ''}`,
    '</demo>'
  )
  if (rawSounds)
    L.push(
      '<sons>',
      'Lista JSON dos sons do Material bruto que tocam neste motion; "em" é o segundo a partir do começo do bloco e "volume" vai de 0 a 1. Ex.: [{"arquivo": "bruto-3-whoosh.wav", "em": 1.2, "volume": 0.6}]. Sem som: [].',
      '</sons>'
    )
  return L.join('\n')
}

export function parseDemo(text: string) {
  let demo = text.match(/<demo>([\s\S]*?)<\/demo>/i)?.[1]?.trim() ?? ''
  if (!demo && /<html[\s>]/i.test(text)) demo = text.slice(text.search(/<!doctype|<html/i))
  return demo.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim()
}

/** nome do arquivo de anexo dentro da pasta da prévia */
export const attachName = (a: BlockAttachment, i: number) => `anexo-${i + 1}${a.path.match(/\.\w+$/)?.[0]?.toLowerCase() ?? '.png'}`

/** item da memória a partir de um bloco aprovado (lê o HTML da prévia) */
export async function memoryFromBlock(b: InstructionBlock, html: string): Promise<MotionMemoryItem> {
  const what = [
    b.dynamic ? 'Bloco dinâmico (motion deduzido da fala).' : 'Bloco com instruções escritas.',
    b.text.trim() ? 'Pedido: ' + b.text.trim() : '',
    b.attachments.length ? 'Anexos: ' + b.attachments.map((a) => `${a.name} (${a.use === 'insert' ? 'insert' : 'referência'})`).join(', ') : '',
    b.preview?.transcript ? 'Fala do trecho: ' + b.preview.transcript.replace(/\[[\d.]+s\]\s*/g, '').slice(0, 400) : ''
  ]
  return { id: uid(), at: new Date().toISOString(), source: 'bloco', title: blockLabel(b), text: what.filter(Boolean).join('\n'), html: html.slice(0, 12000) }
}

// ---------- editar um motion já aprovado (o clipe na timeline) ----------
/**
 * O bloco por trás de um clipe de motion aprovado, posto no tempo do clipe (o segundo 0 do HTML cai em
 * clip.start - clip.in), e a timeline sem esse clipe (pra ele não aparecer como "vídeo de baixo" de si mesmo).
 * Clipes aprovados antes de guardarem o bloco viram um bloco só com o HTML.
 */
export function blockFromClip(data: MontageData, clipId: string, format?: Format): { block: InstructionBlock; data: MontageData } | null {
  const c = data.clips.find((x) => x.id === clipId)
  const m = c && data.media.find((x) => x.id === c.media)
  if (!c || !m || !(m.motionHtml || m.motionBlock?.preview)) return null
  const start = Math.max(0, c.start - c.in)
  // clipe antigo: o id do bloco é o nome da pasta da prévia (previas/<bloco>/clipe-….mp4), onde estão os anexos copiados
  const folder = m.path.match(/[\\/]previas[\\/]([^\\/]+)[\\/][^\\/]+$/)?.[1]
  const base: InstructionBlock = m.motionBlock ?? { id: folder ?? 'b' + uid(), track: c.track, start, end: start + m.duration, name: m.name.replace(/\.mp4$/i, ''), text: '', attachments: [] }
  const block: InstructionBlock = { ...base, track: c.track, start, end: start + m.duration, approved: true }
  const prev = base.preview
  block.preview = {
    video: m.path,
    html: m.motionHtml ?? prev!.html,
    at: prev?.at ?? '',
    provider: prev?.provider ?? '',
    transcript: prev?.transcript ?? '',
    key: '',
    size: prev?.size ?? previewSize(format)
  }
  block.preview.key = blockKey(block)
  return { block, data: { ...data, clips: data.clips.filter((x) => x.id !== c.id) } }
}

/** pedido de alteração de um trecho do motion (tempos do clipe); sem trecho, vale o clipe todo */
export function rangeTweak(text: string, range: [number, number] | null) {
  if (!range) return text
  const f = (t: number) => t.toFixed(2).replace('.', ',')
  return `ALTERE SÓ O TRECHO de ${f(range[0])} s a ${f(range[1])} s da animação. Fora dele, tudo fica EXATAMENTE igual, quadro a quadro (mesmos elementos, posições e tempos); dentro, a entrada e a saída do trecho emendam sem salto com o que vem antes e depois. Pedido: ${text || '(veja as imagens)'}`
}

/** pedido de continuar o motion: de `from` s (onde ele acaba hoje) até `to` s */
export function extendTweak(text: string, from: number, to: number) {
  const f = (t: number) => t.toFixed(2).replace('.', ',')
  return `CONTINUE A ANIMAÇÃO: hoje ela acaba em ${f(from)} s e agora tem que durar ${f(to)} s. De 0 a ${f(from)} s tudo fica EXATAMENTE igual, quadro a quadro (se o HTML usa a duração antiga em constantes ou cálculos, ajuste sem mudar o tempo do que já existe). De ${f(from)} s a ${f(to)} s, continue de onde ela parou, sem salto nem recomeço: os elementos que estão na tela seguem dali, acompanhando a fala desse trecho.${text.trim() ? ' Pedido do autor pra essa continuação: ' + text.trim() : ''}`
}

// ---------- prévia ----------
export interface PreviewCtx {
  block: InstructionBlock
  data: MontageData
  engine: MontageEngine
  dur: (id: string) => number
  script: ScriptBlock[]
  lang: string
  format?: Format
  dir: string
  /** etapa atual; `pct` é dentro da etapa e `span` o pedaço do total que ela ocupa (pra barra geral) */
  onStage: (label: string, pct: number | null, span?: [number, number], frames?: number) => void
  /** Cancelar: para de esperar (o que já foi pra fila do Whisper continua e fica guardado) */
  signal?: AbortSignal
  /** pedir ajuste: parte da prévia atual em vez de criar do zero */
  adjust?: { tweaks: BlockTweak[] }
}

/** imagens dos ajustes: o nome com que vão pra pasta da prévia */
function tweakFiles(tweaks: BlockTweak[] | undefined) {
  return (tweaks ?? []).map((t, i) =>
    t.files.filter(isImage).map((a, j) => ({ a, name: `ajuste-${i + 1}-${j + 1}${a.path.match(/\.\w+$/)?.[0]?.toLowerCase() ?? '.png'}` }))
  )
}

/**
 * Prévia do bloco: confere se tem áudio no trecho, transcreve, junta roteiro + instruções + estilo + memória,
 * pede o HTML do motion pra IA e grava em 12 fps com o áudio do trecho.
 */
/** espera do Claude: não tem progresso de verdade, então a barra anda devagar (estimativa) até a resposta chegar */
async function waitAi<T>(c: Pick<PreviewCtx, 'onStage'>, label: string, span: [number, number], job: Promise<T>) {
  const t0 = Date.now()
  const tick = () => c.onStage(label, 1 - Math.exp(-(Date.now() - t0) / 150000), span)
  tick()
  const id = setInterval(tick, 1000)
  try {
    return await job
  } finally {
    clearInterval(id)
  }
}

export async function generatePreview(c: PreviewCtx) {
  const b = c.block
  const hasAudio = audioIn(c.data, b).length > 0
  const deaf = hasAudio && !heardClips(c.data, b).length
  let heard: { words: HeardWord[]; prompts: HeardPrompt[]; error?: string } = { words: [], prompts: [] }
  if (hasAudio && !deaf) {
    c.onStage('Ouvindo o trecho (Whisper)…', null, [0, 0.1])
    heard = await heardIn(c.data, b, c.lang, { signal: c.signal, onWait: (l, p) => c.onStage(l, p, [0, 0.1]) })
  }
  if (c.signal?.aborted) throw new Error('Cancelado.')
  const files = b.attachments.filter(isImage).map((a, i) => ({ a, name: attachName(a, i) }))
  const size = previewSize(c.format)
  c.onStage('Olhando o vídeo embaixo do bloco…', null, [0.1, 0.14])
  const under = await underFor(c.data, b, c.dir, size, true)
  if (b.fromPrev || b.toNext) c.onStage('Olhando o que vem antes e depois do bloco…', null, [0.14, 0.17])
  const edges = await edgesFor(c.data, b, c.dir, size)
  let adjust: { html: string; tweaks: { text: string; names: string[] }[] } | undefined
  const tf = tweakFiles(c.adjust?.tweaks)
  if (c.adjust) {
    if (!b.preview) throw new Error('Gere a prévia antes de pedir ajustes.')
    const html = await fetch(fileUrl(b.preview.html))
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => '')
    if (!html) throw new Error('Não achei o HTML da prévia atual. Gere a prévia de novo.')
    adjust = { html, tweaks: c.adjust.tweaks.map((t, i) => ({ text: t.text, names: tf[i].map((f) => f.name) })) }
  }
  const list = await styleAssets(c.format)
  const shownAssets = list.filter((a) => a.kind === 'image' && /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.path)).slice(0, MAX_STYLE_IMAGES)
  // as imagens dos assets vêm por último (depois dos anexos, do vídeo de baixo, das emendas e dos ajustes)
  const baseImages = [...files.map((f) => absPath(f.a)), ...(under?.frames.map((f) => f.path) ?? []), ...edges.map((e) => e.frame), ...tf.flat().map((f) => absPath(f.a))]
  const shownSet = new Set(shownAssets)
  const assets = { list: [...shownAssets, ...list.filter((a) => !shownSet.has(a))], first: baseImages.length + 1, shown: shownAssets.length }
  // o Material bruto (se o bloco pediu): as imagens dele vêm depois das dos assets
  if (b.useRaw) c.onStage('Lendo o Material bruto e analisando os sons…', null, [0.17, 0.17])
  const rawList = b.useRaw ? await withProfiles(await rawFiles(c.data, c.format)) : []
  const shownRaw = rawList.filter((f) => f.kind === 'image' && /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.path)).slice(0, MAX_RAW_IMAGES)
  const shownRawSet = new Set(shownRaw)
  const raw = {
    list: [...shownRaw, ...rawList.filter((f) => !shownRawSet.has(f))],
    first: assets.first + assets.shown,
    shown: shownRaw.length,
    sounds: adjust ? b.preview?.sounds : undefined
  }
  const chapter = chapterAt(c.data, b, c.script)
  const prompt = blockPrompt({
    block: b,
    format: c.format,
    heard: heard.words,
    heardError: heard.error,
    heardPrompts: heard.prompts,
    deaf,
    hasAudio,
    scriptHere: scriptIn(c.data, b, c.script),
    falas: scriptFalas(c.script),
    chapter,
    files,
    size,
    under,
    edges,
    adjust,
    assets,
    raw
  })
  const images = [...baseImages, ...shownAssets.map((a) => a.path), ...shownRaw.map((f) => f.path)]
  if (c.signal?.aborted) throw new Error('Cancelado.')
  const r = await waitAi(c, adjust ? 'Claude ajustando o motion…' : 'Claude criando o motion…', [0.17, 0.62], api.motionTrain({ prompt, images, id: b.id }))
  if ('error' in r) throw new Error(r.error)
  let html = parseDemo(r.text)
  if (!html) throw new Error('A IA respondeu fora do formato (sem o HTML da animação). Tente de novo.')
  let sounds = parseSounds(r.text, rawList, blockDur(b)) ?? []
  const playFiles = (h: string) => [
    ...files.filter((f) => f.a.use === 'insert').map((f) => ({ src: absPath(f.a), name: f.name })),
    ...tf.flat().map((f) => ({ src: absPath(f.a), name: f.name })),
    ...(under ? [{ src: under.video, name: UNDER_NAME }] : []),
    ...edgeFiles(edges),
    ...assetFiles(list, h),
    ...assetFiles(rawList, h)
  ]
  // safe zone: mede a animação e, se algo ficou fora do lugar, devolve pro Claude corrigir (uma vez)
  const zones = safeZones(c.format?.aspect, size.w, size.h)
  const check = async (h: string): Promise<LayoutIssue[]> => {
    const got = await api.motionCheckLayout({ dir: c.dir, block: b.id, html: h, seconds: blockDur(b), width: size.w, height: size.h, files: playFiles(h), probe: layoutProbe(zones) })
    if ('error' in got) {
      if (got.error === 'Cancelado.') throw new Error(got.error)
      return []
    }
    return got.issues
  }
  c.onStage('Conferindo a safe zone…', null, [0.62, 0.66])
  let issues = await check(html)
  if (issues.length && !c.signal?.aborted) {
    const fixPrompt = blockPrompt({
      block: b,
      format: c.format,
      heard: heard.words,
      heardError: heard.error,
      heardPrompts: heard.prompts,
      deaf,
      hasAudio,
      scriptHere: scriptIn(c.data, b, c.script),
      falas: scriptFalas(c.script),
      chapter,
      files,
      size,
      under,
      edges,
      adjust: { html, tweaks: [...(adjust?.tweaks ?? []), { text: issuesTweak(issues, zones), names: [] }] },
      assets,
      raw: { ...raw, sounds }
    })
    const f = await waitAi(
      c,
      `Claude corrigindo a safe zone (${issues.length} elemento${issues.length > 1 ? 's' : ''} fora do lugar)…`,
      [0.66, 0.78],
      api.motionTrain({ prompt: fixPrompt, images, id: b.id })
    )
    if (c.signal?.aborted) throw new Error('Cancelado.')
    const fixed = 'error' in f ? '' : parseDemo(f.text)
    if (fixed) {
      html = fixed
      sounds = ('error' in f ? null : parseSounds(f.text, rawList, blockDur(b))) ?? sounds
      c.onStage('Conferindo a safe zone de novo…', null, [0.78, 0.8])
      issues = await check(html)
    }
  }
  if (c.signal?.aborted) throw new Error('Cancelado.')
  c.onStage('Mixando o áudio do trecho…', null, [0.8, 0.82])
  const mix = await withSounds(c.engine, c.data, c.dur, b, sounds)
  sounds = mix.sounds
  const wav = hasAudio || sounds.length ? await rangeWav(c.engine, mix.data, mix.dur, b.start, b.end).catch(() => undefined) : undefined
  c.onStage('Gravando a prévia (12 fps)…', 0, [0.82, 1], Math.max(1, Math.round(blockDur(b) * PREVIEW_FPS)))
  const v = await api.motionPreview({
    dir: c.dir,
    block: b.id,
    html,
    seconds: blockDur(b),
    width: size.w,
    height: size.h,
    fps: PREVIEW_FPS,
    wav,
    files: playFiles(html)
  })
  if ('error' in v) throw new Error(v.error)
  return {
    video: v.video,
    html: v.html,
    at: new Date().toISOString(),
    provider: r.provider,
    transcript: phrases(heard.words),
    key: blockKey(b),
    size,
    safeIssues: issues.length ? issuesTweak(issues, zones).split('\n').slice(1) : undefined,
    sounds: sounds.length ? sounds : undefined
  }
}

/**
 * Clipe final do bloco: o HTML da prévia aprovada gravado de novo na resolução do projeto (30 fps),
 * ampliado com zoom (a composição fica igual à que foi aprovada), com o áudio do trecho.
 */
export async function generateClip(c: Omit<PreviewCtx, 'script' | 'lang'>) {
  const b = c.block
  if (!b.preview) throw new Error('Gere a prévia antes de aprovar.')
  const files = b.attachments.filter(isImage).map((a, i) => ({ a, name: attachName(a, i) }))
  const size = projectSize(c.format)
  // o tamanho em que o HTML foi escrito (prévias antigas: o do próprio vídeo da prévia)
  let small = b.preview.size
  if (!small) {
    const info = await api.probeMedia(b.preview.video)
    small = !('error' in info) && info.width && info.height ? { w: info.width, h: info.height } : previewSize(c.format)
  }
  if (Math.abs(small.w / small.h - size.w / size.h) > 0.02) {
    const kind = (s: { w: number; h: number }) => (s.w > s.h ? 'horizontal' : s.w < s.h ? 'vertical' : 'quadrada')
    throw new Error(
      `esta prévia foi feita ${kind(small)} (${small.w}×${small.h}) e a timeline está em ${c.format?.aspect ?? '16:9'} (${kind(size)}). Gere a prévia de novo pra ela sair no formato da timeline.`
    )
  }
  const hasAudio = audioIn(c.data, b).length > 0
  // o vídeo de baixo de novo, agora na resolução do clipe (a animação usa ele pelo nome)
  const html = await fetch(fileUrl(b.preview.html))
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '')
  let under: UnderInfo | null = null
  if (html.includes(UNDER_NAME)) {
    c.onStage('Recortando o vídeo de baixo…', null, [0, 0.08])
    under = await underFor(c.data, b, c.dir, size, false)
  }
  // as emendas de novo, no tamanho do clipe (só as que a animação usa pelo nome)
  let edges: EdgeInfo[] = []
  if (html.includes(PREV_NAME) || html.includes(NEXT_NAME)) {
    c.onStage('Pegando os quadros de antes e depois…', null, [0.08, 0.12])
    edges = (await edgesFor(c.data, b, c.dir, size).catch(() => [])).filter((e) => html.includes(edgeName(e)))
  }
  c.onStage('Mixando o áudio do trecho…', null, [0.12, 0.15])
  const sounds = b.preview.sounds ?? []
  const mix = await withSounds(c.engine, c.data, c.dur, b, sounds)
  const wav = hasAudio || sounds.length ? await rangeWav(c.engine, mix.data, mix.dur, b.start, b.end).catch(() => undefined) : undefined
  c.onStage(`Gravando o clipe em ${size.w}×${size.h}…`, 0, [0.15, 1], Math.max(1, Math.round(blockDur(b) * CLIP_FPS)))
  const v = await api.motionPreview({
    dir: c.dir,
    block: b.id,
    html: '',
    htmlPath: b.preview.html,
    seconds: blockDur(b),
    width: size.w,
    height: size.h,
    fps: CLIP_FPS,
    zoom: size.w / small.w,
    final: true,
    wav,
    files: [
      ...files.filter((f) => f.a.use === 'insert').map((f) => ({ src: absPath(f.a), name: f.name })),
      ...tweakFiles(b.tweaks).flat().map((f) => ({ src: absPath(f.a), name: f.name })),
      ...(under ? [{ src: under.video, name: UNDER_NAME }] : []),
      ...edgeFiles(edges),
      ...(html.includes('estilo-') ? assetFiles(await styleAssets(c.format), html) : []),
      ...(html.includes('bruto-') ? assetFiles(await rawFiles(c.data, c.format), html) : [])
    ]
  })
  if ('error' in v) throw new Error(v.error)
  return v.video
}
