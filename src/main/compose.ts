/**
 * Render local: monta os comandos do ffmpeg que compilam um trecho da timeline (camadas de vídeo
 * com fades e crossfades, mix das faixas de áudio com o mesmo envelope da Montagem) e o vídeo final.
 * Sem Electron aqui: só texto, pra dar pra testar com o ffmpeg puro.
 */

/**
 * Versão da codificação: entra na assinatura das partes e dos letterings do render, pra que um ajuste
 * aqui grave tudo de novo em vez de reaproveitar arquivos feitos com o ajuste antigo.
 */
export const ENCODE_V = 2

/**
 * H.264 de entrega. Fundo em gradiente escuro com grão (o que o motion mais faz) é o pior caso do
 * x264: no "veryfast" com CRF 18–20 ele joga o grão fora e o gradiente vira blocos e degraus.
 * - `grain`: animação feita no Typos (motion, lettering): guarda o grão, que é o que esconde os degraus.
 * - `master`: partes do render (gravam de novo o que já veio comprimido): CRF menor e AQ que protege
 *   as áreas escuras e lisas.
 * As cores saem em BT.709 (o padrão de vídeo HD), marcadas no arquivo.
 */
export function x264Args(kind: 'grain' | 'master'): string[] {
  const q = kind === 'grain' ? ['-preset', 'slow', '-crf', '12', '-tune', 'grain'] : ['-preset', 'medium', '-crf', '14', '-x264-params', 'aq-mode=3']
  return ['-c:v', 'libx264', ...q, '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']
}

/** RGB (quadros PNG do navegador) → YUV 4:2:0 em BT.709, com arredondamento preciso (sem degrau extra) */
export const RGB_TO_YUV = 'flags=bicubic+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv'

/** camada de vídeo (clipe, imagem ou lettering): tempos na timeline, já com os crossfades */
export interface VLayer {
  path: string
  image: boolean
  t0: number
  t1: number
  /** segundo do arquivo que toca em t0 */
  src0: number
  /** fades de opacidade (s) a partir das bordas da camada */
  fadeIn: number
  fadeOut: number
}

/** trecho de áudio: tempos na timeline e o envelope de volume (s desde t0, ganho linear) */
export interface ALayer {
  path: string
  /** limpeza de ruído: o render troca o path pela cópia limpa antes de montar o comando */
  denoise?: 1 | 2 | 3
  t0: number
  t1: number
  src0: number
  env: [number, number][]
}

export interface PartSpec {
  from: number
  to: number
  width: number
  height: number
  fps: number
  /** de baixo pra cima */
  video: VLayer[]
  audio: ALayer[]
  /** contain = cabe inteiro (com barras); cover = preenche o quadro e corta as sobras (recortes verticais) */
  fit?: 'contain' | 'cover'
  outVideo: string
  outWav: string
}

export const RATE = 48000
const n = (x: number, d = 4) => String(Math.round(x * 10 ** d) / 10 ** d)

export const partFrames = (p: { from: number; to: number; fps: number }) => Math.max(1, Math.round(p.to * p.fps) - Math.round(p.from * p.fps))
export const partSamples = (p: { from: number; to: number }) => Math.max(1, Math.round(p.to * RATE) - Math.round(p.from * RATE))

/** valor do envelope (rampas lineares entre os pontos) */
function envValue(env: [number, number][], t: number) {
  if (!env.length) return 1
  if (t <= env[0][0]) return env[0][1]
  for (let i = 1; i < env.length; i++) {
    const [t1, g1] = env[i]
    if (t <= t1) {
      const [t0, g0] = env[i - 1]
      return t1 > t0 ? g0 + ((g1 - g0) * (t - t0)) / (t1 - t0) : g1
    }
  }
  return env[env.length - 1][1]
}

/** recorta o envelope na janela [a, a+len] (tempos passam a contar de a) e tira pontos que não mudam nada */
export function sliceEnv(env: [number, number][], a: number, len: number): [number, number][] {
  const pts: [number, number][] = [[0, envValue(env, a)]]
  for (const [t, g] of env) if (t > a && t < a + len) pts.push([t - a, g])
  pts.push([len, envValue(env, a + len)])
  return pts.filter((p, i, all) => {
    if (i === 0 || i === all.length - 1) return true
    const [t0, g0] = all[i - 1]
    const [t2, g2] = all[i + 1]
    const lerp = t2 > t0 ? g0 + ((g2 - g0) * (p[0] - t0)) / (t2 - t0) : g2
    return Math.abs(lerp - p[1]) > 1e-4
  })
}

/** filtro volume do envelope: constante = volume fixo; senão rampas por expressão (quadros curtos, sem degrau audível) */
export function volumeFilter(env: [number, number][]) {
  const gs = env.map((p) => p[1])
  if (Math.max(...gs) - Math.min(...gs) < 1e-4) return `volume=${n(gs[0], 5)}`
  let expr = n(gs[gs.length - 1], 5)
  for (let i = env.length - 2; i >= 0; i--) {
    const [t0, g0] = env[i]
    const [t1, g1] = env[i + 1]
    const seg = t1 > t0 ? `${n(g0, 5)}+(${n(g1 - g0, 5)})*(t-${n(t0, 5)})/${n(t1 - t0, 5)}` : n(g1, 5)
    expr = `if(lt(t\\,${n(t1, 5)})\\,${seg}\\,${expr})`
  }
  return `asetnsamples=n=128:p=0,volume=${expr}:eval=frame`
}

