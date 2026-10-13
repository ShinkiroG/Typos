// Publica a versão atual no GitHub Releases (instalador + zip portátil + arquivos do auto-update).
// Uso: npm run dist && npm run release -- "notas da versão"
// Os instaladores ficam no repositório público ShinkiroG/Typos_Release (o código fica no ShinkiroG/Typos).
// Com --ponte, publica também no ShinkiroG/Typos, pra versões antigas (que procuram atualização lá)
// acharem esta e passarem a usar o Typos_Release. Use antes de deixar o Typos privado.
import { readFileSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'

const RELEASE_REPO = 'ShinkiroG/Typos_Release'
const OLD_REPO = 'ShinkiroG/Typos'

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

const args = process.argv.slice(2)
const bridge = args.includes('--ponte')
const notes = args.filter((a) => a !== '--ponte').join(' ') || `Typos ${version}`
const repos = bridge ? [RELEASE_REPO, OLD_REPO] : [RELEASE_REPO]
for (const repo of repos) {
  execFileSync('gh', ['release', 'create', tag, ...files, '--repo', repo, '--title', `Typos ${version}`, '--notes', notes], { stdio: 'inherit' })
  console.log(`\nPublicado: https://github.com/${repo}/releases/tag/${tag}`)
}
