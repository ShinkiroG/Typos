import { uid, type TranscriptEdit, type TranscriptPrompt } from '../lib'

/**
 * Correções e prompts do autor em cima da transcrição do Whisper. Tudo preso ao tempo das palavras
 * no arquivo (não ao índice), então sobrevive a ler o áudio de novo.
 */

export type RawWord = { s: number; e: number; w: string }

export interface ShownWord extends RawWord {
  /** índice na transcrição original */
  i: number
  /** o que o Whisper ouviu */
  orig: string
  fixed: boolean
}

export const wordKey = (w: { s: number }) => w.s.toFixed(2)

const EPS = 0.005
export const inPrompt = (w: { s: number; e: number }, p: { from: number; to: number }) => w.s >= p.from - EPS && w.e <= p.to + EPS

/** as palavras com as correções aplicadas; as que foram juntadas na anterior ('') somem */
export function applyFixes(words: RawWord[], edit?: TranscriptEdit): ShownWord[] {
  const fix = edit?.fix ?? {}
  const out: ShownWord[] = []
  words.forEach((w, i) => {
    const f = fix[wordKey(w)]
    if (f === '') return
    // a correção de várias palavras vai até o fim da última que ela engoliu
    let j = i
    while (j + 1 < words.length && fix[wordKey(words[j + 1])] === '') j++
    const orig = words
      .slice(i, j + 1)
      .map((x) => x.w)
      .join(' ')
    out.push({ s: w.s, e: words[j].e, w: f ?? w.w, i, orig, fixed: f !== undefined })
  })
  return out
}

/** corrige as palavras de `from` a `to` (índices da original): a primeira vira `text` e as outras somem */
export function fixWords(words: RawWord[], edit: TranscriptEdit | undefined, from: number, to: number, text: string): TranscriptEdit {
  const fix = { ...(edit?.fix ?? {}) }
  const a = Math.min(from, to)
  const z = Math.max(from, to)
  // a correção nova também engole as palavras que a última corrigida do trecho já tinha engolido
  let end = z
  while (end + 1 < words.length && fix[wordKey(words[end + 1])] === '') end++
  const t = text.trim().replace(/\s+/g, ' ')
  const same = a === end && t === words[a].w
  for (let i = a; i <= end; i++) delete fix[wordKey(words[i])]
  if (!same) {
    fix[wordKey(words[a])] = t
    for (let i = a + 1; i <= end; i++) fix[wordKey(words[i])] = ''
  }
  return { ...edit, fix }
}

/** volta a palavra `i` (e as que ela engoliu) ao que o Whisper ouviu */
export function revertWord(words: RawWord[], edit: TranscriptEdit | undefined, i: number): TranscriptEdit {
  const fix = { ...(edit?.fix ?? {}) }
  delete fix[wordKey(words[i])]
  for (let j = i + 1; j < words.length && fix[wordKey(words[j])] === ''; j++) delete fix[wordKey(words[j])]
  return { ...edit, fix }
}

/** prompt novo (ou editado, se tiver id) preso às palavras de `from` a `to` */
export function setPrompt(edit: TranscriptEdit | undefined, p: Omit<TranscriptPrompt, 'id'> & { id?: string }): TranscriptEdit {
  const list = edit?.prompts ?? []
  const text = p.text.trim()
  if (p.id) return { ...edit, prompts: list.map((x) => (x.id === p.id ? { ...x, text } : x)) }
  // um trecho tem um prompt só: o novo substitui os que ficavam dentro dele
  const kept = list.filter((x) => !(x.from >= p.from - EPS && x.to <= p.to + EPS))
  return { ...edit, prompts: [...kept, { id: 'tp' + uid(), from: p.from, to: p.to, text }].sort((a, z) => a.from - z.from) }
}

export const removePrompt = (edit: TranscriptEdit | undefined, id: string): TranscriptEdit => ({ ...edit, prompts: (edit?.prompts ?? []).filter((x) => x.id !== id) })

/** o prompt que cobre esta palavra (o mais curto, se tiver mais de um) */
export const promptOf = (edit: TranscriptEdit | undefined, w: { s: number; e: number }) =>
  (edit?.prompts ?? []).filter((p) => inPrompt(w, p)).sort((a, z) => a.to - a.from - (z.to - z.from))[0]

/** tira entradas vazias (pra não guardar lixo no projeto) */
export function tidy(edit: TranscriptEdit): TranscriptEdit | undefined {
  const fix = edit.fix && Object.keys(edit.fix).length ? edit.fix : undefined
  const prompts = edit.prompts?.length ? edit.prompts : undefined
  return fix || prompts ? { fix, prompts } : undefined
}

/** quebra em linhas nas pausas (ou a cada ~12 palavras), como o resumo que vai pro Claude */
export function lines<W extends { s: number; e: number }>(words: W[]): W[][] {
  const out: W[][] = []
  let cur: W[] = []
  words.forEach((w, i) => {
    const prev = words[i - 1]
    if (prev && (w.s - prev.e > 0.6 || cur.length >= 12)) {
      out.push(cur)
      cur = []
    }
    cur.push(w)
  })
  if (cur.length) out.push(cur)
  return out
}
