// Publica a versão atual no GitHub Releases (instalador + zip portátil + arquivos do auto-update).
// Uso: npm run dist && npm run release -- "notas da versão"
import { readFileSync, existsSync } from 'fs'
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

const notes = process.argv.slice(2).join(' ') || `Typos ${version}`
execFileSync('gh', ['release', 'create', tag, ...files, '--title', `Typos ${version}`, '--notes', notes], { stdio: 'inherit' })
console.log(`\nPublicado: https://github.com/ShinkiroG/Typos/releases/tag/${tag}`)
