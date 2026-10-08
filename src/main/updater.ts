import { app, dialog, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, promises as fs } from 'fs'
import { join, dirname } from 'path'
import { spawn } from 'child_process'

const REPO = 'ShinkiroG/Typos'

/**
 * installer = instalado pelo Setup.exe (atualiza com electron-updater)
 * portable  = extraído do .zip (atualiza baixando o .zip novo por cima)
 * dev       = rodando via npm run dev
 */
export type InstallMode = 'installer' | 'portable' | 'dev'

export function installMode(): InstallMode {
  if (!app.isPackaged) return 'dev'
  return existsSync(join(dirname(app.getPath('exe')), 'Uninstall Typos.exe')) ? 'installer' : 'portable'
}

function isNewer(remote: string, local: string) {
  const a = remote.replace(/^v/, '').split('.').map(Number)
  const b = local.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  return false
}

interface Release {
  version: string
  zipUrl?: string
}

async function latestRelease(): Promise<Release | null> {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Typos-updater' }
  })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`GitHub respondeu ${r.status}`)
  const j: any = await r.json()
  const zip = (j.assets ?? []).find((a: any) => /portable\.zip$/i.test(a.name))
  return { version: String(j.tag_name).replace(/^v/, ''), zipUrl: zip?.browser_download_url }
}

interface Hooks {
  window: () => BrowserWindow | null
  /** pede pro renderer salvar e libera o fechamento da janela */
  beforeQuit: () => Promise<void>
}

let hooks: Hooks
let pendingZip: { zip: string; version: string } | null = null
let downloadedInstaller: string | null = null
let busy = false

const send = (channel: string, payload?: unknown) => hooks.window()?.webContents.send(channel, payload)

function progress(p: number) {
  hooks.window()?.setProgressBar(p >= 1 || p < 0 ? -1 : p)
  send('update:progress', p)
}

async function downloadZip(url: string, version: string) {
  const dest = join(app.getPath('temp'), `Typos-${version}-portable.zip`)
  const r = await fetch(url)
  if (!r.ok || !r.body) throw new Error(`Download falhou (${r.status})`)
  const total = Number(r.headers.get('content-length')) || 0
  const fh = await fs.open(dest, 'w')
  let got = 0
  try {
    const reader = r.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await fh.write(value)
      got += value.length
      if (total) progress(got / total)
    }
  } finally {
    await fh.close()
    progress(-1)
  }
  return dest
}

/** Script que espera o app fechar, copia a versão nova por cima e (opcionalmente) reabre. */
function runPortableSwap(zip: string, relaunch: boolean) {
  const exe = app.getPath('exe')
  const ps1 = join(app.getPath('temp'), 'typos-update.ps1')
  const script = `
param([int]$ProcId, [string]$Zip, [string]$Dest, [string]$Exe, [int]$Relaunch)
try { Wait-Process -Id $ProcId -Timeout 60 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 700
$tmp = Join-Path $env:TEMP ("typos-update-" + [guid]::NewGuid())
Expand-Archive -LiteralPath $Zip -DestinationPath $tmp -Force
$src = $tmp
$kids = Get-ChildItem $tmp
if ($kids.Count -eq 1 -and $kids[0].PSIsContainer) { $src = $kids[0].FullName }
Copy-Item -Path (Join-Path $src '*') -Destination $Dest -Recurse -Force
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $Zip -Force -ErrorAction SilentlyContinue
if ($Relaunch -eq 1) { Start-Process -FilePath $Exe }
`
  return fs.writeFile(ps1, script, 'utf8').then(() => {
    spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1,
        '-ProcId', String(process.pid), '-Zip', zip, '-Dest', dirname(exe), '-Exe', exe, '-Relaunch', relaunch ? '1' : '0'],
      { detached: true, stdio: 'ignore', windowsHide: true }
    ).unref()
  })
}

async function check(): Promise<{ version: string; zipUrl?: string } | null> {
  if (installMode() === 'installer') {
    const r = await autoUpdater.checkForUpdates()
    const v = r?.updateInfo.version
    return v && isNewer(v, app.getVersion()) ? { version: v } : null
  }
  const rel = await latestRelease()
  return rel && isNewer(rel.version, app.getVersion()) ? rel : null
}

