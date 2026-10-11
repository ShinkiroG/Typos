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
interface RunOpts {
  cwd?: string
  input?: string
  /** limite total */
  timeoutMs?: number
  /** limite sem nenhuma saída nova (só com stream-json, que fala o tempo todo) */
  idleMs?: number
  onLine?: (line: string) => void
}

/** mata o processo e os filhos (no Windows o p.kill() deixa o node do claude.cmd vivo) */
function killTree(pid?: number) {
  if (!pid) return
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  else
    try {
      process.kill(pid)
    } catch {
      /* já saiu */
    }
}

function run(file: string, args: string[], opts: RunOpts = {}) {
  return new Promise<{ code: number | null; out: string; err: string; timedOut?: 'idle' | 'total' }>((resolve) => {
    const p = spawn(file, args, { cwd: opts.cwd, windowsHide: true, env: process.env })
    let out = ''
    let err = ''
    let partial = ''
    let timedOut: 'idle' | 'total' | undefined
    const stop = (why: 'idle' | 'total') => {
      if (timedOut) return
      timedOut = why
      killTree(p.pid)
    }
    const total = setTimeout(() => stop('total'), opts.timeoutMs ?? 120000)
    let idle: NodeJS.Timeout | undefined
    const bump = () => {
      if (!opts.idleMs) return
      clearTimeout(idle)
      idle = setTimeout(() => stop('idle'), opts.idleMs)
    }
    bump()
    const clear = () => (clearTimeout(total), clearTimeout(idle))
    p.stdout.on('data', (d) => {
      out += d
      bump()
      if (!opts.onLine) return
      partial += d
      const lines = partial.split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) opts.onLine(l)
    })
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => {
      clear()
      resolve({ code: -1, out, err: String(e), timedOut })
    })
    p.on('close', (code) => {
      clear()
      if (opts.onLine && partial.trim()) opts.onLine(partial)
      resolve({ code, out, err, timedOut })
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
export async function findClaudeCode(s: AiSettings): Promise<{ path: string; source: string } | null> {
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

export type AiProgress = { stage: 'start' | 'thinking' | 'searching' | 'writing'; chars: number; seconds: number }

/** limite total do Claude Code em minutos (Configurações → IA); padrão 20 */
const ccMaxMs = (s: AiSettings) => Math.min(Math.max(Number(s.claudeCodeMaxMin) || 20, 1), 120) * 60000
/** sem nenhum sinal de vida por esse tempo = travou */
const CC_IDLE_MS = 4 * 60000

async function textClaudeCode(s: AiSettings, job: TextJob, onProgress?: (p: AiProgress) => void) {
  const cc = await findClaudeCode(s)
  if (!cc) throw new Error('Claude Code não encontrado neste PC. Instale e faça login (Configurações → IA).')
  const prompt = `${job.instruction}\n\nSe precisar de dados atuais ou números exatos, pesquise na web. Responda só com o resultado, sem comentários antes ou depois.\n\n---\n${job.input}`
  // prompt vai pela entrada padrão (sem limite de tamanho da linha de comando do Windows)
  // no modo -p só roda ferramenta liberada aqui: busca na web sim, mexer em arquivo não
  // stream-json: o Claude Code avisa cada pedaço que escreve, então dá pra mostrar progresso
  // e só desistir quando ele para de dar sinal de vida (pedido sobre o roteiro todo demora)
  const t0 = Date.now()
  let chars = 0
  let last = 0
  let result: any = null
  const tell = (stage: AiProgress['stage'], force = false) => {
    if (!onProgress || (!force && Date.now() - last < 400)) return
    last = Date.now()
    onProgress({ stage, chars, seconds: Math.round((Date.now() - t0) / 1000) })
  }
  tell('start', true)
  const maxMs = ccMaxMs(s)
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--allowedTools', 'WebSearch,WebFetch']
  const r = await run(cc.path, args, {
    cwd: job.dir,
    input: prompt,
    timeoutMs: maxMs,
    idleMs: CC_IDLE_MS,
    onLine: (line) => {
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.type === 'result') result = ev
      else if (ev.type === 'stream_event') {
        const e = ev.event
        if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') tell('searching', true)
        else if (e?.delta?.type === 'text_delta') {
          chars += e.delta.text?.length ?? 0
          tell('writing')
        } else if (e?.delta?.type === 'thinking_delta') tell('thinking')
      }
    }
  })
  if (result && !result.is_error && typeof result.result === 'string') return result.result.trim()
  if (r.timedOut) {
    const min = Math.round((Date.now() - t0) / 60000)
    throw new Error(
      r.timedOut === 'idle'
        ? `O Claude Code ficou ${CC_IDLE_MS / 60000} min sem dar sinal de vida e foi interrompido (${chars ? `tinha escrito ${chars} caracteres` : 'não chegou a escrever nada'}). Tente de novo; se repetir, rode "claude" num terminal pra ver se ele pede login ou atualização.`
        : `O Claude Code passou do limite de ${maxMs / 60000} min (${min} min, ${chars} caracteres escritos) e foi interrompido. Peça uma parte do roteiro por vez ou aumente o limite em Configurações → IA.`
    )
  }
  const why = (result?.result || r.err || r.out.slice(-300) || '').toString().trim()
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
      claudeCodePath: s.claudeCodePath ?? '',
      claudeCodeMaxMin: String(ccMaxMs(s) / 60000)
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
    for (const k of ['anthropicModel', 'openaiTextModel', 'openaiImageModel', 'claudeCodePath', 'claudeCodeMaxMin'] as const)
      if (typeof patch[k] === 'string') next[k] = patch[k]!.trim() || undefined
    if (patch.routeText !== undefined) next.routeText = patch.routeText || undefined
    if (patch.routeImage !== undefined) next.routeImage = patch.routeImage || undefined
    await saveSettings({ ai: next })
  })

  ipcMain.handle('ai:test', (_e, id: ProviderId) => test(id))

  ipcMain.handle('ai:text', async (e, job: TextJob) => {
    try {
      const provider = await routeFor('text')
      const s = (await loadSettings()).ai ?? {}
      const progress = (p: AiProgress) => !e.sender.isDestroyed() && e.sender.send('ai:progress', p)
      const text =
        provider === 'claude-code' ? await textClaudeCode(s, job, progress) : provider === 'anthropic' ? await textAnthropic(s, job) : await textOpenAI(s, job)
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
      const r = await run(cc.path, args, { cwd: process.env.USERPROFILE, input: prompt, timeoutMs: 15 * 60000 })
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
