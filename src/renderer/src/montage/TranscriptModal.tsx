import { Fragment, useEffect, useRef, useState } from 'react'
import { Ear, FileText, Loader2, Pencil, Undo2, X } from 'lucide-react'
import { api, type MontageData, type TranscriptEdit } from '../lib'
import { RefModal } from '../components/References'
import { readAudio, readState, useReadCache, useWhisperJobs, jobLabel } from './transcripts'
import { applyFixes, fixWords, lines, promptOf, removePrompt, revertWord, setPrompt, tidy, type RawWord, type ShownWord } from './transcriptEdits'

/**
 * A transcrição do que o Whisper ouviu, pra corrigir palavras e prender prompts em falas (como no Roteiro:
 * seleciona, botão direito, Criar prompt). Fica guardado na timeline e o bloco de instrução lê junto com a fala.
 */

export interface TranscriptFile {
  path: string
  name: string
  /** só esses pedaços do arquivo (tempos do arquivo); sem isso, o arquivo todo */
  windows?: [number, number][]
}

const fmt = (t: number) => {
  const m = Math.floor(Math.max(0, t) / 60)
  return `${m}:${String(Math.floor(Math.max(0, t) - m * 60)).padStart(2, '0')}`
}

/** palavras de `from` a `to` (índices da original) de um arquivo */
type Sel = { path: string; from: number; to: number }
type Menu = { x: number; y: number; sel: Sel; word: ShownWord | null }

