import { api, clipEndT, uid, type MontageClip, type MontageData, type ShortClip, type ShortTarget } from '../lib'
import { planRender, timelineEnd } from '../render/plan'
import { runningLabel, watchJobs } from '../montage/transcripts'

/**
 * Criar Clipes: lê a transcrição da narração (Whisper, com cache por arquivo), pede pro Claude os
 * melhores trechos pra recortes curtos e monta uma timeline própria pra cada um, a partir da
 * timeline de montagem.
 */

/** palavra falada, com o tempo na timeline de montagem (s) */
export interface TlWord {
  s: number
  e: number
  w: string
}

/** cortes que tocam a narração no vídeo: faixas de áudio ligadas, da pasta Narração ou do corte automático */
function narrationClips(m: MontageData): MontageClip[] {
  const binById = new Map(m.bins.map((b) => [b.id, b]))
  const roleOf = (id: string) => {
    let cur = binById.get(id)
    for (let i = 0; cur?.parent && i < 20; i++) cur = binById.get(cur.parent)
    return cur?.role
  }
  const media = new Map(m.media.map((x) => [x.id, x]))
  const muted = new Set(m.tracks.filter((t) => t.muted).map((t) => t.id))
  const audio = new Set(m.tracks.filter((t) => t.kind === 'audio').map((t) => t.id))
  const live = m.clips.filter((c) => !muted.has(c.track) && !c.audioOff && media.get(c.media)?.hasAudio)
  const narr = live.filter((c) => audio.has(c.track) && (c.block !== undefined || roleOf(media.get(c.media)?.bin ?? '') === 'narration'))
  // sem pasta de narração (ex.: talking head direto na faixa de vídeo): qualquer corte com voz
  return (narr.length ? narr : live.filter((c) => roleOf(media.get(c.media)?.bin ?? '') !== 'sfx')).sort((a, b) => a.start - b.start)
}

/** o que é falado no vídeo, palavra por palavra, no tempo da timeline */
export async function timelineWords(m: MontageData, lang: string, onStep?: (label: string) => void): Promise<TlWord[] | { error: string }> {
  const clips = narrationClips(m)
  if (!clips.length) return { error: 'Não há narração na timeline de montagem pra ler.' }
  const media = new Map(m.media.map((x) => [x.id, x]))
  const byPath = new Map<string, TlWord[]>()
  const paths = [...new Set(clips.map((c) => media.get(c.media)!.path))]
  for (const [i, p] of paths.entries()) {
    const step = () => {
      const j = runningLabel(p, lang)
      onStep?.(`Lendo a transcrição (${i + 1}/${paths.length})${j ? ': ' + j : '…'}`)
    }
    step()
    const stop = watchJobs(step)
    const r = await api.transcribe(p, lang).finally(stop)
    if ('error' in r) return r
    byPath.set(p, r.words)
  }
  const out: TlWord[] = []
  for (const c of clips) {
    for (const w of byPath.get(media.get(c.media)!.path) ?? []) {
      const mid = (w.s + w.e) / 2
      if (mid < c.in || mid >= c.out) continue
      out.push({ s: c.start + Math.max(0, w.s - c.in), e: c.start + Math.min(c.out, w.e) - c.in, w: w.w })
    }
  }
  return out.sort((a, b) => a.s - b.s)
}

const ts = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

