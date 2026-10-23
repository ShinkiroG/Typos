import { describe, expect, it } from 'vitest'
import { migrateFormat, type Format } from '../lib'

const base: Format = { id: 'f1', name: 'Canal', aspect: '16:9', wpm: 150, maxSeconds: null }

describe('estilos antigos: instrução pro Claude vira parte de rules', () => {
  it('junta as regras com a instrução e apaga a instrução', () => {
    const f = migrateFormat({ ...base, rules: 'pngtuber no canto', motion: { refs: [], instruction: 'cores frias' } })
    expect(f.rules).toBe('pngtuber no canto\n\ncores frias')
    expect(f.motion).toEqual({ refs: [] })
  })
  it('só instrução, ou instrução repetida, não duplica', () => {
    expect(migrateFormat({ ...base, motion: { refs: [], instruction: 'cores frias' } }).rules).toBe('cores frias')
    expect(migrateFormat({ ...base, rules: 'cores frias', motion: { refs: [], instruction: 'cores frias' } }).rules).toBe('cores frias')
  })
  it('estilo já novo fica igual', () => {
    const f = { ...base, rules: 'x', motion: { refs: [] } }
    expect(migrateFormat(f)).toBe(f)
  })
})
