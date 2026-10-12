import {
  absPath,
  api,
  clipEndT,
  formatTime,
  RESOLUTIONS,
  uid,
  type BlockAttachment,
  type Format,
  type InstructionBlock,
  type MontageData,
  type MotionMemoryItem
} from '../lib'
import { spans, type MontageEngine } from './engine'
import type { ScriptBlock } from './autocut'

/**
 * Blocos de instrução: pedaços de tempo na faixa de vídeo com instruções de motion.
 * Aqui fica o modelo (criar, mexer), a prévia (ouvir o trecho, pedir o HTML à IA, virar MP4)
 * e o texto que vai pro render e pra memória de motion.
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
  const s = JSON.stringify([b.start.toFixed(2), b.end.toFixed(2), b.text.trim(), !!b.dynamic, b.attachments.map((a) => [a.path, a.use, a.note ?? ''])])
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export const previewStale = (b: InstructionBlock) => !!b.preview && b.preview.key !== blockKey(b)

export const isImage = (a: BlockAttachment) => (a.kind ?? 'image') === 'image' || /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.path)

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

/** transcreve (Whisper, com cache por arquivo) e devolve só as palavras que caem dentro do bloco */
export async function heardIn(data: MontageData, b: InstructionBlock, lang: string): Promise<{ words: HeardWord[]; error?: string }> {
  const clips = audioIn(data, b)
  const media = new Map(data.media.map((m) => [m.id, m]))
  const words: HeardWord[] = []
  let error: string | undefined
  for (const path of new Set(clips.map((c) => media.get(c.media)!.path))) {
    const r = await api.transcribe(path, lang)
    if ('error' in r) {
      error = r.error
      continue
    }
    for (const c of clips.filter((x) => media.get(x.media)!.path === path)) {
      for (const w of r.words) {
        if (w.s < c.in || w.s >= c.out) continue
        const t = c.start + (w.s - c.in)
        if (t >= b.start && t < b.end) words.push({ t: t - b.start, w: w.w })
      }
    }
  }
  return { words: words.sort((a, z) => a.t - z.t), error }
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

/** só as falas do roteiro (sem prompts nem instruções): é o tema do vídeo */
export const scriptFalas = (script: ScriptBlock[]) =>
  script
    .filter((s) => s.type === 'paragraph' && s.text.trim())
    .map((s) => s.text.trim())
    .join('\n')

// ---------- áudio do trecho (mixado como a Montagem toca) ----------
export async function rangeWav(engine: MontageEngine, data: MontageData, dur: (id: string) => number, t0: number, t1: number): Promise<Uint8Array | undefined> {
  const rate = 44100
  const len = Math.ceil((t1 - t0) * rate)
  if (len <= 0) return
  const ctx = new OfflineAudioContext(1, len, rate)
  let any = false
  for (const s of spans(data, dur)) {
    if (s.t1 <= t0 || s.t0 >= t1) continue
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
    const env = (rel: number) => {
      let v = 1
      if (s.fin > 0 && rel < s.fin) v = Math.min(v, rel / s.fin)
      if (s.fout > 0 && rel > d - s.fout) v = Math.min(v, (d - rel) / s.fout)
      return Math.max(0, v) * s.gain
    }
    g.gain.setValueAtTime(env(rel0), when)
    for (const p of [s.fin, d - s.fout, d]) if (p > rel0 && p <= d) g.gain.linearRampToValueAtTime(env(p), when + (p - rel0))
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

// ---------- direção de motion (vale pra prévia e pro render) ----------
export const MOTION_DIRECTION = [
  '- Pense como motion designer, não como apresentador de slides: nada de lista de tópicos surgindo um embaixo do outro, nada de "cartão com título + bullets".',
  '- Antes de animar, imagine de 3 a 7 ideias de apresentação bem diferentes pro trecho (gráfico que se monta, objeto isométrico, mapa, linha do tempo, comparação lado a lado, tipografia gigante em close, colagem, interface recriada, câmera viajando por um cenário, contador, metáfora visual…) e escolha a mais forte. Em trechos longos, encadeie 2 ou 3 composições diferentes.',
  '- Varie a composição de cena de um momento pro outro: escala (close × aberto), centro × terços, camadas com profundidade, movimento de câmera, ritmo.',
  '- NÃO sincronize cada frase da fala. A fala dá o tema e os momentos-chave (um número, um nome, uma virada); só esses picos casam com o áudio. O resto respira com movimento contínuo.',
  '- Texto na tela é curto (palavra-chave, número, título), nunca a frase falada inteira.',
  '- Siga o guia de estilo e a memória de motion (o que o autor já aprovou).'
].join('\n')

const ATTACH_RULES = {
  insert: 'INSERT: a imagem ENTRA no vídeo. Mostre ela de verdade e anime por cima (setas, círculos, zoom em detalhes, destaques, recortes) seguindo as instruções.',
  ref: 'REFERÊNCIA: a imagem NÃO aparece no vídeo. Recrie em HTML/CSS, com design bonito e no estilo do formato (um clone estilizado, ex.: a página do SteamDB redesenhada), e anime essa recriação.'
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

export function blockPrompt(o: {
  block: InstructionBlock
  format?: Format
  heard: HeardWord[]
  heardError?: string
  hasAudio: boolean
  scriptHere: string[]
  falas: string
  files: { a: BlockAttachment; name: string }[]
  size: { w: number; h: number }
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
  if (o.files.length) {
    L.push('## Anexos (as imagens chegam pra você na mesma ordem: a 1ª imagem é o anexo 1, e assim por diante)')
    o.files.forEach(({ a, name }, i) => {
      L.push(`${i + 1}. ${name}: ${ATTACH_RULES[a.use]}${a.use === 'insert' ? ` No HTML use exatamente <img src="${name}">.` : ''}${a.note?.trim() ? ` Nota do autor: ${a.note.trim()}` : ''}`)
    })
    L.push('')
  }
  L.push('## O que é falado neste trecho (tempos a partir do começo do bloco)')
  if (!o.hasAudio) L.push('(não há áudio neste trecho: o motion carrega o momento sozinho)')
  else if (o.heard.length) L.push(phrases(o.heard))
  else L.push(o.heardError ? `(não deu pra transcrever: ${o.heardError})` : '(só silêncio ou música)')
  if (o.scriptHere.length) L.push('', 'Falas do roteiro que caem aqui (use pra acertar nomes e termos; a fala gravada manda, inclusive improvisos):', ...o.scriptHere.map((s) => '> ' + s))
  L.push('')
  if (o.falas) L.push('## Roteiro do vídeo (só as falas, pra entender o tema)', o.falas.slice(0, 12000), '')
  L.push('## Direção de motion', MOTION_DIRECTION, '')
  const guide = o.format?.motion?.learned?.guide
  if (guide) L.push('## Guia de estilo do formato', guide, '')
  const m = o.format?.motion
  if (m?.colors?.length) L.push('Cores: ' + m.colors.join(', '))
  if (m?.fonts) L.push(`Fontes: título ${m.fonts.title ?? '-'}, subtítulo ${m.fonts.subtitle ?? '-'}, texto ${m.fonts.body ?? '-'}, destaque ${m.fonts.accent ?? '-'}`)
  const mem = memorySection(m?.memory)
  if (mem) L.push('', mem, '')
  L.push(
    '## Responda EXATAMENTE neste formato (nada fora das tags)',
    '<demo>',
    `Um arquivo HTML completo e autocontido (CSS e JS inline, sem internet), em ${o.size.w}x${o.size.h} px preenchendo a página (body sem margem, overflow hidden), que toca o motion deste bloco UMA vez, começando em 0 s e durando exatamente ${d.toFixed(2)} s (sem loop; segure o último quadro). Anime com CSS keyframes, Web Animations ou requestAnimationFrame com performance.now(): o Typos controla o relógio e grava quadro a quadro. Use as fontes pelo nome (font-family) e as cores do estilo.${o.files.some((f) => f.a.use === 'insert') ? ' As imagens de insert estão na mesma pasta do HTML, pelo nome indicado.' : ''}`,
    '</demo>'
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

// ---------- render: o que vai no pedido ----------
export function blocksBriefSection(blocks: InstructionBlock[] | undefined, memory: MotionMemoryItem[] | undefined, tracks: MontageData['tracks']) {
  const list = [...(blocks ?? [])].sort((a, b) => a.start - b.start)
  const out: string[] = []
  if (list.length) {
    out.push(
      '## Blocos de instrução de motion (o autor marcou na timeline: siga à risca)',
      'Cada bloco é um trecho do vídeo com motion próprio. `modo: escrito` = siga as instruções; `modo: dinâmico` = deduza o motion da fala do trecho. Anexos `insert` entram no vídeo (anotados com setas, zoom, destaques); `referencia` NÃO aparece: recrie em motion com design bonito. Quando há `previa_aprovada`, o autor aprovou aquela animação (HTML): reaproveite a ideia e a composição, em resolução cheia.',
      '```json',
      JSON.stringify(
        list.map((b) => ({
          faixa: tracks.find((t) => t.id === b.track)?.name ?? b.track,
          nome: b.name || undefined,
          inicio: +b.start.toFixed(2),
          fim: +b.end.toFixed(2),
          modo: b.dynamic ? 'dinâmico' : 'escrito',
          instrucoes: b.text.trim() || undefined,
          anexos: b.attachments.length ? b.attachments.map((a) => ({ arquivo: absPath(a), uso: a.use === 'insert' ? 'insert' : 'referencia', nota: a.note || undefined })) : undefined,
          previa_aprovada: b.approved && b.preview ? b.preview.html : undefined
        })),
        null,
        1
      ),
      '```',
      ''
    )
  }
  out.push('## Direção de motion', MOTION_DIRECTION, '')
  const mem = memorySection(memory)
  if (mem) out.push(mem, '')
  return out
}

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
  onStage: (label: string, pct: number | null) => void
}

/**
 * Prévia do bloco: confere se tem áudio no trecho, transcreve, junta roteiro + instruções + estilo + memória,
 * pede o HTML do motion pra IA e grava em 12 fps com o áudio do trecho.
 */
export async function generatePreview(c: PreviewCtx) {
  const b = c.block
  const hasAudio = audioIn(c.data, b).length > 0
  let heard: { words: HeardWord[]; error?: string } = { words: [] }
  if (hasAudio) {
    c.onStage('Ouvindo o trecho (Whisper)…', null)
    heard = await heardIn(c.data, b, c.lang)
  }
  const files = b.attachments.filter(isImage).map((a, i) => ({ a, name: attachName(a, i) }))
  const size = previewSize(c.format)
  const prompt = blockPrompt({
    block: b,
    format: c.format,
    heard: heard.words,
    heardError: heard.error,
    hasAudio,
    scriptHere: scriptIn(c.data, b, c.script),
    falas: scriptFalas(c.script),
    files,
    size
  })
  c.onStage('Claude criando o motion…', null)
  const r = await api.motionTrain({ prompt, images: files.map((f) => absPath(f.a)) })
  if ('error' in r) throw new Error(r.error)
  const html = parseDemo(r.text)
  if (!html) throw new Error('A IA respondeu fora do formato (sem o HTML da animação). Tente de novo.')
  c.onStage('Mixando o áudio do trecho…', null)
  const wav = hasAudio ? await rangeWav(c.engine, c.data, c.dur, b.start, b.end).catch(() => undefined) : undefined
  c.onStage('Gravando a prévia (12 fps)…', 0)
  const v = await api.motionPreview({
    dir: c.dir,
    block: b.id,
    html,
    seconds: blockDur(b),
    width: size.w,
    height: size.h,
    fps: PREVIEW_FPS,
    wav,
    files: files.filter((f) => f.a.use === 'insert').map((f) => ({ src: absPath(f.a), name: f.name }))
  })
  if ('error' in v) throw new Error(v.error)
  return {
    video: v.video,
    html: v.html,
    at: new Date().toISOString(),
    provider: r.provider,
    transcript: phrases(heard.words),
    key: blockKey(b)
  }
}
