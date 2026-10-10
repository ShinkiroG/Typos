import type { JSONContent } from '@tiptap/core'
import { api, countWords, inlineMd, mdToJson } from './lib'

/**
 * Formato de troca com a IA: um bloco por linha, com etiqueta.
 *   [CAPÍTULO] Intro
 *   [PROMPT] close no rosto…
 *   [FALA] Se você é desenvolvedor…
 *   [TRANSIÇÃO: Whip pan] whip pra direita
 *   [SOBE SOM 3s] trilha épica
 *   [PAUSA 2s] trecho do jornal
 * Assim a IA devolve o roteiro inteiro e o app consegue comparar bloco a bloco.
 */

const textOf = (n: JSONContent): string => inlineMd(n)

export function blockToLine(n: JSONContent): string | null {
  const t = textOf(n).replace(/\s*\n\s*/g, ' ').trim()
  switch (n.type) {
    case 'chapter':
      return `[CAPÍTULO] ${t}`
    case 'prompt':
      return `[PROMPT] ${t}`
    case 'paragraph':
      return t ? `[FALA] ${t}` : null
    case 'transition':
      return `[TRANSIÇÃO: ${n.attrs?.kind ?? 'Corte seco'}] ${t}`
    case 'soundUp':
      return `[SOBE SOM ${n.attrs?.seconds ?? 3}s] ${t}`
    case 'sonora':
      return `[PAUSA ${n.attrs?.seconds ?? 5}s] ${t}`
  }
  return null
}

export const docToLines = (blocks: JSONContent[]) => blocks.map(blockToLine).filter((l): l is string => l !== null).join('\n')

const txt = (t: string): JSONContent[] | undefined => (t.trim() ? mdToJson(t.trim()) : undefined)

