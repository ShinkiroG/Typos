import { Fragment, Slice, type Mark, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { uid } from '../lib'

/**
 * Roteiro em texto puro com a marcação embutida: copiar pro Bloco de Notas (ou pro Claude) leva as
 * instruções junto, e colar esse texto de volta reconstrói os blocos e a formatação.
 *
 *   # Capítulo                       <capitulo lettering="sim">Capítulo</capitulo>
 *   [instrução de motion]            prompt
 *   <fala>texto narrado</fala>       fala (s="4.2" = duração própria)
 *   <transicao tipo="Corte seco">…</transicao>
 *   <sobe-som s="3">…</sobe-som>     <pausa s="5">…</pausa>
 *
 * Dentro do texto: **negrito**, *itálico*, ~~riscado~~, ==marca-texto==, <u>sublinhado</u>,
 * <marca cor="#hex">…</marca>, <estilo cor="…" fonte="…" tamanho="…">…</estilo>,
 * <ref fonte="…">trecho</ref>, <prompt texto="…">trecho</prompt> e <br> (quebra de linha).
 * Um caractere com \ na frente é literal. Linha sem marcação nenhuma vira fala.
 */

// ---------- texto → marcação ----------
const esc = (t: string) =>
  t
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/~~/g, '\\~\\~')
    .replace(/==/g, '\\=\\=')
    .replace(/<(?=[a-zA-Z/])/g, '\\<')
const attr = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
const num = (v: unknown) => String(Math.round(Number(v) * 1000) / 1000)

function markDelims(m: Mark): [string, string] | null {
  switch (m.type.name) {
    case 'bold':
      return ['**', '**']
    case 'italic':
      return ['*', '*']
    case 'strike':
      return ['~~', '~~']
    case 'underline':
      return ['<u>', '</u>']
    case 'highlight':
      return m.attrs.color ? [`<marca cor="${attr(m.attrs.color)}">`, '</marca>'] : ['==', '==']
    case 'reference':
      return [`<ref fonte="${attr(m.attrs.text)}">`, '</ref>']
    case 'promptRange':
      return [`<prompt texto="${attr(m.attrs.text)}">`, '</prompt>']
    case 'textStyle': {
      const a = m.attrs
      const parts = [a.color && `cor="${attr(a.color)}"`, a.fontFamily && `fonte="${attr(a.fontFamily)}"`, a.fontSize && `tamanho="${attr(a.fontSize)}"`].filter(Boolean)
      return parts.length ? [`<estilo ${parts.join(' ')}>`, '</estilo>'] : null
    }
    default:
      return null
  }
}

/** conteúdo inline de um bloco, com as marcas abrindo e fechando aninhadas */
export function inlineToMarkup(block: PMNode | Fragment): string {
  const content = block instanceof Fragment ? block : block.content
  let out = ''
  const open: { mark: Mark; close: string }[] = []
  const sync = (marks: readonly Mark[]) => {
    const want = marks.map((m) => ({ mark: m, d: markDelims(m) })).filter((x) => x.d) as { mark: Mark; d: [string, string] }[]
    let keep = 0
    while (keep < open.length && keep < want.length && open[keep].mark.eq(want[keep].mark)) keep++
    while (open.length > keep) out += open.pop()!.close
    for (const w of want.slice(keep)) {
      out += w.d[0]
      open.push({ mark: w.mark, close: w.d[1] })
    }
  }
  content.forEach((n) => {
    if (n.isText) {
      sync(n.marks)
      out += esc(n.text ?? '')
    } else if (n.type.name === 'hardBreak') out += '<br>'
  })
  sync([])
  return out
}

function blockToMarkup(n: PMNode): string {
  const body = inlineToMarkup(n)
  const a = n.attrs
  switch (n.type.name) {
    case 'chapter':
      return a.lettering === true || a.lettering === false ? `<capitulo lettering="${a.lettering ? 'sim' : 'nao'}">${body}</capitulo>` : `# ${body}`
    case 'prompt':
      return `[${body}]`
    case 'transition':
      return `<transicao tipo="${attr(a.kind)}">${body}</transicao>`
    case 'soundUp':
      return `<sobe-som s="${num(a.seconds)}">${body}</sobe-som>`
    case 'sonora':
      return `<pausa s="${num(a.seconds)}">${body}</pausa>`
    case 'paragraph':
      return a.seconds ? `<fala s="${num(a.seconds)}">${body}</fala>` : `<fala>${body}</fala>`
    default:
      return body
  }
}

