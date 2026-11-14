/**
 * Efeitos globais do estilo: aplicados pelo Typos POR CIMA de todo motion em HTML (prévia, clipe
 * final e a demo do Estilo), em vez de cada HTML do Claude fazer o seu. Assim a intensidade é uma
 * só no vídeo inteiro e dá pra mexer num slider sem pedir motion novo.
 *
 * O script anda no relógio da página: na gravação é o relógio virtual do Typos (quadro a quadro,
 * sempre igual); na prévia do Estilo é o relógio de verdade, e os sliders mudam os valores por
 * postMessage sem recarregar a demo.
 *
 * Sem DOM e sem Node: o renderer e o main usam este arquivo.
 */

export interface GlobalFx {
  /** camera shake: quanto a câmera treme (0 = desligado, 100 = forte) */
  shake?: number
  /** velocidade do shake: 0 = balanço lento (câmera na mão), 100 = tremor rápido */
  shakeSpeed?: number
  /** quanto do shake vira rotação (0 = só desloca, 100 = gira até ~2°) */
  shakeRotate?: number
  /** grão de filme por cima de tudo (0 = desligado) */
  grain?: number
}

export const FX_DEFAULTS: Required<GlobalFx> = { shake: 0, shakeSpeed: 35, shakeRotate: 30, grain: 0 }

const clamp = (n: unknown, d: number) => {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : d
}

/** valores completos e dentro de 0..100 */
export function normFx(fx?: GlobalFx | null): Required<GlobalFx> {
  return {
    shake: clamp(fx?.shake, FX_DEFAULTS.shake),
    shakeSpeed: clamp(fx?.shakeSpeed, FX_DEFAULTS.shakeSpeed),
    shakeRotate: clamp(fx?.shakeRotate, FX_DEFAULTS.shakeRotate),
    grain: clamp(fx?.grain, FX_DEFAULTS.grain)
  }
}

/** algum efeito ligado? */
export const fxActive = (fx?: GlobalFx | null) => {
  const n = normFx(fx)
  return n.shake > 0 || n.grain > 0
}

/** deslocamento máximo do shake, em fração do lado menor do quadro (100 → 2,5%) */
export const SHAKE_MAX = 0.025
/** rotação máxima do shake (graus) */
export const ROTATE_MAX = 2

/** frequência base do shake (Hz): 0 → 0,3 Hz (balanço), 100 → 6 Hz (tremor) */
export const shakeHz = (speed: number) => 0.3 + (Math.max(0, Math.min(100, speed)) / 100) * 5.7

/**
 * Ruído suave e determinístico (−1..1): soma de senos com frequências que não se repetem juntas.
 * O mesmo t dá sempre o mesmo valor, então a prévia de 12 fps e o clipe final tremem igual.
 */
export function wobble(t: number, hz: number, seed: number) {
  const w = 2 * Math.PI * hz * t
  return 0.5 * Math.sin(w + seed * 1.7) + 0.3 * Math.sin(w * 2.13 + seed * 4.1 + 1.3) + 0.2 * Math.sin(w * 3.71 + seed * 2.9 + 2.2)
}

/**
 * Quanto o quadro precisa crescer pra borda nunca aparecer com esse shake: o deslocamento dos dois
 * lados mais o canto que a rotação puxa pra dentro.
 */
export function coverScale(fx: GlobalFx, w: number, h: number) {
  const n = normFx(fx)
  if (!n.shake) return 1
  const amt = n.shake / 100
  const lo = Math.max(1, Math.min(w, h))
  const hi = Math.max(w, h)
  const th = ((amt * (n.shakeRotate / 100) * ROTATE_MAX) * Math.PI) / 180
  return Math.cos(th) + (hi / lo) * Math.sin(th) + 2 * amt * SHAKE_MAX * 1.02
}

/** transform do quadro no tempo t (s), pra um quadro w×h px */
export function shakeAt(fx: GlobalFx, t: number, w: number, h: number) {
  const n = normFx(fx)
  if (!n.shake) return { x: 0, y: 0, r: 0, s: 1 }
  const amt = n.shake / 100
  const hz = shakeHz(n.shakeSpeed)
  const px = amt * SHAKE_MAX * Math.min(w, h)
  return {
    x: px * wobble(t, hz, 1),
    y: px * wobble(t, hz * 0.93, 2),
    r: amt * (n.shakeRotate / 100) * ROTATE_MAX * wobble(t, hz * 0.71, 3),
    s: coverScale(n, w, h)
  }
}

/** texto pro prompt do Claude: o Typos já faz esses efeitos, então o HTML não deve fazer de novo */
export function fxPrompt(fx?: GlobalFx | null): string[] {
  if (!fxActive(fx)) return []
  const n = normFx(fx)
  const L = ['## Efeitos globais (o Typos aplica por cima do seu HTML)']
  if (n.shake) L.push(`- Camera shake na intensidade ${n.shake}/100 em todo o vídeo. NÃO faça shake nem tremida de câmera no HTML, mesmo que a câmera do estilo peça "câmera na mão" ou shake (o Typos já faz, e ficaria dobrado); deixe uns 3% de sobra nas bordas, que o quadro é ampliado de leve pra tremer.`)
  if (n.grain) L.push(`- Grão de filme na intensidade ${n.grain}/100 por cima de tudo. NÃO ponha grão ou ruído no HTML.`)
  return [...L, '']
}

