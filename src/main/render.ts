import { ipcMain, type WebContents } from 'electron'
import { join, dirname, resolve as resolvePath, sep } from 'path'
import { promises as fs, existsSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { loadSettings } from './settings'
import { findFfmpeg, probe } from './media'
import { transcribe, type Word } from './whisper'
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

/** uma etapa do plano (vem do Workspace Render): arquivo de saída conhecido = progresso medível */
export interface RenderStepIn {
  id: string
  label: string
  /** relativo a render/ */
  file: string
  weight: number
  expect?: number
  /** tudo que define a etapa: mudou = refaz */
  key: string
  from?: number
  to?: number
}

export interface RenderJob {
  dir: string
  /** pedido completo (markdown) que o Typos montou */
  brief: string
  /** pastas que o Claude pode ler (mídia, bibliotecas de som, estilo…) */
  readDirs: string[]
  /** guia de estilo aprendido no workspace Estilo, se tiver */
  styleGuide?: string
  /** só as falas do roteiro: serve pra acertar nomes e termos da transcrição */
  script: string
  /** trechos de narração na timeline (o Typos transcreve antes de chamar o Claude) */
  narration: { path: string; in: number; out: number; start: number }[]
  lang: string
  steps: RenderStepIn[]
  /** joga fora o que já foi feito e começa do zero */
  fresh?: boolean
}

interface StepState {
  id: string
  label: string
  file: string
  weight: number
  expect?: number
  sig: string
  done: boolean
  from?: number
  to?: number
}

/** render/estado.json: o que já ficou pronto (sobrevive a token acabando, cancelar, fechar o app) */
interface RenderState {
  v: 1
  status: 'rodando' | 'interrompido' | 'pronto'
  reason?: string
  updated: number
  /** assinatura da narração já transcrita */
  transcript?: string
  steps: StepState[]
}

export interface RenderProgress {
  phase: 'transcrevendo' | 'claude'
  /** 0–1 */
  pct: number
  /** segundos que faltam (null = ainda calculando) */
  eta: number | null
  steps: { id: string; label: string; done: boolean }[]
  /** etapas reaproveitadas de uma rodada anterior */
  resumed: number
}

const STATE = 'estado.json'
/** fatia da barra que é a transcrição local */
const TW = 0.05
const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16)
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

let current: ChildProcess | null = null
let busy = false
let cancelled = false

async function readState(out: string): Promise<RenderState | null> {
  try {
    const j = JSON.parse(await fs.readFile(join(out, STATE), 'utf8'))
    return j?.v === 1 && Array.isArray(j.steps) ? j : null
  } catch {
    return null
  }
}
const writeState = (out: string, st: RenderState) => fs.writeFile(join(out, STATE), JSON.stringify({ ...st, updated: Date.now() }, null, 1), 'utf8').catch(() => {})

/** só mexe em arquivos dentro de render/ */
const insideDir = (dir: string, p: string) => resolvePath(p).startsWith(resolvePath(dir) + sep)

/**
 * Etapa pronta? O arquivo existe, parou de crescer (entre duas olhadas) e, se é mídia, tem a duração
 * esperada. Um .mp4 interrompido no meio não tem índice: o probe não acha duração e ele não conta.
 */
const sizes = new Map<string, number>()
async function finished(out: string, s: StepState, needStable: boolean) {
  const p = join(out, s.file)
  let size = 0
  try {
    size = (await fs.stat(p)).size
  } catch {
    sizes.delete(p)
    return false
  }
  const prev = sizes.get(p)
  sizes.set(p, size)
  if (!size || (needStable && prev !== size)) return false
  if (!s.expect || !/\.(mp4|mov|mkv|webm|m4a|aac|wav|mp3)$/i.test(s.file)) return true
  const info = await probe(p)
  return !('error' in info) && info.duration >= s.expect * 0.97 - 0.3
}

