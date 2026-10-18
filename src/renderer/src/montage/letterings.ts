import { type InstructionBlock, type MontageData, type MontageMarker } from '../lib'
import { BLOCK_MIN } from './blocks'
import { voicedRanges, type SilenceOpts } from './silence'

/**
 * Lettering de capítulo é a transição: entra no silêncio entre um capítulo e outro, cobre a tela
 * inteira e corta os blocos de instrução. O bloco que passa por ele termina onde o lettering
 * começa e continua (um bloco novo, com as mesmas instruções) onde ele acaba.
 */

const EPS = 0.01

const letteringsOf = (d: MontageData) =>
  (d.markers ?? []).filter((m): m is MontageMarker => m.kind === 'lettering' && m.dur > 0).sort((a, b) => a.t - b.t)

/** recorta os blocos em volta dos letterings; blocos aprovados (o motion já virou clipe) ficam como estão */
export function fitBlocksToLetterings(data: MontageData): MontageData {
  const marks = letteringsOf(data)
  const blocks = data.blocks ?? []
  if (!marks.length || !blocks.length) return data
  const ids = new Set(blocks.map((b) => b.id))
  let changed = false
  const out: InstructionBlock[] = []
  for (const b of blocks) {
    if (b.approved) {
      out.push(b)
      continue
    }
    let pieces = [b]
    for (const m of marks) {
      const m0 = m.t
      const m1 = m.t + m.dur
      pieces = pieces.flatMap((p) => {
        // não encosta, ou fica inteiro embaixo do lettering (aí não tem o que sobrar)
        if (p.end <= m0 + EPS || p.start >= m1 - EPS) return [p]
        if (p.start >= m0 - EPS && p.end <= m1 + EPS) return [p]
        const left = m0 - p.start >= BLOCK_MIN ? { ...p, end: m0, toNext: false } : null
        let right: InstructionBlock | null = null
        if (p.end - m1 >= BLOCK_MIN) {
          let id = p.id
          if (left) {
            // id estável (o arrasto recalcula a partir do original a cada passo)
            id = `${p.id}-${m.id}`
            while (ids.has(id)) id += '+'
            ids.add(id)
          }
          right = left ? { ...p, id, start: m1, fromPrev: false, preview: undefined, approved: false } : { ...p, start: m1, fromPrev: false }
        }
        if (!left && !right) return [p]
        changed = true
        return [left, right].filter((x): x is InstructionBlock => !!x)
      })
    }
    out.push(...pieces)
  }
  return changed ? { ...data, blocks: out } : data
}

/** os blocos mudaram de lugar ou de tamanho (texto e anexos não contam) */
const timing = (d: MontageData) => (d.blocks ?? []).map((b) => `${b.id}:${b.track}:${b.start}:${b.end}`).join('|')
export const blocksMoved = (a: MontageData, b: MontageData) => a.blocks !== b.blocks && timing(a) !== timing(b)

/**
 * Silêncios da timeline: onde nenhuma faixa de áudio ligada tem fala. Usa a onda quando ela já
 * carregou (silêncio dentro do corte) e os vãos entre os cortes. [início, fim] em segundos.
 */
export function timelineSilences(
  data: MontageData,
  peaksOf: (mediaId: string) => Float32Array | undefined,
  o: SilenceOpts
): [number, number][] {
  const audio = new Set(data.tracks.filter((t) => t.kind === 'audio' && !t.muted).map((t) => t.id))
  const media = new Map(data.media.map((m) => [m.id, m]))
  const voiced: [number, number][] = []
  for (const c of data.clips) {
    if (!audio.has(c.track) || c.audioOff || media.get(c.media)?.hasAudio === false) continue
    const peaks = peaksOf(c.media)
    const ranges = peaks ? voicedRanges(peaks, c.in, c.out, o) : [[c.in, c.out] as [number, number]]
    for (const [a, b] of ranges) voiced.push([c.start + a - c.in, c.start + b - c.in])
  }
  if (!voiced.length) return []
  voiced.sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  let end = voiced[0][1]
  for (const [a, b] of voiced.slice(1)) {
    if (a - end >= o.minSilence) out.push([end, a])
    end = Math.max(end, b)
  }
  return out
}

/** onde o lettering entra: no começo do silêncio em que t cai, ou do mais perto (até `max` s); sem silêncio perto, t */
export function silenceStart(t: number, silences: [number, number][], max = 2) {
  const inside = silences.find(([a, b]) => t >= a - EPS && t <= b + EPS)
  if (inside) return inside[0]
  let best = t
  let bestD = max
  for (const [a, b] of silences) {
    const d = Math.min(Math.abs(a - t), Math.abs(b - t))
    if (d < bestD) {
      best = a
      bestD = d
    }
  }
  return best
}

