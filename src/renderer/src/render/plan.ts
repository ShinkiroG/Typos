import type { JSONContent } from '@tiptap/core'
import { absPath, type InstructionBlock, type MontageData, type MontageBin } from '../lib'

/**
 * Plano do render: a timeline vira uma lista de etapas com arquivo de saída conhecido
 * (partes de vídeo, áudio, final). O Typos confere os arquivos pra medir o progresso e,
 * se o Claude parar no meio (token acabou, PC desligou), a próxima rodada pula o que já está pronto.
 */

export interface RenderStep {
  id: string
  label: string
  /** relativo à pasta render/ */
  file: string
  /** peso no progresso (~ segundos de trabalho) */
  weight: number
  /** duração esperada do arquivo (s): arquivo mais curto = incompleto */
  expect?: number
  /** tudo que define essa etapa: mudou = refaz */
  key: string
  /** trecho da timeline (s), pras partes */
  from?: number
  to?: number
}

export interface NarrationPiece {
  path: string
  in: number
  out: number
  start: number
}

const r2 = (n: number) => Math.round(n * 100) / 100

/** papel (narração, bruto, sfx…) da categoria raiz de cada bin */
export function roleResolver(montage: MontageData) {
  const binById = new Map(montage.bins.map((b) => [b.id, b]))
  return (binId: string | undefined) => {
    let cur: MontageBin | undefined = binId ? binById.get(binId) : undefined
    for (let i = 0; cur?.parent && i < 20; i++) cur = binById.get(cur.parent)
    return cur?.role
  }
}

/** blocos de instrução da timeline, lidos com tolerância (end ou duration) */
export function instructionBlocks(montage: MontageData): InstructionBlock[] {
  const raw = ((montage as any).blocks ?? []) as any[]
  if (!Array.isArray(raw)) return []
  return raw
    .map((b) => {
      const start = Number(b?.start) || 0
      const end = Number(b?.end ?? start + (Number(b?.duration) || 0))
      return {
        id: String(b?.id ?? ''),
        track: String(b?.track ?? ''),
        start,
        end,
        text: String(b?.text ?? b?.instructions ?? ''),
        dynamic: !!b?.dynamic,
        attachments: (Array.isArray(b?.attachments) ? b.attachments : [])
          .filter((a: any) => a?.path)
          .map((a: any) => ({
            // anexos seguem a regra do Attachment: relativo à pasta do projeto, a não ser que external
            path: /^([a-z]:[\\/]|[\\/])/i.test(String(a.path)) ? String(a.path) : absPath(a),
            name: String(a.name ?? String(a.path).split(/[\\/]/).pop()),
            use: a.use === 'insert' ? 'insert' : 'ref',
            note: a.note ? String(a.note) : undefined
          })),
        approved: !!b?.approved,
        preview: b?.preview?.html || b?.preview?.video ? { html: b.preview.html, video: b.preview.video } : undefined
      } as InstructionBlock
    })
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start)
}

