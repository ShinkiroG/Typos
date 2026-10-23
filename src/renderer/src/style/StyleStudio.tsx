import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Trash2,
  Save,
  Undo2,
  Check,
  Link2,
  Download,
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
  FolderOpen,
  BookmarkPlus,
  Brain,
  Star
} from 'lucide-react'
import { api, fileUrl, formatLang, langLabel, openPreview, RESOLUTIONS, uid, type Format, type MotionRef, type MotionStyle, type MotionMemoryItem, type FontCase, DEFAULT_FONT_CASES, refWeights, styleFoldersOf, STYLE_FOLDER_ROLES, type StyleFolder, type StyleFolderRole } from '../lib'
import { ASSETS_ANSWER, assetsOnlyPrompt, collectStudy, folderName, guessRole, MAX_STUDY_IMAGES, parseAssets, studyImages, studySection, studyStale } from './assets'
import { FontPicker } from './FontPicker'
import { YoutubeDownload } from '../components/YoutubeDownload'
import { askText } from '../components/AskDialog'

const CAMERA = [
  'estática',
  'zoom-in lento',
  'zoom punch (rápido)',
  'pan lateral',
  'parallax 2.5D',
  'câmera na mão (tremida)',
  'câmera com shake leve suavizado',
  'whip pan',
  'rotação leve',
  'dolly / push-in',
  'tracking em elemento'
]
const TRANSITIONS = ['corte seco', 'whip / swipe', 'zoom through', 'glitch', 'fade', 'slide', 'máscara / wipe', 'flash branco', 'match cut', 'luma fade']
const BACKGROUNDS = ['sólido escuro', 'gradiente suave', 'textura / grão', 'gameplay desfocado', 'papel / colagem', 'grid / tech', 'ilustração plana', 'foto com overlay']
const PACES: MotionStyle['pace'][] = ['calmo', 'médio', 'frenético']
const PREFERRED_LANGS = ['pt-BR', 'pt-PT', 'en-US', 'en-GB', 'es-ES']
const STUDY_BUSY = 'Estudando os assets do estilo…'

const emptyMotion = (f: Format): MotionStyle => ({
  // referências antigas (Formatos → referência pro motion) entram como imagens
  refs: (f.motionRefFiles ?? []).map((p) => ({ id: uid(), kind: /\.(mp4|mov|webm|m4v|mkv)$/i.test(p) ? 'video' : 'image', path: p, name: p.split(/[\\/]/).pop() || p })),
  colors: [],
  camera: [],
  transitions: []
})

