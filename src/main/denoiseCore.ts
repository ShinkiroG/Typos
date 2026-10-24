/**
 * Limpeza de ruído (sem Electron aqui, pra testar com o ffmpeg puro): a cadeia de filtros de cada
 * intensidade, o chão de ruído medido nas partes mais quietas e o atraso que os filtros põem no som.
 */

/** 1 = leve, 2 = médio, 3 = forte */
export type DenoiseLevel = 1 | 2 | 3

export const DENOISE_LEVELS: { id: DenoiseLevel; label: string; hint: string }[] = [
  { id: 1, label: 'Leve', hint: 'tira chiado e zumbido de leve, sem mexer na voz' },
  { id: 2, label: 'Médio', hint: 'IA de voz (RNNoise): tira ventilador, ar-condicionado, rua e chiado' },
  { id: 3, label: 'Forte', hint: 'IA de voz + redução extra: pra gravação bem ruidosa (a voz pode ficar mais "seca")' }
]

/** versão da receita: mudar a cadeia gera os arquivos limpos de novo */
export const DENOISE_V = 1

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/**
 * Chão de ruído (dBFS): o volume das partes mais quietas da gravação (percentil 10 das janelas de 50 ms),
 * ignorando o silêncio digital (som cortado/zerado). null se não deu pra medir.
 */
export function noiseFloorDb(pcm: Int16Array, rate: number): number | null {
  const win = Math.max(1, Math.round(rate * 0.05))
  const levels: number[] = []
  for (let i = 0; i + win <= pcm.length; i += win) {
    let s = 0
    for (let j = i; j < i + win; j++) s += pcm[j] * pcm[j]
    const rms = Math.sqrt(s / win) / 32768
    if (rms > 3e-5) levels.push(20 * Math.log10(rms))
  }
  if (levels.length < 4) return null
  levels.sort((a, b) => a - b)
  return levels[Math.floor(levels.length * 0.1)]
}

/** começo (s) do trecho de `len` segundos com mais energia (é onde a fala está, pra medir o atraso) */
export function loudestStart(pcm: Int16Array, rate: number, len: number): number {
  const win = Math.max(1, Math.round(rate * 0.05))
  const e: number[] = []
  for (let i = 0; i + win <= pcm.length; i += win) {
    let s = 0
    for (let j = i; j < i + win; j++) s += pcm[j] * pcm[j]
    e.push(s)
  }
  const n = Math.max(1, Math.round(len / 0.05))
  if (e.length <= n) return 0
  let cur = e.slice(0, n).reduce((a, b) => a + b, 0)
  let best = cur
  let at = 0
  for (let i = n; i < e.length; i++) {
    cur += e[i] - e[i - n]
    if (cur > best) {
      best = cur
      at = i - n + 1
    }
  }
  return at * 0.05
}

/**
 * Quantas amostras `out` está atrasado em relação a `ref` (0..maxLag), pela correlação.
 * null se os dois não se parecem (aí não dá pra confiar no número).
 */
export function bestLag(ref: Int16Array, out: Int16Array, maxLag: number): number | null {
  const n = Math.min(ref.length, out.length - maxLag)
  if (n < 1000) return null
  let best = -Infinity
  let lag = 0
  for (let l = 0; l <= maxLag; l++) {
    let c = 0
    for (let i = 0; i < n; i++) c += ref[i] * out[i + l]
    if (c > best) {
      best = c
      lag = l
    }
  }
  let ee = 0
  let oo = 0
  for (let i = 0; i < n; i++) {
    ee += ref[i] * ref[i]
    oo += out[i + lag] * out[i + lag]
  }
  return ee && oo && best / Math.sqrt(ee * oo) > 0.3 ? lag : null
}

/** atraso típico (s) quando não deu pra medir: afftdn ~25 ms, arnndn ~10 ms */
export function typicalLag(level: DenoiseLevel, model: boolean) {
  return level === 1 || !model ? 0.025 : level === 2 ? 0.01 : 0.035
}

/**
 * Cadeia de filtros. `model` é o arquivo .rnnn como o ffmpeg deve ler (relativo à pasta onde ele roda),
 * ou null se o ffmpeg não tem o arnndn (aí só o afftdn, mais forte).
 * O nf do afftdn (chão de ruído) sai do ruído medido: um nf baixo demais não limpa nada.
 */
export function denoiseFilter(level: DenoiseLevel, noiseDb: number | null, model: string | null) {
  const nf = Math.round(clamp((noiseDb ?? -60) + 20, -80, -20))
  if (level === 1) return `highpass=f=70,afftdn=nr=12:nf=${nf}`
  if (!model) return level === 2 ? `highpass=f=80,afftdn=nr=20:nf=${nf}` : `highpass=f=80,afftdn=nr=32:nf=${Math.min(-20, nf + 4)}`
  const rnn = `highpass=f=80,arnndn=m=${model}`
  return level === 2 ? rnn : `${rnn},afftdn=nr=20:nf=${nf}`
}

/**
 * Argumentos do ffmpeg da limpeza: a cadeia, menos o atraso dela no começo (e o mesmo tanto de
 * silêncio no fim), pra o arquivo limpo ficar exatamente no tempo do original. WAV 24 bits.
 */
export function denoiseArgs(input: string, out: string, filter: string, lagSec: number, rate = 48000): string[] {
  const lag = Math.max(0, Math.round(lagSec * rate))
  const af = `${filter},aresample=${rate}` + (lag ? `,atrim=start_sample=${lag},asetpts=PTS-STARTPTS,apad=pad_len=${lag}` : '')
  return ['-hide_banner', '-nostdin', '-y', '-i', input, '-vn', '-af', af, '-ar', String(rate), '-c:a', 'pcm_s24le', out]
}
