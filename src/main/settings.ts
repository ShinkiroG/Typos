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
  /** caminho manual do codex.exe, se não for achado sozinho */
  codexPath?: string
  /** modelo do Codex (vazio = o padrão do Codex) */
  codexModel?: string
  routeText?: 'claude-code' | 'codex' | 'anthropic' | 'openai'
  routeImage?: 'claude-code' | 'codex' | 'anthropic' | 'openai'
}

export interface AppSettings {
  lastParent?: string
  autoUpdate: boolean
  /** fica só no PC do usuário (userData), nunca vai pro renderer nem pro repositório */
  elevenLabsKey?: string
  ai?: AiSettings
  /** caminho manual do ffmpeg.exe (Montagem) */
  ffmpegPath?: string
  /** caminho manual do yt-dlp.exe */
  ytdlpPath?: string
  /** modelo do Whisper pro corte automático */
  whisperModel?: string
  /** quantos arquivos o Whisper lê ao mesmo tempo (1–4) */
  whisperParallel?: number
  /** atalhos trocados pelo usuário (id da ação → tecla); o resto usa o padrão */
  keys?: Record<string, string>
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
