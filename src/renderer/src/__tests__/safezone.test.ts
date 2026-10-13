import { describe, expect, it } from 'vitest'
import { issuesTweak, safeZones } from '../montage/safezone'

const inside = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h

describe('safe zone', () => {
  it('vertical reserva mais embaixo e à direita (interface do Shorts/Reels)', () => {
    const z = safeZones('9:16', 270, 480)
    expect(z.safe.y).toBeGreaterThan(0)
    expect(480 - (z.safe.y + z.safe.h)).toBeGreaterThan(z.safe.y)
    expect(270 - (z.safe.x + z.safe.w)).toBeGreaterThan(z.safe.x)
  })
  it('a faixa persistente fica no topo da safe zone e o palco embaixo dela, sem encostar', () => {
    for (const a of ['16:9', '9:16', '1:1', '4:5', 'outro']) {
      const z = safeZones(a, 480, 270)
      expect(inside(z.band, z.safe)).toBe(true)
      expect(inside(z.stage, z.safe)).toBe(true)
      expect(z.band.y).toBe(z.safe.y)
      expect(z.stage.y).toBeGreaterThan(z.band.y + z.band.h)
    }
  })
  it('o pedido de correção lista o que ficou fora', () => {
    const z = safeZones('9:16', 270, 480)
    const t = issuesTweak([{ kind: 'faixa', what: 'POUCOS', t: 1.25, rect: { x: 30, y: 63, w: 170, h: 44 } }], z)
    expect(t).toContain('"POUCOS" em 1.3s passa por cima da faixa persistente')
  })
})
