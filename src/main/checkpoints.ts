// Rewind support: snapshots of the whole workspace taken with a *shadow* git repository
// (git-dir in userData, work-tree = workspace). The user's own .git is never touched.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { checkpointsRoot } from './store'

const run = promisify(execFile)

function shadowDir(workspace: string): string {
  const h = createHash('sha1').update(workspace.toLowerCase()).digest('hex').slice(0, 16)
  return join(checkpointsRoot(), h)
}

async function git(workspace: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const gd = shadowDir(workspace)
  const { stdout } = await run('git', ['--git-dir', gd, '--work-tree', workspace, ...args], {
    cwd: workspace,
    env: { ...process.env, ...extraEnv, GIT_INDEX_FILE: join(gd, 'ember-index') },
    maxBuffer: 50 * 1024 * 1024,
    timeout: 120000
  })
  return stdout
}

async function ensureShadow(workspace: string): Promise<void> {
  const gd = shadowDir(workspace)
  if (existsSync(join(gd, 'HEAD'))) return
  mkdirSync(gd, { recursive: true })
  await run('git', ['init', '-q', '--bare', gd])
  mkdirSync(join(gd, 'info'), { recursive: true })
  // Big generated folders are never worth snapshotting. The workspace's own .gitignore files also apply.
  writeFileSync(
    join(gd, 'info', 'exclude'),
    ['node_modules/', '.git/', 'dist/', 'out/', 'build/', '.next/', '__pycache__/', '.venv/', 'venv/', 'target/', 'bin/', 'obj/', '*.log'].join('\n')
  )
  await run('git', ['--git-dir', gd, 'config', 'core.autocrlf', 'false'])
  await run('git', ['--git-dir', gd, 'config', 'core.safecrlf', 'false'])
}

/** Take a snapshot; returns a tree id. */
export async function snapshot(workspace: string): Promise<string> {
  await ensureShadow(workspace)
  await git(workspace, ['add', '-A', '--', '.'])
  return (await git(workspace, ['write-tree'])).trim()
}

/** Restore the workspace to a snapshot. Files created after the snapshot are removed (ignored files are kept). */
export async function restore(workspace: string, tree: string): Promise<void> {
  await ensureShadow(workspace)
  await git(workspace, ['read-tree', tree])
  await git(workspace, ['checkout-index', '-a', '-f'])
  // remove files not in the snapshot
  await git(workspace, ['clean', '-fd', '-e', '.git'])
}

/** Files that differ between a snapshot and the current working tree. */
export async function changedSince(workspace: string, tree: string): Promise<{ path: string; status: string }[]> {
  await ensureShadow(workspace)
  await git(workspace, ['add', '-A', '--', '.'])
  const out = await git(workspace, ['diff-index', '--cached', '--name-status', tree])
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t')
      return { path: rest.join('\t'), status: status[0] }
    })
}

/** Content of a file inside a snapshot, or null if it did not exist. */
export async function fileAt(workspace: string, tree: string, relPath: string): Promise<string | null> {
  try {
    return await git(workspace, ['show', `${tree}:${relPath.split('\\').join('/')}`])
  } catch {
    return null
  }
}

export async function diffSince(workspace: string, tree: string, relPath?: string): Promise<string> {
  await ensureShadow(workspace)
  await git(workspace, ['add', '-A', '--', '.'])
  const args = ['diff-index', '--cached', '-p', tree]
  if (relPath) args.push('--', relPath)
  return git(workspace, args)
}
