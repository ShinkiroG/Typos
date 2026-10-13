import { createReadStream, promises as fs } from 'fs'
import { crc32 } from 'zlib'

/**
 * Escreve um .zip sem compressão (vídeo e áudio já vêm comprimidos; assim é rápido e
 * não pesa a CPU). Lê cada arquivo uma vez só: o cabeçalho sai com o tamanho do stat e o
 * CRC é corrigido no lugar depois. Passou de 4 GB (arquivo, posição ou total), usa ZIP64.
 */

const MAX32 = 0xffffffff

interface Entry {
  name: Buffer
  crc: number
  size: number
  offset: number
  time: number
  date: number
}

function dosTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

function zip64Extra(fields: number[]) {
  const b = Buffer.alloc(4 + fields.length * 8)
  b.writeUInt16LE(0x0001, 0)
  b.writeUInt16LE(fields.length * 8, 2)
  fields.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + i * 8))
  return b
}

export async function writeZip(
  out: string,
  files: { path: string; name: string }[],
  onProgress?: (done: number, total: number) => void,
  /** só pra teste: força ZIP64 mesmo em arquivo pequeno */
  force64 = false
) {
  const fh = await fs.open(out, 'w')
  const entries: Entry[] = []
  let pos = 0
  const sizes = await Promise.all(files.map((f) => fs.stat(f.path)))
  const total = sizes.reduce((s, st) => s + st.size, 0)
  let done = 0
  try {
    for (const [i, f] of files.entries()) {
      const st = sizes[i]
      const name = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8')
      const { time, date } = dosTime(st.mtime)
      const big = force64 || st.size >= MAX32
      const extra = big ? zip64Extra([st.size, st.size]) : Buffer.alloc(0)
      const h = Buffer.alloc(30)
      h.writeUInt32LE(0x04034b50, 0)
      h.writeUInt16LE(big ? 45 : 20, 4)
      h.writeUInt16LE(0x0800, 6) // nome em UTF-8
      h.writeUInt16LE(0, 8) // sem compressão
      h.writeUInt16LE(time, 10)
      h.writeUInt16LE(date, 12)
      h.writeUInt32LE(0, 14) // CRC: corrigido depois
      h.writeUInt32LE(big ? MAX32 : st.size, 18)
      h.writeUInt32LE(big ? MAX32 : st.size, 22)
      h.writeUInt16LE(name.length, 26)
      h.writeUInt16LE(extra.length, 28)
      const offset = pos
      const head = Buffer.concat([h, name, extra])
      await fh.write(head, 0, head.length, pos)
      pos += head.length
      let crc = 0
      let wrote = 0
      for await (const chunk of createReadStream(f.path, { highWaterMark: 1 << 20 })) {
        const c = chunk as Buffer
        crc = crc32(c, crc)
        await fh.write(c, 0, c.length, pos)
        pos += c.length
        wrote += c.length
        done += c.length
        onProgress?.(done, total)
      }
      if (wrote !== st.size) throw new Error(`${f.name} mudou de tamanho durante a exportação`)
      const cb = Buffer.alloc(4)
      cb.writeUInt32LE(crc >>> 0, 0)
      await fh.write(cb, 0, 4, offset + 14)
      entries.push({ name, crc: crc >>> 0, size: st.size, offset, time, date })
    }

    // diretório central
    const cdStart = pos
    for (const e of entries) {
      const bigSize = force64 || e.size >= MAX32
      const bigOff = force64 || e.offset >= MAX32
      const fields = [...(bigSize ? [e.size, e.size] : []), ...(bigOff ? [e.offset] : [])]
      const extra = fields.length ? zip64Extra(fields) : Buffer.alloc(0)
      const c = Buffer.alloc(46)
      c.writeUInt32LE(0x02014b50, 0)
      c.writeUInt16LE(45, 4)
      c.writeUInt16LE(fields.length ? 45 : 20, 6)
      c.writeUInt16LE(0x0800, 8)
      c.writeUInt16LE(0, 10)
      c.writeUInt16LE(e.time, 12)
      c.writeUInt16LE(e.date, 14)
      c.writeUInt32LE(e.crc, 16)
      c.writeUInt32LE(bigSize ? MAX32 : e.size, 20)
      c.writeUInt32LE(bigSize ? MAX32 : e.size, 24)
      c.writeUInt16LE(e.name.length, 28)
      c.writeUInt16LE(extra.length, 30)
      c.writeUInt32LE(bigOff ? MAX32 : e.offset, 42)
      const rec = Buffer.concat([c, e.name, extra])
      await fh.write(rec, 0, rec.length, pos)
      pos += rec.length
    }
    const cdSize = pos - cdStart
    const need64 = force64 || entries.length > 0xffff || cdStart >= MAX32 || cdSize >= MAX32
    if (need64) {
      const z = Buffer.alloc(56)
      z.writeUInt32LE(0x06064b50, 0)
      z.writeBigUInt64LE(44n, 4)
      z.writeUInt16LE(45, 12)
      z.writeUInt16LE(45, 14)
      z.writeBigUInt64LE(BigInt(entries.length), 24)
      z.writeBigUInt64LE(BigInt(entries.length), 32)
      z.writeBigUInt64LE(BigInt(cdSize), 40)
      z.writeBigUInt64LE(BigInt(cdStart), 48)
      const loc = Buffer.alloc(20)
      loc.writeUInt32LE(0x07064b50, 0)
      loc.writeBigUInt64LE(BigInt(pos), 8)
      loc.writeUInt32LE(1, 16)
      const both = Buffer.concat([z, loc])
      await fh.write(both, 0, both.length, pos)
      pos += both.length
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(need64 ? 0xffff : entries.length, 8)
    end.writeUInt16LE(need64 ? 0xffff : entries.length, 10)
    end.writeUInt32LE(need64 ? MAX32 : cdSize, 12)
    end.writeUInt32LE(need64 ? MAX32 : cdStart, 16)
    await fh.write(end, 0, end.length, pos)
  } finally {
    await fh.close()
  }
}