export function TranscriptModal({
  title,
  files,
  data,
  lang,
  ready,
  change,
  onClose
}: {
  title: string
  files: TranscriptFile[]
  data: MontageData
  lang: string
  /** modelo do Whisper baixado */
  ready: boolean
  change: (d: MontageData, gesture?: string) => void
  onClose: () => void
}) {
  const cache = useReadCache(
    files.map((f) => f.path),
    lang
  )
  const jobs = useWhisperJobs()
  const [words, setWords] = useState<Record<string, RawWord[] | { error: string }>>({})
  const [menu, setMenu] = useState<Menu | null>(null)
  const [fixing, setFixing] = useState<(Sel & { text: string; excerpt: string }) | null>(null)
  const [prompting, setPrompting] = useState<(Sel & { text: string; excerpt: string; id?: string }) | null>(null)
  const body = useRef<HTMLDivElement>(null)

  // carrega o que já foi lido (do cache: é na hora)
  const key = files.map((f) => f.path).join('\n')
  useEffect(() => {
    if (!cache) return
    for (const f of files) {
      if (!cache[f.path] || words[f.path]) continue
      api.transcribe(f.path, lang).then((r) => setWords((w) => ({ ...w, [f.path]: 'error' in r ? r : r.words })))
    }
  }, [cache, key, lang])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  const editOf = (path: string) => data.transcriptEdits?.[path]
  const save = (path: string, next: TranscriptEdit) => {
    const all = { ...(data.transcriptEdits ?? {}) }
    const t = tidy(next)
    if (t) all[path] = t
    else delete all[path]
    change({ ...data, transcriptEdits: Object.keys(all).length ? all : undefined })
  }
  const raw = (path: string) => {
    const w = words[path]
    return Array.isArray(w) ? w : []
  }
  const textOf = (s: Sel) =>
    applyFixes(raw(s.path), editOf(s.path))
      .filter((w) => w.i >= s.from && w.i <= s.to)
      .map((w) => w.w)
      .join(' ')

  /** as palavras selecionadas com o mouse (num arquivo só); sem seleção, a palavra clicada */
  const selection = (target: EventTarget | null): { sel: Sel; word: ShownWord | null } | null => {
    const clicked = (target as HTMLElement | null)?.closest?.('[data-i]') as HTMLElement | null
    const wordAt = (el: HTMLElement | null) => {
      if (!el) return null
      const path = el.dataset.path!
      const i = Number(el.dataset.i)
      return applyFixes(raw(path), editOf(path)).find((w) => w.i === i) ?? null
    }
    const s = window.getSelection()
    if (s && !s.isCollapsed && body.current) {
      const hit = [...body.current.querySelectorAll<HTMLElement>('[data-i]')].filter((el) => s.containsNode(el, true))
      if (hit.length) {
        const path = hit[0].dataset.path!
        const same = hit.filter((el) => el.dataset.path === path)
        const last = wordAt(same[same.length - 1])!
        return { sel: { path, from: Number(same[0].dataset.i), to: last.i }, word: wordAt(clicked) }
      }
    }
    const w = wordAt(clicked)
    return w && clicked ? { sel: { path: clicked.dataset.path!, from: w.i, to: w.i }, word: w } : null
  }
  /** fim real do trecho: a última palavra mostrada pode ter engolido outras */
  const endOf = (s: Sel) => applyFixes(raw(s.path), editOf(s.path)).find((w) => w.i === s.to)?.e ?? raw(s.path)[s.to].e

  const openFix = (sel: Sel) => setFixing({ ...sel, text: textOf(sel), excerpt: textOf(sel) })

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal tr-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          <FileText size={16} /> {title}
          <button className="icon-btn" onClick={onClose} title="Fechar">
            <X size={16} />
          </button>
        </h3>
        <p className="muted small tr-help">
          Selecione palavras e clique com o botão direito pra <b>corrigir</b> ou <b>criar um prompt</b> pro trecho (duplo clique corrige uma palavra). O bloco de instrução lê a
          fala já corrigida e segue os prompts no tempo dessas palavras.
        </p>
        <div className="tr-body" ref={body} onContextMenu={(e) => {
          const s = selection(e.target)
          if (!s) return
          e.preventDefault()
          setMenu({ x: Math.min(e.clientX, window.innerWidth - 250), y: Math.min(e.clientY, window.innerHeight - 200), ...s })
        }}>
          {!files.length && <p className="muted">Nenhuma fala pra ouvir aqui (as faixas podem estar desligadas ou desarmadas pra escuta).</p>}
          {files.map((f) => {
            const st = readState(f.path, lang, cache, jobs)
            const w = words[f.path]
            const edit = editOf(f.path)
            const shown = Array.isArray(w)
              ? applyFixes(w, edit).filter((x) => !f.windows || f.windows.some(([a, z]) => x.s >= a && x.s < z))
              : []
            return (
              <section key={f.path} className="tr-file">
                {files.length > 1 || !f.windows ? <div className="tr-name" title={f.path}>{f.name}</div> : null}
                {st.kind !== 'done' ? (
                  <div className="tr-todo">
                    {st.kind === 'running' || st.kind === 'queued' ? (
                      <>
                        <Loader2 size={13} className="spin" /> {st.kind === 'running' ? `Lendo ${jobLabel(st.job)}` : 'Na fila do Whisper…'}
                      </>
                    ) : (
                      <>
                        <span>{st.kind === 'error' ? `Não deu pra ler: ${st.error}` : 'Este áudio ainda não foi lido.'}</span>
                        <button className="btn small" disabled={!ready} title={ready ? '' : 'Baixe o modelo do Whisper antes (pasta Narração → Transcrição)'} onClick={() => readAudio([f.path], lang)}>
                          <Ear size={12} /> Ler agora
                        </button>
                      </>
                    )}
                  </div>
                ) : !w ? (
                  <div className="tr-todo">
                    <Loader2 size={13} className="spin" /> Abrindo…
                  </div>
                ) : 'error' in w ? (
                  <div className="tr-todo ar-err">{w.error}</div>
                ) : !shown.length ? (
                  <div className="tr-todo muted">(nenhuma fala neste trecho)</div>
                ) : (
                  lines(shown).map((line) => (
                    <p key={line[0].i} className="tr-line">
                      <span className="tr-time">{fmt(line[0].s)}</span>
                      <span className="tr-text">
                        {line.map((x, k) => {
                          const p = promptOf(edit, x)
                          const next = line[k + 1]
                          const ends = p && (!next || promptOf(edit, next)?.id !== p.id)
                          return (
                            <Fragment key={x.i}>
                              <span
                                data-path={f.path}
                                data-i={x.i}
                                className={'tr-word' + (x.fixed ? ' fixed' : '') + (p ? ' prompt-mark' : '')}
                                title={[x.fixed ? `Whisper ouviu: "${x.orig}"` : '', p ? `🎬 ${p.text}` : ''].filter(Boolean).join('\n') || undefined}
                                onDoubleClick={() => openFix({ path: f.path, from: x.i, to: x.i })}
                              >
                                {x.w}
                              </span>
                              {ends && (
                                <span className="tr-prompt" title={p.text}>
                                  🎬 {p.text}
                                </span>
                              )}{' '}
                            </Fragment>
                          )
                        })}
                      </span>
                    </p>
                  ))
                )}
              </section>
            )
          })}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>

      {menu && (
        <div className="ctx-menu tr-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <div className="ctx-label">“{(() => {
            const t = textOf(menu.sel)
            return t.length > 50 ? t.slice(0, 50) + '…' : t
          })()}”</div>
          <button
            onClick={() => {
              openFix(menu.sel)
              setMenu(null)
            }}
          >
            <span>
              <Pencil size={12} /> Corrigir {menu.sel.from === menu.sel.to ? 'palavra' : 'palavras'}
            </span>
          </button>
          {menu.word?.fixed && (
            <button
              onClick={() => {
                save(menu.sel.path, revertWord(raw(menu.sel.path), editOf(menu.sel.path), menu.word!.i))
                setMenu(null)
              }}
            >
              <span>
                <Undo2 size={12} /> Voltar ao que o Whisper ouviu (“{menu.word.orig}”)
              </span>
            </button>
          )}
          <div className="ctx-sep" />
          {(() => {
            const p = menu.word ? promptOf(editOf(menu.sel.path), menu.word) : undefined
            if (p && menu.sel.from === menu.sel.to)
              return (
                <>
                  <div className="ctx-label ctx-prompt">🎬 {p.text.length > 60 ? p.text.slice(0, 60) + '…' : p.text}</div>
                  <button
                    onClick={() => {
                      const ws = applyFixes(raw(menu.sel.path), editOf(menu.sel.path)).filter((w) => w.s >= p.from - 0.005 && w.e <= p.to + 0.005)
                      setPrompting({ path: menu.sel.path, from: ws[0]?.i ?? 0, to: ws[ws.length - 1]?.i ?? 0, text: p.text, id: p.id, excerpt: ws.map((w) => w.w).join(' ') })
                      setMenu(null)
                    }}
                  >
                    Editar prompt do trecho
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      save(menu.sel.path, removePrompt(editOf(menu.sel.path), p.id))
                      setMenu(null)
                    }}
                  >
                    Apagar prompt do trecho
                  </button>
                </>
              )
            return (
              <button
                onClick={() => {
                  setPrompting({ ...menu.sel, text: '', excerpt: textOf(menu.sel) })
                  setMenu(null)
                }}
              >
                🎬 Criar prompt pra este trecho
              </button>
            )
          })()}
        </div>
      )}

      {fixing && (
        <FixModal
          excerpt={fixing.excerpt}
          text={fixing.text}
          onCancel={() => setFixing(null)}
          onSave={(t) => {
            save(fixing.path, fixWords(raw(fixing.path), editOf(fixing.path), fixing.from, fixing.to, t))
            setFixing(null)
            window.getSelection()?.removeAllRanges()
          }}
        />
      )}
      {prompting && (
        <div onMouseDown={(e) => e.stopPropagation()}>
          <RefModal
            kind="prompt"
            edit={prompting}
            onCancel={() => setPrompting(null)}
            onSave={(text) => {
              const ws = raw(prompting.path)
              save(prompting.path, setPrompt(editOf(prompting.path), { id: prompting.id, from: ws[prompting.from].s, to: endOf(prompting), text }))
              setPrompting(null)
              window.getSelection()?.removeAllRanges()
            }}
          />
        </div>
      )}
    </div>
  )
}

/** caixa pra corrigir o que o Whisper ouviu */
function FixModal({ excerpt, text, onCancel, onSave }: { excerpt: string; text: string; onCancel: () => void; onSave: (t: string) => void }) {
  const [v, setV] = useState(text)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const ok = v.trim().length > 0
  return (
    <div className="modal-backdrop" onMouseDown={(e) => (e.stopPropagation(), onCancel())}>
      <div className="modal ref-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          <Pencil size={16} /> Corrigir a transcrição
        </h3>
        <blockquote className="ref-excerpt">{excerpt}</blockquote>
        <input
          ref={ref}
          className="tr-fix-input"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel()
            if (e.key === 'Enter' && ok) onSave(v)
          }}
        />
        <div className="modal-actions">
          <span className="muted small">Enter salva</span>
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!ok} onClick={() => onSave(v)}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  )
}
