import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { jsonEsc, listFiles, readJson, safeName, serial, writeAtomic, writeJson } from '../fsx'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'typos-fsx-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('writeAtomic', () => {
  it('grava o arquivo e não deixa .tmp pra trás', async () => {
    const file = join(dir, 'a.json')
    await writeJson(file, { a: 1 })
    await writeJson(file, { a: 2 })
    expect(await readJson(file, null)).toEqual({ a: 2 })
    expect(await readdir(dir)).toEqual(['a.json'])
  })

  it('gravações ao mesmo tempo no mesmo arquivo terminam com um JSON inteiro', async () => {
    const file = join(dir, 'b.json')
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeJson(file, { i, pad: 'x'.repeat(5000) })))
    const got = await readJson<{ i: number } | null>(file, null)
    expect(got).not.toBeNull()
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('se falhar, o arquivo antigo fica e o .tmp some', async () => {
    const file = join(dir, 'pasta')
    await mkdir(file)
    await expect(writeAtomic(file, 'x')).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['pasta'])
  })
})

describe('readJson', () => {
  it('devolve o padrão quando o arquivo não existe ou está corrompido', async () => {
    expect(await readJson(join(dir, 'nada.json'), 7)).toBe(7)
    await writeFile(join(dir, 'ruim.json'), '{"a":')
    expect(await readJson(join(dir, 'ruim.json'), 'x')).toBe('x')
  })
})

describe('serial', () => {
  it('roda as tarefas da mesma chave uma depois da outra, na ordem', async () => {
    const run = serial()
    const log: string[] = []
    const job = (name: string, ms: number) => async () => {
      log.push(`+${name}`)
      await new Promise((r) => setTimeout(r, ms))
      log.push(`-${name}`)
      return name
    }
    const got = await Promise.all([run('k', job('a', 20)), run('k', job('b', 1)), run('k', job('c', 1))])
    expect(got).toEqual(['a', 'b', 'c'])
    expect(log).toEqual(['+a', '-a', '+b', '-b', '+c', '-c'])
  })

  it('chaves diferentes não esperam uma pela outra', async () => {
    const run = serial()
    const log: string[] = []
    await Promise.all([
      run('x', async () => {
        await new Promise((r) => setTimeout(r, 20))
        log.push('x')
      }),
      run('y', async () => void log.push('y'))
    ])
    expect(log).toEqual(['y', 'x'])
  })

  it('uma tarefa que falha não trava as seguintes', async () => {
    const run = serial()
    const bad = run('k', async () => {
      throw new Error('ops')
    })
    const ok = run('k', async () => 'foi')
    await expect(bad).rejects.toThrow('ops')
    expect(await ok).toBe('foi')
  })
})

describe('listFiles', () => {
  it('lista os arquivos das subpastas e pula o que o filtro mandar', async () => {
    await mkdir(join(dir, 'sub', 'fora'), { recursive: true })
    await writeFile(join(dir, 'a.txt'), '')
    await writeFile(join(dir, 'sub', 'b.txt'), '')
    await writeFile(join(dir, 'sub', 'fora', 'c.txt'), '')
    const all = (await listFiles(dir)).sort()
    expect(all).toEqual([join(dir, 'a.txt'), join(dir, 'sub', 'b.txt'), join(dir, 'sub', 'fora', 'c.txt')])
    expect((await listFiles(dir, (name) => name === 'fora')).sort()).toEqual([join(dir, 'a.txt'), join(dir, 'sub', 'b.txt')])
    expect(await listFiles(join(dir, 'nao-existe'))).toEqual([])
  })
})

describe('nomes', () => {
  it('safeName tira o que atrapalha num caminho', () => {
    expect(safeName('meu vídeo: final?.mp4')).toBe('meu_v_deo_final_.mp4')
    expect(safeName('')).toBe('arquivo')
    expect(safeName('a'.repeat(100))).toHaveLength(60)
  })
  it('jsonEsc escapa como dentro de um JSON', () => {
    expect(jsonEsc('C:\\a\\"b"')).toBe('C:\\\\a\\\\\\"b\\"')
  })
})
