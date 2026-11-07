import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testServerUrl } from './database'
import {
  lockHolder,
  MigrationLockError,
  TEST_KIT_APPLICATION,
  testKitApplicationName,
  withMigrationLock,
  type MigrationLockOptions,
} from './migration-lock'

/**
 * The test migration lock (B-W2b-F11), on a database and a key of this file's own: never MIGRATION_LOCK, never a
 * session of anyone else. Builds never hold it together; a holder that is killed, or that stops acting while it holds
 * or while it waits in the queue, keeps the next build waiting no longer than the idle bound; a session outside the
 * test kit that sits on the lock is named in the error and left alone.
 */
const HOLDER = fileURLToPath(new URL('./migration-lock-holder.ts', import.meta.url))
const PACKAGE = fileURLToPath(new URL('../..', import.meta.url))
const RUN = process.env.FACTORY_PG_TEST_RUN ?? 'adhoc'
if (!/^[a-z0-9]{1,16}$/.test(RUN)) throw new Error(`Bad FACTORY_PG_TEST_RUN: ${JSON.stringify(RUN)}.`)
const LOCK_DB = `factory_test_${RUN}_lockkey_${randomBytes(4).toString('hex')}`
const KEY = BigInt(`0x${randomBytes(6).toString('hex')}`).toString()
const IDLE_BOUND = 1_500

