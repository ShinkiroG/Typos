# Typos

Editor de roteiros pra YouTube: fala, prompts de motion, transições, sobe som, timeline de áudio e integração com o Claude.

> *týpos* (τύπος), em grego: a marca deixada por um golpe, como um selo na cera. Daí vêm "tipo" e "tipografia".

## Baixar

Na página de [Releases](https://github.com/ShinkiroG/Typos/releases/latest):

- **`Typos-Setup-x.y.z.exe`**: instalador; você escolhe a pasta de instalação.
- **`Typos-x.y.z-portable.zip`**: já "instalado"; extraia em qualquer pasta e abra o `Typos.exe`.

O Windows pode mostrar "O Windows protegeu o computador" (o app não tem assinatura paga). Clique em **Mais informações → Executar assim mesmo**.

### Atualizações
Em **Configurações** (engrenagem):
- **Atualizar automaticamente**: ao abrir, baixa a versão nova em segundo plano e instala quando você fechar o app.
- **Procurar atualizações**: pergunta se quer atualizar; se sim, o app salva, fecha, atualiza e reabre.

Funciona tanto na versão instalada quanto na do .zip.

## Usando

| Atalho | Bloco | Digitando |
|---|---|---|
| Ctrl+1 | Capítulo | `# ` no começo da linha |
| Ctrl+2 | Prompt (motion/Claude) | `[texto]` numa linha |
| Ctrl+3 | Fala | padrão |
| Ctrl+4 | Transição | — |
| Ctrl+5 | Sobe som | — |
| Ctrl+6 | Pausa | — |

- Colar um roteiro com linhas `[instrução]` converte automaticamente.
- **Imagens**: Ctrl+V com o cursor no prompt, arrastar o arquivo ou 📎. Cada imagem tem um status: Referência, Aprovada, **Recortar** ou **Regerar**.
- **Biblioteca**: botão direito num bloco → Salvar na biblioteca (título e imagem opcionais). Arraste de volta pro texto.
- **Formatos**: Longo/Horizontal e Vertical (com limite de 60s), renomeáveis.

### Timeline (ícone de onda no topo)
- **Play/pausa**: Ctrl+P, ou Espaço com a timeline em foco. O texto destaca a palavra atual pelo ppm (palavras/min).
- Clicar no texto ou na régua move o playhead.
- **Música**: o botão Música ou arrastar o arquivo; entra a 20% do volume. Dá pra arrastar, aparar pelas bordas e cortar com **S**.
- **Keyframes de volume**: duplo clique no clipe cria, arrastar o ponto move, botão direito apaga. Fade in/out prontos no painel do clipe.
- **SFX**: gera efeitos com a ElevenLabs. Coloque sua chave em Configurações; ela fica só no seu PC.

### Criar Clipes (recortes curtos)
Na Montagem, **Preparar Clipes** pergunta o tempo mínimo, ideal e máximo dos recortes e a proporção (9:16 por padrão). O Claude lê a transcrição da narração e sugere os melhores trechos: sempre mira o tempo ideal e só passa dele, até o máximo, pra não cortar um assunto no meio.
- O workspace **Clipes** aparece no topo. A pasta **Recortes** fica na área de mídia: clicar num recorte abre a timeline dele (✓ verde = aprovado, ✗ = ainda não).
- **Aprovar short** põe o recorte nos **Exports pendentes** do Render, que exporta tudo em fila (em `render/clipes/`), preenchendo o quadro vertical.

### Claude
O botão **Claude** salva e copia um pedido pronto. É só colar no Claude, que ele lê o `roteiro.md` e os anexos. Recortes feitos pelo Claude vão em `assets/recortes/` e aparecem no app ao lado da imagem original.

**Modelo do motion**: em Configurações → IA, "Motion dos blocos de instrução" escolhe qual Claude faz o motion (Fable 5.2, Fable 5.1, Opus 5.5, Opus 5 ou Sonnet 5.5). Cada bloco pode trocar no seletor **Modelo**, ao lado de "Ao gerar"; "Padrão" usa o das Configurações. Vale pro Claude Code (o seu plano precisa incluir o modelo) e pra chave da Anthropic.

### Efeitos globais (Estilo)
No workspace **Estilo**, a seção **Efeitos globais** tem sliders de **Camera shake** (com velocidade e rotação) e **Grão**. O Typos aplica esses efeitos por cima de todo motion em HTML, na prévia e no clipe final, com a mesma intensidade no vídeo inteiro, e a prévia do estilo mostra o efeito mudando enquanto você arrasta. O Claude é avisado pra não fazer o mesmo efeito no HTML. Clipes já gravados pegam o valor novo quando forem gravados de novo.

### Editar o motion à mão
Cada motion de bloco é um HTML em `previas/<bloco>/motion-*.html`, dentro da pasta do projeto. No painel do bloco, **HTML do motion** abre o arquivo no navegador ou mostra ele na pasta pra abrir num editor. O clipe final é gravado a partir desse arquivo quando você aprova.

## Arquivos de um roteiro
```
Minha pasta/
  roteiro.json   ← fonte (o app lê e grava)
  roteiro.md     ← versão legível com tempos, gerada a cada save (o Claude lê esta)
  assets/        ← imagens, audio/, recortes/
```
Biblioteca, formatos e configurações ficam em `%APPDATA%/Typos/`.

## Desenvolvimento
```
npm install
npm run dev        # abre em modo dev (F12 = DevTools)
npm run dist       # gera dist/Typos-Setup-x.y.z.exe e o .zip
npm run release -- "notas"   # publica no GitHub Releases (precisa do gh logado)
```
Pra lançar uma versão nova: suba o `version` no package.json e, com isso na main, rode o workflow **Release** em Actions (ou envie a tag `vX.Y.Z`). O GitHub compila no Windows e publica sozinho. Pelo PC ainda dá: rode `dist` e depois `release`.
