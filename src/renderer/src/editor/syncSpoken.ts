import type { Node as PMNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { tokens } from '../montage/autocut'

/**
 * "Atualizar roteiro": o texto escrito das falas passa a ser o que foi falado na narração.
 * A transcrição (Whisper) é alinhada com o roteiro inteiro, palavra a palavra:
 *  - palavra que bate (igual ou quase: nome que o Whisper escreveu diferente) fica como o autor escreveu,
 *    com a formatação;
 *  - palavra escrita que não foi falada sai;
 *  - palavra falada que não estava escrita (improviso) entra, na fala onde foi dita.
 * Falas antes do primeiro e depois do último trecho reconhecido (ainda não gravadas) não mudam.
 */

interface Chunk {
  /** posição no documento */
  from: number
  to: number
  para: number
  toks: string[]
}

/** palavras de um parágrafo com a posição de cada uma no documento (quebra de linha separa palavras) */
function paragraphChunks(node: PMNode, pos: number, para: number): Chunk[] {
  let text = ''
  const at: number[] = []
  node.descendants((n, p) => {
    if (n.isText) {
      for (let i = 0; i < n.text!.length; i++) at.push(pos + 1 + p + i)
      text += n.text
    } else if (n.isLeaf) {
      at.push(pos + 1 + p)
      text += ' '
    }
  })
  const out: Chunk[] = []
  for (const m of text.matchAll(/\S+/g)) {
    const a = m.index!
    const b = a + m[0].length
    out.push({ from: at[a], to: at[b - 1] + 1, para, toks: tokens(m[0]) })
  }
  return out
}

function similar(a: string, b: string) {
  if (a === b) return true
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 2) return false
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length) >= 0.75
}

export type SyncResult = { changed: number; inserted: number; removed: number } | { error: string }

/**
 * Aplica no `tr` a troca do texto escrito pelo falado. `spoken` = palavras da narração na ordem
 * em que tocam na Montagem.
 */
