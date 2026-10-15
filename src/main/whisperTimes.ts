/**
 * Tempos das palavras que o filtro whisper do ffmpeg devolve, acertados pelas rodadas de transcrição.
 *
 * O filtro transcreve o áudio em rodadas. Quase sempre a rodada vem do VAD ("VAD detected …, start, end"
 * logo antes de "run transcription at …"): aí o Whisper "estica" as primeiras palavras por cima do
 * silêncio do começo e os limites do VAD, que são exatos, servem pra remapear [0, fim] → [início da fala, fim].
 * Mas a rodada também roda sem VAD: quando a fila enche (fala corrida, sem pausa de meio segundo, por
 * mais que `queue` segundos) e no fim do arquivo. Essas não têm limites de VAD e ficam com os tempos do Whisper.
 */

export interface WhisperRun {
  /** onde a rodada começa no arquivo (s) */
  at: number
  /** quanto áudio a rodada tem (s) */
  dur: number
  /** fala dentro da rodada, pelo VAD (s, a partir do começo dela); só nas rodadas que o VAD disparou */
  vad?: { vs: number; ve: number }
}

/** lê o log do filtro linha a linha e junta as rodadas */
export function whisperRuns() {
  const runs: WhisperRun[] = []
  let seg: WhisperRun['vad'] | undefined
  return {
    runs,
    /** devolve o instante da rodada (s) quando a linha começa uma */
    line(l: string): number | null {
      const v = /VAD detected \d+ segments?, start: (\d+) ms, end: (\d+) ms/.exec(l)
      if (v) seg = { vs: Number(v[1]) / 1000, ve: Number(v[2]) / 1000 }
      const r = /run transcription at (\d+) ms(?:, \d+\/\d+ samples \(([\d.]+) seconds\))?/.exec(l)
      if (!r) return null
      // os limites do VAD valem só pra rodada que ele disparou: a próxima (fila cheia, fim do arquivo) não tem
      runs.push({ at: Number(r[1]) / 1000, dur: r[2] ? Number(r[2]) : Infinity, vad: seg })
      seg = undefined
      return Number(r[1]) / 1000
    }
  }
}

export interface TimedWord {
  s: number
  e: number
  w: string
}

/** as linhas JSON do filtro ({start, end, text} em ms) viram palavras com o tempo acertado pela rodada */
export function wordsFromWhisper(jsonl: string, runs: WhisperRun[], total = 0): TimedWord[] {
  const words: TimedWord[] = []
  let k = 0
  const fix = (t: number) => {
    const R = runs[k]
    if (!R) return t
    const rel = Math.min(Math.max(t - R.at, 0), R.dur)
    if (!R.vad || R.vad.ve <= 0) return R.at + rel
    const r = Math.min(rel, R.vad.ve)
    return R.at + R.vad.vs + (r * (R.vad.ve - R.vad.vs)) / R.vad.ve
  }
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      const w = String(j.text ?? '').trim()
      const s0 = j.start / 1000
      while (k + 1 < runs.length && s0 >= runs[k + 1].at - 0.001) k++
      const s = fix(s0)
      // texto inventado no silêncio do fim (o Whisper às vezes "legenda" o nada)
      if (total && s > total - 0.05) continue
      if (w) words.push({ s, e: Math.min(Math.max(s, fix(j.end / 1000)), total || Infinity), w })
    } catch {
      /* linha quebrada */
    }
  }
  return words
}
