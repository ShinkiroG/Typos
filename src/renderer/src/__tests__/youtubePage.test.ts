import { describe, expect, it } from 'vitest'
import { richParts, channelHandle } from '../youtube/rich'
import { splitTags, tagsLength, ytHashtags } from '../lib'

describe('página do YouTube', () => {
  it('pinta link, hashtag e tempo', () => {
    expect(richParts('Capítulos:\n0:00 Intro\n1:02:03 Fim #carros veja https://x.com/a')).toEqual([
      { kind: 'text', text: 'Capítulos:\n' },
      { kind: 'time', text: '0:00' },
      { kind: 'text', text: ' Intro\n' },
      { kind: 'time', text: '1:02:03' },
      { kind: 'text', text: ' Fim ' },
      { kind: 'tag', text: '#carros' },
      { kind: 'text', text: ' veja ' },
      { kind: 'link', text: 'https://x.com/a' }
    ])
  })
  it('as 3 primeiras hashtags, sem repetir', () => {
    expect(ytHashtags('#a texto #b #a #ção #d')).toEqual(['#a', '#b', '#ção'])
    expect(ytHashtags('sem tag c#d')).toEqual([])
  })
  it('arroba do canal', () => {
    expect(channelHandle('Magnates Média')).toBe('@magnatesmedia')
    expect(channelHandle('')).toBe('@seucanal')
  })
})

describe('tags do YouTube', () => {
  it('separa por vírgula/linha, sem vazias e sem repetir', () => {
    expect(splitTags(' carros, Tesla ,\n,tesla, carro  elétrico', ['Carros'])).toEqual(['Tesla', 'carro elétrico'])
  })
  it('conta como o YouTube (vírgulas + aspas nas com espaço)', () => {
    expect(tagsLength(['abc', 'de f'])).toBe(3 + 1 + 6)
    expect(tagsLength([])).toBe(0)
  })
})
