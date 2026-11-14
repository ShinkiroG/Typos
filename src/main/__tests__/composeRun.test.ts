import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { concatList, finalArgs, partArgs, seekArgs, x264Args, type PartSpec } from '../compose'

/**
 * O render de verdade: os comandos do compose.ts rodando no ffmpeg (sem ele, como num PC sem ffmpeg, é pulado).
 * Material sintético: dois vídeos de teste e um tom.
 */
const which = spawnSync('which', ['ffmpeg']).stdout?.toString().trim()
const probe = (file: string, entries: string) =>
  execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'default=nw=1:nk=1', file]).toString().trim().split(/\s+/)

describe.skipIf(!which)('render (ffmpeg de verdade)', () => {
  let dir = ''
  const f = (n: string) => join(dir, n)
  const fast = [...x264Args('master').map((a) => (a === 'medium' ? 'ultrafast' : a))]
  const spec = (over: Partial<PartSpec>): PartSpec => ({
    from: 0,
    to: 2,
    width: 320,
    height: 180,
    fps: 30,
    video: [
      { path: f('a.mp4'), image: false, t0: 0, t1: 2, src0: 0.5, fadeIn: 0, fadeOut: 0 },
      { path: f('b.mp4'), image: false, t0: 1, t1: 2, src0: 0, fadeIn: 0.4, fadeOut: 0 }
    ],
    audio: [{ path: f('tom.wav'), t0: 0, t1: 2, src0: 0, env: [[0, 1], [2, 0.5]] }],
    outVideo: f('parte-01.mp4'),
    outWav: f('parte-01.wav'),
    ...over
  })

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'typos-render-'))
    const gen = (src: string, out: string) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', out])
    gen('testsrc=s=640x360:r=30:d=4', f('a.mp4'))
    gen('testsrc2=s=320x180:r=25:d=3', f('b.mp4'))
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=4', f('tom.wav')])
  }, 60000)
  afterAll(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('uma parte com duas camadas e fade sai com os quadros e o tamanho pedidos', () => {
    execFileSync('ffmpeg', partArgs(spec({}), fast), { stdio: 'ignore' })
    const [w, h, frames] = probe(f('parte-01.mp4'), 'stream=width,height,nb_read_frames')
    expect([w, h, frames]).toEqual(['320', '180', '60'])
  }, 60000)

  it('as partes juntam num vídeo com som, sem recomprimir o vídeo', () => {
    execFileSync('ffmpeg', partArgs(spec({}), fast), { stdio: 'ignore' })
    execFileSync('ffmpeg', partArgs(spec({ from: 2, to: 3.5, video: [{ path: f('a.mp4'), image: false, t0: 0, t1: 4, src0: 0, fadeIn: 0, fadeOut: 0 }], audio: [], outVideo: f('parte-02.mp4'), outWav: f('parte-02.wav') }), fast), { stdio: 'ignore' })
    writeFileSync(f('video.txt'), concatList(['parte-01.mp4', 'parte-02.mp4']))
    writeFileSync(f('audio.txt'), concatList(['parte-01.wav', 'parte-02.wav']))
    execFileSync('ffmpeg', finalArgs(f('video.txt'), f('audio.txt'), f('final.mp4')), { stdio: 'ignore' })
    const [frames] = probe(f('final.mp4'), 'stream=nb_read_frames')
    expect(frames).toBe('105')
    const audio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', f('final.mp4')]).toString().trim()
    expect(audio).toBe('aac')
  }, 60000)

  it('o vídeo de baixo sai com quadro-chave curto (pra animação pular nele quadro a quadro)', () => {
    execFileSync('ffmpeg', partArgs(spec({ audio: [], outVideo: f('embaixo.mp4'), outWav: f('embaixo.wav') }), seekArgs()), { stdio: 'ignore' })
    const keys = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', f('embaixo.mp4')]).toString().trim().split(/\s+/)
    expect(keys.length).toBe(60)
    expect(keys.filter((k) => k.startsWith('1')).length).toBeGreaterThanOrEqual(15)
  }, 60000)

  it('camada de baixo opaca (sem canal alfa) sai igual à comum: mesmos quadros, fade pro preto', () => {
    const video = [{ path: f('a.mp4'), image: false, t0: 0, t1: 2, src0: 0.5, fadeIn: 0.5, fadeOut: 0, opaque: true, covers: true }]
    execFileSync('ffmpeg', partArgs(spec({ video, audio: [], outVideo: f('op.mp4'), outWav: f('op.wav') }), fast), { stdio: 'ignore' })
    execFileSync('ffmpeg', partArgs(spec({ video: video.map((v) => ({ ...v, opaque: false, covers: false })), audio: [], outVideo: f('al.mp4'), outWav: f('al.wav') }), fast), { stdio: 'ignore' })
    expect(probe(f('op.mp4'), 'stream=width,height,nb_read_frames')).toEqual(['320', '180', '60'])
    // os dois caminhos dão a mesma imagem (PSNR alto em todos os quadros, inclusive no fade)
    const r = spawnSync('ffmpeg', ['-v', 'info', '-i', f('op.mp4'), '-i', f('al.mp4'), '-lavfi', 'psnr', '-f', 'null', '-'])
    const min = Number(/min:([\d.]+|inf)/.exec(r.stderr.toString())?.[1].replace('inf', '99'))
    expect(min).toBeGreaterThan(30)
  }, 60000)

  it('camada opaca mais curta que a parte: o resto fica preto e a conta de quadros fecha', () => {
    const video = [{ path: f('a.mp4'), image: false, t0: 0.5, t1: 1.5, src0: 0, fadeIn: 0, fadeOut: 0, opaque: true, covers: true }]
    execFileSync('ffmpeg', partArgs(spec({ video, audio: [], outVideo: f('curta.mp4'), outWav: f('curta.wav') }), fast), { stdio: 'ignore' })
    expect(probe(f('curta.mp4'), 'stream=nb_read_frames')).toEqual(['60'])
  }, 60000)
})
