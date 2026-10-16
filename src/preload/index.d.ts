export interface EmberApi {
  invoke: (channel: string, ...args: unknown[]) => Promise<any>
  on: (channel: string, fn: (payload: any) => void) => () => void
  pathForFile: (f: File) => string
}

declare global {
  interface Window {
    ember: EmberApi
  }
}
