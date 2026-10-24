import { clipEndT, type Format, type MontageData, type MontageMarker } from '../lib'
import { envAt, envPoints, spans } from '../montage/engine'

/**
 * Plano do render local: a timeline de montagem vira partes de ~20 s, cada uma com as camadas de
 * vídeo (de baixo pra cima, com fades e crossfades), os trechos de áudio (com o mesmo envelope que
 * a Montagem toca) e os letterings. O Typos compila cada parte com o ffmpeg e junta no fim; se parar
 * no meio, a próxima rodada pula as partes que não mudaram.
 */

export interface VLayer {
  path: string
  image: boolean
  t0: number
  t1: number
  src0: number
  fadeIn: number
  fadeOut: number
}

export interface ALayer {
  path: string
  t0: number
  t1: number
  src0: number
  env: [number, number][]
}

export interface LetteringSpec {
  id: string
  label: string
  t: number
  dur: number
  /** animação (HTML), gravada pelo mesmo motor das prévias de motion */
  html: string
}

export interface RenderPart {
  id: string
  label: string
  from: number
  to: number
  /** tudo que define a parte: mudou = refaz */
  key: string
  video: VLayer[]
  audio: ALayer[]
  /** ids dos letterings que aparecem nela (ficam por cima de tudo) */
  letterings: string[]
}

export interface RenderPlan {
  parts: RenderPart[]
  letterings: LetteringSpec[]
  /** blocos de instrução que ainda não viraram clipe (não entram no vídeo) */
  pendingBlocks: number
  total: number
}

const r3 = (n: number) => Math.round(n * 1000) / 1000
const pad = (n: number) => String(n).padStart(2, '0')
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
const mediaLen = (m?: MontageData['media'][number]) => (!m ? 0 : m.kind === 'image' ? 3600 : m.duration)

/** fim do que entra no vídeo (faixas mudas, como a narração original do corte automático, não contam) */
export function timelineEnd(montage: MontageData) {
  const muted = new Set(montage.tracks.filter((t) => t.muted).map((t) => t.id))
  return Math.max(
    0,
    ...montage.clips.filter((c) => !muted.has(c.track)).map(clipEndT),
    ...(montage.markers ?? []).map((m) => m.t + m.dur),
    ...(montage.blocks ?? []).map((b) => b.end)
  )
}

/** corta [a, b] em partes de até ~20 s, de preferência num corte de vídeo */
function segments(montage: MontageData, a: number, b: number): [number, number][] {
  const video = new Set(montage.tracks.filter((t) => t.kind === 'video').map((t) => t.id))
  const cuts = montage.clips
    .filter((c) => video.has(c.track))
    .flatMap((c) => [c.start, clipEndT(c)])
    .sort((x, y) => x - y)
  const out: [number, number][] = []
  let t = a
  while (t < b - 0.01) {
    let next = cuts.filter((p) => p >= t + 10 && p <= t + 25).pop() ?? t + 20
    if (b - next < 4) next = b
    out.push([r3(t), r3(next)])
    t = next
  }
  return out
}

/** cor CSS válida? (o fundo do estilo às vezes é uma descrição em texto) */
const isColor = (s?: string) => !!s && /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(s.trim())
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** lettering capitular: título do capítulo entrando com as fontes e cores do formato */
export function letteringHtml(label: string, dur: number, format?: Format) {
  const m = format?.motion
  const colors = (m?.colors ?? []).filter(isColor)
  const bg = isColor(m?.background) ? m!.background!.trim() : '#0d0f14'
  const accent = colors[0] ?? '#f5c542'
  const ink = colors[1] ?? '#ffffff'
  const font = m?.fonts?.title || m?.fonts?.accent || 'Segoe UI'
  const d = Math.max(0.8, dur)
  const inT = Math.min(0.9, d * 0.35)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${bg}}
.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2.2vh}
.bar{height:.9vh;width:0;background:${accent};border-radius:1vh;animation:bar ${inT}s cubic-bezier(.2,.8,.2,1) forwards}
h1{margin:0;padding:0 8vw;text-align:center;font-family:"${esc(font)}",sans-serif;font-weight:800;font-size:11vh;line-height:1.05;color:${ink};
  letter-spacing:.35em;opacity:0;filter:blur(1.2vh);transform:translateY(4vh);animation:title ${inT}s cubic-bezier(.2,.8,.2,1) ${inT * 0.25}s forwards}
