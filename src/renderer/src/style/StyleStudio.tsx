import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Trash2,
  Save,
  Undo2,
  Check,
  Link2,
  ImagePlus,
  Film,
  X,
  Rocket,
  Loader2,
  RotateCcw,
  Copy,
  FolderPlus,
  Languages,
  Palette,
  Clipboard,
  Sparkles,
  ExternalLink,
  FolderOpen
} from 'lucide-react'
import { api, fileUrl, formatLang, langLabel, openPreview, RESOLUTIONS, uid, type Format, type MotionRef, type MotionStyle, type FontCase, DEFAULT_FONT_CASES } from '../lib'
import { FontPicker } from './FontPicker'

const CAMERA = ['estática', 'zoom-in lento', 'zoom punch (rápido)', 'pan lateral', 'parallax 2.5D', 'câmera na mão (tremida)', 'whip pan', 'rotação leve', 'dolly / push-in', 'tracking em elemento']
const TRANSITIONS = ['corte seco', 'whip / swipe', 'zoom through', 'glitch', 'fade', 'slide', 'máscara / wipe', 'flash branco', 'match cut', 'luma fade']
const BACKGROUNDS = ['sólido escuro', 'gradiente suave', 'textura / grão', 'gameplay desfocado', 'papel / colagem', 'grid / tech', 'ilustração plana', 'foto com overlay']
const PACES: MotionStyle['pace'][] = ['calmo', 'médio', 'frenético']
const PREFERRED_LANGS = ['pt-BR', 'pt-PT', 'en-US', 'en-GB', 'es-ES']

const emptyMotion = (f: Format): MotionStyle => ({
  // referências antigas (Formatos → referência pro motion) entram como imagens
  refs: (f.motionRefFiles ?? []).map((p) => ({ id: uid(), kind: /\.(mp4|mov|webm|m4v|mkv)$/i.test(p) ? 'video' : 'image', path: p, name: p.split(/[\\/]/).pop() || p })),
  colors: [],
  camera: [],
  transitions: []
})

