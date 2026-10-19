import { app, ipcMain } from 'electron'
import { join, dirname } from 'path'
import { promises as fs, existsSync } from 'fs'
import { spawn, execFile } from 'child_process'
import { randomUUID } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { loadSettings, saveSettings, type AiSettings } from './settings'
import { chargeAnthropic, chargeOpenAI, initAiMeter, metered } from './aiMeter'

/**
 * IA do Typos, sem depender de um fornecedor só. O app pede uma TAREFA ("texto" ou
 * "imagem"); qual conexão faz cada tarefa é escolha do usuário em Configurações.
 *
 *  - claude-code: o Claude Code instalado neste PC (usa o plano do usuário, sem chave)
 *  - anthropic:   API da Anthropic (chave própria, paga por uso)
 *  - codex:       o Codex (CLI da OpenAI) instalado neste PC, logado com a conta do ChatGPT (usa o plano, sem chave; gera imagem)
 *  - openai:      API da OpenAI (chave própria, paga por uso; gera imagem)
 *
 * Chaves ficam só no settings.json do userData e nunca voltam pro renderer.
 */

export type ProviderId = 'claude-code' | 'codex' | 'anthropic' | 'openai'
type Task = 'text' | 'image'

const CAPS: Record<ProviderId, Task[]> = {
  'claude-code': ['text'],
  codex: ['text', 'image'],
  anthropic: ['text'],
  openai: ['text', 'image']
}

const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5-5',
  openaiText: 'gpt-5',
  openaiImage: 'gpt-image-1'
}

// ---------- Claude Code: achar o executável ----------
function run(file: string, args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number; signal?: AbortSignal } = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const p = spawn(file, args, { cwd: opts.cwd, windowsHide: true, env: process.env })
    let out = ''
    let err = ''
    opts.signal?.addEventListener(
      'abort',
      () => {
        p.kill()
        err += '\n(cancelado)'
      },
      { once: true }
    )
    const timer = setTimeout(() => {
      p.kill()
      err += '\n(tempo esgotado)'
    }, opts.timeoutMs ?? 120000)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: String(e) })
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
    if (opts.input !== undefined) p.stdin.end(opts.input)
    else p.stdin.end()
  })
}

/** tudo que o "where" acha pra esse comando (vazio se nada) */
const whereAll = (cmd: string) =>
  new Promise<string[]>((resolve) =>
    execFile('where', [cmd], { windowsHide: true }, (e, out) => resolve(e ? [] : out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)))
  )
const whereClaude = async () => (await whereAll('claude'))[0] ?? null

/** Onde está o Claude Code: caminho escolhido > comando no PATH > instalador oficial. */
export async function findClaudeCode(s: AiSettings): Promise<{ path: string; source: string } | null> {
  if (s.claudeCodePath && existsSync(s.claudeCodePath)) return { path: s.claudeCodePath, source: 'caminho escolhido' }
  const onPath = await whereClaude()
  if (onPath) return { path: onPath.trim(), source: 'comando claude' }
  const home = app.getPath('home')
  for (const p of [join(home, '.local', 'bin', 'claude.exe'), join(home, '.claude', 'local', 'claude.exe')])
    if (existsSync(p)) return { path: p, source: 'instalação oficial' }
  return null
}

// ---------- Codex: achar o executável ----------
/**
 * O npm instala o Codex como codex.cmd (um script que chama o codex.exe de verdade).
 * O spawn não roda .cmd sem shell, então vamos direto no .exe que vem no pacote.
 */
