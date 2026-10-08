import { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } from 'electron'
import { join, basename, extname, dirname } from 'path'
import { promises as fs, existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { randomUUID } from 'crypto'

// rs://local/<caminho absoluto codificado> serve imagens/áudios locais pro renderer
protocol.registerSchemesAsPrivileged([
  { scheme: 'rs', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
])

const PROJECT_FILE = 'roteiro.json'
const MARKDOWN_FILE = 'roteiro.md'
const ASSETS_DIR = 'assets'
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']

const DEFAULT_FORMATS = [
  { id: 'long', name: 'Longo / Horizontal', aspect: '16:9', wpm: 150, maxSeconds: null },
  { id: 'vertical', name: 'Vertical', aspect: '9:16', wpm: 160, maxSeconds: 60 }
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

async function rememberParent(dir: string) {
  const s = await readJson<Record<string, unknown>>(settingsFile('settings.json'), {})
  s.lastParent = dirname(dir)
  await writeJson(settingsFile('settings.json'), s)
}

// ---------- janela ----------
let win: BrowserWindow | null = null
let allowClose = false

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
    win.webContents.send('app:request-close')
    setTimeout(() => {
      allowClose = true
      win?.close()
    }, 4000)
  })

  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  protocol.handle('rs', (req) => {
    const p = decodeURIComponent(new URL(req.url).pathname.slice(1))
    return net.fetch(pathToFileURL(p).toString())
  })
  createWindow()
})

app.on('window-all-closed', () => app.quit())

ipcMain.handle('app:close-confirmed', () => {
  allowClose = true
  win?.close()
})

// ---------- projetos ----------
ipcMain.handle('project:new', async (): Promise<Result<{ dir: string; data: unknown } | null>> => {
  const settings = await readJson<{ lastParent?: string }>(settingsFile('settings.json'), {})
  const parent = settings.lastParent && existsSync(settings.lastParent) ? settings.lastParent : app.getPath('documents')
  const r = await dialog.showSaveDialog(win!, {
    title: 'Criar novo roteiro (escolha a pasta e o nome)',
    buttonLabel: 'Criar roteiro',
    defaultPath: join(parent, 'Novo roteiro'),
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
  if (r.canceled || !r.filePath) return null
  const dir = r.filePath
  if (existsSync(join(dir, PROJECT_FILE))) return { error: 'Já existe um roteiro nessa pasta. Use "Abrir".' }
  await fs.mkdir(join(dir, ASSETS_DIR), { recursive: true })
  const now = new Date().toISOString()
  const data = {
    version: 1,
    title: basename(dir),
    formatId: 'long',
    doc: {
      type: 'doc',
      content: [
        { type: 'chapter', content: [{ type: 'text', text: 'Gancho' }] },
        { type: 'paragraph' }
      ]
    },
    createdAt: now,
    updatedAt: now
  }
  await writeJson(join(dir, PROJECT_FILE), data)
  await touchRecent(dir, data.title)
  await rememberParent(dir)
  return { dir, data }
})

ipcMain.handle('project:open', async (_e, dir?: string): Promise<Result<{ dir: string; data: any } | null>> => {
  if (!dir) {
    const r = await dialog.showOpenDialog(win!, { title: 'Abrir pasta do roteiro', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    dir = r.filePaths[0]
  }
  const file = join(dir, PROJECT_FILE)
  if (!existsSync(file)) return { error: `Essa pasta não tem um ${PROJECT_FILE}.` }
  const data = await readJson<any>(file, null)
  if (!data) return { error: `Não consegui ler o ${PROJECT_FILE}.` }
  await touchRecent(dir, data.title ?? basename(dir))
  return { dir, data }
})

ipcMain.handle('project:save', async (_e, dir: string, data: any, markdown: string): Promise<Result<true>> => {
  try {
    await writeJson(join(dir, PROJECT_FILE), data)
    await fs.writeFile(join(dir, MARKDOWN_FILE), markdown, 'utf8')
    await touchRecent(dir, data.title)
    return true
  } catch (err) {
    return { error: String(err) }
  }
})

ipcMain.handle('project:recent', async () => {
  const list = await readJson<Recent[]>(settingsFile('recent.json'), [])
  return list.filter((r) => existsSync(join(r.dir, PROJECT_FILE)))
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
