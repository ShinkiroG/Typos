import { describe, expect, it } from 'vitest'
import { aeScript, aerenderFrame, bodyOffset, parseResult, pickAeFolders, renderInput, type AeScriptJob } from '../aeCore'

const job = (body: string, wav?: string): AeScriptJob => ({
  body,
  dir: 'C:\\proj\\previas\\b1\\ae-x',
  aep: 'C:\\proj\\previas\\b1\\ae-x\\motion.aep',
  result: 'C:\\proj\\previas\\b1\\ae-x\\_resultado.txt',
  renderDir: 'C:\\proj\\previas\\b1\\ae-x\\render',
  width: 1920,
  height: 1080,
  seconds: 4,
  fps: 30,
  wav
})

/** um After Effects de mentira, só o bastante pro script rodar */
function fakeAe(opts: { files?: string[] } = {}) {
  const written: string[] = []
  const layers: any[] = []
  const saved: string[] = []
  const rq: any[] = []
  const comp = {
    bgColor: null as any,
    layers: { add: (it: any) => (layers.unshift({ name: it.name, src: it, moveToEnd() {} }), layers[0]), addText: (t: string) => (layers.unshift({ name: t }), layers[0]) },
    openInViewer() {}
  }
  const proj = {
    items: { addComp: (...a: any[]) => Object.assign(comp, { args: a }) },
    importFile: (o: any) => ({ name: o.file.name }),
    renderQueue: {
      get numItems() {
        return rq.length
      },
      item: (i: number) => ({ remove: () => rq.splice(i - 1, 1) }),
      items: {
        add: () => {
          const om: any = { applyTemplate() {} }
          const it = { applyTemplate() {}, outputModule: () => om, om }
          rq.push(it)
          return it
        }
      }
    },
    save: (f: any) => saved.push(f.path)
  }
  const File = (p: string) => ({
    path: p,
    name: p.split('/').pop(),
    exists: (opts.files ?? []).some((n) => p.endsWith('/' + n)),
    open() {},
    write: (t: string) => written.push(t),
    close() {}
  })
  const Folder = (p: string) => ({ fsName: p, create() {} })
  const app = { newProject: () => proj, beginSuppressDialogs() {}, endSuppressDialogs() {} }
  function ImportOptions(this: any, f: any) {
    this.file = f
  }
  return { env: { app, File, Folder, ImportOptions }, written, layers, saved, rq, comp }
}

function runJsx(src: string, env: Record<string, unknown>) {
  new Function(...Object.keys(env), src)(...Object.values(env))
}

describe('After Effects', () => {
  it('prefere o 2025 e o 2024, mesmo com um 2026 instalado junto', () => {
    expect(pickAeFolders(['Adobe Photoshop 2025', 'Adobe After Effects 2026', 'Adobe After Effects 2024', 'Adobe After Effects 2025', 'Adobe After Effects CC 2019'])).toEqual([
      'Adobe After Effects 2025',
      'Adobe After Effects 2024',
      'Adobe After Effects 2026',
      'Adobe After Effects CC 2019'
    ])
    expect(pickAeFolders(['Adobe After Effects 2026', 'Adobe After Effects 2024'])[0]).toBe('Adobe After Effects 2024')
  })

  it('lê o quadro do progresso do aerender', () => {
    expect(aerenderFrame('PROGRESS:  0:00:01:05 (36): 1 Seconds')).toBe(36)
    expect(aerenderFrame('PROGRESS:  Total Time Elapsed: 3 Seconds')).toBeNull()
  })

  it('acha o vídeo ou a sequência de imagens que o aerender gravou', () => {
    expect(renderInput([])).toBeNull()
    expect(renderInput(['clipe.mov'])).toEqual({ file: 'clipe.mov' })
    expect(renderInput(['clipe_00002.png', 'clipe_00001.png', 'clipe_00000.png'])).toEqual({ file: 'clipe_%05d.png', pattern: { start: 0 } })
  })

  it('lê o resultado do script', () => {
    expect(parseResult('\uFEFFOK\n')).toEqual({ ok: true })
    expect(parseResult('ERRO\nlinha 3: ReferenceError')).toEqual({ error: 'linha 3: ReferenceError' })
  })

  it('o script monta a comp, roda o miolo, põe na fila e salva o .aep', () => {
    const ae = fakeAe({ files: ['audio-trecho.wav', 'logo.png'] })
    runJsx(aeScript(job('var l = addFile("logo.png");\nl.name = "Logo";\ncomp.layers.addText("Olá");', 'audio-trecho.wav')), ae.env)
    expect(ae.written).toEqual(['OK'])
    expect((ae.comp as any).args).toEqual(['Typos', 1920, 1080, 1, 4, 30])
    expect(ae.layers.map((l) => l.name)).toEqual(['Olá', 'Logo', 'Áudio do trecho (referência, o Typos põe o som de novo)'])
    expect(ae.saved).toEqual(['C:/proj/previas/b1/ae-x/motion.aep'])
    expect(ae.rq).toHaveLength(1)
    expect(ae.rq[0].om.file.path).toBe('C:/proj/previas/b1/ae-x/render/clipe')
  })

  it('erro no miolo volta com a linha contada a partir do script do Claude', () => {
    const ae = fakeAe()
    const j = job('var a = 1;\naddFile("falta.png");')
    // o ExtendScript dá a linha do arquivo inteiro no erro: aqui ela é simulada
    const src = aeScript(j).replace('addFile("falta.png");', `try { addFile("falta.png"); } catch (x) { x.line = ${bodyOffset(j) + 2}; throw x; }`)
    runJsx(src, ae.env)
    expect(ae.written[0]).toMatch(/^ERRO\nlinha 2: Error: Arquivo não encontrado na pasta do bloco: falta\.png/)
    expect(ae.saved).toEqual([])
  })
})
