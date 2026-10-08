import { useEffect, useState } from 'react'
import { RefreshCw, Check, KeyRound } from 'lucide-react'
import { api } from '../lib'

type Info = Awaited<ReturnType<typeof api.getSettings>>

const MODE_LABEL = { installer: 'instalado', portable: 'versão .zip', dev: 'modo desenvolvimento' }

export function SettingsModal({ onClose }: { onClose: () => void }) {
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

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}
