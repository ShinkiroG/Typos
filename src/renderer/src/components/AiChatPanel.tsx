import { useEffect, useRef, useState } from 'react'
import { Sparkles, Send, Loader2, FileDiff, Copy, Check, Trash2 } from 'lucide-react'
import { askAboutScript, requestDraft } from '../review'
import type { JSONContent } from '@tiptap/core'

const PROVIDER_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', anthropic: 'Claude (API)', openai: 'ChatGPT (API)' }

interface Msg {
  ask: string
  mode: 'chat' | 'draft'
  answer?: string
  error?: string
  provider?: string
}

const QUICK = [
  { label: 'Revisar o roteiro todo', ask: 'Revise o roteiro todo: falas mais naturais pra narrar, ritmo bom, sem perder o sentido.', mode: 'draft' as const },
  { label: 'Gancho mais forte', ask: 'Deixe o começo (gancho) mais forte e curto, pra segurar quem chega.', mode: 'draft' as const },
  { label: 'Encurtar', ask: 'Encurte o roteiro mantendo o essencial e o tom.', mode: 'draft' as const },
  { label: 'O que melhorar?', ask: 'Leia o roteiro e me diga os 5 pontos que mais melhorariam o vídeo.', mode: 'chat' as const }
]

interface Props {
  dir: string
  /** linhas do roteiro atual no formato da IA */
  getLines: () => string
  save: () => Promise<void>
  /** rascunho revisado pronto: abre a revisão lado a lado */
  onDraft: (blocks: JSONContent[], request: string, provider?: string) => void
}

/**
 * Chat com a IA sobre o roteiro inteiro. "Enviar" conversa; "Gerar versão revisada"
 * pede o roteiro completo reescrito e abre a revisão lado a lado.
 */
export function AiChatPanel({ dir, getLines, save, onDraft }: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(-1)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [msgs])

  const send = async (ask: string, mode: Msg['mode']) => {
    if (!ask.trim() || busy) return
    setText('')
    setBusy(true)
    setMsgs((m) => [...m, { ask, mode }])
    await save()
    const lines = getLines()
    const finish = (patch: Partial<Msg>) =>
      setMsgs((m) => {
        const next = [...m]
        next[next.length - 1] = { ...next[next.length - 1], ...patch }
        return next
      })
    if (mode === 'chat') {
      const history = msgs.filter((x) => x.mode === 'chat' && x.answer).slice(-3).map((x) => ({ ask: x.ask, answer: x.answer! }))
      const r = await askAboutScript(lines, ask, history, dir)
      finish('error' in r ? { error: r.error } : { answer: r.text, provider: r.provider })
    } else {
      const r = await requestDraft(lines, ask, dir)
      if ('error' in r) finish({ error: r.error })
      else {
        finish({ answer: `Rascunho pronto (${r.blocks.length} blocos). Abri a revisão lado a lado.`, provider: r.provider })
        onDraft(r.blocks, ask, r.provider)
      }
    }
    setBusy(false)
  }

  return (
    <div className="panel-body ai-chat">
      <p className="muted small">
        Converse sobre o roteiro inteiro ou peça uma versão revisada: ela abre lado a lado pra você aprovar linha por linha. Usa a IA de texto escolhida em ⚙ Configurações → IA.
      </p>
      <div className="ai-line-quick">
        {QUICK.map((q) => (
          <button key={q.label} className="chip" disabled={busy} onClick={() => send(q.ask, q.mode)} title={q.mode === 'draft' ? 'Gera uma versão revisada' : 'Resposta em texto'}>
            {q.mode === 'draft' ? <FileDiff size={11} /> : <Sparkles size={11} />} {q.label}
          </button>
        ))}
      </div>

      <div className="ai-chat-log">
        {msgs.map((m, i) => (
          <div key={i} className="ai-ex">
            <div className="ai-ask">
              {m.mode === 'draft' && <FileDiff size={11} />} {m.ask}
            </div>
            {!m.answer && !m.error && (
              <div className="ai-answer muted">
                <Loader2 size={12} className="spin" /> {m.mode === 'draft' ? 'escrevendo a versão revisada… (o roteiro todo pode levar um minuto)' : 'pensando…'}
              </div>
            )}
            {m.error && <div className="ai-answer error">{m.error}</div>}
            {m.answer && (
              <div className="ai-answer">
                <div className="ai-answer-text">{m.answer}</div>
                <div className="ai-answer-actions">
                  <span className="muted small">{PROVIDER_LABEL[m.provider ?? ''] ?? m.provider}</span>
                  <button
                    className="icon-btn"
                    title="Copiar"
                    onClick={() => {
                      navigator.clipboard.writeText(m.answer!)
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
        <div ref={end} />
      </div>

      <div className="ai-chat-input">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(text, 'chat')
            }
          }}
          placeholder="Pergunte ou peça algo sobre o roteiro todo… (Enter envia, Shift+Enter quebra linha)"
          rows={3}
          disabled={busy}
        />
        <div className="ai-chat-btns">
          {msgs.length > 0 && (
            <button className="icon-btn" title="Limpar conversa" onClick={() => setMsgs([])} disabled={busy}>
              <Trash2 size={13} />
            </button>
          )}
          <button className="btn small" disabled={busy || !text.trim()} onClick={() => send(text, 'draft')} title="A IA reescreve o roteiro todo e abre a revisão lado a lado">
            <FileDiff size={13} /> Gerar versão revisada
          </button>
          <button className="btn small primary" disabled={busy || !text.trim()} onClick={() => send(text, 'chat')}>
            {busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />} Enviar
          </button>
        </div>
      </div>
    </div>
  )
}
