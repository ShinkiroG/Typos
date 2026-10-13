import { useState } from 'react'
import { Scissors } from 'lucide-react'
import { SHORT_TARGET_DEFAULT, type ShortTarget } from '../lib'

const ASPECTS = [
  { id: '9:16', label: '9:16 · Reels, TikTok, Shorts' },
  { id: '1:1', label: '1:1 · quadrado' },
  { id: '4:5', label: '4:5 · feed do Instagram' },
  { id: '16:9', label: '16:9 · horizontal' }
]

/** Antes de abrir o Criar Clipes: tempo mínimo, ideal e máximo dos recortes e a proporção. */
export function ShortsSetup({
  target,
  aspect,
  first,
  onCancel,
  onOk
}: {
  target?: ShortTarget
  aspect?: string
  /** primeira vez (o Claude já sugere os recortes ao confirmar) */
  first: boolean
  onCancel: () => void
  onOk: (t: ShortTarget, aspect: string, suggest: boolean) => void
}) {
  const [t, setT] = useState<ShortTarget>(target ?? SHORT_TARGET_DEFAULT)
  const [ar, setAr] = useState(aspect ?? '9:16')
  const err = !(t.min > 0 && t.ideal >= t.min && t.max >= t.ideal) ? 'O tempo mínimo ≤ ideal ≤ máximo.' : t.max > 180 ? 'Até 180 s por recorte.' : ''
  const num = (k: keyof ShortTarget) => (
    <input type="number" min={5} max={180} step={1} value={t[k]} onChange={(e) => setT({ ...t, [k]: Math.round(Number(e.target.value) || 0) })} />
  )
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal shorts-setup" role="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          <Scissors size={16} /> Criar Clipes
        </h3>
        <p className="muted small">
          O Claude lê a transcrição do vídeo e sugere os melhores trechos pra recortes curtos. Ele sempre mira o tempo <b>ideal</b>; o <b>máximo</b> é a folga pra não cortar
          um assunto no meio (uma explicação sem a conclusão, um corte seco).
        </p>
        <div className="shorts-times">
          <label className="field">
            Mínimo (s){num('min')}
          </label>
          <label className="field">
            Ideal (s){num('ideal')}
          </label>
          <label className="field">
            Máximo (s){num('max')}
          </label>
        </div>
        <label className="field">
          Proporção
          <select value={ar} onChange={(e) => setAr(e.target.value)}>
            {ASPECTS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        {err && <p className="shorts-err">{err}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
          {!first && (
            <button className="btn" disabled={!!err} onClick={() => onOk(t, ar, false)} title="Só guarda os tempos (os recortes ficam como estão)">
              Salvar tempos
            </button>
          )}
          <button className="btn primary" disabled={!!err} onClick={() => onOk(t, ar, true)}>
            {first ? 'Ativar e sugerir recortes' : 'Sugerir recortes de novo'}
          </button>
        </div>
      </div>
    </div>
  )
}