/** texto solto não pode começar parecendo bloco ("[…" vira prompt, "# " vira capítulo) */
const bare = (t: string) => t.replace(/^(\[|#\s)/, '\\$1')

/** o que vai pro text/plain da área de transferência */
export function sliceToMarkup(slice: Slice): string {
  const c = slice.content
  // pedaço de dentro de um bloco só: vai só o texto (com a formatação), sem a etiqueta do bloco
  if (c.childCount === 1 && c.firstChild!.isTextblock && slice.openStart > 0 && slice.openEnd > 0) return bare(inlineToMarkup(c.firstChild!))
  if (c.childCount && c.firstChild!.isInline) return bare(inlineToMarkup(c))
  const lines: string[] = []
  c.forEach((n) => lines.push(n.isTextblock ? blockToMarkup(n) : n.textContent))
  return lines.join('\n')
}

// ---------- marcação → texto ----------
type Tok = { t: 'text'; v: string } | { t: 'delim'; v: '**' | '*' | '~~' | '==' } | { t: 'open'; name: string; attrs: Record<string, string> } | { t: 'close'; name: string } | { t: 'br' }

const INLINE_TAGS = ['u', 'marca', 'ref', 'prompt', 'estilo']
const unattr = (v: string) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&')

function parseAttrs(s: string) {
  const out: Record<string, string> = {}
  for (const m of s.matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) out[m[1].toLowerCase()] = unattr(m[2])
  return out
}

function tokenize(s: string): Tok[] {
  const toks: Tok[] = []
  let text = ''
  const flush = () => {
    if (text) toks.push({ t: 'text', v: text })
    text = ''
  }
  for (let i = 0; i < s.length; ) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) {
      text += s[i + 1]
      i += 2
      continue
    }
    const two = s.slice(i, i + 2)
    if (two === '**' || two === '~~' || two === '==') {
      flush()
      toks.push({ t: 'delim', v: two })
      i += 2
      continue
    }
    if (ch === '*') {
      flush()
      toks.push({ t: 'delim', v: '*' })
      i++
      continue
    }
    if (ch === '<') {
      const m = s.slice(i).match(/^<(\/?)([a-zA-Z-]+)((?:\s+[a-zA-Z-]+\s*=\s*"[^"]*")*)\s*\/?>/)
      const name = m?.[2].toLowerCase()
      if (m && name === 'br') {
        flush()
        toks.push({ t: 'br' })
        i += m[0].length
        continue
      }
      if (m && name && INLINE_TAGS.includes(name)) {
        flush()
        toks.push(m[1] ? { t: 'close', name } : { t: 'open', name, attrs: parseAttrs(m[3]) })
        i += m[0].length
        continue
      }
    }
    text += ch
    i++
  }
  flush()
  // delimitador sem par (um "*" solto de outro programa) fica como texto
  for (const d of ['**', '*', '~~', '=='] as const) {
    const idx = toks.flatMap((t, k) => (t.t === 'delim' && t.v === d ? [k] : []))
    if (idx.length % 2) toks[idx[idx.length - 1]] = { t: 'text', v: d }
  }
  return toks
}

function markFor(schema: Schema, name: string, attrs: Record<string, string>): Mark | null {
  const m = schema.marks
  switch (name) {
    case 'u':
      return m.underline?.create() ?? null
    case 'marca':
      return m.highlight?.create({ color: attrs.cor || null }) ?? null
    case 'ref':
      return m.reference?.create({ id: uid(), text: attrs.fonte ?? '' }) ?? null
    case 'prompt':
      return m.promptRange?.create({ id: uid(), text: attrs.texto ?? '' }) ?? null
    case 'estilo':
      return m.textStyle?.create({ color: attrs.cor || null, fontFamily: attrs.fonte || null, fontSize: attrs.tamanho || null }) ?? null
    default:
      return null
  }
}

/** texto com marcação → nós inline (texto com marcas e quebras de linha) */
export function markupToInline(schema: Schema, s: string): PMNode[] {
  const out: PMNode[] = []
  const toggled = new Map<string, Mark>()
  const stack: { name: string; mark: Mark | null }[] = []
  const DELIM: Record<string, string> = { '**': 'bold', '*': 'italic', '~~': 'strike', '==': 'highlight' }
  for (const t of tokenize(s)) {
    if (t.t === 'delim') {
      const type = schema.marks[DELIM[t.v]]
      if (!type) continue
      if (toggled.has(t.v)) toggled.delete(t.v)
      else toggled.set(t.v, type.create())
    } else if (t.t === 'open') stack.push({ name: t.name, mark: markFor(schema, t.name, t.attrs) })
    else if (t.t === 'close') {
      const at = stack.map((x) => x.name).lastIndexOf(t.name)
      if (at >= 0) stack.splice(at, 1)
    } else if (t.t === 'br') {
      if (schema.nodes.hardBreak) out.push(schema.nodes.hardBreak.create())
    } else {
      let marks: readonly Mark[] = []
      for (const m of [...stack.map((x) => x.mark), ...toggled.values()]) if (m) marks = m.addToSet(marks)
      out.push(schema.text(t.v, marks))
    }
  }
  return out
}

const BLOCK_TAGS: Record<string, string> = { fala: 'paragraph', capitulo: 'chapter', transicao: 'transition', 'sobe-som': 'soundUp', pausa: 'sonora' }

/** acha "]" que fecha o prompt (ignora os escapados) */
function closingBracket(s: string) {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === ']') return i
  }
  return -1
}

/** texto colado (do Bloco de Notas, do Claude…) → blocos do roteiro */
export function markupToBlocks(schema: Schema, text: string): PMNode[] {
  const N = schema.nodes
  const out: PMNode[] = []
  const block = (type: string, body: string, attrs: Record<string, unknown> | null = null) => {
    const inl = markupToInline(schema, body)
    out.push(N[type].create(attrs, inl.length ? inl : null))
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim()
    if (!line) continue
    const open = line.match(/^<(fala|capitulo|transicao|sobe-som|pausa)((?:\s+[a-zA-Z-]+\s*=\s*"[^"]*")*)\s*>/i)
    if (open) {
      const tag = open[1].toLowerCase()
      const close = `</${tag}>`
      // a fala pode ter vindo quebrada em várias linhas (o Claude às vezes faz isso): junta com <br>
      while (!line.toLowerCase().endsWith(close) && i + 1 < lines.length) line += '<br>' + lines[++i].trim()
      const body = line.slice(open[0].length, line.toLowerCase().endsWith(close) ? -close.length : undefined)
      const a = parseAttrs(open[2])
      const secs = Number(a.s?.replace(',', '.'))
      const type = BLOCK_TAGS[tag]
      if (type === 'paragraph') block(type, body, secs > 0 ? { seconds: secs } : null)
      else if (type === 'chapter') block(type, body, { lettering: a.lettering === 'sim' ? true : a.lettering === 'nao' ? false : null })
      else if (type === 'transition') block(type, body, a.tipo ? { kind: a.tipo } : null)
      else block(type, body, secs > 0 ? { seconds: secs } : null)
      continue
    }
    if (/^#\s/.test(line)) {
      block('chapter', line.replace(/^#+\s*/, ''))
      continue
    }
    if (line.startsWith('[')) {
      const end = closingBracket(line)
      if (end > 0) {
        block('prompt', line.slice(1, end).trim())
        // "[instrução] fala aqui": prompt + fala (jeito antigo)
        const rest = line.slice(end + 1).trim()
        if (rest) block('paragraph', rest)
        continue
      }
    }
    block('paragraph', line)
  }
  return out
}

/** o que o editor recebe ao colar texto puro */
export function markupToSlice(schema: Schema, text: string): Slice {
  // texto de uma linha só, sem etiqueta de bloco: entra no meio da fala, como texto
  if (!/\n/.test(text.trim()) && !/^\s*(<(fala|capitulo|transicao|sobe-som|pausa)\b|#\s|\[)/i.test(text)) {
    const inl = markupToInline(schema, text.replace(/\r?\n$/, ''))
    return new Slice(Fragment.from(inl), 0, 0)
  }
  // blocos inteiros (fechados): um prompt colado continua prompt, mesmo no meio de uma fala
  const blocks = markupToBlocks(schema, text)
  return blocks.length ? new Slice(Fragment.from(blocks), 0, 0) : Slice.empty
}