function codexExeFromNpm(binDir: string): string | null {
  const arm = process.arch === 'arm64'
  const pkg = arm ? 'codex-win32-arm64' : 'codex-win32-x64'
  const triple = arm ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const roots = [join(binDir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', pkg), join(binDir, 'node_modules', '@openai', pkg), join(binDir, 'node_modules', '@openai', 'codex')]
  for (const r of roots)
    for (const p of [join(r, 'vendor', triple, 'bin', 'codex.exe'), join(r, 'vendor', triple, 'codex', 'codex.exe')]) if (existsSync(p)) return p
  return null
}

/** Onde está o Codex: caminho escolhido > comando no PATH > instalação do npm. */
export async function findCodex(s: AiSettings): Promise<{ path: string; source: string } | null> {
  if (s.codexPath && existsSync(s.codexPath)) return { path: s.codexPath, source: 'caminho escolhido' }
  const found = await whereAll('codex')
  const exe = found.find((p) => /\.exe$/i.test(p))
  if (exe) return { path: exe, source: 'comando codex' }
  for (const p of found) {
    const real = codexExeFromNpm(dirname(p))
    if (real) return { path: real, source: 'comando codex (npm)' }
  }
  const npmBin = join(process.env.APPDATA ?? join(app.getPath('home'), 'AppData', 'Roaming'), 'npm')
  const real = codexExeFromNpm(npmBin)
  return real ? { path: real, source: 'instalação do npm' } : null
}

const CODEX_LOGIN_MSG = 'O Codex não está logado. Abra um terminal, rode "codex login" e entre com sua conta do ChatGPT.'

/** roda "codex exec" com o pedido pela entrada padrão e devolve a última mensagem do agente */
async function codexExec(s: AiSettings, prompt: string, opts: { cwd: string; sandbox: 'read-only' | 'workspace-write'; extra?: string[]; timeoutMs: number; signal?: AbortSignal }) {
  const cx = await findCodex(s)
  if (!cx) throw new Error('Codex não encontrado neste PC. Instale e faça login (Configurações → IA).')
  const outFile = join(app.getPath('temp'), `typos-codex-${randomUUID().slice(0, 8)}.txt`)
  const args = ['exec', '--skip-git-repo-check', '--color', 'never', '--sandbox', opts.sandbox, '-C', opts.cwd, '-o', outFile, ...(s.codexModel ? ['-m', s.codexModel] : []), ...(opts.extra ?? []), '-']
  const r = await run(cx.path, args, { cwd: opts.cwd, input: prompt, timeoutMs: opts.timeoutMs, signal: opts.signal })
  const last = await fs.readFile(outFile, 'utf8').catch(() => '')
  await fs.rm(outFile, { force: true }).catch(() => null)
  if (r.code === 0 && last.trim()) return { text: last.trim(), out: r.out }
  if (opts.signal?.aborted) throw new Error('Cancelado.')
  const why = (r.err || r.out || '').toString().trim()
  if (/not logged in|log ?in|unauthori[sz]ed|\b401\b|auth/i.test(why)) throw new Error(CODEX_LOGIN_MSG)
  if (r.err.includes('(tempo esgotado)')) throw new Error('Codex: tempo esgotado. Tente de novo.')
  throw new Error(`Codex: ${why.split(/\r?\n/).filter(Boolean).slice(-4).join(' ').slice(0, 300) || 'falhou sem mensagem'}`)
}

// ---------- tarefas por fornecedor ----------
interface TextJob {
  /** instrução do que fazer (curta) */
  instruction: string
  /** material: a fala, o trecho do roteiro… */
  input: string
  /** pasta do roteiro (o Claude Code roda lá e pode ler roteiro.md e anexos) */
  dir?: string
  /** tempo máximo do Claude Code (pedidos grandes, como achar recortes num vídeo longo); padrão 3 min */
  timeoutMs?: number
}

async function textClaudeCode(s: AiSettings, job: TextJob) {
  const cc = await findClaudeCode(s)
  if (!cc) throw new Error('Claude Code não encontrado neste PC. Instale e faça login (Configurações → IA).')
  const prompt = `${job.instruction}\n\nSe precisar de dados atuais ou números exatos, pesquise na web. Responda só com o resultado, sem comentários antes ou depois.\n\n---\n${job.input}`
  // prompt vai pela entrada padrão (sem limite de tamanho da linha de comando do Windows)
  // no modo -p só roda ferramenta liberada aqui: busca na web sim, mexer em arquivo não
  const r = await run(cc.path, ['-p', '--output-format', 'json', '--allowedTools', 'WebSearch,WebFetch'], { cwd: job.dir, input: prompt, timeoutMs: Math.min(30 * 60000, job.timeoutMs ?? 180000) })
  let parsed: any = null
  try {
    parsed = JSON.parse(r.out)
  } catch {
    /* saída não-JSON: erro abaixo */
  }
  if (parsed && !parsed.is_error && typeof parsed.result === 'string') return parsed.result.trim()
  const why = (parsed?.result || r.err || r.out || '').toString().trim()
  if (/log ?in|auth|credential|\/login/i.test(why)) throw new Error('O Claude Code não está logado. Abra um terminal, rode "claude" e faça o login.')
  throw new Error(`Claude Code: ${why.slice(0, 300) || 'falhou sem mensagem'}`)
}

async function textCodex(s: AiSettings, job: TextJob) {
  const prompt = `${job.instruction}\n\nSe precisar de dados atuais ou números exatos, pesquise na web. Não mexa em nenhum arquivo. Responda só com o resultado, sem comentários antes ou depois.\n\n---\n${job.input}`
  const cwd = job.dir && existsSync(job.dir) ? job.dir : app.getPath('temp')
  const r = await codexExec(s, prompt, { cwd, sandbox: 'read-only', extra: ['--ephemeral'], timeoutMs: Math.min(30 * 60000, job.timeoutMs ?? 180000) })
  return r.text
}

async function textAnthropic(s: AiSettings, job: TextJob) {
  if (!s.anthropicKey) throw new Error('Coloque a chave da API da Anthropic em Configurações → IA.')
  const client = new Anthropic({ apiKey: s.anthropicKey })
  const res = await client.beta.messages.create({
    model: s.anthropicModel || DEFAULT_MODELS.anthropic,
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    // se o modelo recusar por política, o próprio servidor tenta outro modelo
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    system: 'Você ajuda a escrever roteiros de vídeo para YouTube, em português do Brasil.',
    messages: [{ role: 'user', content: `${job.instruction}\n\nSe precisar de dados atuais ou números exatos, pesquise na web. Responda só com o resultado, sem comentários antes ou depois.\n\n---\n${job.input}` }]
  })
  chargeAnthropic(res.model, res.usage)
  if (res.stop_reason === 'refusal') throw new Error('O Claude recusou esse pedido.')
  return res.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim()
}

async function openaiFetch(s: AiSettings, path: string, body?: unknown) {
  if (!s.openaiKey) throw new Error('Coloque a chave da API da OpenAI em Configurações → IA.')
  const r = await fetch(`https://api.openai.com/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${s.openaiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${j?.error?.message ?? 'erro'}`.slice(0, 300))
  return j
}

async function textOpenAI(s: AiSettings, job: TextJob) {
  const j = await openaiFetch(s, 'chat/completions', {
    model: s.openaiTextModel || DEFAULT_MODELS.openaiText,
    messages: [
      { role: 'system', content: 'Você ajuda a escrever roteiros de vídeo para YouTube, em português do Brasil.' },
      { role: 'user', content: `${job.instruction}\n\nSe precisar de dados atuais ou números exatos, pesquise na web. Responda só com o resultado, sem comentários antes ou depois.\n\n---\n${job.input}` }
    ]
  })
  chargeOpenAI(String(j?.model ?? ''), j?.usage)
  return String(j?.choices?.[0]?.message?.content ?? '').trim()
}

async function imageOpenAI(s: AiSettings, prompt: string, aspect: string) {
  const size = aspect === '9:16' || aspect === '4:5' ? '1024x1536' : aspect === '1:1' ? '1024x1024' : '1536x1024'
  const model = s.openaiImageModel || DEFAULT_MODELS.openaiImage
  const j = await openaiFetch(s, 'images/generations', { model, prompt, size, n: 1 })
  chargeOpenAI(model, j?.usage)
  const b64 = j?.data?.[0]?.b64_json
  if (!b64) throw new Error('A OpenAI não devolveu imagem.')
  return Buffer.from(b64, 'base64')
}

const ASPECT_WORDS: Record<string, string> = {
  '16:9': 'horizontal 16:9 (paisagem)',
  '9:16': 'vertical 9:16 (retrato, tela de celular)',
  '4:5': 'vertical 4:5',
  '1:1': 'quadrada 1:1'
}

/** novas imagens .png/.webp/.jpg nessa pasta (e subpastas) desde t0, a mais nova primeiro */
async function newImagesSince(dir: string, t0: number): Promise<string[]> {
  const out: { p: string; t: number }[] = []
  const walk = async (d: string, depth: number) => {
    if (depth > 4) return
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[])) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p, depth + 1)
      else if (/\.(png|webp|jpe?g)$/i.test(e.name)) {
        const st = await fs.stat(p).catch(() => null)
        if (st && st.mtimeMs >= t0 - 2000) out.push({ p, t: st.mtimeMs })
      }
    }
  }
  await walk(dir, 0)
  return out.sort((a, b) => b.t - a.t).map((x) => x.p)
}

