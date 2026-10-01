/**
 * A Postgres LISTEN that wakes a worker at once: the instant path beside its poll. A trigger calls
 * pg_notify(<channel>) in the writer's transaction; Postgres delivers it at COMMIT. A lost or refused
 * connection only means the worker's own poll covers the gap, so this never throws to its caller:
 * it logs, then reconnects with a back-off (5 s, doubling, at most 60 s).
 *
 * Used by the shared stock worker (`nexus_stock_pool`, Owner 2026-10-01: "the change of the stock
 * whenever an item sells must happen in real time"). `listenUrlFrom` is shared with the assortment sync
 * worker, which keeps its own listener.
 */
import { Client } from 'pg'
import { logger } from '../utils/logger.js'

/**
 * The URL to LISTEN on: DIRECT_URL, else DATABASE_URL with Neon's `-pooler` taken off the host — the rule
 * packages/database/scripts/migrate-direct.mjs uses for migrations (one credential, so it follows a rotation).
 * A notify does not reach a LISTEN made through the pooler (PgBouncer in transaction mode gives the server
 * session back after each statement). Nothing else in this repo reads DIRECT_URL (migrate-direct.mjs names only
 * DIRECT_DATABASE_URL on Railway): with DATABASE_URL alone the worker would only poll there (up to 60 s when
 * quiet) while the local measurement said 0.1 s (build doc §7).
 */
export function listenUrlFrom(env: NodeJS.ProcessEnv): string | null {
  if (env.DIRECT_URL) return env.DIRECT_URL
  if (!env.DATABASE_URL) return null
  let url: URL
  try { url = new URL(env.DATABASE_URL) } catch { throw new Error('Listener requires a valid PostgreSQL URL') }
  if (url.hostname.endsWith('.neon.tech')) url.hostname = url.hostname.replace(/-pooler(?=\.)/, '')
  return url.toString()
}

export interface WakeListenerOptions {
  /** The notify channel: a plain lowercase identifier, as the trigger names it. */
  channel: string
  /** The connection to LISTEN on; null: none (the worker polls only). */
  url: string | null
  /** Called on every notify, and once after each (re)connect for anything written while not listening. */
  wake: () => void
  /** For the log lines. */
  label: string
}

/** Start listening. Returns the stop function. */
export function startWakeListener(options: WakeListenerOptions): () => Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(options.channel)) throw new Error(`Invalid notify channel: ${options.channel}`)
  let stopped = false
  let client: Client | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let delay = 5_000

  const reconnect = () => {
    if (stopped || timer) return
    const dropped = client
    client = null
    dropped?.end().catch(() => { /* already closed */ })
    timer = setTimeout(() => { timer = null; void listen() }, delay)
    timer.unref?.()
    delay = Math.min(delay * 2, 60_000)
  }

  const listen = async () => {
    if (stopped || !options.url) return
    const next = new Client({ connectionString: options.url })
    client = next
    next.on('notification', () => { if (!stopped) options.wake() })
    next.on('error', (error) => {
      logger.warn(`${options.label}: listener connection failed; polling covers it`, { error: error.message })
      reconnect()
    })
    next.on('end', reconnect)
    try {
      await next.connect()
      await next.query(`LISTEN ${options.channel}`)
      logger.info(`${options.label}: listening`, { pooled: options.url.includes('-pooler') })
      delay = 5_000
      if (!stopped) options.wake() // anything written while we were not listening
    } catch (error) {
      logger.warn(`${options.label}: could not listen; polling covers it`, { error: error instanceof Error ? error.message : String(error) })
      reconnect()
    }
  }

  void listen()
  return async () => {
    stopped = true
    if (timer) clearTimeout(timer)
    const open = client
    client = null
    open?.removeAllListeners('end')
    await open?.end().catch(() => { /* closing */ })
  }
}
