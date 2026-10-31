/**
 * Pedaços do texto como o YouTube pinta na descrição/comentário: links, #hashtags e
 * marcações de tempo (0:00, 1:02:03) ficam azuis; o resto é texto normal.
 */
export type RichPart = { kind: 'text' | 'link' | 'tag' | 'time'; text: string }

const TOKEN = /(https?:\/\/[^\s]+|www\.[^\s]+)|((?<![\w#])#[\p{L}\p{N}_]+)|((?<![\w:])(?:\d{1,2}:)?\d{1,2}:\d{2}(?![\w:]))/gu

export function richParts(text: string): RichPart[] {
  const out: RichPart[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) })
    out.push({ kind: m[1] ? 'link' : m[2] ? 'tag' : 'time', text: m[0] })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/** "Meu Canal" → "@meucanal" */
export const channelHandle = (name: string) => '@' + (name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]/g, '').toLowerCase() || 'seucanal')
