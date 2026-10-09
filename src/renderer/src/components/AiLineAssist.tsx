import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { Sparkles, Send, X, Loader2, Replace, ListPlus, Copy, Check, ImagePlus } from 'lucide-react'
import { api, blockLabel } from '../lib'

const PROVIDER_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', anthropic: 'Claude (API)', openai: 'ChatGPT (API)' }

/** atalhos de pedido por tipo de bloco */
const QUICK: Record<string, { label: string; ask: string }[]> = {
  paragraph: [
    { label: 'Revisar', ask: 'Revise esta fala pra soar natural narrada, mais clara e com ritmo. Mantenha o sentido e o tamanho parecido.' },
    { label: 'Mais curta', ask: 'Deixe esta fala mais curta e direta, sem perder a ideia.' },
    { label: 'Mais impactante', ask: 'Reescreva esta fala com mais impacto e gancho, sem exagerar nem inventar fatos.' },
    { label: 'Continuar', ask: 'Escreva a próxima fala que viria depois desta, no mesmo tom.' }
  ],
  chapter: [
    { label: 'Sugerir títulos', ask: 'Sugira 5 títulos curtos e chamativos pra este capítulo, um por linha.' },
    { label: 'Mais chamativo', ask: 'Reescreva este título de capítulo pra ser mais chamativo, curto.' }
  ],
  prompt: [
    { label: 'Detalhar motion', ask: 'Transforme esta instrução num prompt de motion mais detalhado e visual (enquadramento, movimento de câmera, elementos, estilo), em uma frase.' },
    { label: 'Prompt de imagem', ask: 'Escreva um prompt em inglês pra gerar uma imagem de referência desta cena, detalhado e visual.' }
  ],
  transition: [{ label: 'Sugerir transição', ask: 'Sugira uma transição de edição que combine com este ponto do roteiro, em uma frase.' }],
  soundUp: [{ label: 'Sugerir trilha', ask: 'Sugira o clima/estilo da trilha que sobe aqui, em poucas palavras.' }],
  sonora: [{ label: 'O que mostrar', ask: 'Sugira o que mostrar nesta pausa (trecho, imagem, gameplay…), em uma frase.' }]
}

interface Exchange {
  ask: string
  answer?: string
  error?: string
  provider?: string
}

interface Props {
  editor: Editor | null
  dir: string
  aspect: string
  /** salva antes de pedir (o Claude Code lê o roteiro.md da pasta) */
  save: () => Promise<void>
  /** gerar imagem pro bloco (usa a conexão de imagem) */
  onImage: (pos: number) => void
  /** container que rola (editor-scroll) e a página onde o ícone é posicionado */
  scrollEl: HTMLElement | null
  pageEl: HTMLElement | null
}

/**
 * Ícone de IA no fim da linha sob o mouse; clicando, abre um chat ali mesmo,
 * já sabendo de qual linha se trata. Quem responde é a IA escolhida em Configurações → IA.
 */