/** Transcreve a narração da timeline (Whisper local, com cache) e escreve render/transcricao.md com os tempos da timeline. */
async function writeTranscript(out: string, job: RenderJob, onPct: (p: number) => void): Promise<string | null> {
  const paths = [...new Set(job.narration.map((n) => n.path))]
  const words: { t: number; e: number; w: string }[] = []
  for (const [i, path] of paths.entries()) {
    const r = await transcribe(null, path, job.lang, (p) => onPct((i + p) / paths.length))
    if ('error' in r) return r.error
    for (const n of job.narration.filter((x) => x.path === path))
      for (const w of r.words as Word[])
        if (w.s >= n.in - 0.05 && w.s < n.out) words.push({ t: n.start + w.s - n.in, e: n.start + Math.min(w.e, n.out) - n.in, w: w.w })
  }
  words.sort((a, b) => a.t - b.t)
  // frases: quebra em pausa, ponto final ou a cada ~14 palavras
  const lines: string[] = []
  let cur: typeof words = []
  const flush = () => {
    if (cur.length) lines.push(`[${fmt(cur[0].t)} – ${fmt(cur[cur.length - 1].e)}] ${cur.map((w) => w.w).join(' ')}`)
    cur = []
  }
  for (const w of words) {
    if (cur.length && (w.t - cur[cur.length - 1].e > 0.6 || cur.length >= 14)) flush()
    cur.push(w)
    if (/[.!?…]$/.test(w.w)) flush()
  }
  flush()
  await fs.writeFile(
    join(out, 'transcricao.md'),
    [
      '# Transcrição da narração (o que foi DITO, nos tempos da timeline)',
      '',
      'Feita pelo Whisper aqui no PC. É a fonte da verdade do que foi falado, inclusive os improvisos.',
      'Nomes e termos podem sair errados: confira a grafia em script.md.',
      '',
      ...lines
    ].join('\n'),
    'utf8'
  )
  return null
}

function stepsSection(out: string, steps: StepState[]) {
  const line = (s: StepState) =>
    `- [${s.done ? 'x' : ' '}] ${s.id}${s.from !== undefined ? ` (${fmt(s.from)} → ${fmt(s.to ?? 0)})` : ''}: ${join(out, s.file)}${s.done ? ' (PRONTA: não refaça nem confira)' : ''}`
  return [
    '## Etapas (o Typos mede o progresso pelos arquivos: use exatamente estes nomes)',
    '- Uma etapa por vez, na ordem. Cada parte sai de UM comando ffmpeg que escreve direto no arquivo da parte (intermediários dela, como overlays, em partes/parte-NN/).',
    '- As partes são SÓ VÍDEO (sem faixa de áudio), todas com o mesmo codec, resolução, fps e pix_fmt yuv420p, pra juntar com o concat demuxer em -c copy.',
    '- Cada parte tem exatamente a duração do seu trecho (buraco sem vídeo vira fundo do estilo): parte mais curta conta como incompleta.',
    '- audio: mix de todas as faixas de áudio não mudas da timeline, do 0 até o fim, AAC 192k.',
    '- final: concat das partes (-c:v copy) + audio.m4a (-c:a copy).',
    '',
    ...steps.map(line),
    ''
  ].join('\n')
}

