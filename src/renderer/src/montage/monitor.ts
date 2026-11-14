import { type MontageData, type MontageMarker } from '../lib'
import { spans, type Span } from './engine'
import { layerCover } from '../render/plan'

/**
 * O que o visualizador da Montagem mostra num instante: as mesmas camadas que o render compõe (faixa de
 * cima cobre as de baixo, fades e crossfades com a mesma conta), em vez de só o corte da faixa mais de
 * cima. Assim um fade, um crossfade ou um motion com transparência aparecem na Montagem como saem no vídeo.
 */

export interface PicLayer {
  /** id do corte (a vaga do visualizador segue o corte enquanto ele está na tela) */
  id: string
  path: string
  image: boolean
  /** ponto do arquivo (s) que corresponde ao instante pedido */
  src: number
  /** 0..1 */
  opacity: number
}

type MediaMap = Map<string, MontageData['media'][number]>
const mediaLen = (m?: MontageData['media'][number]) => (!m ? 0 : m.kind === 'image' ? 3600 : m.duration)

/** os trechos de vídeo da timeline, de baixo pra cima (refeito só quando a montagem muda) */
const cache = new WeakMap<MontageData, { s: Span; z: number }[]>()
function videoSpans(data: MontageData, media: MediaMap) {
  let list = cache.get(data)
  if (!list) {
    // a primeira faixa da lista é a de cima
    const tracks = data.tracks.filter((t) => t.kind === 'video' && !t.muted)
    const z = new Map(tracks.map((t, i) => [t.id, tracks.length - i]))
    list = spans(data, (id) => mediaLen(media.get(id)))
      .filter((s) => z.has(s.clip.track))
      .filter((s) => {
        const m = media.get(s.clip.media)
        return !!m && (m.kind === 'image' || (m.kind === 'video' && m.hasVideo))
      })
      .map((s) => ({ s, z: z.get(s.clip.track)! }))
      .sort((a, b) => a.z - b.z || a.s.t0 - b.s.t0)
    cache.set(data, list)
  }
  return list
}

/** opacidade do trecho no instante t (a mesma conta do render: crossfade entra por cima, fades lineares) */
export function spanOpacity(s: Span, t: number) {
  const fadeIn = s.xIn ? 2 * s.xIn : (s.clip.fadeIn ?? 0)
  const fadeOut = s.xOut ? 0 : (s.clip.fadeOut ?? 0)
  let v = 1
  if (fadeIn > 0) v = Math.min(v, (t - s.t0) / fadeIn)
  if (fadeOut > 0) v = Math.min(v, (s.t1 - t) / fadeOut)
  return Math.max(0, Math.min(1, v))
}

/**
 * Camadas visíveis em t, de baixo pra cima. Para de descer quando acha uma camada inteira que cobre o
 * quadro (o que está embaixo dela não aparece) e fica com no máximo `max` (as de cima).
 */
export function pictureLayers(data: MontageData, media: MediaMap, t: number, frame: { width: number; height: number; fit?: 'contain' | 'cover' }, max = 3): PicLayer[] {
  const out: PicLayer[] = []
  const list = videoSpans(data, media)
  for (let i = list.length - 1; i >= 0 && out.length < max; i--) {
    const { s } = list[i]
    if (s.t0 > t || s.t1 <= t) continue
    const m = media.get(s.clip.media)!
    const opacity = spanOpacity(s, t)
    if (opacity <= 0.001) continue
    out.unshift({ id: s.clip.id, path: m.path, image: m.kind === 'image', src: s.src0 + (t - s.t0), opacity })
    if (opacity >= 0.999 && layerCover(m, frame).covers) break
  }
  return out
}

/** o próximo corte de vídeo que entra em até `within` s (pra vaga livre já ir carregando o arquivo) */
export function nextPicture(data: MontageData, media: MediaMap, t: number, within = 1): PicLayer | null {
  let best: Span | null = null
  for (const { s } of videoSpans(data, media)) if (s.t0 > t && s.t0 <= t + within && (!best || s.t0 < best.t0)) best = s
  if (!best) return null
  const m = media.get(best.clip.media)!
  return { id: best.clip.id, path: m.path, image: m.kind === 'image', src: best.src0, opacity: 0 }
}

/** o lettering que está na tela em t (fica por cima de tudo, como no render) */
export function letteringAt(data: MontageData, t: number): MontageMarker | null {
  return (data.markers ?? []).find((m) => m.kind === 'lettering' && m.dur > 0 && m.t <= t && m.t + m.dur > t) ?? null
}