/** Codex gera com a ferramenta image_gen dele (no plano do ChatGPT) e a gente pega o arquivo */
async function imageCodex(s: AiSettings, prompt: string, aspect: string) {
  const work = join(app.getPath('userData'), 'codex-image', randomUUID().slice(0, 8))
  await fs.mkdir(work, { recursive: true })
  const t0 = Date.now()
  try {
    const ask = [
      'Use a sua ferramenta embutida de gerar imagem (image_gen) para criar UMA imagem, sem perguntar nada.',
      `Formato: ${ASPECT_WORDS[aspect] ?? aspect}.`,
      'Depois copie o arquivo gerado para esta pasta com o nome imagem.png e responda só "ok".',
      '',
      'Descrição da imagem:',
      prompt
    ].join('\n')
    const r = await codexExec(s, ask, { cwd: work, sandbox: 'workspace-write', extra: ['--json', '--enable', 'image_generation'], timeoutMs: 10 * 60000 })
    // 1) a cópia que ele fez aqui; 2) o caminho que o evento da imagem traz; 3) a mais nova em generated_images
    const candidates = await newImagesSince(work, t0)
    for (const m of r.out.matchAll(/"saved_path"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
      try {
        candidates.push(JSON.parse(m[1]))
      } catch {
        /* ignora */
      }
    }
    const codexHome = process.env.CODEX_HOME || join(app.getPath('home'), '.codex')
    candidates.push(...(await newImagesSince(join(codexHome, 'generated_images'), t0)))
    const file = candidates.find((p) => existsSync(p))
    if (!file) throw new Error('O Codex não devolveu imagem. Veja se o seu plano do ChatGPT inclui geração de imagem e tente de novo.')
    return await fs.readFile(file)
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => null)
  }
}

