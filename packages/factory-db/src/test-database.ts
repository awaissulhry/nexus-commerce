import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { describeUrlHost, isLoopbackUrl } from '@nexus/db-kit/url-guard'

/**
 * The test-database guard. Factory tests refuse to start unless the database URL is on this machine (loopback) and
 * names a database that is safe to fill and wipe:
 *   - `factory_test…`: the throwaway databases the test runners create;
 *   - `factory_<branch>`: this worktree's own database, named after its git branch, its folder, or the step id at the
 *     start of its folder (`w9-01-…` → `factory_w9_01`). Letters are compared lower case, other characters as `_`.
 */

export type TestDatabaseCheck = { ok: true; database: string } | { ok: false; reason: string }

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/** The `factory_<name>` databases that belong to a worktree with this branch and folder. */
export function worktreeDatabaseNames(worktree: { branch?: string | undefined; folder?: string | undefined }): string[] {
  const names = new Set<string>()
  const add = (part: string): void => {
    const name = slug(part)
    if (name !== '') names.add(`factory_${name}`)
  }
  if (worktree.branch !== undefined && worktree.branch !== 'HEAD') add(worktree.branch)
  if (worktree.folder !== undefined) {
    add(worktree.folder)
    const step = /^(?:b-)?w\d+-\d+/i.exec(worktree.folder)
    if (step) add(step[0])
  }
  return [...names]
}

/** The current branch and worktree folder, read from git. Empty when git cannot tell (then only factory_test… passes). */
export function readWorktree(cwd: string): { branch?: string; folder?: string } {
  const git = (...args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return undefined
    }
  }
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  const top = git('rev-parse', '--show-toplevel')
  return { ...(branch ? { branch } : {}), ...(top ? { folder: basename(top) } : {}) }
}

export function checkTestDatabaseUrl(url: string | undefined, worktreeNames: readonly string[]): TestDatabaseCheck {
  if (url === undefined || url.trim() === '') {
    return { ok: false, reason: 'FACTORY_DATABASE_URL is not set' }
  }
  if (!isLoopbackUrl(url)) {
    return { ok: false, reason: `${describeUrlHost(url)} is not a database on this machine (loopback only)` }
  }
  const database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  if (database.startsWith('factory_test') || worktreeNames.includes(slug(database))) {
    return { ok: true, database }
  }
  const allowed = ['factory_test…', ...worktreeNames].join(', ')
  return { ok: false, reason: `database "${database}" is not a test or worktree database (allowed: ${allowed})` }
}

/** Throws with the reason, so a test run stops before its first connection. */
export function assertTestDatabaseUrl(url: string | undefined, worktreeNames: readonly string[]): string {
  const result = checkTestDatabaseUrl(url, worktreeNames)
  if (!result.ok) throw new Error(`Factory tests refused to start: ${result.reason}.`)
  return result.database
}
