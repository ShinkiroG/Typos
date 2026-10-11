// Gera build/icon.ico a partir de build/icon.png (precisa do ffmpeg no PATH).
// Tamanhos pequenos vão como bitmap (DIB 32 bits): o Windows mostra ícone genérico
// na barra de tarefas/atalhos quando eles vêm em PNG. Só o 256 vai em PNG.
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

const SRC = 'build/icon.png'
const OUT = 'build/icon.ico'
const SIZES = [16, 24, 32, 48, 64, 128, 256]

const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-i', SRC, ...args, '-'], { maxBuffer: 64 << 20 })

const images = SIZES.map((s) => {
  const scale = `scale=${s}:${s}:flags=lanczos`
  if (s === 256) return { s, data: ff(['-vf', scale, '-f', 'image2pipe', '-c:v', 'png']) }
  const bgra = ff(['-vf', scale, '-f', 'rawvideo', '-pix_fmt', 'bgra'])
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(s, 4)
  header.writeInt32LE(s * 2, 8) // altura dobrada (cor + máscara)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(s * s * 4, 20)
  // linhas de baixo pra cima
  const pixels = Buffer.alloc(s * s * 4)
  for (let y = 0; y < s; y++) bgra.copy(pixels, (s - 1 - y) * s * 4, y * s * 4, (y + 1) * s * 4)
  const maskRow = Math.ceil(s / 32) * 4
  const mask = Buffer.alloc(maskRow * s) // tudo 0: a transparência vem do alfa
  return { s, data: Buffer.concat([header, pixels, mask]) }
})

const dir = Buffer.alloc(6 + 16 * images.length)
dir.writeUInt16LE(1, 2)
dir.writeUInt16LE(images.length, 4)
let offset = dir.length
images.forEach(({ s, data }, i) => {
  const o = 6 + i * 16
  dir[o] = s === 256 ? 0 : s
  dir[o + 1] = s === 256 ? 0 : s
  dir.writeUInt16LE(1, o + 4)
  dir.writeUInt16LE(32, o + 6)
  dir.writeUInt32LE(data.length, o + 8)
  dir.writeUInt32LE(offset, o + 12)
  offset += data.length
})
writeFileSync(OUT, Buffer.concat([dir, ...images.map((x) => x.data)]))
console.log(`${OUT}: ${SIZES.join(', ')} (${(readFileSync(OUT).length / 1024).toFixed(0)} KB)`)