// ---------- status / teste ----------
async function status() {
  const s = (await loadSettings()).ai ?? {}
  const [cc, cx] = await Promise.all([findClaudeCode(s), findCodex(s)])
  return {
    providers: [
      {
        id: 'claude-code' as const,
        label: 'Claude Code (este PC)',
        caps: CAPS['claude-code'],
        configured: !!cc,
        detail: cc ? `${cc.source}: ${cc.path}` : 'não encontrado: instale e faça login'
      },
      {
        id: 'codex' as const,
        label: 'Codex do ChatGPT (este PC)',
        caps: CAPS.codex,
        configured: !!cx,
        detail: cx ? `${cx.source}: ${cx.path}${s.codexModel ? ` · modelo ${s.codexModel}` : ''}` : 'não encontrado: instale e faça login'
      },
      {
        id: 'anthropic' as const,
        label: 'Claude (API da Anthropic)',
        caps: CAPS.anthropic,
        configured: !!s.anthropicKey,
        detail: s.anthropicKey ? `chave salva · modelo ${s.anthropicModel || DEFAULT_MODELS.anthropic}` : 'sem chave'
      },
      {
        id: 'openai' as const,
        label: 'ChatGPT (API da OpenAI)',
        caps: CAPS.openai,
        configured: !!s.openaiKey,
        detail: s.openaiKey
          ? `chave salva · texto ${s.openaiTextModel || DEFAULT_MODELS.openaiText} · imagem ${s.openaiImageModel || DEFAULT_MODELS.openaiImage}`
          : 'sem chave'
      }
    ],
    routes: { text: s.routeText ?? null, image: s.routeImage ?? null },
    models: {
      anthropicModel: s.anthropicModel || DEFAULT_MODELS.anthropic,
      openaiTextModel: s.openaiTextModel || DEFAULT_MODELS.openaiText,
      openaiImageModel: s.openaiImageModel || DEFAULT_MODELS.openaiImage,
      claudeCodePath: s.claudeCodePath ?? '',
      codexPath: s.codexPath ?? '',
      codexModel: s.codexModel ?? ''
    }
  }
}

