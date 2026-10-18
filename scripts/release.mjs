// Publica a versão atual no GitHub Releases (instalador + zip portátil + arquivos do auto-update).
// Uso: npm run dist && npm run release -- "notas da versão"
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${version}`
const files = [
  `dist/Typos-Setup-${version}.exe`,
  `dist/Typos-Setup-${version}.exe.blockmap`,
  `dist/Typos-${version}-portable.zip`,
  'dist/latest.yml'
]
const missing = files.filter((f) => !existsSync(f))
if (missing.length) {
  console.error('Faltam arquivos (rode "npm run dist" antes):\n  ' + missing.join('\n  '))
  process.exit(1)
}

// o app portátil confere o .zip baixado contra este hash antes de se atualizar
const zip = `dist/Typos-${version}-portable.zip`
writeFileSync(`${zip}.sha256`, createHash('sha256').update(readFileSync(zip)).digest('hex') + '\n')
files.push(`${zip}.sha256`)

const notes = process.argv.slice(2).join(' ').trim() || `Typos ${version}`
const args = ['release', 'create', tag, ...files, '--title', `Typos ${version}`, '--notes', notes]
// no GitHub Actions, a tag (se ainda não existir) aponta pro commit que foi compilado
if (process.env.GITHUB_SHA) args.push('--target', process.env.GITHUB_SHA)
execFileSync('gh', args, { stdio: 'inherit' })
console.log(`\nPublicado: https://github.com/ShinkiroG/Typos/releases/tag/${tag}`)
