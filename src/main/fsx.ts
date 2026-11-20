import { join } from 'path'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'

/**
 * Leitura e gravação de arquivos que vários módulos do main usam (sem Electron aqui, pra testar).
 */

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/**
 * No Windows o rename por cima falha (EPERM/EBUSY/EACCES) enquanto outro programa está com o arquivo
 * aberto (antivírus, indexador); costuma soltar em milissegundos, então tenta de novo algumas vezes.
 */
async function renameOver(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await new Promise((r) => setTimeout(r, 20 * 2 ** attempt))
    }
  }
}

/**
 * Grava num .tmp e renomeia: quem lê nunca pega o arquivo pela metade, e uma queda no meio da
 * gravação deixa o arquivo antigo inteiro. O .tmp é único, então duas gravações do mesmo arquivo
 * ao mesmo tempo não se atropelam no rename.
 */
export async function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await fs.writeFile(tmp, text, 'utf8')
    await renameOver(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => null)
    throw err
  }
}

export const writeJson = (file: string, data: unknown) => writeAtomic(file, JSON.stringify(data, null, 2))

/** todos os arquivos da pasta e das subpastas (caminhos completos); `skip` deixa uma entrada de fora */
export async function listFiles(dir: string, skip?: (name: string, parent: string) => boolean): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (skip?.(e.name, dir)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listFiles(p, skip)))
    else if (e.isFile()) out.push(p)
  }
  return out
}

/** um texto como ele aparece dentro de um JSON (barras e aspas escapadas), pra procurar/trocar no arquivo cru */
export const jsonEsc = (s: string) => JSON.stringify(s).slice(1, -1)

/** nome de arquivo sem nada que atrapalhe num caminho ou numa linha de comando */
export const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'arquivo'

/**
 * Tarefas da mesma chave em fila, uma depois da outra (ler → mudar → gravar sem uma atropelar a outra).
 * Uma tarefa que falha não trava as seguintes.
 */
export function serial() {
  const tails = new Map<string, Promise<unknown>>()
  return function run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const next = (tails.get(key) ?? Promise.resolve()).then(job, job)
    const tail = next.catch(() => null)
    tails.set(key, tail)
    void tail.then(() => tails.get(key) === tail && tails.delete(key))
    return next
  }
}
