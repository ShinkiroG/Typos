import { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, session } from 'electron'
import { join, basename, extname, dirname, resolve, sep } from 'path'
import { promises as fs, existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { randomUUID } from 'crypto'
import { loadSettings, saveSettings } from './settings'
import { initUpdater, checkManually, installDownloadedNow, installMode } from './updater'
import { initSpell } from './spell'

// rs://local/<caminho absoluto codificado> serve imagens/áudios locais pro renderer
protocol.registerSchemesAsPrivileged([
  { scheme: 'rs', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } }
])

const PROJECT_FILE = 'roteiro.json'
const MARKDOWN_FILE = 'roteiro.md'
const ASSETS_DIR = 'assets'
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']

const DEFAULT_FORMATS = [
  { id: 'long', name: 'Longo / Horizontal', aspect: '16:9', wpm: 150, maxSeconds: null, lang: 'pt-BR' },
  { id: 'vertical', name: 'Vertical', aspect: '9:16', wpm: 160, maxSeconds: 60, lang: 'pt-BR' }
]

const userDir = () => app.getPath('userData')
const settingsFile = (name: string) => join(userDir(), name)
const libraryDir = (sub: string) => join(userDir(), 'library', sub)

type Result<T> = T | { error: string }

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, data: unknown) {
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

/** Copia um arquivo pra dentro de destDir com nome único e devolve o nome novo. */
async function copyUnique(src: string, destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })
  const ext = extname(src).toLowerCase()
  const base = basename(src, extname(src)).replace(/[^\w\-]+/g, '_').slice(0, 40) || 'img'
  const name = `${base}-${randomUUID().slice(0, 8)}${ext}`
  await fs.copyFile(src, join(destDir, name))
  return name
}

async function writeUnique(bytes: Uint8Array, original: string, destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })
  const ext = extname(original).toLowerCase() || '.png'
  const base = basename(original, extname(original)).replace(/[^\w\-]+/g, '_').slice(0, 40) || 'colado'
  const name = `${base}-${randomUUID().slice(0, 8)}${ext}`
  await fs.writeFile(join(destDir, name), bytes)
  return name
}

const isImage = (p: string) => IMAGE_EXT.includes(extname(p).toLowerCase())
const attachment = (rel: string) => ({ id: randomUUID(), path: rel, name: rel.split('/').pop() })

// ---------- recentes ----------
type Recent = { dir: string; title: string; openedAt: string }

async function touchRecent(dir: string, title: string) {
  const list = await readJson<Recent[]>(settingsFile('recent.json'), [])
  const next = [{ dir, title, openedAt: new Date().toISOString() }, ...list.filter((r) => r.dir !== dir)].slice(0, 12)
  await writeJson(settingsFile('recent.json'), next)
}

const rememberParent = (dir: string) => saveSettings({ lastParent: dirname(dir) })

// ---------- janela ----------
let win: BrowserWindow | null = null
let allowClose = false

/** Pede pro renderer salvar o roteiro aberto; resolve quando terminar (ou em 4s). */
function flushRenderer(): Promise<void> {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve()
    const done = () => {
      clearTimeout(timer)
      ipcMain.removeListener('app:flushed', done)
      resolve()
    }
    const timer = setTimeout(done, 4000)
    ipcMain.once('app:flushed', done)
    win.webContents.send('app:flush')
  })
}

async function prepareQuit() {
  await flushRenderer()
  allowClose = true
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e1014',
    autoHideMenuBar: true,
    title: 'Typos',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools()
  })

  // Antes de fechar, deixa o renderer salvar o que estiver pendente
  win.on('close', (e) => {
    if (allowClose || !win) return
    e.preventDefault()
    prepareQuit().then(() => win?.close())
  })

  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  protocol.handle('rs', async (req) => {
    const p = decodeURIComponent(new URL(req.url).pathname.slice(1))
    if (!existsSync(p)) return new Response(null, { status: 404 })
    const res = await net.fetch(pathToFileURL(p).toString())
    // o renderer roda em file:// e precisa de CORS pra ler áudio com fetch()
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(res.body, { status: res.status, headers })
  })
  createWindow()
  loadSettings().then((s) => initUpdater({ window: () => win, beforeQuit: prepareQuit }, s.autoUpdate))
})

app.on('window-all-closed', () => app.quit())

initSpell()