/** o pedido que vai pra IA, com tudo que o autor escolheu */
function buildPrompt(f: Format, m: MotionStyle, imageList: string[], sample: string, installed: string[]) {
  const [w, h] = f.aspect === '9:16' ? [540, 960] : f.aspect === '1:1' ? [720, 720] : f.aspect === '4:5' ? [576, 720] : [960, 540]
  const lines: string[] = []
  lines.push(`Você é diretor de motion design de vídeos para YouTube. Vou te ensinar um ESTILO DE MOTION pra eu usar sempre neste formato de vídeo: "${f.name}" (${f.aspect}).`)
  lines.push('Analise com rigor as referências (imagens; os quadros de cada vídeo estão em ordem cronológica) e as escolhas abaixo. Onde as escolhas e as referências discordarem, as escolhas mandam.')
  lines.push(
    'Cada referência tem um FOCO de 0 a 100: perto de 0 = aprenda dela a ESTÉTICA (cores, tipografia, composição, fundo, textura); perto de 100 = aprenda o MOTION (movimento de câmera, transições, ritmo, como os elementos entram e saem). No meio, os dois. Pese o que tirar de cada uma por esse número.'
  )
  lines.push('')
  lines.push('## Escolhas do autor')
  if (m.background) lines.push(`- Fundo: ${m.background}`)
  if (m.camera?.length) lines.push(`- Movimentos de câmera: ${m.camera.join(', ')}`)
  if (m.transitions?.length) lines.push(`- Transições: ${m.transitions.join(', ')}`)
  if (m.pace) lines.push(`- Ritmo: ${m.pace}`)
  if (m.colors?.length) lines.push(`- Paleta: ${m.colors.join(', ')}`)
  const ft = m.fonts ?? {}
  if (ft.title || ft.subtitle || ft.body || ft.accent)
    lines.push(
      `- Fontes principais: título "${ft.title ?? 'você escolhe'}", subtítulo "${ft.subtitle ?? 'você escolhe'}", texto "${ft.body ?? 'você escolhe'}", destaque "${ft.accent ?? 'você escolhe'}" (instaladas no PC; use pelo nome)`
    )
  const cases = m.fontCases ?? DEFAULT_FONT_CASES()
  const dyn = cases.filter((c) => c.mode === 'dynamic' || !c.favorites.length)
  if (cases.length) {
    lines.push('- Fontes por situação (quando o vídeo pedir esse clima):')
    for (const c of cases)
      lines.push(c.mode === 'favorites' && c.favorites.length ? `  - ${c.name}: use só estas favoritas → ${c.favorites.map((x) => `"${x}"`).join(', ')}` : `  - ${c.name}: DINÂMICA — escolha você a melhor fonte instalada pra isso`)
  }
  const needList = dyn.length > 0 || !ft.title || !ft.subtitle || !ft.body || !ft.accent
  if (f.rules?.trim()) lines.push(`- Regras do estilo: ${f.rules.trim()}`)
  if (m.instruction?.trim()) {
    lines.push('')
    lines.push('## Instrução do autor')
    lines.push(m.instruction.trim())
  }
  const links = m.refs.filter((r) => r.kind === 'link' && r.url)
  if (links.length) {
    lines.push('')
    lines.push('## Links de referência (contexto; abra a página se ajudar)')
    for (const l of links) lines.push(`- ${l.url} ${focusLabel(l.focus)}${l.note ? ` — ${l.note}` : ''}`)
  }
  if (needList && installed.length) {
    lines.push('')
    lines.push('## Fontes instaladas no PC (escolha só daqui, pelo nome exato)')
    lines.push(installed.join(' | '))
  }
  if (imageList.length) {
    lines.push('')
    lines.push('## Imagens (na ordem em que foram enviadas)')
    imageList.forEach((d, i) => lines.push(`${i + 1}. ${d}`))
  }
  lines.push('')
  lines.push('## Responda EXATAMENTE neste formato (nada fora das tags)')
  lines.push('<guia>')
  lines.push(
    'Guia do estilo em português, markdown curto e prático, pra ser seguido em todo prompt de motion deste formato: identidade em 1 frase; de qual referência veio o quê (respeitando o foco de cada uma); fundo; paleta com hex e função de cada cor; tipografia e hierarquia (as 4 fontes principais com tamanhos, peso, caixa, espaçamento) e uma tabela "Fontes por situação" com a fonte escolhida pra cada situação (nas dinâmicas, a que você escolheu e por quê, em poucas palavras); movimentos de câmera com duração e easing; transições (quando usar cada uma); ritmo de cortes; elementos gráficos recorrentes (molduras, lower thirds, setas, marcadores); o que NUNCA fazer; checklist final.'
  )
  lines.push('</guia>')
  lines.push('<demo>')
  lines.push(
    `Um arquivo HTML completo e autocontido (CSS e JS inline, sem internet, sem imagens externas), em ${w}x${h} px preenchendo a página toda (body sem margem, overflow hidden), que demonstra o estilo animado em loop contínuo de 8 a 12 segundos: abertura com o título "${sample}", um lower third/legenda, um destaque de número ou dado, e uma transição do estilo. Use as fontes pelo nome (font-family) e as cores do estilo; anime com CSS keyframes ou requestAnimationFrame.`
  )
  lines.push('</demo>')
  return lines.join('\n')
}

/** "[foco 70: mais motion]" — o mesmo texto vai em cada imagem/link no pedido */
export function focusLabel(v = 50) {
  const what = v <= 20 ? 'só estética' : v < 45 ? 'mais estética' : v <= 55 ? 'estética e motion' : v < 80 ? 'mais motion' : 'só motion'
  return `[foco ${v}: ${what}]`
}

function parseAnswer(text: string) {
  const pick = (tag: string) => text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))?.[1]?.trim() ?? ''
  const guide = pick('guia')
  let demo = pick('demo')
  demo = demo.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim()
  return { guide, demo }
}

interface Props {
  active: boolean
  formats: Format[]
  activeId: string
  onChange: (formats: Format[]) => void
  onSelect: (id: string) => void
}