/** Baixa e instala já: fecha, atualiza e reabre. */
async function applyNow(rel: { version: string; zipUrl?: string }) {
  send('update:status', { state: 'downloading', version: rel.version })
  if (installMode() === 'installer') {
    if (!downloadedInstaller) {
      autoUpdater.on('download-progress', (p) => progress(p.percent / 100))
      await autoUpdater.downloadUpdate()
      progress(-1)
    }
    await hooks.beforeQuit()
    autoUpdater.quitAndInstall(true, true)
    return
  }
  if (!rel.zipUrl) throw new Error('A versão nova não tem o .zip portátil.')
  const zip = pendingZip?.version === rel.version ? pendingZip.zip : await downloadZip(rel.zipUrl, rel.version)
  pendingZip = null
  await hooks.beforeQuit()
  await runPortableSwap(zip, true)
  app.quit()
}

/** Botão "Procurar atualizações": pergunta sim/não. */
export async function checkManually() {
  const win = hooks.window()
  const mode = installMode()
  if (mode === 'dev') {
    await dialog.showMessageBox(win!, {
      type: 'info',
      title: 'Atualizações',
      message: 'Atualizações só funcionam no app instalado.',
      detail: 'Você está rodando em modo desenvolvimento (npm run dev).'
    })
    return
  }
  if (busy) return
  busy = true
  try {
    send('update:status', { state: 'checking' })
    const rel = await check()
    send('update:status', { state: 'idle' })
    if (!rel) {
      await dialog.showMessageBox(win!, {
        type: 'info',
        title: 'Atualizações',
        message: `Você já está na versão mais recente (${app.getVersion()}).`
      })
      return
    }
    const { response } = await dialog.showMessageBox(win!, {
      type: 'question',
      title: 'Atualização disponível',
      buttons: ['Sim', 'Não'],
      defaultId: 0,
      cancelId: 1,
      message: `Typos ${rel.version} está disponível (você tem ${app.getVersion()}).\nQuer atualizar agora?`,
      detail: 'O app salva o roteiro, fecha, atualiza e abre de novo sozinho.'
    })
    if (response === 0) await applyNow(rel)
  } catch (err) {
    send('update:status', { state: 'idle' })
    await dialog.showMessageBox(win!, { type: 'error', title: 'Atualizações', message: 'Não consegui atualizar.', detail: String(err) })
  } finally {
    busy = false
  }
}

/** Modo automático: baixa em segundo plano e instala quando o app for fechado. */
async function autoCheck() {
  if (installMode() === 'dev' || busy) return
  busy = true
  try {
    const rel = await check()
    if (!rel) return
    if (installMode() === 'installer') {
      autoUpdater.autoInstallOnAppQuit = true
      await autoUpdater.downloadUpdate()
      downloadedInstaller = rel.version
    } else if (rel.zipUrl) {
      pendingZip = { zip: await downloadZip(rel.zipUrl, rel.version), version: rel.version }
    }
    send('update:ready', { version: rel.version })
  } catch {
    /* sem internet etc.: tenta de novo na próxima abertura */
  } finally {
    busy = false
  }
}

export async function installDownloadedNow() {
  if (installMode() === 'installer' && downloadedInstaller) {
    await hooks.beforeQuit()
    autoUpdater.quitAndInstall(true, true)
  } else if (pendingZip) {
    const { zip } = pendingZip
    pendingZip = null
    await hooks.beforeQuit()
    await runPortableSwap(zip, true)
    app.quit()
  }
}

export function initUpdater(h: Hooks, auto: boolean) {
  hooks = h
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = null

  // zip baixado no modo automático é aplicado quando o usuário fecha o app
  app.on('will-quit', () => {
    if (pendingZip) {
      const { zip } = pendingZip
      pendingZip = null
      runPortableSwap(zip, false)
    }
  })

  if (auto) setTimeout(autoCheck, 4000)
}
