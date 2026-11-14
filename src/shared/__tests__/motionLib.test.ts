import { beforeEach, describe, expect, it } from 'vitest'
import { MOTION_LIB, MOTION_LIB_FILE, motionLibPrompt } from '../motionLib'

interface Typos {
  animate(t: unknown, o: Record<string, unknown>): Typos
  in(t: unknown, kind: string, o?: Record<string, unknown>): Typos
  out(t: unknown, kind: string, o?: Record<string, unknown>): Typos
  split(t: unknown, by: string): HTMLElement[]
  count(t: unknown, o: Record<string, unknown>): Typos
  type(t: unknown, o?: Record<string, unknown>): Typos
  at(t: number, fn: () => void): Typos
  seek(t: number): Typos
  ease: Record<string, (t: number) => number>
}

/** carrega a biblioteca numa página nova, com o relógio parado (o teste anda com seek) */
function load(body: string): Typos {
  document.body.innerHTML = body
  delete (window as unknown as { typos?: Typos }).typos
  new Function('requestAnimationFrame', 'performance', MOTION_LIB)(() => 0, { now: () => 0 })
  return (window as unknown as { typos: Typos }).typos
}
const el = (id: string) => document.getElementById(id)!

describe('biblioteca de animação do Typos', () => {
  beforeEach(() => (document.body.innerHTML = ''))

  it('o texto da biblioteca é JavaScript válido e o prompt cita o arquivo', () => {
    expect(() => new Function(MOTION_LIB)).not.toThrow()
    expect(motionLibPrompt().join('\n')).toContain(`<script src="${MOTION_LIB_FILE}">`)
  })

  it('as curvas começam em 0 e terminam em 1', () => {
    const t = load('')
    for (const [name, f] of Object.entries(t.ease)) {
      expect(f(0), name).toBeCloseTo(0, 5)
      expect(f(1), name).toBeCloseTo(1, 2)
    }
  })

  it('animate: fica no from antes de começar, no meio interpola e para no to', () => {
    const t = load('<div id="a"></div>')
    t.animate('#a', { from: { x: 100, opacity: 0 }, to: { x: 0, opacity: 1 }, at: 1, dur: 2, ease: 'linear' })
    expect(+el('a').style.opacity).toBe(0)
    expect(el('a').style.transform).toContain('translate(100.00px,0.00px)')
    t.seek(2)
    expect(+el('a').style.opacity).toBe(0.5)
    expect(el('a').style.transform).toContain('translate(50.00px,0.00px)')
    t.seek(9)
    expect(+el('a').style.opacity).toBe(1)
    expect(el('a').style.transform).toContain('translate(0.00px,0.00px)')
  })

  it('o mesmo instante dá sempre o mesmo quadro, em qualquer ordem (gravação e motion blur)', () => {
    const t = load('<div id="a"></div>')
    t.animate('#a', { from: { y: 40, scale: 0.5 }, at: 0.2, dur: 0.8, ease: 'outBack' }).animate('#a', { to: { y: -30, rotate: 90 }, at: 1.5, dur: 0.5 })
    t.seek(0.61)
    const a = el('a').style.transform
    t.seek(1.9)
    const b = el('a').style.transform
    t.seek(0.61)
    expect(el('a').style.transform).toBe(a)
    t.seek(1.9)
    expect(el('a').style.transform).toBe(b)
    expect(a).not.toBe(b)
  })

  it('tweens encadeados partem de onde o anterior parou', () => {
    const t = load('<div id="a"></div>')
    t.animate('#a', { to: { x: 100 }, at: 0, dur: 1, ease: 'linear' }).animate('#a', { to: { x: 300 }, at: 2, dur: 1, ease: 'linear' })
    t.seek(1.5)
    expect(el('a').style.transform).toContain('translate(100.00px')
    t.seek(2.5)
    expect(el('a').style.transform).toContain('translate(200.00px')
  })

  it('stagger atrasa cada elemento e as entradas prontas terminam no estado natural', () => {
    const t = load('<i class="w"></i><i class="w"></i><i class="w"></i>')
    t.in('.w', 'up', { at: 0, dur: 1, stagger: 1, ease: 'linear', dist: 50 })
    t.seek(1)
    const ops = [...document.querySelectorAll<HTMLElement>('.w')].map((x) => +x.style.opacity)
    expect(ops).toEqual([1, 0, 0])
    t.seek(5)
    for (const x of document.querySelectorAll<HTMLElement>('.w')) expect(x.style.transform).toContain('translate(0.00px,0.00px)')
  })

  it('split quebra em palavras e letras sem perder o texto', () => {
    const t = load('<h1 id="h">Olá mundo novo</h1><h2 id="g">Oi tu</h2>')
    expect(t.split('#h', 'words').map((s) => s.textContent)).toEqual(['Olá', 'mundo', 'novo'])
    expect(el('h').textContent).toBe('Olá mundo novo')
    expect(t.split('#g', 'chars').map((s) => s.textContent)).toEqual(['O', 'i', 't', 'u'])
    expect(el('g').textContent).toBe('Oi tu')
  })

  it('count, type e at andam com o tempo', () => {
    const t = load('<b id="n"></b><p id="p">abcd</p>')
    let fired = 0
    t.count('#n', { from: 0, to: 1500, at: 0, dur: 1, ease: 'linear', prefix: 'R$ ' }).type('#p', { at: 0, dur: 1 }).at(0.7, () => fired++)
    t.seek(0.5)
    expect(el('n').textContent).toBe('R$ 750')
    expect(el('p').textContent).toBe('ab')
    expect(fired).toBe(0)
    t.seek(1)
    t.seek(1.2)
    expect(el('n').textContent).toBe('R$ 1.500')
    expect(el('p').textContent).toBe('abcd')
    expect(fired).toBe(1)
  })

  it('propriedade CSS com unidade (ex.: largura em %)', () => {
    const t = load('<div id="a"></div>')
    t.animate('#a', { from: { width: '0%' }, to: { width: '80%' }, at: 0, dur: 1, ease: 'linear' })
    t.seek(0.5)
    expect(el('a').style.width).toBe('40%')
  })
})
