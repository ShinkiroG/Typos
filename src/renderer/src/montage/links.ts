import { clipEndT, uid, type MontageClip, type MontageData, type MontageTrack } from '../lib'

/**
 * Áudio vinculado (como no Premiere): um clipe de vídeo com som vira dois cortes com o mesmo `link`,
 * o vídeo (mudo, na faixa de vídeo) e o som dele numa faixa de áudio, na metade de baixo. Os dois andam
 * juntos no tempo (mover, aparar, dividir, apagar), mas o som pode trocar de faixa à vontade.
 *
 * `syncLinks` roda a cada mudança da timeline e conserta o par a partir do que mudou:
 * - pedaço novo com o link de um par que já existia (dividir, duplicar, sobrescrever): ganha link próprio
 *   e, se o outro lado não veio junto, um par novo cortado no mesmo trecho;
 * - um lado apagado: o outro sai junto (se a faixa inteira foi apagada, o outro só fica sem vínculo);
 * - um lado mudou de tempo e o outro não: o outro acompanha;
 * - vídeo com som ainda sem par: o som vai pra uma faixa de áudio (a "Som dos vídeos", criada se precisar).
 */

const EPS = 0.002
const same = (a: number, b: number) => Math.abs(a - b) < EPS

/** o outro lado do par */
export function partnerOf(d: MontageData, c: MontageClip | undefined) {
  return c?.link ? d.clips.find((x) => x.id !== c.id && x.link === c.link) : undefined
}

/** os cortes e os pares deles (sem repetir) */
export function withLinked(d: MontageData, ids: string[]) {
  const out = new Set(ids)
  for (const id of ids) {
    const p = partnerOf(
      d,
      d.clips.find((c) => c.id === id)
    )
    if (p) out.add(p.id)
  }
  return [...out]
}

/** liga um vídeo e um som do mesmo arquivo: o som passa a ter o tempo do vídeo e o vídeo fica mudo */
export function linkPair(d: MontageData, videoId: string, audioId: string): MontageData {
  const v = d.clips.find((c) => c.id === videoId)
  const a = d.clips.find((c) => c.id === audioId)
  if (!v || !a || v.media !== a.media) return d
  const L = uid()
  return {
    ...d,
    clips: d.clips.map((c) =>
      c.id === v.id ? { ...c, link: L, audioOff: true } : c.id === a.id ? { ...c, link: L, start: v.start, in: v.in, out: v.out, audioOff: undefined } : c
    )
  }
}

/** desfaz o vínculo (o vídeo continua mudo; o som fica solto e pode ser apagado ou movido sozinho) */
export function unlink(d: MontageData, ids: string[]): MontageData {
  const links = new Set(d.clips.filter((c) => ids.includes(c.id) && c.link).map((c) => c.link))
  if (!links.size) return d
  return { ...d, clips: d.clips.map((c) => (c.link && links.has(c.link) ? { ...c, link: undefined } : c)) }
}

export const VIDEO_SOUND_NAME = 'Som dos vídeos'

/** faixa de áudio livre no trecho pro som de um vídeo: uma "Som dos vídeos" livre, ou uma nova logo abaixo da divisória */
function soundTrack(tracks: MontageTrack[], clips: MontageClip[], start: number, end: number): { tracks: MontageTrack[]; id: string } {
  const free = (t: MontageTrack) => !clips.some((c) => c.track === t.id && c.start < end - EPS && clipEndT(c) > start + EPS)
  const hit = tracks.find((t) => t.kind === 'audio' && t.videoSound && !t.muted && free(t))
  if (hit) return { tracks, id: hit.id }
  const n = tracks.filter((t) => t.videoSound).length
  const t: MontageTrack = { id: 'AV-' + uid().slice(0, 6), kind: 'audio', name: n ? `${VIDEO_SOUND_NAME} ${n + 1}` : VIDEO_SOUND_NAME, videoSound: true }
  // a primeira fica em cima do áudio (encostada no vídeo); as outras, logo depois das que já existem
  const last = tracks.map((x) => !!x.videoSound).lastIndexOf(true)
  const firstAudio = tracks.findIndex((x) => x.kind === 'audio')
  const at = last >= 0 ? last + 1 : firstAudio >= 0 ? firstAudio : tracks.length
  return { tracks: [...tracks.slice(0, at), t, ...tracks.slice(at)], id: t.id }
}

const timing = (c: MontageClip) => [c.start, c.in, c.out] as const
const moved = (a: MontageClip, b: MontageClip) => !same(a.start, b.start) || !same(a.in, b.in) || !same(a.out, b.out)

