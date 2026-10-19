import { BrowserWindow, ipcMain } from 'electron'
import { AsyncLocalStorage } from 'async_hooks'
import { join } from 'path'
import { promises as fs } from 'fs'

/**
 * Quanto cada pedido de IA levou e custou. Quem paga por uso (chave da Anthropic ou da
 * OpenAI) vê o custo em dólar, calculado pelos tokens que a própria API devolve; o
 * Claude Code usa o plano do usuário, então só mostra o tempo.
 *
 * O gasto soma por projeto em <roteiro>/.typos-ia.json, com um limite opcional: passou
 * dele, os pedidos pagos param até o usuário subir o limite (o Claude Code segue livre).
 */

// US$ por milhão de tokens [entrada, saída]; o primeiro prefixo que bater vale
const ANTHROPIC: [string, number, number][] = [
  ['claude-opus-5-5', 4, 20],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4', 5, 25],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4', 3, 15],
  ['claude-haiku-5', 0.1, 0.5],
  ['claude-haiku-4', 1, 5],
  ['claude-fable-5', 10, 50]
]
const OPENAI: [string, number, number][] = [
  ['gpt-5-nano', 0.05, 0.4],
  ['gpt-5-mini', 0.25, 2],
  ['gpt-5', 1.25, 10],
  ['gpt-4.1-mini', 0.4, 1.6],
  ['gpt-4.1', 2, 8],
  ['gpt-4o-mini', 0.15, 0.6],
  ['gpt-4o', 2.5, 10],
  // imagem: entrada de texto 5, saída (a imagem) 40
  ['gpt-image-1', 5, 40]
]
const WEB_SEARCH = 10 / 1000 // US$ por busca na web da Anthropic

const price = (table: [string, number, number][], model: string) => table.find(([p]) => model.startsWith(p))

interface Meter {
  cost: number
  /** algum pedido sem preço conhecido (modelo fora da tabela) */
  unknown: boolean
}
const als = new AsyncLocalStorage<Meter>()

export function chargeAnthropic(model: string, u: any) {
  const m = als.getStore()
  if (!m || !u) return
  const p = price(ANTHROPIC, model)
  if (!p) return void (m.unknown = true)
  const [, inp, out] = p
  const tokens =
    (u.input_tokens ?? 0) * inp + (u.cache_creation_input_tokens ?? 0) * inp * 1.25 + (u.cache_read_input_tokens ?? 0) * inp * 0.1 + (u.output_tokens ?? 0) * out
  m.cost += tokens / 1e6 + (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH
}

export function chargeOpenAI(model: string, u: any) {
  const m = als.getStore()
  if (!m || !u) return
  const p = price(OPENAI, model)
  if (!p) return void (m.unknown = true)
  const inTok = u.prompt_tokens ?? u.input_tokens ?? 0
  const outTok = u.completion_tokens ?? u.output_tokens ?? 0
  m.cost += (inTok * p[1] + outTok * p[2]) / 1e6
}

// ---------- gasto por projeto ----------
interface Budget {
  spent: number
  cap?: number
}
const budgetFile = (dir: string) => join(dir, '.typos-ia.json')
async function readBudget(dir?: string): Promise<Budget> {
  if (!dir) return { spent: 0 }
  try {
    const j = JSON.parse(await fs.readFile(budgetFile(dir), 'utf8'))
    return { spent: Number(j.spent) || 0, cap: j.cap > 0 ? Number(j.cap) : undefined }
  } catch {
    return { spent: 0 }
  }
}
const writeBudget = (dir: string, b: Budget) => fs.writeFile(budgetFile(dir), JSON.stringify(b, null, 2)).catch(() => null)

/** projeto aberto agora (pedidos que não dizem a pasta contam pra ele) */
let current: string | undefined

const usd = (n: number) => 'US$ ' + n.toFixed(n < 1 ? 3 : 2).replace('.', ',')

/**
 * Roda um pedido de IA medindo tempo e custo. Pedido pago com o limite do projeto
 * estourado nem sai. No fim avisa a janela: quanto levou, quanto custou, total do projeto.
 */
export async function metered<T>(provider: string, dir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const project = dir || current
  // Claude Code e Codex rodam no plano do usuário: não contam no gasto
  const paid = provider !== 'claude-code' && provider !== 'codex'
  if (paid && project) {
    const b = await readBudget(project)
    if (b.cap !== undefined && b.spent >= b.cap)
      throw new Error(`Este projeto já gastou ${usd(b.spent)} com IA e o limite é ${usd(b.cap)}. Suba o limite em Configurações → IA pra continuar.`)
  }
  const meter: Meter = { cost: 0, unknown: false }
  const t0 = Date.now()
  let ok = false
  try {
    const r = await als.run(meter, fn)
    ok = true
    return r
  } finally {
    const ms = Date.now() - t0
    let spent: number | undefined
    let cap: number | undefined
    // conta o que foi cobrado mesmo se o pedido deu erro no meio
    if (paid && project && meter.cost > 0) {
      const b = await readBudget(project)
      b.spent += meter.cost
      await writeBudget(project, b)
      spent = b.spent
      cap = b.cap
    }
    const ev = { provider, ms, ok, cost: paid && !meter.unknown ? meter.cost : null, spent, cap }
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ai:usage', ev)
  }
}

export function initAiMeter() {
  ipcMain.handle('ai:project', (_e, dir: string | null) => void (current = dir || undefined))
  ipcMain.handle('ai:budget', (_e, dir: string) => readBudget(dir))
  ipcMain.handle('ai:setBudget', async (_e, dir: string, cap: number | null) => {
    const b = await readBudget(dir)
    b.cap = cap && cap > 0 ? cap : undefined
    await writeBudget(dir, b)
    return b
  })
}
