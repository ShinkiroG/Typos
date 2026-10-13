import { ipcMain } from 'electron'
import { join } from 'path'
import { promises as fs, existsSync } from 'fs'
import { execFile } from 'child_process'

/**
 * Backup automático do roteiro: antes de gravar, o roteiro.json que estava no disco vira uma cópia
 * em <projeto>/.typos-versoes (no máximo uma a cada 3 min; ficam as 10 mais novas).
 * "Arquivo → Versões anteriores" lista e restaura.
 */

const DIR = '.typos-versoes'
const KEEP = 10
const EVERY_MS = 3 * 60_000
const PROJECT_FILE = 'roteiro.json'

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
const NAME = /^\d{8}-\d{6}(-\d+)?\.json$/

async function list(dir: string) {
  const names = (await fs.readdir(join(dir, DIR)).catch(() => [] as string[])).filter((n) => NAME.test(n))
  return names.sort().reverse()
}

/** guarda o roteiro.json atual antes de ser sobrescrito (force: ignora o intervalo mínimo) */
export async function snapshotVersion(dir: string, force = false) {
  const src = join(dir, PROJECT_FILE)
  if (!existsSync(src)) return
  const vdir = join(dir, DIR)
  const names = await list(dir)
  if (!force && names[0]) {
    const st = await fs.stat(join(vdir, names[0])).catch(() => null)
    if (st && Date.now() - st.mtimeMs < EVERY_MS) return
  }
  const created = !existsSync(vdir)
  await fs.mkdir(vdir, { recursive: true })
  // pasta escondida no Explorer (no Windows o ponto no nome não esconde)
  if (created && process.platform === 'win32') execFile('attrib', ['+h', vdir], { windowsHide: true }, () => null)
  let name = stamp() + '.json'
  for (let i = 2; existsSync(join(vdir, name)); i++) name = `${stamp()}-${i}.json`
  await fs.copyFile(src, join(vdir, name))
  for (const old of (await list(dir)).slice(KEEP)) await fs.rm(join(vdir, old), { force: true })
}

const words = (n: any): number =>
  typeof n?.text === 'string' ? n.text.split(/\s+/).filter(Boolean).length : Array.isArray(n?.content) ? n.content.reduce((s: number, c: any) => s + words(c), 0) : 0

export function initVersions() {
  ipcMain.handle('versions:list', async (_e, dir: string) => {
    const out: { name: string; at: number; words: number; title: string }[] = []
    for (const name of await list(dir)) {
      const file = join(dir, DIR, name)
      try {
        const [st, text] = await Promise.all([fs.stat(file), fs.readFile(file, 'utf8')])
        const data = JSON.parse(text)
        out.push({ name, at: st.mtimeMs, words: words(data?.doc), title: String(data?.title ?? '') })
      } catch {
        /* cópia quebrada: não lista */
      }
    }
    return out
  })

  /** volta pra uma versão: o roteiro atual também vira versão antes (dá pra desfazer a volta) */
  ipcMain.handle('versions:restore', async (_e, dir: string, name: string) => {
    if (!NAME.test(name)) return { error: 'versão inválida' }
    const file = join(dir, DIR, name)
    try {
      JSON.parse(await fs.readFile(file, 'utf8'))
      await snapshotVersion(dir, true)
      await fs.copyFile(file, join(dir, PROJECT_FILE))
      return { ok: true }
    } catch (err) {
      return { error: 'Não deu pra voltar pra essa versão: ' + String(err) }
    }
  })
}
