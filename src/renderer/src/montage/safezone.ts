/**
 * Safe zone do motion: a área da tela onde texto e gráficos podem ficar sem serem cobertos pela
 * interface das plataformas (botões, legenda, nome do canal no Shorts/Reels/TikTok; bordas de TV
 * no YouTube). Dentro dela, no topo, fica a "faixa persistente" (sub safe zone): o lugar reservado
 * pros elementos que ficam na tela (capítulo, selo do episódio, progresso, logo). Quando a faixa
 * está em uso, o resto do motion não pode encostar nela.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface SafeZones {
  /** onde texto e gráficos podem ficar (px da prévia) */
  safe: Rect
  /** faixa persistente, no topo da safe zone (px da prévia) */
  band: Rect
  /** palco: o que sobra da safe zone embaixo da faixa (px da prévia) */
  stage: Rect
}

/** margens em fração da tela [topo, direita, baixo, esquerda] e altura da faixa (fração da altura) */
const MARGINS: Record<string, { m: [number, number, number, number]; band: number }> = {
  // Shorts/Reels/TikTok: título e botões em cima, coluna de botões à direita, legenda e canal embaixo
  '9:16': { m: [0.12, 0.14, 0.22, 0.06], band: 0.075 },
  '4:5': { m: [0.07, 0.07, 0.12, 0.07], band: 0.08 },
  '1:1': { m: [0.06, 0.06, 0.08, 0.06], band: 0.09 },
  // horizontal: title safe de TV / YouTube (5% em volta)
  '16:9': { m: [0.05, 0.05, 0.05, 0.05], band: 0.1 }
}

export function safeZones(aspect: string | undefined, w: number, h: number): SafeZones {
  const { m, band } = MARGINS[aspect ?? '16:9'] ?? MARGINS['16:9']
  const r = (n: number) => Math.round(n)
  const safe = { x: r(w * m[3]), y: r(h * m[0]), w: r(w * (1 - m[1] - m[3])), h: r(h * (1 - m[0] - m[2])) }
  const bh = r(h * band)
  const gap = r(h * 0.015)
  return {
    safe,
    band: { x: safe.x, y: safe.y, w: safe.w, h: bh },
    stage: { x: safe.x, y: safe.y + bh + gap, w: safe.w, h: safe.h - bh - gap }
  }
}

const box = (r: Rect) => `x ${r.x}, y ${r.y}, largura ${r.w}, altura ${r.h} (de ${r.x},${r.y} até ${r.x + r.w},${r.y + r.h})`

/** seção do prompt com a safe zone e a faixa persistente, em px da prévia */
export function safeZoneDirection(z: SafeZones, size: { w: number; h: number }) {
  const vertical = size.h > size.w
  return [
    `## Safe zone (OBRIGATÓRIO; tela de ${size.w}x${size.h} px)`,
    vertical
      ? `- A plataforma (Shorts/Reels/TikTok) cobre as bordas com botões, legenda e nome do canal. Todo TEXTO, número, ícone, gráfico ou imagem de insert fica INTEIRO dentro da safe zone: ${box(z.safe)}.`
      : `- Todo TEXTO, número, ícone, gráfico ou imagem de insert fica INTEIRO dentro da safe zone: ${box(z.safe)}.`,
    '- Só o fundo (cor, textura, gradiente) e o vídeo de baixo em tela cheia podem passar da safe zone. Elementos podem entrar ou sair de fora dela numa transição rápida, mas parados ficam dentro. Texto grande que não cabe: diminua a fonte ou quebre a linha, nunca deixe vazar.',
    `- Faixa persistente (sub safe zone): ${box(z.band)}. É o lugar RESERVADO pros elementos que ficam na tela por bastante tempo ou o bloco todo: capítulo, selo de episódio ("EP. 12"), indicador de progresso, logo, título fixo do trecho. Ponha esses elementos (e só eles) dentro de um <div id="faixa"> posicionado exatamente nessa faixa, e nada dele sai dela.`,
    `- Se a faixa estiver em uso, o resto do motion fica no palco, embaixo dela: ${box(z.stage)}. Nada (texto, gráfico, seta, imagem) pode passar por cima da faixa nem encostar nela enquanto ela tem algo visível. Se não usar a faixa, não crie o <div id="faixa"> e o palco é a safe zone inteira.`,
    '- Depois de gerar, o Typos mede a posição de cada texto e gráfico em vários momentos da animação; o que estiver fora da safe zone ou em cima da faixa volta pra você corrigir.'
  ].join('\n')
}

