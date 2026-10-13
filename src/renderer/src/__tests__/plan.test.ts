import { describe, expect, it } from 'vitest'
import { planRender, timelineEnd } from '../render/plan'
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
})