async function test(id: ProviderId): Promise<{ ok: boolean; message: string }> {
  const s = (await loadSettings()).ai ?? {}
  try {
    if (id === 'claude-code') {
      const cc = await findClaudeCode(s)
      if (!cc) return { ok: false, message: 'Claude Code não encontrado. Instale (veja as instruções) e abra o Typos de novo.' }
      const v = await run(cc.path, ['--version'], { timeoutMs: 20000 })
      const reply = await textClaudeCode(s, { instruction: 'Responda exatamente: OK', input: 'teste de conexão do Typos' })
      return { ok: /ok/i.test(reply), message: `Funcionando · ${v.out.trim() || 'Claude Code'} · respondeu "${reply.slice(0, 40)}"` }
    }
    if (id === 'codex') {
      const cx = await findCodex(s)
      if (!cx) return { ok: false, message: 'Codex não encontrado. Instale (veja as instruções) e abra o Typos de novo.' }
      const v = await run(cx.path, ['--version'], { timeoutMs: 20000 })
      const reply = await textCodex(s, { instruction: 'Responda exatamente: OK', input: 'teste de conexão do Typos' })
      return { ok: /ok/i.test(reply), message: `Funcionando · ${v.out.trim() || 'Codex'} · respondeu "${reply.slice(0, 40)}"` }
    }
    if (id === 'anthropic') {
      const reply = await textAnthropic(s, { instruction: 'Responda exatamente: OK', input: 'teste de conexão do Typos' })
      return { ok: true, message: `Funcionando · respondeu "${reply.slice(0, 40)}"` }
    }
    await openaiFetch(s, 'models')
    return { ok: true, message: 'Chave aceita pela OpenAI.' }
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e) }
  }
}

async function routeFor(task: Task): Promise<ProviderId> {
  const s = (await loadSettings()).ai ?? {}
  const chosen = task === 'text' ? s.routeText : s.routeImage
  if (chosen) return chosen
  throw new Error(
    task === 'image'
      ? 'Nenhuma IA escolhida pra gerar imagem. Em Configurações → IA, escolha uma conexão que gera imagem (Codex ou OpenAI).'
      : 'Nenhuma IA escolhida pra texto. Em Configurações → IA, escolha uma conexão.'
  )
}

function textBy(provider: ProviderId, s: AiSettings, job: TextJob) {
  if (provider === 'claude-code') return textClaudeCode(s, job)
  if (provider === 'codex') return textCodex(s, job)
  if (provider === 'anthropic') return textAnthropic(s, job)
  return textOpenAI(s, job)
}

export function initAi() {
  initAiMeter()
  ipcMain.handle('ai:status', () => status())

  ipcMain.handle('ai:set', async (_e, patch: Partial<AiSettings>) => {
    const cur = (await loadSettings()).ai ?? {}
    const next: AiSettings = { ...cur }
    for (const k of ['anthropicKey', 'openaiKey'] as const)
      if (typeof patch[k] === 'string') next[k] = patch[k]!.trim() || undefined
    for (const k of ['anthropicModel', 'openaiTextModel', 'openaiImageModel', 'claudeCodePath', 'codexPath', 'codexModel'] as const)
      if (typeof patch[k] === 'string') next[k] = patch[k]!.trim() || undefined
    if (patch.routeText !== undefined) next.routeText = patch.routeText || undefined
    if (patch.routeImage !== undefined) next.routeImage = patch.routeImage || undefined
    await saveSettings({ ai: next })
  })

  ipcMain.handle('ai:test', (_e, id: ProviderId) => test(id))

  ipcMain.handle('ai:text', async (_e, job: TextJob) => {
    try {
      const provider = await routeFor('text')
      const s = (await loadSettings()).ai ?? {}
      const text = await metered(provider, job.dir, () => textBy(provider, s, job))
      return { text, provider }
    } catch (e: any) {
      return { error: String(e?.message ?? e) }
    }
  })

  /** gera imagem e salva em <roteiro>/assets; devolve o anexo pronto */
  ipcMain.handle('ai:image', async (_e, dir: string, prompt: string, aspect: string) => {
    try {
      const provider = await routeFor('image')
      if (!CAPS[provider].includes('image')) throw new Error('A conexão escolhida não gera imagem.')
      const s = (await loadSettings()).ai ?? {}
      const bytes = await metered(provider, dir, () => (provider === 'codex' ? imageCodex(s, prompt, aspect) : imageOpenAI(s, prompt, aspect)))
      const name = `ia-${prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'imagem'}-${randomUUID().slice(0, 8)}.png`
      await fs.mkdir(join(dir, 'assets'), { recursive: true })
      await fs.writeFile(join(dir, 'assets', name), bytes)
      return { attachment: { id: randomUUID(), path: `assets/${name}`, name, kind: 'image' as const }, provider }
    } catch (e: any) {
      return { error: String(e?.message ?? e) }
    }
  })
}


