import { useEffect, useState } from 'react'
import { RefreshCw, Check, KeyRound, Trash2, HardDrive } from 'lucide-react'
import { api } from '../lib'

type Info = Awaited<ReturnType<typeof api.getSettings>>

const MODE_LABEL = { installer: 'instalado', portable: 'versão .zip', dev: 'modo desenvolvimento' }

const fmtBytes = (b: number) =>
  b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(0)} KB` : b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`

type Storage = Awaited<ReturnType<typeof api.storageInfo>>

/** Limpar rascunhos, cache e a lista de recentes. O roteiro aberto nunca é apagado. */
function StorageSection({ currentDir }: { currentDir?: string }) {
  const [st, setSt] = useState<Storage | null>(null)
  const [msg, setMsg] = useState('')
  const refresh = () => api.storageInfo(currentDir).then(setSt)
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

export function SettingsModal({ onClose, currentDir }: { onClose: () => void; currentDir?: string }) {
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

        <StorageSection currentDir={currentDir} />

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}