export function AiLineAssist({ editor, dir, aspect, save, onImage, scrollEl, pageEl }: Props) {
  const [hover, setHover] = useState<{ pos: number; x: number; y: number } | null>(null)
  const [open, setOpen] = useState<{ pos: number; x: number; y: number } | null>(null)
  const [chat, setChat] = useState<Exchange[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(-1)
  const raf = useRef(0)
  const openRef = useRef(open)
  openRef.current = open

  /** onde fica o ícone de um bloco: fim do texto (fala/capítulo) ou canto direito (blocos com caixa) */
  const anchorFor = useCallback(
    (pos: number) => {
      if (!editor || editor.isDestroyed || !pageEl) return null
      const node = editor.state.doc.nodeAt(pos)
      if (!node) return null
      const page = pageEl.getBoundingClientRect()
      const boxed = !['paragraph', 'chapter'].includes(node.type.name)
      if (boxed) {
        const dom = editor.view.nodeDOM(pos) as HTMLElement | null
        if (!dom) return null
        const r = dom.getBoundingClientRect()
        return { pos, x: r.right - page.left + 10, y: r.top - page.top + 6 }
      }
      const c = editor.view.coordsAtPos(pos + node.nodeSize - 1)
      return { pos, x: c.right - page.left + 8, y: (c.top + c.bottom) / 2 - page.top - 11 }
    },
    [editor, pageEl]
  )

  // segue o mouse: o ícone aparece na linha sob o cursor
  useEffect(() => {
    if (!scrollEl || !editor) return
    const move = (e: MouseEvent) => {
      if (openRef.current) return
      if ((e.target as HTMLElement).closest?.('.ai-line-btn')) return
      cancelAnimationFrame(raf.current)
      raf.current = requestAnimationFrame(() => {
        if (editor.isDestroyed) return
        const r = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
        if (!r) return
        // bloco de nível superior sob o mouse (r.inside às vezes já é a posição antes do bloco)
        const doc = editor.state.doc
        const $p = doc.resolve(Math.min(r.pos, doc.content.size))
        let pos: number | null = $p.depth >= 1 ? $p.before(1) : null
        if (pos === null && r.inside >= 0) {
          const $i = doc.resolve(r.inside)
          pos = $i.depth === 0 ? r.inside : $i.before(1)
        }
        if (pos === null || !doc.nodeAt(pos)) return
        const a = anchorFor(pos)
        if (a) setHover(a)
      })
    }
    const leave = () => !openRef.current && setHover(null)
    scrollEl.addEventListener('mousemove', move)
    scrollEl.addEventListener('mouseleave', leave)
    return () => {
      scrollEl.removeEventListener('mousemove', move)
      scrollEl.removeEventListener('mouseleave', leave)
    }
  }, [scrollEl, editor, anchorFor])

  // fecha com Esc
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const close = () => {
    setOpen(null)
    setChat([])
    setText('')
  }

  const node = open && editor ? editor.state.doc.nodeAt(open.pos) : null
  const kind = node?.type.name ?? 'paragraph'

  const neighbors = (pos: number) => {
    const list: { pos: number; text: string }[] = []
    editor!.state.doc.forEach((n, off) => list.push({ pos: off, text: n.textContent.trim() }))
    const i = list.findIndex((x) => x.pos === pos)
    const find = (dir: -1 | 1) => {
      for (let k = i + dir; k >= 0 && k < list.length; k += dir) if (list[k].text) return list[k].text
      return ''
    }
    return { before: find(-1), after: find(1) }
  }

  const ask = async (request: string) => {
    if (!open || !editor || !node || !request.trim() || busy) return
    const history = chat.filter((c) => c.answer).slice(-3)
    const { before, after } = neighbors(open.pos)
    setChat((c) => [...c, { ask: request }])
    setText('')
    setBusy(true)
    await save()
    const r = await api.aiText({
      instruction:
        'Você está ajudando com UMA linha de um roteiro de vídeo para YouTube (o roteiro completo está em roteiro.md, se puder ler). ' +
        'Se o pedido for pra escrever ou reescrever, devolva só o texto final, pronto pra colocar no roteiro, sem aspas. ' +
        'Se for uma pergunta, responda curto e direto.\n\nPEDIDO: ' +
        request,
      input:
        `LINHA (${blockLabel(kind)}): ${node.textContent || '(vazia)'}\n\nANTES: ${before || '(início)'}\nDEPOIS: ${after || '(fim)'}` +
        (history.length ? `\n\nCONVERSA ATÉ AQUI:\n${history.map((h) => `Pedido: ${h.ask}\nResposta: ${h.answer}`).join('\n\n')}` : ''),
      dir
    })
    setBusy(false)
    setChat((c) => {
      const next = [...c]
      next[next.length - 1] = 'error' in r ? { ask: request, error: r.error } : { ask: request, answer: r.text, provider: r.provider }
      return next
    })
  }

  const replaceLine = (answer: string) => {
    if (!editor || !open) return
    const n = editor.state.doc.nodeAt(open.pos)
    if (!n) return
    editor.view.dispatch(editor.state.tr.replaceWith(open.pos + 1, open.pos + n.nodeSize - 1, editor.schema.text(answer.trim())))
    close()
  }

  const insertBelow = (answer: string) => {
    if (!editor || !open) return
    const n = editor.state.doc.nodeAt(open.pos)
    if (!n) return
    const at = open.pos + n.nodeSize
    // cada linha da resposta vira um bloco do mesmo tipo (fala gera falas, prompt gera prompts…)
    const type = ['paragraph', 'prompt', 'chapter'].includes(n.type.name) ? n.type : editor.schema.nodes.paragraph
    const nodes = answer
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => type.create(null, editor.schema.text(l)))
    editor.view.dispatch(editor.state.tr.insert(at, nodes))
    close()
  }

  const anchor = open ?? hover
  if (!anchor) return null
  const pageW = pageEl?.clientWidth ?? 820
  const panelLeft = Math.max(-40, Math.min(anchor.x - 380, pageW - 420))

  return (
    <>
      <button
        className={'ai-line-btn' + (open ? ' on' : '')}
        style={{ left: anchor.x, top: anchor.y }}
        title="Pedir pra IA sobre esta linha"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? close() : setOpen(anchor))}
      >
        <Sparkles size={13} />
      </button>
      {open && node && (
        <div className="ai-line-panel" style={{ left: panelLeft, top: open.y + 28 }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="ai-line-head">
            <Sparkles size={13} /> IA · {blockLabel(kind)}
            <span className="muted small ai-line-quote">{node.textContent.slice(0, 60) || '(linha vazia)'}</span>
            <button className="icon-btn" onClick={close} title="Fechar (Esc)">
              <X size={13} />
            </button>
          </div>

          <div className="ai-line-quick">
            {(QUICK[kind] ?? QUICK.paragraph).map((q) => (
              <button key={q.label} className="chip" disabled={busy} onClick={() => ask(q.ask)}>
                {q.label}
              </button>
            ))}
            {(kind === 'prompt' || kind === 'sonora') && (
              <button
                className="chip"
                disabled={busy}
                onClick={() => {
                  onImage(open.pos)
                  close()
                }}
                title={`Gera uma imagem ${aspect} com a IA de imagem e anexa aqui`}
              >
                <ImagePlus size={12} /> Gerar imagem
              </button>
            )}
          </div>

          {chat.length > 0 && (
            <div className="ai-line-chat">
              {chat.map((c, i) => (
                <div key={i} className="ai-ex">
                  <div className="ai-ask">{c.ask}</div>
                  {!c.answer && !c.error && (
                    <div className="ai-answer muted">
                      <Loader2 size={12} className="spin" /> pensando…
                    </div>
                  )}
                  {c.error && <div className="ai-answer error">{c.error}</div>}
                  {c.answer && (
                    <div className="ai-answer">
                      <div className="ai-answer-text">{c.answer}</div>
                      <div className="ai-answer-actions">
                        <span className="muted small">{PROVIDER_LABEL[c.provider ?? ''] ?? c.provider}</span>
                        <button className="btn small" onClick={() => replaceLine(c.answer!)} title="Troca o texto desta linha (Ctrl+Z desfaz)">
                          <Replace size={12} /> Substituir
                        </button>
                        <button className="btn small" onClick={() => insertBelow(c.answer!)} title="Cada linha da resposta vira um bloco abaixo">
                          <ListPlus size={12} /> Inserir abaixo
                        </button>
                        <button
                          className="icon-btn"
                          title="Copiar"
                          onClick={() => {
                            navigator.clipboard.writeText(c.answer!)
                            setCopied(i)
                            setTimeout(() => setCopied(-1), 1200)
                          }}
                        >
                          {copied === i ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <form
            className="ai-line-input"
            onSubmit={(e) => {
              e.preventDefault()
              ask(text)
            }}
          >
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Peça algo sobre esta linha…"
              disabled={busy}
            />
            <button className="btn small primary" disabled={busy || !text.trim()}>
              {busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />}
            </button>
          </form>
        </div>
      )}
    </>
  )
}
