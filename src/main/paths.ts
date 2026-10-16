// Where Ember keeps and finds executables.
import { app } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'

/** Binaries shipped inside the installer (resources/bin). In development: <project>/resources/bin. */
export function bundledBin(): string {
  return app.isPackaged ? join(process.resourcesPath, 'bin') : join(app.getAppPath(), 'resources', 'bin')
}

/** Binaries Ember downloads or updates itself at runtime (per user, no admin rights). */
export function managedBin(): string {
  const d = join(app.getPath('userData'), 'bin')
  mkdirSync(d, { recursive: true })
  return d
}