async function start(sender: WebContents, job: RenderJob) {
  const send = (ev: { kind: 'tool' | 'say' | 'info'; text: string }) => !sender.isDestroyed() && sender.send('render:progress', ev)
  const s = (await loadSettings()).ai ?? {}
  const cc = await findClaudeCode(s)
  if (!cc) throw new Error('Pra criar o vídeo o Typos usa o Claude Code (ele roda o ffmpeg aqui no PC). Instale e faça login em Configurações → IA.')
  const ff = await findFfmpeg()
  if (!ff) throw new Error('O ffmpeg não foi encontrado (Configurações → Mídia).')
  if (!job.steps.length) throw new Error('A timeline de montagem está vazia: é ela que diz como o vídeo é feito.')
  const out = join(job.dir, 'render')
  if (job.fresh) {
    await fs.rm(join(out, 'partes'), { recursive: true, force: true })
    await fs.rm(join(out, STATE), { force: true })
  }
  await fs.mkdir(join(out, 'partes'), { recursive: true })
  const t0 = Date.now()

  // ---------- o que já está pronto de uma rodada anterior ----------
  const old = await readState(out)
  const steps: StepState[] = []
  for (const x of job.steps) {
    const st: StepState = { id: x.id, label: x.label, file: x.file, weight: x.weight, expect: x.expect, sig: sha(x.key), done: false, from: x.from, to: x.to }
    const prev = old?.steps.find((p) => p.id === x.id)
    if (prev && prev.sig === st.sig && prev.file === st.file) st.done = await finished(out, st, false)
    // arquivo de um plano antigo (a timeline mudou): some, pra ninguém achar que está pronto
    else if (insideDir(out, join(out, x.file))) await fs.rm(join(out, x.file), { force: true })
    steps.push(st)
  }
  const resumed = steps.filter((x) => x.done).length
  const state: RenderState = { v: 1, status: 'rodando', updated: 0, transcript: old?.transcript, steps }
  await writeState(out, state)

  const totalW = steps.reduce((a, x) => a + x.weight, 0) || 1
  const doneW = () => steps.filter((x) => x.done).reduce((a, x) => a + x.weight, 0)
  const progress = (phase: RenderProgress['phase'], pct: number, eta: number | null) =>
    !sender.isDestroyed() &&
    sender.send('render:state', { phase, pct, eta, resumed, steps: steps.map((x) => ({ id: x.id, label: x.label, done: x.done })) } satisfies RenderProgress)
  if (resumed) send({ kind: 'info', text: `Retomando: ${resumed} de ${steps.length} etapas já estavam prontas.` })

  // ---------- 1) transcrição local da narração ----------
  const tsig = sha(JSON.stringify(job.narration) + '|' + job.lang)
  let transcriptNote = ''
  if (!job.narration.length) transcriptNote = 'Sem narração na timeline: não há transcrição.'
  else if (state.transcript !== tsig || !existsSync(join(out, 'transcricao.md'))) {
    send({ kind: 'info', text: 'Transcrevendo a narração da timeline (Whisper, aqui no PC)…' })
    progress('transcrevendo', 0, null)
    const err = await writeTranscript(out, job, (p) => progress('transcrevendo', TW * p, null))
    if (err) {
      transcriptNote = 'Não deu pra transcrever (' + err + '). Use o script e os tempos da timeline.'
      send({ kind: 'info', text: transcriptNote })
      await fs.rm(join(out, 'transcricao.md'), { force: true })
    } else state.transcript = tsig
    await writeState(out, state)
  }
  if (cancelled) {
    state.status = 'interrompido'
    state.reason = 'cancelado'
    await writeState(out, state)
    throw new Error('Cancelado.')
  }

  // ---------- 2) arquivos pro Claude ----------
  await fs.writeFile(join(out, 'pedido.md'), job.brief + '\n\n' + stepsSection(out, steps), 'utf8')
  if (job.script.trim()) await fs.writeFile(join(out, 'script.md'), '# Script (só as falas escritas, sem instruções)\n\n' + job.script, 'utf8')
  if (job.styleGuide) await fs.writeFile(join(out, 'estilo.md'), job.styleGuide, 'utf8')
  const pending = steps.filter((x) => !x.done)
  const prompt = [
    'Você está dentro do Typos (editor de roteiro e vídeo do usuário). Tarefa: CRIAR A PRÉVIA DO VÍDEO.',
    `Leia o pedido completo em ${join(out, 'pedido.md')}${job.styleGuide ? ` e o guia de estilo em ${join(out, 'estilo.md')}` : ''}.`,
    existsSync(join(out, 'transcricao.md')) ? `A narração já foi transcrita com os tempos da timeline em ${join(out, 'transcricao.md')}.` : transcriptNote,
    job.script.trim() ? `O texto escrito está em ${join(out, 'script.md')}: use SÓ pra acertar nomes e termos. O que vale é o que foi falado (improvisos inclusos).` : '',
    resumed
      ? `RETOMADA: ${resumed} de ${steps.length} etapas já estão prontas (marcadas [x] no pedido). Não leia, não confira e não refaça essas; comece por ${pending[0]?.id}.`
      : '',
    'Use o ffmpeg (já está no PATH; ffprobe também) pra montar o vídeo seguindo a timeline de edição e os blocos de instrução.',
    `Trabalhe só dentro de ${out} (arquivos temporários, legendas .ass, listas de concat, etc.). Nunca altere nem apague os arquivos originais de mídia.`,
    'É uma prévia: velocidade importa mais que perfeição. Planeje tudo antes de rodar e use poucos comandos ffmpeg grandes, não dezenas de pequenos.',
    'Pra ser rápido: corte trechos com -ss/-t ANTES do -i (busca no arquivo, sem decodificar desde o começo); reduza pra resolução da prévia logo no começo do filtro; use -preset ultrafast nos intermediários;',
    'siga as Etapas do pedido (os nomes dos arquivos são como o Typos mede o progresso e retoma se algo parar no meio). Não re-encode o vídeo final só pra mexer no áudio: use -c:v copy.',
    'Confira com ffprobe só os arquivos finais, não cada passo. No fim, responda com um resumo curto do que foi feito e o caminho do vídeo final.'
  ]
    .filter(Boolean)
    .join('\n')
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
  const env = {
    ...process.env,
    PATH: dirname(ff.ffmpeg) + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? ''),
    // o Bash do Claude Code mata qualquer comando depois de 2 min por padrão; um encode longo era morto e refeito
    BASH_DEFAULT_TIMEOUT_MS: process.env.BASH_DEFAULT_TIMEOUT_MS ?? String(20 * 60000),
    BASH_MAX_TIMEOUT_MS: process.env.BASH_MAX_TIMEOUT_MS ?? String(60 * 60000)
  }
  send({ kind: 'info', text: 'Claude Code iniciado. Pedido salvo em render/pedido.md.' })

  // ---------- 3) Claude Code + acompanhamento pelos arquivos ----------
  const tc = Date.now()
  const startW = doneW()
  let polling = false
  const poll = async (needStable: boolean) => {
    if (polling) return
    polling = true
    try {
      let changed = false
      for (const x of steps) if (!x.done && (await finished(out, x, needStable))) (x.done = true), (changed = true)
      if (changed) await writeState(out, state)
      const w = doneW()
      const ranW = w - startW
      const eta = ranW > 0 ? Math.round(((Date.now() - tc) / 1000 / ranW) * (totalW - w)) : null
      progress('claude', TW + (1 - TW) * (w / totalW), eta)
    } finally {
      polling = false
    }
  }
  await poll(false)
  return await new Promise<{ path?: string; summary: string; seconds: number }>((resolve, reject) => {
    const p = spawn(cc.path, args, { cwd: out, windowsHide: true, env })
    current = p
    const timer = setInterval(() => poll(true), 3000)
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
      clearInterval(timer)
      reject(e)
    })
    p.on('close', async (code) => {
      current = null
      clearInterval(timer)
      while (polling) await new Promise((r) => setTimeout(r, 100))
      await poll(false)
      const finalStep = steps[steps.length - 1]
      const left = steps.filter((x) => !x.done).length
      const keep = `${steps.length - left} de ${steps.length} etapas ficaram prontas: "Continuar" segue de onde parou.`
      const stop = async (reason: string) => {
        state.status = 'interrompido'
        state.reason = reason
        await writeState(out, state)
      }
      if (code === null || cancelled) {
        await stop('cancelado')
        return reject(new Error('Cancelado. ' + keep))
      }
      if (!final || final.is_error) {
        const msg = String(final?.result ?? err ?? '').trim()
        await stop(msg.slice(0, 300) || 'falhou')
        const limit = /limit|quota|credit|usage|rate|token/i.test(msg)
        return reject(new Error((limit ? 'O limite de uso do Claude acabou. ' : 'Claude Code: ' + (msg.slice(0, 300) || 'falhou sem mensagem') + ' · ') + keep))
      }
      if (finalStep.done) {
        state.status = 'pronto'
        delete state.reason
        await writeState(out, state)
        return resolve({ path: join(out, finalStep.file), summary: String(final.result ?? ''), seconds: Math.round((Date.now() - t0) / 1000) })
      }
      // o Claude achou que terminou mas o vídeo final não bate com o plano
      await stop('o vídeo final não ficou completo')
      const path = await newestVideo(out)
      const fresh = path && (await fs.stat(path)).mtimeMs >= t0
      resolve({ path: fresh ? path : undefined, summary: String(final.result ?? '') + `\n\n(${keep})`, seconds: Math.round((Date.now() - t0) / 1000) })
    })
    p.stdin.end(prompt)
  })
}

