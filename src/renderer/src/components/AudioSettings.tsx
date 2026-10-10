import { useEffect, useRef, useState } from 'react'
import { Mic, Volume2, X, Play, Square, Circle } from 'lucide-react'
import { audioPrefs, listDevices, micStream, peakDb, setAudioPrefs, encodeWav, type AudioPrefs } from '../audio'

/** Entrada (microfone), saída e níveis — pra deixar tudo certo antes de gravar a narração. */
export function AudioSettings({ onClose }: { onClose: () => void }) {
  const [prefs, setPrefs] = useState<AudioPrefs>(audioPrefs)
  const [devs, setDevs] = useState<{ inputs: { id: string; label: string }[]; outputs: { id: string; label: string }[] } | null>(null)
  const [err, setErr] = useState('')
  const [db, setDb] = useState(-120)
  const [peak, setPeak] = useState(-120)
  const [test, setTest] = useState<'idle' | 'rec' | 'play'>('idle')
  const testRef = useRef<{ chunks: Float32Array[]; rate: number } | null>(null)
  const rateRef = useRef(48000)

  const save = (p: Partial<AudioPrefs>) => setPrefs(setAudioPrefs(p))

  useEffect(() => {
    listDevices()
      .then(setDevs)
      .catch((e) => setErr(String(e)))
  }, [])

  // medidor ao vivo do microfone escolhido (e grava o teste de 5 s quando pedir)
  useEffect(() => {
    let alive = true
    let raf = 0
    let ctx: AudioContext | null = null
    let stream: MediaStream | null = null
    let hold = -120
    let holdAt = 0
    ;(async () => {
      try {
        stream = await micStream(prefs)
        if (!alive) return stream.getTracks().forEach((t) => t.stop())
        ctx = new AudioContext()
        const src = ctx.createMediaStreamSource(stream)
        const an = ctx.createAnalyser()
        an.fftSize = 2048
        src.connect(an)
        const proc = ctx.createScriptProcessor(4096, 1, 1)
        proc.onaudioprocess = (e) => testRef.current?.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
        src.connect(proc)
        proc.connect(ctx.destination)
        const rate = ctx.sampleRate
        rateRef.current = rate
        const buf = new Float32Array(2048)
        const tick = () => {
          const v = peakDb(an, buf)
          setDb(v)
          const now = performance.now()
          if (v > hold || now - holdAt > 1500) {
            hold = v
            holdAt = now
            setPeak(v)
          }
          raf = requestAnimationFrame(tick)
        }
        tick()
        setErr('')
      } catch (e) {
        setErr('Não deu pra abrir esse microfone: ' + (e as Error).message)
      }
    })()
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      ctx?.close().catch(() => null)
    }
  }, [prefs.input, prefs.processing])

  const recTest = () => {
    testRef.current = { chunks: [], rate: rateRef.current }
    setTest('rec')
    setTimeout(async () => {
      const t = testRef.current
      testRef.current = null
      if (!t) return
      setTest('play')
      const n = t.chunks.reduce((s, c) => s + c.length, 0)
      const pcm = new Float32Array(n)
      let o = 0
      for (const c of t.chunks) {
        pcm.set(c, o)
        o += c.length
      }
      const url = URL.createObjectURL(new Blob([encodeWav(pcm, t.rate)], { type: 'audio/wav' }))
      const a = new Audio(url) as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
      if (prefs.output) await a.setSinkId?.(prefs.output).catch(() => null)
      a.onended = () => {
        setTest('idle')
        URL.revokeObjectURL(url)
      }
      a.play().catch(() => setTest('idle'))
    }, 5000)
  }

  const beep = async () => {
    const ctx = new AudioContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    if (prefs.output) await ctx.setSinkId?.(prefs.output).catch(() => null)
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.value = 440
    g.gain.setValueAtTime(0, ctx.currentTime)
    g.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.02)
    g.gain.setValueAtTime(0.25, ctx.currentTime + 0.8)
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + 1)
    o.connect(g).connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 1.05)
    o.onended = () => ctx.close()
  }

  const pct = (v: number) => Math.max(0, Math.min(100, ((v + 60) / 60) * 100))
  const hint =
    peak < -50 ? 'sem sinal — fale perto do microfone' : peak > -2 ? 'estourando! baixe o ganho do microfone' : peak >= -8 ? 'ótimo pra voz' : peak > -16 ? 'um pouco baixo — dá pra subir o ganho' : 'baixo — chegue mais perto ou suba o ganho'

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal audio-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          <Mic size={16} /> Áudio
          <button className="icon-btn" onClick={onClose} title="Fechar">
            <X size={16} />
          </button>
        </h3>

        <section className="set-section">
          <h4>
            <Mic size={14} /> Entrada (gravação)
          </h4>
          <select value={prefs.input} onChange={(e) => save({ input: e.target.value })}>
            <option value="">Padrão do Windows</option>
            {devs?.inputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <div className="lvl" title={`${db.toFixed(1)} dBFS`}>
            <i className={peak > -3 ? 'red' : peak > -12 ? 'yellow' : 'green'} style={{ width: `${pct(db)}%` }} />
            <b style={{ left: `${pct(peak)}%` }} />
            {[-48, -24, -12, -6, 0].map((m) => (
              <span key={m} style={{ left: `${pct(m)}%` }}>
                {m}
              </span>
            ))}
          </div>
          <p className="muted small">
            Pico {peak <= -100 ? '—' : peak.toFixed(1) + ' dB'} · {hint}. O ideal pra voz é o pico ficar entre −8 e −4 dB.
          </p>
          <label className="toggle-row">
            <input type="checkbox" checked={prefs.processing} onChange={(e) => save({ processing: e.target.checked })} />
            Redução de ruído, eco e ganho automático (deixe desligado se o seu microfone/interface já trata o som)
          </label>
          <button className="btn small" disabled={test !== 'idle' || !!err} onClick={recTest}>
            {test === 'rec' ? <Square size={12} /> : test === 'play' ? <Play size={12} /> : <Circle size={12} />}
            {test === 'rec' ? ' Gravando 5 s…' : test === 'play' ? ' Ouvindo o teste…' : ' Testar: gravar 5 s e ouvir'}
          </button>
          {err && <p className="error small">{err}</p>}
        </section>

        <section className="set-section">
          <h4>
            <Volume2 size={14} /> Saída (o que o Typos toca)
          </h4>
          <select value={prefs.output} onChange={(e) => save({ output: e.target.value })}>
            <option value="">Padrão do Windows</option>
            {devs?.outputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="btn small" onClick={beep}>
            <Volume2 size={12} /> Tocar som de teste
          </button>
          <p className="muted small">Dica: grave com fone de ouvido, senão o microfone pega o som da timeline tocando junto.</p>
        </section>

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Pronto
          </button>
        </div>
      </div>
    </div>
  )
}
