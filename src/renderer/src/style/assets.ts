import { api, profileText, styleFoldersOf, STYLE_FOLDER_ROLES, type Format, type MediaKind, type SoundProfile, type StyleFolder, type StyleFolderRole } from '../lib'

/**
 * Estudo das pastas do estilo: o Typos lista o que tem em cada pasta (sons com a análise de volume:
 * impacto, LUFS, curva de energia) e o Claude escreve um guia de como usar cada asset nos motions.
 * O guia fica salvo no estilo (motion.assetsGuide) e vai junto pros blocos.
 */

export interface StudyItem {
  path: string
  /** categoria/pasta/arquivo (o que o Claude lê) */
  rel: string
  kind: MediaKind
  role: StyleFolderRole
  profile?: SoundProfile
}

/** por pasta e no total (bibliotecas de som têm milhares de arquivos) */
const PER_FOLDER = 40
const MAX_ITEMS = 150
/** imagens das pastas que vão junto pro Claude ver */
export const MAX_STUDY_IMAGES = 8

export const roleLabel = (role: StyleFolderRole) => STYLE_FOLDER_ROLES.find((r) => r.role === role)?.label ?? role
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** o que cada categoria usa: SFX e Música só som; Visual imagem e vídeo; Material bruto tudo */
export const roleKeeps = (role: StyleFolderRole, kind: MediaKind) => (role === 'raw' ? true : role === 'visual' ? kind !== 'audio' : kind === 'audio')

/** categoria que combina com o que tem na pasta (a maioria som: SFX; senão Visual); o autor troca no seletor */
export function guessRole(files: { kind: MediaKind }[]): StyleFolderRole {
  const audio = files.filter((f) => f.kind === 'audio').length
  return files.length && audio / files.length >= 0.6 ? 'sfx' : 'visual'
}

/** os arquivos das pastas do estilo, com o perfil de cada som */
export async function collectStudy(f: Format, onStage?: (s: string) => void): Promise<StudyItem[]> {
  const out: StudyItem[] = []
  const folders = [...styleFoldersOf(f)].sort((a, z) => Number(!!z.star) - Number(!!a.star))
  for (const x of folders) {
    if (out.length >= MAX_ITEMS) break
    onStage?.(`Lendo a pasta "${folderName(x.path)}"…`)
    const list = await api.scanFolder(x.path).catch(() => ({ error: '' }))
    if ('error' in list) continue
    for (const it of list.filter((it) => roleKeeps(x.role, it.kind)).slice(0, Math.min(PER_FOLDER, MAX_ITEMS - out.length)))
      out.push({ path: it.path, rel: [roleLabel(x.role), folderName(x.path), it.rel.replace(/\\/g, '/')].join('/'), kind: it.kind, role: x.role })
  }
  const audio = out.filter((x) => x.kind === 'audio')
  if (audio.length) {
    onStage?.(`Analisando ${audio.length} som(ns): impacto, volume e energia…`)
    const got = await api.soundProfiles(audio.map((x) => x.path)).catch(() => [])
    audio.forEach((x, i) => (x.profile = got[i] ?? undefined))
  }
  return out
}

export const studyImages = (items: StudyItem[]) => items.filter((x) => x.kind === 'image' && /\.(png|jpe?g|webp|gif|bmp)$/i.test(x.path)).slice(0, MAX_STUDY_IMAGES)

const kindText = (x: StudyItem) =>
  (x.kind === 'image' ? 'imagem' : x.kind === 'video' ? 'vídeo' : x.role === 'music' ? 'música' : 'som') + (x.profile ? `, ${x.profile.duration.toFixed(1)} s; ${profileText(x.profile)}` : '')

/** a parte do pedido com as pastas e os arquivos (entra no treino do estilo e no "Estudar os assets") */
export function studySection(folders: StyleFolder[], items: StudyItem[]) {
  if (!folders.length) return []
  return [
    '## Pastas de assets do estilo (estude pra escrever o guia de assets)',
    'O autor ligou estas pastas do PC a este estilo; elas valem pra todo vídeo dele. "Visual do estilo" o motion pode usar sempre (logo, pngtuber, molduras…). "Material bruto", "SFX" e "Música" entram quando um bloco de motion liga "Usar o Material bruto"; os sons viram cortes de áudio mixados com a narração.',
    ...folders.map((x) => `- ${roleLabel(x.role)}/${folderName(x.path)}${x.star ? ' ⭐ favorita' : ''}${x.note?.trim() ? `: ${x.note.trim()}` : ''}`),
    '',
    'Arquivos. Nos sons, a análise do Typos: começa (onde fica audível), impacto (o momento mais forte, contado do começo do arquivo), some (onde praticamente acaba), volume percebido em LUFS e a energia de 0 a 9 ao longo do arquivo.',
    ...items.map((x) => `- ${x.rel} (${kindText(x)})`),
    ''
  ]
}

export const ASSETS_ANSWER = [
  '<assets>',
  'Guia de assets em português, markdown curto e prático, que vai junto em todo pedido de motion deste estilo: pra cada pasta, o que tem e quando usar. Sons agrupados por função (transição/whoosh, impacto/hit, riser, UI/clique, ambiente, trilha…), cada um com o caminho do arquivo, onde está o impacto (pra sincronizar: o arquivo começa em momento − impacto), volume sugerido de 0 a 1 pensando no LUFS (quanto mais alto o arquivo, menor o volume; a narração fica sempre por cima) e o tipo de momento em que cai bem. Trilhas: clima, onde crescem (pela energia), se servem de fundo ou de abertura. Imagens e vídeos: o que são e quando entram. Feche com regras curtas (o que evitar, quantos sons por bloco).',
  '</assets>'
]

/** pedido só do guia de assets (sem refazer o guia e a demo do estilo) */
export function assetsOnlyPrompt(f: Format, section: string[], imageDescs: string[]) {
  const L = [`Você é diretor de motion design e de som de vídeos para YouTube. Estude as pastas de assets do estilo "${f.name}" (${f.aspect}) e escreva o guia de como usar cada uma nos motions.`, '']
  if (f.rules?.trim()) L.push('## Regras do estilo', f.rules.trim(), '')
  const guide = f.motion?.learned?.guide
  if (guide) L.push('## Guia de motion do estilo (já aprendido)', guide.slice(0, 6000), '')
  L.push(...section)
  if (imageDescs.length) L.push('## Imagens (na ordem em que foram enviadas)', ...imageDescs.map((d, i) => `${i + 1}. ${d}`), '')
  L.push('## Responda EXATAMENTE neste formato (nada fora das tags)', ...ASSETS_ANSWER)
  return L.join('\n')
}

export const parseAssets = (text: string) => text.match(/<assets>([\s\S]*?)<\/assets>/i)?.[1]?.trim() ?? ''

/** as pastas mudaram desde o último estudo? */
export function studyStale(f: Format) {
  const g = f.motion?.assetsGuide
  if (!g) return false
  const now = styleFoldersOf(f)
    .map((x) => `${x.role}|${x.path}`)
    .sort()
  return now.join('\n') !== [...g.folders].sort().join('\n')
}
