import { app, ipcMain } from 'electron'
import { join } from 'path'
import { promises as fs, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import {
  countWords,
  legacyTime,
  parseName,
  pickKeep,
  repairDraftPaths,
  sameDir,
  snapshotReason,
  validId,
  versionName,
  type Reason,
  type VersionInfo
} from './historyCore'

/**
 * Histórico de versões do roteiro, num lugar só: <userData>/historico/<id do roteiro>/.
 * O id fica no roteiro.json, então o histórico acompanha o roteiro quando o rascunho é salvo,
 * a pasta muda de nome ou de lugar. Antes de gravar por cima, o roteiro que estava no disco
 * vira uma cópia (regras em historyCore.ts). As cópias antigas de <projeto>/.typos-versoes
 * entram aqui na primeira vez que o roteiro é aberto.
 */

const PROJECT_FILE = 'roteiro.json'
const LEGACY_DIR = '.typos-versoes'

interface Info {
  id: string
  title: string
  /** última pasta onde o roteiro esteve */
  dir: string
  imported?: boolean
}

const root = () => join(app.getPath('userData'), 'historico')
const store = (id: string) => join(root(), id)
const keyOf = (dir: string) => (process.platform === 'win32' ? dir.toLowerCase() : dir)

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, data: unknown) {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

const infos = new Map<string, Info>()
async function readInfo(id: string): Promise<Info | null> {
  if (infos.has(id)) return infos.get(id)!
  const info = await readJson<Info | null>(join(store(id), 'info.json'), null)
  if (info) infos.set(id, info)
  return info
}

/** só grava o info.json quando algo mudou (o autosave chama isso a cada salvar) */
async function touchInfo(id: string, patch: Partial<Info>) {
  const old = await readInfo(id)
  const next: Info = { id, title: '', dir: '', ...old, ...patch }
  if (old && old.title === next.title && old.dir === next.dir && !!old.imported === !!next.imported) return
  await fs.mkdir(store(id), { recursive: true })
  await writeJson(join(store(id), 'info.json'), next)
  infos.set(id, next)
}

async function listVersions(id: string): Promise<VersionInfo[]> {
  const names = await fs.readdir(store(id)).catch(() => [] as string[])
  return names
    .map(parseName)
    .filter((v): v is VersionInfo => !!v)
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
}

async function prune(id: string) {
  const all = await listVersions(id)
  const keep = pickKeep(all, Date.now())
  for (const v of all) if (!keep.has(v.name)) await fs.rm(join(store(id), v.name), { force: true }).catch(() => null)
}

/** grava uma cópia (pula se for igual à última) */
async function writeVersion(id: string, text: string, at: number, reason: Reason, words: number) {
  const latest = (await listVersions(id))[0]
  if (latest && latest.words === words && (await fs.readFile(join(store(id), latest.name), 'utf8').catch(() => '')) === text) return
  await fs.mkdir(store(id), { recursive: true })
  let n = 1
  while (existsSync(join(store(id), versionName(at, reason, words, n)))) n++
  await fs.writeFile(join(store(id), versionName(at, reason, words, n)), text, 'utf8')
}

/** roteiros já salvos desde que o app abriu (o primeiro salvar de cada um guarda como estava ao abrir) */
const seen = new Set<string>()
/** pasta → id já conferido nesta sessão */
const known = new Map<string, string>()

/**
 * O id do roteiro desta pasta. Pasta copiada no Explorer (mesmo id, as duas existem): a que não é a
 * do histórico vira outro roteiro, pra não misturar as cópias.
 */
export async function projectId(dir: string, disk: any): Promise<string> {
  let id: string | null = validId(disk?.id) ? disk.id : null
  const key = keyOf(dir)
  if (id && known.get(key) === id) return id
  if (id) {
    const info = await readInfo(id)
    if (info?.dir && !sameDir(info.dir, dir) && existsSync(join(info.dir, PROJECT_FILE))) {
      const other = await readJson<any>(join(info.dir, PROJECT_FILE), null)
      if (other?.id === id) id = null
    }
  }
  if (!id) id = randomUUID()
  known.set(key, id)
  return id
}

/** esta pasta passou a ser a casa do roteiro (salvar como, mover) */
export async function adoptDir(dir: string, id: string, title: string) {
  known.set(keyOf(dir), id)
  seen.add(keyOf(dir))
  await touchInfo(id, { title, dir })
}

/** cópia forçada do roteiro que está no disco agora (antes de voltar versão, salvar como…) */
export async function snapshotNow(dir: string, reason: Reason) {
  const file = join(dir, PROJECT_FILE)
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  if (!text) return
  let disk: any
  try {
    disk = JSON.parse(text)
  } catch {
    return
  }
  const id = await projectId(dir, disk)
  const st = await fs.stat(file).catch(() => null)
  await writeVersion(id, text, st?.mtimeMs ?? Date.now(), reason, countWords(disk?.doc))
  await touchInfo(id, { title: String(disk?.title ?? ''), dir })
  await prune(id)
}

/**
 * Antes do autosave gravar: põe o id no que vai ser gravado e, se for a hora, guarda o roteiro
 * que está no disco. Erro no histórico não impede o salvar.
 */
export async function beforeSave(dir: string, diskText: string | null, data: any) {
  let disk: any = null
  try {
    disk = diskText ? JSON.parse(diskText) : null
  } catch {
    /* roteiro.json quebrado no disco: não vira cópia */
  }
  data.id = await projectId(dir, disk)
  try {
    const key = keyOf(dir)
    const first = !seen.has(key)
    seen.add(key)
    if (disk && diskText) {
      const versions = await listVersions(data.id)
      const latest = versions[0] ?? null
      const st = latest ? await fs.stat(join(store(data.id), latest.name)).catch(() => null) : null
      const reason = snapshotReason({
        firstSaveThisSession: first,
        latest,
        latestWrittenAt: st?.mtimeMs ?? null,
        diskWords: countWords(disk.doc),
        newWords: countWords(data.doc),
        now: Date.now()
      })
      if (reason) {
        const at = (await fs.stat(join(dir, PROJECT_FILE)).catch(() => null))?.mtimeMs ?? Date.now()
        await writeVersion(data.id, diskText, at, reason, countWords(disk.doc))
        await prune(data.id)
      }
    }
    await touchInfo(data.id, { title: String(data.title ?? ''), dir })
  } catch (err) {
    console.warn('histórico:', err)
  }
}

/** cópias antigas de <projeto>/.typos-versoes entram no histórico (a pasta fica onde está) */
async function importLegacy(dir: string, id: string) {
  if ((await readInfo(id))?.imported) return
  const ldir = join(dir, LEGACY_DIR)
  for (const name of await fs.readdir(ldir).catch(() => [] as string[])) {
    const at = legacyTime(name)
    if (at == null) continue
    const text = await fs.readFile(join(ldir, name), 'utf8').catch(() => null)
    if (!text) continue
    try {
      await writeVersion(id, text, at, 'importado', countWords(JSON.parse(text)?.doc))
    } catch {
      /* cópia quebrada: fica de fora */
    }
  }
  await touchInfo(id, { imported: true })
  await prune(id)
}

/**
 * Ao abrir: garante o id no roteiro.json, conserta a mídia que apontava pro rascunho apagado
 * e traz as cópias antigas pro histórico.
 */
export async function onOpen(dir: string, data: any): Promise<any> {
  const id = await projectId(dir, data)
  const repaired = repairDraftPaths(data, dir, existsSync)
  let out = repaired.data
  if (out.id !== id || repaired.changed) {
    out = { ...out, id }
    await writeJson(join(dir, PROJECT_FILE), out).catch((err) => console.warn('histórico:', err))
  }
  await importLegacy(dir, id).catch((err) => console.warn('histórico (cópias antigas):', err))
  await touchInfo(id, { title: String(out.title ?? ''), dir }).catch(() => null)
  return out
}

const fmtWhen = (at: number) => {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function initHistory(o: { newDraftDir: () => Promise<string> }) {
  /** todos os roteiros com histórico, inclusive os de pasta apagada ou movida */
  ipcMain.handle('history:projects', async () => {
    const out: { id: string; title: string; dir: string; exists: boolean; versions: number; lastAt: number }[] = []
    for (const id of await fs.readdir(root()).catch(() => [] as string[])) {
      if (!validId(id)) continue
      const versions = await listVersions(id)
      if (!versions.length) continue
      const info = await readInfo(id)
      const dir = info?.dir ?? ''
      out.push({ id, title: info?.title || 'Sem título', dir, exists: !!dir && existsSync(join(dir, PROJECT_FILE)), versions: versions.length, lastAt: versions[0].at })
    }
    return out.sort((a, b) => b.lastAt - a.lastAt)
  })

  /** as versões de um roteiro, pela pasta (roteiro aberto) ou pelo id (tela inicial) */
  ipcMain.handle('history:list', async (_e, ref: { dir?: string; id?: string }) => {
    let id = ref.id
    if (ref.dir) id = (await readJson<any>(join(ref.dir, PROJECT_FILE), null))?.id
    if (!validId(id)) return { id: null, title: '', dir: '', exists: false, versions: [] }
    const info = await readInfo(id)
    const dir = info?.dir ?? ''
    return { id, title: info?.title ?? '', dir, exists: !!dir && existsSync(join(dir, PROJECT_FILE)), versions: await listVersions(id) }
  })

  ipcMain.handle('history:read', async (_e, id: string, name: string) => {
    if (!validId(id) || !parseName(name)) return null
    return readJson<any>(join(store(id), name), null)
  })

  /** volta o roteiro desta pasta pra uma versão; o de agora vira cópia antes (dá pra desfazer) */
  ipcMain.handle('history:restore', async (_e, dir: string, id: string, name: string) => {
    if (!validId(id) || !parseName(name)) return { error: 'versão inválida' }
    try {
      const data = JSON.parse(await fs.readFile(join(store(id), name), 'utf8'))
      await snapshotNow(dir, 'antes-de-voltar')
      const current = await readJson<any>(join(dir, PROJECT_FILE), null)
      const out = { ...repairDraftPaths(data, dir, existsSync).data, id: validId(current?.id) ? current.id : id }
      await writeJson(join(dir, PROJECT_FILE), out)
      return { ok: true }
    } catch (err) {
      return { error: 'Não deu pra voltar pra essa versão: ' + String(err) }
    }
  })

  /** abre uma versão como rascunho novo (o roteiro original não muda) */
  ipcMain.handle('history:openCopy', async (_e, id: string, name: string) => {
    const v = parseName(name)
    if (!validId(id) || !v) return { error: 'versão inválida' }
    try {
      const data = JSON.parse(await fs.readFile(join(store(id), name), 'utf8'))
      const dir = await o.newDraftDir()
      const now = new Date().toISOString()
      const out = { ...data, id: randomUUID(), title: `${data.title || 'Sem título'} (versão de ${fmtWhen(v.at)})`, createdAt: now, updatedAt: now }
      await writeJson(join(dir, PROJECT_FILE), out)
      return { dir, data: out, draft: true }
    } catch (err) {
      return { error: 'Não deu pra abrir essa versão: ' + String(err) }
    }
  })
}
