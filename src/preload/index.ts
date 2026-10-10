import { contextBridge, ipcRenderer, webUtils } from 'electron'

type AiProvider = 'claude-code' | 'anthropic' | 'openai'

const api = {
  newProject: () => ipcRenderer.invoke('project:new'),
  openProject: (dir?: string) => ipcRenderer.invoke('project:open', dir),
  saveProject: (dir: string, data: unknown, markdown: string) => ipcRenderer.invoke('project:save', dir, data, markdown),
  saveProjectAs: (dir: string, data: unknown, markdown: string): Promise<{ dir: string } | { error: string } | null> =>
    ipcRenderer.invoke('project:saveAs', dir, data, markdown),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  removeRecent: (dir: string) => ipcRenderer.invoke('project:removeRecent', dir),
  drafts: (keep?: string): Promise<{ dir: string; title: string; updatedAt: string; preview: string }[]> =>
    ipcRenderer.invoke('project:drafts', keep),
  deleteDraft: (dir: string) => ipcRenderer.invoke('project:deleteDraft', dir),
  storageInfo: (keep?: string): Promise<{ drafts: number; draftBytes: number; cacheBytes: number; recent: number }> =>
    ipcRenderer.invoke('storage:info', keep),
  clearStorage: (what: 'drafts' | 'cache' | 'recent', keep?: string) => ipcRenderer.invoke('storage:clear', what, keep),
  openPath: (path: string) => ipcRenderer.invoke('shell:open', path),
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

  getSettings: (): Promise<{ autoUpdate: boolean; hasElevenLabsKey: boolean; version: string; mode: 'installer' | 'portable' | 'dev' }> =>
    ipcRenderer.invoke('settings:get'),
  setSettings: (patch: { autoUpdate?: boolean; elevenLabsKey?: string }) => ipcRenderer.invoke('settings:set', patch),
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
  aiText: (job: { instruction: string; input: string; dir?: string }): Promise<{ text: string; provider: AiProvider } | { error: string }> =>
    ipcRenderer.invoke('ai:text', job),
  aiImage: (
    dir: string,
    prompt: string,
    aspect: string
  ): Promise<{ attachment: { id: string; path: string; name: string; kind: 'image' }; provider: AiProvider } | { error: string }> =>
    ipcRenderer.invoke('ai:image', dir, prompt, aspect),

  // Montagem (ffmpeg no main)
  ffmpegInfo: (force?: boolean): Promise<{ path: string; version: string; whisper: boolean } | null> => ipcRenderer.invoke('media:ffmpeg', force),
  pickMedia: (): Promise<string[]> => ipcRenderer.invoke('media:pick'),
  probeMedia: (
    path: string
  ): Promise<{ duration: number; hasVideo: boolean; hasAudio: boolean; width?: number; height?: number; fps?: number } | { error: string }> =>
    ipcRenderer.invoke('media:probe', path),
  proxyAudio: (path: string): Promise<string | { error: string }> => ipcRenderer.invoke('media:proxy', path),
  mediaExists: (paths: string[]): Promise<boolean[]> => ipcRenderer.invoke('media:exists', paths),
  trashRecording: (path: string): Promise<{ ok: true } | { error: string }> => ipcRenderer.invoke('media:trashRecording', path),
  showItem: (path: string) => ipcRenderer.invoke('shell:showItem', path),
  saveRecording: (dir: string, bytes: Uint8Array): Promise<string | { error: string }> => ipcRenderer.invoke('media:saveRecording', dir, bytes),
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
  onWhisperProgress: (cb: (p: { stage: 'download' | 'transcribe'; pct: number; path?: string }) => void) => {
    ipcRenderer.removeAllListeners('whisper:progress')
    ipcRenderer.on('whisper:progress', (_e, p) => cb(p))
  },

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
