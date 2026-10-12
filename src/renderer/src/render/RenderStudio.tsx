import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import {
  Clapperboard,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  FileText,
  Mic,
  Film,
  AudioLines,
  Palette,
  FolderOpen,
  Square,
  Star,
  Sparkles,
  Music
} from 'lucide-react'
import { api, fileUrl, RESOLUTIONS, type Format, type MontageData, type MontageBin, type TimelineAsset } from '../lib'
import './render.css'

/**
 * Workspace Render: mostra tudo que vai alimentar o Claude, confere se ele consegue acessar
 * cada arquivo/pasta, escolhe a qualidade da prévia e manda o Claude Code criar o vídeo.
 */

interface Props {
  active: boolean
  dir: string
  title: string
  format?: Format
  montage: MontageData
  /** trilha marcada no Roteiro: não vai mais pro render (o roteiro não mexe no vídeo) */
  timelineAssets?: TimelineAsset[]
  getDoc: () => JSONContent | undefined
  save: () => Promise<void>
}

type Check = { path: string; ok: boolean; files?: number; error?: string }
type GroupId = 'script' | 'narration' | 'edit' | 'raw' | 'sfx' | 'style'
interface Group {
  id: GroupId
  label: string
  icon: React.ReactNode
  summary: string
  /** linhas (arquivos/pastas) que o Claude vai ler */
  items: { label: string; path?: string; note?: string; star?: boolean }[]
  empty?: boolean
}

const QUALITY_KEY = 'typos.renderQuality'
const loadQuality = (): { pct: number; fps: number } => {
  try {
    return { pct: 50, fps: 30, ...JSON.parse(localStorage.getItem(QUALITY_KEY) || '{}') }
  } catch {
    return { pct: 50, fps: 30 }
  }
}

const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
const r2 = (n: number) => Math.round(n * 100) / 100

/** todos os nós de um JSON do TipTap */
/**
 * Do roteiro, o render só recebe as falas, em texto puro: é o script de referência pra acertar
 * nomes e termos ao ouvir a narração. Prompts, transições, capítulos e anexos ficam no Roteiro
 * (servem pra gravar), não mandam no vídeo.
 */
function spokenLines(doc: JSONContent | undefined): string[] {
  const text = (n: JSONContent): string => (n.type === 'text' ? (n.text ?? '') : n.type === 'hardBreak' ? ' ' : (n.content ?? []).map(text).join(''))
  return (doc?.content ?? []).filter((n) => n.type === 'paragraph').map((n) => text(n).replace(/\s+/g, ' ').trim()).filter(Boolean)
}

