import { describe, expect, it } from 'vitest'
import { linkPair, partnerOf, syncLinks, unlink, withLinked } from '../montage/links'
import { splitClip, overwrite } from '../montage/EditTimeline'
import { defaultMontage, type MontageClip, type MontageData } from '../lib'

const base = (): MontageData => ({
  ...defaultMontage(),
  media: [
    { id: 'v', bin: 'raw', path: 'C:/v.mp4', name: 'v.mp4', kind: 'video', duration: 60, hasAudio: true, hasVideo: true },
    { id: 'mute', bin: 'raw', path: 'C:/m.mp4', name: 'm.mp4', kind: 'video', duration: 60, hasAudio: false, hasVideo: true },
    { id: 'a', bin: 'narration', path: 'C:/a.wav', name: 'a.wav', kind: 'audio', duration: 60, hasAudio: true, hasVideo: false }
  ]
})
const vclip = (p: Partial<MontageClip> = {}): MontageClip => ({ id: 'c1', track: 'V1', media: 'v', start: 2, in: 1, out: 6, ...p })
const step = (prev: MontageData, next: MontageData) => syncLinks(prev, next)
const add = (d: MontageData, c: MontageClip) => step(d, { ...d, clips: [...d.clips, c] })

describe('áudio vinculado aos clipes de vídeo', () => {
  it('vídeo com som ganha o som numa faixa de áudio, e o vídeo fica mudo', () => {
    const d = add(base(), vclip())
    const v = d.clips.find((c) => c.id === 'c1')!
    const s = partnerOf(d, v)!
    expect(v.audioOff).toBe(true)
    expect(s).toMatchObject({ media: 'v', start: 2, in: 1, out: 6 })
    const tr = d.tracks.find((t) => t.id === s.track)!
    expect(tr.kind).toBe('audio')
    expect(tr.videoSound).toBe(true)
    // a faixa nova fica em cima do áudio (logo abaixo da divisória)
    expect(d.tracks.findIndex((t) => t.kind === 'audio')).toBe(d.tracks.indexOf(tr))
  })

  it('vídeo sem som, ou com o som desligado, não ganha par', () => {
    const d = add(base(), vclip({ media: 'mute' }))
    expect(d.clips).toHaveLength(1)
    const e = add(base(), vclip({ audioOff: true }))
    expect(e.clips).toHaveLength(1)
  })

  it('dois vídeos no mesmo tempo: o segundo som vai pra outra faixa', () => {
    let d = add(base(), vclip())
    d = add(d, vclip({ id: 'c2', track: 'V1', start: 3 }))
    const s1 = partnerOf(d, d.clips.find((c) => c.id === 'c1'))!
    const s2 = partnerOf(d, d.clips.find((c) => c.id === 'c2'))!
    expect(s1.track).not.toBe(s2.track)
    // mais tarde, sem sobrepor, volta pra primeira
    d = add(d, vclip({ id: 'c3', start: 30 }))
    expect(partnerOf(d, d.clips.find((c) => c.id === 'c3'))!.track).toBe(s1.track)
  })

  it('mover ou aparar um lado leva o outro junto (mas não muda a faixa do som)', () => {
    let d = add(base(), vclip())
    const s = partnerOf(d, d.clips[0])!
    // som foi pra A2
    d = step(d, { ...d, clips: d.clips.map((c) => (c.id === s.id ? { ...c, track: 'A2' } : c)) })
    expect(d.clips.find((c) => c.id === s.id)!.track).toBe('A2')
    d = step(d, { ...d, clips: d.clips.map((c) => (c.id === 'c1' ? { ...c, start: 10 } : c)) })
    expect(d.clips.find((c) => c.id === s.id)).toMatchObject({ start: 10, track: 'A2' })
    // aparar o som apara o vídeo
    d = step(d, { ...d, clips: d.clips.map((c) => (c.id === s.id ? { ...c, out: 4 } : c)) })
    expect(d.clips.find((c) => c.id === 'c1')!.out).toBe(4)
  })

  it('apagar um lado apaga o outro; apagar a faixa só solta', () => {
    let d = add(base(), vclip())
    const s = partnerOf(d, d.clips[0])!
    const del = step(d, { ...d, clips: d.clips.filter((c) => c.id !== 'c1') })
    expect(del.clips).toHaveLength(0)
    d = step(d, { ...d, tracks: d.tracks.filter((t) => t.id !== s.track), clips: d.clips.filter((c) => c.id !== s.id) })
    expect(d.clips).toHaveLength(1)
    expect(d.clips[0].link).toBeUndefined()
    expect(d.clips[0].audioOff).toBe(true)
  })

  it('dividir o vídeo divide o som', () => {
    let d = add(base(), vclip({ fadeOut: 0.5 }))
    const s = partnerOf(d, d.clips[0])!
    const [l, r] = splitClip(d.clips[0], 4)!
    d = step(d, { ...d, clips: d.clips.flatMap((c) => (c.id === 'c1' ? [l, r] : [c])) })
    const sl = partnerOf(d, d.clips.find((c) => c.id === l.id))!
    const sr = partnerOf(d, d.clips.find((c) => c.id === r.id))!
    expect(sl.id).toBe(s.id)
    expect(sl).toMatchObject({ start: 2, in: 1, out: 3, fadeOut: 0 })
    expect(sr).toMatchObject({ start: 4, in: 3, out: 6, fadeOut: 0.5, track: s.track })
    expect(sr.link).not.toBe(sl.link)
  })

  it('dividir os dois juntos (playhead) não duplica o som', () => {
    let d = add(base(), vclip())
    const s = partnerOf(d, d.clips[0])!
    let clips = d.clips
    for (const c of [d.clips[0], s]) {
      const parts = splitClip(c, 4)!
      clips = clips.flatMap((x) => (x.id === c.id ? parts : [x]))
    }
    d = step(d, { ...d, clips })
    expect(d.clips).toHaveLength(4)
    const right = d.clips.filter((c) => c.start === 4)
    expect(right).toHaveLength(2)
    expect(right[0].link).toBe(right[1].link)
  })

  it('duplicar só o vídeo cria o som da cópia', () => {
    let d = add(base(), vclip())
    const copy = { ...d.clips[0], id: 'cp', start: 20 }
    d = step(d, { ...d, clips: [...d.clips, copy] })
    const s = partnerOf(d, d.clips.find((c) => c.id === 'cp'))!
    expect(s).toMatchObject({ start: 20, media: 'v' })
    expect(d.clips).toHaveLength(4)
  })

  it('soltar outro corte por cima do meio do vídeo: o pedaço da direita ganha o seu som', () => {
    let d = add(base(), vclip({ start: 0, in: 0, out: 10 }))
    d = step(d, { ...d, clips: [...d.clips, { id: 'img', track: 'V1', media: 'mute', start: 4, in: 0, out: 2 }] })
    d = step(d, { ...d, clips: overwrite(d.clips, ['img']) })
    const vids = d.clips.filter((c) => c.track === 'V1' && c.media === 'v').sort((a, b) => a.start - b.start)
    expect(vids).toHaveLength(2)
    expect(partnerOf(d, vids[0])).toMatchObject({ start: 0, out: 4 })
    expect(partnerOf(d, vids[1])).toMatchObject({ start: 6, in: 6, out: 10 })
  })

  it('desvincular e vincular de novo', () => {
    let d = add(base(), vclip())
    const s = partnerOf(d, d.clips[0])!
    expect(withLinked(d, ['c1']).sort()).toEqual(['c1', s.id].sort())
    d = unlink(d, ['c1'])
    expect(partnerOf(d, d.clips[0])).toBeUndefined()
    // solto: apagar o som não apaga o vídeo
    const e = step(d, { ...d, clips: d.clips.filter((c) => c.id !== s.id) })
    expect(e.clips.map((c) => c.id)).toEqual(['c1'])
    d = step(d, { ...d, clips: d.clips.map((c) => (c.id === s.id ? { ...c, start: 9 } : c)) })
    d = linkPair(d, 'c1', s.id)
    expect(d.clips.find((c) => c.id === s.id)!.start).toBe(2)
  })

  it('timeline antiga (vídeo tocando o próprio som) é convertida ao abrir', () => {
    const d = { ...base(), clips: [vclip()] }
    const m = syncLinks(null, d)
    expect(m.clips).toHaveLength(2)
    expect(syncLinks(null, m)).toBe(m)
  })
})
