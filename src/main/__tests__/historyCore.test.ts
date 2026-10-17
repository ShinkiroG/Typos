import { describe, expect, it } from 'vitest'
import { join, resolve } from 'path'
import { legacyTime, parseName, pickKeep, relocatePaths, repairDraftPaths, snapshotReason, versionName, type VersionInfo } from '../historyCore'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = new Date(2026, 9, 17, 12, 0, 0).getTime()

const v = (ago: number, reason: VersionInfo['reason'] = 'auto', words = 100): VersionInfo => {
  const at = NOW - ago
  return { name: versionName(at, reason, words, Math.round(ago / 1000) % 7 + 1), at, reason, words }
}

describe('nome das cópias', () => {
  it('ida e volta: hora, motivo e palavras', () => {
    const at = new Date(2026, 9, 17, 1, 53, 38).getTime()
    const name = versionName(at, 'corte', 1234)
    expect(name).toBe('20261017-015338_corte_1234w.json')
    expect(parseName(name)).toEqual({ name, at, reason: 'corte', words: 1234 })
    expect(parseName('20261017-015338-2_auto_5w.json')?.words).toBe(5)
  })

  it('recusa nome estranho e motivo desconhecido', () => {
    expect(parseName('../../x_auto_1w.json')).toBeNull()
    expect(parseName('20261017-015338_hack_1w.json')).toBeNull()
  })

  it('lê a hora das cópias antigas de .typos-versoes', () => {
    expect(legacyTime('20261016-231308.json')).toBe(new Date(2026, 9, 16, 23, 13, 8).getTime())
    expect(legacyTime('info.json')).toBeNull()
  })
})

describe('quais cópias ficam', () => {
  it('guarda tudo das últimas 2 h e as 20 mais novas', () => {
    const items = Array.from({ length: 50 }, (_, i) => v(i * 2 * MIN + 1000))
    const keep = pickKeep(items, NOW)
    for (const x of items) if (NOW - x.at < 2 * HOUR) expect(keep.has(x.name)).toBe(true)
  })

  it('até 7 dias: uma por hora; até 90 dias: uma por dia; depois some', () => {
    const recent = Array.from({ length: 20 }, (_, i) => v(i * MIN + 1000))
    const twoDaysAgo = [v(2 * DAY + 10 * MIN), v(2 * DAY + 20 * MIN), v(2 * DAY + 70 * MIN)]
    const monthAgo = [v(30 * DAY + HOUR), v(30 * DAY + 3 * HOUR), v(31 * DAY + HOUR)]
    const ancient = v(120 * DAY)
    const keep = pickKeep([...recent, ...twoDaysAgo, ...monthAgo, ancient], NOW)
    const kept = (xs: VersionInfo[]) => xs.filter((x) => keep.has(x.name)).length
    expect(kept(recent)).toBe(20)
    expect(kept(twoDaysAgo)).toBe(2)
    expect(kept(monthAgo)).toBe(2)
    expect(keep.has(ancient.name)).toBe(false)
  })

  it('"antes de apagar texto" fica 30 dias, mesmo com outras na mesma hora', () => {
    const recent = Array.from({ length: 20 }, (_, i) => v(i * MIN + 1000))
    const cut = v(5 * DAY + 30 * MIN, 'corte', 900)
    const same = v(5 * DAY + 10 * MIN)
    const keep = pickKeep([...recent, cut, same], NOW)
    expect(keep.has(cut.name)).toBe(true)
    expect(keep.has(same.name)).toBe(true)
  })
})

describe('quando fazer cópia', () => {
  const base = { firstSaveThisSession: false, latestWrittenAt: NOW - 30_000, diskWords: 1000, newWords: 1000, now: NOW }
  const latest = { name: 'x', at: NOW - 30_000, reason: 'auto' as const, words: 1000 }

  it('primeiro salvar depois de abrir guarda como estava', () => {
    expect(snapshotReason({ ...base, firstSaveThisSession: true, latest })).toBe('abertura')
  })

  it('a cada 2 min, não antes', () => {
    expect(snapshotReason({ ...base, latest })).toBeNull()
    expect(snapshotReason({ ...base, latest, latestWrittenAt: NOW - 2 * MIN })).toBe('auto')
  })

  it('apagou um capítulo inteiro: guarda na hora, sem esperar os 2 min', () => {
    expect(snapshotReason({ ...base, latest, diskWords: 1010, newWords: 600 })).toBe('corte')
  })

  it('apagando aos poucos: guarda quando já sumiram 60 palavras desde a última cópia', () => {
    expect(snapshotReason({ ...base, latest, diskWords: 945, newWords: 943 })).toBeNull()
    expect(snapshotReason({ ...base, latest, diskWords: 942, newWords: 940 })).toBe('corte')
  })
})

describe('caminhos de pasta que mudou', () => {
  const draft = resolve('/dados/Typos/autosaves/rascunho-20261014220220-38c5')
  const target = resolve('/videos/Steam')

  it('salvar como: mídia de dentro do rascunho passa pra pasta nova; a de fora fica', () => {
    const outside = resolve('/biblioteca/sfx.wav')
    const data = { montage: { media: [{ path: join(draft, 'assets', 'gravacoes', 'a.wav') }, { path: outside }] }, title: 'Steam' }
    const out = relocatePaths(data, draft, target)
    expect(out.montage.media[0].path).toBe(join(target, 'assets', 'gravacoes', 'a.wav'))
    expect(out.montage.media[1].path).toBe(outside)
    expect(out.title).toBe('Steam')
  })

  it('roteiro já salvo com a mídia no rascunho apagado: conserta se o arquivo está na pasta', () => {
    const lost = join(draft, 'assets', 'gravacoes', 'a.wav')
    const here = join(target, 'assets', 'gravacoes', 'a.wav')
    const gone = join(draft, 'assets', 'nao-copiado.wav')
    const r = repairDraftPaths({ media: [lost, gone] }, target, (p) => p === here)
    expect(r.changed).toBe(true)
    expect(r.data.media).toEqual([here, gone])
  })
})
