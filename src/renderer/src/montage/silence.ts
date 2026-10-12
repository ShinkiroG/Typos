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
}

export const SILENCE_DEFAULT: SilenceOpts = { threshold: -40, minSilence: 0.35, pad: 0.12 }

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
    else if (e - s >= 0.05) padded.push([s, e])
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

