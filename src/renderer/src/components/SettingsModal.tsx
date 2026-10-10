import { useEffect, useState } from 'react'
import { RefreshCw, Check, KeyRound, Trash2, HardDrive, ArrowDownToLine, ArrowUpFromLine, Package } from 'lucide-react'
import { api } from '../lib'
import { AiSection } from './AiSection'

type Info = Awaited<ReturnType<typeof api.getSettings>>

const MODE_LABEL = { installer: 'instalado', portable: 'versão .zip', dev: 'modo desenvolvimento' }

const fmtBytes = (b: number) =>
  b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(0)} KB` : b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`

type Storage = Awaited<ReturnType<typeof api.storageInfo>>

/** Limpar rascunhos, cache e a lista de recentes. O roteiro aberto nunca é apagado. */
function StorageSection({ currentDir, onCleanAssets }: { currentDir?: string; onCleanAssets?: () => Promise<string> }) {
  const [st, setSt] = useState<Storage | null>(null)
  const [msg, setMsg] = useState('')
  const [assets, setAssets] = useState<{ copies: number; unused: number; bytes: number } | null>(null)
  const refresh = () => {
    api.storageInfo(currentDir).then(setSt)
    if (currentDir) api.scanAssets(currentDir).then((r) => setAssets('error' in r ? null : r))
  }
  useEffect(() => {
    refresh()
  }, [])
  if (!st) return null

  const clear = async (what: 'drafts' | 'cache' | 'recent', label: string, ask?: string) => {
    if (ask && !confirm(ask)) return
    await api.clearStorage(what, currentDir)
    setMsg(label)
    refresh()
  }

  return (
    <section className="set-section">
      <h4>
        <HardDrive size={14} /> Armazenamento
      </h4>
      <div className="storage-row">
        <span>
          <b>Rascunhos não salvos</b>
          <span className="muted small">
            {st.drafts} {st.drafts === 1 ? 'rascunho' : 'rascunhos'} · {fmtBytes(st.draftBytes)}
            {currentDir ? ' (o que está aberto fica)' : ''}
          </span>
        </span>
        <button
          className="btn small danger-btn"
          disabled={!st.drafts}
          onClick={() => clear('drafts', 'Rascunhos apagados.', `Apagar ${st.drafts} rascunho(s) não salvo(s)? Não dá pra desfazer.`)}
        >
          <Trash2 size={13} /> Limpar
        </button>
      </div>
      <div className="storage-row">
        <span>
          <b>Cache</b>
          <span className="muted small">cache do app e sobras de atualização · {fmtBytes(st.cacheBytes)}</span>
        </span>
        <button className="btn small" onClick={() => clear('cache', 'Cache limpo.')}>
          <Trash2 size={13} /> Limpar
        </button>
      </div>
      {currentDir && assets && onCleanAssets && (
        <div className="storage-row">
          <span>
            <b>Arquivos deste roteiro</b>
            <span className="muted small">
              {assets.copies || assets.unused
                ? `${assets.copies} cópia(s) repetida(s) · ${assets.unused} sem uso · ${fmtBytes(assets.bytes)} (vão pra Lixeira)`
                : 'nada repetido nem sobrando'}
            </span>
          </span>
          <button
            className="btn small"
            disabled={!assets.copies && !assets.unused}
            onClick={async () => {
              if (!confirm('Juntar as cópias repetidas (o roteiro passa a usar uma só) e mandar as sobras pra Lixeira?')) return
              setMsg(await onCleanAssets())
              refresh()
            }}
          >
            <Trash2 size={13} /> Limpar
          </button>
        </div>
      )}
      <div className="storage-row">
        <span>
          <b>Lista de recentes</b>
          <span className="muted small">{st.recent} na lista (os arquivos não são apagados)</span>
        </span>
        <button className="btn small" disabled={!st.recent} onClick={() => clear('recent', 'Lista de recentes limpa.')}>
          <Trash2 size={13} /> Limpar
        </button>
      </div>
      {msg && (
        <p className="ok small">
          <Check size={12} /> {msg}
        </p>
      )}
    </section>
  )
}