/** o pedido que vai pra IA, com tudo que o autor escolheu */
function buildPrompt(f: Format, m: MotionStyle, imageList: string[], sample: string, installed: string[], assets: string[] = []) {
  const [w, h] = f.aspect === '9:16' ? [540, 960] : f.aspect === '1:1' ? [720, 720] : f.aspect === '4:5' ? [576, 720] : [960, 540]
  const lines: string[] = []
  lines.push(`Você é diretor de motion design de vídeos para YouTube. Vou te ensinar um ESTILO DE MOTION pra eu usar sempre neste formato de vídeo: "${f.name}" (${f.aspect}).`)
  lines.push('Analise com rigor as referências (imagens; os quadros de cada vídeo estão em ordem cronológica) e as escolhas abaixo. Onde as escolhas e as referências discordarem, as escolhas mandam.')
  lines.push(
    'Imagens marcadas como SEQUÊNCIA são quadros seguidos do vídeo (8 por segundo): compare quadro a quadro pra entender direção, velocidade e curva (easing) dos movimentos de câmera, transições e animações.'
  )
  lines.push(
    'Imagens marcadas como QUADRO A QUADRO são quadros seguidos a 24 por segundo: o autor quer o motion dessa referência com precisão. Leia quadro a quadro a curva de cada movimento (aceleração, overshoot, quantos quadros dura cada entrada e saída, motion blur, defasagem entre elementos) e descreva isso no guia em quadros e milissegundos.'
  )
  lines.push(
    'Cada referência tem DOIS pesos independentes, de 0 a 100: ESTÉTICA (cores, tipografia, composição, fundo, textura) e MOTION (movimento de câmera, transições, ritmo, como os elementos entram e saem). 0 = ignore esse aspecto dela; 100 = siga à risca. Uma referência pode ter os dois altos, os dois baixos ou um de cada. Pese o que tirar de cada uma por esses números.'
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
  if (f.negative?.trim()) lines.push(`- O que EVITAR (prompt negativo, nada disso pode aparecer): ${f.negative.trim()}`)
  if (f.rules?.trim()) {
    lines.push('')
    lines.push('## Instrução do autor (como é o estilo)')
    lines.push(f.rules.trim())
  }
  const links = m.refs.filter((r) => r.kind === 'link' && r.url)
  if (links.length) {
    lines.push('')
    lines.push('## Links de referência (contexto; abra a página se ajudar)')
    for (const l of links) lines.push(`- ${l.url} ${focusLabel(l)}${l.note ? ` — ${l.note}` : ''}`)
  }
  if (needList && installed.length) {
    lines.push('')
    lines.push('## Fontes instaladas no PC (escolha só daqui, pelo nome exato)')
    lines.push(installed.join(' | '))
  }
  if (assets.length) {
    lines.push('')
    lines.push(...assets)
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
    'Guia do estilo em português, markdown curto e prático, pra ser seguido em todo prompt de motion deste formato: identidade em 1 frase; de qual referência veio o quê (respeitando os pesos de estética e motion de cada uma); fundo; paleta com hex e função de cada cor; tipografia e hierarquia (as 4 fontes principais com tamanhos, peso, caixa, espaçamento) e uma tabela "Fontes por situação" com a fonte escolhida pra cada situação (nas dinâmicas, a que você escolheu e por quê, em poucas palavras); movimentos de câmera com duração e easing; transições (quando usar cada uma); ritmo de cortes; elementos gráficos recorrentes (molduras, lower thirds, setas, marcadores); o que NUNCA fazer; checklist final.'
  )
  lines.push('</guia>')
  lines.push('<demo>')
  lines.push(
    `Um arquivo HTML completo e autocontido (CSS e JS inline, sem internet, sem imagens externas), em ${w}x${h} px preenchendo a página toda (body sem margem, overflow hidden), que demonstra o estilo animado em loop contínuo de 8 a 12 segundos: abertura com o título "${sample}", um lower third/legenda, um destaque de número ou dado, e uma transição do estilo. Use as fontes pelo nome (font-family) e as cores do estilo; anime com CSS keyframes ou requestAnimationFrame.`
  )
  lines.push('</demo>')
  if (assets.length) lines.push(...ASSETS_ANSWER)
  return lines.join('\n')
}

/** mesmo plano do main: estética = quadros soltos espalhados; motion = sequências rápidas; quadro a quadro = sequências longas a 24/s */
export function framePlan(r: MotionRef) {
  const w = refWeights(r)
  const even = Math.round(2 + (Math.max(0, Math.min(100, w.aesthetic)) / 100) * 7)
  if (w.frameByFrame) return { even, bursts: 4, perBurst: 12, fps: 24 }
  const m = Math.max(0, Math.min(100, w.motion))
  const bursts = m >= 25 ? Math.min(3, 1 + Math.round((m - 25) / 35)) : 0 // 25→1 · 60→2 · 95→3
  return { even, bursts, perBurst: 6, fps: 8 }
}
const framesOf = (r: MotionRef) => {
  const p = framePlan(r)
  return p.even + p.bursts * p.perBurst
}

/** "[estética 70 · motion 30]" — o mesmo texto vai em cada imagem/link no pedido */
export function focusLabel(r: MotionRef) {
  const w = refWeights(r)
  return `[estética ${w.aesthetic} · motion ${w.motion}${w.frameByFrame ? ' · quadro a quadro' : ''}]`
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
  const [ytOpen, setYtOpen] = useState(false)
  const [sample, setSample] = useState('Você está fazendo o marketing errado')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [replay, setReplay] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [sent, setSent] = useState(0)

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

  // ---------- pastas do estilo ----------
  const folders = styleFoldersOf(f)
  /** grava as pastas e espelha as visuais no campo antigo (versões anteriores do Typos só leem ele) */
  const setFolders = (list: StyleFolder[]) => patch({ styleFolders: list, assetFolders: list.filter((x) => x.role === 'visual').map((x) => x.path) })
  const patchFolder = (path: string, p: Partial<StyleFolder>) => setFolders(folders.map((x) => (x.path === path ? { ...x, ...p } : x)))
  const addFolder = async () => {
    const p = await api.pickFolder()
    if (!p || folders.some((x) => x.path === p)) return
    const list = await api.scanFolder(p).catch(() => ({ error: '' }))
    setFolders([...styleFoldersOf(fRef.current), { path: p, role: 'error' in list ? 'visual' : guessRole(list) }])
  }

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

  // ---------- memória de motion (salva na hora, sem mexer no rascunho do resto) ----------
  const memory = m.memory ?? []
  const setMemory = (list: MotionMemoryItem[]) => {
    if (saved) onChange(formats.map((x) => (x.id === editId ? { ...x, motion: { ...(x.motion ?? emptyMotion(x)), memory: list } } : x)))
    if (drafts[editId] || !saved) patchM({ memory: list })
  }
  const remember = (item: Omit<MotionMemoryItem, 'id' | 'at'>) => setMemory([...memory, { ...item, id: uid(), at: new Date().toISOString() }])
  const demoInMemory = !!f.motion?.learned && memory.some((x) => x.source === 'estilo' && x.html === f.motion!.learned!.demoHtml.slice(0, 12000))

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
  // quantas imagens vão (estimativa pelo foco de cada referência)
  const MAX_IMAGES = 100
  const estimate = useMemo(() => Math.min(MAX_IMAGES, m.refs.reduce((s, r) => s + (r.kind === 'image' ? 1 : r.kind === 'video' ? framesOf(r) : 0), 0)), [m.refs])

  /** junta as imagens na hora do treino: de vídeo, tira os quadros que o foco pede */
  const collectImages = async () => {
    const out: { path: string; desc: string }[] = []
    for (const [i, r] of m.refs.entries()) {
      const note = ` ${focusLabel(r)}` + (r.note ? ` — nota do autor: ${r.note}` : '')
      if (r.kind === 'image' && r.path) out.push({ path: r.path, desc: `referência ${i + 1} (imagem "${r.name}")${note}` })
      if (r.kind !== 'video' || !r.path) continue
      setBusy(`Tirando quadros de "${r.name}"…`)
      const fr = await api.motionFrames(r.path, refWeights(r))
      if ('error' in fr) {
        // o vídeo sumiu do lugar: usa os quadros que já estavam guardados
        ;(r.frames ?? []).forEach((p, k) => out.push({ path: p, desc: `referência ${i + 1} (vídeo "${r.name}", quadro ${k + 1})${k === 0 ? note : ''}` }))
        continue
      }
      const even = fr.filter((x) => x.kind === 'even')
      fr.forEach((x, k) =>
        out.push({
          path: x.path,
          desc:
            x.kind === 'even'
              ? `referência ${i + 1} (vídeo "${r.name}", quadro solto ${x.index + 1}/${even.length}, em ${x.t.toFixed(1)}s)${k === 0 ? note : ''}`
              : x.fps >= 24
                ? `referência ${i + 1} (vídeo "${r.name}", QUADRO A QUADRO ${x.group}, quadro ${x.index + 1}/${fr.filter((y) => y.group === x.group).length} — quadros seguidos a ${x.fps} por segundo, a partir de ${x.t.toFixed(2)}s: compare com o anterior pra medir a curva do movimento)`
                : `referência ${i + 1} (vídeo "${r.name}", SEQUÊNCIA ${x.group}, quadro ${x.index + 1}/${fr.filter((y) => y.group === x.group).length} — quadros seguidos a ${x.fps} por segundo, a partir de ${x.t.toFixed(2)}s: compare com o anterior pra ler o movimento)`
        })
      )
    }
    return out.slice(0, MAX_IMAGES)
  }

  const canTrain = m.refs.length > 0 || !!f.rules?.trim() || !!m.colors?.length || folders.length > 0
  /** as pastas do estilo pro pedido: a lista (com a análise dos sons) e as primeiras imagens */
  const studyInput = async (room: number) => {
    const items = await collectStudy(f, setBusy)
    const imgs = studyImages(items).slice(0, Math.max(0, room))
    return { section: studySection(folders, items), images: imgs.map((x) => ({ path: x.path, desc: `asset do estilo "${x.rel}"` })) }
  }
  const assetsGuideOf = (guide: string, provider: string) => ({ at: new Date().toISOString(), provider, guide, folders: folders.map((x) => `${x.role}|${x.path}`) })
  const train = async () => {
    setError('')
    setBusy('O Claude está estudando as referências…')
    const t0 = Date.now()
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    try {
      const refImages = await collectImages()
      const study = folders.length ? await studyInput(MAX_IMAGES - refImages.length) : null
      const images = [...refImages, ...(study?.images ?? [])]
      setBusy('O Claude está estudando as referências…')
      setSent(images.length)
      const r = await api.motionTrain({ prompt: buildPrompt(f, m, images.map((i) => i.desc), sample, fonts, study?.section), images: images.map((i) => i.path) })
      if ('error' in r) throw new Error(r.error)
      const { guide, demo } = parseAnswer(r.text)
      if (!guide && !demo) throw new Error('A IA respondeu fora do formato. Tente de novo.')
      const assetsGuide = study ? parseAssets(r.text) : ''
      const next = {
        ...fRef.current,
        motion: {
          ...(fRef.current.motion ?? m),
          learned: { at: new Date().toISOString(), provider: r.provider, guide: guide || r.text, demoHtml: demo },
          ...(assetsGuide ? { assetsGuide: assetsGuideOf(assetsGuide, r.provider) } : {})
        }
      }
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

  /** só o guia de assets (sem refazer o guia e a demo do estilo) */
  const studyAssets = async () => {
    setError('')
    setBusy(STUDY_BUSY)
    try {
      const study = await studyInput(MAX_STUDY_IMAGES)
      setBusy(STUDY_BUSY)
      const r = await api.motionTrain({ prompt: assetsOnlyPrompt(f, study.section, study.images.map((x) => x.desc)), images: study.images.map((x) => x.path) })
      if ('error' in r) throw new Error(r.error)
      const guide = parseAssets(r.text)
      if (!guide) throw new Error('A IA respondeu fora do formato. Tente de novo.')
      // estudo custa tempo: já salva
      save({ ...fRef.current, motion: { ...(fRef.current.motion ?? m), assetsGuide: assetsGuideOf(guide, r.provider) } })
    } catch (err) {
      setError((err as Error).message)
    } finally {
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
          <button
            className="icon-btn"
            title="Duplicar estilo (cria uma cópia pra você mudar só o que quiser, ex.: a versão Shorts)"
            onClick={() => {
              const id = uid()
              const copy: Format = structuredClone({ ...clean(f), id, name: `${f.name} (cópia)` })
              if (copy.motion) copy.motion.refs = copy.motion.refs.map((r) => ({ ...r, id: uid() }))
              setDrafts((d) => ({ ...d, [id]: copy }))
              setEditId(id)
            }}
          >
            <Copy size={15} />
          </button>
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
          <div className="st-field">
            <span>Pastas do estilo (assets que valem pra todo vídeo com este estilo; o Typos só guarda o caminho)</span>
            <div className="st-sfolders">
              {folders.map((x) => (
                <div key={x.path} className="st-sfolder">
                  <button className={'icon-btn' + (x.star ? ' on' : '')} title={x.star ? 'Favorita: o Claude usa com mais frequência' : 'Marcar como favorita'} onClick={() => patchFolder(x.path, { star: !x.star })}>
                    <Star size={13} fill={x.star ? 'currentColor' : 'none'} />
                  </button>
                  <span className="st-sfolder-name" title={x.path}>
                    <FolderOpen size={12} /> {folderName(x.path)}
                  </span>
                  <select value={x.role} title="Categoria: Visual entra sempre; Material bruto, SFX e Música entram quando o bloco liga “Usar o Material bruto”" onChange={(e) => patchFolder(x.path, { role: e.target.value as StyleFolderRole })}>
                    {STYLE_FOLDER_ROLES.map((r) => (
                      <option key={r.role} value={r.role}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <input value={x.note ?? ''} placeholder="o que tem / quando usar (opcional)" onChange={(e) => patchFolder(x.path, { note: e.target.value })} />
                  <button className="icon-btn" title="Tirar a pasta do estilo (os arquivos continuam no PC)" onClick={() => setFolders(folders.filter((y) => y.path !== x.path))}>
                    <X size={13} />
                  </button>
                </div>
              ))}
              <div className="st-sfolder-bar">
                <button className="btn small" onClick={addFolder}>
                  <FolderPlus size={12} /> Pasta
                </button>
                {folders.length > 0 && (
                  <button
                    className="btn small"
                    disabled={!!busy}
                    onClick={studyAssets}
                    title="O Typos analisa os sons (impacto, volume, energia) e o Claude escreve o guia de como usar cada asset. O treino do estilo também faz isso."
                  >
                    {busy === STUDY_BUSY ? <Loader2 size={12} className="spin" /> : <Brain size={12} />} {m.assetsGuide ? 'Estudar os assets de novo' : 'Estudar os assets'}
                  </button>
                )}
                {m.assetsGuide && studyStale(f) && <span className="st-warn">as pastas mudaram desde o último estudo</span>}
              </div>
            </div>
            <small className="muted">
              Visual do estilo (logo, pngtuber, molduras) o motion pode usar sempre. Material bruto, SFX e Música entram junto do Material bruto do projeto quando o bloco liga “Usar o Material bruto”.
            </small>
          </div>
        </section>

        <section className="st-sec">
          <h4>Referências de motion</h4>
          <p className="muted small">Arraste vídeos e imagens pra cá, cole prints com <b>Ctrl+V</b> ou cole links. De vídeo o Typos tira 8 quadros-chave pra IA olhar.</p>
          <div className="st-refbar">
            <button className="btn small" onClick={async () => addFiles(await api.motionPickFiles())}>
              <ImagePlus size={13} /> Arquivos…
            </button>
            <button className={'btn small' + (ytOpen ? ' primary' : '')} onClick={() => setYtOpen((o) => !o)} title="Baixar um trecho do YouTube (ou outro site) como referência">
              <Download size={13} /> YouTube
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
          {ytOpen && (
            <YoutubeDownload
              dir=""
              target="motion"
              allowAudio={false}
              hint="Baixe só o trecho do motion (início/fim). Vira referência deste formato: o Typos tira os quadros pra IA olhar."
              onDone={(path) => addFiles([path])}
            />
          )}
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
                {(() => {
                  const w = refWeights(r)
                  // mexer num slider grava os dois (a referência deixa de usar o slider único antigo)
                  const setW = (p: Partial<MotionRef>) => patchRef(r.id, { aesthetic: w.aesthetic, motion: w.motion, ...p })
                  return (
                    <>
                      <label className="st-focus" title="Quanto o Claude aprende da estética desta referência: cores, tipografia, composição, fundo (duplo clique volta pra 50)">
                        <span className={w.aesthetic >= 50 ? 'on' : ''}>estética</span>
                        <input type="range" min={0} max={100} step={5} value={w.aesthetic} onChange={(e) => setW({ aesthetic: Number(e.target.value) })} onDoubleClick={() => setW({ aesthetic: 50 })} />
                        <b>{w.aesthetic}</b>
                      </label>
                      <label className="st-focus" title="Quanto o Claude aprende do motion desta referência: câmera, transições, ritmo (duplo clique volta pra 50)">
                        <span className={w.motion >= 50 ? 'on' : ''}>motion</span>
                        <input type="range" min={0} max={100} step={5} value={w.motion} onChange={(e) => setW({ motion: Number(e.target.value) })} onDoubleClick={() => setW({ motion: 50 })} />
                        <b>{w.motion}</b>
                      </label>
                      {r.kind === 'video' && w.motion >= 100 && (
                        <label className={'st-fbf' + (w.frameByFrame ? ' on' : '')} title="Manda 4 sequências de 12 quadros seguidos (24 por segundo) pro Claude medir cada movimento">
                          <input type="checkbox" checked={!!r.frameByFrame} onChange={(e) => setW({ frameByFrame: e.target.checked })} />
                          <span>
                            <b>Checagem frame a frame</b>
                            <small>mais lento/caro</small>
                          </span>
                        </label>
                      )}
                      {r.kind === 'video' && (
                        <div className="st-focus-info">
                          {(() => {
                            const p = framePlan(r)
                            const what = p.fps >= 24 ? `${p.bursts} sequências quadro a quadro` : `${p.bursts} sequência(s) rápida(s) pra ler o movimento`
                            return `${p.even + p.bursts * p.perBurst} quadros${p.bursts ? ` · ${what}` : ' espalhados'}`
                          })()}
                        </div>
                      )}
                    </>
                  )
                })()}
                <button className="icon-btn danger st-ref-x" title="Tirar" onClick={() => patchM((mm) => ({ refs: mm.refs.filter((x) => x.id !== r.id) }))}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="st-sec">
          <h4>Instrução pro Claude</h4>
          <p className="muted small">Vale no treino e em todo motion deste estilo. Não entra no Roteiro.</p>
          <label className="st-field">
            Como é o estilo
            <textarea
              className="st-instr"
              rows={4}
              value={f.rules ?? ''}
              placeholder="Explique com suas palavras: o que te chama atenção nas referências, o que você quer igual, pngtuber no canto inferior direito, legenda amarela…"
              onChange={(e) => patch({ rules: e.target.value })}
            />
          </label>
          <label className="st-field">
            O que evitar
            <textarea rows={2} value={f.negative ?? ''} placeholder="Ex.: nada de emoji, sem fundo branco, sem texto girando, sem neon…" onChange={(e) => patch({ negative: e.target.value })} />
          </label>
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
              <CustomChips list={m.camera} presets={CAMERA} onChange={(camera) => patchM({ camera })} />
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
              <CustomChips list={m.transitions} presets={TRANSITIONS} onChange={(transitions) => patchM({ transitions })} />
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
                ? `${elapsed}s · analisando ${sent} imagem(ns) com calma`
                : `${m.refs.length} referência(s) · ~${estimate} imagem(ns) vão junto${folders.length ? ` · ${folders.length} pasta(s) de assets` : ''}`}
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
              <button
                className="icon-btn"
                disabled={demoInMemory}
                title={demoInMemory ? 'Esta demo já está na memória de motion' : 'Gostei: guardar esta demo na memória de motion (as prévias dos blocos e o render seguem ela)'}
                onClick={() =>
                  remember({
                    source: 'estilo',
                    title: `Demo do Estilo ${f.name}`,
                    text: 'Demo do treino de estilo aprovada pelo autor: composições, ritmo e transições que funcionaram.',
                    html: f.motion!.learned!.demoHtml.slice(0, 12000)
                  })
                }
              >
                {demoInMemory ? <Check size={14} /> : <BookmarkPlus size={14} />}
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

        {m.assetsGuide && (
          <div className="st-guide">
            <div className="st-guide-head">
              <span>
                Guia dos assets · {new Date(m.assetsGuide.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
              </span>
              <button className="icon-btn" title="Copiar guia dos assets (markdown)" onClick={() => navigator.clipboard.writeText(m.assetsGuide!.guide)}>
                <Copy size={13} />
              </button>
            </div>
            <div className="st-guide-text">{m.assetsGuide.guide}</div>
          </div>
        )}

        <div className="st-guide st-memory">
          <div className="st-guide-head">
            <span>
              <Brain size={13} /> Memória de motion · {memory.length}
            </span>
            <button
              className="icon-btn"
              title="Escrever uma nota (ex.: “gráficos sempre montam da esquerda pra direita”)"
              onClick={async () => {
                const t = await askText('Nota pra memória de motion:')
                if (t?.trim()) remember({ source: 'nota', title: t.trim().slice(0, 50), text: t.trim() })
              }}
            >
              <Plus size={13} />
            </button>
          </div>
          {!memory.length && (
            <div className="st-memory-empty">
              O que você aprovar fica aqui: a demo do Estilo (botão <BookmarkPlus size={11} />), prévias de blocos de instrução aprovadas na Montagem e notas suas. As prévias e o render seguem essa memória.
            </div>
          )}
          {[...memory].reverse().map((x) => (
            <div key={x.id} className="st-memory-item">
              <div>
                <b>{x.title}</b>
                <small>
                  {x.source === 'estilo' ? 'demo do Estilo' : x.source === 'bloco' ? 'bloco aprovado' : 'nota'} · {new Date(x.at).toLocaleDateString('pt-BR')}
                  {x.html ? ' · com animação' : ''}
                </small>
                <p>{x.text}</p>
              </div>
              <button className="icon-btn" title="Esquecer" onClick={() => setMemory(memory.filter((y) => y.id !== x.id))}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}

/** estilos que você digitou (aparecem ligados, com x) + botão "+ outro" pra digitar mais */
function CustomChips({ list, presets, onChange }: { list?: string[]; presets: string[]; onChange: (v: string[]) => void }) {
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const custom = (list ?? []).filter((x) => !presets.includes(x))
  const add = () => {
    const v = text.trim()
    if (v && !(list ?? []).includes(v)) onChange([...(list ?? []), v])
    setText('')
    setTyping(false)
  }
  return (
    <>
      {custom.map((c) => (
        <span key={c} className="st-chip on custom" title="Seu estilo (clique no x pra tirar)">
          {c}
          <X size={11} onClick={() => onChange((list ?? []).filter((x) => x !== c))} />
        </span>
      ))}
      {typing ? (
        <input
          autoFocus
          className="st-chip-input"
          placeholder="digite e Enter…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
            if (e.key === 'Escape') setTyping(false)
          }}
          onBlur={add}
        />
      ) : (
        <button className="st-chip add" onClick={() => setTyping(true)} title="Digitar um estilo seu">
          <Plus size={11} /> outro
        </button>
      )}
    </>
  )
}
