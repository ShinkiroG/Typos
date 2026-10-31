import { describe, expect, it } from 'vitest'
import { MAX_PARALLEL, busyFor, canStart, withBusy, type BusyMap } from '../montage/busy'

const job = (id: string) => ({ id, label: 'Claude criando o motion…', pct: null })

describe('motion em paralelo', () => {
  it('deixa começar até o limite e não repete o mesmo bloco', () => {
    let m: BusyMap = {}
    expect(canStart(m, 'a')).toBe(true)
    m = withBusy(m, 'a', job('a'))
    expect(canStart(m, 'a')).toBe(false)
    expect(canStart(m, 'b')).toBe(true)
    m = withBusy(m, 'b', job('b'))
    expect(MAX_PARALLEL).toBe(2)
    expect(canStart(m, 'c')).toBe(false)
    m = withBusy(m, 'a', null)
    expect(canStart(m, 'c')).toBe(true)
  })

  it('cada bloco vê o próprio progresso; livre com vaga não vê nada; livre sem vaga vê outro', () => {
    let m: BusyMap = withBusy({}, 'a', job('a'))
    expect(busyFor(m, 'a')?.id).toBe('a')
    expect(busyFor(m, 'b')).toBeNull()
    m = withBusy(m, 'b', job('b'))
    expect(busyFor(m, 'b')?.id).toBe('b')
    const other = busyFor(m, 'c')
    expect(other && other.id !== 'c').toBe(true)
  })

  it('atualiza pelo atual e tirar um bloco livre não muda nada', () => {
    const m = withBusy({}, 'a', job('a'))
    const n = withBusy(m, 'a', (cur) => (cur ? { ...cur, pct: 0.5 } : null))
    expect(n.a.pct).toBe(0.5)
    expect(withBusy(n, 'z', null)).toBe(n)
    expect(withBusy(n, 'z', (cur) => (cur ? cur : null))).toBe(n)
  })
})
