import { app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'

export interface AppSettings {
  lastParent?: string
  autoUpdate: boolean
  /** fica só no PC do usuário (userData), nunca vai pro renderer nem pro repositório */
  elevenLabsKey?: string
}

const DEFAULTS: AppSettings = { autoUpdate: true }
const file = () => join(app.getPath('userData'), 'settings.json')

export async function loadSettings(): Promise<AppSettings> {
  try {
    return { ...DEFAULTS, ...JSON.parse(await fs.readFile(file(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function saveSettings(patch: Partial<AppSettings>) {
  const next = { ...(await loadSettings()), ...patch }
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(file(), JSON.stringify(next, null, 2), 'utf8')
  return next
}
