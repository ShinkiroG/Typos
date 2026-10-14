import { uid, type MontageClip, type MontageData } from '../lib'
import { PEAKS_PER_SEC } from './engine'

/**
 * Corte por silêncio (igual ao "remover silêncio" do Premiere): olha a onda que já está
 * carregada, acha os trechos abaixo do limiar e deixa só a fala, colada. Não transcreve nada,
 * então é instantâneo.
 */
export interface SilenceOpts {
  /** abaixo disso (dBFS) é silêncio */
  threshold: number
  /** silêncio mais curto que isso fica (respiração entre palavras) */
  minSilence: number
  /** folga antes/depois de cada trecho falado (s) */
  pad: number
  /** som mais curto que isso entre silêncios é ruído (estalo, clique) e sai junto (s) */
  minVoice?: number
}

export const SILENCE_DEFAULT: SilenceOpts = { threshold: -40, minSilence: 0.35, pad: 0.12, minVoice: 0.05 }

/** trechos com som [início, fim] (s, no arquivo) dentro de in→out */
export function voicedRanges(peaks: Float32Array, from: number, to: number, o: SilenceOpts): [number, number][] {
  const lim = Math.pow(10, o.threshold / 20)
  const i0 = Math.max(0, Math.floor(from * PEAKS_PER_SEC))
  const i1 = Math.min(peaks.length, Math.ceil(to * PEAKS_PER_SEC))
  const minRun = Math.max(1, Math.round(o.minSilence * PEAKS_PER_SEC))
  const out: [number, number][] = []
  let voiceStart: number | null = null
  let quiet = 0
  for (let i = i0; i < i1; i++) {
    if (peaks[i] >= lim) {
      if (voiceStart === null) voiceStart = i
      quiet = 0
    } else if (voiceStart !== null) {
      quiet++
      if (quiet >= minRun) {
        out.push([voiceStart / PEAKS_PER_SEC, (i - quiet + 1) / PEAKS_PER_SEC])
        voiceStart = null
        quiet = 0
      }
    }
  }
  if (voiceStart !== null) out.push([voiceStart / PEAKS_PER_SEC, (i1 - quiet) / PEAKS_PER_SEC])
  // folga e junta o que encostar
  const padded: [number, number][] = []
  for (const [a, b] of out) {
    const s = Math.max(from, a - o.pad)
    const e = Math.min(to, b + o.pad)
    const last = padded[padded.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else if (e - s >= Math.max(0.05, o.minVoice ?? 0.05)) padded.push([s, e])
  }
  return padded
}

/**
 * Corta os silêncios dos clipes de origem e põe o resultado colado na faixa de destino,
 * a partir do começo do primeiro, com crossfade em cada junção.
 */
export function silenceCut(
  data: MontageData,
  sources: MontageClip[],
  dest: string,
  peaksOf: (mediaId: string) => Float32Array | undefined,
  o: SilenceOpts
): { clips: MontageClip[]; removed: number } {
  const splice = data.spliceDefault ?? 0.02
  const ordered = [...sources].sort((a, b) => a.start - b.start)
  const out: MontageClip[] = []
  let cursor = ordered.length ? ordered[0].start : 0
  let removed = 0
  for (const c of ordered) {
    const peaks = peaksOf(c.media)
    const ranges = peaks ? voicedRanges(peaks, c.in, c.out, o) : [[c.in, c.out] as [number, number]]
    let kept = 0
    ranges.forEach(([a, b], i) => {
      out.push({
        ...c,
        id: uid(),
        track: dest,
        start: cursor,
        in: a,
        out: b,
        fadeIn: i === 0 ? c.fadeIn : 0,
        fadeOut: i === ranges.length - 1 ? c.fadeOut : 0,
        splice: out.length ? splice : undefined
      })
      cursor += b - a
      kept += b - a
    })
    removed += c.out - c.in - kept
  }
  return { clips: out, removed }
}


type Src = Pick<MontageClip, 'media' | 'in' | 'out'>

/** quanto o corte tiraria com esses ajustes (pra calibrar antes de cortar) */
export function silenceStats(sources: Src[], peaksOf: (mediaId: string) => Float32Array | undefined, o: SilenceOpts) {
  let total = 0
  let kept = 0
  let pieces = 0
  for (const c of sources) {
    const peaks = peaksOf(c.media)
    if (!peaks) continue
    total += c.out - c.in
    for (const [a, b] of voicedRanges(peaks, c.in, c.out, o)) {
      kept += b - a
      pieces++
    }
  }
  return { total, kept, removed: total - kept, pieces }
}

/**
 * Limiar sugerido: mede o chão de ruído (os 15% mais baixos) e o nível da fala (os 10% mais altos)
 * e põe o corte a um terço do caminho entre os dois, acima do ruído.
 */
export function suggestThreshold(sources: Src[], peaksOf: (mediaId: string) => Float32Array | undefined): number | null {
  const db: number[] = []
  for (const c of sources) {
    const peaks = peaksOf(c.media)
    if (!peaks) continue
    const i0 = Math.max(0, Math.floor(c.in * PEAKS_PER_SEC))
    const i1 = Math.min(peaks.length, Math.ceil(c.out * PEAKS_PER_SEC))
    const step = Math.max(1, Math.floor((i1 - i0) / 20000))
    for (let i = i0; i < i1; i += step) db.push(20 * Math.log10(Math.max(1e-5, peaks[i])))
  }
  if (db.length < 20) return null
  db.sort((a, b) => a - b)
  const noise = db[Math.floor(db.length * 0.15)]
  const speech = db[Math.floor(db.length * 0.9)]
  const t = noise + (speech - noise) / 3
  return Math.round(Math.max(-60, Math.min(-20, t)))
}
