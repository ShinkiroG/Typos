import { afterEach, describe, expect, it } from 'vitest'
import { api, profileText, styleFoldersOf, type Format, type MontageData } from '../lib'
import { blockPrompt, newBlock, rawFiles, styleAssets } from '../montage/blocks'
import { assetsOnlyPrompt, guessRole, parseAssets, studySection, studyStale } from '../style/assets'

const data: MontageData = {
  bins: [
    { id: 'raw', name: 'Material bruto', role: 'raw' },
    { id: 'sfx', name: 'SFX', role: 'sfx' }
  ],
  media: [{ id: 'v', bin: 'raw', path: '/p/gameplay.mp4', name: 'gameplay.mp4', kind: 'video', duration: 30, hasAudio: true, hasVideo: true }],
  tracks: [],
  clips: []
}

const disk: Record<string, { path: string; name: string; rel: string; kind: 'image' | 'audio' | 'video' }[]> = {
  '/sons/Whooshes': [
    { path: '/sons/Whooshes/whoosh.wav', name: 'whoosh.wav', rel: 'whoosh.wav', kind: 'audio' },
    { path: '/sons/Whooshes/capa.png', name: 'capa.png', rel: 'capa.png', kind: 'image' }
  ],
  '/trilhas': [{ path: '/trilhas/tema.mp3', name: 'tema.mp3', rel: 'tema.mp3', kind: 'audio' }],
  '/logo': [
    { path: '/logo/logo.png', name: 'logo.png', rel: 'logo.png', kind: 'image' },
    { path: '/logo/jingle.wav', name: 'jingle.wav', rel: 'jingle.wav', kind: 'audio' }
  ]
}
const real = { ...api }
afterEach(() => Object.assign(api, real))
const mockDisk = () => Object.assign(api, { scanFolder: async (p: string) => disk[p] ?? { error: 'não existe' } })

const format: Format = {
  id: 'f',
  name: 'Canal',
  aspect: '16:9',
  wpm: 150,
  maxSeconds: null,
  styleFolders: [
    { path: '/logo', role: 'visual' },
    { path: '/trilhas', role: 'music' },
    { path: '/sons/Whooshes', role: 'sfx', star: true, note: 'transições rápidas' }
  ]
}

describe('pastas do estilo', () => {
  it('estilos antigos: as pastas de assets viram pastas visuais', () => {
    expect(styleFoldersOf({ ...format, styleFolders: undefined, assetFolders: ['/a'] })).toEqual([{ path: '/a', role: 'visual' }])
    expect(styleFoldersOf(undefined)).toEqual([])
  })
  it('as visuais seguem como assets do estilo (sem som)', async () => {
    mockDisk()
    const list = await styleAssets(format)
    expect(list.map((x) => x.rel)).toEqual(['logo/logo.png'])
  })
  it('SFX e Música entram depois do bruto do projeto (só sons, as ⭐ antes), na categoria certa da Montagem', async () => {
    mockDisk()
    const list = await rawFiles(data, format)
    expect(list.map((f) => [f.rel, f.bin, f.style])).toEqual([
      ['Material bruto/gameplay.mp4', 'raw', undefined],
      ['Estilo/SFX/Whooshes/whoosh.wav', 'sfx', 'sfx'],
      ['Estilo/Música/trilhas/tema.mp3', 'raw', 'music']
    ])
    expect(await rawFiles(data)).toHaveLength(1)
  })
  it('o prompt do bloco traz a análise do som, as notas das pastas e o guia de assets', async () => {
    mockDisk()
    const prof = { duration: 0.8, attack: 0.02, peakAt: 0.31, tail: 0.7, peakDb: -3, lufs: -14.2, env: '39952', step: 0.1 }
    const list = (await rawFiles(data, format)).map((f) => (f.kind === 'audio' ? { ...f, profile: prof } : f))
    const fm = { ...format, motion: { refs: [], assetsGuide: { at: '', provider: 'x', guide: 'WHOOSH NAS TRANSIÇÕES', folders: [] } } }
    const p = blockPrompt({ block: newBlock('V1', 0, 4), heard: [], hasAudio: false, scriptHere: [], falas: '', files: [], size: { w: 480, h: 270 }, format: fm, raw: { list, first: 1, shown: 0 } })
    expect(p).toContain('pastas do estilo')
    expect(p).toContain('Estilo/SFX/Whooshes ⭐ favorita (use com mais frequência): transições rápidas')
    expect(p).toContain('impacto em 0.31 s')
    expect(p).toContain('em = X − impacto')
    expect(p).toContain('WHOOSH NAS TRANSIÇÕES')
    expect(p).toMatch(/bruto-3-tema\.mp3 ← Estilo\/Música\/trilhas\/tema\.mp3 \(música/)
  })
  it('perfil em texto', () => {
    expect(profileText({ duration: 12, attack: 0, peakAt: 10.25, tail: 11.5, peakDb: -1, env: '1', step: 0.25 })).toBe(
      'começa em 0 s, impacto em 10.3 s, some em 11.5 s, pico -1 dBFS, energia (0–9) a cada 0,25 s: 1'
    )
  })
})

describe('estudo dos assets', () => {
  it('chuta a categoria pelo que tem na pasta', () => {
    expect(guessRole([{ kind: 'audio' }, { kind: 'audio' }, { kind: 'image' }])).toBe('sfx')
    expect(guessRole([{ kind: 'image' }, { kind: 'audio' }])).toBe('visual')
    expect(guessRole([])).toBe('visual')
  })
  it('pede o guia com as pastas e lê a resposta', () => {
    const sec = studySection(format.styleFolders!, [{ path: '/trilhas/tema.mp3', rel: 'Música/trilhas/tema.mp3', kind: 'audio', role: 'music' }])
    const p = assetsOnlyPrompt(format, sec, [])
    expect(p).toContain('- SFX/Whooshes ⭐ favorita: transições rápidas')
    expect(p).toContain('- Música/trilhas/tema.mp3 (música)')
    expect(p).toContain('<assets>')
    expect(parseAssets('x<assets>\n# Guia\n</assets>')).toBe('# Guia')
  })
  it('avisa quando as pastas mudaram desde o estudo', () => {
    const folders = format.styleFolders!.map((x) => `${x.role}|${x.path}`).reverse()
    const f = { ...format, motion: { refs: [], assetsGuide: { at: '', provider: '', guide: 'g', folders } } }
    expect(studyStale(f)).toBe(false)
    expect(studyStale({ ...f, styleFolders: [...format.styleFolders!, { path: '/novo', role: 'raw' }] })).toBe(true)
    expect(studyStale(format)).toBe(false)
  })
})
