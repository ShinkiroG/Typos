import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronUp, CircleDashed, Ear, FileText, Layers, Loader2, X } from 'lucide-react'
import { api, type InstructionBlock, type MontageData } from '../lib'
import { audioIn, blockSpeech } from './blocks'
import { jobLabel, readAudio, readState, speechFiles, useReadCache, useWhisperJobs, type ReadState, type WhisperJob } from './transcripts'

/**
 * Ler o áudio de antemão: o Whisper transcreve em segundo plano (vários arquivos em paralelo) e guarda
 * no PC. Depois o corte automático, os blocos de instrução e o Criar Clipes usam na hora.
 */

const nameOf = (p: string) => p.split(/[\\/]/).pop() ?? p

function StateIcon({ s }: { s: ReadState }) {
  if (s.kind === 'done') return <Check size={12} strokeWidth={3} className="ar-ok" />
  if (s.kind === 'running') return <Loader2 size={12} className="spin ar-run" />
  if (s.kind === 'queued') return <CircleDashed size={12} className="ar-run" />
  if (s.kind === 'error') return <AlertTriangle size={12} className="ar-err" />
  return <CircleDashed size={12} className="ar-todo" />
}

const stateText = (s: ReadState) =>
  s.kind === 'done' ? 'lido' : s.kind === 'running' ? jobLabel(s.job) : s.kind === 'queued' ? 'na fila' : s.kind === 'error' ? s.error : 'não lido'