export function syncLinks(prev: MontageData | null, next: MontageData): MontageData {
  const kind = new Map(next.tracks.map((t) => [t.id, t.kind]))
  const isVideo = (c: MontageClip) => (kind.get(c.track) ?? (prev?.tracks.find((t) => t.id === c.track)?.kind)) === 'video'
  const media = new Map(next.media.map((m) => [m.id, m]))
  const prevById = new Map((prev?.clips ?? []).map((c) => [c.id, c]))
  const group = (clips: MontageClip[]) => {
    const g = new Map<string, MontageClip[]>()
    for (const c of clips) if (c.link) g.set(c.link, [...(g.get(c.link) ?? []), c])
    return g
  }
  const prevLinks = group(prev?.clips ?? [])
  let clips = next.clips
  let tracks = next.tracks
  let dirty = false
  const patch = (id: string, p: Partial<MontageClip>) => {
    clips = clips.map((c) => (c.id === id ? { ...c, ...p } : c))
    dirty = true
  }
  const get = (id: string) => clips.find((c) => c.id === id)!

  // 1) pedaços novos com o link de um par antigo (dividir, duplicar, sobrescrever no meio)
  if (prev)
    for (const [L, members] of group(clips)) {
      const before = prevLinks.get(L)
      const fresh = members.filter((c) => !prevById.has(c.id))
      if (!before || !fresh.length) continue
      const used = new Set<string>()
      for (const n of fresh) {
        if (used.has(n.id)) continue
        used.add(n.id)
        const L2 = uid()
        patch(n.id, { link: L2 })
        // o outro lado veio junto (dividiu os dois, duplicou os dois)
        const mate = fresh.find((m) => !used.has(m.id) && isVideo(m) !== isVideo(n) && same(m.start, n.start))
        if (mate) {
          used.add(mate.id)
          patch(mate.id, { link: L2 })
          continue
        }
        const src = before.find((o) => o.id !== n.id && isVideo(o) !== isVideo(n))
        if (!src) {
          patch(n.id, { link: undefined })
          continue
        }
        const srcNow = clips.find((c) => c.id === src.id)
        // continuação de um pedaço que ficou (dividiu): o fade de saída do par passa pro pedaço novo
        const cont = members.find((o) => prevById.has(o.id) && isVideo(o) === isVideo(n) && same(clipEndT(get(o.id)), n.start) && same(get(o.id).out, n.in))
        const keepOut = same(clipEndT(n), clipEndT(src))
        if (cont && srcNow && keepOut) patch(src.id, { fadeOut: 0, fadeOutCurve: undefined })
        const twin: MontageClip = {
          ...src,
          id: uid(),
          track: srcNow?.track ?? src.track,
          link: L2,
          start: n.start,
          in: n.in,
          out: n.out,
          splice: undefined,
          fadeIn: same(n.start, src.start) ? src.fadeIn : 0,
          fadeInCurve: same(n.start, src.start) ? src.fadeInCurve : undefined,
          fadeOut: keepOut ? src.fadeOut : 0,
          fadeOutCurve: keepOut ? src.fadeOutCurve : undefined
        }
        clips = [...clips, twin]
        dirty = true
      }
    }

  // 2) um lado sumiu: o outro sai junto (faixa apagada: só perde o vínculo)
  if (prev)
    for (const [L, before] of prevLinks) {
      const gone = before.filter((c) => !clips.some((x) => x.id === c.id))
      if (!gone.length) continue
      const trackGone = gone.some((c) => !kind.has(c.track))
      for (const o of before) {
        const cur = clips.find((x) => x.id === o.id && x.link === L)
        if (!cur) continue
        if (trackGone) patch(cur.id, { link: undefined })
        else {
          clips = clips.filter((x) => x.id !== cur.id)
          dirty = true
        }
      }
    }

  // 3) um lado mudou de tempo e o outro não: o outro acompanha
  for (const [, members] of group(clips)) {
    if (members.length !== 2) continue
    const [a, b] = members
    const pa = prevById.get(a.id)
    const pb = prevById.get(b.id)
    const ca = !pa || moved(a, pa)
    const cb = !pb || moved(b, pb)
    if (!moved(a, b)) continue
    const from = ca && !cb ? a : cb && !ca ? b : isVideo(a) ? a : b
    const to = from === a ? b : a
    const [start, inn, out] = timing(from)
    patch(to.id, { start, in: inn, out })
  }

  // o vídeo do par fica sempre mudo (quem toca é o som vinculado)
  for (const c of clips) if (c.link && isVideo(c) && !c.audioOff && clips.some((x) => x.id !== c.id && x.link === c.link)) patch(c.id, { audioOff: true })

  // 4) vídeo com som e sem par: o som desce pra uma faixa de áudio
  for (const c of [...clips]) {
    if (c.link || c.audioOff || !isVideo(c)) continue
    const m = media.get(c.media)
    if (!m || m.kind !== 'video' || !m.hasAudio || !m.hasVideo) continue
    const L = uid()
    const st = soundTrack(tracks, clips, c.start, clipEndT(c))
    tracks = st.tracks
    kind.set(st.id, 'audio')
    const sound: MontageClip = {
      id: uid(),
      track: st.id,
      media: c.media,
      start: c.start,
      in: c.in,
      out: c.out,
      link: L,
      ...(c.gainDb ? { gainDb: c.gainDb } : {}),
      ...(c.fadeIn ? { fadeIn: c.fadeIn, fadeInCurve: c.fadeInCurve } : {}),
      ...(c.fadeOut ? { fadeOut: c.fadeOut, fadeOutCurve: c.fadeOutCurve } : {}),
      ...(c.splice ? { splice: c.splice } : {}),
      ...(c.block !== undefined ? { block: c.block } : {})
    }
    clips = [...clips.map((x) => (x.id === c.id ? { ...x, link: L, audioOff: true, gainDb: undefined } : x)), sound]
    dirty = true
  }

  return dirty ? { ...next, clips, tracks } : next
}