// ---------- configurações e atualizações ----------
ipcMain.handle('settings:get', async () => {
  const s = await loadSettings()
  return { autoUpdate: s.autoUpdate, hasElevenLabsKey: !!s.elevenLabsKey, version: app.getVersion(), mode: installMode() }
})
ipcMain.handle('settings:set', async (_e, patch: { autoUpdate?: boolean; elevenLabsKey?: string }) => {
  const clean: Record<string, unknown> = {}
  if (typeof patch.autoUpdate === 'boolean') clean.autoUpdate = patch.autoUpdate
  if (typeof patch.elevenLabsKey === 'string') clean.elevenLabsKey = patch.elevenLabsKey.trim() || undefined
  await saveSettings(clean)
})
ipcMain.handle('update:check', () => checkManually())
ipcMain.handle('update:installNow', () => installDownloadedNow())

// ---------- projetos ----------
// Roteiro novo nasce como rascunho em <userData>/autosaves e salva sozinho lá.
// "Salvar…" copia a pasta inteira pro lugar escolhido e apaga o rascunho.
const draftsDir = () => join(userDir(), 'autosaves')
const isDraft = (dir: string) => resolve(dir).toLowerCase().startsWith(resolve(draftsDir()).toLowerCase() + sep)

function emptyProject(title: string) {
  const now = new Date().toISOString()
  return {
    version: 1,
    title,
    formatId: 'long',
    doc: {
      type: 'doc',
      content: [{ type: 'chapter', content: [{ type: 'text', text: 'Gancho' }] }, { type: 'paragraph' }]
    },
    createdAt: now,
    updatedAt: now
  }
}

ipcMain.handle('project:new', async () => {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const dir = join(draftsDir(), `rascunho-${stamp}-${randomUUID().slice(0, 4)}`)
  await fs.mkdir(join(dir, ASSETS_DIR), { recursive: true })
  const data = emptyProject('Sem título')
  await writeJson(join(dir, PROJECT_FILE), data)
  return { dir, data, draft: true }
})