export function StyleStudio({ active, formats, activeId, onChange, onSelect }: Props) {
  const [editId, setEditId] = useState(activeId)
  const [drafts, setDrafts] = useState<Record<string, Format>>({})
  const [langs, setLangs] = useState<string[]>(PREFERRED_LANGS)
  const [fonts, setFonts] = useState<string[]>([])
  const [link, setLink] = useState('')
  const [sample, setSample] = useState('Você está fazendo o marketing errado')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [replay, setReplay] = useState(0)
  const [elapsed, setElapsed] = useState(0)

  const saved = formats.find((f) => f.id === editId)
  const f: Format = drafts[editId] ?? saved ?? formats[0]
  const isNew = !saved
  const dirty = !!drafts[editId]
  const m: MotionStyle = f.motion ?? emptyMotion(f)

  useEffect(() => {
    if (!formats.some((x) => x.id === editId) && !drafts[editId]) setEditId(activeId)
  }, [formats])

  useEffect(() => {
    api
      .spellLanguages()
      .then((all) => all.length && setLangs([...PREFERRED_LANGS.filter((l) => all.includes(l)), ...all.filter((l) => !PREFERRED_LANGS.includes(l)).sort()]))
      .catch(() => null)
    api.systemFonts().then(setFonts)
  }, [])

  const formatsRef = useRef(formats)
  formatsRef.current = formats
  type Upd<T> = Partial<T> | ((cur: T) => Partial<T>)
  const patch = (p: Upd<Format>) =>
    setDrafts((d) => {
      const cur = d[editId] ?? formatsRef.current.find((x) => x.id === editId) ?? formatsRef.current[0]
      return { ...d, [editId]: { ...cur, ...(typeof p === 'function' ? p(cur) : p) } }
    })
  const patchM = (p: Upd<MotionStyle>) =>
    patch((cur) => {
      const mm = cur.motion ?? emptyMotion(cur)
      return { motion: { ...mm, ...(typeof p === 'function' ? p(mm) : p) } }
    })
  const clean = ({ __dirty, ...x }: Format) => x as Format

  const save = (next: Format = f) => {
    onChange(saved ? formats.map((x) => (x.id === editId ? clean(next) : x)) : [...formats, clean(next)])
    setDrafts((d) => {
      const { [editId]: _, ...rest } = d
      return rest
    })
  }
  const discard = () =>
    setDrafts((d) => {
      const { [editId]: _, ...rest } = d
      return rest
    })

  // ---------- fontes por situação ----------
  const cases = m.fontCases ?? DEFAULT_FONT_CASES()
  const patchCases = (fn: (cs: FontCase[]) => FontCase[]) => patchM((mm) => ({ fontCases: fn(mm.fontCases ?? DEFAULT_FONT_CASES()) }))
  const patchCase = (id: string, p: Partial<FontCase>) => patchCases((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)))

  // ---------- referências ----------
  const addFiles = async (paths: string[]) => {
    if (!paths.length) return
    setBusy(`Lendo ${paths.length} arquivo(s)${paths.some((p) => /\.(mp4|mov|webm|m4v|mkv)$/i.test(p)) ? ' e tirando quadros dos vídeos' : ''}…`)
    try {
      const got = await api.motionImportFiles(paths)
      const refs: MotionRef[] = got.map((g) => ({ id: uid(), kind: g.kind, path: g.path, name: g.name, frames: g.frames }))
      const bad = got.filter((g) => g.error)
      if (bad.length) setError(bad.map((b) => `${b.name}: ${b.error}`).join(' · '))
      patchM((mm) => ({ refs: [...mm.refs, ...refs] }))
    } finally {
      setBusy(null)
    }
  }
  const addLink = (url: string) => {
    const u = url.trim()
    if (!/^https?:\/\//i.test(u)) return
    patchM((mm) => ({ refs: [...mm.refs, { id: uid(), kind: 'link', url: u, name: u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60) }] }))
    setLink('')
  }
  const patchRef = (id: string, p: Partial<MotionRef>) => patchM((mm) => ({ refs: mm.refs.map((r) => (r.id === id ? { ...r, ...p } : r)) }))

  // Ctrl+V com print (imagem) entra como referência; texto com link vira link
  const fRef = useRef(f)
  fRef.current = f
  const patchMRef = useRef(patchM)
  patchMRef.current = patchM
  useEffect(() => {
    if (!active) return
    const onPaste = async (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((x) => x.type.startsWith('image/'))
      const tgt = e.target as HTMLElement
      const inField = !!tgt.closest?.('input, textarea')
      if (files.length) {
        e.preventDefault()
        const refs: MotionRef[] = []
        for (const file of files) {
          const p = await api.motionPasteImage(new Uint8Array(await file.arrayBuffer()), file.name || 'print.png')
          refs.push({ id: uid(), kind: 'image', path: p, name: 'print colado' })
        }
        patchMRef.current((mm) => ({ refs: [...mm.refs, ...refs] }))
        return
      }
      const txt = e.clipboardData?.getData('text') ?? ''
      if (!inField && /^https?:\/\/\S+$/i.test(txt.trim())) {
        e.preventDefault()
        patchMRef.current((mm) => ({ refs: [...mm.refs, { id: uid(), kind: 'link', url: txt.trim(), name: txt.trim().replace(/^https?:\/\/(www\.)?/, '').slice(0, 60) }] }))
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [active])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const paths = Array.from(e.dataTransfer.files)
      .map((x) => api.pathForFile(x))
      .filter(Boolean)
    if (paths.length) return addFiles(paths)
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text')
    if (url) addLink(url.split(/\r?\n/)[0])
  }

  // ---------- treino ----------
  const images = useMemo(() => {
    const out: { path: string; desc: string }[] = []
    m.refs.forEach((r, i) => {
      const note = ` ${focusLabel(r.focus)}` + (r.note ? ` — nota do autor: ${r.note}` : '')
      if (r.kind === 'image' && r.path) out.push({ path: r.path, desc: `referência ${i + 1} (imagem "${r.name}")${note}` })
      if (r.kind === 'video')
        (r.frames ?? []).forEach((fr, k) => out.push({ path: fr, desc: `referência ${i + 1} (vídeo "${r.name}", quadro ${k + 1}/${r.frames!.length})${k === 0 ? note : ''}` }))
    })
    return out.slice(0, 40)
  }, [m.refs])

  const canTrain = m.refs.length > 0 || !!m.instruction?.trim() || !!m.colors?.length
  const train = async () => {
    setError('')
    setBusy('O Claude está estudando as referências…')
    const t0 = Date.now()
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    try {
      const r = await api.motionTrain({ prompt: buildPrompt(f, m, images.map((i) => i.desc), sample, fonts), images: images.map((i) => i.path) })
      if ('error' in r) throw new Error(r.error)
      const { guide, demo } = parseAnswer(r.text)
      if (!guide && !demo) throw new Error('A IA respondeu fora do formato. Tente de novo.')
      const next = { ...fRef.current, motion: { ...(fRef.current.motion ?? m), learned: { at: new Date().toISOString(), provider: r.provider, guide: guide || r.text, demoHtml: demo } } }
      // treino custa tempo: já salva
      save(next)
      setReplay((n) => n + 1)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      clearInterval(tick)
      setElapsed(0)
      setBusy(null)
    }
  }

  // a demo roda de um arquivo (rs://), não do srcdoc: assim o JS dela funciona isolado
  const demoHtml = f.motion?.learned?.demoHtml
  const [demoSrc, setDemoSrc] = useState<string | null>(null)
  const [demoPath, setDemoPath] = useState<string | null>(null)
  useEffect(() => {
    setDemoSrc(null)
    setDemoPath(null)
    if (demoHtml)
      api.motionDemoFile(demoHtml).then((p) => {
        setDemoPath(p)
        setDemoSrc(fileUrl(p))
      })
  }, [demoHtml])

  const [pw, ph] = f.aspect === '9:16' ? [540, 960] : f.aspect === '1:1' ? [720, 720] : f.aspect === '4:5' ? [576, 720] : [960, 540]
  const stageRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setScale(Math.min(el.clientWidth / pw, el.clientHeight / ph)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [pw, ph, active])

  const toggle = (list: string[] | undefined, v: string) => (list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v])

  return (
    <div className="studio">
      {/* ---------- estilos (formatos) ---------- */}
      <aside className="st-list">
        <div className="st-list-head">Estilos de vídeo</div>
        {[...formats, ...Object.values(drafts).filter((d) => !formats.some((x) => x.id === d.id))].map((x) => {
          const cur = drafts[x.id] ?? x
          return (
            <button key={x.id} className={'st-item' + (x.id === editId ? ' on' : '')} onClick={() => setEditId(x.id)}>
              <span className="st-item-name">{cur.name}</span>
              <span className="st-item-meta">
                {cur.aspect}
                {x.id === activeId && ' · neste roteiro'}
                {drafts[x.id] && ' · não salvo'}
              </span>
              {cur.motion?.learned && (
                <span className="st-item-badge" title="Estilo treinado">
                  <Sparkles size={11} />
                </span>
              )}
            </button>
          )
        })}
        <button
          className="btn small block"
          onClick={() => {
            const id = uid()
            setDrafts((d) => ({ ...d, [id]: { id, name: 'Novo estilo', aspect: '16:9', wpm: 150, maxSeconds: null, lang: 'pt-BR' } }))
            setEditId(id)
          }}
        >
          <Plus size={13} /> Novo estilo
        </button>
      </aside>

      {/* ---------- edição ---------- */}
      <main className="st-main" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <div className="st-head">
          <input className="st-name" value={f.name} onChange={(e) => patch({ name: e.target.value })} />
          {f.id === activeId ? (
            <span className="pill">
              <Check size={12} /> neste roteiro
            </span>
          ) : (
            !isNew && (
              <button className="btn small" onClick={() => onSelect(f.id)}>
                Usar neste roteiro
              </button>
            )
          )}
          <span className="st-grow" />
          {(dirty || isNew) && (
            <>
              <button className="btn small primary" onClick={() => save()}>
                <Save size={13} /> Salvar estilo
              </button>
              <button className="btn small" onClick={discard}>
                <Undo2 size={13} /> Descartar
              </button>
            </>
          )}
          {formats.length > 1 && !isNew && (
            <button
              className="icon-btn danger"
              title="Excluir estilo"
              onClick={() => {
                if (!confirm(`Excluir o estilo "${f.name}"?`)) return
                onChange(formats.filter((x) => x.id !== f.id))
                setEditId(formats.find((x) => x.id !== f.id)!.id)
              }}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>

        <section className="st-sec">
          <h4>Formato</h4>
          <div className="st-grid4">
            <label>
              Proporção
              <select value={f.aspect} onChange={(e) => patch({ aspect: e.target.value })}>
                {Object.keys(RESOLUTIONS).map((a) => (
                  <option key={a} value={a}>
                    {a} · {RESOLUTIONS[a]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Palavras/min
              <input type="number" min={60} max={300} value={f.wpm} onChange={(e) => patch({ wpm: Number(e.target.value) || 150 })} />
            </label>
            <label>
              Duração máx. (s)
              <input type="number" min={0} placeholder="sem limite" value={f.maxSeconds ?? ''} onChange={(e) => patch({ maxSeconds: e.target.value ? Number(e.target.value) : null })} />
            </label>
            <label>
              <span>
                <Languages size={11} /> Corretor
              </span>
              <select value={formatLang(f)} onChange={(e) => patch({ lang: e.target.value })}>
                {(langs.includes(formatLang(f)) ? langs : [formatLang(f), ...langs]).map((l) => (
                  <option key={l} value={l}>
                    {langLabel(l)} ({l})
                  </option>
                ))}
                <option value="off">Corretor desligado</option>
              </select>
            </label>
          </div>
          <label className="st-field">
            Regras do estilo (valem sempre que a IA mexe no roteiro)
            <textarea rows={2} value={f.rules ?? ''} placeholder="Ex.: pngtuber no canto inferior direito, legenda amarela, nada de emoji…" onChange={(e) => patch({ rules: e.target.value })} />
          </label>
          <div className="st-field">
            <span>Assets frequentes (aparecem nas Pastas quando este estilo está ativo)</span>
            <div className="st-folders">
              {(f.assetFolders ?? []).map((p) => (
                <span key={p} className="st-chip on" title={p}>
                  {p.split(/[\\/]/).pop()}
                  <X size={11} onClick={() => patch({ assetFolders: (f.assetFolders ?? []).filter((x) => x !== p) })} />
                </span>
              ))}
              <button
                className="btn small"
                onClick={async () => {
                  const p = await api.pickFolder()
                  if (p && !(f.assetFolders ?? []).includes(p)) patch({ assetFolders: [...(f.assetFolders ?? []), p] })
                }}
              >
                <FolderPlus size={12} /> Pasta
              </button>
            </div>
          </div>
        </section>

        <section className="st-sec">
          <h4>Referências de motion</h4>
          <p className="muted small">Arraste vídeos e imagens pra cá, cole prints com <b>Ctrl+V</b> ou cole links. De vídeo o Typos tira 8 quadros-chave pra IA olhar.</p>
          <div className="st-refbar">
            <button className="btn small" onClick={async () => addFiles(await api.motionPickFiles())}>
              <ImagePlus size={13} /> Arquivos…
            </button>
            <span className="st-paste">
              <Clipboard size={12} /> Ctrl+V cola print
            </span>
            <div className="st-link">
              <Link2 size={13} />
              <input value={link} placeholder="https://… (vídeo, post, página)" onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addLink(link)} />
              <button className="btn small" disabled={!/^https?:\/\//i.test(link.trim())} onClick={() => addLink(link)}>
                Adicionar
              </button>
            </div>
          </div>
          {busy && !busy.startsWith('O Claude') && (
            <div className="st-note">
              <Loader2 size={12} className="spin" /> {busy}
            </div>
          )}
          <div className="st-refs">
            {m.refs.length === 0 && <div className="st-empty">Solte aqui vídeos, imagens ou links de motions que você gosta.</div>}
            {m.refs.map((r, i) => (
              <div key={r.id} className={'st-ref k-' + r.kind}>
                <div className="st-ref-media">
                  {r.kind === 'image' && r.path && <img src={fileUrl(r.path)} onClick={() => openPreview(fileUrl(r.path!))} />}
                  {r.kind === 'video' &&
                    (r.frames?.length ? (
                      <div className="st-frames">
                        {r.frames.slice(0, 4).map((fr) => (
                          <img key={fr} src={fileUrl(fr)} onClick={() => r.path && openPreview(fileUrl(r.path))} />
                        ))}
                      </div>
                    ) : (
                      <Film size={22} />
                    ))}
                  {r.kind === 'link' && <Link2 size={22} />}
                  <span className="st-ref-n">{i + 1}</span>
                </div>
                <div className="st-ref-name" title={r.url ?? r.path}>
                  {r.kind === 'video' && <Film size={11} />} {r.name}
                </div>
                <input className="st-ref-note" value={r.note ?? ''} placeholder="o que observar aqui…" onChange={(e) => patchRef(r.id, { note: e.target.value })} />
                <label className="st-focus" title="O que o Claude aprende dessa referência">
                  <span className={(r.focus ?? 50) < 45 ? 'on' : ''}>estética</span>
                  <input type="range" min={0} max={100} step={5} value={r.focus ?? 50} onChange={(e) => patchRef(r.id, { focus: Number(e.target.value) })} onDoubleClick={() => patchRef(r.id, { focus: 50 })} />
                  <span className={(r.focus ?? 50) > 55 ? 'on' : ''}>motion</span>
                </label>
                <button className="icon-btn danger st-ref-x" title="Tirar" onClick={() => patchM((mm) => ({ refs: mm.refs.filter((x) => x.id !== r.id) }))}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="st-sec">
          <h4>Instrução pro Claude</h4>
          <textarea
            className="st-instr"
            rows={4}
            value={m.instruction ?? ''}
            placeholder="Explique o estilo com suas palavras: o que te chama atenção nessas referências, o que você quer igual, o que é proibido…"
            onChange={(e) => patchM({ instruction: e.target.value })}
          />
        </section>

        <section className="st-sec">
          <h4>Tipografia</h4>
          <div className="st-sub">Fontes principais do projeto</div>
          <div className="st-grid4">
            <FontPicker label="Título" fonts={fonts} value={m.fonts?.title} onChange={(v) => patchM((mm) => ({ fonts: { ...mm.fonts, title: v } }))} />
            <FontPicker label="Subtítulo" fonts={fonts} value={m.fonts?.subtitle} onChange={(v) => patchM((mm) => ({ fonts: { ...mm.fonts, subtitle: v } }))} />
            <FontPicker label="Texto" fonts={fonts} value={m.fonts?.body} onChange={(v) => patchM((mm) => ({ fonts: { ...mm.fonts, body: v } }))} />
            <FontPicker label="Destaque" fonts={fonts} value={m.fonts?.accent} onChange={(v) => patchM((mm) => ({ fonts: { ...mm.fonts, accent: v } }))} />
          </div>

          <div className="st-sub st-sub-row">
            <span>Fontes por situação</span>
            <span className="muted small">✨ dinâmica: o Claude escolhe entre as suas fontes instaladas · ★ favoritas: só as que você escolher</span>
            <span className="st-grow" />
            <button className="btn small" title="Todas as situações ficam com o Claude escolhendo" onClick={() => patchCases((cs) => cs.map((c) => ({ ...c, mode: 'dynamic' })))}>
              <Sparkles size={12} /> Tudo dinâmico
            </button>
            <button className="btn small" onClick={() => patchCases((cs) => [...cs, { id: uid(), name: 'Nova situação', mode: 'dynamic', favorites: [] }])}>
              <Plus size={12} /> Situação
            </button>
          </div>
          <div className="st-cases">
            {cases.map((c) => (
              <div key={c.id} className={'st-case m-' + c.mode}>
                <input className="st-case-name" value={c.name} onChange={(e) => patchCase(c.id, { name: e.target.value })} />
                <div className="seg st-case-mode">
                  <button className={c.mode === 'dynamic' ? 'on' : ''} onClick={() => patchCase(c.id, { mode: 'dynamic' })} title="O Claude escolhe a fonte sozinho">
                    ✨ Dinâmica
                  </button>
                  <button className={c.mode === 'favorites' ? 'on' : ''} onClick={() => patchCase(c.id, { mode: 'favorites' })} title="Usar só as fontes que você escolher">
                    ★ Favoritas
                  </button>
                </div>
                <div className="st-case-fonts">
                  {c.mode === 'dynamic' ? (
                    <span className="muted small">o Claude escolhe{c.favorites.length ? ` (suas favoritas ficam guardadas: ${c.favorites.length})` : ''}</span>
                  ) : (
                    <>
                      {c.favorites.map((ft) => (
                        <span key={ft} className="st-fav" style={{ fontFamily: `"${ft}"` }}>
                          {ft}
                          <X size={11} onClick={() => patchCase(c.id, { favorites: c.favorites.filter((x) => x !== ft) })} />
                        </span>
                      ))}
                      <FontPicker
                        compact
                        fonts={fonts}
                        placeholder="+ favorita"
                        onChange={(v) => v && !c.favorites.includes(v) && patchCase(c.id, { favorites: [...c.favorites, v] })}
                      />
                    </>
                  )}
                </div>
                <button className="icon-btn danger" title="Tirar situação" onClick={() => patchCases((cs) => cs.filter((x) => x.id !== c.id))}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          <input className="st-sample-input" value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Texto de exemplo" />
          <div className="st-type-preview" style={{ background: m.colors?.[0] ?? '#0b0d12' }}>
            <div style={{ fontFamily: m.fonts?.title ? `"${m.fonts.title}"` : undefined, color: m.colors?.[1] ?? '#fff' }} className="tp-title">
              {sample}
            </div>
            <div style={{ fontFamily: m.fonts?.subtitle ? `"${m.fonts.subtitle}"` : undefined, color: m.colors?.[2] ?? '#e8ebf2' }} className="tp-sub">
              Episódio 7 · o erro que quase todo mundo comete
            </div>
            <div style={{ fontFamily: m.fonts?.body ? `"${m.fonts.body}"` : undefined, color: m.colors?.[2] ?? m.colors?.[1] ?? '#d6dae3' }} className="tp-body">
              Mais da metade dos jogos lançados na Steam não passa de mil avaliações.
            </div>
            <div style={{ fontFamily: m.fonts?.accent ? `"${m.fonts.accent}"` : undefined, color: m.colors?.[3] ?? '#ffd34d' }} className="tp-accent">
              73% · 2025
            </div>
          </div>
        </section>
        <section className="st-sec">
          <h4>Visual</h4>
          <div className="st-row">
            <span className="st-lbl">Fundo</span>
            <div className="st-chips">
              {BACKGROUNDS.map((b) => (
                <button key={b} className={'st-chip' + (m.background === b ? ' on' : '')} onClick={() => patchM({ background: m.background === b ? undefined : b })}>
                  {b}
                </button>
              ))}
              <input
                className="st-chip-input"
                placeholder="outro…"
                value={m.background && !BACKGROUNDS.includes(m.background) ? m.background : ''}
                onChange={(e) => patchM({ background: e.target.value || undefined })}
              />
            </div>
          </div>
          <div className="st-row">
            <span className="st-lbl">Câmera</span>
            <div className="st-chips">
              {CAMERA.map((c) => (
                <button key={c} className={'st-chip' + (m.camera?.includes(c) ? ' on' : '')} onClick={() => patchM((mm) => ({ camera: toggle(mm.camera, c) }))}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="st-row">
            <span className="st-lbl">Transições</span>
            <div className="st-chips">
              {TRANSITIONS.map((c) => (
                <button key={c} className={'st-chip' + (m.transitions?.includes(c) ? ' on' : '')} onClick={() => patchM((mm) => ({ transitions: toggle(mm.transitions, c) }))}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="st-row">
            <span className="st-lbl">Ritmo</span>
            <div className="st-chips">
              {PACES.map((p) => (
                <button key={p} className={'st-chip' + (m.pace === p ? ' on' : '')} onClick={() => patchM({ pace: m.pace === p ? undefined : p })}>
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="st-row">
            <span className="st-lbl">
              <Palette size={12} /> Cores
            </span>
            <div className="st-colors">
              {(m.colors ?? []).map((c, i) => (
                <span key={i} className="st-color">
                  <input type="color" value={c} onChange={(e) => patchM({ colors: (m.colors ?? []).map((x, k) => (k === i ? e.target.value : x)) })} />
                  <code>{c}</code>
                  <X size={11} onClick={() => patchM({ colors: (m.colors ?? []).filter((_, k) => k !== i) })} />
                </span>
              ))}
              {(m.colors?.length ?? 0) < 8 && (
                <button className="btn small" onClick={() => patchM((mm) => ({ colors: [...(mm.colors ?? []), '#7c8cff'] }))}>
                  <Plus size={12} /> Cor
                </button>
              )}
            </div>
          </div>
        </section>

      </main>

      {/* ---------- treinar + prévia ---------- */}
      <aside className="st-side">
        <button className="st-rocket" disabled={!!busy || !canTrain} onClick={train} title={canTrain ? '' : 'Adicione referências, uma instrução ou cores primeiro'}>
          {busy?.startsWith('O Claude') ? <Loader2 size={22} className="spin" /> : <Rocket size={22} />}
          <span>
            <b>{busy?.startsWith('O Claude') ? 'Treinando…' : f.motion?.learned ? 'Treinar de novo' : 'Enviar treino pro Claude'}</b>
            <small>
              {busy?.startsWith('O Claude')
                ? `${elapsed}s · analisando ${images.length} imagem(ns) com calma`
                : `${m.refs.length} referência(s) · ${images.length} imagem(ns) vão junto`}
            </small>
          </span>
        </button>
        {error && <div className="st-error">{error}</div>}

        <div className="st-preview-head">
          <span>Prévia do estilo ({pw}×{ph})</span>
          {f.motion?.learned?.demoHtml && (
            <span className="st-preview-actions">
              {demoPath && (
                <>
                  <button className="icon-btn" title="Abrir a demo no navegador (tela cheia)" onClick={() => api.openPath(demoPath)}>
                    <ExternalLink size={14} />
                  </button>
                  <button className="icon-btn" title="Mostrar o arquivo da demo na pasta" onClick={() => api.showItem(demoPath)}>
                    <FolderOpen size={14} />
                  </button>
                </>
              )}
              <button className="icon-btn" title="Rodar de novo" onClick={() => setReplay((n) => n + 1)}>
                <RotateCcw size={14} />
              </button>
            </span>
          )}
        </div>
        <div className="st-stage" ref={stageRef}>
          {demoHtml && demoSrc ? (
            <iframe
              key={replay + (f.motion?.learned?.at ?? '')}
              title="demo do estilo"
              sandbox="allow-scripts"
              src={demoSrc}
              style={{ width: pw, height: ph, transform: `scale(${scale})` }}
            />
          ) : (
            <div className="st-stage-empty">Depois do treino, o Claude mostra aqui uma demo animada no estilo pra você conferir.</div>
          )}
        </div>

        {f.motion?.learned && (
          <div className="st-guide">
            <div className="st-guide-head">
              <span>
                Guia aprendido · {new Date(f.motion.learned.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
              </span>
              <button className="icon-btn" title="Copiar guia" onClick={() => navigator.clipboard.writeText(f.motion!.learned!.guide)}>
                <Copy size={13} />
              </button>
            </div>
            <div className="st-guide-text">{f.motion.learned.guide}</div>
          </div>
        )}
      </aside>
    </div>
  )
}
