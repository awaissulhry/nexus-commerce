import { join } from 'node:path'
import { loadFactoryEnv, type FactoryEnv } from '../../env'
import { localFilesRootOf } from '../files/service'
import { localMailbox, type LocalMailbox } from './mailbox'

/**
 * The Owner's local test server (B-W2b-F58; FACTORY_ENV=local, every integration FAKE): what only it has, made on first use
 * from apps/factory-api/.env (or the process), like the other process runtimes. On test, staging and production every part
 * is off: no mailbox (the FAKE mail stays in memory; the mailbox route is not registered, so it answers 404 for everyone) and
 * the TEST MODE bar shows (env.ts refuses FACTORY_HIDE_TEST_MODE_BANNER there; this reads it only on local as well).
 * Tests set their own with useLocalStack().
 */

export interface LocalStack {
  /** The local mailbox every process writes FAKE mail to (`FACTORY_LOCAL_FILES_DIR/mailbox/`), or null (not local). */
  readonly mailbox: LocalMailbox | null
  /** FACTORY_HIDE_TEST_MODE_BANNER=1 on local: the office shell draws no top TEST MODE bar (GET /shell/notices says so). */
  readonly hideTestModeBanner: boolean
}

export const NO_LOCAL_STACK: LocalStack = Object.freeze({ mailbox: null, hideTestModeBanner: false })

/** The local stack of a loaded environment: everything off unless FACTORY_ENV=local. */
export function localStackOf(env: Pick<FactoryEnv, 'FACTORY_ENV' | 'FACTORY_LOCAL_FILES_DIR' | 'FACTORY_QUEUE_PREFIX' | 'FACTORY_HIDE_TEST_MODE_BANNER'>): LocalStack {
  if (env.FACTORY_ENV !== 'local') return NO_LOCAL_STACK
  return Object.freeze({
    mailbox: localMailbox({ folder: join(localFilesRootOf(env), 'mailbox') }),
    hideTestModeBanner: env.FACTORY_HIDE_TEST_MODE_BANNER === '1',
  })
}

let configured: LocalStack | undefined
let fromEnv: LocalStack | undefined

/** Tests: the local stack to use (undefined goes back to the process's own). */
export function useLocalStack(stack: LocalStack | undefined): void {
  configured = stack
}

export function processLocalStack(): LocalStack {
  if (configured) return configured
  if (!fromEnv) fromEnv = localStackOf(loadFactoryEnv())
  return fromEnv
}