ipcMain.handle('project:open', async (_e, dir?: string): Promise<Result<{ dir: string; data: any; draft: boolean } | null>> => {
  if (!dir) {
    const r = await dialog.showOpenDialog(win!, { title: 'Abrir pasta do roteiro', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    dir = r.filePaths[0]
  }
  const file = join(dir, PROJECT_FILE)
  if (!existsSync(file)) return { error: `Essa pasta não tem um ${PROJECT_FILE}.` }
  const data = await readJson<any>(file, null)
  if (!data) return { error: `Não consegui ler o ${PROJECT_FILE}.` }
  if (!isDraft(dir)) await touchRecent(dir, data.title ?? basename(dir))
  return { dir, data, draft: isDraft(dir) }
})

ipcMain.handle('project:save', async (_e, dir: string, data: any, markdown: string): Promise<Result<true>> => {
  try {
    await writeJson(join(dir, PROJECT_FILE), data)
    await fs.writeFile(join(dir, MARKDOWN_FILE), markdown, 'utf8')
    if (!isDraft(dir)) await touchRecent(dir, data.title)
    return true
  } catch (err) {
    return { error: String(err) }
  }
})

/** Salvar como: copia a pasta do roteiro (com assets) pra onde o usuário escolher. */
ipcMain.handle('project:saveAs', async (_e, dir: string, data: any, markdown: string): Promise<Result<{ dir: string } | null>> => {
  const settings = await loadSettings()
  const parent = settings.lastParent && existsSync(settings.lastParent) ? settings.lastParent : app.getPath('documents')
  const name = String(data.title || 'Roteiro').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Roteiro'
  const r = await dialog.showSaveDialog(win!, {
    title: 'Salvar roteiro (escolha a pasta e o nome)',
    buttonLabel: 'Salvar',
    defaultPath: join(parent, name),
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
  if (r.canceled || !r.filePath) return null
  const target = r.filePath
  if (resolve(target) === resolve(dir)) return { dir }
  if (existsSync(join(target, PROJECT_FILE))) return { error: 'Já existe um roteiro nessa pasta. Escolha outro nome.' }
  try {
    await fs.cp(dir, target, { recursive: true })
    await writeJson(join(target, PROJECT_FILE), data)
    await fs.writeFile(join(target, MARKDOWN_FILE), markdown, 'utf8')
    if (isDraft(dir)) await fs.rm(dir, { recursive: true, force: true })
    await touchRecent(target, data.title)
    await rememberParent(target)
    return { dir: target }
  } catch (err) {
    return { error: String(err) }
  }
})

ipcMain.handle('project:recent', async () => {
  const list = await readJson<Recent[]>(settingsFile('recent.json'), [])
  return list.filter((r) => !isDraft(r.dir) && existsSync(join(r.dir, PROJECT_FILE)))
})

ipcMain.handle('project:removeRecent', async (_e, dir: string) => {
  const list = await readJson<Recent[]>(settingsFile('recent.json'), [])
  await writeJson(settingsFile('recent.json'), list.filter((r) => r.dir !== dir))
})

const docHasText = (doc: any): boolean =>
  !!doc && (typeof doc.text === 'string' ? doc.text.trim().length > 0 : (doc.content ?? []).some(docHasText))

/** Rascunhos não salvos. Rascunhos vazios (nada escrito, nada anexado) são apagados aqui. */
ipcMain.handle('project:drafts', async (_e, keep?: string) => {
  const out: { dir: string; title: string; updatedAt: string; preview: string }[] = []
  let names: string[] = []
  try {
    names = await fs.readdir(draftsDir())
  } catch {
    return out
  }
  for (const n of names) {
    const dir = join(draftsDir(), n)
    const data = await readJson<any>(join(dir, PROJECT_FILE), null)
    const hasAssets = (await dirSize(join(dir, ASSETS_DIR))) > 0
    const titled = data && data.title && data.title !== 'Sem título'
    if (!data || (!hasAssets && !titled && !(data.doc?.content ?? []).slice(1).some(docHasText))) {
      if (resolve(dir) !== resolve(keep ?? '')) await fs.rm(dir, { recursive: true, force: true }).catch(() => null)
      continue
    }
    const preview = (data.doc?.content ?? [])
      .filter((b: any) => b.type === 'paragraph')
      .map((b: any) => (b.content ?? []).map((c: any) => c.text ?? '').join(''))
      .join(' ')
      .slice(0, 90)
    out.push({ dir, title: data.title, updatedAt: data.updatedAt, preview })
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
})

ipcMain.handle('project:deleteDraft', async (_e, dir: string) => {
  if (isDraft(dir)) await fs.rm(dir, { recursive: true, force: true })
})

// ---------- armazenamento: rascunhos, cache, recentes ----------
async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries: import('fs').Dirent[] = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(p)
    else total += (await fs.stat(p).catch(() => ({ size: 0 }))).size
  }
  return total
}

/** Sobras de atualização: zip baixado no %TEMP% e cache do electron-updater. */
async function updateLeftovers() {
  const tmp = app.getPath('temp')
  const files = (await fs.readdir(tmp).catch(() => [] as string[]))
    .filter((n) => /^Typos-.*-portable\.zip$/i.test(n) || n === 'typos-update.ps1')
    .map((n) => join(tmp, n))
  const updaterCache = join(process.env.LOCALAPPDATA ?? tmp, 'typos-updater')
  return { files, updaterCache }
}

ipcMain.handle('storage:info', async (_e, keep?: string) => {
  const drafts = (await fs.readdir(draftsDir()).catch(() => [] as string[])).filter((n) => resolve(join(draftsDir(), n)) !== resolve(keep ?? ''))
  let draftBytes = 0
  for (const n of drafts) draftBytes += await dirSize(join(draftsDir(), n))
  const { files, updaterCache } = await updateLeftovers()
  let updateBytes = await dirSize(updaterCache)
  for (const f of files) updateBytes += (await fs.stat(f).catch(() => ({ size: 0 }))).size
  const cacheBytes = (await session.defaultSession.getCacheSize()) + updateBytes
  const recent = (await readJson<Recent[]>(settingsFile('recent.json'), [])).length
  return { drafts: drafts.length, draftBytes, cacheBytes, recent }
})

ipcMain.handle('storage:clear', async (_e, what: 'drafts' | 'cache' | 'recent', keep?: string) => {
  if (what === 'drafts') {
    for (const n of await fs.readdir(draftsDir()).catch(() => [] as string[])) {
      const dir = join(draftsDir(), n)
      if (resolve(dir) !== resolve(keep ?? '')) await fs.rm(dir, { recursive: true, force: true }).catch(() => null)
    }
  } else if (what === 'cache') {
    await session.defaultSession.clearCache()
    await session.defaultSession.clearCodeCaches({}).catch(() => null)
    const { files, updaterCache } = await updateLeftovers()
    for (const f of files) await fs.rm(f, { force: true }).catch(() => null)
    await fs.rm(updaterCache, { recursive: true, force: true }).catch(() => null)
  } else if (what === 'recent') {
    await writeJson(settingsFile('recent.json'), [])
  }
})

ipcMain.handle('shell:open', (_e, path: string) => shell.openPath(path))

// ---------- anexos (copiados pra <projeto>/assets) ----------
ipcMain.handle('asset:pick', async (_e, dir: string) => {
  const r = await dialog.showOpenDialog(win!, {
    title: 'Anexar imagens de referência',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Imagens', extensions: IMAGE_EXT.map((e) => e.slice(1)) }]
  })
  if (r.canceled) return []
  return importPaths(dir, r.filePaths)
})

async function importPaths(dir: string, paths: string[]) {
  const out = []
  for (const p of paths.filter(isImage)) {
    const name = await copyUnique(p, join(dir, ASSETS_DIR))
    out.push(attachment(`${ASSETS_DIR}/${name}`))
  }
  return out
}

ipcMain.handle('asset:importPaths', (_e, dir: string, paths: string[]) => importPaths(dir, paths))

ipcMain.handle('asset:importBuffer', async (_e, dir: string, name: string, bytes: Uint8Array) => {
  const file = await writeUnique(bytes, name, join(dir, ASSETS_DIR))
  return attachment(`${ASSETS_DIR}/${file}`)
})

// ---------- biblioteca de prompts (global, fica no userData) ----------
ipcMain.handle('library:load', () => readJson(settingsFile('library.json'), []))
ipcMain.handle('library:save', (_e, items: unknown) => writeJson(settingsFile('library.json'), items))

ipcMain.handle('library:storeFiles', async (_e, paths: string[]) => {
  const out: string[] = []
  for (const p of paths) out.push(join(libraryDir('files'), await copyUnique(p, libraryDir('files'))))
  return out
})

ipcMain.handle('library:pickCover', async () => {
  const r = await dialog.showOpenDialog(win!, {
    title: 'Imagem do atalho',
    properties: ['openFile'],
    filters: [{ name: 'Imagens', extensions: IMAGE_EXT.map((e) => e.slice(1)) }]
  })
  if (r.canceled || !r.filePaths[0]) return null
  return join(libraryDir('covers'), await copyUnique(r.filePaths[0], libraryDir('covers')))
})

ipcMain.handle('library:coverFromFile', async (_e, path: string) =>
  join(libraryDir('covers'), await copyUnique(path, libraryDir('covers')))
)

// ---------- formatos ----------
ipcMain.handle('formats:load', () => readJson(settingsFile('formats.json'), DEFAULT_FORMATS))
ipcMain.handle('formats:save', (_e, formats: unknown) => writeJson(settingsFile('formats.json'), formats))

// ---------- áudio (copiado pra <projeto>/assets/audio) ----------
const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus']
const isAudio = (p: string) => AUDIO_EXT.includes(extname(p).toLowerCase())
const AUDIO_DIR = `${ASSETS_DIR}/audio`

async function importAudio(dir: string, paths: string[]) {
  const out = []
  for (const p of paths.filter(isAudio)) {
    const name = await copyUnique(p, join(dir, ASSETS_DIR, 'audio'))
    out.push({ path: `${AUDIO_DIR}/${name}`, name: basename(p) })
  }
  return out
}

ipcMain.handle('audio:pick', async (_e, dir: string) => {
  const r = await dialog.showOpenDialog(win!, {
    title: 'Adicionar música ou áudio',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Áudio', extensions: AUDIO_EXT.map((e) => e.slice(1)) }]
  })
  return r.canceled ? [] : importAudio(dir, r.filePaths)
})
ipcMain.handle('audio:importPaths', (_e, dir: string, paths: string[]) => importAudio(dir, paths))

// ---------- ElevenLabs: efeitos sonoros ----------
ipcMain.handle('sfx:generate', async (_e, dir: string, text: string, seconds: number | null) => {
  const key = (await loadSettings()).elevenLabsKey
  if (!key) return { error: 'Coloque sua chave da ElevenLabs em Configurações (engrenagem no topo).' }
  try {
    const body: Record<string, unknown> = { text, prompt_influence: 0.4 }
    if (seconds) body.duration_seconds = Math.min(30, Math.max(0.5, seconds))
    const r = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify(body)
    })
    if (!r.ok) {
      const msg = (await r.text()).slice(0, 300)
      return { error: r.status === 401 ? 'Chave da ElevenLabs inválida.' : `ElevenLabs respondeu ${r.status}: ${msg}` }
    }
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'sfx'
    const name = await writeUnique(new Uint8Array(await r.arrayBuffer()), `sfx-${slug}.mp3`, join(dir, ASSETS_DIR, 'audio'))
    return { path: `${AUDIO_DIR}/${name}`, name: `SFX: ${text.slice(0, 40)}` }
  } catch (err) {
    return { error: `Não consegui falar com a ElevenLabs: ${String(err)}` }
  }
})
