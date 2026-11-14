import { describe, expect, it } from 'vitest'
import { CLAUDE_MOTION_MODELS, claudeModelLabel, motionModelFor } from '../claudeModels'

describe('modelo do Claude pro motion', () => {
  it('o do bloco vence o das Configurações', () => {
    expect(motionModelFor('claude-fable-5-2', 'claude-opus-5-5')).toBe('claude-fable-5-2')
  })
  it('sem o do bloco, usa o das Configurações; sem nenhum, o padrão da conexão', () => {
    expect(motionModelFor(undefined, 'claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(motionModelFor('', '')).toBeUndefined()
  })
  it('oferece Opus e os dois Fable', () => {
    const ids = CLAUDE_MOTION_MODELS.map((m) => m.id)
    expect(ids).toEqual(expect.arrayContaining(['claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5-2']))
    expect(claudeModelLabel('claude-fable-5-2')).toBe('Fable 5.2')
    expect(claudeModelLabel('outro-modelo')).toBe('outro-modelo')
  })
})
