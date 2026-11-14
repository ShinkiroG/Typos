import { describe, expect, it } from 'vitest'
import { FX_PAGE_MATH, coverScale, fxActive, fxPrompt, fxScript, normFx, shakeAt, withFx } from '../fx'

// o cálculo que roda dentro da página (texto) tem que bater com o do TypeScript
const page = new Function(FX_PAGE_MATH + '\nreturn { fxNorm, fxShake }')() as {
  fxNorm: (f: unknown) => ReturnType<typeof normFx>
  fxShake: (n: ReturnType<typeof normFx>, t: number, w: number, h: number) => { x: number; y: number; r: number; s: number }
}

describe('efeitos globais', () => {
  it('normaliza e limita os valores', () => {
    expect(normFx(undefined)).toEqual({ shake: 0, shakeSpeed: 35, shakeRotate: 30, grain: 0 })
    expect(normFx({ shake: 140, grain: -3, shakeSpeed: 12.6 })).toMatchObject({ shake: 100, grain: 0, shakeSpeed: 13 })
    expect(page.fxNorm({ shake: 140, grain: -3, shakeSpeed: 12.6 })).toEqual(normFx({ shake: 140, grain: -3, shakeSpeed: 12.6 }))
    expect(fxActive({ shakeSpeed: 80 })).toBe(false)
    expect(fxActive({ grain: 1 })).toBe(true)
  })

  it('o shake da página é o mesmo do TypeScript', () => {
    for (const fx of [{ shake: 40 }, { shake: 100, shakeSpeed: 0, shakeRotate: 100 }, { shake: 7, shakeSpeed: 90, shakeRotate: 0 }])
      for (const t of [0, 0.25, 1.7, 9.3])
        for (const [w, h] of [[960, 540], [540, 960]]) {
          const a = shakeAt(fx, t, w, h)
          const b = page.fxShake(normFx(fx), t, w, h)
          expect(b.x).toBeCloseTo(a.x, 9)
          expect(b.y).toBeCloseTo(a.y, 9)
          expect(b.r).toBeCloseTo(a.r, 9)
          expect(b.s).toBeCloseTo(a.s, 9)
        }
  })

  it('é determinístico e a borda nunca aparece', () => {
    const fx = { shake: 100, shakeSpeed: 70, shakeRotate: 100 }
    expect(shakeAt(fx, 3.21, 960, 540)).toEqual(shakeAt(fx, 3.21, 960, 540))
    const W = 960
    const H = 540
    for (let t = 0; t < 10; t += 0.05) {
      const o = shakeAt(fx, t, W, H)
      const th = (o.r * Math.PI) / 180
      // cantos do quadro (que o espectador vê), no sistema do conteúdo transformado: têm que cair dentro do conteúdo
      for (const [cx, cy] of [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]]) {
        const x = cx - o.x
        const y = cy - o.y
        const ux = (Math.cos(-th) * x - Math.sin(-th) * y) / o.s
        const uy = (Math.sin(-th) * x + Math.cos(-th) * y) / o.s
        expect(Math.abs(ux)).toBeLessThanOrEqual(W / 2 + 1e-6)
        expect(Math.abs(uy)).toBeLessThanOrEqual(H / 2 + 1e-6)
      }
    }
    expect(coverScale({ shake: 0 }, W, H)).toBe(1)
  })

  it('não mexe no HTML quando está tudo desligado', () => {
    const html = '<html><head></head><body>x</body></html>'
    expect(withFx(html, { shake: 0, grain: 0 })).toBe(html)
    expect(withFx(html, { shake: 30 })).toContain('fxShake')
    // ao vivo (prévia do Estilo): sempre entra, pra escutar os sliders
    expect(withFx(html, null, { live: true })).toContain("addEventListener('message'")
  })

  it('entra depois do relógio do Typos', () => {
    const clock = '<script>/*relogio*/</script>'
    const out = withFx(`<html><head>${clock}<style></style></head></html>`, { shake: 10 }, { after: clock })
    expect(out.indexOf(clock)).toBeLessThan(out.indexOf('fxShake'))
    expect(out.indexOf('fxShake')).toBeLessThan(out.indexOf('<style>'))
  })

  it('o script é JS válido', () => {
    const js = fxScript({ shake: 50, grain: 20 }, true).replace(/^<script>|<\/script>$/g, '')
    expect(() => new Function(js)).not.toThrow()
  })

  it('avisa o Claude pra não fazer o efeito de novo', () => {
    expect(fxPrompt({})).toEqual([])
    const p = fxPrompt({ shake: 40, grain: 10 }).join('\n')
    expect(p).toMatch(/NÃO faça shake/)
    expect(p).toMatch(/NÃO ponha grão/)
  })
})
