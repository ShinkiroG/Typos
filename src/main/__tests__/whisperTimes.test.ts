import { describe, expect, it } from 'vitest'
import { whisperRuns, wordsFromWhisper } from '../whisperTimes'

const jsonl = (ws: [number, number, string][]) => ws.map(([s, e, text]) => JSON.stringify({ start: s * 1000, end: e * 1000, text })).join('\n')

describe('tempos das palavras do Whisper', () => {
  it('rodada do VAD: estica a fala do silêncio inicial até o fim que o VAD achou', () => {
    const log = whisperRuns()
    log.line('VAD detected 1 segments, start: 1000 ms, end: 4000 ms (buffer: 5000 ms)')
    log.line('run transcription at 0 ms, 64000/80000 samples (4.00 seconds)...')
    const w = wordsFromWhisper(jsonl([[0, 2, 'oi'], [2, 4, 'gente']]), log.runs)
    expect(w.map((x) => +x.s.toFixed(2))).toEqual([1, 2.5])
  })

  it('fala corrida (fila cheia, sem VAD): não reaproveita os limites da rodada anterior', () => {
    const log = whisperRuns()
    log.line('VAD detected 1 segments, start: 500 ms, end: 3000 ms (buffer: 3600 ms)')
    log.line('run transcription at 0 ms, 48000/57600 samples (3.00 seconds)...')
    // 20 s de narração rápida sem pausa: a fila enche e a rodada roda sem passar pelo VAD
    log.line('run transcription at 3000 ms, 320000/320000 samples (20.00 seconds)...')
    const fast: [number, number, string][] = Array.from({ length: 70 }, (_, i) => [3.2 + i * 0.28, 3.4 + i * 0.28, 'p' + i])
    const w = wordsFromWhisper(jsonl([[0, 1, 'oi'], ...fast]), log.runs)
    // cada palavra fica no tempo dela (antes, tudo depois de 6 s se amontoava no mesmo instante)
    fast.forEach(([s], i) => expect(w[i + 1].s).toBeCloseTo(s, 5))
    expect(new Set(w.map((x) => x.s.toFixed(2))).size).toBe(w.length)
  })

  it('a rodada do fim do arquivo também fica com os tempos do Whisper', () => {
    const log = whisperRuns()
    log.line('VAD detected 1 segments, start: 0 ms, end: 2000 ms (buffer: 2600 ms)')
    log.line('run transcription at 0 ms, 32000/41600 samples (2.00 seconds)...')
    log.line('run transcription at 2000 ms, 9600/9600 samples (0.60 seconds)...')
    const w = wordsFromWhisper(jsonl([[0.1, 0.5, 'a'], [2.1, 2.4, 'fim']]), log.runs, 10)
    expect(w[1].s).toBeCloseTo(2.1, 5)
  })
})
