/**
 * Equalizador do som do vídeo (o mix inteiro, depois de juntar as faixas). Os mesmos filtros
 * (biquads do "Audio EQ Cookbook") tocam na prévia da Montagem (Web Audio) e entram no render
 * (ffmpeg), então o que você ouve ajustando é o que sai no vídeo.
 *
 * Sem DOM e sem Node: o renderer e o main usam este arquivo.
 */

/** centro de cada faixa (Hz): 10 faixas de oitava, do subgrave ao brilho */
export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const
/** largura das faixas (Q de uma oitava) */
export const EQ_Q = 1.41
/** ganho máximo de cada faixa (dB, pra cima ou pra baixo) */
export const EQ_MAX = 12
/** cortes de grave (passa-alta) que dá pra escolher; 0 = desligado */
export const EQ_HIGHPASS = [0, 25, 30, 40, 50, 60, 80, 100, 120] as const

export interface MontageEq {
  /** desligado = passa reto (guarda os ajustes) */
  on: boolean
  /** corte de grave: tira tudo abaixo disso (Hz, 24 dB/oitava); 0 = sem corte */
  highpass: number
  /** ganho de cada faixa de EQ_BANDS (dB) */
  gains: number[]
}

export const flatEq = (): MontageEq => ({ on: true, highpass: 0, gains: EQ_BANDS.map(() => 0) })

/** prontos: o que mais se usa pra corrigir o som de um vídeo */
export const EQ_PRESETS: { id: string; label: string; hint: string; eq: MontageEq }[] = [
  { id: 'flat', label: 'Plano (sem EQ)', hint: 'Nada muda.', eq: flatEq() },
  {
    id: 'sub-leve',
    label: 'Menos subgrave (leve)',
    hint: 'Corta o que fica abaixo de 30 Hz (só subwoofer sente) e baixa um pouco os 64 Hz.',
    eq: { on: true, highpass: 30, gains: [-3, -2, 0, 0, 0, 0, 0, 0, 0, 0] }
  },
  {
    id: 'sub-forte',
    label: 'Menos subgrave (forte)',
    hint: 'Pra quando reclamam que o subwoofer treme: corta abaixo de 40 Hz e segura os graves até 125 Hz.',
    eq: { on: true, highpass: 40, gains: [-6, -4, -1.5, 0, 0, 0, 0, 0, 0, 0] }
  },
  {
    id: 'voz',
    label: 'Voz mais clara',
    hint: 'Corta o grave que embola a voz (abaixo de 80 Hz) e realça a presença (2–4 kHz).',
    eq: { on: true, highpass: 80, gains: [0, -2, -1, -1, 0, 0, 1.5, 2, 1, 0] }
  }
]

const clampGain = (g: unknown) => (typeof g === 'number' && isFinite(g) ? Math.max(-EQ_MAX, Math.min(EQ_MAX, Math.round(g * 10) / 10)) : 0)

/** lê o que veio do projeto (pode ser antigo ou estar faltando pedaço) */
export function normEq(eq?: Partial<MontageEq> | null): MontageEq {
  const hp = typeof eq?.highpass === 'number' && isFinite(eq.highpass) ? Math.max(0, Math.min(300, Math.round(eq.highpass))) : 0
  return { on: eq?.on !== false, highpass: hp, gains: EQ_BANDS.map((_, i) => clampGain(eq?.gains?.[i])) }
}

/** o EQ muda alguma coisa? */
export function eqActive(eq?: Partial<MontageEq> | null) {
  if (!eq) return false
  const e = normEq(eq)
  return e.on && (e.highpass > 0 || e.gains.some((g) => g !== 0))
}

/**
 * Cadeia de filtros do ffmpeg (pra `-af`). Passa-alta = dois de 2ª ordem (Butterworth, 24 dB/oitava);
 * cada faixa = equalizer de pico com Q de uma oitava. Vazio quando o EQ não muda nada.
 */
export function eqFfmpeg(eq?: Partial<MontageEq> | null): string[] {
  if (!eqActive(eq)) return []
  const e = normEq(eq)
  const out: string[] = []
  if (e.highpass > 0) out.push(`highpass=f=${e.highpass}:p=2:t=q:w=0.7071`, `highpass=f=${e.highpass}:p=2:t=q:w=0.7071`)
  e.gains.forEach((g, i) => {
    if (g !== 0) out.push(`equalizer=f=${EQ_BANDS[i]}:t=q:w=${EQ_Q}:g=${g}`)
  })
  return out
}

/** assinatura (pra saber se o render precisa refazer o final) */
export const eqKey = (eq?: Partial<MontageEq> | null) => eqFfmpeg(eq).join(',')

type Coefs = [number, number, number, number, number, number]

function peaking(f0: number, g: number, q: number, fs: number): Coefs {
  const A = Math.pow(10, g / 40)
  const w0 = (2 * Math.PI * f0) / fs
  const al = Math.sin(w0) / (2 * q)
  const c = Math.cos(w0)
  return [1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A]
}

function highpass(f0: number, fs: number): Coefs {
  const w0 = (2 * Math.PI * f0) / fs
  const al = Math.sin(w0) / (2 * Math.SQRT1_2)
  const c = Math.cos(w0)
  return [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al]
}

/** |H| de um biquad na frequência f (dB) */
function magDb([b0, b1, b2, a0, a1, a2]: Coefs, f: number, fs: number) {
  const w = (2 * Math.PI * f) / fs
  const c1 = Math.cos(w)
  const s1 = Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = Math.sin(2 * w)
  const nr = b0 + b1 * c1 + b2 * c2
  const ni = -(b1 * s1 + b2 * s2)
  const dr = a0 + a1 * c1 + a2 * c2
  const di = -(a1 * s1 + a2 * s2)
  return 10 * Math.log10(Math.max(1e-12, (nr * nr + ni * ni) / (dr * dr + di * di)))
}

/** quanto o EQ sobe/desce cada frequência (dB): a curva que aparece no gráfico */
export function eqResponseDb(eq: Partial<MontageEq> | null | undefined, freqs: number[], fs = 48000): number[] {
  if (!eqActive(eq)) return freqs.map(() => 0)
  const e = normEq(eq)
  const filters: Coefs[] = []
  if (e.highpass > 0) filters.push(highpass(e.highpass, fs), highpass(e.highpass, fs))
  e.gains.forEach((g, i) => g !== 0 && filters.push(peaking(EQ_BANDS[i], g, EQ_Q, fs)))
  return freqs.map((f) => filters.reduce((a, c) => a + magDb(c, f, fs), 0))
}

/** "1k", "16k", "64" */
export const hzLabel = (f: number) => (f >= 1000 ? `${Number((f / 1000).toFixed(1))}k` : String(Math.round(f)))
