import type { MontageClip, MontageTrack } from '../lib'

/**
 * Arrastar vários cortes pra outra faixa: todos descem/sobem o mesmo número de faixas que o corte
 * pego (contando só faixas do mesmo tipo, na ordem em que aparecem), mantendo o tempo entre eles.
 * Se algum cairia fora (passou da última faixa), o pulo é limitado pra caber todo mundo.
 * Devolve a faixa nova de cada corte (só os que mudam).
 */
export function shiftTracks(tracks: MontageTrack[], clips: MontageClip[], ids: string[], main: string, target: MontageTrack | null): Map<string, string> {
  const out = new Map<string, string>()
  const o = clips.find((c) => c.id === main)
  const from = o && tracks.find((t) => t.id === o.track)
  if (!o || !from || !target || target.kind !== from.kind) return out
  const list = (kind: MontageTrack['kind']) => tracks.filter((t) => t.kind === kind)
  let delta = list(from.kind).indexOf(target) - list(from.kind).indexOf(from)
  if (!delta) return out
  const moving = clips.filter((c) => ids.includes(c.id))
  for (const c of moving) {
    const tr = tracks.find((t) => t.id === c.track)
    if (!tr) continue
    const l = list(tr.kind)
    const i = l.indexOf(tr)
    delta = Math.max(-i, Math.min(l.length - 1 - i, delta))
  }
  if (!delta) return out
  for (const c of moving) {
    const tr = tracks.find((t) => t.id === c.track)
    if (!tr) continue
    const l = list(tr.kind)
    out.set(c.id, l[l.indexOf(tr) + delta].id)
  }
  return out
}