/** botão "Ler áudio" da barra da Montagem, com a lista de cada arquivo (lido ou não) */
export function AudioReadButton({
  data,
  lang,
  ready,
  onNeedModel,
  others,
  onOpenTranscript
}: {
  data: MontageData
  lang: string
  /** modelo do Whisper baixado */
  ready: boolean
  onNeedModel: () => void
  /** abre a transcrição (pra corrigir e pôr prompts); sem caminho, a de todos os arquivos */
  onOpenTranscript?: (path?: string) => void
  /** as outras timelines do projeto (principal e recortes do Criar Clipes), pro "Ler todas" */
  others?: () => MontageData[]
}) {
  const files = speechFiles(data)
  const cache = useReadCache(
    files.map((f) => f.path),
    lang
  )
  const jobs = useWhisperJobs()
  const [open, setOpen] = useState(false)
  const [parallel, setParallel] = useState(2)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    api.whisperParallel().then(setParallel)
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const states = files.map((f) => ({ ...f, s: readState(f.path, lang, cache, jobs) }))
  const done = states.filter((x) => x.s.kind === 'done').length
  const running = states.filter((x) => x.s.kind === 'running' || x.s.kind === 'queued')
  const pending = states.filter((x) => x.s.kind === 'todo' || x.s.kind === 'error')
  const pct = running.length ? (done + running.reduce((a, x) => a + (x.s.kind === 'running' && x.s.job.stage === 'listen' ? x.s.job.pct : 0), 0)) / files.length : null

  const read = (paths: string[]) => {
    if (!ready) return onNeedModel()
    readAudio(paths, lang)
  }
  const allPaths = () => [...new Set([data, ...(others?.() ?? [])].flatMap((d) => speechFiles(d).map((f) => f.path)))]
  const nOthers = others?.().length ?? 0

  if (!files.length) return null
  const all = cache && done === files.length
  return (
    <div className="ar" ref={ref}>
      <button
        className={'btn small ar-btn' + (all ? ' ar-all' : '') + (open ? ' on' : '')}
        title="Ler o áudio da timeline (Whisper) de antemão, em segundo plano: depois o corte automático, os blocos de instrução e o Criar Clipes usam na hora"
        onClick={() => setOpen((o) => !o)}
      >
        {running.length ? <Loader2 size={13} className="spin" /> : all ? <Check size={13} strokeWidth={3} /> : <Ear size={13} />}
        {running.length ? `Lendo o áudio ${Math.round((pct ?? 0) * 100)}%` : all ? 'Áudio lido' : `Ler áudio (${done}/${files.length})`}
        {open ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
      </button>
      {open && (
        <div className="ar-pop">
          <div className="ar-head">
            <b>Áudio desta timeline</b>
            <small>
              {done}/{files.length} lido{files.length > 1 ? 's' : ''}
            </small>
          </div>
          <ul className="ar-list">
            {states.map((x) => (
              <li key={x.path} title={x.path}>
                <StateIcon s={x.s} />
                <span className="ar-name">{x.name}</span>
                <small className={x.s.kind === 'error' ? 'ar-err' : ''} title={x.s.kind === 'error' ? x.s.error : undefined}>
                  {stateText(x.s)}
                </small>
                {x.s.kind === 'done' && onOpenTranscript && (
                  <button
                    className="icon-btn"
                    title="Abrir a transcrição: corrigir palavras e pôr prompts nas falas"
                    onClick={() => {
                      setOpen(false)
                      onOpenTranscript(x.path)
                    }}
                  >
                    <FileText size={11} />
                  </button>
                )}
                {(x.s.kind === 'running' || x.s.kind === 'queued') && (
                  <button className="icon-btn" title="Parar de ler este arquivo" onClick={() => api.whisperCancel(x.path, lang)}>
                    <X size={11} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!ready && <p className="ar-note ar-err">O modelo do Whisper ainda não foi baixado (pasta Narração → Transcrição).</p>}
          <div className="ar-btns">
            <button className="btn small primary" disabled={!pending.length} onClick={() => read(pending.map((x) => x.path))}>
              <Ear size={12} /> {pending.length ? `Ler esta timeline (${pending.length})` : 'Tudo lido'}
            </button>
            {onOpenTranscript && done > 0 && (
              <button
                className="btn small"
                title="Abre a transcrição do que já foi lido: corrigir palavras e pôr prompts nas falas (o bloco de instrução lê junto)"
                onClick={() => {
                  setOpen(false)
                  onOpenTranscript()
                }}
              >
                <FileText size={12} /> Abrir transcrição
              </button>
            )}
            {others && (
              <button
                className="btn small"
                title="Lê o áudio de todas as timelines do projeto: a principal e cada recorte do Criar Clipes"
                onClick={() => read(allPaths())}
              >
                <Layers size={12} /> Ler todas as timelines{nOthers ? ` (${nOthers + 1})` : ''}
              </button>
            )}
          </div>
          <label className="ar-par" title="Quantos arquivos o Whisper lê ao mesmo tempo. Mais = mais rápido no total, mas pesa mais no PC (memória e processador).">
            Ler ao mesmo tempo
            <select
              value={parallel}
              onChange={async (e) => {
                setParallel(await api.whisperParallel(Number(e.target.value)))
              }}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} arquivo{n > 1 ? 's' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="ar-note">Roda em segundo plano: pode fechar isto e continuar usando o Typos. Fica guardado no PC (da próxima vez é na hora).</p>
        </div>
      )}
    </div>
  )
}

/** estado do som de um bloco: 'none' = não tem fala embaixo */
export type BlockHeard = 'none' | 'done' | 'running' | 'todo'

/** pro desenho dos blocos na timeline: o som de cada bloco já foi lido? */
export function useBlockHeard(data: MontageData, lang: string) {
  const blocks = data.blocks ?? []
  const per = new Map(blocks.map((b) => [b.id, blockSpeech(data, b)]))
  const cache = useReadCache([...new Set([...per.values()].flat())], lang)
  const jobs = useWhisperJobs()
  return (b: InstructionBlock): BlockHeard => {
    const paths = per.get(b.id) ?? []
    if (!paths.length) return 'none'
    const st = paths.map((p) => readState(p, lang, cache, jobs).kind)
    if (st.every((k) => k === 'done')) return 'done'
    if (st.some((k) => k === 'running' || k === 'queued')) return 'running'
    return 'todo'
  }
}

/** linha da janela do bloco: "Som do trecho: lido ✓ / lendo 40% / não lido [Ler agora]" */
export function BlockHeardRow({ data, b, lang, onOpen }: { data: MontageData; b: InstructionBlock; lang: string; onOpen?: () => void }) {
  const paths = blockSpeech(data, b)
  const cache = useReadCache(paths, lang)
  const jobs = useWhisperJobs()
  if (!paths.length)
    return (
      <div className="blk-heard-row none">
        Som do trecho: {audioIn(data, b).length ? 'as faixas de áudio daqui estão desarmadas pra escuta' : 'sem fala embaixo deste bloco'}
      </div>
    )
  const states = paths.map((p) => ({ p, s: readState(p, lang, cache, jobs) }))
  const pending = states.filter((x) => x.s.kind === 'todo' || x.s.kind === 'error')
  const run = states.find((x) => x.s.kind === 'running')?.s as { job: WhisperJob } | undefined
  const queued = states.some((x) => x.s.kind === 'queued')
  const ok = cache && states.every((x) => x.s.kind === 'done')
  return (
    <div className={'blk-heard-row' + (ok ? ' ok' : '')} title={states.map((x) => `${nameOf(x.p)}: ${stateText(x.s)}`).join('\n')}>
      {ok ? <Check size={12} strokeWidth={3} /> : run || queued ? <Loader2 size={12} className="spin" /> : <Ear size={12} />}
      <span>
        Som do trecho:{' '}
        {!cache ? '…' : ok ? 'já lido (a prévia não espera o Whisper)' : run ? `lendo ${jobLabel(run.job)}` : queued ? 'na fila do Whisper' : 'ainda não lido'}
      </span>
      {cache && pending.length > 0 && !run && !queued && (
        <button className="btn small" title="Lê o áudio em segundo plano: pode fechar a janela" onClick={() => readAudio(pending.map((x) => x.p), lang)}>
          Ler agora
        </button>
      )}
      {onOpen && states.some((x) => x.s.kind === 'done') && (
        <button className="btn small" title="Abrir o que foi ouvido neste trecho: corrigir palavras e pôr prompts em falas específicas (a prévia lê junto)" onClick={onOpen}>
          <FileText size={12} /> Transcrição
        </button>
      )}
    </div>
  )
}

/** aviso fixo no canto (em qualquer tela) enquanto o Whisper lê arquivos em segundo plano */
export function WhisperJobsChip() {
  const jobs = useWhisperJobs()
  const [open, setOpen] = useState(false)
  const live = jobs.filter((j) => j.state === 'running' || j.state === 'queued')
  const errors = jobs.filter((j) => j.state === 'error' && j.error !== 'Cancelado.')
  // re-desenha a cada segundo pro tempo que falta andar
  const [, tick] = useState(0)
  useEffect(() => {
    if (!live.length) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [live.length > 0])
  if (!live.length && !errors.length) return null
  const run = live.filter((j) => j.state === 'running')
  return (
    <div className={'wj-chip' + (open ? ' open' : '')}>
      <button className="wj-head" onClick={() => setOpen((o) => !o)} title="Leitura do áudio (Whisper) em segundo plano">
        {live.length ? <Loader2 size={13} className="spin" /> : <AlertTriangle size={13} className="ar-err" />}
        <span>
          {live.length
            ? `Lendo o áudio: ${run.length} agora${live.length > run.length ? `, ${live.length - run.length} na fila` : ''}`
            : `${errors.length} leitura${errors.length > 1 ? 's' : ''} falhou`}
        </span>
        {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
      </button>
      {!open && run[0] && (
        <div className="mt-bar">
          <i style={{ width: `${Math.round((run[0].stage === 'listen' ? run[0].pct : 0) * 100)}%` }} />
        </div>
      )}
      {open && (
        <ul className="ar-list">
          {[...live, ...errors].map((j) => {
            const s: ReadState = j.state === 'running' ? { kind: 'running', job: j } : j.state === 'queued' ? { kind: 'queued' } : { kind: 'error', error: j.error ?? '' }
            return (
              <li key={j.path + j.lang} title={j.path}>
                <StateIcon s={s} />
                <span className="ar-name">{nameOf(j.path)}</span>
                <small className={j.state === 'error' ? 'ar-err' : ''} title={j.error}>
                  {stateText(s)}
                </small>
                {j.state !== 'error' && (
                  <button className="icon-btn" title="Parar de ler" onClick={() => api.whisperCancel(j.path, j.lang)}>
                    <X size={11} />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {open && (
        <div className="ar-btns">
          {live.length > 0 && (
            <button className="btn small" onClick={() => api.whisperCancel()}>
              Parar tudo
            </button>
          )}
          {errors.length > 0 && (
            <button className="btn small" onClick={() => api.whisperClearErrors()}>
              Limpar avisos
            </button>
          )}
        </div>
      )}
    </div>
  )
}
