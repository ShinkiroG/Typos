import { useEffect, useMemo, useState } from 'react'
import { FilePlus2, FolderOpen, Settings, X, Trash2, FileClock, History, PenLine, Film, Palette, Clapperboard, ArrowRight, Lightbulb, Play } from 'lucide-react'
import { api, type ProjectData } from '../lib'
import '../home.css'

type Recent = { dir: string; title: string; openedAt: string }
type Draft = Awaited<ReturnType<typeof api.drafts>>[number]

const when = (iso: string) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? `hoje, ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : d.toLocaleDateString('pt-BR')
}

const greeting = () => {
  const h = new Date().getHours()
  return h < 5 ? 'Boa madrugada' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'
}

const TIPS = [
  'Ctrl+1 a Ctrl+6 trocam o tipo do bloco: capítulo, fala, prompt, transição, sobe som, sonora.',
  'Selecione um trecho e clique em Prompt na bolha de formatação pra prender um pedido de motion naquele pedaço.',
  'Na Montagem, C liga a lâmina, S corta no cursor, E faz a Emenda entre dois cortes e R grava.',
  'Pastas ⭐ e bibliotecas de som favoritas são as que o Claude usa com mais frequência no Render.',
  'No Render, prévia a 25% sai em segundos; deixe o Full HD pra versão final.',
  'Capítulos viram lettering capitular: clique com o botão direito no capítulo pra trocar.',
  'Ctrl+Shift+S salva uma cópia em outra pasta e continua trabalhando nela.'
]

const FLOW = [
  { icon: <PenLine size={18} />, name: 'Roteiro', text: 'Fala, prompts de motion, transições e sobe som, com tempo de leitura.' },
  { icon: <Film size={18} />, name: 'Montagem', text: 'Grave ou importe a narração, corte os silêncios e monte a timeline.' },
  { icon: <Palette size={18} />, name: 'Estilo', text: 'Ensine seu motion ao Claude com referências, fontes e cores.' },
  { icon: <Clapperboard size={18} />, name: 'Render', text: 'Confira tudo que vai pro Claude e clique em Criar Vídeo.' }
]

/** linhas da página que se escreve na abertura (tipo: fala, prompt, sobe som…) */
const INTRO_LINES: { kind: string; text: string; w?: number }[] = [
  { kind: 'chapter', text: 'CAPÍTULO 1' },
  { kind: 'fala', text: '', w: 92 },
  { kind: 'fala', text: '', w: 78 },
  { kind: 'prompt', text: '[PROMPT] câmera entra devagar no título' },
  { kind: 'fala', text: '', w: 85 },
  { kind: 'sound', text: '[SOBE SOM] whoosh' },
  { kind: 'fala', text: '', w: 60 }
]

const INTRO_KEY = 'typos.introPlayed'
const shouldPlayIntro = () => {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
    return !sessionStorage.getItem(INTRO_KEY)
  } catch {
    return true
  }
}

function Intro({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    try {
      sessionStorage.setItem(INTRO_KEY, '1')
    } catch {
      /* sem storage: toca de novo na próxima vez, tudo bem */
    }
    const a = setTimeout(() => setLeaving(true), 2500)
    const b = setTimeout(onDone, 3100)
    return () => (clearTimeout(a), clearTimeout(b))
  }, [])
  const skip = () => {
    setLeaving(true)
    setTimeout(onDone, 350)
  }
  return (
    <div className={'intro' + (leaving ? ' leaving' : '')} onClick={skip} title="Clique pra pular">
      <div className="intro-page">
        {INTRO_LINES.map((l, i) => (
          <div key={i} className={'intro-line ' + l.kind} style={{ animationDelay: `${0.15 + i * 0.22}s`, ...(l.w ? { width: l.w + '%' } : {}) }}>
            {l.text}
          </div>
        ))}
        <span className="intro-caret" />
      </div>
      <div className="intro-word">
        {'Typos'.split('').map((c, i) => (
          <span key={i} style={{ animationDelay: `${1.55 + i * 0.08}s` }}>
            {c}
          </span>
        ))}
      </div>
    </div>
  )
}

export function Welcome({
  onOpen,
  onOpenSettings
}: {
  onOpen: (dir: string, data: ProjectData, draft: boolean) => void
  onOpenSettings: () => void
}) {
  const [recent, setRecent] = useState<Recent[]>([])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [error, setError] = useState('')
  const [intro, setIntro] = useState(shouldPlayIntro)
  const tip = useMemo(() => TIPS[Math.floor(Math.random() * TIPS.length)], [])

  const refresh = () => {
    api.recentProjects().then(setRecent)
    api.drafts().then(setDrafts)
  }
  useEffect(() => {
    refresh()
  }, [])

  const handle = (r: any) => {
    if (!r) return
    if (r.error) return setError(r.error)
    onOpen(r.dir, r.data, !!r.draft)
  }

  /** o último em que mexeu: recente ou rascunho, o mais novo */
  const last = useMemo(() => {
    const r = recent[0] && { dir: recent[0].dir, title: recent[0].title, at: recent[0].openedAt, preview: '', draft: false }
    const d = drafts[0] && { dir: drafts[0].dir, title: drafts[0].title, at: drafts[0].updatedAt, preview: drafts[0].preview, draft: true }
    if (!r) return d
    if (!d) return r
    return new Date(d.at) > new Date(r.at) ? d : r
  }, [recent, drafts])

  return (
    <div className={'welcome home2' + (intro ? ' behind-intro' : '')}>
      {intro && <Intro onDone={() => setIntro(false)} />}
      <div className="home-bg" aria-hidden>
        <span className="blob b1" />
        <span className="blob b2" />
        <span className="blob b3" />
        <div className="home-lines">
          {Array.from({ length: 14 }, (_, i) => (
            <i key={i} style={{ width: `${30 + ((i * 37) % 55)}%`, animationDelay: `${-i * 1.7}s` }} />
          ))}
        </div>
      </div>

      <button className="icon-btn welcome-gear" title="Configurações" onClick={onOpenSettings}>
        <Settings size={18} />
      </button>

      <div className="home-wrap">
        <section className="home-hero">
          <div className="home-brand">
            <span className="home-logo">T</span>
            <div>
              <h1>Typos</h1>
              <span className="home-ver">V2</span>
            </div>
          </div>
          <p className="home-hello">{greeting()}! Do roteiro ao vídeo pronto, no mesmo lugar.</p>
          <div className="welcome-actions">
            <button className="btn primary big home-new" onClick={async () => handle(await api.newProject())} title="Começa na hora; salva sozinho como rascunho">
              <FilePlus2 size={18} /> Novo roteiro
            </button>
            <button className="btn big" onClick={async () => handle(await api.openProject())}>
              <FolderOpen size={18} /> Abrir pasta…
            </button>
          </div>
          {error && <div className="error">{error}</div>}
          <div className="home-tip">
            <Lightbulb size={14} /> <span>{tip}</span>
          </div>
        </section>

        <section className="home-continue">
          {last ? (
            <button className="home-cont-card" onClick={async () => handle(await api.openProject(last.dir))}>
              <span className="home-cont-label">
                <Play size={12} /> Continuar de onde parou
              </span>
              <div className="home-paper">
                <b>{last.title}</b>
                {last.preview ? <p>{last.preview}</p> : <p className="muted">{last.dir}</p>}
                <div className="home-paper-lines">
                  <i />
                  <i className="p" />
                  <i />
                  <i className="s" />
                </div>
              </div>
              <span className="home-cont-foot">
                {last.draft ? 'rascunho' : 'salvo'} · {when(last.at)} <ArrowRight size={14} />
              </span>
            </button>
          ) : (
            <div className="home-cont-card empty">
              <span className="home-cont-label">Seu primeiro roteiro</span>
              <div className="home-paper">
                <b>Comece pelo texto</b>
                <p className="muted">Escreva a fala, marque os prompts de motion e o Typos calcula o tempo de cada trecho.</p>
                <div className="home-paper-lines">
                  <i />
                  <i className="p" />
                  <i />
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="home-flow">
          {FLOW.map((f, i) => (
            <div key={f.name} className="home-step" style={{ animationDelay: `${0.1 + i * 0.08}s` }}>
              <span className="home-step-icon">{f.icon}</span>
              <b>
                <small>{i + 1}</small> {f.name}
              </b>
              <p>{f.text}</p>
            </div>
          ))}
        </section>

        <div className="welcome-lists home-lists">
          <section>
            <h3>
              <History size={13} /> Arquivos recentes <span className="home-count">{recent.length}</span>
            </h3>
            {recent.length === 0 ? (
              <p className="list-empty">Os roteiros que você salvar ou abrir aparecem aqui.</p>
            ) : (
              <ul className="recent">
                {recent.map((r) => (
                  <li key={r.dir} onClick={async () => handle(await api.openProject(r.dir))}>
                    <span className="recent-title">{r.title}</span>
                    <span className="recent-dir">{r.dir}</span>
                    <span className="recent-date">{when(r.openedAt)}</span>
                    <button
                      className="icon-btn recent-x"
                      title="Tirar da lista (não apaga o arquivo)"
                      onClick={async (e) => {
                        e.stopPropagation()
                        await api.removeRecent(r.dir)
                        refresh()
                      }}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>
              <FileClock size={13} /> Rascunhos não salvos <span className="home-count">{drafts.length}</span>
            </h3>
            {drafts.length === 0 ? (
              <p className="list-empty">Nenhum rascunho. Um roteiro novo fica aqui até você salvar.</p>
            ) : (
              <ul className="recent">
                {drafts.map((d) => (
                  <li key={d.dir} onClick={async () => handle(await api.openProject(d.dir))}>
                    <span className="recent-title">{d.title}</span>
                    <span className="recent-dir">{d.preview || 'sem texto ainda'}</span>
                    <span className="recent-date">{when(d.updatedAt)}</span>
                    <button
                      className="icon-btn danger recent-x"
                      title="Apagar rascunho"
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (!confirm(`Apagar o rascunho "${d.title}"? Não dá pra desfazer.`)) return
                        await api.deleteDraft(d.dir)
                        refresh()
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