/** um elemento fora do lugar, como o checador do Typos achou */
export interface LayoutIssue {
  kind: 'fora' | 'faixa' | 'faixa-vaza'
  what: string
  /** segundos desde o começo do bloco */
  t: number
  rect: Rect
}

/** o pedido de correção que volta pro Claude */
export function issuesTweak(issues: LayoutIssue[], z: SafeZones) {
  const why = { fora: 'está fora da safe zone', faixa: 'passa por cima da faixa persistente', 'faixa-vaza': 'está no #faixa mas sai da faixa' }
  const lines = issues.slice(0, 12).map((i) => {
    const r = i.rect
    return `- "${i.what}" em ${i.t.toFixed(1)}s ${why[i.kind]} (ocupa ${Math.round(r.x)},${Math.round(r.y)} até ${Math.round(r.x + r.w)},${Math.round(r.y + r.h)})`
  })
  return [
    `CORREÇÃO DE SAFE ZONE (automática, do Typos): o checador mediu a animação e achou elementos fora do lugar. Mantenha a ideia e o tempo, só reposicione/redimensione pra que tudo fique dentro da safe zone (${box(z.safe)}) e nada fora do #faixa encoste na faixa persistente (${box(z.band)}) enquanto ela mostra algo.`,
    ...lines,
    issues.length > 12 ? `- e mais ${issues.length - 12} parecidos` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Roda dentro da página do motion (no relógio virtual): mede os textos e gráficos visíveis e devolve
 * o que está fora da safe zone, em cima da faixa ou saindo dela. Fica como string pro executeJavaScript.
 */
export function layoutProbe(z: SafeZones) {
  return `(function(Z){
var tol=3,W=innerWidth,H=innerHeight,out=[];
function inside(r,b){return r.left>=b.x-tol&&r.top>=b.y-tol&&r.right<=b.x+b.w+tol&&r.bottom<=b.y+b.h+tol}
function hits(r,b){return r.left<b.x+b.w-tol&&r.right>b.x+tol&&r.top<b.y+b.h-tol&&r.bottom>b.y+tol}
function shown(el){var o=1;for(var e=el;e&&e.nodeType===1;e=e.parentElement){var cs=getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;o*=+cs.opacity;if(o<0.15)return false}return true}
function onScreen(r){return r.width>1&&r.height>1&&r.right>0&&r.bottom>0&&r.left<W&&r.top<H}
var items=[],tw=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),n,rg=document.createRange();
while((n=tw.nextNode())){var s=n.nodeValue.trim();if(!s)continue;var p=n.parentElement;if(!p||/^(SCRIPT|STYLE|TITLE)$/.test(p.tagName))continue;
  rg.selectNodeContents(n);var rs=rg.getClientRects(),u=null;for(var i=0;i<rs.length;i++){var q=rs[i];if(q.width<1||q.height<1)continue;u=u?{left:Math.min(u.left,q.left),top:Math.min(u.top,q.top),right:Math.max(u.right,q.right),bottom:Math.max(u.bottom,q.bottom)}:{left:q.left,top:q.top,right:q.right,bottom:q.bottom}}
  if(u)items.push({el:p,r:u,what:s.slice(0,40)})}
[].forEach.call(document.querySelectorAll('img,svg,canvas,video'),function(e){if(e.tagName.toLowerCase()==='svg'&&e.parentElement&&e.parentElement.closest('svg'))return;var r=e.getBoundingClientRect();if(r.width*r.height>W*H*0.5)return;
  items.push({el:e,r:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},what:'<'+e.tagName.toLowerCase()+(e.getAttribute('src')?' '+e.getAttribute('src'):e.id?' #'+e.id:e.className&&typeof e.className==='string'?' .'+e.className.split(' ')[0]:'')+'>'})});
items=items.filter(function(i){i.r.width=i.r.right-i.r.left;i.r.height=i.r.bottom-i.r.top;return onScreen(i.r)&&shown(i.el)});
var bandUsed=items.some(function(i){return i.el.closest('#faixa')});
items.forEach(function(i){var f=i.el.closest('#faixa'),k=null;
  if(f){if(!inside(i.r,Z.band))k='faixa-vaza'}else if(!inside(i.r,Z.safe))k='fora';else if(bandUsed&&hits(i.r,Z.band))k='faixa';
  if(k)out.push({kind:k,what:i.what,rect:{x:i.r.left,y:i.r.top,w:i.r.width,h:i.r.height}})});
return out})(${JSON.stringify({ safe: z.safe, band: z.band })})`
}
