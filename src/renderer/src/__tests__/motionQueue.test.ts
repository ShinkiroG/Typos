import { describe, expect, it } from 'vitest'
import { dequeue, enqueue, queuePos, takeFromQueue, withBusy, type BusyMap } from '../montage/busy'

const job = (id: string) => ({ id, label: 'Claude criando o motion…', pct: null })

describe('fila de motion', () => {
  it('entra na ordem, sem repetir e sem o que já está rodando', () => {
    const m: BusyMap = withBusy({}, 'a', job('a'))
    let q = enqueue([], ['b', 'c', 'a'], m)
    q = enqueue(q, ['b', 'd'], m)
    expect(q).toEqual(['b', 'c', 'd'])
    expect(queuePos(q, 'c')).toBe(2)
    expect(queuePos(q, 'a')).toBe(0)
    expect(dequeue(q, ['c'])).toEqual(['b', 'd'])
  })

  it('sai só o que cabe nas vagas livres e descarta blocos que sumiram', () => {
    const all = new Set(['b', 'c', 'd'])
    let m: BusyMap = withBusy({}, 'a', job('a'))
    let r = takeFromQueue(['x', 'b', 'c', 'd'], m, (id) => all.has(id))
    expect(r.start).toEqual(['b'])
    expect(r.rest).toEqual(['c', 'd'])
    m = withBusy(m, 'b', job('b'))
    expect(takeFromQueue(r.rest, m, (id) => all.has(id)).start).toEqual([])
    m = {}
    r = takeFromQueue(['c', 'd'], m, (id) => all.has(id))
    expect(r.start).toEqual(['c', 'd'])
    expect(r.rest).toEqual([])
  })
})
