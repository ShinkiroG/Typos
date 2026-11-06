import { useEffect, useRef, useState } from 'react'
import { Power, RotateCcw, X } from 'lucide-react'
import { EQ_BANDS, EQ_HIGHPASS, EQ_MAX, EQ_PRESETS, eqActive, eqResponseDb, flatEq, hzLabel, normEq, type MontageEq } from '../../../shared/eq'

/**
 * Equalizador do vídeo, com o analisador de frequências: mostra em Hz o que está tocando na
 * Montagem (depois do EQ, que é o que sai no render) e a curva do EQ por cima.
 */

const F_MIN = 20
const F_MAX = 20000
const DB_MIN = -100
const DB_MAX = -10
/** escala da curva do EQ (dB pra cima e pra baixo do meio) */
const CURVE_DB = 15
const W = 560
const H = 210

const xOf = (f: number) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * W
const fOf = (x: number) => F_MIN * Math.pow(F_MAX / F_MIN, x / W)
const yOf = (db: number) => H - ((Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * H
const curveY = (db: number) => H / 2 - (Math.max(-CURVE_DB, Math.min(CURVE_DB, db)) / CURVE_DB) * (H / 2 - 8)

/** regiões do espectro (o que cada uma é no som) */
const ZONES: { from: number; to: number; label: string; tint: string }[] = [
  { from: 20, to: 60, label: 'Subgrave', tint: 'rgba(255, 92, 92, 0.10)' },
  { from: 60, to: 250, label: 'Grave', tint: 'rgba(255, 170, 70, 0.07)' },
  { from: 250, to: 2000, label: 'Médio', tint: 'rgba(120, 200, 120, 0.05)' },
  { from: 2000, to: 6000, label: 'Presença', tint: 'rgba(90, 170, 255, 0.06)' },
  { from: 6000, to: 20000, label: 'Brilho', tint: 'rgba(170, 120, 255, 0.06)' }
]
const GRID = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]

interface Props {
  eq?: MontageEq
  onChange: (eq: MontageEq, gesture?: string) => void
  analyser: () => AnalyserNode | null
  playing: boolean
  onClose: () => void
}

export function EqPanel({ eq: raw, onChange, analyser, playing, onClose }: Props) {
  const eq = normEq(raw ?? flatEq())
  const canvas = useRef<HTMLCanvasElement>(null)
  const eqRef = useRef(eq)
  eqRef.current = eq
  const [hover, setHover] = useState<{ x: number; f: number; db: number | null } | null>(null)
  const hoverRef = useRef(hover)
  hoverRef.current = hover
  /** média lenta do espectro (alguns segundos): mostra o "peso" de cada região, não só o instante */
  const avg = useRef<Float32Array | null>(null)
  const cols = useRef<Float32Array>(new Float32Array(W))
  const [hasSignal, setHasSignal] = useState(false)

  const set = (p: Partial<MontageEq>, gesture?: string) => onChange({ ...eq, ...p }, gesture)
  const setGain = (i: number, g: number) => set({ gains: eq.gains.map((x, j) => (j === i ? Math.max(-EQ_MAX, Math.min(EQ_MAX, g)) : x)) }, 'eq-band-' + i)
  const preset = EQ_PRESETS.find((p) => JSON.stringify(normEq(p.eq)) === JSON.stringify({ ...eq, on: true }))

  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    cv.width = W * dpr
    cv.height = H * dpr
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    let raf = 0
    let buf: Float32Array<ArrayBuffer> | null = null
    let signal = false
    const curveFreqs = Array.from({ length: W / 2 + 1 }, (_, i) => fOf(i * 2))

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const an = analyser()
      g.clearRect(0, 0, W, H)
      // fundo: regiões e grade
      for (const z of ZONES) {
        g.fillStyle = z.tint
        g.fillRect(xOf(z.from), 0, xOf(z.to) - xOf(z.from), H)
        g.fillStyle = 'rgba(255,255,255,0.35)'
        g.font = '10px system-ui, sans-serif'
        g.fillText(z.label, xOf(z.from) + 4, 12)
      }
      g.strokeStyle = 'rgba(255,255,255,0.07)'
      g.lineWidth = 1
      for (const f of GRID) {
        const x = Math.round(xOf(f)) + 0.5
        g.beginPath()
        g.moveTo(x, 16)
        g.lineTo(x, H)
        g.stroke()
      }
      g.beginPath()
      g.moveTo(0, Math.round(H / 2) + 0.5)
      g.lineTo(W, Math.round(H / 2) + 0.5)
      g.stroke()

      // espectro
      let live = false
      if (an) {
        if (!buf || buf.length !== an.frequencyBinCount) buf = new Float32Array(an.frequencyBinCount)
        an.getFloatFrequencyData(buf)
        const binHz = an.context.sampleRate / an.fftSize
        const c = cols.current
        for (let x = 0; x < W; x++) {
          const lo = Math.max(1, Math.floor(fOf(x) / binHz))
          const hi = Math.max(lo, Math.floor(fOf(x + 1) / binHz))
          let m = -Infinity
          for (let b = lo; b <= hi && b < buf.length; b++) if (buf[b] > m) m = buf[b]
          c[x] = isFinite(m) ? m : DB_MIN
          if (c[x] > DB_MIN + 10) live = true
        }
        if (live) {
          if (!avg.current) avg.current = Float32Array.from(c)
          const a = avg.current
          for (let x = 0; x < W; x++) a[x] += (c[x] - a[x]) * 0.02
          const grad = g.createLinearGradient(0, 0, 0, H)
          grad.addColorStop(0, 'rgba(124, 140, 255, 0.55)')
          grad.addColorStop(1, 'rgba(124, 140, 255, 0.05)')
          g.fillStyle = grad
          g.beginPath()
          g.moveTo(0, H)
          for (let x = 0; x < W; x++) g.lineTo(x, yOf(c[x]))
          g.lineTo(W, H)
          g.closePath()
          g.fill()
        }
      }
      if (avg.current) {
        g.strokeStyle = 'rgba(255, 214, 102, 0.85)'
        g.lineWidth = 1.5
        g.beginPath()
        avg.current.forEach((v, x) => (x ? g.lineTo(x, yOf(v)) : g.moveTo(x, yOf(v))))
        g.stroke()
      }
      if (live !== signal) {
        signal = live
        setHasSignal(live)
      }

      // curva do EQ (escala própria: ±15 dB em volta do meio)
      const e = eqRef.current
      if (eqActive(e)) {
        const resp = eqResponseDb(e, curveFreqs, an?.context.sampleRate ?? 48000)
        g.strokeStyle = '#4ade80'
        g.lineWidth = 2
        g.beginPath()
        resp.forEach((db, i) => (i ? g.lineTo(i * 2, curveY(db)) : g.moveTo(0, curveY(db))))
        g.stroke()
      }

      const hv = hoverRef.current
      if (hv) {
        g.strokeStyle = 'rgba(255,255,255,0.4)'
        g.beginPath()
        g.moveTo(hv.x + 0.5, 0)
        g.lineTo(hv.x + 0.5, H)
        g.stroke()
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [analyser])

  const onMove = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = Math.max(0, Math.min(W - 1, ((e.clientX - r.left) / r.width) * W))
    const db = avg.current ? avg.current[Math.floor(x)] : null
    setHover({ x, f: fOf(x), db })
  }

  return (
    <div className="mt-eq" onMouseDown={(e) => e.stopPropagation()}>
      <div className="mt-eq-head">
        <b>Frequências e equalizador</b>
        <span className="mt-grow" />
        <button className={'btn small' + (eq.on ? ' on' : '')} title={eq.on ? 'Desligar o EQ (compara com o som original; os ajustes ficam guardados)' : 'Ligar o EQ'} onClick={() => set({ on: !eq.on }, 'eq-on')}>
          <Power size={12} /> {eq.on ? 'Ligado' : 'Desligado'}
        </button>
        <button className="icon-btn" title="Zerar o EQ" onClick={() => onChange(flatEq(), 'eq-reset')}>
          <RotateCcw size={14} />
        </button>
        <button className="icon-btn" title="Fechar" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      <div className="mt-eq-graph" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <canvas ref={canvas} style={{ width: W, height: H }} />
        <div className="mt-eq-axis">
          {GRID.map((f) => (
            <span key={f} style={{ left: `${(xOf(f) / W) * 100}%` }}>
              {hzLabel(f)}
            </span>
          ))}
        </div>
        {hover && (
          <div className="mt-eq-hover" style={{ left: Math.min(W - 120, hover.x + 8) }}>
            {Math.round(hover.f)} Hz{hover.db != null && ` · ${Math.round(hover.db)} dB`}
          </div>
        )}
        {!hasSignal && <div className="mt-eq-idle">{playing ? 'Silêncio neste trecho…' : 'Dê play na Montagem pra ver as frequências do som.'}</div>}
      </div>
      <div className="mt-eq-legend">
        <span>
          <i className="sw live" /> agora
        </span>
        <span>
          <i className="sw avg" /> média dos últimos segundos
        </span>
        <span>
          <i className="sw curve" /> curva do EQ (±{CURVE_DB} dB)
        </span>
      </div>

      <div className="mt-eq-row">
        <label>
          Pronto
          <select
            className="mt-loud"
            value={preset?.id ?? ''}
            onChange={(e) => {
              const p = EQ_PRESETS.find((x) => x.id === e.target.value)
              if (p) onChange(normEq(p.eq), 'eq-preset')
            }}
          >
            {!preset && <option value="">Personalizado</option>}
            {EQ_PRESETS.map((p) => (
              <option key={p.id} value={p.id} title={p.hint}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label title="Passa-alta: tira tudo abaixo dessa frequência (24 dB por oitava). Abaixo de 30–40 Hz quase nenhuma caixa toca: só o subwoofer, e é isso que incomoda.">
          Cortar abaixo de
          <select className="mt-loud" value={eq.highpass} onChange={(e) => set({ highpass: Number(e.target.value) }, 'eq-hp')}>
            {[...new Set([...EQ_HIGHPASS, eq.highpass])]
              .sort((a, b) => a - b)
              .map((f) => (
                <option key={f} value={f}>
                  {f ? `${f} Hz` : 'sem corte'}
                </option>
              ))}
          </select>
        </label>
        {preset && <span className="mt-eq-hint">{preset.hint}</span>}
      </div>

      <div className={'mt-eq-bands' + (eq.on ? '' : ' off')}>
        {EQ_BANDS.map((f, i) => (
          <div key={f} className={'mt-eq-band' + (f < 60 ? ' sub' : '')} title={`${hzLabel(f)} Hz: duplo clique zera`}>
            <span className="v">{eq.gains[i] > 0 ? '+' : ''}{eq.gains[i]}</span>
            <input type="range" min={-EQ_MAX} max={EQ_MAX} step={0.5} value={eq.gains[i]} onChange={(e) => setGain(i, Number(e.target.value))} onDoubleClick={() => setGain(i, 0)} />
            <span className="f">{hzLabel(f)}</span>
          </div>
        ))}
      </div>
      <div className="mt-eq-foot">O EQ vale pro vídeo inteiro: você ouve aqui na prévia e ele sai igual no Workspace Render (mudar só o EQ não recompila as partes, só o passo final).</div>
    </div>
  )
}