const server = testServerUrl()
const lockUrl = (): string => {
  const url = new URL(server.href)
  url.pathname = `/${LOCK_DB}`
  return url.href
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const elapsed = (since: number): number => performance.now() - since

let root: pg.Client
let probe: pg.Client
let base: MigrationLockOptions
const children: ChildProcess[] = []

/** A holder in a process of its own: resolves `waiting` and `held` as it prints them. */
function startHolder(options: Partial<MigrationLockOptions> = {}): { child: ChildProcess; waiting: Promise<void>; held: Promise<void> } {
  const child = spawn(process.execPath, ['--import', 'tsx', HOLDER], {
    cwd: PACKAGE,
    env: { ...process.env, FACTORY_TEST_LOCK_HOLDER: JSON.stringify({ ...base, tag: 'child', ...options }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let out = ''
  let err = ''
  const said = (word: string): Promise<void> => {
    const promise = new Promise<void>((resolve, reject) => {
      const check = (): void => void (out.split('\n').includes(word) && resolve())
      child.stdout!.on('data', check)
      child.on('exit', (code, signal) => reject(new Error(`the holder process ended (${code ?? signal}) before ${word}: ${err}`)))
    })
    promise.catch(() => {})
    return promise
  }
  child.stdout!.prependListener('data', (chunk: Buffer) => void (out += chunk.toString()))
  child.stderr!.on('data', (chunk: Buffer) => void (err += chunk.toString()))
  return { child, waiting: said('WAITING'), held: said('HELD') }
}

/** The backends of a holder process, found by the application_name the kit gives them (it holds the client's pid). */
async function backendsOf(child: ChildProcess): Promise<Array<{ pid: number; granted: boolean | null }>> {
  const { rows } = await probe.query<{ pid: number; granted: boolean | null }>(
    `SELECT a.pid, l.granted FROM pg_stat_activity a
       LEFT JOIN pg_locks l ON l.pid = a.pid AND l.locktype = 'advisory'
      WHERE a.datname = current_database() AND starts_with(a.application_name, $1)`,
    [`${TEST_KIT_APPLICATION} lock ${child.pid} `],
  )
  return rows
}

async function until(what: string, check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const started = performance.now()
  while (!(await check())) {
    if (elapsed(started) > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

const alive = async (pid: number): Promise<boolean> =>
  (await probe.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rowCount === 1

beforeAll(async () => {
  root = new pg.Client({ connectionString: server.href, application_name: testKitApplicationName('root', 'lockkey') })
  await root.connect()
  await root.query(`CREATE DATABASE "${LOCK_DB}"`)
  probe = new pg.Client({ connectionString: lockUrl(), application_name: testKitApplicationName('probe', 'lockkey') })
  await probe.connect()
  base = { url: lockUrl(), key: KEY, tag: 'lockkey', idleBoundMs: IDLE_BOUND, heartbeatMs: 300, checkEveryMs: 300, staleAfterMs: 60_000, waitMaxMs: 30_000, holdMaxMs: 30_000 }
}, 60_000)

afterAll(async () => {
  for (const child of children) child.kill('SIGKILL')
  await probe?.end().catch(() => {})
  // Our own database: FORCE ends only the sessions of this file's holders.
  await root?.query(`DROP DATABASE IF EXISTS "${LOCK_DB}" WITH (FORCE)`)
  await root?.end()
}, 60_000)

describe('the test migration lock', () => {
  it('lets one build at a time hold it: three at once take turns', async () => {
    const spans: Array<[number, number]> = []
    const build = (n: number): Promise<void> =>
      withMigrationLock({ ...base, tag: `build${n}` }, async (signal) => {
        const start = performance.now()
        await sleep(150)
        expect(await lockHolder(probe, KEY)).toMatchObject({ testKit: true, applicationName: testKitApplicationName('lock', `build${n}`) })
        await sleep(150)
        signal.throwIfAborted()
        spans.push([start, performance.now()])
      })
    await Promise.all([build(1), build(2), build(3)])
    spans.sort((a, b) => a[0] - b[0])
    expect(spans).toHaveLength(3)
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1])
    expect(await lockHolder(probe, KEY)).toBeUndefined()
  }, 30_000)

  it('is given back at once when its holder process is killed', async () => {
    const holder = startHolder({ idleBoundMs: 20_000, heartbeatMs: 1_000 })
    await holder.held
    const started = performance.now()
    holder.child.kill('SIGKILL')
    await withMigrationLock(base, async () => {})
    // Far below the holder's own 20 s idle bound: the closed socket freed it.
    expect(elapsed(started)).toBeLessThan(10_000)
  }, 30_000)

  it('is taken from a holder that stops acting while it holds, by the server, after the idle bound', async () => {
    const holder = startHolder()
    await holder.held
    const [backend] = await backendsOf(holder.child)
    expect(backend).toMatchObject({ granted: true })
    holder.child.kill('SIGSTOP')
    const started = performance.now()
    await withMigrationLock(base, async () => {})
    const waited = elapsed(started)
    expect(waited).toBeGreaterThanOrEqual(IDLE_BOUND - 400)
    expect(waited).toBeLessThan(IDLE_BOUND + 5_000)
    // The server ended the frozen holder's session; its process is still there, stopped.
    expect(await alive(backend!.pid)).toBe(false)
    expect(holder.child.exitCode).toBeNull()
    holder.child.kill('SIGKILL')
  }, 30_000)

  it('is taken from a waiter that stopped acting in the queue and got its turn while frozen', async () => {
    let release!: () => void
    const first = withMigrationLock(base, () => new Promise<void>((resolve) => (release = resolve)))
    await until('the first build to hold the lock', async () => (await lockHolder(probe, KEY)) !== undefined)
    // A long wait per try, so the frozen waiter stays in the queue and is granted the lock while it cannot act.
    const waiter = startHolder({ checkEveryMs: 30_000 })
    await waiter.waiting
    await until('the waiter to queue', async () => (await backendsOf(waiter.child)).some((row) => row.granted === false))
    waiter.child.kill('SIGSTOP')
    release()
    await first
    await until('the frozen waiter to be granted the lock', async () => (await backendsOf(waiter.child)).some((row) => row.granted === true))
    const started = performance.now()
    await withMigrationLock(base, async () => {})
    expect(elapsed(started)).toBeLessThan(IDLE_BOUND + 5_000)
    expect(await backendsOf(waiter.child)).toEqual([])
    waiter.child.kill('SIGKILL')
  }, 30_000)

  it('names a session outside the test kit that sits on it, and leaves that session alone', async () => {
    // Like the kit before F11: a session-level lock on the same key, on a connection that then does nothing.
    const foreign = new pg.Client({ connectionString: lockUrl(), application_name: 'f11 foreign holder' })
    foreign.on('error', () => {})
    await foreign.connect()
    try {
      const pid = (await foreign.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      await foreign.query('SELECT pg_advisory_lock($1::bigint)', [KEY])
      const error = await withMigrationLock({ ...base, staleAfterMs: 1_500 }, async () => {}).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(MigrationLockError)
      const message = (error as MigrationLockError).message
      expect(message).toContain(`pid ${pid} (application_name "f11 foreign holder", outside the test kit; state idle;`)
      expect(message).toMatch(/idle for \d+ s; connected \d+ s ago; last query "SELECT pg_advisory_lock\(\$1::bigint\)"\)/)
      expect(message).toContain('never ends another session')
      expect((error as MigrationLockError).holder).toMatchObject({ pid, testKit: false, state: 'idle' })
      // Never ended: it still holds the lock.
      expect(await alive(pid)).toBe(true)
      expect((await lockHolder(probe, KEY))?.pid).toBe(pid)

      // A holder that is busy is not stuck; the wait still has an end.
      const busy = foreign.query('SELECT pg_sleep(3)')
      await until('the foreign holder to be busy', async () => (await lockHolder(probe, KEY))?.state === 'active')
      const waited = await withMigrationLock({ ...base, staleAfterMs: 500, waitMaxMs: 1_000 }, async () => {}).catch((caught: unknown) => caught)
      expect(waited).toBeInstanceOf(MigrationLockError)
      expect((waited as Error).message).toMatch(/^Gave up after waiting \d+ s for the test migration lock .*it is held by pid \d+ .*state active/)
      await busy
    } finally {
      await foreign.query('SELECT pg_advisory_unlock_all()').catch(() => {})
      await foreign.end()
    }
    expect(await lockHolder(probe, KEY)).toBeUndefined()
  }, 30_000)

  it('is given back when a build fails or holds it too long', async () => {
    await expect(withMigrationLock(base, async () => Promise.reject(new Error('a migration failed')))).rejects.toThrow('a migration failed')
    expect(await lockHolder(probe, KEY)).toBeUndefined()

    let seen: AbortSignal | undefined
    const stuck = withMigrationLock({ ...base, holdMaxMs: 800 }, (signal) => {
      seen = signal
      return new Promise<never>(() => {})
    })
    await expect(stuck).rejects.toThrow(/^The test migration lock was lost: the build held it longer than 1 s$/)
    expect(seen?.aborted).toBe(true)
    const started = performance.now()
    await withMigrationLock(base, async () => {})
    expect(elapsed(started)).toBeLessThan(1_000)
  }, 30_000)
})