// ---------- treino de estilo de motion (texto + imagens) ----------
export interface MotionTrainJob {
  /** pedido completo (o que analisar e como responder) */
  prompt: string
  /** imagens de referência (prints e quadros dos vídeos), caminhos absolutos */
  images: string[]
  /** quem pediu (ex.: o id do bloco): é o que o Cancelar para */
  id?: string
}

/** pedidos de motion em andamento (o Cancelar da prévia corta o do bloco) */
const motionRunning = new Map<string, AbortController>()

const mimeOf = (p: string) => (/\.png$/i.test(p) ? 'image/png' : /\.webp$/i.test(p) ? 'image/webp' : /\.gif$/i.test(p) ? 'image/gif' : 'image/jpeg')

async function motionClaudeCode(s: AiSettings, job: MotionTrainJob, signal?: AbortSignal) {
  const cc = await findClaudeCode(s)
  if (!cc) throw new Error('Claude Code não encontrado neste PC. Instale e faça login (Configurações → IA).')
  // as imagens vão pra uma pasta de trabalho; o Claude Code lê cada uma (ele enxerga imagem)
  const work = join(app.getPath('userData'), 'motion-train', randomUUID().slice(0, 8))
  await fs.mkdir(work, { recursive: true })
  const names: string[] = []
  for (const [i, p] of job.images.entries()) {
    const name = `ref-${String(i + 1).padStart(2, '0')}${p.match(/\.\w+$/)?.[0] ?? '.jpg'}`
    await fs.copyFile(p, join(work, name)).catch(() => null)
    names.push(name)
  }
  const prompt = `${job.prompt}\n\nAs imagens de referência estão nesta pasta: ${names.join(', ')}. Abra e olhe TODAS antes de responder.`
  try {
    // 30 min: com emenda (HTML do vizinho + quadros) o Claude Code passava dos 15 e era cortado
    const r = await run(cc.path, ['-p', '--output-format', 'json', '--allowedTools', 'Read,WebSearch,WebFetch'], { cwd: work, input: prompt, timeoutMs: 30 * 60000, signal })
    let parsed: any = null
    try {
      parsed = JSON.parse(r.out)
    } catch {
      /* erro abaixo */
    }
    if (parsed && !parsed.is_error && typeof parsed.result === 'string') return parsed.result.trim()
    if (signal?.aborted) throw new Error('Cancelado.')
    if (r.err.includes('(tempo esgotado)')) throw new Error('Claude Code: tempo esgotado (30 min sem resposta). Tente de novo; se repetir, encurte o bloco ou as instruções.')
    const why = (parsed?.result || r.err || r.out || '').toString().trim()
    throw new Error(`Claude Code: ${why.slice(0, 300) || 'falhou sem mensagem'}`)
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => null)
  }
}

async function motionCodex(s: AiSettings, job: MotionTrainJob, signal?: AbortSignal) {
  // mesma ideia do Claude Code: as imagens vão pra uma pasta de trabalho e entram anexadas no pedido
  const work = join(app.getPath('userData'), 'motion-train', randomUUID().slice(0, 8))
  await fs.mkdir(work, { recursive: true })
  const names: string[] = []
  for (const [i, p] of job.images.slice(0, 50).entries()) {
    const name = `ref-${String(i + 1).padStart(2, '0')}${p.match(/\.\w+$/)?.[0] ?? '.jpg'}`
    if (await fs.copyFile(p, join(work, name)).then(() => true, () => false)) names.push(name)
  }
  try {
    const r = await codexExec(s, `${job.prompt}\n\nNão mexa em nenhum arquivo. Responda só com o resultado.`, {
      cwd: work,
      sandbox: 'read-only',
      extra: ['--ephemeral', ...names.map((n) => `--image=${join(work, n)}`)],
      timeoutMs: 30 * 60000,
      signal
    })
    return r.text
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => null)
  }
}

