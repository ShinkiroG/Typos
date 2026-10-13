import { useEffect, useMemo, useRef, useState } from 'react'
import { Clapperboard, CheckCircle2, XCircle, Loader2, RefreshCw, Mic, Film, AudioLines, FolderOpen, Square, Sparkles, Music, Boxes, RotateCcw, Play, Type } from 'lucide-react'
import { api, fileUrl, RESOLUTIONS, type Format, type MontageData } from '../lib'
import { planRender } from './plan'
import './render.css'

/**
 * Workspace Render: o Typos compila a timeline de montagem aqui no PC (ffmpeg, sem IA). Entra o que
 * está na timeline: cortes de vídeo e imagens (faixa de cima cobre a de baixo), fades e crossfades,
 * o mix das faixas de áudio, os clipes de motion aprovados e os letterings dos capítulos.
 * Aqui dá pra conferir se os arquivos estão acessíveis, escolher a qualidade e criar o vídeo.
 */

interface Props {
  active: boolean
  dir: string
  format?: Format
  montage: MontageData
  save: () => Promise<void>
}

type Check = { path: string; ok: boolean; files?: number; error?: string }

const QUALITY_KEY = 'typos.renderQuality'
/** short: só 30 s de vídeo (a partir de `from`, "m:ss") pra conferir rápido */
type Quality = { pct: number; fps: number; short: boolean; from: string }
const loadQuality = (): Quality => {
  const def: Quality = { pct: 50, fps: 30, short: false, from: '0:00' }
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(QUALITY_KEY) || '{}') }
  } catch {
    return def
  }
}

const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
/** tempo restante, legível */
const fmtEta = (s: number) => (s < 60 ? 'menos de 1 min' : s < 3600 ? `~${Math.round(s / 60)} min` : `~${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`)
type Progress = { phase: 'letterings' | 'partes' | 'final'; pct: number; eta: number | null; steps: { id: string; label: string; done: boolean }[]; resumed: number }
type Resume = Awaited<ReturnType<typeof api.renderStatus>>
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

