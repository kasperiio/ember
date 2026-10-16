// Make sure Electron's binary exists even when npm's install-script policy skipped its postinstall.
import { existsSync } from 'fs'
import { execSync } from 'child_process'
if (!existsSync('node_modules/electron/dist')) {
  try {
    execSync('node node_modules/electron/install.js', { stdio: 'inherit' })
  } catch (e) {
    console.warn('electron install skipped:', e.message)
  }
}
