import { useEffect, useState } from 'react'
import { KEY_ACTIONS, comboOf, conflictOf, customKeys, keyOf, onKeysChange, setCustomKeys } from '../keys'

/** fixos: valem no app todo e não mudam */
const FIXED: [string, string, string][] = [
  ['Arquivo', 'Ctrl+N / Ctrl+O', 'novo roteiro / abrir pasta'],
  ['Arquivo', 'Ctrl+S / Ctrl+Shift+S', 'salvar / salvar como'],
  ['Arquivo', 'Ctrl+,', 'configurações'],
  ['Geral', 'Ctrl+Z / Ctrl+Shift+Z', 'desfazer / refazer (no roteiro e na Montagem)'],
  ['Geral', '?', 'esta tela (fora do texto)'],
  ['Montagem', 'Delete / Shift+Delete', 'apagar / apagar e juntar'],
  ['Montagem', '← → / Shift+← →', 'quadro a quadro / de corte em corte'],
  ['Montagem', 'Home', 'volta pro começo'],
  ['Roteiro', 'Botão direito', 'corretor, referência, IA, biblioteca, trocar tipo']
]

/** Tela de atalhos: clique na tecla de uma ação e aperte a nova. */
export function KeysEditor() {
  const [, redraw] = useState(0)
  const [wait, setWait] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => onKeysChange(() => redraw((n) => n + 1)), [])

  const save = (next: Record<string, string>) => {
    setCustomKeys(next)
    window.api.setSettings({ keys: next })
  }

  useEffect(() => {
    if (!wait) return
    const on = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') return setWait(null)
      const combo = comboOf(e)
      if (!combo) return // só apertou Ctrl/Shift: espera a tecla
      const a = KEY_ACTIONS.find((x) => x.id === wait)!
      if (a.group === 'Roteiro' && !/^(Ctrl|Alt)\+/.test(combo)) return setMsg('No roteiro o atalho precisa de Ctrl ou Alt (senão a tecla vira texto).')
      if (/^(Ctrl\+)?(Shift\+)?[ZYASNO,]$/.test(combo) && combo.startsWith('Ctrl+')) return setMsg(`${combo} já é do app (desfazer, salvar…). Escolha outra.`)
      const other = conflictOf(wait, combo)
      const next = { ...customKeys() }
      next[wait] = combo
      // a ação que tinha essa tecla fica sem atalho (o usuário vê e escolhe outra)
      if (other) next[other.id] = ''
      save(next)
      setMsg(other ? `${combo} era de "${other.label}", que ficou sem atalho.` : '')
      setWait(null)
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [wait])

  const groups = ['Roteiro', 'Montagem'] as const
  const changed = Object.keys(customKeys()).length > 0
  return (
    <>
      <p className="muted small">Clique na tecla de uma ação e aperte a nova (Esc cancela).</p>
      <div className="keys-grid keys-edit">
        {groups.map((g) => (
          <div key={g} style={{ display: 'contents' }}>
            <b>{g}</b>
            {KEY_ACTIONS.filter((a) => a.group === g).map((a) => {
              const k = keyOf(a.id)
              const custom = customKeys()[a.id] !== undefined
              return (
                <div key={a.id} style={{ display: 'contents' }}>
                  <button className={'key-cap' + (wait === a.id ? ' wait' : '') + (custom ? ' custom' : '')} onClick={() => (setMsg(''), setWait(a.id))}>
                    {wait === a.id ? 'aperte a tecla…' : k || '(nenhum)'}
                  </button>
                  <span className="key-label">
                    {a.label}
                    {custom && (
                      <button
                        className="link-btn"
                        title={`Voltar pro padrão (${a.def})`}
                        onClick={() => {
                          const next = { ...customKeys() }
                          delete next[a.id]
                          save(next)
                        }}
                      >
                        padrão
                      </button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        ))}
        <b>Fixos</b>
        {FIXED.map(([, k, what]) => (
          <div key={k} style={{ display: 'contents' }}>
            <span className="key-fixed">{k}</span>
            <span className="key-label">{what}</span>
          </div>
        ))}
      </div>
      {msg && <p className="warn small">{msg}</p>}
      {changed && (
        <button className="btn small" onClick={() => (save({}), setMsg(''))}>
          Voltar todos pro padrão
        </button>
      )}
    </>
  )
}