export function syncSpokenText(doc: PMNode, spoken: string[], tr: Transaction): SyncResult {
  const W: { tok: string; chunk: number }[] = []
  const chunks: Chunk[] = []
  doc.forEach((node, pos, i) => {
    if (node.type.name !== 'paragraph') return
    for (const c of paragraphChunks(node, pos, i)) {
      for (const tok of c.toks) W.push({ tok, chunk: chunks.length })
      chunks.push(c)
    }
  })
  const sChunks = spoken.map((w) => w.trim()).filter(Boolean)
  const S: { tok: string; chunk: number }[] = []
  sChunks.forEach((w, k) => tokens(w).forEach((tok) => S.push({ tok, chunk: k })))
  if (!W.length) return { error: 'O roteiro não tem falas escritas.' }
  if (!S.length) return { error: 'Não há narração falada na Montagem (ou a transcrição veio vazia).' }

  const n = W.length
  const m = S.length
  if (n * m > 150e6) return { error: 'Roteiro e narração grandes demais pra alinhar de uma vez.' }

  // LCS ponderado (igual = 2, parecido = 1). dir: 1 = casou, 2 = pula escrita, 3 = pula falada
  const dir = new Uint8Array((n + 1) * (m + 1))
  let prev = new Int32Array(m + 1)
  let cur = new Int32Array(m + 1)
  const ids = new Map<string, number>()
  const id = (t: string) => ids.get(t) ?? (ids.set(t, ids.size), ids.size - 1)
  const wi = W.map((x) => id(x.tok))
  const si = S.map((x) => id(x.tok))
  const simCache = new Map<number, boolean>()
  for (let i = 1; i <= n; i++) {
    cur[0] = 0
    for (let j = 1; j <= m; j++) {
      let best = prev[j]
      let d = 2
      if (cur[j - 1] > best) {
        best = cur[j - 1]
        d = 3
      }
      const a = wi[i - 1]
      const b = si[j - 1]
      let gain = 0
      if (a === b) gain = 2
      else {
        const key = a * 1048576 + b
        let ok = simCache.get(key)
        if (ok === undefined) simCache.set(key, (ok = similar(W[i - 1].tok, S[j - 1].tok)))
        if (ok) gain = 1
      }
      if (gain && prev[j - 1] + gain >= best) {
        best = prev[j - 1] + gain
        d = 1
      }
      cur[j] = best
      dir[i * (m + 1) + j] = d
    }
    ;[prev, cur] = [cur, prev]
  }

  type Op = { k: 'm'; w: number; s: number } | { k: 'd'; w: number } | { k: 'i'; s: number }
  const ops: Op[] = []
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const d = i && j ? dir[i * (m + 1) + j] : i ? 2 : 3
    if (d === 1) ops.push({ k: 'm', w: --i, s: --j })
    else if (d === 2) ops.push({ k: 'd', w: --i })
    else ops.push({ k: 'i', s: --j })
  }
  ops.reverse()

  const matchedS = ops.filter((o) => o.k === 'm').length
  if (matchedS < 0.3 * m) return { error: 'A narração quase não bate com o roteiro. O idioma do formato está certo?' }

  const matchedChunk = new Set<number>()
  const matchedSpoken = new Set<number>()
  for (const o of ops)
    if (o.k === 'm') {
      matchedChunk.add(W[o.w].chunk)
      matchedSpoken.add(S[o.s].chunk)
    }
  const first = Math.min(...matchedChunk)
  const last = Math.max(...matchedChunk)

  // o que entra antes/depois de cada palavra escrita, e quais saem
  const before = new Map<number, string[]>()
  const after = new Map<number, string[]>()
  const removed = new Set<number>()
  const placed = new Set<number>()
  let anchor = -1
  for (const o of ops) {
    if (o.k !== 'i') {
      const c = W[o.w].chunk
      if (c >= first && c <= last) anchor = c
      if (o.k === 'd' && c >= first && c <= last && !matchedChunk.has(c)) removed.add(c)
      continue
    }
    const sc = S[o.s].chunk
    if (matchedSpoken.has(sc) || placed.has(sc)) continue
    placed.add(sc)
    const map = anchor < 0 ? before : after
    const at = anchor < 0 ? first : anchor
    map.set(at, [...(map.get(at) ?? []), sChunks[sc]])
  }
  // palavra falada que casou só em parte (o Whisper juntou/separou diferente) não duplica nada:
  // a escrita fica

  const schema = doc.type.schema
  const edits: { from: number; to: number; text: string }[] = []
  chunks.forEach((c, k) => {
    const b = before.get(k) ?? []
    const a = after.get(k) ?? []
    if (removed.has(k)) {
      const words = [...b, ...a]
      if (words.length) return edits.push({ from: c.from, to: c.to, text: words.join(' ') })
      // apaga junto um espaço vizinho (o de depois; na última palavra da fala, o de antes)
      const next = chunks[k + 1]
      const prevC = chunks[k - 1]
      if (next && next.para === c.para) edits.push({ from: c.from, to: next.from, text: '' })
      else if (prevC && prevC.para === c.para && !removed.has(k - 1)) edits.push({ from: prevC.to, to: c.to, text: '' })
      else edits.push({ from: c.from, to: c.to, text: '' })
      return
    }
    if (b.length) edits.push({ from: c.from, to: c.from, text: b.join(' ') + ' ' })
    if (a.length) edits.push({ from: c.to, to: c.to, text: ' ' + a.join(' ') })
  })
  edits.sort((x, y) => x.from - y.from || x.to - y.to)

  const paras = new Set<number>()
  for (const e of edits) {
    const from = tr.mapping.map(e.from, 1)
    const to = Math.max(from, tr.mapping.map(e.to, -1))
    if (e.text) tr.replaceWith(from, to, schema.text(e.text))
    else if (to > from) tr.delete(from, to)
    paras.add(chunks.find((c) => c.from <= e.from && e.from <= c.to)?.para ?? -1)
  }
  let inserted = 0
  for (const v of [...before.values(), ...after.values()]) inserted += v.length
  return { changed: paras.size, inserted, removed: removed.size }
}
