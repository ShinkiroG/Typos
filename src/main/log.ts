import { app, ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { release, platform, arch, totalmem } from 'os'

/**
 * Relatório de erro com um clique: o app guarda as últimas mensagens de erro (do main, da tela e
 * dos pedidos que voltaram com erro, como ffmpeg, render e IA) e "Ajuda → Gerar relatório de erro"
 * junta tudo num .txt pra mandar. Chaves de API nunca entram.
 */

const MAX = 400
const lines: string[] = []

export function logLine(source: string, text: unknown) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const s = (typeof text === 'string' ? text : text instanceof Error ? `${text.message}\n${text.stack ?? ''}` : safeJson(text)).slice(0, 4000)
  lines.push(`[${t}] ${source}: ${s}`)
  if (lines.length > MAX) lines.splice(0, lines.length - MAX)
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

// erros do processo principal
for (const level of ['error', 'warn'] as const) {
  const orig = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    logLine('main.' + level, args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message}\n${a.stack}` : safeJson(a))).join(' '))
    orig(...args)
  }
}
process.on('uncaughtException', (e) => logLine('main.exceção', e))
process.on('unhandledRejection', (e) => logLine('main.promessa', e))

// todo pedido da tela que volta com { error } (ffmpeg, render, IA, Whisper…) ou que estoura fica anotado
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel: string, fn: Parameters<typeof ipcMain.handle>[1]) =>
  handle(channel, async (e, ...args) => {
    try {
      const r = await fn(e, ...args)
      if (r && typeof r === 'object' && typeof (r as { error?: unknown }).error === 'string') logLine(channel, (r as { error: string }).error)
      return r
    } catch (err) {
      logLine(channel + ' (falhou)', err)
      throw err
    }
  })

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13).replace(/(\d{8})(\d{4})/, '$1-$2')

export function initLog(extra: () => Promise<Record<string, unknown>>) {
  ipcMain.on('log:renderer', (_e, text: string) => logLine('tela', text))

  ipcMain.handle('log:report', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const info: Record<string, unknown> = {
      Typos: app.getVersion(),
      Electron: process.versions.electron,
      Sistema: `${platform()} ${release()} ${arch()}`,
      Memória: `${Math.round(totalmem() / 1024 ** 3)} GB`,
      ...(await extra().catch((err) => ({ 'erro ao coletar': String(err) })))
    }
    const body = [
      'Relatório de erro do Typos',
      `Gerado em ${new Date().toLocaleString('pt-BR')}`,
      '',
      ...Object.entries(info).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : safeJson(v)}`),
      '',
      `Últimas mensagens (${lines.length}):`,
      ...(lines.length ? lines : ['(nenhum erro registrado desde que o app abriu)'])
    ].join('\r\n')
    const r = await dialog.showSaveDialog(win!, {
      title: 'Salvar relatório de erro',
      defaultPath: join(app.getPath('desktop'), `Typos-relatorio-${stamp()}.txt`),
      filters: [{ name: 'Texto', extensions: ['txt'] }]
    })
    if (r.canceled || !r.filePath) return null
    await fs.writeFile(r.filePath, body, 'utf8')
    shell.showItemInFolder(r.filePath)
    return { path: r.filePath, lines: lines.length }
  })
}
