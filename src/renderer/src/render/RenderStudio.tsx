import { useEffect, useMemo, useRef, useState } from 'react'
import { Clapperboard, CheckCircle2, XCircle, Loader2, RefreshCw, Mic, Film, AudioLines, FolderOpen, Square, Music, Boxes, RotateCcw, Play, Type, Scissors, Clock, ListOrdered, FolderOutput, X } from 'lucide-react'
import { api, fileUrl, queueRenderItems, RESOLUTIONS, shortRenderId, type Format, type MontageData, type RenderItemId, type RenderSettings, type ShortClip, type ShortsData } from '../lib'
import { planRender } from './plan'
import { shortDuration, shortKey, slug } from '../shorts/shorts'
import './render.css'

/**
 * Workspace Render: o Typos compila a timeline de montagem aqui no PC (ffmpeg, sem IA). Entra o que
 * está na timeline: cortes de vídeo e imagens (faixa de cima cobre a de baixo), fades e crossfades,
 * o mix das faixas de áudio, os clipes de motion aprovados e os letterings dos capítulos.
 * Cada vídeo (o principal e os recortes aprovados) aparece na fila: clica pra ver a prévia,
 * renderiza só um ou todos em sequência, e o pronto vai pra pasta de export.
 */

interface Props {
  active: boolean
  dir: string
  /** nome do roteiro (vira o nome do arquivo exportado) */
  title: string
  format?: Format
  /** formato dos recortes (o do Criar Clipes; vazio = o mesmo da Montagem) */
  shortsFormat?: Format
  montage: MontageData
  save: () => Promise<void>
  /** recortes do Criar Clipes: os aprovados aparecem na fila */
  shorts?: ShortsData
  patchShort?: (id: string, p: Partial<ShortClip>) => void
  /** a fila e a pasta de export (salvas no projeto) */
  render: RenderSettings
  onRender: (fn: (r: RenderSettings) => RenderSettings) => void
}