.glow{position:absolute;inset:-20%;background:radial-gradient(circle at 50% 50%,${accent}22,transparent 55%);animation:glow ${d}s linear forwards}
@keyframes bar{to{width:22vw}}
@keyframes title{to{opacity:1;filter:blur(0);transform:none;letter-spacing:.04em}}
@keyframes glow{from{transform:scale(.9)}to{transform:scale(1.15)}}
</style></head><body><div class="glow"></div><div class="wrap"><div class="bar"></div><h1>${esc(label)}</h1></div></body></html>`
}

/**
 * Plano do render: [from, to] da timeline (o vídeo inteiro ou só um pedaço) em partes.
 * Faixa de vídeo de cima cobre as de baixo; faixa muda não entra; som de clipe desligado não entra.
 */
export function planRender(montage: MontageData, o: { from: number; to: number; width: number; height: number; fps: number; format?: Format }): RenderPlan {
  const media = new Map(montage.media.map((m) => [m.id, m]))
  const mediaDur = (id: string) => mediaLen(media.get(id))
  const total = timelineEnd(montage)
  const a = Math.max(0, Math.min(o.from, total))
  const b = Math.max(a, Math.min(o.to, total))
  const all = spans(montage, mediaDur)

  // vídeo: a primeira faixa da lista é a de cima, então desenha de trás pra frente
  const vTracks = montage.tracks.filter((t) => t.kind === 'video' && !t.muted)
  const z = new Map(vTracks.map((t, i) => [t.id, vTracks.length - i]))
  const video = all
    .filter((s) => z.has(s.clip.track))
    .map((s) => ({ s, m: media.get(s.clip.media) }))
    .filter(({ m }) => m && (m.kind === 'image' || (m.kind === 'video' && m.hasVideo)))
    .sort((x, y) => z.get(x.s.clip.track)! - z.get(y.s.clip.track)! || x.s.t0 - y.s.t0)
    .map(({ s, m }) => ({
      path: m!.path,
      image: m!.kind === 'image',
      t0: r3(s.t0),
      t1: r3(s.t1),
      src0: r3(s.src0),
      // crossfade: o corte de cima aparece por cima do anterior (que segue inteiro por baixo)
      fadeIn: r3(s.xIn ? 2 * s.xIn : (s.clip.fadeIn ?? 0)),
      fadeOut: r3(s.xOut ? 0 : (s.clip.fadeOut ?? 0))
    }))

  // áudio: tudo que a Montagem toca, com o mesmo envelope (ganho, fades com curva, crossfades)
  const audio = all
    .filter((s) => media.get(s.clip.media)?.hasAudio && !s.clip.audioOff)
    .map((s) => ({
      path: media.get(s.clip.media)!.path,
      // limpeza de ruído: o render troca pela cópia limpa (a mesma que a prévia toca)
      ...(media.get(s.clip.media)!.denoise ? { denoise: media.get(s.clip.media)!.denoise } : {}),
      t0: r3(s.t0),
      t1: r3(s.t1),
      src0: r3(s.src0),
      env: envPoints(s).map((p) => [r3(p), Math.round(s.gain * envAt(s, p) * 1e5) / 1e5] as [number, number])
    }))

  const marks = (montage.markers ?? []).filter((m): m is MontageMarker => m.kind === 'lettering' && m.dur > 0)
  const letterings: LetteringSpec[] = marks.map((m) => ({ id: m.id, label: m.label, t: r3(m.t), dur: r3(m.dur), html: letteringHtml(m.label, m.dur, o.format) }))

  const parts = segments(montage, a, b).map(([from, to], i) => {
    const hit = <T extends { t0: number; t1: number }>(x: T) => x.t0 < to && x.t1 > from
    const v = video.filter(hit)
    const au = audio.filter(hit)
    const lt = letterings.filter((l) => l.t < to && l.t + l.dur > from)
    return {
      id: 'parte-' + pad(i + 1),
      label: `Parte ${i + 1} (${fmt(from)} → ${fmt(to)})`,
      from,
      to,
      key: JSON.stringify({ from, to, w: o.width, h: o.height, fps: o.fps, v, au, lt }),
      video: v,
      audio: au,
      letterings: lt.map((l) => l.id)
    }
  })
  return { parts, letterings, pendingBlocks: (montage.blocks ?? []).length, total }
}