export function SettingsModal({ onClose, currentDir, onCleanAssets }: { onClose: () => void; currentDir?: string; onCleanAssets?: () => Promise<string> }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState('')

  const refresh = () => api.getSettings().then(setInfo)
  useEffect(() => {
    refresh()
  }, [])

  if (!info) return null

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Configurações</h3>

        <section className="set-section">
          <h4>Atualizações</h4>
          <p className="muted small">
            Typos {info.version} · {MODE_LABEL[info.mode]}
          </p>
          <label className="toggle">
            <input
              type="checkbox"
              checked={info.autoUpdate}
              onChange={async (e) => {
                await api.setSettings({ autoUpdate: e.target.checked })
                refresh()
              }}
            />
            <span>
              <b>Atualizar automaticamente</b>
              <br />
              <span className="muted small">Ao abrir, baixa a versão nova em segundo plano e instala quando você fechar o app.</span>
            </span>
          </label>
          <button className="btn" onClick={() => api.checkUpdates()}>
            <RefreshCw size={14} /> Procurar atualizações
          </button>
        </section>

        <section className="set-section">
          <h4>ElevenLabs (efeitos sonoros)</h4>
          <p className="muted small">
            A chave fica salva só neste PC, fora da pasta do código. Pegue em elevenlabs.io → Profile → API Keys.
          </p>
          <div className="key-row">
            <KeyRound size={15} />
            <input
              type="password"
              placeholder={info.hasElevenLabsKey ? '•••••••• (chave salva, digite pra trocar)' : 'cole sua chave aqui'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button
              className="btn small primary"
              disabled={!key.trim()}
              onClick={async () => {
                await api.setSettings({ elevenLabsKey: key })
                setKey('')
                setSaved('Chave salva.')
                refresh()
              }}
            >
              Salvar
            </button>
            {info.hasElevenLabsKey && (
              <button
                className="btn small"
                onClick={async () => {
                  await api.setSettings({ elevenLabsKey: '' })
                  setSaved('Chave removida.')
                  refresh()
                }}
              >
                Remover
              </button>
            )}
          </div>
          {info.hasElevenLabsKey && (
            <p className="ok small">
              <Check size={12} /> chave configurada {saved && `· ${saved}`}
            </p>
          )}
          {!info.hasElevenLabsKey && saved && <p className="muted small">{saved}</p>}
        </section>

        <AiSection />

        <PrefsSection />

        <StorageSection currentDir={currentDir} onCleanAssets={onCleanAssets} />

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}

/** Leva ajustes, formatos, biblioteca, pastas e dicionário pra outra instalação. */
function PrefsSection() {
  const [withKeys, setWithKeys] = useState(false)
  const [msg, setMsg] = useState('')
  return (
    <section className="set-section">
      <h4>
        <Package size={14} /> Preferências
      </h4>
      <p className="muted small">
        Um arquivo só com ajustes, formatos (com as referências), biblioteca, pastas e dicionário pessoal. Serve pra reinstalar o Typos ou levar pra
        outro PC. Os roteiros não vão junto (eles já ficam nas pastas deles).
      </p>
      <label className="toggle-row">
        <input type="checkbox" checked={withKeys} onChange={(e) => setWithKeys(e.target.checked)} />
        Incluir chaves de API (guarde o arquivo em lugar seguro)
      </label>
      <div className="set-row">
        <button
          className="btn small"
          onClick={async () => {
            const r = await api.exportPrefs(withKeys)
            if (r) setMsg('error' in r ? r.error : `Exportado (${r.files} itens): ${r.path}`)
          }}
        >
          <ArrowUpFromLine size={13} /> Exportar…
        </button>
        <button
          className="btn small"
          onClick={async () => {
            if (!confirm('Importar substitui os formatos, a biblioteca, as pastas e os ajustes atuais pelos do arquivo. Continuar?')) return
            const r = await api.importPrefs()
            if (r) setMsg('error' in r ? r.error : `Importado (${r.files} itens). Recarregando…`)
          }}
        >
          <ArrowDownToLine size={13} /> Importar…
        </button>
      </div>
      {msg && <p className="muted small">{msg}</p>}
    </section>
  )
}