/**
 * Um trecho da timeline → parte-NN.mp4 (só vídeo, H.264) + parte-NN.wav (mix em float, sem limitar:
 * o limitador roda uma vez só, no vídeo final, pra não ter emenda entre as partes).
 */
export function partArgs(p: PartSpec): string[] {
  const { width: W, height: H, fps } = p
  const frames = partFrames(p)
  const samples = partSamples(p)
  const args = ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats']
  args.push('-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${n(frames / fps + 1, 3)}`)
  args.push('-f', 'lavfi', '-t', n(samples / RATE + 0.5, 3), '-i', `anullsrc=r=${RATE}:cl=stereo`)
  const fil: string[] = []
  let k = 2
  let last = '0:v'
  p.video.forEach((v, i) => {
    const vis0 = Math.max(v.t0, p.from)
    const vis1 = Math.min(v.t1, p.to)
    if (vis1 - vis0 < 0.5 / fps) return
    // começa a ler antes da janela só o necessário pra um fade que já estava no meio
    let d0 = vis0
    if (v.fadeIn > 0 && vis0 < v.t0 + v.fadeIn) d0 = v.t0
    if (v.fadeOut > 0 && d0 > v.t1 - v.fadeOut) d0 = Math.max(v.t0, v.t1 - v.fadeOut)
    const len = vis1 - d0
    if (v.image) args.push('-loop', '1', '-framerate', String(fps), '-t', n(len + 1 / fps, 3), '-i', v.path)
    else args.push('-ss', n(Math.max(0, v.src0 + d0 - v.t0)), '-t', n(len + 1 / fps), '-i', v.path)
    const f = [
      'setpts=PTS-STARTPTS',
      `fps=${fps}`,
      ...(p.fit === 'cover'
        ? [`scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic`, `crop=${W}:${H}`]
        : [`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic`]),
      'setsar=1',
      'format=yuva420p',
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`
    ]
    if (v.fadeIn > 0 && d0 === v.t0) f.push(`fade=t=in:st=0:d=${n(v.fadeIn)}:alpha=1`)
    if (v.fadeOut > 0) f.push(`fade=t=out:st=${n(v.t1 - v.fadeOut - d0)}:d=${n(v.fadeOut)}:alpha=1`)
    f.push(`trim=start=${n(vis0 - d0)}:duration=${n(vis1 - vis0)}`, `setpts=PTS-STARTPTS+${n(vis0 - p.from)}/TB`)
    fil.push(`[${k}:v]${f.join(',')}[l${i}]`)
    fil.push(`[${last}][l${i}]overlay=eof_action=pass:format=auto[o${i}]`)
    last = `o${i}`
    k++
  })
  fil.push(`[${last}]format=yuv420p[vout]`)

  const mix: string[] = ['[1:a]']
  p.audio.forEach((a, i) => {
    const a0 = Math.max(a.t0, p.from)
    const a1 = Math.min(a.t1, p.to)
    if (a1 - a0 < 0.002) return
    args.push('-ss', n(Math.max(0, a.src0 + a0 - a.t0), 6), '-t', n(a1 - a0, 6), '-i', a.path)
    const env = sliceEnv(a.env, a0 - a.t0, a1 - a0)
    const delay = Math.max(0, Math.round(a0 * RATE) - Math.round(p.from * RATE))
    fil.push(
      `[${k}:a]aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,${volumeFilter(env)},adelay=delays=${delay}S:all=1[s${i}]`
    )
    mix.push(`[s${i}]`)
    k++
  })
  fil.push(
    mix.length > 1
      ? `${mix.join('')}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${samples}[aout]`
      : `[1:a]atrim=end_sample=${samples}[aout]`
  )

  args.push('-filter_complex', fil.join(';'))
  args.push('-map', '[vout]', '-frames:v', String(frames), ...x264Args('master'), '-r', String(fps), '-an', p.outVideo)
  args.push('-map', '[aout]', '-c:a', 'pcm_f32le', '-ar', String(RATE), '-ac', '2', p.outWav)
  return args
}

/** lista do concat demuxer (nomes relativos à pasta da lista) */
export const concatList = (names: string[]) => names.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n'

/** junta as partes: vídeo copiado (sem recomprimir), áudio com limitador (igual ao da Montagem) em AAC */
export function finalArgs(videoList: string, audioList: string, out: string, limiter = true): string[] {
  return [
    '-hide_banner',
    '-y',
    '-nostdin',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    videoList,
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    audioList,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'copy',
    ...(limiter ? ['-af', 'alimiter=limit=0.84:attack=5:release=120:level=0'] : []),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    '-movflags',
    '+faststart',
    out
  ]
}
