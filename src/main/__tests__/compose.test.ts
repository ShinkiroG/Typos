import { describe, expect, it } from 'vitest'
import { nvencArgs, nvencFailed, partArgs, x264Args } from '../compose'

const part = {
  from: 0,
  to: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  video: [{ path: 'a.mp4', image: false, t0: 0, t1: 10, src0: 0, fadeIn: 0, fadeOut: 0 }],
  audio: [],
  outVideo: 'p.mp4',
  outWav: 'p.wav'
}

describe('encoder das partes do render', () => {
  it('usa o x264 de master por padrão', () => {
    const a = partArgs(part)
    expect(a.join(' ')).toContain(x264Args('master').join(' '))
  })
  it('usa o encoder passado (NVENC)', () => {
    const a = partArgs(part, nvencArgs())
    expect(a).toContain('h264_nvenc')
    expect(a).not.toContain('libx264')
  })
  it('reconhece falha da placa pra refazer na CPU', () => {
    expect(nvencFailed('[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: out of memory (10)')).toBe(true)
    expect(nvencFailed('Cannot load nvcuda.dll')).toBe(true)
    expect(nvencFailed('a.mp4: No such file or directory')).toBe(false)
  })
})
