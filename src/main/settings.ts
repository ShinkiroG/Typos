import { app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'

/** Conexões de IA e quem faz cada tarefa (ver main/ai.ts). Chaves nunca saem do main. */
export interface AiSettings {
  anthropicKey?: string
  anthropicModel?: string
  openaiKey?: string
  openaiTextModel?: string
  openaiImageModel?: string
  /** caminho manual do claude.exe, se não for achado sozinho */
  claudeCodePath?: string
  routeText?: 'claude-code' | 'anthropic' | 'openai'
  routeImage?: 'claude-code' | 'anthropic' | 'openai'
}

export interface AppSettings {
  lastParent?: string
  autoUpdate: boolean
  /** fica só no PC do usuário (userData), nunca vai pro renderer nem pro repositório */
  elevenLabsKey?: string
  ai?: AiSettings
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
