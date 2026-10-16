import { contextBridge, ipcRenderer, webUtils } from 'electron'

const invoke = (ch: string, ...args: unknown[]) => ipcRenderer.invoke(ch, ...args)
const on = (ch: string, fn: (payload: any) => void) => {
  const l = (_e: unknown, payload: any) => fn(payload)
  ipcRenderer.on(ch, l)
  return () => ipcRenderer.removeListener(ch, l)
}

const api = {
  invoke,
  on,
  pathForFile: (f: File) => webUtils.getPathForFile(f)
}

contextBridge.exposeInMainWorld('ember', api)
export type EmberApi = typeof api
