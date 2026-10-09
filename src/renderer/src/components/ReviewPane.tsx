import { useEffect, useMemo, useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import { Check, X, CheckCheck, Trash2, Merge, Loader2, Send, ChevronDown, ChevronRight } from 'lucide-react'
import { blockLabel, formatTime } from '../lib'
import { diffBlocks, estimate, textOf, wordDiff, type Op } from '../review'

type Decision = 'accept' | 'reject'

interface Props {
  original: JSONContent[]
  draft: JSONContent[]
  wpm: number
  /** pedido que gerou o rascunho (mostrado no topo) */
  request: string
  provider?: string
  busy: boolean
  onApply: (blocks: JSONContent[]) => void
  onDiscard: () => void
  onRequestChanges: (request: string) => void
}

const KIND_LABEL: Record<Op['kind'], string> = { same: 'igual', change: 'alterado', del: 'removido', add: 'novo' }
const PROVIDER_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', anthropic: 'Claude (API)', openai: 'ChatGPT (API)' }

/** Bloco da versão sugerida "por cima" do original: texto e ajustes novos, mas anexos/ritmo do original ficam. */
function merged(a: JSONContent, b: JSONContent): JSONContent {
  return { ...a, attrs: { ...(a.attrs ?? {}), ...(b.attrs ?? {}) }, content: b.content }
}

/** Faixa de tempo de uma versão: cada bloco com largura proporcional à duração. */
function MiniTimeline({ label, blocks, wpm }: { label: string; blocks: JSONContent[]; wpm: number }) {
  const { segs, total } = estimate(blocks, wpm)
  return (
    <div className="rv-tl">
      <span className="rv-tl-label">
        {label} <b>{formatTime(total)}</b>
      </span>
      <div className="rv-tl-bar">
        {segs.map((s, i) =>
          s.dur > 0 ? <span key={i} className={'rv-seg t-' + s.kind} style={{ flexGrow: s.dur }} title={`${blockLabel(s.kind)} · ${s.dur.toFixed(1)}s`} /> : null
        )}
      </div>
    </div>
  )
}

function Cell({ node, words }: { node?: JSONContent; words?: { t: string; d: boolean }[] }) {
  if (!node) return <div className="rv-cell empty" />
  const extra = node.type === 'transition' ? ` · ${node.attrs?.kind}` : node.type === 'sonora' || node.type === 'soundUp' ? ` · ${node.attrs?.seconds}s` : ''
  return (
    <div className={'rv-cell t-' + node.type}>
      <span className="rv-tag">
        {blockLabel(node.type ?? 'paragraph')}
        {extra}
      </span>
      <span className="rv-text">{words ? words.map((w, i) => (w.d ? <mark key={i}>{w.t}</mark> : <span key={i}>{w.t}</span>)) : textOf(node)}</span>
    </div>
  )
}

/**
 * Revisão lado a lado: versão atual × sugestão da IA, bloco a bloco.
 * Aprovar/recusar por linha (ou tudo), pedir alterações em cima do rascunho, e Unificar.
 */
export function ReviewPane({ original, draft, wpm, request, provider, busy, onApply, onDiscard, onRequestChanges }: Props) {
  const ops = useMemo(() => diffBlocks(original, draft), [original, draft])
  const [decisions, setDecisions] = useState<Record<number, Decision>>({})
  const [openSame, setOpenSame] = useState<Record<number, boolean>>({})
  const [ask, setAsk] = useState('')
  // rascunho novo (pediu alterações): as linhas mudam, então as decisões recomeçam
  useEffect(() => {
    setDecisions({})
    setOpenSame({})
  }, [draft])

  const changes = ops.map((o, i) => ({ o, i })).filter(({ o }) => o.kind !== 'same')
  const accepted = changes.filter(({ i }) => decisions[i] === 'accept').length
  const rejected = changes.filter(({ i }) => decisions[i] === 'reject').length

  const decide = (i: number, d: Decision) => setDecisions((x) => ({ ...x, [i]: x[i] === d ? (undefined as any) : d }))
  const all = (d: Decision) => setDecisions(Object.fromEntries(changes.map(({ i }) => [i, d])))

  /** junta: só entra o que foi aprovado; o resto fica como estava */
  const unify = () => {
    const out: JSONContent[] = []
    ops.forEach((o, i) => {
      const ok = decisions[i] === 'accept'
      if (o.kind === 'same') out.push(original[o.a])
      else if (o.kind === 'change') out.push(ok ? merged(original[o.a], draft[o.b]) : original[o.a])
      else if (o.kind === 'del') {
        if (!ok) out.push(original[o.a])
      } else if (ok) out.push(draft[o.b])
    })
    onApply(out)
  }

  // trechos iguais longos ficam recolhidos
  const rows: ({ type: 'op'; o: Op; i: number } | { type: 'same-run'; start: number; ops: { o: Op; i: number }[] })[] = []
  for (let i = 0; i < ops.length; ) {
    if (ops[i].kind !== 'same') {
      rows.push({ type: 'op', o: ops[i], i })
      i++
      continue
    }
    const run: { o: Op; i: number }[] = []
    while (i < ops.length && ops[i].kind === 'same') run.push({ o: ops[i], i: i++ })
    if (run.length <= 2) run.forEach((r) => rows.push({ type: 'op', ...r }))
    else rows.push({ type: 'same-run', start: run[0].i, ops: run })
  }

  const renderOp = (o: Op, i: number) => {
    const a = o.kind === 'same' || o.kind === 'change' || o.kind === 'del' ? original[o.a] : undefined
    const b = o.kind === 'same' || o.kind === 'change' || o.kind === 'add' ? draft[o.b] : undefined
    const wd = o.kind === 'change' && a && b ? wordDiff(textOf(a), textOf(b)) : null
    const d = decisions[i]
    return (
      <div key={i} className={'rv-row k-' + o.kind + (d ? ' d-' + d : '')}>
        <Cell node={a} words={wd?.a} />
        <div className="rv-mid">
          {o.kind === 'same' ? (
            <span className="rv-kind">=</span>
          ) : (
            <>
              <span className="rv-kind">{KIND_LABEL[o.kind]}</span>
              <div className="rv-btns">
                <button className={'rv-ok' + (d === 'accept' ? ' on' : '')} title="Aprovar esta mudança" onClick={() => decide(i, 'accept')}>
                  <Check size={14} />
                </button>
                <button className={'rv-no' + (d === 'reject' ? ' on' : '')} title="Manter como estava" onClick={() => decide(i, 'reject')}>
                  <X size={14} />
                </button>
              </div>
            </>
          )}
        </div>
        <Cell node={b} words={wd?.b} />
      </div>
    )
  }

  return (
    <div className="review">
      <div className="rv-head">
        <div className="rv-title">
          <b>Revisão da IA</b>
          <span className="muted small">
            “{request}”{provider ? ` · ${PROVIDER_LABEL[provider] ?? provider}` : ''}
          </span>
        </div>
        <span className="rv-count">
          {changes.length} mudanças · <span className="ok">{accepted} aprovadas</span> · <span className="bad">{rejected} recusadas</span>
        </span>
        <button className="btn small" onClick={() => all('accept')} disabled={busy}>
          <CheckCheck size={14} /> Aprovar tudo
        </button>
        <button className="btn small" onClick={() => all('reject')} disabled={busy}>
          <X size={14} /> Recusar tudo
        </button>
        <button className="btn small danger-btn" onClick={onDiscard} disabled={busy} title="Fecha a revisão sem mudar nada">
          <Trash2 size={14} /> Descartar
        </button>
        <button className="btn small primary" onClick={unify} disabled={busy || !accepted} title="Aplica as mudanças aprovadas (Ctrl+Z desfaz)">
          <Merge size={14} /> Unificar ({accepted})
        </button>
        <form
          className="rv-ask"
          onSubmit={(e) => {
            e.preventDefault()
            if (ask.trim()) onRequestChanges(ask.trim())
            setAsk('')
          }}
        >
          <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Pedir alterações em cima deste rascunho… (ex.: deixa o gancho mais curto)" disabled={busy} />
          <button className="btn small primary" disabled={busy || !ask.trim()}>
            {busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />} Refazer rascunho
          </button>
        </form>
      </div>

      <div className="rv-tls">
        <MiniTimeline label="Atual" blocks={original} wpm={wpm} />
        <MiniTimeline label="Sugestão" blocks={draft} wpm={wpm} />
      </div>

      <div className="rv-cols">
        <span>Versão atual</span>
        <span />
        <span>Sugestão da IA</span>
      </div>

      <div className={'rv-body' + (busy ? ' busy' : '')}>
        {changes.length === 0 && <p className="muted rv-none">A sugestão ficou igual ao roteiro atual.</p>}
        {rows.map((r) =>
          r.type === 'op' ? (
            renderOp(r.o, r.i)
          ) : (
            <div key={'s' + r.start}>
              <button className="rv-same-run" onClick={() => setOpenSame((x) => ({ ...x, [r.start]: !x[r.start] }))}>
                {openSame[r.start] ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {r.ops.length} linhas iguais
              </button>
              {openSame[r.start] && r.ops.map(({ o, i }) => renderOp(o, i))}
            </div>
          )
        )}
      </div>

    </div>
  )
}