/** o estado de um item nesta sessão (o que está esperando de verdade é a fila salva no projeto) */
type RunState = { status: 'esperando' | 'rodando' | 'pronto' | 'erro'; error?: string; path?: string }
type Row = {
  id: RenderItemId
  kind: 'main' | 'short'
  shortId?: string
  label: string
  detail: string
  aspect: string
  queued: boolean
  /** último arquivo pronto (e ainda atual) */
  done?: string
  /** já saiu antes, mas a timeline mudou depois */
  changed?: boolean
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

export function RenderStudio({ active, dir, title, format, shortsFormat, montage, save, shorts, patchShort, render, onRender }: Props) {
  const [quality, setQuality] = useState(loadQuality)
  const [checks, setChecks] = useState<Record<string, Check>>({})
  const [checking, setChecking] = useState(false)
  const [job, setJob] = useState<{
    busy: boolean
    log: { kind: string; text: string }[]
    t0: number
    path?: string
    summary?: string
    error?: string
    seconds?: number
    /** o que está saindo (na fila) e a proporção dele */
    label?: string
    aspect?: string
  } | null>(null)
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

  // ---------- fila: o vídeo principal e os recortes aprovados ----------
  const queue = render.queue ?? []
  const approved = (shorts?.items ?? []).filter((x) => x.approved)
  const isFresh = (x: ShortClip) => !!x.exported && x.exported.key === shortKey(x)
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    if (montage.clips.length)
      out.push({
        id: 'main',
        kind: 'main',
        label: 'Vídeo principal',
        detail: `${fmtT(plan.total)} · ${format?.aspect ?? '16:9'}`,
        aspect: format?.aspect ?? '16:9',
        queued: queue.includes('main'),
        done: render.mainExport?.path
      })
    for (const x of approved) {
      const id = shortRenderId(x.id)
      out.push({
        id,
        kind: 'short',
        shortId: x.id,
        label: x.title,
        detail: `${Math.round(shortDuration(x))} s · ${shorts?.aspect ?? '9:16'}`,
        aspect: shorts?.aspect ?? '9:16',
        queued: queue.includes(id),
        done: isFresh(x) ? x.exported!.path : undefined,
        changed: !!x.exported && !isFresh(x)
      })
    }
    // a ordem da fila manda; quem não está na fila vem depois
    const pos = (r: Row) => (r.queued ? queue.indexOf(r.id) : 1e6 + out.indexOf(r))
    return out.sort((a, b) => pos(a) - pos(b))
  }, [montage.clips.length, plan.total, format?.aspect, approved, shorts?.aspect, queue.join('|'), render.mainExport?.path])
  const queuedRows = rows.filter((r) => r.queued)

  const [sel, setSel] = useState<RenderItemId>('main')
  const cur = rows.find((r) => r.id === sel) ?? rows[0]
  const [run, setRun] = useState<Record<string, RunState>>({})
  const setRunOf = (id: string, p: RunState | null) =>
    setRun((m) => {
      const n = { ...m }
      if (p) n[id] = p
      else delete n[id]
      return n
    })

  // os arquivos prontos ainda existem? (prévia)
  const [exists, setExists] = useState<Record<string, boolean>>({})
  const donePaths = rows.map((r) => run[r.id]?.path ?? r.done).filter((p): p is string => !!p)
  useEffect(() => {
    if (!active || !donePaths.length) return
    api.renderExists(donePaths).then((ok) => setExists((e) => ({ ...e, ...Object.fromEntries(donePaths.map((p, i) => [p, ok[i]])) })))
  }, [active, donePaths.join('|')])

  const shortsRef = useRef(shorts)
  shortsRef.current = shorts
  const renderRef = useRef(render)
  renderRef.current = render
  const running = useRef(false)
  const stopQueue = useRef(false)
  /** o que falta rodar nesta rodada, na ordem */
  const runList = useRef<{ id: RenderItemId; fresh?: boolean }[]>([])
  const runningId = useRef<RenderItemId | null>(null)
  const qualityRef = useRef({ outW, outH, fps: quality.fps, pct: quality.pct, short: quality.short, plan, finalFile })
  qualityRef.current = { outW, outH, fps: quality.fps, pct: quality.pct, short: quality.short, plan, finalFile }

  /** resolução do recorte: a mesma qualidade escolhida, na proporção dele */
  const shortSize = (aspect: string, pct: number) => {
    const [w, h] = (RESOLUTIONS[aspect] ?? '1080×1920').split('×').map(Number)
    return pct === -1 ? [even(w), even(h)] : [even((w * pct) / 100), even((h * pct) / 100)]
  }

  const specFor = (id: RenderItemId, fresh?: boolean) => {
    const q = qualityRef.current
    // os 30 s de conferência não vão pra pasta de export
    const exportDir = q.short ? undefined : renderRef.current.exportDir || undefined
    if (id === 'main') {
      const name = `${slug(title || 'video')}-${q.outW}x${q.outH}.mp4`
      return {
        label: 'Vídeo principal',
        aspect: format?.aspect ?? '16:9',
        job: { dir, width: q.outW, height: q.outH, fps: q.fps, finalFile: q.finalFile, parts: q.plan.parts, letterings: q.plan.letterings, fresh, exportDir, exportName: name }
      }
    }
    const sd = shortsRef.current
    const sh = sd?.items.find((x) => shortRenderId(x.id) === id)
    if (!sd || !sh) return { error: 'O recorte não existe mais.' }
    const [w, h] = shortSize(sd.aspect, q.pct)
    const p = planRender(sh.montage, { from: 0, to: Infinity, width: w, height: h, fps: q.fps, format: shortsFormat ?? format })
    if (!p.parts.length) return { error: 'A timeline do recorte está vazia.' }
    const name = slug(sh.title)
    return {
      label: sh.title,
      aspect: sd.aspect,
      shortId: sh.id,
      key: shortKey(sh),
      job: { dir, width: w, height: h, fps: q.fps, finalFile: `${name}-${w}x${h}.mp4`, parts: p.parts, letterings: p.letterings, sub: `clipes/${name}-${sh.id}`, fit: 'cover' as const, exportDir, exportName: `${name}-${w}x${h}.mp4` }
    }
  }

  const runItems = async (items: { id: RenderItemId; fresh?: boolean }[]) => {
    const add = items.filter((n) => !runList.current.some((x) => x.id === n.id) && runningId.current !== n.id)
    runList.current.push(...add)
    add.forEach((n) => setRunOf(n.id, { status: 'esperando' }))
    if (running.current) return
    running.current = true
    stopQueue.current = false
    await save()
    while (!stopQueue.current && runList.current.length) {
      const it = runList.current.shift()!
      runningId.current = it.id
      setRunOf(it.id, { status: 'rodando' })
      const spec = specFor(it.id, it.fresh)
      if ('error' in spec) {
        setRunOf(it.id, { status: 'erro', error: spec.error })
        continue
      }
      setJob({ busy: true, log: [], t0: Date.now(), label: spec.label, aspect: spec.aspect })
      setProg(null)
      const r = await api.renderStart(spec.job)
      setJob((j) => ({ ...(j ?? { log: [], t0: Date.now() }), busy: false, ...('error' in r ? { error: r.error } : r) }))
      if ('error' in r) {
        // cancelado: continua na fila (as partes prontas são reaproveitadas na próxima)
        setRunOf(it.id, stopQueue.current ? null : { status: 'erro', error: r.error })
      } else {
        setRunOf(it.id, { status: 'pronto', path: r.path })
        const short = qualityRef.current.short
        // a conferência de 30 s não tira o vídeo da fila
        if (!short) onRender((x) => ({ ...queueRenderItems(x, [it.id], false), ...(it.id === 'main' && r.path ? { mainExport: { path: r.path, at: new Date().toISOString() } } : {}) }))
        else if (it.id === 'main' && r.path) onRender((x) => ({ ...x, mainExport: { path: r.path!, at: new Date().toISOString() } }))
        if ('shortId' in spec && r.path && !short) patchShort?.(spec.shortId!, { exported: { path: r.path, key: spec.key!, at: new Date().toISOString() } })
      }
    }
    runningId.current = null
    // cancelou: quem estava esperando volta pro estado da fila
    runList.current.forEach((x) => setRunOf(x.id, null))
    runList.current = []
    running.current = false
    api.renderStatus(dir).then(setResume)
  }

  const confirmBad = (ids: RenderItemId[]) =>
    !ids.includes('main') || !bad.length || confirm(`${bad.length} arquivo(s) da timeline não estão acessíveis e vão sair pretos ou mudos. Renderizar mesmo assim?`)

  /** renderiza só o selecionado (fresh: joga fora as partes prontas) */
  const renderOne = (id: RenderItemId, fresh = false) => {
    if (fresh && !confirm('Recomeçar do zero? As partes já prontas do render anterior são apagadas.')) return
    if (!confirmBad([id])) return
    runItems([{ id, fresh }])
  }
  /** renderiza tudo o que está na fila, um depois do outro */
  const renderAll = () => {
    const ids = queuedRows.map((r) => r.id)
    if (!ids.length || !confirmBad(ids)) return
    runItems(ids.map((id) => ({ id })))
  }
  const toggleQueue = (id: RenderItemId, on: boolean) => onRender((r) => queueRenderItems(r, [id], on))
  const pickExport = async () => {
    const d = await api.renderPickDir(render.exportDir)
    if (d) onRender((r) => ({ ...r, exportDir: d }))
  }

  const cancel = () => {
    stopQueue.current = true
    api.renderCancel()
  }

  const stateOf = (c: (typeof checklist)[number]): CheckState => {
    if (!c.count) return 'none'
    if (c.paths.some((p) => !checks[p])) return 'checking'
    return c.paths.some((p) => !checks[p].ok) ? 'bad' : 'ok'
  }
  const STATE_LABEL: Record<CheckState, string> = { ok: 'OK', bad: 'sem acesso', checking: 'conferindo', none: 'nenhum' }
  const readyCount = checklist.filter((c) => stateOf(c) === 'ok').length

  const curRun = cur ? run[cur.id] : undefined
  const curBusy = !!job?.busy && curRun?.status === 'rodando'
  const curPath = curRun?.path ?? cur?.done
  const curFile = curPath && exists[curPath] !== false ? curPath : undefined
  const curSize = cur?.kind === 'short' ? shortSize(cur.aspect, quality.pct) : [outW, outH]
  const [rw, rh] = ((curBusy ? job?.aspect : cur?.aspect) ?? format?.aspect ?? '16:9').split(':').map(Number)
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

      {/* ---------- palco: prévia + fila | qualidade + renderizar ---------- */}
      <section className="rn-stage">
        <div className="rn-main">
          <div className="rn-screen-wrap">
            <div className="rn-screen" style={{ aspectRatio: `${rw} / ${rh}`, width: `min(100%, calc(42vh * ${rw / rh}))` }}>
              {curBusy ? (
                <div className="rn-screen-busy">
                  <div className="rn-scan" />
                  <Loader2 size={30} className="spin" />
                  <b>
                    {job!.label && job!.label !== 'Vídeo principal' ? `Renderizando "${job!.label}"` : 'Compilando o vídeo'}… {fmtT((now - job!.t0) / 1000)}
                  </b>
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
              ) : curFile ? (
                <video key={curFile + (job?.seconds ?? '')} src={fileUrl(curFile)} controls />
              ) : (
                <div className="rn-screen-empty">
                  <Clapperboard size={34} />
                  <span>{cur ? `${cur.label}: ainda não renderizado` : 'O vídeo aparece aqui'}</span>
                  <small>
                    {cur?.kind === 'short'
                      ? `${curSize[0]}×${curSize[1]} · ${quality.fps} fps · ${cur.detail}`
                      : `${outW}×${outH} · ${quality.fps} fps${quality.short ? ` · 30 s a partir de ${fmtT(fromSec)}` : ` · ${fmtT(plan.total)}`}`}
                  </small>
                  {cur?.changed && <small>a timeline mudou depois do último render</small>}
                </div>
              )}
            </div>
            {curFile && !curBusy && (
              <div className="rn-chips rn-screen-foot">
                <button className="btn small" onClick={() => api.showItem(curFile)}>
                  <FolderOpen size={13} /> Mostrar na pasta
                </button>
                <span className="muted small rn-path" title={curFile}>
                  {curFile}
                </span>
              </div>
            )}
          </div>

          {/* ---------- fila ---------- */}
          <section className="rn-card rn-queue">
            <div className="rn-queue-head">
              <h3>
                <ListOrdered size={14} /> Fila de render
              </h3>
              <span className="muted small">
                {queuedRows.length} na fila{rows.length > queuedRows.length ? ` · ${rows.length - queuedRows.length} fora` : ''}
              </span>
            </div>
            {rows.length ? (
              <ul className="rn-qlist">
                {rows.map((r) => {
                  const rs = run[r.id]
                  const st = rs?.status ?? (r.queued ? 'pendente' : r.done ? 'pronto' : 'fora')
                  const label =
                    st === 'rodando'
                      ? 'renderizando'
                      : st === 'esperando'
                        ? 'na vez'
                        : st === 'erro'
                          ? 'erro'
                          : st === 'pronto'
                            ? 'pronto'
                            : st === 'pendente'
                              ? r.changed
                                ? 'mudou: na fila de novo'
                                : 'na fila'
                              : r.changed
                                ? 'mudou depois do render'
                                : 'fora da fila'
                  return (
                    <li key={r.id} className={'rn-q ' + st + (r.id === cur?.id ? ' sel' : '')} title={rs?.error ?? 'Clique pra ver a prévia'} onClick={() => setSel(r.id)}>
                      <input
                        type="checkbox"
                        checked={r.queued}
                        title={r.queued ? 'Na fila: sai no "Renderizar todos". Desmarque pra tirar.' : 'Pôr na fila'}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => toggleQueue(r.id, e.target.checked)}
                      />
                      <QState s={st} />
                      {r.kind === 'main' ? <Film size={13} className="muted" /> : <Scissors size={13} className="muted" />}
                      <span className="rn-qname">{r.label}</span>
                      <small>
                        {r.detail} · {label}
                      </small>
                      <button
                        className="icon-btn"
                        title="Renderizar só este agora"
                        disabled={st === 'rodando' || st === 'esperando'}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSel(r.id)
                          renderOne(r.id)
                        }}
                      >
                        <Play size={13} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="muted small">Nada pra renderizar ainda: monte a timeline na Montagem (ou aprove recortes no Criar Clipes).</p>
            )}
            <div className="rn-export">
              <FolderOutput size={14} />
              <span className="rn-export-path" title={render.exportDir || 'Sem pasta de export: o vídeo fica em render/, dentro da pasta do roteiro'}>
                {render.exportDir || 'Exporta em render/ (pasta do roteiro)'}
              </span>
              <button className="btn small" onClick={pickExport} title="Escolher a pasta onde os vídeos prontos são salvos">
                Escolher pasta
              </button>
              {render.exportDir && (
                <>
                  <button className="icon-btn" title="Abrir a pasta de export" onClick={() => api.openPath(render.exportDir!)}>
                    <FolderOpen size={13} />
                  </button>
                  <button className="icon-btn" title="Voltar pra render/ (pasta do roteiro)" onClick={() => onRender((r) => ({ ...r, exportDir: undefined }))}>
                    <X size={13} />
                  </button>
                </>
              )}
            </div>
          </section>
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
            {job?.busy && (
              <button className="btn small rn-cancel" onClick={cancel} title="Para agora (e o resto da rodada também). As partes que já ficaram prontas são guardadas e dá pra continuar depois.">
                <Square size={12} /> Cancelar
              </button>
            )}
            <button className="rn-create" onClick={renderAll} disabled={!queuedRows.length} title="Renderiza tudo o que está na fila, um depois do outro">
              <ListOrdered size={18} /> Renderizar todos ({queuedRows.length})
            </button>
            {cur &&
              (cur.id === 'main' && !job?.busy && resume && resume.status !== 'pronto' && resume.done > 0 ? (
                <div className="rn-chips">
                  <button className="btn small" onClick={() => renderOne('main')} disabled={!plan.parts.length} title="Reaproveita as partes prontas que não mudaram na timeline">
                    <Play size={12} /> Continuar o principal ({Math.round(resume.pct * 100)}% pronto)
                  </button>
                  <button className="btn small" onClick={() => renderOne('main', true)} disabled={!plan.parts.length}>
                    <RotateCcw size={12} /> Recomeçar do zero
                  </button>
                </div>
              ) : (
                <button
                  className="btn small rn-one"
                  onClick={() => renderOne(cur.id)}
                  disabled={curRun?.status === 'rodando' || curRun?.status === 'esperando' || (cur.id === 'main' && !plan.parts.length)}
                  title={job?.busy ? 'Entra na vez: começa quando o render de agora terminar' : 'Renderiza só o selecionado na fila'}
                >
                  <Play size={12} /> Renderizar só "{cur.label}"
                </button>
              ))}
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

function QState({ s }: { s: RunState['status'] | 'pendente' | 'fora' }) {
  return s === 'pronto' ? (
    <CheckCircle2 size={14} className="rn-q-ok" />
  ) : s === 'erro' ? (
    <XCircle size={14} className="rn-q-bad" />
  ) : s === 'rodando' ? (
    <Loader2 size={14} className="spin" />
  ) : s === 'fora' ? (
    <span className="rn-q-off" />
  ) : (
    <Clock size={14} className="muted" />
  )
}