export function RenderStudio({ active, dir, format, montage, save }: Props) {
  const [quality, setQuality] = useState(loadQuality)
  const [checks, setChecks] = useState<Record<string, Check>>({})
  const [checking, setChecking] = useState(false)
  const [job, setJob] = useState<{ busy: boolean; log: { kind: string; text: string }[]; t0: number; path?: string; summary?: string; error?: string; seconds?: number } | null>(null)
  const [now, setNow] = useState(Date.now())
  const [prog, setProg] = useState<Progress | null>(null)
  /** o que uma rodada anterior deixou pronto (pra "Continuar") */
  const [resume, setResume] = useState<Resume>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(QUALITY_KEY, JSON.stringify(quality))
    } catch {
      /* sem storage: só não lembra */
    }
  }, [quality])

  useEffect(() => {
    if (active && !job?.busy) api.renderStatus(dir).then(setResume)
  }, [active])

  // ---------- resolução ----------
  const [baseW, baseH] = (RESOLUTIONS[format?.aspect ?? '16:9'] ?? '1920×1080').split('×').map(Number)
  const fullHd = (() => {
    const k = 1080 / Math.min(baseW, baseH)
    return [even(baseW * k), even(baseH * k)]
  })()
  const fromSec = (() => {
    const m = quality.from.trim().match(/^(?:(\d+):)?(\d+(?:[.,]\d+)?)$/)
    return m ? Number(m[1] ?? 0) * 60 + Number(m[2].replace(',', '.')) : 0
  })()
  const [outW, outH] = quality.pct === -1 ? fullHd : [even((baseW * quality.pct) / 100), even((baseH * quality.pct) / 100)]

  // ---------- o plano: o que está na timeline, em partes ----------
  const plan = useMemo(
    () => planRender(montage, { from: quality.short ? fromSec : 0, to: quality.short ? fromSec + 30 : Infinity, width: outW, height: outH, fps: quality.fps, format }),
    [montage, quality.short, fromSec, outW, outH, quality.fps, format]
  )
  const finalFile = `video-${outW}x${outH}${quality.short ? `-30s-${fmtT(fromSec).replace(':', 'm')}` : ''}.mp4`

  // ---------- checklist: o que entra no vídeo, num olhar ----------
  type CheckState = 'ok' | 'bad' | 'checking' | 'none'
  const checklist = useMemo(() => {
    const binById = new Map(montage.bins.map((b) => [b.id, b]))
    const roleOf = (binId: string) => {
      let cur = binById.get(binId)
      for (let i = 0; cur?.parent && i < 20; i++) cur = binById.get(cur.parent)
      return cur?.role
    }
    const mediaById = new Map(montage.media.map((m) => [m.id, m]))
    const kind = new Map(montage.tracks.map((t) => [t.id, t.kind]))
    // faixa silenciada não entra (ex.: gravação original ao lado do corte automático)
    const mutedTr = new Set(montage.tracks.filter((t) => t.muted).map((t) => t.id))
    const live = montage.clips.filter((c) => !mutedTr.has(c.track))
    const used = (pred: (c: (typeof live)[number], m: (typeof montage.media)[number]) => boolean) =>
      live.filter((c) => mediaById.get(c.media) && pred(c, mediaById.get(c.media)!))
    const uniq = (cs: typeof live) => [...new Set(cs.map((c) => mediaById.get(c.media)!.path))]
    const motion = used((c, m) => kind.get(c.track) === 'video' && m.bin === 'motion')
    const video = used((c, m) => kind.get(c.track) === 'video' && m.kind !== 'audio' && m.bin !== 'motion')
    const narr = used((c, m) => m.hasAudio && !c.audioOff && roleOf(m.bin) === 'narration')
    const narrDur = narr.reduce((s, c) => s + c.out - c.in, 0)
    const music = used((c, m) => m.hasAudio && !c.audioOff && kind.get(c.track) === 'audio' && roleOf(m.bin) !== 'narration' && roleOf(m.bin) !== 'sfx')
    const sfx = used((c, m) => m.hasAudio && !c.audioOff && roleOf(m.bin) === 'sfx')
    return [
      { id: 'video', label: 'Vídeos e imagens', icon: <Film size={18} />, count: video.length, detail: `${video.length} cortes · ${uniq(video).length} arquivos`, paths: uniq(video), required: false },
      { id: 'motion', label: 'Clipes de motion', icon: <Boxes size={18} />, count: motion.length, detail: plan.pendingBlocks ? `${motion.length} aprovados · ${plan.pendingBlocks} blocos sem aprovar` : `${motion.length} aprovados`, paths: uniq(motion), required: false },
      { id: 'narration', label: 'Narração', icon: <Mic size={18} />, count: narr.length, detail: narr.length ? `${narr.length} cortes · ${fmtT(narrDur)}` : 'grave ou importe na Montagem', paths: uniq(narr), required: true },
      { id: 'music', label: 'Músicas', icon: <Music size={18} />, count: music.length, detail: `${music.length} cortes na timeline`, paths: uniq(music), required: false },
      { id: 'sfx', label: 'Efeitos sonoros', icon: <AudioLines size={18} />, count: sfx.length, detail: `${sfx.length} na timeline`, paths: uniq(sfx), required: false },
      { id: 'lettering', label: 'Letterings', icon: <Type size={18} />, count: plan.letterings.length, detail: `${plan.letterings.length} capítulos marcados`, paths: [] as string[], required: false }
    ]
  }, [montage, plan])

  const checkPaths = useMemo(() => [...new Set(checklist.flatMap((c) => c.paths))], [checklist])
  const runChecks = async () => {
    setChecking(true)
    try {
      const r = await api.renderCheck(checkPaths)
      setChecks((c) => ({ ...c, ...Object.fromEntries(r.map((x) => [x.path, x])) }))
    } catch (e) {
      setChecks((c) => ({ ...c, ...Object.fromEntries(checkPaths.filter((p) => !c[p]).map((p) => [p, { path: p, ok: false, error: String(e) }])) }))
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    if (active) runChecks()
  }, [active, checkPaths.join('|')])
  const bad = checkPaths.filter((p) => checks[p] && !checks[p].ok)

  // ---------- criar vídeo ----------
  useEffect(() => {
    api.onRenderProgress((ev) => setJob((j) => (j ? { ...j, log: [...j.log, ev].slice(-300) } : j)))
    api.onRenderState(setProg)
  }, [])
  useEffect(() => {
    if (!job?.busy) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [job?.busy])
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [job?.log.length])

  const create = async (fresh = false) => {
    if (fresh && !confirm('Recomeçar do zero? As partes já prontas do render anterior são apagadas.')) return
    if (bad.length && !confirm(`${bad.length} arquivo(s) da timeline não estão acessíveis e vão sair pretos ou mudos. Criar mesmo assim?`)) return
    await save()
    setJob({ busy: true, log: [], t0: Date.now() })
    setProg(null)
    const r = await api.renderStart({ dir, width: outW, height: outH, fps: quality.fps, finalFile, parts: plan.parts, letterings: plan.letterings, fresh })
    setJob((j) => ({ ...(j ?? { log: [], t0: Date.now() }), busy: false, ...('error' in r ? { error: r.error } : r) }))
    api.renderStatus(dir).then(setResume)
  }

  const stateOf = (c: (typeof checklist)[number]): CheckState => {
    if (!c.count) return 'none'
    if (c.paths.some((p) => !checks[p])) return 'checking'
    return c.paths.some((p) => !checks[p].ok) ? 'bad' : 'ok'
  }
  const STATE_LABEL: Record<CheckState, string> = { ok: 'OK', bad: 'sem acesso', checking: 'conferindo', none: 'nenhum' }
  const readyCount = checklist.filter((c) => stateOf(c) === 'ok').length

  const [rw, rh] = (format?.aspect ?? '16:9').split(':').map(Number)
  const lastLine = job?.log.length ? job.log[job.log.length - 1].text : 'Preparando…'
  const phaseLabel = (p: Progress) =>
    p.phase === 'letterings' ? 'gravando os letterings' : p.phase === 'final' ? 'juntando as partes' : `${p.steps.filter((x) => x.done).length}/${p.steps.length} etapas`

  return (
    <div className="render-studio v2">
      <header className="rn-head">
        <div>
          <h2>
            <Clapperboard size={20} /> Render
          </h2>
          <p className="muted">O Typos compila a timeline de montagem aqui no PC: o vídeo sai igual ao que você montou.</p>
        </div>
        <button className="btn small" onClick={runChecks} disabled={checking} title="Confere de novo se cada arquivo da timeline está acessível">
          {checking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Verificar acessos
        </button>
      </header>

      {/* ---------- checklist ---------- */}
      <section className="rn-checklist">
        {checklist.map((c, i) => {
          const st = stateOf(c)
          return (
            <div key={c.id} className={'rn-check ' + st + (c.required && st === 'none' ? ' missing' : '')} style={{ animationDelay: `${i * 0.06}s` }}>
              <span className="rn-check-icon">{c.icon}</span>
              <div className="rn-check-text">
                <b>{c.label}</b>
                <small>{c.detail}</small>
              </div>
              <span className="rn-check-state">
                {st === 'ok' ? <CheckCircle2 size={16} /> : st === 'bad' ? <XCircle size={16} /> : st === 'checking' ? <Loader2 size={15} className="spin" /> : null}
                {c.required && st === 'none' ? 'faltando' : STATE_LABEL[st]}
              </span>
            </div>
          )
        })}
        <div className="rn-check-bar" title={`${readyCount} de ${checklist.length} OK`}>
          <i style={{ width: `${(readyCount / checklist.length) * 100}%` }} />
        </div>
      </section>

      {/* ---------- palco: vídeo + controles ---------- */}
      <section className="rn-stage">
        <div className="rn-screen-wrap">
          <div className="rn-screen" style={{ aspectRatio: `${rw} / ${rh}`, width: `min(100%, calc(52vh * ${rw / rh}))` }}>
            {job && !job.busy && job.path ? (
              <video key={job.path + (job.seconds ?? '')} src={fileUrl(job.path)} controls />
            ) : job?.busy ? (
              <div className="rn-screen-busy">
                <div className="rn-scan" />
                <Loader2 size={30} className="spin" />
                <b>Compilando o vídeo… {fmtT((now - job.t0) / 1000)}</b>
                {prog && (
                  <div className="rn-progress">
                    <div className="rn-progress-bar">
                      <i style={{ width: `${Math.round(prog.pct * 100)}%` }} />
                    </div>
                    <span>
                      {Math.round(prog.pct * 100)}% · {phaseLabel(prog)} · {prog.eta === null ? 'calculando o tempo…' : 'falta ' + fmtEta(prog.eta)}
                    </span>
                  </div>
                )}
                <small>{lastLine}</small>
              </div>
            ) : (
              <div className="rn-screen-empty">
                <Clapperboard size={34} />
                <span>O vídeo aparece aqui</span>
                <small>
                  {outW}×{outH} · {quality.fps} fps{quality.short ? ` · 30 s a partir de ${fmtT(fromSec)}` : ` · ${fmtT(plan.total)}`}
                </small>
              </div>
            )}
          </div>
          {job && !job.busy && job.path && (
            <div className="rn-chips rn-screen-foot">
              <button className="btn small" onClick={() => api.showItem(job.path!)}>
                <FolderOpen size={13} /> Mostrar na pasta
              </button>
              <span className="muted small">pronto em {fmtT(job.seconds ?? 0)}</span>
            </div>
          )}
        </div>

        <aside className="rn-side">
          <section className="rn-card">
            <h3>Qualidade</h3>
            <div className="rn-res">
              {outW}×{outH}
              <small>{quality.pct === -1 ? 'Full HD' : `${quality.pct}% de ${baseW}×${baseH}`}</small>
            </div>
            <input
              type="range"
              min={25}
              max={100}
              step={5}
              value={quality.pct === -1 ? 100 : quality.pct}
              onChange={(e) => setQuality((q) => ({ ...q, pct: Number(e.target.value) }))}
            />
            <div className="rn-chips">
              {[25, 50, 75, 100].map((p) => (
                <button key={p} className={'rn-chip' + (quality.pct === p ? ' on' : '')} onClick={() => setQuality((q) => ({ ...q, pct: p }))}>
                  {p}%
                </button>
              ))}
              <button className={'rn-chip' + (quality.pct === -1 ? ' on' : '')} onClick={() => setQuality((q) => ({ ...q, pct: -1 }))} title={`${fullHd[0]}×${fullHd[1]}`}>
                Full HD
              </button>
            </div>
            <div className="rn-fps">
              Duração
              <div className="rn-chips">
                <button className={'rn-chip' + (!quality.short ? ' on' : '')} onClick={() => setQuality((q) => ({ ...q, short: false }))}>
                  Vídeo inteiro
                </button>
                <button className={'rn-chip' + (quality.short ? ' on' : '')} onClick={() => setQuality((q) => ({ ...q, short: true }))} title="Só 30 segundos: bem mais rápido pra conferir">
                  30 s
                </button>
              </div>
            </div>
            {quality.short && (
              <label className="rn-fps">
                A partir de
                <input
                  className="rn-from"
                  value={quality.from}
                  placeholder="0:00"
                  onChange={(e) => setQuality((q) => ({ ...q, from: e.target.value }))}
                  title={`De ${fmtT(fromSec)} a ${fmtT(fromSec + 30)}`}
                />
              </label>
            )}
            <label className="rn-fps">
              Quadros por segundo
              <select value={quality.fps} onChange={(e) => setQuality((q) => ({ ...q, fps: Number(e.target.value) }))}>
                {[24, 30, 60].map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="rn-card rn-go">
            {bad.length > 0 && !job?.busy && (
              <p className="rn-warn">
                <XCircle size={13} /> {bad.length} arquivo(s) sem acesso: saem pretos ou mudos.
              </p>
            )}
            {plan.pendingBlocks > 0 && !job?.busy && (
              <p className="rn-warn">
                <Boxes size={13} /> {plan.pendingBlocks} bloco(s) de instrução ainda sem aprovar: não entram no vídeo. Aprove a prévia na Montagem pra virar clipe.
              </p>
            )}
            {!plan.parts.length && !job?.busy && (
              <p className="rn-warn">
                <XCircle size={13} /> A timeline de montagem está vazia: é ela que vira o vídeo.
              </p>
            )}
            {job?.busy ? (
              <button className="btn small rn-cancel" onClick={() => api.renderCancel()} title="Para agora. As partes que já ficaram prontas são guardadas e dá pra continuar depois.">
                <Square size={12} /> Cancelar
              </button>
            ) : resume && resume.status !== 'pronto' && resume.done > 0 ? (
              <>
                <button className="rn-create" onClick={() => create()} disabled={!plan.parts.length} title="Reaproveita as partes prontas que não mudaram na timeline">
                  <Play size={18} /> Continuar ({Math.round(resume.pct * 100)}% pronto)
                </button>
                <button className="btn small" onClick={() => create(true)} disabled={!plan.parts.length}>
                  <RotateCcw size={12} /> Recomeçar do zero
                </button>
              </>
            ) : (
              <button className="rn-create" onClick={() => create()} disabled={!plan.parts.length}>
                <Sparkles size={18} /> Criar Vídeo
              </button>
            )}
            {job?.busy && prog && (
              <ul className="rn-steps">
                {prog.steps.map((x) => (
                  <li key={x.id} className={x.done ? 'done' : ''}>
                    {x.done ? <CheckCircle2 size={12} /> : <span className="rn-step-dot" />} {x.label}
                  </li>
                ))}
              </ul>
            )}
            {job && (
              <div className="rn-log" ref={logRef}>
                {job.log.map((l, i) => (
                  <div key={i} className={'rn-ev ' + l.kind}>
                    {l.text}
                  </div>
                ))}
                {job.error && <div className="rn-ev error">{job.error}</div>}
                {!job.busy && !job.error && job.summary && <div className="rn-ev say">{job.summary}</div>}
              </div>
            )}
          </section>
        </aside>
      </section>

      {/* ---------- o que entra no vídeo, faixa por faixa ---------- */}
      <h3 className="rn-section-title">O que entra no vídeo</h3>
      <div className="rn-grid">
        {montage.tracks.map((t) => {
          const clips = montage.clips.filter((c) => c.track === t.id).sort((a, b) => a.start - b.start)
          const names = [...new Set(clips.map((c) => montage.media.find((m) => m.id === c.media)?.name ?? '?'))]
          return (
            <section key={t.id} className={'rn-group' + (t.muted || !clips.length ? ' off' : '')}>
              <div className="rn-ghead">
                <span className="rn-gicon">{t.kind === 'video' ? <Film size={15} /> : <AudioLines size={15} />}</span>
                <b>{t.name}</b>
              </div>
              <span className="rn-gsum">{t.muted ? 'muda: não entra' : `${clips.length} cortes${t.kind === 'video' && clips.some((c) => c.audioOff) ? ' · alguns sem som' : ''}`}</span>
              {!!names.length && !t.muted && (
                <ul className="rn-items">
                  {names.slice(0, 30).map((nm) => (
                    <li key={nm}>
                      <span className="rn-iname">{nm}</span>
                    </li>
                  ))}
                  {names.length > 30 && <li className="muted">… e mais {names.length - 30}</li>}
                </ul>
              )}
            </section>
          )
        })}
        {plan.letterings.length > 0 && (
          <section className="rn-group">
            <div className="rn-ghead">
              <span className="rn-gicon">
                <Type size={15} />
              </span>
              <b>Letterings</b>
            </div>
            <span className="rn-gsum">por cima de tudo, com as fontes e cores do formato</span>
            <ul className="rn-items">
              {plan.letterings.map((l) => (
                <li key={l.id}>
                  <span className="rn-iname">{l.label}</span>
                  <span className="rn-note">
                    {fmtT(l.t)} · {l.dur.toFixed(1)} s
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
