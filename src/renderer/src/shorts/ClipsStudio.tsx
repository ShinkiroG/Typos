import { useEffect, useRef, useState } from 'react'
import { Check, CheckCircle2, ChevronDown, ChevronRight, Clapperboard, FolderOpen, Loader2, RefreshCw, Scissors, Settings2, Sparkles, Trash2, X } from 'lucide-react'
import { type Format, type MontageData, type ShortClip, type ShortsData } from '../lib'
import { Montage } from '../montage/Montage'
import { timelineEnd } from '../render/plan'
import { buildShorts, parseSuggestions, shortDuration, shortKey, suggestPrompt, timelineWords, transcriptText } from './shorts'
import './shorts.css'

/**
 * Workspace Criar Clipes: o Claude sugere os melhores trechos do vídeo pra recortes curtos; cada um
 * tem a timeline dele (a mesma Montagem, no quadro e no formato próprios dos clipes). Aprovar o recorte põe ele nos
 * fila de render.
 */

interface Props {
  active: boolean
  dir: string
  /** a timeline de montagem do vídeo longo (de onde saem os recortes) */
  main: MontageData
  shorts: ShortsData
  onChange: (s: ShortsData) => void
  lang: string
  wpm: number
  format?: Format
  onFormatChange?: (f: Format) => void
  onAudioSettings: () => void
  /** muda = sugere os recortes agora (vem do "Ativar e sugerir" / "Sugerir de novo") */
  suggestToken: number
  /** abre a janelinha dos tempos */
  onSetup: () => void
  onGoRender: () => void
  /** aprovou (ou voltou pra edição): entra (ou sai) da fila de render */
  onApprove?: (id: string, approved: boolean) => void
}

