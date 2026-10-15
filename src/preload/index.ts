import { contextBridge, ipcRenderer, webUtils } from 'electron'

type AiProvider = 'claude-code' | 'anthropic' | 'openai'

/** um arquivo na fila do Whisper (ver main/whisper.ts) */
export interface WhisperJob {
  path: string
  lang: string
  state: 'queued' | 'running' | 'done' | 'error'
  stage: 'audio' | 'model' | 'listen' | null
  pct: number
  since?: number
  error?: string
}

const api = {
  newProject: () => ipcRenderer.invoke('project:new'),
  openProject: (dir?: string) => ipcRenderer.invoke('project:open', dir),
  saveProject: (dir: string, data: unknown, markdown: string) => ipcRenderer.invoke('project:save', dir, data, markdown),
  saveProjectAs: (dir: string, data: unknown, markdown: string): Promise<{ dir: string } | { error: string } | null> =>
    ipcRenderer.invoke('project:saveAs', dir, data, markdown),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  /** Ajuda → Gerar relatório de erro (.txt com versão, ffmpeg e os últimos erros; sem chaves) */
  errorReport: (): Promise<{ path: string; lines: number } | null> => ipcRenderer.invoke('log:report'),
  /** .zip com a pasta do roteiro e a mídia de fora que ele usa */
  exportProject: (dir: string, title: string): Promise<{ path: string; files: number; external: number; bytes: number } | { error: string } | null> =>
    ipcRenderer.invoke('project:export', dir, title),
  onExportProgress: (cb: (pct: number) => void) => {
    ipcRenderer.removeAllListeners('project:exportProgress')
    ipcRenderer.on('project:exportProgress', (_e, pct) => cb(pct))
  },
  logError: (text: string) => ipcRenderer.send('log:renderer', text),
  /** cópias automáticas do roteiro (as 10 mais novas, uma a cada 3 min no máximo) */
  listVersions: (dir: string): Promise<{ name: string; at: number; words: number; title: string }[]> => ipcRenderer.invoke('versions:list', dir),
  restoreVersion: (dir: string, name: string): Promise<{ ok: true } | { error: string }> => ipcRenderer.invoke('versions:restore', dir, name),
  removeRecent: (dir: string) => ipcRenderer.invoke('project:removeRecent', dir),
  drafts: (keep?: string): Promise<{ dir: string; title: string; updatedAt: string; preview: string }[]> =>
    ipcRenderer.invoke('project:drafts', keep),
  deleteDraft: (dir: string) => ipcRenderer.invoke('project:deleteDraft', dir),
  storageInfo: (keep?: string): Promise<{ drafts: number; draftBytes: number; cacheBytes: number; recent: number }> =>
    ipcRenderer.invoke('storage:info', keep),
  clearStorage: (what: 'drafts' | 'cache' | 'recent', keep?: string) => ipcRenderer.invoke('storage:clear', what, keep),
  openPath: (path: string) => ipcRenderer.invoke('shell:open', path),
  editAction: (what: 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle') => ipcRenderer.invoke('edit:do', what),
  moveProject: (dir: string, title: string): Promise<{ dir: string } | { error: string } | null> => ipcRenderer.invoke('project:move', dir, title),
  scanAssets: (dir: string): Promise<{ copies: number; unused: number; bytes: number } | { error: string }> => ipcRenderer.invoke('assets:scan', dir),
  cleanAssets: (dir: string): Promise<{ removed: number; bytes: number } | { error: string }> => ipcRenderer.invoke('assets:clean', dir),

  pickAssets: (dir: string) => ipcRenderer.invoke('asset:pick', dir),
  importPaths: (dir: string, paths: string[]) => ipcRenderer.invoke('asset:importPaths', dir, paths),
  importBuffer: (dir: string, name: string, bytes: Uint8Array) => ipcRenderer.invoke('asset:importBuffer', dir, name, bytes),
  pathForFile: (file: File) => webUtils.getPathForFile(file),

  loadLibrary: () => ipcRenderer.invoke('library:load'),
  saveLibrary: (items: unknown) => ipcRenderer.invoke('library:save', items),
  storeLibraryFiles: (paths: string[]): Promise<string[]> => ipcRenderer.invoke('library:storeFiles', paths),
  pickLibraryCover: (): Promise<string | null> => ipcRenderer.invoke('library:pickCover'),
  coverFromFile: (path: string): Promise<string> => ipcRenderer.invoke('library:coverFromFile', path),

  loadFolders: (): Promise<{ id: string; name: string; path: string }[]> => ipcRenderer.invoke('folders:load'),
  saveFolders: (folders: unknown) => ipcRenderer.invoke('folders:save', folders),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('folders:pick'),
  listDir: (
    dir: string
  ): Promise<{ dirs: { name: string; path: string }[]; files: { name: string; path: string; kind: 'image' | 'audio' | 'video' }[] } | { error: string }> =>
    ipcRenderer.invoke('fs:list', dir),
  scanFolder: (
    path: string
  ): Promise<{ path: string; name: string; rel: string; kind: 'image' | 'audio' | 'video' }[] | { error: string }> =>
    ipcRenderer.invoke('folders:scan', path),

  /** miniatura pequena (data URL) feita pelo Windows; null se não houver */
  thumb: (path: string, size: number): Promise<string | null> => ipcRenderer.invoke('thumb:get', path, size),

  loadFormats: () => ipcRenderer.invoke('formats:load'),
  pickFormatImages: (): Promise<string[]> => ipcRenderer.invoke('format:pickImages'),
  exportPrefs: (includeKeys: boolean): Promise<{ path: string; files: number } | { error: string } | null> =>
    ipcRenderer.invoke('prefs:export', includeKeys),
  importPrefs: (): Promise<{ files: number } | { error: string } | null> => ipcRenderer.invoke('prefs:import'),
  saveFormats: (formats: unknown) => ipcRenderer.invoke('formats:save', formats),

  pickAudio: (dir: string): Promise<{ path: string; name: string }[]> => ipcRenderer.invoke('audio:pick', dir),
  importAudioPaths: (dir: string, paths: string[]): Promise<{ path: string; name: string }[]> =>
    ipcRenderer.invoke('audio:importPaths', dir, paths),
  generateSfx: (dir: string, text: string, seconds: number | null): Promise<{ path: string; name: string } | { error: string }> =>
    ipcRenderer.invoke('sfx:generate', dir, text, seconds),

  getSettings: (): Promise<{ autoUpdate: boolean; hasElevenLabsKey: boolean; version: string; mode: 'installer' | 'portable' | 'dev'; keys: Record<string, string> }> =>
    ipcRenderer.invoke('settings:get'),
  setSettings: (patch: { autoUpdate?: boolean; elevenLabsKey?: string; keys?: Record<string, string> }) => ipcRenderer.invoke('settings:set', patch),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdateNow: () => ipcRenderer.invoke('update:installNow'),
  onUpdate: (cb: (event: string, payload: any) => void) => {
    for (const ch of ['update:ready', 'update:progress', 'update:status']) {
      ipcRenderer.removeAllListeners(ch)
      ipcRenderer.on(ch, (_e, payload) => cb(ch, payload))
    }
  },

  // corretor (Hunspell no main): o editor manda as palavras e desenha o sublinhado
  spellCheck: (lang: string, words: string[]): Promise<string[]> => ipcRenderer.invoke('spell:check', lang, words),
  spellSuggest: (lang: string, word: string): Promise<string[]> => ipcRenderer.invoke('spell:suggest', lang, word),
  spellAdd: (word: string) => ipcRenderer.invoke('spell:add', word),
  spellLanguages: (): Promise<string[]> => ipcRenderer.invoke('spell:languages'),

  // IA (qualquer fornecedor): o app pede a tarefa, o main escolhe a conexão configurada
  aiStatus: (): Promise<{
    providers: { id: AiProvider; label: string; caps: ('text' | 'image')[]; configured: boolean; detail: string }[]
    routes: { text: AiProvider | null; image: AiProvider | null }
    models: { anthropicModel: string; openaiTextModel: string; openaiImageModel: string; claudeCodePath: string }
  }> => ipcRenderer.invoke('ai:status'),
  aiSet: (patch: Record<string, string | null>) => ipcRenderer.invoke('ai:set', patch),
  aiTest: (id: AiProvider): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('ai:test', id),
  aiText: (job: { instruction: string; input: string; dir?: string; timeoutMs?: number }): Promise<{ text: string; provider: AiProvider } | { error: string }> =>
    ipcRenderer.invoke('ai:text', job),
  aiImage: (
    dir: string,
    prompt: string,
    aspect: string
  ): Promise<{ attachment: { id: string; path: string; name: string; kind: 'image' }; provider: AiProvider } | { error: string }> =>
    ipcRenderer.invoke('ai:image', dir, prompt, aspect),
  // quanto cada pedido de IA levou e custou, e o gasto/limite do projeto
  aiSetProject: (dir: string | null) => ipcRenderer.invoke('ai:project', dir),
  aiBudget: (dir: string): Promise<{ spent: number; cap?: number }> => ipcRenderer.invoke('ai:budget', dir),
  aiSetBudget: (dir: string, cap: number | null): Promise<{ spent: number; cap?: number }> => ipcRenderer.invoke('ai:setBudget', dir, cap),
  onAiUsage: (cb: (u: { provider: AiProvider; ms: number; ok: boolean; cost: number | null; spent?: number; cap?: number }) => void) => {
    ipcRenderer.removeAllListeners('ai:usage')
    ipcRenderer.on('ai:usage', (_e, u) => cb(u))
  },

  // Montagem (ffmpeg no main)
  ffmpegInfo: (force?: boolean): Promise<{ path: string; version: string; whisper: boolean } | null> => ipcRenderer.invoke('media:ffmpeg', force),
  pickMedia: (): Promise<string[]> => ipcRenderer.invoke('media:pick'),
  probeMedia: (
    path: string
  ): Promise<{ duration: number; hasVideo: boolean; hasAudio: boolean; width?: number; height?: number; fps?: number } | { error: string }> =>
    ipcRenderer.invoke('media:probe', path),
  proxyAudio: (path: string): Promise<string | { error: string }> => ipcRenderer.invoke('media:proxy', path),
  /** cópia 720p só pra prévia de vídeo pesado (4K, HEVC, ProRes…); null = o original já toca leve */
  proxyVideo: (path: string): Promise<string | null> => ipcRenderer.invoke('media:proxyVideo', path),
  loudness: (path: string, start: number, dur: number): Promise<{ i: number; tp: number } | null> => ipcRenderer.invoke('media:loudness', path, start, dur),
  mediaExists: (paths: string[]): Promise<boolean[]> => ipcRenderer.invoke('media:exists', paths),
  missingMedia: (paths: string[]): Promise<string[]> => ipcRenderer.invoke('media:missing', paths),
  /** procura na pasta (e subpastas) arquivos com o mesmo nome dos que sumiram: caminho antigo → novo */
  relinkMedia: (paths: string[], root: string): Promise<Record<string, string>> => ipcRenderer.invoke('media:relink', paths, root),
  trashRecording: (path: string): Promise<{ ok: true } | { error: string }> => ipcRenderer.invoke('media:trashRecording', path),
  trashProjectFiles: (dir: string, paths: string[]): Promise<{ trashed: number; errors: string[] }> => ipcRenderer.invoke('media:trashProjectFiles', dir, paths),
  showItem: (path: string) => ipcRenderer.invoke('shell:showItem', path),
  saveRecording: (dir: string, bytes: Uint8Array): Promise<string | { error: string }> => ipcRenderer.invoke('media:saveRecording', dir, bytes),
  ytdlpInfo: (): Promise<{ path: string } | null> => ipcRenderer.invoke('media:ytdlp'),
  installYtdlp: (): Promise<{ path: string } | { error: string }> => ipcRenderer.invoke('media:installYtdlp'),
  downloadVideo: (url: string, dir: string, opts: { quality: '1080' | '720' | 'audio'; from?: string; to?: string; target?: 'motion' }): Promise<{ path: string } | { error: string }> =>
    ipcRenderer.invoke('media:download', url, dir, opts),
  cancelDownload: () => ipcRenderer.invoke('media:dlCancel'),
  onDownloadProgress: (cb: (p: { pct: number; speed: string; eta: string }) => void) => {
    ipcRenderer.removeAllListeners('media:dlProgress')
    ipcRenderer.on('media:dlProgress', (_e, p) => cb(p))
  },
  silences: (path: string): Promise<[number, number][] | { error: string }> => ipcRenderer.invoke('media:silences', path),

  // transcrição (Whisper local) pro corte automático
  whisperStatus: (): Promise<{
    model: string
    models: { id: string; label: string; file: string; mb: number; ready: boolean }[]
    vad: boolean
    downloading: boolean
  }> => ipcRenderer.invoke('whisper:status'),
  whisperSetModel: (id: string) => ipcRenderer.invoke('whisper:setModel', id),
  whisperDownload: (id: string): Promise<{ ok: true } | { error: string }> => ipcRenderer.invoke('whisper:download', id),
  transcribe: (path: string, lang: string): Promise<{ words: { s: number; e: number; w: string }[] } | { error: string }> =>
    ipcRenderer.invoke('whisper:transcribe', path, lang),
  onWhisperProgress: (cb: (p: { stage: 'download'; pct: number }) => void) => {
    ipcRenderer.removeAllListeners('whisper:progress')
    ipcRenderer.on('whisper:progress', (_e, p) => cb(p))
  },
  // leitura do áudio em segundo plano (fila com cache)
  whisperQueue: (paths: string[], lang: string): Promise<void> => ipcRenderer.invoke('whisper:queue', paths, lang),
  whisperCached: (paths: string[], lang: string): Promise<Record<string, boolean>> => ipcRenderer.invoke('whisper:cached', paths, lang),
  whisperJobs: (): Promise<WhisperJob[]> => ipcRenderer.invoke('whisper:jobs'),
  whisperCancel: (path?: string, lang?: string): Promise<void> => ipcRenderer.invoke('whisper:cancel', path, lang),
  whisperClearErrors: (): Promise<void> => ipcRenderer.invoke('whisper:clear'),
  whisperParallel: (n?: number): Promise<number> => ipcRenderer.invoke('whisper:parallel', n),
  /** a fila toda, a cada mudança (todas as janelas e partes do app ouvem) */
  onWhisperJobs: (cb: (jobs: WhisperJob[]) => void) => {
    const f = (_e: unknown, jobs: WhisperJob[]) => cb(jobs)
    ipcRenderer.on('whisper:jobs', f)
    return () => ipcRenderer.removeListener('whisper:jobs', f)
  },

  // workspace Estilo (treinar motion)
  motionImportFiles: (paths: string[]): Promise<{ kind: 'image' | 'video'; path: string; name: string; frames?: string[]; error?: string }[]> =>
    ipcRenderer.invoke('motion:importFiles', paths),
  motionPickFiles: (): Promise<string[]> => ipcRenderer.invoke('motion:pickFiles'),
  motionFrames: (
    path: string,
    weights: { aesthetic: number; motion: number; frameByFrame?: boolean }
  ): Promise<{ path: string; kind: 'even' | 'burst'; group: number; index: number; t: number; fps: number }[] | { error: string }> =>
    ipcRenderer.invoke('motion:frames', path, weights),
  /** um quadro do vídeo em cada tempo (s do arquivo), com `width` px de largura (padrão 480); null onde não deu */
  motionFramesAt: (path: string, times: number[], width?: number): Promise<(string | null)[]> => ipcRenderer.invoke('motion:framesAt', path, times, width),
  motionPasteImage: (bytes: Uint8Array, name: string): Promise<string> => ipcRenderer.invoke('motion:pasteImage', bytes, name),
  systemFonts: (): Promise<string[]> => ipcRenderer.invoke('sys:fonts'),
  motionDemoFile: (html: string): Promise<string> => ipcRenderer.invoke('motion:demoFile', html),
  renderCheck: (paths: string[]): Promise<{ path: string; ok: boolean; files?: number; size?: number; error?: string }[]> => ipcRenderer.invoke('render:check', paths),
  renderStart: (job: {
    dir: string
    width: number
    height: number
    fps: number
    finalFile: string
    parts: {
      id: string
      label: string
      from: number
      to: number
      key: string
      video: { path: string; image: boolean; t0: number; t1: number; src0: number; fadeIn: number; fadeOut: number }[]
      audio: { path: string; t0: number; t1: number; src0: number; env: [number, number][] }[]
      letterings: string[]
    }[]
    letterings: { id: string; label: string; t: number; dur: number; html: string }[]
    fresh?: boolean
    sub?: string
    fit?: 'contain' | 'cover'
    exportDir?: string
    exportName?: string
  }): Promise<{ path?: string; summary: string; seconds: number } | { error: string }> => ipcRenderer.invoke('render:start', job),
  renderStatus: (dir: string): Promise<{ status: 'rodando' | 'interrompido' | 'pronto'; reason?: string; done: number; total: number; pct: number; updated: number } | null> =>
    ipcRenderer.invoke('render:status', dir),
  onRenderState: (
    cb: (p: { phase: 'letterings' | 'partes' | 'final'; pct: number; eta: number | null; steps: { id: string; label: string; done: boolean }[]; resumed: number }) => void
  ) => {
    ipcRenderer.removeAllListeners('render:state')
    ipcRenderer.on('render:state', (_e, p) => cb(p))
  },
  renderCancel: () => ipcRenderer.invoke('render:cancel'),
  /** escolhe a pasta de export (null = cancelou) */
  renderPickDir: (current?: string): Promise<string | null> => ipcRenderer.invoke('render:pickDir', current),
  /** os arquivos ainda existem? (pra prévia dos vídeos já renderizados) */
  renderExists: (paths: string[]): Promise<boolean[]> => ipcRenderer.invoke('render:exists', paths),
  onRenderProgress: (cb: (ev: { kind: 'say' | 'info'; text: string }) => void) => {
    ipcRenderer.removeAllListeners('render:progress')
    ipcRenderer.on('render:progress', (_e, ev) => cb(ev))
  },
  // blocos de instrução: prévia do motion (HTML → MP4 leve)
  motionPreview: (job: {
    dir: string
    block: string
    html: string
    seconds: number
    width: number
    height: number
    fps: number
    wav?: Uint8Array
    files: { src: string; name: string }[]
    /** clipe final (resolução do projeto) a partir do HTML aprovado */
    final?: boolean
    zoom?: number
    htmlPath?: string
  }): Promise<{ video: string; html: string } | { error: string }> => ipcRenderer.invoke('motion:preview', job),
  motionPreviewCancel: () => ipcRenderer.invoke('motion:previewCancel'),
  /** mede o HTML do motion em vários instantes e devolve o que está fora da safe zone / em cima da faixa persistente */
  motionCheckLayout: (job: {
    dir: string
    block: string
    html: string
    seconds: number
    width: number
    height: number
    files: { src: string; name: string }[]
    probe: string
    step?: number
  }): Promise<{ issues: { kind: 'fora' | 'faixa' | 'faixa-vaza'; what: string; t: number; rect: { x: number; y: number; w: number; h: number } }[] } | { error: string }> =>
    ipcRenderer.invoke('motion:checkLayout', job),
  /** o que está nas faixas de vídeo embaixo de um bloco, recortado num MP4 sem som (0 s = começo do bloco) */
  motionUnderVideo: (job: {
    dir: string
    block: string
    from: number
    to: number
    width: number
    height: number
    video: { path: string; image: boolean; t0: number; t1: number; src0: number; fadeIn: number; fadeOut: number }[]
  }): Promise<{ video: string } | { error: string }> => ipcRenderer.invoke('motion:underVideo', job),
  onMotionPreviewProgress: (cb: (p: { block: string; stage: string; pct: number }) => void) => {
    ipcRenderer.removeAllListeners('motion:previewProgress')
    ipcRenderer.on('motion:previewProgress', (_e, p) => cb(p))
  },
  findSfxLibraries: (): Promise<{ libs: { path: string; name: string; program: string; why: string; files: number }[]; hints: number } | { error: string }> =>
    ipcRenderer.invoke('ai:findSfx'),
  motionTrain: (job: { prompt: string; images: string[]; id?: string }): Promise<{ text: string; provider: AiProvider } | { error: string }> =>
    ipcRenderer.invoke('ai:motionTrain', job),
  /** para o pedido de motion desse id (o bloco) */
  motionTrainCancel: (id?: string) => ipcRenderer.invoke('ai:motionCancel', id),

  /** o main pede pra salvar antes de fechar/atualizar */
  onFlush: (cb: () => Promise<void>) => {
    ipcRenderer.removeAllListeners('app:flush')
    ipcRenderer.on('app:flush', async () => {
      try {
        await cb()
      } finally {
        ipcRenderer.send('app:flushed')
      }
    })
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
