import { uid, type MontageClip, type MontageData, type MontageMedia } from '../lib'

/**
 * Corte automático: acha cada frase do roteiro na narração gravada (pela transcrição),
 * fica com a ÚLTIMA tomada boa (quem grava repete a frase até acertar) e corta nos silêncios.
 */

export interface ScriptBlock {
  index: number
  type: string
  text: string
  /** pausa / sobe som: tempo parado no vídeo */
  seconds?: number
}
export interface Word {
  s: number
  e: number
  w: string
}
export interface Take {
  media: MontageMedia
  words: Word[]
  silences: [number, number][]
}

// ---------- normalização ----------
const UNITS = ['zero', 'um', 'dois', 'tres', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove']
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa']
const HUND = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos']

function under1000(n: number): string[] {
  if (n === 100) return ['cem']
  const out: string[] = []
  if (n >= 100) {
    out.push(HUND[Math.floor(n / 100)])
    n %= 100
    if (n) out.push('e')
  }
  if (n >= 20) {
    out.push(TENS[Math.floor(n / 10)])
    if (n % 10) out.push('e', UNITS[n % 10])
  } else if (n || !out.length) out.push(UNITS[n])
  return out
}

/** "2026" → dois mil e vinte e seis (o Whisper às vezes escreve número, o roteiro por extenso, ou o contrário) */
export function numberWords(n: number): string[] {
  if (!Number.isFinite(n) || n < 0 || n >= 1e9) return [String(n)]
  if (n < 1000) return under1000(n)
  const out: string[] = []
  const mi = Math.floor(n / 1e6)
  const th = Math.floor((n % 1e6) / 1000)
  const rest = n % 1000
  if (mi) out.push(...(mi === 1 ? ['um', 'milhao'] : [...under1000(mi), 'milhoes']))
  if (th) {
    if (out.length) out.push('e')
    out.push(...(th === 1 ? ['mil'] : [...under1000(th), 'mil']))
  }
  if (rest) {
    out.push('e')
    out.push(...under1000(rest))
  }
  return out
}

export function tokens(text: string): string[] {
  const out: string[] = []
  const clean = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/(\d)[.,](\d{3})\b/g, '$1$2')
  for (const raw of clean.split(/[^a-z0-9%]+/)) {
    if (!raw) continue
    if (/^\d+$/.test(raw)) out.push(...numberWords(Number(raw)))
    else if (/^\d+%$/.test(raw)) out.push(...numberWords(Number(raw.slice(0, -1))), 'por', 'cento')
    else out.push(raw)
  }
  return out
}

function similar(a: string, b: string) {
  if (a === b) return 1
  if (Math.min(a.length, b.length) < 4) return 0
  const m = a.length
  const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return 1 - prev[n] / Math.max(m, n)
}

const score = (a: string, b: string) => {
  if (a === b) return 2
  return similar(a, b) >= 0.75 ? 1 : -1
}

// ---------- alinhamento ----------
/** palavra da transcrição já normalizada, com de onde veio */
interface TWord {
  tok: string
  take: number
  word: Word
}

interface Match {
  from: number
  to: number
  score: number
}

/**
 * A frase inteira (B) contra um pedaço livre da transcrição (T): global em B, local em T.
 * Devolve os finais possíveis com a pontuação, do começo ao fim da gravação.
 */
function candidates(B: string[], T: TWord[]): Match[] {
  const n = B.length
  const m = T.length
  let D = new Float32Array(m + 1)
  let S = new Int32Array(m + 1)
  for (let j = 0; j <= m; j++) S[j] = j
  for (let i = 1; i <= n; i++) {
    const D2 = new Float32Array(m + 1)
    const S2 = new Int32Array(m + 1)
    D2[0] = -i
    S2[0] = 0
    for (let j = 1; j <= m; j++) {
      // não deixa uma frase atravessar de um arquivo pro outro
      const cross = j > 1 && T[j - 1].take !== T[j - 2].take
      const diag = D[j - 1] + score(B[i - 1], T[j - 1].tok) - (cross && i > 1 ? 50 : 0)
      const up = D[j] - 1
      const left = D2[j - 1] - 1 - (cross ? 50 : 0)
      if (diag >= up && diag >= left) {
        D2[j] = diag
        S2[j] = S[j - 1]
      } else if (up >= left) {
        D2[j] = up
        S2[j] = S[j]
      } else {
        D2[j] = left
        S2[j] = S2[j - 1]
      }
    }
    D = D2
    S = S2
  }
  const out: Match[] = []
  const min = 0.45 * 2 * n
  for (let j = 1; j <= m; j++) {
    // só picos locais (senão vira uma escadinha de quase-iguais)
    if (D[j] < min || (j < m && D[j + 1] > D[j]) || (j > 1 && D[j - 1] >= D[j])) continue
    out.push({ from: S[j], to: j, score: D[j] / (2 * n) })
  }
  return out
}