/** transcrição em linhas com tempo ("[1:02.3] texto"), quebrando nas pausas e no fim das frases */
export function transcriptText(words: TlWord[]) {
  const lines: string[] = []
  let cur: TlWord[] = []
  const flush = () => {
    if (!cur.length) return
    lines.push(`[${ts(cur[0].s)}–${ts(cur[cur.length - 1].e)}] ${cur.map((w) => w.w).join(' ')}`)
    cur = []
  }
  words.forEach((w, i) => {
    const gap = i > 0 ? w.s - words[i - 1].e : 0
    if (cur.length && (gap > 0.7 || cur.length >= 28)) flush()
    cur.push(w)
    if (/[.!?…]["”')]*$/.test(w.w) && cur.length >= 6) flush()
  })
  flush()
  return lines.join('\n')
}

const endsSentence = (w: string) => /[.!?…]["”')]*$/.test(w)

/**
 * Ajusta o trecho sugerido às palavras: começa no começo de uma palavra, termina no fim de outra,
 * mira o tempo ideal e só passa dele (até o máximo) pra fechar a frase.
 */
export function snapRange(words: TlWord[], from: number, to: number, t: ShortTarget): { from: number; to: number } | null {
  if (!words.length) return null
  let a = words.findIndex((w) => w.e > from + 0.05)
  if (a < 0) return null
  // a palavra mais perto do começo pedido
  if (a > 0 && Math.abs(words[a - 1].s - from) < Math.abs(words[a].s - from)) a--
  let b = -1
  for (let i = a; i < words.length && words[i].s < to - 0.05; i++) b = i
  if (b < a) b = a
  const dur = (i: number) => words[i].e - words[a].s
  // passou do máximo: volta até o fim de frase mais perto do ideal (ou a última palavra que cabe)
  if (dur(b) > t.max) {
    let fit = a
    for (let i = a; i <= b && dur(i) <= t.max; i++) fit = i
    let best = -1
    for (let i = a; i <= fit; i++) if (endsSentence(words[i].w) && dur(i) >= t.min && (best < 0 || Math.abs(dur(i) - t.ideal) < Math.abs(dur(best) - t.ideal))) best = i
    b = best >= 0 ? best : fit
  }
  // curto demais: estica até fechar uma frase depois do mínimo, sem passar do máximo
  if (dur(b) < t.min) {
    for (let i = b + 1; i < words.length && dur(i) <= t.max; i++) {
      b = i
      if (dur(i) >= t.min && endsSentence(words[i].w)) break
    }
  }
  // folga: um respiro antes e depois da fala, sem pegar a palavra vizinha
  const prevEnd = a > 0 ? words[a - 1].e : 0
  const nextStart = b + 1 < words.length ? words[b + 1].s : Infinity
  const s = Math.max(prevEnd + 0.02, words[a].s - 0.15, 0)
  const e = Math.min(nextStart - 0.04, words[b].e + 0.35)
  return { from: r3(Math.min(s, words[a].s)), to: r3(Math.max(e, words[b].e)) }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

/** a timeline do recorte: o trecho [from, to] da montagem, começando em 0 */
export function sliceMontage(m: MontageData, from: number, to: number): MontageData {
  const audioTracks = new Set(m.tracks.filter((t) => t.kind === 'audio').map((t) => t.id))
  const media = new Map(m.media.map((x) => [x.id, x]))
  const clips: MontageClip[] = []
  for (const c of m.clips) {
    const s = c.start
    const e = clipEndT(c)
    if (e <= from + 0.001 || s >= to - 0.001) continue
    const ns = Math.max(s, from)
    const ne = Math.min(e, to)
    const cutHead = ns > s + 0.001
    const cutTail = ne < e - 0.001
    const inn = c.in + (ns - s)
    const voice = audioTracks.has(c.track) || !!media.get(c.media)?.hasAudio
    clips.push({
      ...c,
      id: uid(),
      start: r3(ns - from),
      in: r3(inn),
      out: r3(inn + (ne - ns)),
      // nas bordas do recorte entra um fade curtinho (sem estalo); o crossfade com o vizinho de fora some
      splice: cutHead || s <= from + 0.001 ? undefined : c.splice,
      fadeIn: cutHead ? (voice ? 0.04 : undefined) : c.fadeIn,
      fadeInCurve: cutHead ? undefined : c.fadeInCurve,
      fadeOut: cutTail ? (voice ? 0.08 : undefined) : c.fadeOut,
      fadeOutCurve: cutTail ? undefined : c.fadeOutCurve
    })
  }
  return {
    ...m,
    clips,
    // letterings de capítulo e blocos de instrução são do vídeo longo
    markers: [],
    blocks: []
  }
}

/** pedido pro Claude: os melhores trechos, em JSON */
export function suggestPrompt(t: ShortTarget, total: number) {
  const max = Math.max(1, Math.min(15, Math.floor(total / Math.max(15, t.ideal))))
  return [
    'Você é editor de vídeos curtos (Reels, TikTok, YouTube Shorts). Abaixo está a transcrição de um vídeo longo, com o tempo de cada trecho [início–fim] em minutos:segundos.',
    `Escolha os melhores trechos pra virar recortes curtos (até ${max}, só os que realmente funcionam sozinhos), do mais forte pro mais fraco.`,
    'Regras de cada recorte:',
    `- Duração: mire sempre em ${t.ideal} s. Nunca menos que ${t.min} s.`,
    `- Pode passar do ideal (até ${t.max} s, nunca mais) só quando precisa pra não cortar um assunto no meio: uma lógica sem a conclusão, uma explicação que termina num corte seco, uma pergunta sem a resposta, uma piada sem o fim.`,
    '- Começa no começo de uma frase, de preferência com um gancho forte nos primeiros 3 segundos (uma afirmação surpreendente, uma pergunta, um conflito). Nada de começar com "e aí", "então", "como eu falei".',
    '- Termina no fim de uma frase, com a ideia fechada.',
    '- Faz sentido sozinho, pra quem não viu o vídeo longo (sem depender de "isso que eu mostrei antes").',
    '- Recortes não se sobrepõem.',
    'Responda só com JSON, sem texto antes ou depois, neste formato (tempos em segundos desde o começo do vídeo, tirados da transcrição):',
    '{"clips":[{"title":"título curto e chamativo","start":12.3,"end":58.1,"reason":"por que esse trecho funciona, em uma frase"}]}'
  ].join('\n')
}

/** lê o JSON da resposta (tolera texto ou ```json em volta) */
export function parseSuggestions(text: string): { title: string; start: number; end: number; reason: string }[] {
  const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  let j: any
  try {
    j = JSON.parse(body)
  } catch {
    return []
  }
  const list = Array.isArray(j) ? j : Array.isArray(j?.clips) ? j.clips : []
  return list
    .map((c: any) => ({ title: String(c?.title ?? '').trim(), start: Number(c?.start), end: Number(c?.end), reason: String(c?.reason ?? '').trim() }))
    .filter((c: any) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
}

/** sugestões → recortes prontos (com a timeline de cada um) */
export function buildShorts(m: MontageData, words: TlWord[], list: ReturnType<typeof parseSuggestions>, t: ShortTarget): ShortClip[] {
  const out: ShortClip[] = []
  for (const c of list) {
    const r = snapRange(words, c.start, c.end, t)
    if (!r || r.to - r.from < 3) continue
    // não repete um trecho que já entrou
    if (out.some((o) => Math.min(o.to, r.to) - Math.max(o.from, r.from) > (r.to - r.from) * 0.5)) continue
    out.push({ id: uid(), title: c.title || `Recorte ${out.length + 1}`, reason: c.reason, from: r.from, to: r.to, montage: sliceMontage(m, r.from, r.to) })
  }
  return out
}

export const shortDuration = (s: ShortClip) => timelineEnd(s.montage)

/** impressão digital do que vai no export do recorte (só o conteúdo da timeline) */
export function shortKey(s: ShortClip) {
  const plan = planRender(s.montage, { from: 0, to: Infinity, width: 1080, height: 1920, fps: 30 })
  const str = plan.parts.map((p) => p.key).join('|')
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0
  return h.toString(36) + '-' + str.length.toString(36)
}

/** nome de arquivo seguro a partir do título */
export const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'recorte'
