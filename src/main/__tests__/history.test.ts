import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, cpSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'typos-hist-'))
vi.mock('electron', () => ({ app: { getPath: () => join(tmp, 'userData') }, ipcMain: { handle: vi.fn() } }))

const { beforeSave, onOpen, snapshotNow } = await import('../history')

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const doc = (words: number) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: Array(words).fill('palavra').join(' ') }] }] })
const store = (id: string) => join(tmp, 'userData', 'historico', id)
const versions = (id: string) => readdirSync(store(id)).filter((n) => n !== 'info.json').sort()

/** o que o project:save faz: lê o disco, decide a cópia e grava por cima */
async function save(dir: string, data: any) {
  const file = join(dir, 'roteiro.json')
  const diskText = existsSync(file) ? readFileSync(file, 'utf8') : null
  await beforeSave(dir, diskText, data)
  writeFileSync(file, JSON.stringify(data))
  return data
}

describe('histórico central', () => {
  it('abrir dá um id ao roteiro e traz as cópias antigas de .typos-versoes', async () => {
    const dir = join(tmp, 'Steam')
    mkdirSync(join(dir, '.typos-versoes'), { recursive: true })
    writeFileSync(join(dir, 'roteiro.json'), JSON.stringify({ title: 'Steam', doc: doc(300) }))
    writeFileSync(join(dir, '.typos-versoes', '20261016-231308.json'), JSON.stringify({ title: 'Steam', doc: doc(250) }))
    const data = await onOpen(dir, JSON.parse(readFileSync(join(dir, 'roteiro.json'), 'utf8')))
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(readFileSync(join(dir, 'roteiro.json'), 'utf8')).id).toBe(data.id)
    expect(versions(data.id)).toEqual(['20261016-231308_importado_250w.json'])
  })

  it('primeiro salvar guarda como estava; apagar muito texto guarda na hora', async () => {
    const dir = join(tmp, 'Steam')
    const opened = JSON.parse(readFileSync(join(dir, 'roteiro.json'), 'utf8'))
    await save(dir, { ...opened, doc: doc(305) })
    expect(versions(opened.id).filter((n) => n.includes('_abertura_300w'))).toHaveLength(1)
    // logo em seguida (menos de 2 min): sem cópia nova
    await save(dir, { ...opened, doc: doc(310) })
    expect(versions(opened.id)).toHaveLength(2)
    // apagou um capítulo: o que estava no disco (310) vira cópia na hora
    await save(dir, { ...opened, doc: doc(100) })
    expect(versions(opened.id).filter((n) => n.includes('_corte_310w'))).toHaveLength(1)
  })

  it('pasta renomeada continua com o mesmo histórico; pasta copiada vira outro roteiro', async () => {
    const dir = join(tmp, 'Steam')
    const { id } = JSON.parse(readFileSync(join(dir, 'roteiro.json'), 'utf8'))
    const copy = join(tmp, 'Steam (2)')
    cpSync(dir, copy, { recursive: true })
    const saved = await save(copy, { ...JSON.parse(readFileSync(join(copy, 'roteiro.json'), 'utf8')), doc: doc(120) })
    expect(saved.id).not.toBe(id)

    const renamed = join(tmp, 'Nova pasta')
    cpSync(dir, renamed, { recursive: true })
    rmSync(dir, { recursive: true, force: true })
    const again = await save(renamed, { ...JSON.parse(readFileSync(join(renamed, 'roteiro.json'), 'utf8')), doc: doc(130) })
    expect(again.id).toBe(id)
    await snapshotNow(renamed, 'antes-de-voltar')
    const info = JSON.parse(readFileSync(join(store(id), 'info.json'), 'utf8'))
    expect(info.dir).toBe(renamed)
    expect(versions(id).some((n) => n.includes('_antes-de-voltar_'))).toBe(true)
  })
})