/** caminhos dos arquivos que a timeline usa */
const usedPaths = (d: MontageData) => {
  const used = new Set(d.clips.map((c) => c.media))
  return d.media.filter((m) => used.has(m.id)).map((m) => m.path)
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function ClipsStudio({ active, dir, main, shorts, onChange, lang, wpm, format, onFormatChange, onAudioSettings, suggestToken, onSetup, onGoRender, onApprove }: Props) {
  const ref = useRef(shorts)
  ref.current = shorts
  const mainRef = useRef(main)
  mainRef.current = main
  const [sel, setSel] = useState<string | null>(shorts.items[0]?.id ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [folderOpen, setFolderOpen] = useState(true)

  const cur = shorts.items.find((s) => s.id === sel) ?? null
  useEffect(() => {
    if (!cur && shorts.items.length) setSel(shorts.items[0].id)
  }, [cur, shorts.items])
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(''), 5000)
    return () => clearTimeout(t)
  }, [note])

  const patch = (id: string, p: Partial<ShortClip>) => {
    const s = ref.current
    const next = { ...s, items: s.items.map((x) => (x.id === id ? { ...x, ...p } : x)) }
    ref.current = next
    onChange(next)
  }

  // ---------- o Claude sugere os recortes ----------
  const suggest = async () => {
    if (busy) return
    setError('')
    const m = mainRef.current
    try {
      setBusy('Lendo a transcrição…')
      const words = await timelineWords(m, lang, setBusy)
      if ('error' in words) throw new Error(words.error)
      if (words.length < 20) throw new Error('A narração da timeline tem fala de menos pra tirar recortes.')
      setBusy('O Claude está escolhendo os melhores trechos…')
      const t = ref.current.target
      const r = await window.api.aiText({ instruction: suggestPrompt(t, timelineEnd(m)), input: transcriptText(words), dir, timeoutMs: 10 * 60000 })
      if ('error' in r) throw new Error(r.error)
      const list = parseSuggestions(r.text)
      if (!list.length) throw new Error('O Claude não devolveu nenhum trecho no formato esperado. Tente de novo.')
      // os aprovados ficam; os outros dão lugar às sugestões novas (menos as que caem em cima de um aprovado)
      const kept = ref.current.items.filter((x) => x.approved)
      const fresh = buildShorts(m, words, list, t).filter(
        (n) => !kept.some((k) => Math.min(k.to, n.to) - Math.max(k.from, n.from) > (n.to - n.from) * 0.5)
      )
      if (!fresh.length && !kept.length) throw new Error('Nenhum trecho sugerido bateu com a fala da timeline.')
      const next: ShortsData = { ...ref.current, items: [...kept, ...fresh], analyzedAt: new Date().toISOString(), provider: r.provider }
      ref.current = next
      onChange(next)
      setSel(fresh[0]?.id ?? kept[0]?.id ?? null)
      setNote(`${fresh.length} recorte(s) sugerido(s)${kept.length ? ` · ${kept.length} aprovado(s) ficaram` : ''}.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const lastToken = useRef(0)
  useEffect(() => {
    if (suggestToken && suggestToken !== lastToken.current) {
      lastToken.current = suggestToken
      suggest()
    }
  }, [suggestToken])

  const remove = (s: ShortClip) => {
    if (!confirm(`Apagar o recorte "${s.title}"? (O vídeo longo não muda.)`)) return
    const next = { ...ref.current, items: ref.current.items.filter((x) => x.id !== s.id) }
    ref.current = next
    onChange(next)
    if (sel === s.id) setSel(next.items[0]?.id ?? null)
  }

  const approve = () => {
    if (!cur) return
    if (cur.approved) {
      patch(cur.id, { approved: false })
      onApprove?.(cur.id, false)
      return setNote('Recorte voltou pra edição: saiu da fila de render.')
    }
    if (!cur.montage.clips.length) return setNote('A timeline desse recorte está vazia.')
    patch(cur.id, { approved: true })
    onApprove?.(cur.id, true)
    setNote('Aprovado: entrou na fila de render.')
  }

  const t = shorts.target
  const approvedN = shorts.items.filter((s) => s.approved).length
  const pendingN = shorts.items.filter((s) => s.approved && s.exported?.key !== shortKey(s)).length

  // ---------- pasta Recortes (no topo da área de mídia) ----------
  const folder = (
    <div className="sh-folder">
      <button className="sh-folder-head" onClick={() => setFolderOpen((o) => !o)} title="Clique num recorte pra abrir a timeline dele">
        {folderOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <FolderOpen size={14} />
        <b>Recortes</b>
        <small>
          {approvedN}/{shorts.items.length} prontos
        </small>
      </button>
      {folderOpen && (
        <ul className="sh-list">
          {shorts.items.map((s) => {
            const d = shortDuration(s)
            const off = d < t.min - 0.5 || d > t.max + 0.5
            return (
              <li key={s.id} className={s.id === sel ? 'on' : ''} onClick={() => setSel(s.id)} title={s.reason || s.title}>
                <span className={'sh-state ' + (s.approved ? 'ok' : 'no')} title={s.approved ? 'Aprovado: está na fila de render' : 'Ainda não aprovado'}>
                  {s.approved ? <Check size={11} strokeWidth={3} /> : <X size={11} strokeWidth={3} />}
                </span>
                <span className="sh-name">{s.title}</span>
                <small className={off ? 'sh-off' : ''} title={off ? `Fora do tempo alvo (${t.min}–${t.max} s)` : undefined}>
                  {Math.round(d)} s
                </small>
                <button
                  className="icon-btn sh-del"
                  title="Apagar recorte"
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(s)
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            )
          })}
          {!shorts.items.length && <li className="sh-empty">nenhum recorte ainda</li>}
        </ul>
      )}
    </div>
  )

  const approveBtn = cur && (
    <button
      className={'btn small ' + (cur.approved ? 'sh-approved' : 'primary')}
      onClick={approve}
      title={cur.approved ? 'Aprovado (está na fila de render). Clique pra voltar pra edição.' : 'Aprovar: o recorte entra na fila de render'}
    >
      {cur.approved ? <CheckCircle2 size={13} /> : <Check size={13} />} {cur.approved ? 'Short aprovado' : 'Aprovar short'}
    </button>
  )

  return (
    <div className="clips-studio">
      <header className="cs-head">
        <h2>
          <Scissors size={17} /> Criar Clipes
        </h2>
        {cur ? (
          <div className="cs-cur">
            <input className="cs-title" value={cur.title} onChange={(e) => patch(cur.id, { title: e.target.value })} spellCheck={false} title="Nome do recorte (vira o nome do arquivo)" />
            <small className="muted" title={cur.reason}>
              {fmt(cur.from)}–{fmt(cur.to)} do vídeo · {Math.round(shortDuration(cur))} s{cur.reason ? ` · ${cur.reason}` : ''}
            </small>
          </div>
        ) : (
          <span className="tb-grow" />
        )}
        {busy ? (
          <span className="cs-busy">
            <Loader2 size={13} className="spin" /> {busy}
          </span>
        ) : note ? (
          <span className="cs-note">{note}</span>
        ) : null}
        <button className="btn small" onClick={onSetup} title="Tempo mínimo, ideal e máximo e a proporção dos recortes">
          <Settings2 size={13} /> {t.min}–{t.ideal}–{t.max} s · {shorts.aspect}
        </button>
        <button className="btn small" disabled={!!busy || !main.clips.length} onClick={suggest} title="O Claude sugere de novo (os recortes aprovados ficam)">
          <RefreshCw size={13} /> Sugerir de novo
        </button>
        <button className="btn small" onClick={onGoRender} title="Fila de render">
          <Clapperboard size={13} /> Render{pendingN ? ` (${pendingN} pendente${pendingN > 1 ? 's' : ''})` : ''}
        </button>
      </header>

      {cur ? (
        <Montage
          key={cur.id}
          active={active}
          data={cur.montage}
          onChange={(d) => patch(cur.id, { montage: d })}
          dir={dir}
          wpm={wpm}
          lang={lang}
          getBlocks={() => []}
          onAudioSettings={onAudioSettings}
          format={format}
          onFormatChange={onFormatChange}
          poolTop={folder}
          toolbarExtra={approveBtn}
          frame={shorts.aspect}
          usedElsewhere={() => new Set([mainRef.current, ...ref.current.items.filter((x) => x.id !== cur.id).map((x) => x.montage)].flatMap(usedPaths))}
          otherTimelines={() => [mainRef.current, ...ref.current.items.filter((x) => x.id !== cur.id).map((x) => x.montage)]}
        />
      ) : (
        <div className="cs-empty">
          {busy ? (
            <>
              <Loader2 size={30} className="spin" />
              <b>{busy}</b>
              <small className="muted">A transcrição de cada narração fica guardada no PC: da segunda vez é na hora.</small>
            </>
          ) : (
            <>
              <Scissors size={30} />
              <b>Nenhum recorte ainda</b>
              {error && <p className="shorts-err">{error}</p>}
              <button className="btn primary" disabled={!main.clips.length} onClick={suggest}>
                <Sparkles size={14} /> Sugerir recortes
              </button>
              {!main.clips.length && <small className="muted">A timeline de montagem está vazia: os recortes saem dela.</small>}
            </>
          )}
        </div>
      )}
      {error && cur && (
        <div className="cs-error">
          {error}
          <button className="icon-btn" onClick={() => setError('')}>
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
