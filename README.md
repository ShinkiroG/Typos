# Typos

Editor de roteiros pra YouTube (Electron + React + TipTap).

## Rodar
- Duplo clique em `Abrir Typos.bat` (compila e abre)
- Desenvolvimento: `npm run dev` (F12 abre o DevTools)

## Elementos
| Atalho | Bloco | Como criar digitando |
|---|---|---|
| Ctrl+1 | Fala | padrão |
| Ctrl+2 | Prompt (motion/Claude) | digite `[texto]` numa linha |
| Ctrl+3 | Transição | — |
| Ctrl+4 | Sobe som | — |
| Ctrl+5 | Capítulo | `# ` no começo da linha |

- Colar um roteiro com linhas `[instrução]` converte automaticamente.
- Imagem: Ctrl+V com o cursor no prompt, arrastar arquivo, ou 📎.
- Botão direito num bloco → Salvar na biblioteca / Transformar em / Excluir.

## Arquivos de um roteiro
```
Minha pasta/
  roteiro.json   ← fonte (o app lê/grava)
  roteiro.md     ← versão legível gerada a cada save (é o que o Claude lê)
  assets/        ← imagens anexadas
```
Biblioteca e formatos ficam em `%APPDATA%/typos/`.