export function RenderStudio({ active, dir, title, format, montage, getDoc, save }: Props) {
  const [quality, setQuality] = useState(loadQuality)
  const [off, setOff] = useState<Set<GroupId>>(new Set())
  const [checks, setChecks] = useState<Record<string, Check>>({})
  const [checking, setChecking] = useState(false)
  const [doc, setDoc] = useState<JSONContent | undefined>()
  const [job, setJob] = useState<{ busy: boolean; log: { kind: string; text: string }[]; t0: number; path?: string; summary?: string; error?: string; seconds?: number } | null>(null)
  const [now, setNow] = useState(Date.now())
  /** salvou ao entrar (o roteiro.md fica em dia antes de conferir) */
  const [ready, setReady] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(QUALITY_KEY, JSON.stringify(quality))
    } catch {
      /* sem storage: só não lembra */
    }
  }, [quality])

  // ao entrar no workspace, relê o roteiro (o editor fica no Roteiro)
  useEffect(() => {
    if (!active) return setReady(false)
    setDoc(getDoc())
    save().then(() => setReady(true))
  }, [active])

  // ---------- resolução ----------
  const [baseW, baseH] = (RESOLUTIONS[format?.aspect ?? '16:9'] ?? '1920×1080').split('×').map(Number)
  const fullHd = (() => {
    const k = 1080 / Math.min(baseW, baseH)
    return [even(baseW * k), even(baseH * k)]
  })()
  const [outW, outH] = quality.pct === -1 ? fullHd : [even((baseW * quality.pct) / 100), even((baseH * quality.pct) / 100)]

  // ---------- inventário: o que vai pro Claude ----------
  const groups = useMemo<Group[]>(() => {
    const binById = new Map(montage.bins.map((b) => [b.id, b]))
    const rootOf = (b?: MontageBin): MontageBin | undefined => {
      let cur = b
      for (let i = 0; cur?.parent && i < 20; i++) cur = binById.get(cur.parent)
      return cur
    }
    const roleOfBin = (id: string) => rootOf(binById.get(id))?.role
    const mediaById = new Map(montage.media.map((m) => [m.id, m]))

    // roteiro: só as falas
    const falas = spokenLines(doc)
    const palavras = falas.reduce((s, l) => s + l.split(' ').length, 0)

    const narrClips = montage.clips.filter((c) => roleOfBin(mediaById.get(c.media)?.bin ?? '') === 'narration')
    const narrDur = narrClips.reduce((s, c) => s + c.out - c.in, 0)
    const editEnd = montage.clips.reduce((s, c) => Math.max(s, c.start + c.out - c.in), 0)
    const inRole = (role: string) => montage.media.filter((m) => roleOfBin(m.bin) === role)
    const linkedIn = (role: string) =>
      montage.bins.filter((b) => b.linked && rootOf(b)?.role === role).sort((a, b) => Number(!!b.star) - Number(!!a.star))
    const raw = inRole('raw')
    const rawLinked = linkedIn('raw')
    const sfx = inRole('sfx')
    const sfxLinked = linkedIn('sfx')
    const m = format?.motion
    const styleItems: Group['items'] = []
    if (format?.rules?.trim()) styleItems.push({ label: 'Regras do formato', note: format.rules.trim().slice(0, 90) })
    if (m?.learned) styleItems.push({ label: 'Guia de estilo treinado', note: `aprendido em ${new Date(m.learned.at).toLocaleDateString('pt-BR')}` })
    const fonts = Object.values(m?.fonts ?? {}).filter(Boolean)
    if (fonts.length) styleItems.push({ label: 'Fontes', note: fonts.join(', ') })
    if (m?.colors?.length) styleItems.push({ label: 'Cores', note: m.colors.join(' ') })
    for (const r of m?.refs ?? []) if (r.path) styleItems.push({ label: 'Referência: ' + r.name, path: r.path })
    for (const f of format?.assetFolders ?? []) styleItems.push({ label: 'Pasta do formato', path: f })

    return [
      {
        id: 'script',
        label: 'Script (falas do roteiro)',
        icon: <FileText size={15} />,
        summary: `${falas.length} falas · ${palavras} palavras · só como referência de nomes e termos`,
        items: [],
        empty: !falas.length
      },
      {
        id: 'narration',
        label: 'Narração cortada',
        icon: <Mic size={15} />,
        summary: narrClips.length ? `${narrClips.length} cortes · ${fmtT(narrDur)}` : 'sem cortes na Montagem',
        items: [...new Set(narrClips.map((c) => mediaById.get(c.media)?.path).filter(Boolean) as string[])].map((p) => ({ label: p.split(/[\\/]/).pop()!, path: p })),
        empty: !narrClips.length
      },
      {
        id: 'edit',
        label: 'Timeline de edição',
        icon: <Film size={15} />,
        summary: montage.clips.length ? `${montage.clips.length} clipes em ${montage.tracks.length} faixas · ${fmtT(editEnd)}` : 'vazia (o Claude monta pela narração)',
        items: montage.tracks.map((t) => ({ label: t.name, note: `${montage.clips.filter((c) => c.track === t.id).length} clipes${t.muted ? ' · mudo' : ''}` })),
        empty: !montage.clips.length
      },
      {
        id: 'raw',
        label: 'Material bruto (B-roll)',
        icon: <FolderOpen size={15} />,
        summary: `${raw.length} arquivos · ${rawLinked.length} pastas do PC`,
        items: [
          ...rawLinked.map((b) => ({ label: b.name, path: b.linked, star: b.star, note: 'pasta do PC' })),
          ...raw.map((x) => ({ label: x.name, path: x.path }))
        ],
        empty: !raw.length && !rawLinked.length
      },
      {
        id: 'sfx',
        label: 'Áudios e SFX',
        icon: <AudioLines size={15} />,
        summary: `${sfx.length} arquivos · ${sfxLinked.length} bibliotecas (${sfxLinked.filter((b) => b.star).length} ⭐)`,
        items: [
          ...sfxLinked.map((b) => ({ label: b.name, path: b.linked, star: b.star, note: 'biblioteca do PC' })),
          ...sfx.map((x) => ({ label: x.name, path: x.path }))
        ],
        empty: !sfx.length && !sfxLinked.length
      },
      {
        id: 'style',
        label: 'Estilo do formato',
        icon: <Palette size={15} />,
        summary: format ? `${format.name} · ${m?.learned ? 'motion treinado' : 'sem treino de motion'}` : '—',
        items: styleItems,
        empty: !styleItems.length
      }
    ]
  }, [doc, montage, format, dir])

  const allPaths = useMemo(() => [...new Set(groups.flatMap((g) => g.items.map((i) => i.path).filter(Boolean) as string[]))], [groups])

  const runChecks = async () => {
    setChecking(true)
    const r = await api.renderCheck(allPaths)
    setChecks(Object.fromEntries(r.map((c) => [c.path, c])))
    setChecking(false)
  }
  useEffect(() => {
    if (active && ready) runChecks()
  }, [active, ready, allPaths.join('|')])

  const bad = allPaths.filter((p) => checks[p] && !checks[p].ok && !off.has(groups.find((g) => g.items.some((i) => i.path === p))!.id))

  // ---------- criar vídeo ----------
  useEffect(() => {
    api.onRenderProgress((ev) => setJob((j) => (j ? { ...j, log: [...j.log, ev].slice(-300) } : j)))
  }, [])
  useEffect(() => {
    if (!job?.busy) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [job?.busy])
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [job?.log.length])

  const buildBrief = () => {
    const on = (id: GroupId) => !off.has(id) && !groups.find((g) => g.id === id)?.empty
    const g = (id: GroupId) => groups.find((x) => x.id === id)!
    const out: string[] = [`# Pedido de vídeo: ${title}`, '', `- Pasta do projeto: ${dir}`]
    if (format) out.push(`- Formato: ${format.name} (${format.aspect})`)
    out.push(
      `- Saída: ${dir}\\render\\previa-${outW}x${outH}.mp4`,
      `- Resolução da prévia: ${outW}×${outH} (${quality.pct === -1 ? 'Full HD' : quality.pct + '% do formato'}), ${quality.fps} fps, H.264 (crf 23, preset veryfast) + AAC 192k`,
      '- Todo caminho abaixo é absoluto. Arquivos que o Typos não conseguiu acessar estão marcados com (SEM ACESSO): ignore-os.',
      ''
    )
    const line = (i: Group['items'][number]) => {
      const c = i.path ? checks[i.path] : undefined
      return `- ${i.star ? '⭐ ' : ''}${i.label}${i.note ? ` (${i.note})` : ''}${i.path ? `: ${i.path}` : ''}${c && !c.ok ? ' (SEM ACESSO)' : ''}`
    }
    if (on('script'))
      out.push(
        '## Script (as falas que o autor escreveu, só como referência)',
        'Serve pra acertar nomes e termos ao transcrever/ouvir a narração. O que vale é o que foi FALADO na narração: improvisos e mudanças em relação a este texto são respeitados. Não leia roteiro.md nem roteiro.json: o roteiro é só a ferramenta de gravação do autor e não define nada do vídeo.',
        '```text',
        ...spokenLines(doc),
        '```',
        ''
      )
    if (on('edit')) {
      const media = new Map(montage.media.map((m) => [m.id, m]))
      const tl = montage.tracks.map((t) => ({
        faixa: t.name,
        tipo: t.kind,
        mudo: !!t.muted || undefined,
        clipes: montage.clips
          .filter((c) => c.track === t.id)
          .sort((a, b) => a.start - b.start)
          .map((c) => ({
            arquivo: media.get(c.media)?.path,
            inicio: r2(c.start),
            de: r2(c.in),
            ate: r2(c.out),
            ganhoDb: c.gainDb || undefined,
            fadeIn: c.fadeIn || undefined,
            fadeOut: c.fadeOut || undefined,
            emenda: c.splice || undefined
          }))
      }))
      out.push(
        '## Timeline de edição (a montagem do autor: siga à risca)',
        '`inicio` = segundo na timeline; `de`/`ate` = trecho do arquivo; `emenda` = crossfade curto com o clipe anterior.',
        montage.norm ? `Normalização da narração: ${montage.norm} (peak = pico em dBFS, lufs = volume percebido).` : '',
        '```json',
        JSON.stringify(tl, null, 1),
        '```',
        ''
      )
    } else if (on('narration')) out.push('## Narração cortada', ...g('narration').items.map(line), '')
    if (!on('edit')) out.push('A timeline de edição está vazia: monte na ordem da narração, usando o material disponível.', '')
    if (on('raw')) out.push('## Material bruto (B-roll: escolha o que combina com cada trecho da narração; pastas ⭐ são as preferidas)', ...g('raw').items.map(line), '')
    if (on('sfx')) out.push('## Áudios e SFX (bibliotecas ⭐ são as referências essenciais de som: use com mais frequência)', ...g('sfx').items.map(line), '')
    if (on('style')) {
      const m = format?.motion
      out.push('## Estilo', ...g('style').items.filter((i) => i.path).map(line))
      if (format?.rules?.trim()) out.push('', 'Regras do formato:', format.rules.trim())
      if (m) {
        if (m.fonts) out.push(`Fontes: título ${m.fonts.title ?? '-'}, subtítulo ${m.fonts.subtitle ?? '-'}, texto ${m.fonts.body ?? '-'}, destaque ${m.fonts.accent ?? '-'}`)
        if (m.fontCases?.length) out.push('Fontes por situação: ' + m.fontCases.map((f) => `${f.name}: ${f.mode === 'favorites' && f.favorites.length ? f.favorites.join('/') : 'você escolhe'}`).join('; '))
        if (m.colors?.length) out.push('Cores: ' + m.colors.join(', '))
        if (m.background) out.push('Fundo: ' + m.background)
        if (m.camera?.length) out.push('Câmera: ' + m.camera.join(', '))
        if (m.transitions?.length) out.push('Transições: ' + m.transitions.join(', '))
        if (m.pace) out.push('Ritmo: ' + m.pace)
        if (m.learned) out.push('Guia completo do estilo: render\\estilo.md')
      }
      out.push('')
    }
    out.push(
      '## Como fazer',
      '- É uma PRÉVIA: priorize ter o vídeo inteiro montado e sincronizado com a narração; capriche nos letterings e textos na tela (legendas .ass com as fontes instaladas) e nos cortes de B-roll.',
      '- Áudio: narração na frente, música por baixo (uns -18 dB), SFX nos pontos de impacto. Sem clipping.'
    )
    return out.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
  }

  const readDirs = () => {
    const ds = new Set<string>()
    for (const p of allPaths) {
      const c = checks[p]
      if (!c?.ok) continue
      ds.add(c.files === 1 && /\.[a-z0-9]{2,5}$/i.test(p) ? p.replace(/[\\/][^\\/]+$/, '') : p)
    }
    return [...ds]
  }

  const create = async () => {
    await save()
    setJob({ busy: true, log: [], t0: Date.now() })
    const r = await api.renderStart({ dir, brief: buildBrief(), readDirs: readDirs(), styleGuide: off.has('style') ? undefined : format?.motion?.learned?.guide })
    setJob((j) => ({ ...(j ?? { log: [], t0: Date.now() }), busy: false, ...('error' in r ? { error: r.error } : r) }))
  }

  const toggle = (id: GroupId) =>
    setOff((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const statusOf = (g: Group) => {
    const ps = g.items.map((i) => i.path).filter(Boolean) as string[]
    if (!ps.length) return null
    const known = ps.filter((p) => checks[p])
    if (known.length < ps.length) return <Loader2 size={13} className="spin" />
    const fails = known.filter((p) => !checks[p].ok)
    return fails.length ? (
      <span className="rn-bad">
        <XCircle size={13} /> {fails.length} sem acesso
      </span>
    ) : (
      <span className="rn-ok">
        <CheckCircle2 size={13} /> acesso ok
      </span>
    )
  }

  // ---------- checklist: o essencial do vídeo, num olhar ----------
  type CheckState = 'ok' | 'bad' | 'checking' | 'none'
  const checklist = useMemo(() => {
    const binById = new Map(montage.bins.map((b) => [b.id, b]))
    const roleOf = (binId: string) => {
      let cur = binById.get(binId)
      for (let i = 0; cur?.parent && i < 20; i++) cur = binById.get(cur.parent)
      return cur?.role
    }
    const mediaById = new Map(montage.media.map((m) => [m.id, m]))
    const used = (pred: (m: (typeof montage.media)[number]) => boolean) => montage.clips.map((c) => mediaById.get(c.media)).filter((m): m is NonNullable<typeof m> => !!m && pred(m))
    const uniq = (ps: (string | undefined)[]) => [...new Set(ps.filter(Boolean) as string[])]

    const videoMedia = [...used((m) => m.kind !== 'audio'), ...montage.media.filter((m) => m.kind !== 'audio' && roleOf(m.bin) === 'raw')]
    const narr = used((m) => roleOf(m.bin) === 'narration')
    const narrDur = montage.clips.filter((c) => roleOf(mediaById.get(c.media)?.bin ?? '') === 'narration').reduce((s, c) => s + c.out - c.in, 0)
    const musicMedia = used((m) => m.kind === 'audio' && roleOf(m.bin) !== 'narration' && roleOf(m.bin) !== 'sfx')
    const sfxMedia = montage.media.filter((m) => roleOf(m.bin) === 'sfx')
    const sfxLinked = montage.bins.filter((b) => b.linked && roleOf(b.id) === 'sfx')

    return [
      {
        id: 'video',
        label: 'Vídeos',
        icon: <Film size={18} />,
        count: uniq(videoMedia.map((m) => m.path)).length,
        detail: `${uniq(videoMedia.map((m) => m.path)).length} na montagem`,
        paths: uniq(videoMedia.map((m) => m.path)),
        required: true
      },
      {
        id: 'narration',
        label: 'Narração',
        icon: <Mic size={18} />,
        count: narr.length,
        detail: narr.length ? `${narr.length} cortes · ${fmtT(narrDur)}` : 'grave ou importe na Montagem',
        paths: uniq(narr.map((m) => m.path)),
        required: true
      },
      {
        id: 'music',
        label: 'Músicas',
        icon: <Music size={18} />,
        count: uniq(musicMedia.map((m) => m.path)).length,
        detail: `${uniq(musicMedia.map((m) => m.path)).length} na timeline`,
        paths: uniq(musicMedia.map((m) => m.path)),
        required: false
      },
      {
        id: 'sfx',
        label: 'Efeitos sonoros',
        icon: <AudioLines size={18} />,
        count: sfxMedia.length + sfxLinked.length,
        detail: `${sfxLinked.length} bibliotecas${sfxLinked.some((b) => b.star) ? ' ⭐' : ''} · ${sfxMedia.length} arquivos`,
        paths: uniq([...sfxLinked.map((b) => b.linked), ...sfxMedia.map((m) => m.path)]),
        required: false
      }
    ]
  }, [montage])

  // os caminhos do checklist também passam pela conferência de acesso
  const extraPaths = checklist.flatMap((c) => c.paths).filter((p) => !allPaths.includes(p))
  useEffect(() => {
    if (!active || !ready || !extraPaths.length) return
    api.renderCheck(extraPaths).then((r) => setChecks((c) => ({ ...c, ...Object.fromEntries(r.map((x) => [x.path, x])) })))
  }, [active, ready, extraPaths.join('|')])

  const stateOf = (c: (typeof checklist)[number]): CheckState => {
    if (!c.count) return 'none'
    if (c.paths.some((p) => !checks[p])) return 'checking'
    return c.paths.some((p) => !checks[p].ok) ? 'bad' : 'ok'
  }
  const STATE_LABEL: Record<CheckState, string> = { ok: 'OK', bad: 'sem acesso', checking: 'conferindo', none: 'nenhum' }
  const readyCount = checklist.filter((c) => stateOf(c) === 'ok').length

  const [rw, rh] = (format?.aspect ?? '16:9').split(':').map(Number)
  const lastLine = job?.log.length ? job.log[job.log.length - 1].text : 'Preparando…'

  return (
    <div className="render-studio v2">
      <header className="rn-head">
        <div>
          <h2>
            <Clapperboard size={20} /> Render
          </h2>
          <p className="muted">Confira o que vai pro Claude e crie o vídeo.</p>
        </div>
        <button className="btn small" onClick={runChecks} disabled={checking} title="Confere de novo se cada arquivo e pasta está acessível">
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
        <div className="rn-check-bar" title={`${readyCount} de 4 OK`}>
          <i style={{ width: `${(readyCount / 4) * 100}%` }} />
        </div>
      </section>

      {/* ---------- palco: prévia + controles ---------- */}
      <section className="rn-stage">
        <div className="rn-screen-wrap">
          <div className="rn-screen" style={{ aspectRatio: `${rw} / ${rh}`, width: `min(100%, calc(52vh * ${rw / rh}))` }}>
            {job && !job.busy && job.path ? (
              <video src={fileUrl(job.path)} controls />
            ) : job?.busy ? (
              <div className="rn-screen-busy">
                <div className="rn-scan" />
                <Loader2 size={30} className="spin" />
                <b>Criando o vídeo… {fmtT((now - job.t0) / 1000)}</b>
                <small>{lastLine}</small>
              </div>
            ) : (
              <div className="rn-screen-empty">
                <Clapperboard size={34} />
                <span>A prévia aparece aqui</span>
                <small>
                  {outW}×{outH} · {quality.fps} fps
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
            <h3>Qualidade da prévia</h3>
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
                <XCircle size={13} /> {bad.length} item(ns) sem acesso: o Claude vai ignorar.
              </p>
            )}
            {job?.busy ? (
              <button className="btn small rn-cancel" onClick={() => api.renderCancel()}>
                <Square size={12} /> Cancelar
              </button>
            ) : (
              <button className="rn-create" onClick={create}>
                <Sparkles size={18} /> Criar Vídeo
              </button>
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

      {/* ---------- o que vai pro Claude, em grade ---------- */}
      <h3 className="rn-section-title">O que vai pro Claude</h3>
      <div className="rn-grid">
        {groups.map((g) => (
          <section key={g.id} className={'rn-group' + (off.has(g.id) || g.empty ? ' off' : '')}>
            <label className="rn-ghead">
              <input type="checkbox" checked={!off.has(g.id) && !g.empty} disabled={g.empty} onChange={() => toggle(g.id)} />
              <span className="rn-gicon">{g.icon}</span>
              <b>{g.label}</b>
              <span className="tb-grow" />
              {!off.has(g.id) && statusOf(g)}
            </label>
            <span className="rn-gsum">{g.summary}</span>
            {!!g.items.length && !off.has(g.id) && (
              <ul className="rn-items">
                {g.items.slice(0, 60).map((i, k) => {
                  const c = i.path ? checks[i.path] : undefined
                  return (
                    <li key={k} className={c && !c.ok ? 'bad' : ''} title={i.path}>
                      {i.star && <Star size={11} className="rn-star" />}
                      <span className="rn-iname">{i.label}</span>
                      {i.note && <span className="rn-note">{i.note}</span>}
                      {c && (c.ok ? (c.files && c.files > 1 ? <span className="rn-note">{c.files >= 2000 ? '2000+' : c.files}</span> : null) : <span className="rn-err">{c.error}</span>)}
                    </li>
                  )
                })}
                {g.items.length > 60 && <li className="muted">… e mais {g.items.length - 60}</li>}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
