/**
 * After Effects no motion (sem Electron aqui, pra dar pra testar): acha o AfterFX.exe/aerender.exe,
 * monta o script .jsx que o AE roda pra criar o projeto do bloco e lê o que o aerender escreve.
 *
 * O Claude escreve só o miolo (o que vai dentro da composição); o Typos embrulha com um começo fixo
 * (projeto novo, composição no tamanho/tempo do bloco, áudio do trecho, funções pra importar os arquivos
 * do bloco) e um fim fixo (fila de render, salvar o .aep e avisar o Typos que terminou).
 */

/** pastas do Adobe onde o AE costuma ficar: "Adobe After Effects 2025", "Adobe After Effects CC 2019"… */
export function aeYear(folder: string): number | null {
  const m = folder.match(/^Adobe After Effects(?: CC)? (\d{4})$/i)
  return m ? Number(m[1]) : null
}

/** versões que o Typos usa por padrão, na ordem (o autor trabalha no 2025 e no 2024) */
export const AE_PREFERRED = [2025, 2024]

/**
 * As pastas do AE achadas, na ordem em que o Typos tenta: primeiro as preferidas (2025, 2024),
 * depois as outras da mais nova pra mais velha (uma 2026 instalada junto não passa na frente).
 */
export function pickAeFolders(names: string[]): string[] {
  const rank = (y: number) => {
    const i = AE_PREFERRED.indexOf(y)
    return i >= 0 ? i : AE_PREFERRED.length
  }
  return names
    .map((n) => ({ n, y: aeYear(n) }))
    .filter((x): x is { n: string; y: number } => x.y !== null)
    .sort((a, z) => rank(a.y) - rank(z.y) || z.y - a.y)
    .map((x) => x.n)
}

/** texto JS seguro pra pôr no script (caminho com barras normais, que o ExtendScript entende) */
export const jsxStr = (s: string) => JSON.stringify(s.replace(/\\/g, '/'))

export interface AeScriptJob {
  /** miolo escrito pelo Claude (ExtendScript, ES3) */
  body: string
  /** pasta do bloco no AE (arquivos do bloco, áudio e render ficam aqui) */
  dir: string
  /** projeto que será salvo */
  aep: string
  /** onde o AE escreve "OK" ou "ERRO\n…" quando acaba */
  result: string
  /** pasta onde o aerender grava o vídeo */
  renderDir: string
  width: number
  height: number
  seconds: number
  fps: number
  /** nome do WAV do trecho dentro de `dir` (vira uma camada de áudio de referência) */
  wav?: string
}

/** o começo do script, até a linha antes do miolo do Claude */
function prelude(j: AeScriptJob) {
  return [
    '(function () {',
    `var RESULT = File(${jsxStr(j.result)});`,
    'function typosDone(msg) { RESULT.encoding = "UTF-8"; RESULT.open("w"); RESULT.write(msg); RESULT.close(); }',
    'var typosErr = null;',
    'try {',
    '  app.beginSuppressDialogs();',
    '  var proj = app.newProject();',
    '  if (!proj) { typosDone("ERRO\\nO After Effects não abriu um projeto novo (ele pediu pra salvar o projeto que estava aberto e foi cancelado?)."); return; }',
    `  var DIR = Folder(${jsxStr(j.dir)});`,
    `  var comp = proj.items.addComp("Typos", ${Math.round(j.width)}, ${Math.round(j.height)}, 1, ${j.seconds.toFixed(4)}, ${j.fps});`,
    '  comp.bgColor = [0, 0, 0];',
    '  function file(name) { return File(DIR.fsName + "/" + name); }',
    '  var imported = {};',
    '  function importFile(name) {',
    '    if (imported[name]) return imported[name];',
    '    var f = file(name);',
    '    if (!f.exists) throw new Error("Arquivo não encontrado na pasta do bloco: " + name);',
    '    var it = proj.importFile(new ImportOptions(f));',
    '    imported[name] = it;',
    '    return it;',
    '  }',
    '  function addFile(name) { return comp.layers.add(importFile(name)); }',
    ...(j.wav
      ? [
          `  var typosAudio = comp.layers.add(importFile(${jsxStr(j.wav)}));`,
          '  typosAudio.name = "Áudio do trecho (referência, o Typos põe o som de novo)";',
          '  typosAudio.locked = true;'
        ]
      : ['  var typosAudio = null;']),
    '  (function (comp, file, importFile, addFile) {'
  ]
}

