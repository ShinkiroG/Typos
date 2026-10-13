import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { promises as fs, existsSync } from 'fs'
import { writeZip } from './zip'

/**
 * "Exportar projeto": um .zip com a pasta do roteiro e toda mídia de fora que ele usa
 * (narração, brutos, inserts…), pra levar pra outro PC ou guardar. A mídia de fora vai
 * pra <projeto>/_midia-externa e o roteiro.json do zip já aponta pra lá; ao abrir em
 * outro lugar o Typos acerta os caminhos sozinho (fixExternalPaths).
 */

const EXTERNAL = '_midia-externa'
/** fica de fora: cópias de segurança e a pasta de trabalho do render (vídeos finais, pesados) */
const SKIP_TOP = new Set(['.typos-versoes', 'render'])

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (dir === base && SKIP_TOP.has(e.name)) continue
    if (e.isDirectory()) out.push(...(await listFiles(p, base)))
    else if (e.isFile()) out.push(p)
  }
  return out
}

/** troca cada texto do JSON (em qualquer profundidade) pelo que fn devolver */
function mapStrings(v: any, fn: (s: string) => string): any {
  if (typeof v === 'string') return fn(v)
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]))
  return v
}

const inside = (dir: string, p: string) => {
  const r = relative(resolve(dir), resolve(p))
  return !!r && !r.startsWith('..') && !isAbsolute(r)
}

/** caminhos de arquivos de fora da pasta que o roteiro usa */
async function externalFiles(dir: string, data: any) {
  const found = new Set<string>()
  mapStrings(data, (s) => {
    if (s.length < 4 || s.length > 1000 || !isAbsolute(s) || inside(dir, s) || !existsSync(s)) return s
    found.add(s)
    return s
  })
  const out: string[] = []
  for (const p of found) if ((await fs.stat(p).catch(() => null))?.isFile()) out.push(p)
  return out
}

/**
 * Projeto que veio de um zip exportado: caminhos que apontam pra _midia-externa de outra
 * pasta (o PC de onde saiu) passam a apontar pra _midia-externa desta, se o arquivo está aqui.
 */
export function fixExternalPaths(dir: string, data: any): any {
  let changed = false
  const fixed = mapStrings(data, (s) => {
    const m = s.match(/[\\/]_midia-externa[\\/]([^\\/]+)$/)
    if (!m || existsSync(s)) return s
    const here = join(dir, EXTERNAL, m[1])
    if (!existsSync(here)) return s
    changed = true
    return here
  })
  return changed ? fixed : data
}

export function initExportProject() {
  ipcMain.handle('project:export', async (e, dir: string, title: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const safe = (title || basename(dir)).replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').trim().slice(0, 80) || 'Projeto'
    const r = await dialog.showSaveDialog(win!, {
      title: 'Exportar projeto (.zip)',
      defaultPath: join(app.getPath('documents'), `${safe}.zip`),
      filters: [{ name: 'Arquivo zip', extensions: ['zip'] }]
    })
    if (r.canceled || !r.filePath) return null
    if (inside(dir, r.filePath)) return { error: 'Salve o .zip fora da pasta do projeto.' }
    const tmp = join(app.getPath('temp'), `typos-export-${Date.now()}.json`)
    try {
      const data = JSON.parse(await fs.readFile(join(dir, 'roteiro.json'), 'utf8'))
      const ext = await externalFiles(dir, data)
      // nome único dentro de _midia-externa (dois "narracao.wav" de pastas diferentes)
      const names = new Map<string, string>()
      const used = new Set<string>()
      for (const p of ext) {
        const b = basename(p)
        let n = b
        for (let i = 2; used.has(n.toLowerCase()); i++) n = `${basename(b, extname(b))} (${i})${extname(b)}`
        used.add(n.toLowerCase())
        names.set(p, n)
      }
      const rewritten = mapStrings(data, (s) => (names.has(s) ? join(dir, EXTERNAL, names.get(s)!) : s))
      await fs.writeFile(tmp, JSON.stringify(rewritten, null, 2))

      const root = safe
      const files: { path: string; name: string }[] = []
      for (const p of await listFiles(dir)) {
        const rel = relative(dir, p).split(sep).join('/')
        files.push({ path: rel === 'roteiro.json' ? tmp : p, name: `${root}/${rel}` })
      }
      for (const [p, n] of names) files.push({ path: p, name: `${root}/${EXTERNAL}/${n}` })

      let last = 0
      await writeZip(r.filePath, files, (done, total) => {
        const pct = total ? Math.floor((done / total) * 100) : 100
        if (pct !== last) win?.webContents.send('project:exportProgress', (last = pct))
      })
      const bytes = (await fs.stat(r.filePath)).size
      return { path: r.filePath, files: files.length, external: names.size, bytes }
    } catch (err) {
      await fs.rm(r.filePath, { force: true }).catch(() => null)
      return { error: 'Não deu pra exportar: ' + (err as Error).message }
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => null)
    }
  })
}
