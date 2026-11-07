import pg from 'pg'

/**
 * The lock that serialises building test databases on one server (B-W2b-F11). The migrations create cluster-wide roles,
 * so two builds must never migrate at the same time; and a build that stops acting must never keep the others waiting.
 *
 *   take     a TRANSACTION-level advisory lock (pg_advisory_xact_lock) on a connection of its own, opened for the build
 *            and closed in a `finally`: the lock cannot outlive the build's connection, and a dead process frees it at
 *            once (the server reads the closed socket).
 *   hold     the connection says "still here" (`SELECT 1`) every heartbeatMs, and its session carries
 *            idle_in_transaction_session_timeout = idleBoundMs: a process that is alive but stopped acting (frozen,
 *            stalled, a lost socket) loses its session, and so the lock, to the SERVER after idleBoundMs. A build that
 *            holds the lock longer than holdMaxMs gives it back and fails.
 *   wait     in the queue for checkEveryMs at a time (lock_timeout); in between, the holder is read from pg_locks and
 *            pg_stat_activity. A holder idle for staleAfterMs, or a wait longer than waitMaxMs, ends the wait with a
 *            MigrationLockError that names the holder (pid, application_name, state, idle time, last query).
 *   names    every connection of the test kit carries an application_name that starts with TEST_KIT_APPLICATION and
 *            holds the client's process id (Docker hides the client's port, so pg_stat_activity cannot name it).
 *
 * Nothing here ends another session: a holder outside the test kit (an older worktree's tests, check-migrations-replay)
 * is named in the error, never terminated. A transaction-level and a session-level lock on the same key exclude each
 * other, so this lock still serialises against code that takes the old session-level one.
 */

/** The start of the application_name of every connection the test kit opens. */
export const TEST_KIT_APPLICATION = 'factory-test'

/** application_name is cut by the server at 63 bytes; cut it here so what is set is what is read back. */
export function testKitApplicationName(role: string, tag: string): string {
  return `${TEST_KIT_APPLICATION} ${role} ${process.pid} ${tag}`.slice(0, 63)
}

export interface MigrationLockOptions {
  /** A connection URL; the lock lives in its database (advisory locks are per database). */
  readonly url: string
  /** The advisory-lock key, a bigint as text. */
  readonly key: string
  /** Who builds, shown in the holder's application_name, e.g. the test database's name. */
  readonly tag: string
  /** The server ends the lock's session when it sits idle this long while holding (default 60 s). */
  readonly idleBoundMs?: number
  /** How often the holder shows it is alive (default: a quarter of idleBoundMs, at most 5 s). */
  readonly heartbeatMs?: number
  /** One wait in the queue before the holder is read again (default 5 s). */
  readonly checkEveryMs?: number
  /** A holder idle this long is stuck: the wait ends with an error that names it (default 180 s). */
  readonly staleAfterMs?: number
  /** The longest wait in all (default 15 min). */
  readonly waitMaxMs?: number
  /** The longest hold: the lock is given back and the build fails (default 5 min). */
  readonly holdMaxMs?: number
}

/** The session holding the lock, as pg_stat_activity shows it. */
export interface LockHolder {
  readonly pid: number
  readonly applicationName: string
  /** Its application_name starts with TEST_KIT_APPLICATION. */
  readonly testKit: boolean
  readonly state: string | null
  readonly waitEvent: string | null
  /** Since its state last changed (for an idle session: how long it has done nothing). */
  readonly idleMs: number
  readonly connectedMs: number
  readonly query: string
}

export class MigrationLockError extends Error {
  readonly holder: LockHolder | undefined
  constructor(message: string, holder?: LockHolder) {
    super(message)
    this.name = 'MigrationLockError'
    this.holder = holder
  }
}