/** só as falas do roteiro (sem prompts, transições etc.), com os capítulos como títulos */
export function scriptText(doc: JSONContent | undefined): string {
  const text = (n: JSONContent): string =>
    n.type === 'text' ? n.text ?? '' : n.type === 'hardBreak' ? '\n' : (n.content ?? []).map(text).join('')
  const out: string[] = []
  for (const n of doc?.content ?? []) {
    if (n.type === 'chapter') {
      const t = text(n).trim() || String(n.attrs?.title ?? '').trim()
      if (t) out.push('', '## ' + t, '')
    } else if (n.type === 'paragraph') {
      const t = text(n).trim()
      if (t) out.push(t)
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** trechos de narração ouvidos na timeline (faixas de áudio não mudas, mídia de narração) */
export function narrationPieces(montage: MontageData): NarrationPiece[] {
  const roleOf = roleResolver(montage)
  const media = new Map(montage.media.map((m) => [m.id, m]))
  const muted = new Set(montage.tracks.filter((t) => t.muted).map((t) => t.id))
  return montage.clips
    .filter((c) => !muted.has(c.track))
    .map((c) => ({ c, m: media.get(c.media) }))
    .filter(({ m }) => m && m.hasAudio && roleOf(m.bin) === 'narration')
    .map(({ c, m }) => ({ path: m!.path, in: c.in, out: c.out, start: c.start }))
    .sort((a, b) => a.start - b.start)
}

/** fim do que entra no vídeo (faixas mudas, como a narração original do corte automático, não contam) */
export function timelineEnd(montage: MontageData) {
  const muted = new Set(montage.tracks.filter((t) => t.muted).map((t) => t.id))
  return Math.max(
    montage.clips.filter((c) => !muted.has(c.track)).reduce((s, c) => Math.max(s, c.start + c.out - c.in), 0),
    instructionBlocks(montage).reduce((s, b) => Math.max(s, b.end), 0)
  )
}

/** corta a timeline em partes de ~10–30 s, de preferência nos cortes de vídeo, sem partir um bloco de instrução */
export function segments(montage: MontageData): [number, number][] {
  const total = timelineEnd(montage)
  if (total <= 0) return []
  const blocks = instructionBlocks(montage)
  const videoTracks = new Set(montage.tracks.filter((t) => t.kind === 'video').map((t) => t.id))
  const inside = (p: number) => blocks.find((b) => p > b.start + 0.01 && p < b.end - 0.01)
  const cand = [
    ...montage.clips.filter((c) => videoTracks.has(c.track)).flatMap((c) => [c.start, c.start + c.out - c.in]),
    ...blocks.flatMap((b) => [b.start, b.end])
  ]
    .filter((p) => p > 0.5 && p < total - 0.5 && !inside(p))
    .sort((a, b) => a - b)
  const MIN = 8
  const MAX = 30
  const out: [number, number][] = []
  let t = 0
  while (t < total - 0.01) {
    let next = cand.filter((p) => p >= t + MIN && p <= t + MAX).pop()
    if (next === undefined) {
      next = t + MAX
      const b = inside(next)
      if (b) next = b.end
    }
    if (total - next < 4) next = total
    out.push([r2(t), r2(next)])
    t = next
  }
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

/** etapas do render: parte-NN.mp4 (só vídeo), audio.m4a (mix da timeline) e o arquivo final */
export function planSteps(montage: MontageData, o: { outW: number; outH: number; fps: number; style: string; finalFile: string }): RenderStep[] {
  const media = new Map(montage.media.map((m) => [m.id, m]))
  const kindOf = new Map(montage.tracks.map((t) => [t.id, t]))
  const blocks = instructionBlocks(montage)
  const video = o.outW + 'x' + o.outH + '@' + o.fps
  const clipKey = (c: MontageData['clips'][number]) => [c.track, media.get(c.media)?.path, r2(c.start), r2(c.in), r2(c.out), c.gainDb, c.fadeIn, c.fadeOut, c.fadeInCurve, c.fadeOutCurve, c.splice]
  const steps: RenderStep[] = segments(montage).map(([from, to], i) => {
    const clips = montage.clips.filter((c) => kindOf.get(c.track)?.kind === 'video' && !kindOf.get(c.track)?.muted && c.start < to && c.start + c.out - c.in > from)
    const bl = blocks.filter((b) => b.start < to && b.end > from)
    return {
      id: 'parte-' + pad(i + 1),
      label: `Parte ${i + 1} (${fmt(from)} → ${fmt(to)})`,
      file: `partes/parte-${pad(i + 1)}.mp4`,
      weight: to - from,
      expect: to - from,
      key: JSON.stringify({ from, to, video, style: o.style, clips: clips.map(clipKey), blocks: bl }),
      from,
      to
    }
  })
  const total = steps.length ? steps[steps.length - 1].to! : 0
  const audioClips = montage.clips.filter((c) => kindOf.get(c.track)?.kind === 'audio' && !kindOf.get(c.track)?.muted)
  steps.push({
    id: 'audio',
    label: 'Áudio (mix da timeline)',
    file: 'audio.m4a',
    weight: Math.max(5, total * 0.15),
    expect: total,
    key: JSON.stringify({ total, norm: montage.norm, clips: audioClips.map(clipKey) })
  })
  steps.push({
    id: 'final',
    label: 'Vídeo final',
    file: o.finalFile,
    weight: Math.max(5, total * 0.1),
    expect: total,
    key: JSON.stringify(steps.map((s) => s.key))
  })
  return steps
}
