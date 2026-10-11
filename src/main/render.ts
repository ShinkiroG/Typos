import { ipcMain, type WebContents } from 'electron'
import { join, dirname } from 'path'
import { promises as fs, existsSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { loadSettings } from './settings'
import { findFfmpeg } from './media'
import { findClaudeCode } from './ai'

/**
 * Workspace Render: confere se tudo que vai pro Claude está acessível e manda o Claude Code
 * montar o vídeo (com ffmpeg) dentro de <projeto>/render, mostrando o que ele faz ao vivo.
 */

const MEDIA_RE = /\.(wav|mp3|ogg|flac|aac|m4a|aiff?|mp4|mov|mkv|webm|avi|m4v|png|jpe?g|webp|gif|bmp|svg)$/i

/** existe? dá pra ler? quantos arquivos de mídia tem (pasta: até 2 níveis, para em 2000) */
async function check(path: string) {
  if (!path || !existsSync(path)) return { path, ok: false, error: 'não encontrado' }
  try {
    const st = await fs.stat(path)
    if (st.isFile()) {
      await fs.access(path)
      return { path, ok: true, files: 1, size: st.size }
    }
    let n = 0
    const walk = async (d: string, depth: number) => {
      if (n >= 2000) return
      const list = await fs.readdir(d, { withFileTypes: true })
      for (const e of list) {
        if (n >= 2000) return
        if (e.isDirectory() && depth < 2) await walk(join(d, e.name), depth + 1).catch(() => {})
        else if (MEDIA_RE.test(e.name)) n++
      }
    }
    await walk(path, 0)
    return { path, ok: true, files: n }
  } catch (e: any) {
    return { path, ok: false, error: e?.code === 'EPERM' || e?.code === 'EACCES' ? 'sem permissão de leitura' : String(e?.message ?? e) }
  }
}

export interface RenderJob {
  dir: string
  /** pedido completo (markdown) que o Typos montou */
  brief: string
  /** pastas que o Claude pode ler (mídia, bibliotecas de som, estilo…) */
  readDirs: string[]
  /** guia de estilo aprendido no workspace Estilo, se tiver */
  styleGuide?: string
}

let current: ChildProcess | null = null

/** resumo de uma linha do que o Claude está fazendo (pra lista ao vivo) */
function describeTool(name: string, input: any): string {
  const short = (s: string, n = 140) => (s.length > n ? s.slice(0, n) + '…' : s)
  if (name === 'Bash' || name === 'PowerShell') return '⚙ ' + short(String(input?.description || input?.command || ''))
  if (name === 'Read') return '📄 lendo ' + short(String(input?.file_path ?? ''), 100)
  if (name === 'Write') return '✎ escrevendo ' + short(String(input?.file_path ?? ''), 100)
  if (name === 'Edit') return '✎ ajustando ' + short(String(input?.file_path ?? ''), 100)
  if (name === 'Glob' || name === 'Grep') return '🔎 procurando ' + short(String(input?.pattern ?? ''), 80)
  return name
}

async function newestVideo(dir: string) {
  try {
    const list = await fs.readdir(dir)
    let best: { p: string; t: number } | null = null
    for (const f of list) {
      if (!/\.(mp4|mov|webm|mkv)$/i.test(f)) continue
      const p = join(dir, f)
      const t = (await fs.stat(p)).mtimeMs
      if (!best || t > best.t) best = { p, t }
    }
    return best?.p
  } catch {
    return undefined
  }
}

async function start(sender: WebContents, job: RenderJob) {
  const send = (ev: { kind: 'tool' | 'say' | 'info'; text: string }) => !sender.isDestroyed() && sender.send('render:progress', ev)
  const s = (await loadSettings()).ai ?? {}
  const cc = await findClaudeCode(s)
  if (!cc) throw new Error('Pra criar o vídeo o Typos usa o Claude Code (ele roda o ffmpeg aqui no PC). Instale e faça login em Configurações → IA.')
  const ff = await findFfmpeg()
  if (!ff) throw new Error('O ffmpeg não foi encontrado (Configurações → Mídia).')
  const out = join(job.dir, 'render')
  await fs.mkdir(out, { recursive: true })
  const t0 = Date.now()
  await fs.writeFile(join(out, 'pedido.md'), job.brief, 'utf8')
  if (job.styleGuide) await fs.writeFile(join(out, 'estilo.md'), job.styleGuide, 'utf8')
  const prompt = [
    'Você está dentro do Typos (editor de roteiro e vídeo do usuário). Tarefa: CRIAR A PRÉVIA DO VÍDEO.',
    `Leia o pedido completo em ${join(out, 'pedido.md')}${job.styleGuide ? ` e o guia de estilo em ${join(out, 'estilo.md')}` : ''}.`,
    'Use o ffmpeg (já está no PATH; ffprobe também) pra montar o vídeo seguindo a timeline, o roteiro e o estilo.',
    `Trabalhe só dentro de ${out} (arquivos temporários, legendas .ass, listas de concat, etc.). Nunca altere nem apague os arquivos originais de mídia.`,
    'Vá em etapas curtas e confira cada uma com ffprobe. No fim, responda com um resumo curto do que foi feito e o caminho do vídeo final.'
  ].join('\n')
  const dirs = [...new Set([job.dir, ...job.readDirs].filter((d) => d && existsSync(d)))]
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    'Read,Write,Edit,Glob,Grep,Bash(ffmpeg:*),Bash(ffprobe:*),Bash(mkdir:*),Bash(ls:*),Bash(dir:*)',
    ...dirs.flatMap((d) => ['--add-dir', d])
  ]
  const env = { ...process.env, PATH: dirname(ff.ffmpeg) + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? '') }
  send({ kind: 'info', text: 'Claude Code iniciado. Pedido salvo em render/pedido.md.' })
  return await new Promise<{ path?: string; summary: string; seconds: number }>((resolve, reject) => {
    const p = spawn(cc.path, args, { cwd: out, windowsHide: true, env })
    current = p
    let buf = ''
    let err = ''
    let final: any = null
    p.stdout.on('data', (d) => {
      buf += d
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let ev: any
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.type === 'assistant') {
          for (const c of ev.message?.content ?? []) {
            if (c.type === 'tool_use') send({ kind: 'tool', text: describeTool(c.name, c.input) })
            else if (c.type === 'text' && c.text?.trim()) send({ kind: 'say', text: c.text.trim().slice(0, 600) })
          }
        } else if (ev.type === 'result') final = ev
      }
    })
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => {
      current = null
      reject(e)
    })
    p.on('close', async (code) => {
      current = null
      if (code === null || (p as any).__cancelled) return reject(new Error('Cancelado.'))
      if (!final || final.is_error) return reject(new Error('Claude Code: ' + (String(final?.result ?? err ?? '').trim().slice(0, 300) || 'falhou sem mensagem')))
      const path = await newestVideo(out)
      const fresh = path && (await fs.stat(path)).mtimeMs >= t0
      resolve({ path: fresh ? path : undefined, summary: String(final.result ?? ''), seconds: Math.round((Date.now() - t0) / 1000) })
    })
    p.stdin.end(prompt)
  })
}

export function initRender() {
  ipcMain.handle('render:check', async (_e, paths: string[]) => Promise.all([...new Set(paths)].map(check)))
  ipcMain.handle('render:start', async (e, job: RenderJob) => {
    if (current) return { error: 'Já tem um vídeo sendo criado.' }
    try {
      return await start(e.sender, job)
    } catch (err: any) {
      return { error: String(err?.message ?? err) }
    }
  })
  ipcMain.handle('render:cancel', () => {
    if (!current) return
    ;(current as any).__cancelled = true
    if (process.platform === 'win32' && current.pid) spawn('taskkill', ['/pid', String(current.pid), '/t', '/f'], { windowsHide: true })
    else current.kill()
  })
}
