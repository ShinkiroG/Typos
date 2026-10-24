/**
 * Controle dos picos da voz (sem Electron aqui, pra testar com o ffmpeg puro): o volume típico da fala
 * e a cadeia de cada intensidade. De-esser (só no médio/forte) pro "s" e "ch" chiados, compressor pros
 * trechos fortes e limitador pra pôr um teto que nenhum pico passa.
 */

/** 1 = leve, 2 = médio, 3 = forte */
export type PeaksLevel = 1 | 2 | 3

/** versão da receita: mudar a cadeia gera os arquivos tratados de novo */
export const PEAKS_V = 1

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/**
 * Volume típico da fala (dBFS): a mediana das janelas de 50 ms que estão bem acima do ruído
 * (o que sobra é a voz). null se não deu pra medir.
 */
export function speechLevelDb(pcm: Int16Array, rate: number): number | null {
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
  const floor = levels[Math.floor(levels.length * 0.1)]
  const loud = levels.filter((l) => l > floor + 15)
  // quase tudo no mesmo volume (só fala, sem pausas): a mediana geral já é a fala
  const use = loud.length >= 4 ? loud : levels
  return use[Math.floor(use.length / 2)]
}

/**
 * Cadeia de filtros. O compressor começa a agir um pouco acima do volume típico da fala (então a fala
 * normal fica como está e só os picos descem) e o limitador põe o teto acima disso.
 * Sem ganho automático: o volume geral quem acerta é o Normalizar.
 */
export function peaksFilter(level: PeaksLevel, speechDb: number | null) {
  const sp = clamp(speechDb ?? -24, -45, -8)
  const { over, ratio, ceil, deess } = [
    { over: 6, ratio: 3, ceil: 15, deess: 0 },
    { over: 4, ratio: 4, ceil: 12, deess: 0.3 },
    { over: 2, ratio: 6, ceil: 9, deess: 0.5 }
  ][level - 1]
  const thr = Math.pow(10, clamp(sp + over, -40, -3) / 20)
  const lim = clamp(Math.pow(10, Math.min(-1, sp + ceil) / 20), 0.0625, 1)
  return [
    deess ? `deesser=i=${deess}:m=0.5:f=0.5` : '',
    `acompressor=threshold=${thr.toFixed(4)}:ratio=${ratio}:attack=5:release=120:knee=4`,
    `alimiter=limit=${lim.toFixed(4)}:attack=5:release=80:level=0`
  ]
    .filter(Boolean)
    .join(',')
}

/** atraso típico (s) quando não deu pra medir: o limitador olha 5 ms à frente */
export const PEAKS_LAG = 0.005
