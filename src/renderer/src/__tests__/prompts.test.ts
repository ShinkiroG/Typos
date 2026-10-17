import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_RECENT, forgetPrompt, loadPrompts, pushRecent, rememberPrompt, togglePin, type SavedPrompts } from '../montage/prompts'

const empty: SavedPrompts = { recent: [], pinned: [] }

describe('prompts salvos do motion', () => {
  beforeEach(() => localStorage.clear())

  it('põe o mais novo no topo, sem repetir e sem texto vazio', () => {
    let s = pushRecent(empty, 'a')
    s = pushRecent(s, ' b ')
    s = pushRecent(s, 'a')
    s = pushRecent(s, '   ')
    expect(s.recent).toEqual(['a', 'b'])
  })

  it('guarda só os últimos', () => {
    let s = empty
    for (let i = 0; i < MAX_RECENT + 5; i++) s = pushRecent(s, 'p' + i)
    expect(s.recent).toHaveLength(MAX_RECENT)
    expect(s.recent[0]).toBe('p' + (MAX_RECENT + 4))
  })

  it('favorito sai dos recentes e volta pra eles quando desafixa', () => {
    let s = togglePin(pushRecent(pushRecent(empty, 'a'), 'b'), 'a')
    expect(s).toEqual({ recent: ['b'], pinned: ['a'] })
    expect(pushRecent(s, 'a')).toBe(s)
    s = togglePin(s, 'a')
    expect(s).toEqual({ recent: ['a', 'b'], pinned: [] })
  })

  it('esquece dos dois lados', () => {
    expect(forgetPrompt({ recent: ['a', 'b'], pinned: ['c'] }, 'c')).toEqual({ recent: ['a', 'b'], pinned: [] })
  })

  it('salva no PC e aguenta dado estragado', () => {
    rememberPrompt('gráfico de pizza')
    expect(loadPrompts().recent).toEqual(['gráfico de pizza'])
    localStorage.setItem('typos.motionPrompts', '{"recent":[1,"x"],"pinned":"y"}')
    expect(loadPrompts()).toEqual({ recent: ['x'], pinned: [] })
    localStorage.setItem('typos.motionPrompts', 'não é json')
    expect(loadPrompts()).toEqual(empty)
  })
})
