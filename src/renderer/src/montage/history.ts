import type { MontageClip, MontageData } from '../lib'

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

/** o que mudou num corte, em ordem de importância */
function clipEdit(a: MontageClip, b: MontageClip): string | null {
  if (a.track !== b.track) return 'Moveu de faixa'
  if (a.in !== b.in || a.out !== b.out) return 'Aparou'
  if (a.start !== b.start) return 'Moveu'
  if (a.gainDb !== b.gainDb) return 'Volume'
  if (a.splice !== b.splice) return 'Crossfade'
  if (a.fadeIn !== b.fadeIn || a.fadeOut !== b.fadeOut || a.fadeInCurve !== b.fadeInCurve || a.fadeOutCurve !== b.fadeOutCurve) return 'Fade'
  if (a.audioOff !== b.audioOff) return b.audioOff ? 'Tirou o som do corte' : 'Voltou o som do corte'
  if (a.block !== b.block) return 'Ligou ao roteiro'
  return null
}

/**
 * Nome curto de um passo do desfazer da Montagem, comparando antes e depois
 * (o histórico mostra a lista; ninguém precisa rotular cada ação na mão).
 */
export function describeChange(prev: MontageData, next: MontageData): string {
  const before = new Map(prev.clips.map((c) => [c.id, c]))
  const after = new Map(next.clips.map((c) => [c.id, c]))
  const added = next.clips.filter((c) => !before.has(c.id))
  const removed = prev.clips.filter((c) => !after.has(c.id))
  const edits = new Map<string, number>()
  for (const c of next.clips) {
    const old = before.get(c.id)
    const e = old && clipEdit(old, c)
    if (e) edits.set(e, (edits.get(e) ?? 0) + 1)
  }
  const edited = [...edits.values()].reduce((s, k) => s + k, 0)

  if (next.media.length > prev.media.length) return 'Importou ' + n(next.media.length - prev.media.length, 'mídia', 'mídias')
  if (next.media.length < prev.media.length) return 'Removeu ' + n(prev.media.length - next.media.length, 'mídia', 'mídias')
  if (next.tracks.length !== prev.tracks.length) return next.tracks.length > prev.tracks.length ? 'Nova faixa' : 'Apagou faixa'

  if (added.length || removed.length) {
    // dividir: um corte novo colado no fim de um que encolheu, mesmo arquivo
    if (added.length === 1 && !removed.length && edited === 1 && edits.get('Aparou')) return 'Dividiu corte'
    if (added.length && !removed.length) return added.length === 1 ? 'Pôs corte na timeline' : 'Pôs ' + n(added.length, 'corte', 'cortes')
    if (removed.length && !added.length) return (edited ? 'Apagou e fechou o vão: ' : 'Apagou ') + n(removed.length, 'corte', 'cortes')
    return `Recortou (${removed.length} → ${added.length} cortes)`
  }
  if (edited) {
    const [top] = [...edits.entries()].sort((a, b) => b[1] - a[1])
    if (edits.size === 1 && top[0] === 'Moveu' && edited > 1) {
      // tudo andou pra trás junto: fechou um vão
      const back = next.clips.every((c) => c.start <= (before.get(c.id)?.start ?? c.start))
      return back ? 'Fechou vão' : 'Moveu ' + n(edited, 'corte', 'cortes')
    }
    return edited === 1 ? top[0] : `${top[0]} (${n(edited, 'corte', 'cortes')})`
  }
  if (JSON.stringify(prev.tracks) !== JSON.stringify(next.tracks)) return 'Mexeu na faixa'
  if (JSON.stringify(prev.markers ?? []) !== JSON.stringify(next.markers ?? [])) return 'Lettering'
  if (JSON.stringify(prev.blocks ?? []) !== JSON.stringify(next.blocks ?? [])) {
    const a = prev.blocks?.length ?? 0
    const b = next.blocks?.length ?? 0
    return b > a ? 'Novo bloco de motion' : b < a ? 'Apagou bloco de motion' : 'Bloco de motion'
  }
  if (prev.media.some((m, i) => (m.denoise ?? 0) !== (next.media[i]?.denoise ?? 0))) {
    const on = next.media.some((m, i) => m.denoise && m.denoise !== prev.media[i]?.denoise)
    return on ? 'Limpou o ruído' : 'Desligou a limpeza de ruído'
  }
  if (JSON.stringify(prev.bins) !== JSON.stringify(next.bins)) return 'Pastas de mídia'
  if (prev.norm !== next.norm) return 'Alvo do volume'
  if (prev.spliceDefault !== next.spliceDefault) return 'Duração do crossfade'
  if (prev.letteringDur !== next.letteringDur) return 'Tempo do lettering'
  return 'Ajuste'
}