/**
 * O mesmo cálculo do shakeAt/coverScale, em JS puro pra rodar dentro da página (texto fixo: não
 * dá pra usar Function.toString, que o minificador do renderer muda). O teste confere que os dois
 * dão o mesmo resultado.
 */
export const FX_PAGE_MATH = `
function fxN(v,d){v=Number(v);return isFinite(v)?Math.max(0,Math.min(100,Math.round(v))):d}
function fxNorm(f){f=f||{};return{shake:fxN(f.shake,${FX_DEFAULTS.shake}),shakeSpeed:fxN(f.shakeSpeed,${FX_DEFAULTS.shakeSpeed}),shakeRotate:fxN(f.shakeRotate,${FX_DEFAULTS.shakeRotate}),grain:fxN(f.grain,${FX_DEFAULTS.grain})}}
function fxWob(t,hz,seed){var w=2*Math.PI*hz*t;return 0.5*Math.sin(w+seed*1.7)+0.3*Math.sin(w*2.13+seed*4.1+1.3)+0.2*Math.sin(w*3.71+seed*2.9+2.2)}
function fxShake(n,t,W,H){if(!n.shake)return{x:0,y:0,r:0,s:1};var a=n.shake/100,hz=0.3+n.shakeSpeed/100*5.7,px=a*${SHAKE_MAX}*Math.min(W,H),
lo=Math.max(1,Math.min(W,H)),hi=Math.max(W,H),th=a*(n.shakeRotate/100)*${ROTATE_MAX}*Math.PI/180;
return{x:px*fxWob(t,hz,1),y:px*fxWob(t,hz*0.93,2),r:a*(n.shakeRotate/100)*${ROTATE_MAX}*fxWob(t,hz*0.71,3),s:Math.cos(th)+(hi/lo)*Math.sin(th)+2*a*${SHAKE_MAX}*1.02}}
`

/**
 * Script que liga os efeitos numa página de motion. Vai depois do relógio do Typos (quando tem),
 * pra andar junto com ele. `live`: escuta postMessage({ typosFx }) pra trocar os valores na hora.
 */
export function fxScript(fx: GlobalFx | null | undefined, live = false) {
  return `<script>(function(){
${FX_PAGE_MATH}
var P=fxNorm(${JSON.stringify(normFx(fx))}),cv=null,ctx=null,img=null,lastG=-1,root=document.documentElement;
${live ? "window.addEventListener('message',function(e){if(e.data&&e.data.typosFx){P=fxNorm(e.data.typosFx);lastG=-1}});" : ''}
function grain(t,W,H){
  if(!P.grain){if(cv)cv.style.display='none';return}
  if(!cv){if(!document.body)return;cv=document.createElement('canvas');cv.setAttribute('data-typos-fx','grain');
    cv.style.cssText='position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;image-rendering:pixelated';
    root.appendChild(cv);ctx=cv.getContext('2d');if(!ctx)return}
  cv.style.display='block';
  var w=Math.max(2,Math.min(1280,Math.round(W/2))),h=Math.max(2,Math.round(w*H/W));
  if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h;img=null;lastG=-1}
  var k=Math.floor(t*24);if(k===lastG)return;lastG=k;
  img=img||ctx.createImageData(w,h);var d=new Uint32Array(img.data.buffer),a=Math.round(P.grain/100*70),s=((k+1)*2654435761)>>>0;
  for(var i=0;i<d.length;i++){s^=s<<13;s^=s>>>17;s^=s<<5;var v=s&255;d[i]=((a<<24)|(v<<16)|(v<<8)|v)>>>0}
  ctx.putImageData(img,0,0)}
function frame(ms){
  var W=window.innerWidth||1,H=window.innerHeight||1,t=(ms||0)/1000;
  try{
    if(P.shake){var o=fxShake(P,t,W,H);
      root.style.minHeight='100vh';root.style.minWidth='100vw';
      root.style.transformOrigin=(W/2)+'px '+(H/2)+'px';
      root.style.transform='translate('+o.x.toFixed(2)+'px,'+o.y.toFixed(2)+'px) rotate('+o.r.toFixed(3)+'deg) scale('+o.s.toFixed(4)+')'}
    else if(root.style.transform)root.style.transform='';
    grain(t,W,H)
  }catch(e){}
  requestAnimationFrame(frame)}
requestAnimationFrame(frame);
})();</script>`
}

/** põe o script dos efeitos no HTML, logo depois do <head> (ou depois do relógio, se `after` estiver lá) */
export function withFx(html: string, fx: GlobalFx | null | undefined, opts: { live?: boolean; after?: string } = {}) {
  if (!opts.live && !fxActive(fx)) return html
  const s = fxScript(fx, opts.live)
  if (opts.after) {
    const i = html.indexOf(opts.after)
    if (i >= 0) return html.slice(0, i + opts.after.length) + s + html.slice(i + opts.after.length)
  }
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + s)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + '<head>' + s + '</head>')
  return '<!doctype html><html><head>' + s + '</head><body>' + html + '</body></html>'
}
