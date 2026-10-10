import { app, ipcMain } from 'electron'
import { join } from 'path'
import { promises as fs, existsSync } from 'fs'
import { spawn, execFile } from 'child_process'
import { randomUUID } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { loadSettings, saveSettings, type AiSettings } from './settings'

/**
 * IA do Typos, sem depender de um fornecedor só. O app pede uma TAREFA ("texto" ou
 * "imagem"); qual conexão faz cada tarefa é escolha do usuário em Configurações.
 *
 *  - claude-code: o Claude Code instalado neste PC (usa o plano do usuário, sem chave)
 *  - anthropic:   API da Anthropic (chave própria, paga por uso)
 *  - openai:      API da OpenAI (chave própria; a única que gera imagem)
 *
 * Chaves ficam só no settings.json do userData e nunca voltam pro renderer.
 */

export type ProviderId = 'claude-code' | 'anthropic' | 'openai'
type Task = 'text' | 'image'

const CAPS: Record<ProviderId, Task[]> = {
  'claude-code': ['text'],
  anthropic: ['text'],
  openai: ['text', 'image']
}

const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5-5',
  openaiText: 'gpt-5',
  openaiImage: 'gpt-image-1'
}

// ---------- Claude Code: achar o executável ----------
function run(file: string, args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number } = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const p = spawn(file, args, { cwd: opts.cwd, windowsHide: true, env: process.env })
    let out = ''
    let err = ''
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

const whereClaude = () =>
  new Promise<string | null>((resolve) =>
    execFile('where', ['claude'], { windowsHide: true }, (e, out) => resolve(e ? null : out.split(/\r?\n/).find((l) => l.trim()) ?? null))
  )

/** Onde está o Claude Code: caminho escolhido > comando no PATH > instalador oficial. */
async function findClaudeCode(s: AiSettings): Promise<{ path: string; source: string } | null> {
  if (s.claudeCodePath && existsSync(s.claudeCodePath)) return { path: s.claudeCodePath, source: 'caminho escolhido' }
  const onPath = await whereClaude()
  if (onPath) return { path: onPath.trim(), source: 'comando claude' }
  const home = app.getPath('home')
  for (const p of [join(home, '.local', 'bin', 'claude.exe'), join(home, '.claude', 'local', 'claude.exe')])
    if (existsSync(p)) return { path: p, source: 'instalação oficial' }
  return null
}

// ---------- tarefas por fornecedor ----------
interface TextJob {
  /** instrução do que fazer (curta) */
  instruction: string
  /** material: a fala, o trecho do roteiro… */
  input: string
  /** pasta do roteiro (o Claude Code roda lá e pode ler roteiro.md e anexos) */
  dir?: string
}

async function textClaudeCode(s: AiSettings, job: TextJob) {
  const cc = await findClaudeCode(s)
  if (!cc) throw new Error('Claude Code não encontrado neste PC. Instale e faça login (Configurações → IA).')
  const prompt = `${job.instruction}\n\nSe precisar de dados atuais ou números exatos, pesquise na web. Responda só com o resultado, sem comentários antes ou depois.\n\n---\n${job.input}`
  // prompt vai pela entrada padrão (sem limite de tamanho da linha de comando do Windows)
  // no modo -p só roda ferramenta liberada aqui: busca na web sim, mexer em arquivo não
  const r = await run(cc.path, ['-p', '--output-format', 'json', '--allowedTools', 'WebSearch,WebFetch'], { cwd: job.dir, input: prompt, timeoutMs: 180000 })
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
  return String(j?.choices?.[0]?.message?.content ?? '').trim()
}