const IDLE_STATES = new Set(['idle', 'idle in transaction', 'idle in transaction (aborted)'])
const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`

/** One line about the holder, for an error or a warning. */
function describeHolder(holder: LockHolder): string {
  const who = holder.testKit ? 'the test kit' : 'outside the test kit'
  const idle = IDLE_STATES.has(holder.state ?? '')
  // An idle session always "waits" on ClientRead; only a busy one's wait says something.
  const wait = !idle && holder.waitEvent ? `, waiting on ${holder.waitEvent}` : ''
  return (
    `pid ${holder.pid} (application_name ${JSON.stringify(holder.applicationName)}, ${who}; state ${holder.state ?? 'unknown'}${wait}; ` +
    `${idle ? `idle for ${seconds(holder.idleMs)}` : `in this state for ${seconds(holder.idleMs)}`}; ` +
    `connected ${seconds(holder.connectedMs)} ago; last query ${JSON.stringify(holder.query)})`
  )
}

/** The session that holds the lock in the client's database, if any. */
export async function lockHolder(client: pg.Client, key: string): Promise<LockHolder | undefined> {
  const { rows } = await client.query<{
    pid: number
    application_name: string
    state: string | null
    wait_event: string | null
    idle_ms: string
    connected_ms: string
    query: string
  }>(
    `SELECT a.pid, coalesce(a.application_name, '') AS application_name, a.state, a.wait_event,
            (extract(epoch FROM now() - coalesce(a.state_change, a.backend_start)) * 1000)::bigint AS idle_ms,
            (extract(epoch FROM now() - a.backend_start) * 1000)::bigint AS connected_ms,
            left(coalesce(a.query, ''), 160) AS query
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND l.mode = 'ExclusiveLock' AND l.objsubid = 1
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.classid = ($1::bigint >> 32)::oid AND l.objid = ($1::bigint & 4294967295)::oid
      LIMIT 1`,
    [key],
  )
  const row = rows[0]
  if (!row) return undefined
  return {
    pid: row.pid,
    applicationName: row.application_name,
    testKit: row.application_name.startsWith(`${TEST_KIT_APPLICATION} `),
    state: row.state,
    waitEvent: row.wait_event,
    idleMs: Number(row.idle_ms),
    connectedMs: Number(row.connected_ms),
    query: row.query,
  }
}

const LOCK_TIMEOUT = '55P03'

/**
 * Runs `work` while this process alone holds the lock. `work` gets a signal that aborts when the lock is lost (the
 * server ended the session, or holdMaxMs passed); check it between steps. The lock is given back when `work` settles.
 */
export async function withMigrationLock<T>(options: MigrationLockOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const idleBoundMs = options.idleBoundMs ?? 60_000
  const heartbeatMs = options.heartbeatMs ?? Math.min(5_000, Math.floor(idleBoundMs / 4))
  const checkEveryMs = options.checkEveryMs ?? 5_000
  const staleAfterMs = options.staleAfterMs ?? 180_000
  const waitMaxMs = options.waitMaxMs ?? 900_000
  const holdMaxMs = options.holdMaxMs ?? 300_000
  if (!(heartbeatMs > 0 && heartbeatMs < idleBoundMs)) throw new Error('withMigrationLock: heartbeatMs must be above 0 and below idleBoundMs.')

  const controller = new AbortController()
  const lose = (message: string): void => {
    if (!controller.signal.aborted) controller.abort(new MigrationLockError(`The test migration lock was lost: ${message}`))
  }
  const client = new pg.Client({ connectionString: options.url, application_name: testKitApplicationName('lock', options.tag) })
  // A session the server ends emits 'error' on an idle client; without a listener that would crash the process.
  client.on('error', (error) => lose(error.message))
  let beat: NodeJS.Timeout | undefined
  let cap: NodeJS.Timeout | undefined
  try {
    await client.connect()
    await client.query(`SELECT set_config('idle_in_transaction_session_timeout', $1, false), set_config('lock_timeout', $2, false)`, [
      `${idleBoundMs}ms`,
      `${checkEveryMs}ms`,
    ])

    const started = Date.now()
    const warned = new Set<number>()
    for (;;) {
      await client.query('BEGIN')
      try {
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [options.key])
        break
      } catch (error) {
        if ((error as { code?: string }).code !== LOCK_TIMEOUT) throw error
        await client.query('ROLLBACK')
      }
      const holder = await lockHolder(client, options.key)
      const waited = Date.now() - started
      const idle = holder !== undefined && IDLE_STATES.has(holder.state ?? '')
      if (holder && idle && holder.idleMs >= staleAfterMs) {
        throw new MigrationLockError(
          `The test migration lock (key ${options.key}) is held by a session that does nothing: ${describeHolder(holder)}. ` +
            `Gave up after waiting ${seconds(waited)}. The test kit never ends another session: stop that process, or end the session by hand.`,
          holder,
        )
      }
      if (waited >= waitMaxMs) {
        throw new MigrationLockError(
          `Gave up after waiting ${seconds(waited)} for the test migration lock (key ${options.key}); ` +
            `${holder ? `it is held by ${describeHolder(holder)}` : 'nobody held it at the last look'}.`,
          holder,
        )
      }
      if (holder && idle && holder.idleMs >= idleBoundMs && !warned.has(holder.pid)) {
        warned.add(holder.pid)
        console.warn(`Waiting for the test migration lock: it is held by ${describeHolder(holder)}.`)
      }
    }

    // Held. Show the server we are alive; it ends the session (and the lock) if we stop.
    let pending = false
    beat = setInterval(() => {
      if (pending || controller.signal.aborted) return
      pending = true
      client.query('SELECT 1').then(
        () => void (pending = false),
        (error: Error) => lose(error.message),
      )
    }, heartbeatMs)
    beat.unref()
    cap = setTimeout(() => lose(`the build held it longer than ${seconds(holdMaxMs)}`), holdMaxMs)
    cap.unref()

    const lost = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason)
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    lost.catch(() => {})
    const done = work(controller.signal)
    done.catch(() => {})
    const result = await Promise.race([done, lost])
    clearInterval(beat)
    if (controller.signal.aborted) throw controller.signal.reason
    await client.query('COMMIT')
    return result
  } finally {
    clearInterval(beat)
    clearTimeout(cap)
    // Closing the connection gives the lock back whatever happened above.
    await client.end().catch(() => {})
  }
}