/** pra mostrar "Continuar" ao abrir o projeto: o que a última rodada deixou pronto */
async function status(dir: string) {
  const st = await readState(join(dir, 'render'))
  if (!st) return null
  const total = st.steps.reduce((a, x) => a + x.weight, 0) || 1
  const done = st.steps.filter((x) => x.done)
  return {
    status: st.status === 'rodando' && !busy ? 'interrompido' : st.status,
    reason: st.reason,
    done: done.length,
    total: st.steps.length,
    pct: TW + (1 - TW) * (done.reduce((a, x) => a + x.weight, 0) / total),
    updated: st.updated
  }
}

export function initRender() {
  ipcMain.handle('render:check', async (_e, paths: string[]) => Promise.all([...new Set(paths)].map(check)))
  ipcMain.handle('render:status', (_e, dir: string) => status(dir))
  ipcMain.handle('render:start', async (e, job: RenderJob) => {
    if (busy) return { error: 'Já tem um vídeo sendo criado.' }
    busy = true
    cancelled = false
    try {
      return await start(e.sender, job)
    } catch (err: any) {
      return { error: String(err?.message ?? err) }
    } finally {
      busy = false
    }
  })
  ipcMain.handle('render:cancel', () => {
    cancelled = true
    if (!current) return
    if (process.platform === 'win32' && current.pid) spawn('taskkill', ['/pid', String(current.pid), '/t', '/f'], { windowsHide: true })
    else current.kill()
  })
}
