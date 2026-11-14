/**
 * Biblioteca de animação do Typos: um arquivo JS pequeno que fica na pasta do motion (typos-motion.js)
 * e que o HTML do Claude carrega com <script src>. Dá de pronto o que todo motion refaz na mão e erra
 * (curvas, entrada em cascata, texto letra a letra, contador, traço de SVG, texto que cabe na caixa).
 *
 * Tudo é função do tempo: a cada quadro o valor é recalculado do zero a partir do relógio da página.
 * Por isso funciona igual no relógio virtual da gravação, no navegador (abrindo o HTML na mão) e com
 * motion blur (subquadros). Nada aqui usa sorteio nem depende do ritmo dos quadros.
 *
 * Sem DOM e sem Node neste arquivo: o texto da biblioteca vai pro main (que grava o arquivo) e a
 * descrição vai pro prompt.
 */

/** nome do arquivo na pasta do motion */
export const MOTION_LIB_FILE = 'typos-motion.js'

export const MOTION_LIB = `/* Typos motion: biblioteca de animação (gerada pelo Typos; não edite, ela é regravada a cada prévia) */
(function(){
if(window.typos)return;
var c1=1.70158,c3=c1+1;
var E={
linear:function(t){return t},
inQuad:function(t){return t*t},outQuad:function(t){return 1-(1-t)*(1-t)},inOutQuad:function(t){return t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2},
inCubic:function(t){return t*t*t},outCubic:function(t){return 1-Math.pow(1-t,3)},inOutCubic:function(t){return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2},
inQuart:function(t){return t*t*t*t},outQuart:function(t){return 1-Math.pow(1-t,4)},inOutQuart:function(t){return t<.5?8*t*t*t*t:1-Math.pow(-2*t+2,4)/2},
inExpo:function(t){return t<=0?0:Math.pow(2,10*t-10)},outExpo:function(t){return t>=1?1:1-Math.pow(2,-10*t)},
inOutExpo:function(t){return t<=0?0:t>=1?1:t<.5?Math.pow(2,20*t-10)/2:(2-Math.pow(2,-20*t+10))/2},
inBack:function(t){return c3*t*t*t-c1*t*t},outBack:function(t){return 1+c3*Math.pow(t-1,3)+c1*Math.pow(t-1,2)},
outElastic:function(t){return t<=0?0:t>=1?1:Math.pow(2,-10*t)*Math.sin((t*10-.75)*(2*Math.PI/3))+1},
outBounce:function(t){var n=7.5625,d=2.75;return t<1/d?n*t*t:t<2/d?n*(t-=1.5/d)*t+.75:t<2.5/d?n*(t-=2.25/d)*t+.9375:n*(t-=2.625/d)*t+.984375},
spring:function(t){return t>=1?1:1-Math.exp(-6.5*t)*Math.cos(t*Math.PI*3.2)}
};
function ez(e){return typeof e==='function'?e:E[e]||E.outCubic}
function clamp(v){return v<0?0:v>1?1:v}
function list(x){return typeof x==='string'?[].slice.call(document.querySelectorAll(x)):!x?[]:x.nodeType?[x]:x.length!=null?[].slice.call(x):[]}
var BASE={x:0,y:0,scale:1,scaleX:1,scaleY:1,rotate:0,opacity:1,blur:0},TF={x:1,y:1,scale:1,scaleX:1,scaleY:1,rotate:1};
var els=[],frames=[],marks=[],T0=performance.now(),now=0;
function st(el){var s=el.__typos;if(!s){s=el.__typos={tw:{},base:{},unit:{}};els.push(el)}return s}
function num(v){if(typeof v==='number')return{n:v,u:''};var m=/^(-?[\\d.]+)([a-z%]*)$/i.exec(String(v).trim());return m?{n:+m[1],u:m[2]}:{n:0,u:''}}
function base(el,s,k){if(k in BASE)return BASE[k];if(!(k in s.base)){var c=num(getComputedStyle(el)[k]);s.base[k]=c.n;if(!s.unit[k])s.unit[k]=c.u}return s.base[k]}
/* valor da propriedade k no instante t: os tweens em ordem, cada um partindo de onde o anterior parou */
function val(el,s,k,t){var tw=s.tw[k],v=base(el,s,k);for(var i=0;i<tw.length;i++){var w=tw[i],a=w.from==null?v:w.from,b=w.to==null?base(el,s,k):w.to;
  if(t<w.at){if(i===0&&w.from!=null)v=a;break}v=a+(b-a)*w.ease(w.dur>0?clamp((t-w.at)/w.dur):1)}return v}
function paint(el,t){var s=el.__typos,tf=false,o={},k;for(k in s.tw){o[k]=val(el,s,k,t);if(TF[k])tf=true}
  if(tf){var sx=(o.scale==null?1:o.scale)*(o.scaleX==null?1:o.scaleX),sy=(o.scale==null?1:o.scale)*(o.scaleY==null?1:o.scaleY);
    el.style.transform='translate('+(o.x||0).toFixed(2)+'px,'+(o.y||0).toFixed(2)+'px) rotate('+(o.rotate||0).toFixed(3)+'deg) scale('+sx.toFixed(4)+','+sy.toFixed(4)+')'}
  for(k in o){if(TF[k])continue;if(k==='opacity')el.style.opacity=o[k].toFixed(4);else if(k==='blur')el.style.filter=o[k]>0.01?'blur('+o[k].toFixed(2)+'px)':'none';else el.style[k]=o[k].toFixed(3)+(s.unit[k]||'')}}
function apply(t){now=t;for(var i=0;i<els.length;i++)paint(els[i],t);for(i=0;i<frames.length;i++)try{frames[i](t)}catch(e){console.error(e)}
  for(i=0;i<marks.length;i++)if(!marks[i].done&&t>=marks[i].t){marks[i].done=true;try{marks[i].fn(t)}catch(e){console.error(e)}}}
function tick(){apply((performance.now()-T0)/1000);requestAnimationFrame(tick)}
requestAnimationFrame(tick);
function animate(target,o){o=o||{};var at=+o.at||0,dur=o.dur==null?.6:+o.dur,e=ez(o.ease),sg=+o.stagger||0;
  list(target).forEach(function(el,i){var s=st(el),ks={},k;for(k in o.from||{})ks[k]=1;for(k in o.to||{})ks[k]=1;
    for(k in ks){var f=o.from&&k in o.from?num(o.from[k]):null,g=o.to&&k in o.to?num(o.to[k]):null;if((f&&f.u)||(g&&g.u))s.unit[k]=(f&&f.u)||(g&&g.u);else if(!(k in BASE)&&!s.unit[k]){base(el,s,k);if(!s.unit[k]&&k!=='lineHeight'&&k!=='zIndex'&&k!=='flexGrow')s.unit[k]='px'}
      (s.tw[k]=s.tw[k]||[]).push({at:at+i*sg,dur:dur,ease:e,from:f?f.n:null,to:g?g.n:null});s.tw[k].sort(function(a,b){return a.at-b.at})}
    paint(el,now)});return T}
function dist(o){return o&&o.dist!=null?+o.dist:Math.round(Math.min(innerWidth,innerHeight)*.06)}
var IN={fade:function(){return{opacity:0}},up:function(d){return{opacity:0,y:d}},down:function(d){return{opacity:0,y:-d}},left:function(d){return{opacity:0,x:d}},right:function(d){return{opacity:0,x:-d}},
  pop:function(){return{opacity:0,scale:.6}},zoom:function(){return{opacity:0,scale:1.25}},blur:function(d){return{opacity:0,blur:d/3}}};
function enter(target,kind,o){o=o||{};var f=(IN[kind]||IN.fade)(dist(o)),to={},k;for(k in f)to[k]=BASE[k];
  return animate(target,{from:f,to:to,at:o.at,dur:o.dur==null?.5:o.dur,ease:o.ease||(kind==='pop'?'outBack':'outCubic'),stagger:o.stagger})}
function leave(target,kind,o){o=o||{};var f=(IN[kind]||IN.fade)(dist(o)),k;for(k in f)if(k==='x'||k==='y')f[k]=-f[k];
  return animate(target,{to:f,at:o.at,dur:o.dur==null?.4:o.dur,ease:o.ease||'inCubic',stagger:o.stagger})}
function span(txt,cls){var s=document.createElement('span');s.className=cls;s.style.display='inline-block';s.style.whiteSpace='pre';s.textContent=txt;return s}
function split(target,by){var out=[];list(target).forEach(function(el){var words=el.textContent.split(/(\\s+)/),ws=[];el.textContent='';
    words.forEach(function(w){if(!w)return;if(/^\\s+$/.test(w)){el.appendChild(document.createTextNode(' '));return}
      var s=span(by==='chars'?'':w,'ty-word');if(by==='chars')Array.from(w).forEach(function(ch){var c=span(ch,'ty-char');s.appendChild(c);out.push(c)});el.appendChild(s);ws.push(s)});
    if(by==='chars')return;if(by!=='lines'){out=out.concat(ws);return}
    var lines=[],top=null;ws.forEach(function(w){var y=w.offsetTop;if(top===null||Math.abs(y-top)>2){lines.push([]);top=y}lines[lines.length-1].push(w)});
    el.textContent='';lines.forEach(function(ln){var l=span('','ty-line');l.style.display='block';l.style.whiteSpace='normal';ln.forEach(function(w,i){if(i)l.appendChild(document.createTextNode(' '));l.appendChild(w)});el.appendChild(l);out.push(l)})});
  return out}
function count(target,o){o=o||{};var a=+o.from||0,b=+o.to||0,at=+o.at||0,dur=o.dur==null?1:+o.dur,e=ez(o.ease),dec=o.decimals|0,els2=list(target);
  var f=function(t){var v=a+(b-a)*e(dur>0?clamp((t-at)/dur):1),s=v.toLocaleString(o.locale||'pt-BR',{minimumFractionDigits:dec,maximumFractionDigits:dec});
    els2.forEach(function(el){var x=(o.prefix||'')+s+(o.suffix||'');if(el.textContent!==x)el.textContent=x})};frames.push(f);f(now);return T}
function draw(target,o){o=o||{};var at=+o.at||0,dur=o.dur==null?1:+o.dur,e=ez(o.ease||'inOutCubic'),ps=list(target).map(function(p){var n=p.getTotalLength?p.getTotalLength():0;p.style.strokeDasharray=n;return{p:p,n:n}});
  var f=function(t){var k=e(dur>0?clamp((t-at)/dur):1);ps.forEach(function(x){x.p.style.strokeDashoffset=(x.n*(1-k)).toFixed(2)})};frames.push(f);f(now);return T}
function type(target,o){o=o||{};var at=+o.at||0,els2=list(target).map(function(el){return{el:el,txt:Array.from(el.textContent)}});
  var f=function(t){els2.forEach(function(x){var dur=o.dur==null?x.txt.length*.04:+o.dur,n=Math.round(x.txt.length*(dur>0?clamp((t-at)/dur):1)),s=x.txt.slice(0,n).join('');if(x.el.textContent!==s)x.el.textContent=s})};frames.push(f);f(now);return T}
/* diminui a fonte até o texto caber na caixa (a do pai, ou maxWidth/maxHeight em px) */
function fit(target,o){o=o||{};list(target).forEach(function(el){var p=el.parentElement||document.body,mw=o.maxWidth||p.clientWidth,mh=o.maxHeight||p.clientHeight,min=o.min||8,fs=parseFloat(getComputedStyle(el).fontSize)||16;
    for(var i=0;i<60&&fs>min&&(el.scrollWidth>mw+1||el.offsetWidth>mw+1||el.offsetHeight>mh+1);i++){fs=Math.max(min,fs*.94);el.style.fontSize=fs.toFixed(2)+'px'}});return T}
var T=window.typos={version:1,ease:E,animate:animate,in:enter,out:leave,split:split,count:count,draw:draw,type:type,fit:fit,
  at:function(t,fn){marks.push({t:+t||0,fn:fn,done:false});return T},frame:function(fn){frames.push(fn);return T},time:function(){return now},
  seek:function(t){apply(+t||0);return T}};
})();
`