/** frases de um parágrafo (cada uma vira um corte: dá pra pegar tomadas diferentes por frase) */
export function sentences(text: string): string[] {
  return (text.match(/[^.!?…]+[.!?…]*["”')]*\s*/g) ?? [text]).map((s) => s.trim()).filter((s) => tokens(s).length > 0)
}

export interface AutoCutResult {
  data: MontageData
  found: number
  missing: string[]
  /** frases encontradas mais de uma vez (ficou a última) */
  retakes: number
}

export function autoCut(blocks: ScriptBlock[], takes: Take[], base: MontageData): AutoCutResult {
  const T: TWord[] = []
  takes.forEach((t, ti) => {
    for (const w of t.words) for (const tok of tokens(w.w)) T.push({ tok, take: ti, word: w })
  })

  const used: [number, number][] = []
  const overlaps = (a: number, b: number) => used.some(([x, y]) => a < y && b > x)

  interface Piece {
    block: number
    take: number
    s: number
    e: number
  }
  type Step = Piece | { gap: number }
  const steps: Step[] = []
  const missing: string[] = []
  let found = 0
  let retakes = 0

  for (const b of blocks) {
    if (b.type === 'sonora' || b.type === 'soundUp') {
      if (b.seconds) steps.push({ gap: b.seconds })
      continue
    }
    if (b.type !== 'paragraph' || !b.text.trim()) continue
    for (const sen of sentences(b.text)) {
      const B = tokens(sen)
      const cands = candidates(B, T).filter((c) => !overlaps(c.from, c.to))
      if (!cands.length) {
        missing.push(sen)
        continue
      }
      const best = Math.max(...cands.map((c) => c.score))
      // a última tomada que está quase tão boa quanto a melhor
      const good = cands.filter((c) => c.score >= best - 0.12)
      if (good.length > 1) retakes++
      const pick = good[good.length - 1]
      used.push([pick.from, pick.to])
      const first = T[pick.from]
      const last = T[pick.to - 1]
      steps.push({ block: b.index, take: first.take, s: first.word.s, e: last.word.e })
      found++
    }
  }

  // ---------- monta a timeline ----------
  const snapStart = (t: Take, s: number) => {
    let best: number | null = null
    for (const [a, b] of t.silences) if (b <= s + 0.15 && b >= s - 1) best = Math.max(best ?? -1, Math.max(a, b - 0.06))
    return Math.max(0, best ?? s - 0.06)
  }
  const snapEnd = (t: Take, wordStart: number, e: number) => {
    let best: number | null = null
    for (const [a, b] of t.silences) if (a >= wordStart + 0.1 && a <= e + 0.6) best = Math.min(best ?? Infinity, Math.min(a + 0.1, b))
    return Math.min(t.media.duration || Infinity, best ?? e + 0.08)
  }

  const touched = new Set(takes.map((t) => t.media.id))
  // cortes automáticos antigos dessas mídias saem; o que foi posto à mão fica
  const kept = base.clips.filter((c) => !(c.block !== undefined && touched.has(c.media)))
  const trackFor = (m: MontageMedia) => base.tracks.find((t) => t.kind === (m.kind === 'audio' ? 'audio' : 'video'))?.id ?? base.tracks[0].id
  const splice = base.spliceDefault ?? 0.02

  const clips: MontageClip[] = []
  let cursor = 0
  let prevTrack: string | null = null
  let afterGap = true
  for (const st of steps) {
    if ('gap' in st) {
      cursor += st.gap
      afterGap = true
      continue
    }
    const t = takes[st.take]
    // a última palavra começa onde? (pra achar o silêncio depois dela)
    const lastWordStart = T.filter((w) => w.take === st.take && w.word.e === st.e).pop()?.word.s ?? st.s
    const a = snapStart(t, st.s)
    const z = Math.max(a + 0.1, snapEnd(t, lastWordStart, st.e))
    const track = trackFor(t.media)
    clips.push({
      id: uid(),
      track,
      media: t.media.id,
      start: cursor,
      in: a,
      out: z,
      block: st.block,
      splice: !afterGap && prevTrack === track ? splice : undefined
    })
    cursor += z - a
    prevTrack = track
    afterGap = false
  }

  return { data: { ...base, clips: [...kept, ...clips] }, found, missing, retakes }
}
