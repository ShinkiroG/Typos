import { useEffect, useState } from 'react'
import { Sparkles, CheckCircle2, XCircle, Loader2, KeyRound, Terminal, Copy } from 'lucide-react'
import { api } from '../lib'

type Status = Awaited<ReturnType<typeof api.aiStatus>>
type ProviderId = Status['providers'][number]['id']

const INSTALL_CMD = 'irm https://claude.ai/install.ps1 | iex'

/** Conexões de IA (Claude Code, API da Anthropic, API da OpenAI) e quem faz cada tarefa. */
export function AiSection() {
  const [st, setSt] = useState<Status | null>(null)
  const [tests, setTests] = useState<Partial<Record<ProviderId, { busy?: boolean; ok?: boolean; message?: string }>>>({})
  const [keys, setKeys] = useState({ anthropicKey: '', openaiKey: '' })

  const refresh = () => api.aiStatus().then(setSt)
  useEffect(() => {
    refresh()
  }, [])
  if (!st) return null

  const p = (id: ProviderId) => st.providers.find((x) => x.id === id)!
  const set = async (patch: Record<string, string | null>) => {
    await api.aiSet(patch)
    refresh()
  }
  const test = async (id: ProviderId) => {
    setTests((t) => ({ ...t, [id]: { busy: true } }))
    const r = await api.aiTest(id)
    setTests((t) => ({ ...t, [id]: r }))
    refresh()
  }
  const saveKey = async (k: 'anthropicKey' | 'openaiKey') => {
    await set({ [k]: keys[k] })
    setKeys((v) => ({ ...v, [k]: '' }))
  }

  const Head = ({ id }: { id: ProviderId }) => {
    const pr = p(id)
    const t = tests[id]
    return (
      <div className="ai-head">
        <span className={'ai-dot' + (pr.configured ? ' on' : '')} />
        <b>{pr.label}</b>
        <span className="ai-caps">{pr.caps.map((c) => (c === 'text' ? 'texto' : 'imagem')).join(' + ')}</span>
        <button className="btn small" disabled={t?.busy} onClick={() => test(id)}>
          {t?.busy ? <Loader2 size={12} className="spin" /> : null} Testar
        </button>
        {t?.message && (
          <div className={'ai-test ' + (t.ok ? 'ok' : 'bad')}>
            {t.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {t.message}
          </div>
        )}
      </div>
    )
  }

  const routeOptions = (task: 'text' | 'image') => st.providers.filter((x) => x.caps.includes(task))

  return (
    <section className="set-section">
      <h4>
        <Sparkles size={14} /> IA
      </h4>
      <p className="muted small">
        As funções de IA do Typos funcionam com qualquer uma destas conexões. Você escolhe embaixo quem faz cada tarefa. As chaves ficam só neste PC.
      </p>

      <div className="ai-card">
        <Head id="claude-code" />
        <p className="muted small">{p('claude-code').detail}</p>
        {!p('claude-code').configured && (
          <div className="ai-install">
            <Terminal size={13} /> No PowerShell: <code>{INSTALL_CMD}</code>
            <button className="icon-btn" title="Copiar comando" onClick={() => navigator.clipboard.writeText(INSTALL_CMD)}>
              <Copy size={12} />
            </button>
            <div className="muted small">Depois abra um terminal novo, rode <code>claude</code> e faça login com sua conta. Usa o seu plano, sem chave.</div>
          </div>
        )}
        <label className="ai-field">
          Caminho do claude.exe (opcional)
          <input
            placeholder="achado sozinho se estiver instalado"
            defaultValue={st.models.claudeCodePath}
            onBlur={(e) => e.target.value !== st.models.claudeCodePath && set({ claudeCodePath: e.target.value })}
          />
        </label>
      </div>

      <div className="ai-card">
        <Head id="anthropic" />
        <p className="muted small">{p('anthropic').detail} · pago por uso em console.anthropic.com</p>
        <div className="key-row">
          <KeyRound size={14} />
          <input
            type="password"
            placeholder={p('anthropic').configured ? '•••••••• (salva; digite pra trocar)' : 'chave da API (sk-ant-…)'}
            value={keys.anthropicKey}
            onChange={(e) => setKeys((v) => ({ ...v, anthropicKey: e.target.value }))}
          />
          <button className="btn small primary" disabled={!keys.anthropicKey.trim()} onClick={() => saveKey('anthropicKey')}>
            Salvar
          </button>
          {p('anthropic').configured && (
            <button className="btn small" onClick={() => set({ anthropicKey: '' })}>
              Remover
            </button>
          )}
        </div>
        <label className="ai-field">
          Modelo
          <input defaultValue={st.models.anthropicModel} onBlur={(e) => set({ anthropicModel: e.target.value })} />
        </label>
      </div>

      <div className="ai-card">
        <Head id="openai" />
        <p className="muted small">{p('openai').detail} · pago por uso em platform.openai.com (o plano do ChatGPT não inclui API)</p>
        <div className="key-row">
          <KeyRound size={14} />
          <input
            type="password"
            placeholder={p('openai').configured ? '•••••••• (salva; digite pra trocar)' : 'chave da API (sk-…)'}
            value={keys.openaiKey}
            onChange={(e) => setKeys((v) => ({ ...v, openaiKey: e.target.value }))}
          />
          <button className="btn small primary" disabled={!keys.openaiKey.trim()} onClick={() => saveKey('openaiKey')}>
            Salvar
          </button>
          {p('openai').configured && (
            <button className="btn small" onClick={() => set({ openaiKey: '' })}>
              Remover
            </button>
          )}
        </div>
        <div className="ai-row2">
          <label className="ai-field">
            Modelo de texto
            <input defaultValue={st.models.openaiTextModel} onBlur={(e) => set({ openaiTextModel: e.target.value })} />
          </label>
          <label className="ai-field">
            Modelo de imagem
            <input defaultValue={st.models.openaiImageModel} onBlur={(e) => set({ openaiImageModel: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="ai-routes">
        <b>Quem faz o quê</b>
        <label>
          Texto <span className="muted small">(revisar fala, títulos, ganchos…)</span>
          <select value={st.routes.text ?? ''} onChange={(e) => set({ routeText: e.target.value || null })}>
            <option value="">— escolha —</option>
            {routeOptions('text').map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
                {x.configured ? '' : ' (não configurado)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Imagens de referência <span className="muted small">(só quem gera imagem)</span>
          <select value={st.routes.image ?? ''} onChange={(e) => set({ routeImage: e.target.value || null })}>
            <option value="">— nenhuma —</option>
            {routeOptions('image').map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
                {x.configured ? '' : ' (não configurado)'}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  )
}
