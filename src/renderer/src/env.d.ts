/// <reference types="vite/client" />
import type { EmberApi } from '../../preload/index.d'

declare global {
  interface Window {
    ember: EmberApi
  }
}
export {}
