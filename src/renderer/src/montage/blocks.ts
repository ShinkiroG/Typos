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
  type BlockTweak,
  type Format,
  type InstructionBlock,
  type MontageData,
  type MotionMemoryItem
} from '../lib'
import { envAt, envPoints, spans, type MontageEngine } from './engine'
import type { ScriptBlock } from './autocut'
import { jobPct, runningLabel, speechFiles, watchJobs } from './transcripts'
import { planRender, type VLayer } from '../render/plan'

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
  const s = JSON.stringify([b.start.toFixed(2), b.end.toFixed(2), b.text.trim(), !!b.dynamic, b.attachments.map((a) => [a.path, a.use, a.note ?? '']), blockSync(b)])
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

/** arquivos com fala que tocam no bloco (o que precisa estar lido pra prévia sair sem esperar o Whisper) */
export function blockSpeech(data: MontageData, b: InstructionBlock) {
  const speech = new Set(speechFiles(data).map((f) => f.path))
  const media = new Map(data.media.map((m) => [m.id, m]))
  return [...new Set(audioIn(data, b).map((c) => media.get(c.media)!.path))].filter((p) => speech.has(p))
}

/**
 * Transcreve (Whisper, na fila com cache por arquivo) e devolve só as palavras que caem dentro do bloco.
 * `onWait` conta como vai a leitura; `signal` para de esperar (a leitura continua na fila e fica guardada).
 */
export async function heardIn(
  data: MontageData,
  b: InstructionBlock,
  lang: string,
  opts: { signal?: AbortSignal; onWait?: (label: string, pct: number | null) => void } = {}
): Promise<{ words: HeardWord[]; error?: string }> {
  const clips = audioIn(data, b)
  const media = new Map(data.media.map((m) => [m.id, m]))
  const words: HeardWord[] = []
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

// ---------- o vídeo que está embaixo do bloco ----------
/** a timeline só com as faixas de vídeo do bloco pra baixo (a primeira faixa da lista é a de cima) */
function belowMontage(data: MontageData, b: InstructionBlock): MontageData {
  const vids = data.tracks.filter((t) => t.kind === 'video')
  const at = vids.findIndex((t) => t.id === b.track)
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
  under?: UnderInfo | null
  /** ajuste em cima da prévia atual: o HTML dela e os pedidos (o último é o novo) */
  adjust?: { html: string; tweaks: { text: string; names: string[] }[] }
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
  L.push('## O que é falado neste trecho (tempos a partir do começo do bloco)')
  if (!o.hasAudio) L.push('(não há áudio neste trecho: o motion carrega o momento sozinho)')
  else if (o.heard.length) L.push(phrases(o.heard))
  else L.push(o.heardError ? `(não deu pra transcrever: ${o.heardError})` : '(só silêncio ou música)')
  if (o.scriptHere.length) L.push('', 'Falas do roteiro que caem aqui (use pra acertar nomes e termos; a fala gravada manda, inclusive improvisos):', ...o.scriptHere.map((s) => '> ' + s))
  L.push('')
  if (o.falas) L.push('## Roteiro do vídeo (só as falas, pra entender o tema)', o.falas.slice(0, 12000), '')
  L.push('## Direção de motion', MOTION_DIRECTION, syncDirection(blockSync(b)), '')
  const guide = o.format?.motion?.learned?.guide
  if (guide) L.push('## Guia de estilo do formato', guide, '')
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
export async function generatePreview(c: PreviewCtx) {
  const b = c.block
  const hasAudio = audioIn(c.data, b).length > 0
  let heard: { words: HeardWord[]; error?: string } = { words: [] }
  if (hasAudio) {
    c.onStage('Ouvindo o trecho (Whisper)…', null)
    heard = await heardIn(c.data, b, c.lang, { signal: c.signal, onWait: c.onStage })
  }
  if (c.signal?.aborted) throw new Error('Cancelado.')
  const files = b.attachments.filter(isImage).map((a, i) => ({ a, name: attachName(a, i) }))
  const size = previewSize(c.format)
  c.onStage('Olhando o vídeo embaixo do bloco…', null)
  const under = await underFor(c.data, b, c.dir, size, true)
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
  const prompt = blockPrompt({
    block: b,
    format: c.format,
    heard: heard.words,
    heardError: heard.error,
    hasAudio,
    scriptHere: scriptIn(c.data, b, c.script),
    falas: scriptFalas(c.script),
    files,
    size,
    under,
    adjust
  })
  c.onStage(adjust ? 'Claude ajustando o motion…' : 'Claude criando o motion…', null)
  const r = await api.motionTrain({ prompt, images: [...files.map((f) => absPath(f.a)), ...(under?.frames.map((f) => f.path) ?? []), ...tf.flat().map((f) => absPath(f.a))] })
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
    files: [
      ...files.filter((f) => f.a.use === 'insert').map((f) => ({ src: absPath(f.a), name: f.name })),
      ...tf.flat().map((f) => ({ src: absPath(f.a), name: f.name })),
      ...(under ? [{ src: under.video, name: UNDER_NAME }] : [])
    ]
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

/**
 * Clipe final do bloco: o HTML da prévia aprovada gravado de novo na resolução do projeto (30 fps),
 * ampliado com zoom (a composição fica igual à que foi aprovada), com o áudio do trecho.
 */
export async function generateClip(c: Omit<PreviewCtx, 'script' | 'lang'>) {
  const b = c.block
  if (!b.preview) throw new Error('Gere a prévia antes de aprovar.')
  const files = b.attachments.filter(isImage).map((a, i) => ({ a, name: attachName(a, i) }))
  const small = previewSize(c.format)
  const size = projectSize(c.format)
  const hasAudio = audioIn(c.data, b).length > 0
  // o vídeo de baixo de novo, agora na resolução do clipe (a animação usa ele pelo nome)
  const html = await fetch(fileUrl(b.preview.html))
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '')
  let under: UnderInfo | null = null
  if (html.includes(UNDER_NAME)) {
    c.onStage('Recortando o vídeo de baixo…', null)
    under = await underFor(c.data, b, c.dir, size, false)
  }
  c.onStage('Mixando o áudio do trecho…', null)
  const wav = hasAudio ? await rangeWav(c.engine, c.data, c.dur, b.start, b.end).catch(() => undefined) : undefined
  c.onStage(`Gravando o clipe em ${size.w}×${size.h}…`, 0)
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
      ...(under ? [{ src: under.video, name: UNDER_NAME }] : [])
    ]
  })
  if ('error' in v) throw new Error(v.error)
  return v.video
}
