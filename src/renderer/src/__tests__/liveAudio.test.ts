import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveAudio } from '../audio'

/** AudioContext de mentira: `frozen` = saída de som morta (relógio parado), `hang` = resume() nunca volta */
function fakeContexts(make: (i: number) => { frozen?: boolean; hang?: boolean; state?: AudioContextState }) {
  const made: { closed: boolean }[] = []
  class Fake extends EventTarget {
    state: AudioContextState
    private t0 = performance.now()
    private frozen: boolean
    private hang: boolean
    closed = false
    constructor() {
      super()
      const o = make(made.length)
      this.state = o.state ?? 'running'
      this.frozen = !!o.frozen
      this.hang = !!o.hang
      made.push(this)
    }
    get currentTime() {
      return this.frozen || this.state !== 'running' ? 0 : (performance.now() - this.t0) / 1000
    }
    resume() {
      if (this.hang) return new Promise<void>(() => null)
      this.state = 'running'
      return Promise.resolve()
    }
    close() {
      this.closed = true
      this.state = 'closed'
      return Promise.resolve()
    }
  }
  vi.stubGlobal('AudioContext', Fake)
  return made
}

afterEach(() => vi.unstubAllGlobals())

describe('LiveAudio', () => {
  it('usa o mesmo contexto enquanto o relógio anda', async () => {
    const made = fakeContexts(() => ({}))
    const a = new LiveAudio()
    const c1 = await a.ready()
    const c2 = await a.ready()
    expect(c1).toBe(c2)
    expect(made).toHaveLength(1)
  })

  it('troca o contexto quando o relógio parou (saída de som morreu)', async () => {
    const made = fakeContexts((i) => ({ frozen: i === 0 }))
    const setup = vi.fn()
    const a = new LiveAudio(setup)
    a.get()
    const ctx = await a.ready()
    expect(made).toHaveLength(2)
    expect(made[0].closed).toBe(true)
    expect(ctx).toBe(made[1])
    expect(setup).toHaveBeenCalledTimes(2)
  })

  it('não fica preso quando o resume() nunca volta', async () => {
    const made = fakeContexts((i) => (i === 0 ? { hang: true, state: 'suspended' } : {}))
    const a = new LiveAudio()
    const ctx = await a.ready()
    expect(ctx).toBe(made[1])
    expect(made[0].closed).toBe(true)
  })

  it('troca o contexto quando o Chromium avisa erro no dispositivo', async () => {
    const made = fakeContexts(() => ({}))
    const a = new LiveAudio()
    const first = a.get() as unknown as EventTarget
    first.dispatchEvent(new Event('error'))
    const ctx = await a.ready()
    expect(ctx).toBe(made[1])
  })
})