/** quantas linhas vêm antes do miolo (pra dizer ao Claude a linha certa do erro) */
export const bodyOffset = (j: AeScriptJob) => prelude(j).length

/** o script inteiro que o AE roda */
export function aeScript(j: AeScriptJob): string {
  return [
    ...prelude(j),
    j.body.replace(/\r\n/g, '\n'),
    '  })(comp, file, importFile, addFile);',
    '  if (typosAudio) { typosAudio.locked = false; typosAudio.moveToEnd(); typosAudio.locked = true; }',
    '  try { comp.openInViewer(); } catch (e1) {}',
    '  while (proj.renderQueue.numItems) proj.renderQueue.item(1).remove();',
    '  var rq = proj.renderQueue.items.add(comp);',
    '  var rsT = ["Best Settings", "Melhores configurações"];',
    '  for (var i = 0; i < rsT.length; i++) { try { rq.applyTemplate(rsT[i]); break; } catch (e2) {} }',
    '  var om = rq.outputModule(1);',
    '  var omT = ["High Quality", "Alta qualidade"];',
    '  for (var k = 0; k < omT.length; k++) { try { om.applyTemplate(omT[k]); break; } catch (e3) {} }',
    `  Folder(${jsxStr(j.renderDir)}).create();`,
    `  om.file = File(${jsxStr(j.renderDir + '/clipe')});`,
    `  proj.save(File(${jsxStr(j.aep)}));`,
    '} catch (e) {',
    `  typosErr = (e.line > ${bodyOffset(j)} ? "linha " + (e.line - ${bodyOffset(j)}) + ": " : "") + e.toString();`,
    '} finally {',
    '  try { app.endSuppressDialogs(false); } catch (e4) {}',
    '}',
    'typosDone(typosErr ? "ERRO\\n" + typosErr : "OK");',
    '})();',
    ''
  ].join('\n')
}

/** o que o AE escreveu no arquivo de resultado */
export function parseResult(text: string): { ok: true } | { error: string } {
  const t = text.replace(/^﻿/, '').trim()
  if (t === 'OK') return { ok: true }
  if (t.startsWith('ERRO')) return { error: t.replace(/^ERRO\s*/, '').trim() || 'erro sem mensagem' }
  return { error: 'resposta estranha do After Effects: ' + t.slice(0, 200) }
}

/** quadro em que o aerender está ("PROGRESS:  0:00:01:05 (36): 1 Seconds") */
export function aerenderFrame(line: string): number | null {
  const m = line.match(/PROGRESS:\s+[\d:;.]+\s+\((\d+)\)/)
  return m ? Number(m[1]) : null
}

/** erros do aerender, sem o resto do log */
export function aerenderErrors(log: string): string {
  return log
    .split(/\r?\n/)
    .filter((l) => /error|erro|falh/i.test(l))
    .slice(-4)
    .join(' ')
    .slice(0, 400)
}

/**
 * Como o ffmpeg lê o que o aerender gravou: um arquivo de vídeo, ou uma sequência de imagens
 * ("clipe_00000.png", "clipe_00001.png"…) vira um padrão com o primeiro número.
 */
export function renderInput(names: string[]): { file: string; pattern?: { start: number } } | null {
  const list = names.filter((n) => !n.startsWith('.') && !n.startsWith('_')).sort()
  if (!list.length) return null
  if (list.length === 1) return { file: list[0] }
  const m = list[0].match(/^(.*?)(\d+)(\.\w+)$/)
  if (!m) return { file: list[list.length - 1] }
  return { file: `${m[1]}%0${m[2].length}d${m[3]}`, pattern: { start: Number(m[2]) } }
}