/** seção do prompt: como usar a biblioteca (parte fixa do pedido, igual pra todos os blocos do estilo) */
export function motionLibPrompt(): string[] {
  return [
    '## Biblioteca de animação do Typos (use em vez de escrever o motor de animação na mão)',
    `O arquivo ${MOTION_LIB_FILE} já está na pasta do HTML. Carregue no <head> com <script src="${MOTION_LIB_FILE}"></script> e chame \`typos\` num <script> no fim do <body>. Os tempos são em segundos desde o começo do bloco, então a sincronia com a fala é só escrever o segundo certo em \`at\`. Tudo é calculado pelo tempo (sai igual na prévia e no clipe final).`,
    '- `typos.animate(alvo, { from: {…}, to: {…}, at: 1.2, dur: 0.6, ease: "outCubic", stagger: 0.05 })`: alvo é um seletor CSS, um elemento ou uma lista. Propriedades: x, y (px), scale, scaleX, scaleY, rotate (graus), opacity, blur (px) e qualquer propriedade CSS numérica em camelCase (width, letterSpacing, "50%" como texto). Com `from`, o elemento já fica nesse estado desde o começo. Sem `to`, volta ao estado natural. Vários animate no mesmo elemento encadeiam (cada um parte de onde o anterior parou).',
    '- `typos.in(alvo, tipo, { at, dur, stagger })` e `typos.out(alvo, tipo, { at, dur })`: entradas e saídas prontas. Tipos: fade, up, down, left, right, pop, zoom, blur.',
    '- `typos.split(alvo, "chars" | "words" | "lines")`: quebra o texto em <span> e devolve a lista (pra entrada em cascata: `typos.in(typos.split("#titulo", "words"), "up", { at: 0.4, stagger: 0.06 })`).',
    '- `typos.count(alvo, { from: 0, to: 1500, at, dur, decimals: 0, prefix: "R$ ", suffix: "" })`: número subindo. `typos.type(alvo, { at, dur })`: texto digitado. `typos.draw("path, line", { at, dur })`: traço de SVG se desenhando (o elemento precisa de stroke).',
    '- `typos.fit(alvo, { maxWidth, maxHeight })`: diminui a fonte até o texto caber na caixa (padrão: a do pai). Use em título ou número que pode estourar a safe zone; chame antes do split.',
    '- `typos.at(2.5, fn)`: roda fn uma vez nesse segundo. `typos.frame(fn)`: roda fn(t) a cada quadro, pra animação escrita como função do tempo. `typos.time()`: o segundo atual.',
    '- Curvas (`ease`): linear, in/out/inOut + Quad, Cubic, Quart, Expo; inBack, outBack, outElastic, outBounce, spring; ou uma função (t de 0 a 1).',
    '- O `animate` escreve o `transform` do elemento: não ponha `transform` no CSS do mesmo elemento (pra centralizar ou girar parado, use um elemento pai). Animações CSS e requestAnimationFrame próprios continuam valendo e podem ser misturados.',
    ''
  ]
}