async function imageOpenAI(s: AiSettings, prompt: string, aspect: string) {
  const size = aspect === '9:16' || aspect === '4:5' ? '1024x1536' : aspect === '1:1' ? '1024x1024' : '1536x1024'
  const j = await openaiFetch(s, 'images/generations', { model: s.openaiImageModel || DEFAULT_MODELS.openaiImage, prompt, size, n: 1 })
  const b64 = j?.data?.[0]?.b64_json
  if (!b64) throw new Error('A OpenAI não devolveu imagem.')
  return Buffer.from(b64, 'base64')
}

// ---------- status / teste ----------
async function status() {
  const s = (await loadSettings()).ai ?? {}
  const cc = await findClaudeCode(s)
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
      claudeCodePath: s.claudeCodePath ?? ''
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
      ? 'Nenhuma IA escolhida pra gerar imagem. Em Configurações → IA, escolha uma conexão que gera imagem (ex.: OpenAI).'
      : 'Nenhuma IA escolhida pra texto. Em Configurações → IA, escolha uma conexão.'
  )
}

export function initAi() {
  ipcMain.handle('ai:status', () => status())

  ipcMain.handle('ai:set', async (_e, patch: Partial<AiSettings>) => {
    const cur = (await loadSettings()).ai ?? {}
    const next: AiSettings = { ...cur }
    for (const k of ['anthropicKey', 'openaiKey'] as const)
      if (typeof patch[k] === 'string') next[k] = patch[k]!.trim() || undefined
    for (const k of ['anthropicModel', 'openaiTextModel', 'openaiImageModel', 'claudeCodePath'] as const)
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
      const text =
        provider === 'claude-code' ? await textClaudeCode(s, job) : provider === 'anthropic' ? await textAnthropic(s, job) : await textOpenAI(s, job)
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
      const bytes = await imageOpenAI(s, prompt, aspect)
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
}

const mimeOf = (p: string) => (/\.png$/i.test(p) ? 'image/png' : /\.webp$/i.test(p) ? 'image/webp' : /\.gif$/i.test(p) ? 'image/gif' : 'image/jpeg')

async function motionClaudeCode(s: AiSettings, job: MotionTrainJob) {
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
    const r = await run(cc.path, ['-p', '--output-format', 'json', '--allowedTools', 'Read,WebSearch,WebFetch'], { cwd: work, input: prompt, timeoutMs: 15 * 60000 })
    let parsed: any = null
    try {
      parsed = JSON.parse(r.out)
    } catch {
      /* erro abaixo */
    }
    if (parsed && !parsed.is_error && typeof parsed.result === 'string') return parsed.result.trim()
    const why = (parsed?.result || r.err || r.out || '').toString().trim()
    throw new Error(`Claude Code: ${why.slice(0, 300) || 'falhou sem mensagem'}`)
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => null)
  }
}

async function motionAnthropic(s: AiSettings, job: MotionTrainJob) {
  if (!s.anthropicKey) throw new Error('Coloque a chave da API da Anthropic em Configurações → IA.')
  const client = new Anthropic({ apiKey: s.anthropicKey })
  const imgs = await Promise.all(
    job.images.slice(0, 40).map(async (p) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: mimeOf(p) as 'image/jpeg', data: (await fs.readFile(p)).toString('base64') }
    }))
  )
  const res = await client.beta.messages.create({
    model: s.anthropicModel || DEFAULT_MODELS.anthropic,
    max_tokens: 32000,
    output_config: { effort: 'high' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: [...imgs, { type: 'text', text: job.prompt }] }]
  })
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
  return String(j?.choices?.[0]?.message?.content ?? '').trim()
}

export function initMotionAi() {
  ipcMain.handle('ai:motionTrain', async (_e, job: MotionTrainJob) => {
    try {
      const provider = await routeFor('text')
      const s = (await loadSettings()).ai ?? {}
      const text =
        provider === 'claude-code' ? await motionClaudeCode(s, job) : provider === 'anthropic' ? await motionAnthropic(s, job) : await motionOpenAI(s, job)
      return { text, provider }
    } catch (e: any) {
      return { error: String(e?.message ?? e) }
    }
  })
}