async function motionAnthropic(s: AiSettings, job: MotionTrainJob, signal?: AbortSignal) {
  if (!s.anthropicKey) throw new Error('Coloque a chave da API da Anthropic em Configurações → IA.')
  const client = new Anthropic({ apiKey: s.anthropicKey })
  const imgs = await Promise.all(
    job.images.slice(0, 100).map(async (p) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: mimeOf(p) as 'image/jpeg', data: (await fs.readFile(p)).toString('base64') }
    }))
  )
  // em stream: um motion grande (com o HTML do bloco vizinho, imagens e 32k de saída) passa dos 10 min
  // que a API aceita numa resposta só, e aí dava "tempo esgotado"
  const res = await client.beta.messages
    .stream(
      {
        model: s.anthropicModel || DEFAULT_MODELS.anthropic,
        max_tokens: 32000,
        output_config: { effort: 'high' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [{ role: 'user', content: [...imgs, { type: 'text', text: job.prompt }] }]
      },
      { timeout: 30 * 60000, signal }
    )
    .finalMessage()
  chargeAnthropic(res.model, res.usage)
  if (res.stop_reason === 'refusal') throw new Error('O Claude recusou esse pedido.')
  return res.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim()
}

async function motionOpenAI(s: AiSettings, job: MotionTrainJob) {
  const imgs = await Promise.all(
    job.images.slice(0, 20).map(async (p) => ({ type: 'image_url', image_url: { url: `data:${mimeOf(p)};base64,${(await fs.readFile(p)).toString('base64')}` } }))
  )
  const j = await openaiFetch(s, 'chat/completions', {
    model: s.openaiTextModel || DEFAULT_MODELS.openaiText,
    messages: [{ role: 'user', content: [{ type: 'text', text: job.prompt }, ...imgs] }]
  })
  chargeOpenAI(String(j?.model ?? ''), j?.usage)
  return String(j?.choices?.[0]?.message?.content ?? '').trim()
}

export function initMotionAi() {
  ipcMain.handle('ai:motionTrain', async (_e, job: MotionTrainJob) => {
    const ac = new AbortController()
    const key = job.id ?? randomUUID()
    motionRunning.get(key)?.abort()
    motionRunning.set(key, ac)
    try {
      const provider = await routeFor('text')
      const s = (await loadSettings()).ai ?? {}
      const stopped = new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('Cancelado.')), { once: true }))
      const text = await Promise.race([
        metered(provider, undefined, () =>
          provider === 'claude-code'
            ? motionClaudeCode(s, job, ac.signal)
            : provider === 'codex'
              ? motionCodex(s, job, ac.signal)
              : provider === 'anthropic'
                ? motionAnthropic(s, job, ac.signal)
                : motionOpenAI(s, job)
        ),
        stopped
      ])
      return { text, provider }
    } catch (e: any) {
      return { error: ac.signal.aborted ? 'Cancelado.' : String(e?.message ?? e) }
    } finally {
      if (motionRunning.get(key) === ac) motionRunning.delete(key)
    }
  })
  /** Cancelar: para o pedido de motion desse id (sem id, todos) */
  ipcMain.handle('ai:motionCancel', (_e, id?: string) => {
    for (const [k, ac] of motionRunning) if (!id || k === id) ac.abort()
  })
}

// ---------- Claude procura bibliotecas de som (SFX) no PC ----------
const AUDIO_RE = /\.(wav|mp3|ogg|flac|aif|aiff|m4a)$/i
const HINT_RE = /mister ?horse|motion ?bro|sound ?effects?|sfx|sound ?fx|foley|audio ?pack|sons?\b/i
const SKIP_RE = /^(temp|cache|cep_cache|node_modules|\$recycle\.bin|windows|system32|winsxs)$/i

/** pistas rápidas: pastas com nome de biblioteca de som até 4 níveis nos lugares comuns */
async function sfxHints(): Promise<string[]> {
  const env = process.env
  const roots = [join(env.USERPROFILE ?? '', 'Documents'), join(env.USERPROFILE ?? '', 'Music'), env.APPDATA, env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, env.CommonProgramFiles].filter(Boolean) as string[]
  const out: string[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > 4 || out.length > 60) return
    let ents: import('fs').Dirent[] = []
    try {
      ents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (!e.isDirectory() || SKIP_RE.test(e.name)) continue
      const p = join(dir, e.name)
      if (HINT_RE.test(e.name)) out.push(p)
      else await walk(p, depth + 1)
    }
  }
  for (const r of roots) if (existsSync(r)) await walk(r, 0)
  return [...new Set(out)]
}

