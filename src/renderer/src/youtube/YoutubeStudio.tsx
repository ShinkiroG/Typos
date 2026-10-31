import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Copy, Download, ImagePlus, ListFilter, MoreHorizontal, Pin, Play, Share2, ThumbsDown, ThumbsUp, Trash2, X } from 'lucide-react'
import { api, attachmentUrl, splitTags, tagsLength, ytHashtags, YT_LIMITS, type Attachment, type YoutubePage } from '../lib'
import { channelHandle, richParts } from './rich'
import './youtube.css'

/**
 * Workspace YouTube: imita a página de assistir do YouTube pra deixar pronto, antes de publicar, o título,
 * a thumbnail, a descrição e o 1º comentário fixado. Tudo salva no projeto; o nome do canal fica no PC.
 */

interface Props {
  active: boolean
  dir: string
  /** nome do roteiro: vira o título sugerido enquanto o do vídeo está vazio */
  projectTitle: string
  page: YoutubePage
  onChange: (p: YoutubePage) => void
}

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i

/** textarea que cresce com o texto */
function AutoText({ className, value, onChange, placeholder, autoFocus, onBlur }: {
  className?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  onBlur?: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = el.scrollHeight + 'px'
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      className={className}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onBlur={onBlur}
      spellCheck
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function Rich({ text }: { text: string }) {
  return (
    <>
      {richParts(text).map((p, i) => (p.kind === 'text' ? <span key={i}>{p.text}</span> : <span key={i} className="yt-link">{p.text}</span>))}
    </>
  )
}

function Counter({ n, max }: { n: number; max: number }) {
  return <span className={'yt-count' + (n > max ? ' over' : n > max * 0.9 ? ' near' : '')}>{n}/{max}</span>
}

function Tags({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [text, setText] = useState('')
  const [copied, setCopied] = useState(false)
  const add = (raw: string) => {
    const more = splitTags(raw, tags)
    if (more.length) onChange([...tags, ...more])
    setText('')
  }
  return (
    <div className="yt-tagbox">
      <div className="yt-tagbox-head">
        <b>Tags</b>
        <span className="yt-dim">Não aparecem na página: vão no YouTube Studio. Enter ou vírgula separa.</span>
        <span className="yt-grow" />
        <Counter n={tagsLength(tags)} max={YT_LIMITS.tags} />
        <button
          className="btn small"
          disabled={!tags.length}
          title="Copiar as tags separadas por vírgula, pra colar no YouTube Studio"
          onClick={() => {
            navigator.clipboard.writeText(tags.join(', '))
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          <Copy size={13} /> {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <div className="yt-tags-input">
        {tags.map((t, i) => (
          <span key={t} className="yt-tag">
            {t}
            <button title="Tirar" onClick={() => onChange(tags.filter((_, j) => j !== i))}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          value={text}
          placeholder={tags.length ? '' : 'Adicionar tag'}
          spellCheck={false}
          onChange={(e) => (/[,\n]/.test(e.target.value) ? add(e.target.value) : setText(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(text)
            } else if (e.key === 'Backspace' && !text && tags.length) onChange(tags.slice(0, -1))
          }}
          onBlur={() => text.trim() && add(text)}
        />
      </div>
    </div>
  )
}

export function YoutubeStudio({ active, dir, projectTitle, page, onChange }: Props) {
  const ref = useRef(page)
  ref.current = page
  const set = (p: Partial<YoutubePage>) => onChange({ ...ref.current, ...p })

  const [channel, setChannel] = useState(() => localStorage.getItem('typos.ytChannel') ?? '')
  useEffect(() => {
    localStorage.setItem('typos.ytChannel', channel)
  }, [channel])
  const handle = channelHandle(channel)
  const initial = (channel.trim()[0] ?? 'T').toUpperCase()

  const [editDesc, setEditDesc] = useState(false)
  const [descOpen, setDescOpen] = useState(false)
  const [drag, setDrag] = useState(false)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const thumbUrl = page.thumb ? attachmentUrl(page.thumb) : null
  const title = page.title || projectTitle
  const tags = ytHashtags(page.description)

  const applyThumb = (a: Attachment | null | undefined) => {
    if (!a) return setError('Não deu pra usar esse arquivo como thumbnail.')
    setError('')
    setSize(null)
    set({ thumb: a })
  }
  const fromPaths = async (paths: string[]) => {
    const img = paths.filter((p) => IMAGE.test(p))
    if (!img.length) return setError('A thumbnail precisa ser uma imagem (PNG, JPG ou WEBP).')
    const r: Attachment[] = await api.importPaths(dir, img.slice(0, 1))
    applyThumb(r[0])
  }
  const fromBlob = async (blob: Blob) =>
    applyThumb(await api.importBuffer(dir, `thumbnail.${blob.type.split('/')[1] || 'png'}`, new Uint8Array(await blob.arrayBuffer())))

  // Ctrl+V com uma imagem copiada (fora dos campos de texto) troca a thumbnail
  useEffect(() => {
    if (!active) return
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
      if (!file) return
      e.preventDefault()
      fromBlob(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [active, dir])

  const sizeWarn =
    size && (Math.abs(size.w / size.h - 16 / 9) > 0.02 ? `Fora de 16:9 (${size.w}×${size.h}): o YouTube põe faixas pretas.` : size.w < 1280 ? `${size.w}×${size.h}: o YouTube pede pelo menos 1280×720.` : '')

  return (
    <div className="yt-studio">
      <div className="yt-page">
        <main className="yt-main">
          {/* ---------- player = thumbnail ---------- */}
          <div
            className={'yt-player' + (drag ? ' drag' : '') + (thumbUrl ? '' : ' empty')}
            onClick={() => !thumbUrl && fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDrag(false)
              const files = [...e.dataTransfer.files]
              if (files.length) fromPaths(files.map((f) => api.pathForFile(f)))
            }}
          >
            {thumbUrl ? (
              <>
                <img src={thumbUrl} alt="" onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
                <div className="yt-play">
                  <Play size={34} fill="currentColor" />
                </div>
                <div className="yt-bar">
                  <span />
                </div>
                <div className="yt-thumb-tools" onClick={(e) => e.stopPropagation()}>
                  <button className="btn small" onClick={() => fileRef.current?.click()} title="Escolher outra imagem (ou arraste/cole com Ctrl+V)">
                    <ImagePlus size={13} /> Trocar
                  </button>
                  <button className="btn small" onClick={() => api.openPath(dir + '\\' + page.thumb!.path.replace(/\//g, '\\'))} title="Abrir a imagem">
                    <Download size={13} /> Abrir
                  </button>
                  <button className="btn small" onClick={() => set({ thumb: null })} title="Tirar a thumbnail (o arquivo fica na pasta do projeto)">
                    <Trash2 size={13} />
                  </button>
                </div>
              </>
            ) : (
              <div className="yt-drop">
                <ImagePlus size={36} />
                <b>Thumbnail</b>
                <span>Clique, arraste uma imagem ou cole com Ctrl+V · 1280×720 (16:9)</span>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) fromPaths([api.pathForFile(f)])
              }}
            />
          </div>
          {(error || sizeWarn) && <p className="yt-warn">{error || sizeWarn}</p>}

          {/* ---------- título ---------- */}
          {tags.length > 0 && (
            <div className="yt-tags">
              {tags.map((t) => (
                <span key={t} className="yt-link">
                  {t}
                </span>
              ))}
            </div>
          )}
          <div className="yt-field">
            <AutoText className="yt-title" value={page.title} onChange={(v) => set({ title: v.replace(/\n/g, ' ') })} placeholder={projectTitle || 'Título do vídeo'} />
            <Counter n={title.length} max={YT_LIMITS.title} />
          </div>

          {/* ---------- canal e ações ---------- */}
          <div className="yt-owner">
            <div className="yt-avatar">{initial}</div>
            <div className="yt-channel">
              <input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="Nome do canal" spellCheck={false} />
              <span>0 inscritos</span>
            </div>
            <button className="yt-subscribe" tabIndex={-1}>
              Inscrever-se
            </button>
            <span className="yt-grow" />
            <div className="yt-pill">
              <span>
                <ThumbsUp size={17} /> 0
              </span>
              <i />
              <span>
                <ThumbsDown size={17} />
              </span>
            </div>
            <div className="yt-pill">
              <span>
                <Share2 size={17} /> Compartilhar
              </span>
            </div>
            <div className="yt-pill round">
              <MoreHorizontal size={17} />
            </div>
          </div>

          {/* ---------- descrição ---------- */}
          <div className={'yt-desc' + (editDesc ? ' editing' : '')} onClick={() => !editDesc && setEditDesc(true)}>
            <div className="yt-desc-head">
              <b>0 visualizações · Estreia em breve</b>
              <Counter n={page.description.length} max={YT_LIMITS.description} />
            </div>
            {editDesc ? (
              <AutoText
                className="yt-desc-input"
                value={page.description}
                onChange={(v) => set({ description: v })}
                placeholder="Descrição do vídeo: resumo, links, capítulos (0:00 Intro), #hashtags…"
                autoFocus
                onBlur={() => setEditDesc(false)}
              />
            ) : page.description ? (
              <>
                <div className={'yt-desc-text' + (descOpen ? '' : ' clamp')}>
                  <Rich text={page.description} />
                </div>
                <button
                  className="yt-more"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDescOpen((o) => !o)
                  }}
                >
                  {descOpen ? 'Mostrar menos' : '...mais'}
                </button>
              </>
            ) : (
              <div className="yt-desc-text placeholder">Clique pra escrever a descrição.</div>
            )}
          </div>

          {/* ---------- tags (ficam no YouTube Studio, não na página) ---------- */}
          <Tags tags={page.tags ?? []} onChange={(tags) => set({ tags })} />

          {/* ---------- comentários ---------- */}
          <div className="yt-comments">
            <div className="yt-comments-head">
              <b>{page.pinned.trim() ? 1 : 0} comentário{page.pinned.trim() ? '' : 's'}</b>
              <span>
                <ListFilter size={17} /> Ordenar por
              </span>
            </div>
            <div className="yt-comment">
              <div className="yt-avatar small">{initial}</div>
              <div className="yt-comment-body">
                <div className="yt-pinned">
                  <Pin size={12} /> Fixado por {handle}
                </div>
                <div className="yt-comment-author">
                  <span className="yt-owner-badge">{handle}</span> <span className="yt-dim">há 0 minutos</span>
                </div>
                <AutoText className="yt-comment-input" value={page.pinned} onChange={(v) => set({ pinned: v })} placeholder="1º comentário (fica fixado no topo)…" />
                <div className="yt-comment-actions">
                  <ThumbsUp size={15} /> <ThumbsDown size={15} /> <span>Responder</span>
                  <Counter n={page.pinned.length} max={YT_LIMITS.comment} />
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* ---------- a seguir: como a thumbnail fica pequena ---------- */}
        <aside className="yt-side">
          <div className="yt-chips">
            <span className="on">Tudo</span>
            <span>De {channel.trim() || 'seu canal'}</span>
            <span>Relacionados</span>
          </div>
          <div className="yt-card mine" title="Assim seu vídeo aparece nas sugestões">
            <div className="yt-card-thumb">{thumbUrl ? <img src={thumbUrl} alt="" /> : <ImagePlus size={20} />}</div>
            <div className="yt-card-info">
              <b>{title || 'Título do vídeo'}</b>
              <span>{channel.trim() || 'Seu canal'}</span>
              <span>0 visualizações · agora</span>
            </div>
          </div>
          {Array.from({ length: 6 }, (_, i) => (
            <div className="yt-card ghost" key={i}>
              <div className="yt-card-thumb" />
              <div className="yt-card-info">
                <i style={{ width: `${88 - ((i * 17) % 30)}%` }} />
                <i style={{ width: '60%' }} />
                <i style={{ width: '45%' }} />
              </div>
            </div>
          ))}
        </aside>
      </div>
    </div>
  )
}
