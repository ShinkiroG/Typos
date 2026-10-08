import { app, ipcMain } from 'electron'
import { join, dirname } from 'path'
import { promises as fs } from 'fs'
import { loadModule, type Hunspell, type HunspellFactory } from 'hunspell-asm'

/**
 * Corretor ortográfico: Hunspell (WebAssembly) com os dicionários do LibreOffice.
 * O corretor nativo do Chromium não verifica texto carregado/colado dentro do editor,
 * então o renderer manda as palavras pra cá e desenha o sublinhado ele mesmo.
 */

const DICTS: Record<string, string> = {
  'pt-BR': 'dictionary-pt',
  'pt-PT': 'dictionary-pt-pt',
  'en-US': 'dictionary-en',
  'en-GB': 'dictionary-en-gb',
  'es-ES': 'dictionary-es'
}

let factory: Promise<HunspellFactory> | null = null
const instances = new Map<string, Promise<Hunspell>>()
const personalFile = () => join(app.getPath('userData'), 'dicionario-pessoal.txt')

async function personalWords(): Promise<string[]> {
  try {
    return (await fs.readFile(personalFile(), 'utf8')).split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
}

function checker(lang: string): Promise<Hunspell> | null {
  const pkg = DICTS[lang]
  if (!pkg) return null
  let p = instances.get(lang)
  if (!p) {
    p = (async () => {
      factory ??= loadModule()
      const f = await factory
      // acha a pasta do pacote (no app empacotado fica dentro do app.asar/node_modules)
      const dir = dirname(require.resolve(pkg))
      const aff = f.mountBuffer(await fs.readFile(join(dir, 'index.aff')), `${lang}.aff`)
      const dic = f.mountBuffer(await fs.readFile(join(dir, 'index.dic')), `${lang}.dic`)
      const hs = f.create(aff, dic)
      for (const w of await personalWords()) hs.addWord(w)
      return hs
    })()
    instances.set(lang, p)
    p.catch((err) => {
      console.error(`[spell] não carregou o dicionário ${lang}:`, err)
      instances.delete(lang)
    })
  }
  return p
}

export function initSpell() {
  ipcMain.handle('spell:languages', () => Object.keys(DICTS))

  /** devolve só as palavras erradas */
  ipcMain.handle('spell:check', async (_e, lang: string, words: string[]) => {
    const hs = await checker(lang)?.catch(() => null)
    return hs ? words.filter((w) => !hs.spell(w)) : []
  })

  ipcMain.handle('spell:suggest', async (_e, lang: string, word: string) => {
    const hs = await checker(lang)?.catch(() => null)
    return hs ? hs.suggest(word).slice(0, 8) : []
  })

  /** "Adicionar ao dicionário": vale pra todos os idiomas e fica salvo no PC */
  ipcMain.handle('spell:add', async (_e, word: string) => {
    const words = await personalWords()
    if (!words.includes(word)) await fs.writeFile(personalFile(), [...words, word].join('\n') + '\n', 'utf8')
    for (const p of instances.values()) (await p.catch(() => null))?.addWord(word)
  })
}