/** quantos áudios tem dentro (para de contar em 5000) */
async function countAudio(dir: string) {
  let n = 0
  const walk = async (d: string, depth: number) => {
    if (n >= 5000 || depth > 8) return
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[])) {
      if (e.isDirectory()) await walk(join(d, e.name), depth + 1)
      else if (AUDIO_RE.test(e.name)) n++
    }
  }
  await walk(dir, 0)
  return n
}

export function initSfxFinder() {
  ipcMain.handle('ai:findSfx', async () => {
    try {
      const s = (await loadSettings()).ai ?? {}
      const cc = await findClaudeCode(s)
      if (!cc) throw new Error('Pra procurar no PC o Typos usa o Claude Code (ele precisa olhar as pastas). Instale e faça login em Configurações → IA.')
      const hints = await sfxHints()
      const prompt = [
        'Você está dentro do Typos (editor de vídeo do usuário) e a tarefa é ACHAR BIBLIOTECAS DE EFEITOS SONOROS instaladas neste PC Windows.',
        'Principalmente as de programas como Mister Horse (Animation Composer / Premiere Composer, packs de som), Motion Bro e outros packs de SFX que o usuário tenha.',
        'Só leia e liste pastas (use as ferramentas de busca de arquivos); não mude nada.',
        'Pistas que o Typos já achou (podem ter falsos positivos; algumas guardam só configuração, não os sons):',
        ...hints.map((h) => '- ' + h),
        'Investigue essas pistas e onde mais esses programas costumam guardar os sons (ProgramData, Documents, AppData, a pasta de conteúdo/biblioteca configurada no programa, outros discos).',
        'Pra cada biblioteca, aponte a pasta que de fato contém os arquivos de áudio (.wav/.mp3/.ogg…), a mais alta que ainda seja só de sons.',
        'Responda SÓ com JSON entre as tags, assim:',
        '<libs>[{"path": "C:\\\\caminho\\\\da\\\\pasta", "name": "nome curto", "program": "Mister Horse / Motion Bro / outro", "why": "o que tem lá em poucas palavras"}]</libs>',
        'Se não achar nenhuma, devolva <libs>[]</libs>.'
      ].join('\n')
      const dirs = [...new Set([process.env.USERPROFILE, process.env.ProgramData, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.CommonProgramFiles, ...hints].filter(Boolean) as string[])]
      const args = ['-p', '--output-format', 'json', '--allowedTools', 'Glob,Grep,Read', ...dirs.flatMap((d) => ['--add-dir', d])]
      const r = await metered('claude-code', undefined, () => run(cc.path, args, { cwd: process.env.USERPROFILE, input: prompt, timeoutMs: 15 * 60000 }))
      let parsed: any = null
      try {
        parsed = JSON.parse(r.out)
      } catch {
        /* abaixo */
      }
      if (!parsed || parsed.is_error || typeof parsed.result !== 'string') throw new Error('Claude Code: ' + ((parsed?.result || r.err || r.out || '').toString().trim().slice(0, 300) || 'falhou sem mensagem'))
      const m = parsed.result.match(/<libs>([\s\S]*?)<\/libs>/)
      let list: { path: string; name: string; program: string; why: string }[] = []
      const raw = (m ? m[1] : parsed.result).trim()
      try {
        list = JSON.parse(raw)
      } catch {
        try {
          // caminho do Windows com barra simples (C:\pasta): dobra as barras e tenta de novo
          list = JSON.parse(raw.replace(/\\(?!["\\/bfnrtu])/g, '\\\\'))
        } catch {
          throw new Error('O Claude respondeu fora do formato. Tente de novo.')
        }
      }
      // confere de verdade: a pasta existe e tem áudio?
      const out = []
      for (const l of list) {
        if (!l?.path || !existsSync(l.path)) continue
        const files = await countAudio(l.path)
        if (files) out.push({ ...l, files })
      }
      return { libs: out, hints: hints.length }
    } catch (e: any) {
      return { error: String(e?.message ?? e) }
    }
  })
}
