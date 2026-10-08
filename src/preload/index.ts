import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  newProject: () => ipcRenderer.invoke('project:new'),
  openProject: (dir?: string) => ipcRenderer.invoke('project:open', dir),
  saveProject: (dir: string, data: unknown, markdown: string) => ipcRenderer.invoke('project:save', dir, data, markdown),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  openPath: (path: string) => ipcRenderer.invoke('shell:open', path),

  pickAssets: (dir: string) => ipcRenderer.invoke('asset:pick', dir),
  importPaths: (dir: string, paths: string[]) => ipcRenderer.invoke('asset:importPaths', dir, paths),
  importBuffer: (dir: string, name: string, bytes: Uint8Array) => ipcRenderer.invoke('asset:importBuffer', dir, name, bytes),
  pathForFile: (file: File) => webUtils.getPathForFile(file),

  loadLibrary: () => ipcRenderer.invoke('library:load'),
  saveLibrary: (items: unknown) => ipcRenderer.invoke('library:save', items),
  storeLibraryFiles: (paths: string[]): Promise<string[]> => ipcRenderer.invoke('library:storeFiles', paths),
  pickLibraryCover: (): Promise<string | null> => ipcRenderer.invoke('library:pickCover'),
  coverFromFile: (path: string): Promise<string> => ipcRenderer.invoke('library:coverFromFile', path),

  loadFormats: () => ipcRenderer.invoke('formats:load'),
  saveFormats: (formats: unknown) => ipcRenderer.invoke('formats:save', formats),

  onRequestClose: (cb: () => void) => {
    ipcRenderer.removeAllListeners('app:request-close')
    ipcRenderer.on('app:request-close', cb)
  },
  confirmClose: () => ipcRenderer.invoke('app:close-confirmed')
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
