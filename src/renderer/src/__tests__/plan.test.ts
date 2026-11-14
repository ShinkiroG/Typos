import { describe, expect, it } from 'vitest'
import { cullHidden, planRender, timelineEnd, type VLayer } from '../render/plan'
import { defaultMontage, type MontageData } from '../lib'

function montage(): MontageData {
  const m = defaultMontage()
  m.media = [
    { id: 'v', bin: 'raw', path: 'C:\\video.mp4', name: 'video.mp4', kind: 'video', duration: 30, hasAudio: true, hasVideo: true },
    { id: 'n', bin: 'narration', path: 'C:\\voz.wav', name: 'voz.wav', kind: 'audio', duration: 30, hasAudio: true, hasVideo: false }
  ]
  m.clips = [
    { id: 'c1', track: 'V1', media: 'v', start: 0, in: 0, out: 10 },
    { id: 'c2', track: 'A1', media: 'n', start: 2, in: 0, out: 12 }
  ]
  return m
}

describe('plano do render', () => {
  it('a timeline termina no fim do último clipe', () => {
    expect(timelineEnd(montage())).toBeCloseTo(14)
  })

  it('as partes cobrem o trecho inteiro, sem buraco nem sobra', () => {
    const p = planRender(montage(), { from: 0, to: 999, width: 1920, height: 1080, fps: 30 })
    expect(p.parts.length).toBeGreaterThan(0)
    expect(p.parts[0].from).toBeCloseTo(0)
    expect(p.parts[p.parts.length - 1].to).toBeCloseTo(14)
    for (let i = 1; i < p.parts.length; i++) expect(p.parts[i].from).toBeCloseTo(p.parts[i - 1].to)
  })

  it('vídeo e áudio entram nas partes certas', () => {
    const p = planRender(montage(), { from: 0, to: 999, width: 1920, height: 1080, fps: 30 })
    const all = p.parts.flatMap((x) => x.audio.map((a) => a.path))
    expect(all).toContain('C:\\voz.wav')
    expect(p.parts.flatMap((x) => x.video.map((v) => v.path))).toContain('C:\\video.mp4')
  })

  it('a mesma montagem gera a mesma chave (o render retoma o que já fez)', () => {
    const o = { from: 0, to: 999, width: 1920, height: 1080, fps: 30 }
    expect(planRender(montage(), o).parts.map((x) => x.key)).toEqual(planRender(montage(), o).parts.map((x) => x.key))
  })

  it('empurrar a timeline um número inteiro de quadros não muda a chave das partes', () => {
    const o = { from: 0, to: 999, width: 1920, height: 1080, fps: 30 }
    const m = montage()
    m.clips = [{ id: 'c1', track: 'V1', media: 'v', start: 0, in: 0, out: 10 }]
    const moved = montage()
    moved.clips = [{ id: 'c1', track: 'V1', media: 'v', start: 2, in: 0, out: 10 }]
    const k1 = planRender(m, { ...o, from: 0, to: 10 }).parts.map((x) => x.key)
    const k2 = planRender(moved, { ...o, from: 2, to: 12 }).parts.map((x) => x.key)
    expect(k2).toEqual(k1)
    // mudou o conteúdo (outro ponto do arquivo): a chave muda
    moved.clips[0].in = 1
    moved.clips[0].out = 11
    expect(planRender(moved, { ...o, from: 2, to: 12 }).parts.map((x) => x.key)).not.toEqual(k1)
  })
})

describe('camadas escondidas', () => {
  const L = (o: Partial<VLayer>): VLayer => ({ path: 'a.mp4', image: false, t0: 0, t1: 10, src0: 0, fadeIn: 0, fadeOut: 0, ...o })

  it('some a camada que fica o tempo todo embaixo de outra que cobre o quadro', () => {
    const out = cullHidden([L({ path: 'bruto.mp4' }), L({ path: 'motion.mp4', covers: true, opaque: true })], 0, 10)
    expect(out.map((x) => x.path)).toEqual(['motion.mp4'])
  })

  it('camada de cima com transparência (ou que não cobre) não esconde nada', () => {
    const out = cullHidden([L({ path: 'bruto.mp4' }), L({ path: 'motion.webm' })], 0, 10)
    expect(out.length).toBe(2)
  })

  it('encurta a ponta escondida e acerta o ponto do arquivo', () => {
    const out = cullHidden([L({ path: 'bruto.mp4', src0: 5 }), L({ path: 'motion.mp4', covers: true, t0: 0, t1: 4 })], 0, 10)
    expect(out[0]).toMatchObject({ path: 'bruto.mp4', t0: 4, t1: 10, src0: 9 })
  })

  it('durante o fade da camada de cima a de baixo continua lá', () => {
    const out = cullHidden([L({ path: 'bruto.mp4' }), L({ path: 'motion.mp4', covers: true, t0: 2, t1: 10, fadeIn: 1 })], 0, 10)
    expect(out[0]).toMatchObject({ path: 'bruto.mp4', t0: 0, t1: 3 })
  })

  it('duas camadas emendadas por cima escondem a de baixo inteira', () => {
    const out = cullHidden([L({ path: 'bruto.mp4' }), L({ path: 'm1.mp4', covers: true, t0: 0, t1: 5 }), L({ path: 'm2.mp4', covers: true, t0: 5, t1: 10 })], 0, 10)
    expect(out.map((x) => x.path)).toEqual(['m1.mp4', 'm2.mp4'])
  })
})