/** Lê a resposta da IA de volta em blocos (linhas sem etiqueta viram fala). */
export function linesToBlocks(text: string): JSONContent[] {
  const out: JSONContent[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*]\s+/, '')
    if (!line || /^```/.test(line)) continue
    let m: RegExpMatchArray | null
    if ((m = line.match(/^\[CAP[IÍ]TULO\]\s*(.*)$/i))) out.push({ type: 'chapter', content: txt(m[1]) })
    else if ((m = line.match(/^\[PROMPT\]\s*(.*)$/i))) out.push({ type: 'prompt', content: txt(m[1]) })
    else if ((m = line.match(/^\[FALA\]\s*(.*)$/i))) out.push({ type: 'paragraph', content: txt(m[1]) })
    else if ((m = line.match(/^\[TRANSI[CÇ][AÃ]O(?::\s*([^\]]*))?\]\s*(.*)$/i)))
      out.push({ type: 'transition', attrs: { kind: (m[1] || 'Corte seco').trim() }, content: txt(m[2]) })
    else if ((m = line.match(/^\[SOBE SOM\s*([\d.,]*)\s*s?\]\s*(.*)$/i)))
      out.push({ type: 'soundUp', attrs: { seconds: Number((m[1] || '3').replace(',', '.')) || 3 }, content: txt(m[2]) })
    else if ((m = line.match(/^\[PAUSA\s*([\d.,]*)\s*s?\]\s*(.*)$/i)))
      out.push({ type: 'sonora', attrs: { seconds: Number((m[1] || '5').replace(',', '.')) || 5 }, content: txt(m[2]) })
    else out.push({ type: 'paragraph', content: txt(line) })
  }
  return out
}

// ---------- diff bloco a bloco ----------
export type Op =
  | { kind: 'same'; a: number; b: number }
  | { kind: 'change'; a: number; b: number }
  | { kind: 'del'; a: number }
  | { kind: 'add'; b: number }

const key = (n: JSONContent) => blockToLine(n) ?? `${n.type}:`

/** LCS nas linhas; apagado+adicionado vizinhos do mesmo tipo viram "alterado". */
export function diffBlocks(A: JSONContent[], B: JSONContent[]): Op[] {
  const a = A.map(key)
  const b = B.map(key)
  const n = a.length
  const m = b.length
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const raw: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) raw.push({ kind: 'same', a: i++, b: j++ })
    else if (L[i + 1][j] >= L[i][j + 1]) raw.push({ kind: 'del', a: i++ })
    else raw.push({ kind: 'add', b: j++ })
  }
  while (i < n) raw.push({ kind: 'del', a: i++ })
  while (j < m) raw.push({ kind: 'add', b: j++ })

  // junta trechos "apagou X / adicionou Y" em "alterou X→Y" quando o tipo bate
  const out: Op[] = []
  for (let k = 0; k < raw.length; ) {
    if (raw[k].kind === 'same') {
      out.push(raw[k++])
      continue
    }
    const dels: number[] = []
    const adds: number[] = []
    while (k < raw.length && raw[k].kind !== 'same') {
      const r = raw[k++]
      if (r.kind === 'del') dels.push(r.a)
      else if (r.kind === 'add') adds.push(r.b)
    }
    while (dels.length && adds.length) {
      if (A[dels[0]].type === B[adds[0]].type) out.push({ kind: 'change', a: dels.shift()!, b: adds.shift()! })
      // o par do bloco apagado vem mais adiante: o que está antes é inserção nova
      else if (adds.some((x) => B[x].type === A[dels[0]].type)) out.push({ kind: 'add', b: adds.shift()! })
      else out.push({ kind: 'del', a: dels.shift()! })
    }
    for (const d of dels) out.push({ kind: 'del', a: d })
    for (const x of adds) out.push({ kind: 'add', b: x })
  }
  return out
}

/** Diferença palavra a palavra (pra destacar o que mudou numa linha alterada). */
export function wordDiff(x: string, y: string): { a: { t: string; d: boolean }[]; b: { t: string; d: boolean }[] } {
  const A = x.split(/(\s+)/).filter(Boolean)
  const B = y.split(/(\s+)/).filter(Boolean)
  const n = A.length
  const m = B.length
  if (n * m > 250000) return { a: [{ t: x, d: true }], b: [{ t: y, d: true }] }
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const a: { t: string; d: boolean }[] = []
  const b: { t: string; d: boolean }[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      a.push({ t: A[i++], d: false })
      b.push({ t: B[j++], d: false })
    } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) b.push({ t: B[j++], d: !/^\s+$/.test(B[j - 1]) })
    else a.push({ t: A[i++], d: !/^\s+$/.test(A[i - 1]) })
  }
  return { a, b }
}

/** Duração estimada de cada bloco (fala pelo ppm, pausa/sobe som pelos segundos). */
export function estimate(blocks: JSONContent[], wpm: number) {
  const segs = blocks.map((n) => {
    if (n.type === 'paragraph') return { kind: 'paragraph', dur: Number(n.attrs?.seconds) || (countWords(textOf(n)) / Math.max(wpm, 1)) * 60 }
    if (n.type === 'sonora' || n.type === 'soundUp') return { kind: n.type, dur: Number(n.attrs?.seconds) || 0 }
    return { kind: n.type ?? 'paragraph', dur: 0 }
  })
  return { segs, total: segs.reduce((s, x) => s + x.dur, 0) }
}

export { textOf }

// ---------- pedidos sobre o roteiro inteiro ----------

const FORMAT_RULES =
  'Formato: um bloco por linha, com as etiquetas [CAPÍTULO], [PROMPT], [FALA], [TRANSIÇÃO: tipo], [SOBE SOM Ns], [PAUSA Ns]. ' +
  'Blocos que não precisam mudar ficam exatamente iguais. Não escreva nada além do roteiro (sem comentários, sem cercas de código).'

/** Pergunta/pedido livre sobre o roteiro todo: a resposta é texto. */
export async function askAboutScript(lines: string, request: string, history: { ask: string; answer: string }[], dir: string) {
  return api.aiText({
    instruction:
      'Você está ajudando com o roteiro inteiro de um vídeo para YouTube (abaixo, um bloco por linha; também está em roteiro.md). ' +
      'Responda ao pedido de forma direta e prática, em português. Se sugerir mudanças, diga quais linhas e como.\n\nPEDIDO: ' +
      request,
    input:
      (history.length ? `CONVERSA ATÉ AQUI:\n${history.map((h) => `Pedido: ${h.ask}\nResposta: ${h.answer}`).join('\n\n')}\n\n` : '') +
      `ROTEIRO:\n${lines}`,
    dir
  })
}

/** Pede uma versão revisada COMPLETA (pra revisão lado a lado). */
export async function requestDraft(lines: string, request: string, dir: string, isDraft = false) {
  const r = await api.aiText({
    instruction:
      (isDraft
        ? 'Abaixo está um RASCUNHO revisado de um roteiro de vídeo. Ajuste esse rascunho conforme o pedido e devolva o rascunho COMPLETO. '
        : 'Revise o roteiro de vídeo abaixo conforme o pedido e devolva o roteiro COMPLETO revisado. ') +
      FORMAT_RULES +
      '\n\nPEDIDO: ' +
      request,
    input: `ROTEIRO:\n${lines}`,
    dir
  })
  if ('error' in r) return r
  const blocks = linesToBlocks(r.text)
  if (!blocks.length) return { error: 'A IA não devolveu um roteiro no formato esperado. Tente pedir de novo.' }
  return { blocks, provider: r.provider }
}
