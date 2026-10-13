import { ipcMain } from 'electron'
import { join, basename, dirname } from 'path'
import { promises as fs, existsSync } from 'fs'

/**
 * Mídia que mudou de lugar: procura numa pasta escolhida (e subpastas) arquivos com o mesmo nome
 * dos que sumiram. Com mais de um candidato, fica o que está numa pasta de mesmo nome da antiga.
 */
export function initRelink() {
  ipcMain.handle('media:missing', (_e, paths: string[]) => paths.filter((p) => !existsSync(p)))

  ipcMain.handle('media:relink', async (_e, paths: string[], root: string) => {
    const want = new Map<string, string[]>()
    for (const p of paths) {
      const k = basename(p.replace(/\\/g, '/')).toLowerCase()
      want.set(k, [...(want.get(k) ?? []), p])
    }
    const found = new Map<string, string[]>()
    let seen = 0
    const walk = async (dir: string, depth: number) => {
      if (depth > 8 || seen > 50_000) return
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p, depth + 1)
        else {
          seen++
          const k = e.name.toLowerCase()
          if (want.has(k)) found.set(k, [...(found.get(k) ?? []), p])
        }
      }
    }
    await walk(root, 0)
    const out: Record<string, string> = {}
    for (const [k, olds] of want) {
      const cands = found.get(k)
      if (!cands?.length) continue
      for (const old of olds) {
        const parent = basename(dirname(old.replace(/\\/g, '/'))).toLowerCase()
        out[old] = cands.find((c) => basename(dirname(c)).toLowerCase() === parent) ?? cands[0]
      }
    }
    return out
  })
}
