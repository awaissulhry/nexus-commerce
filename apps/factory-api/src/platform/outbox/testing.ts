import { randomBytes } from 'node:crypto'
import { get, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { Redis } from 'ioredis'
import { describeUrlHost, isLoopbackUrl } from '@nexus/db-kit/url-guard'
import { readFactoryVariables } from '../../env'

/**
 * Test support for the outbox, queue, cron and live-screen tests (imported by tests only). Redis is the local stack's
 * (127.0.0.1:6399, or FACTORY_REDIS_URL from apps/factory-api/.env); loopback only. The local Redis is shared by every
 * worktree, so each test file works under its own random prefix, `<FACTORY_QUEUE_PREFIX or test>_t<hex>`, and deletes
 * every key under it at the end.
 */
export interface TestRedis {
  readonly url: string
  readonly prefix: string
  /** A new connection (BullMQ-ready); closed by cleanup(). */
  connect(): Redis
  /** Deletes every key under the prefix and closes the connections. */
  cleanup(): Promise<void>
}

export function testRedis(): TestRedis {
  const variables = readFactoryVariables()
  const url = variables.FACTORY_REDIS_URL ?? 'redis://127.0.0.1:6399'
  if (!isLoopbackUrl(url)) throw new Error(`Factory Redis tests refused to start: ${describeUrlHost(url)} is not on this machine (loopback only).`)
  const prefix = `${variables.FACTORY_QUEUE_PREFIX || 'test'}_t${randomBytes(4).toString('hex')}`
  const connections: Redis[] = []
  return {
    url,
    prefix,
    connect() {
      const connection = new Redis(url, { maxRetriesPerRequest: null })
      connections.push(connection)
      return connection
    },
    async cleanup() {
      const admin = new Redis(url, { maxRetriesPerRequest: 1 })
      try {
        let cursor = '0'
        do {
          const [next, keys] = await admin.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500)
          cursor = next
          if (keys.length > 0) await admin.del(...keys)
        } while (cursor !== '0')
      } finally {
        admin.disconnect()
        for (const connection of connections.splice(0)) connection.disconnect()
      }
    },
  }
}

/** One server-sent event as the stream delivered it. */
export interface StreamedEvent {
  readonly event: string
  readonly id?: string
  readonly data: unknown
}

export interface EventStream {
  /** Every event so far, in order. */
  readonly events: StreamedEvent[]
  /** Waits for the next event (after the ones already returned) that matches. */
  next(match?: (event: StreamedEvent) => boolean, timeoutMs?: number): Promise<StreamedEvent>
  /** Comment lines (heartbeats) so far. */
  pings(): number
  /** Ends the request (the socket closes). */
  close(): Promise<void>
}

/**
 * Opens an SSE stream with node:http, one socket per stream and no pool (fetch's pool opens spare connections, which
 * a closing server then waits on). Resolves once the headers are in.
 */
export function openEventStream(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; stream: EventStream }> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { accept: 'text/event-stream', ...headers }, agent: false }, (response) => {
      resolve({ status: response.statusCode ?? 0, headers: response.headers, stream: eventStream(response, () => request.destroy()) })
    })
    request.on('error', reject)
  })
}

function eventStream(response: IncomingMessage, destroy: () => void): EventStream {
  const events: StreamedEvent[] = []
  let pings = 0
  let buffer = ''
  let waiting: (() => void) | undefined
  const ended = new Promise<void>((resolve) => {
    response.once('close', resolve)
    response.once('end', resolve)
  })
  response.setEncoding('utf8')
  response.on('error', () => {})
  response.on('data', (chunk: string) => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      let event = 'message'
      let id: string | undefined
      const data: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) pings++
        else if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('id: ')) id = line.slice(4)
        else if (line.startsWith('data: ')) data.push(line.slice(6))
      }
      if (data.length > 0) events.push({ event, ...(id ? { id } : {}), data: JSON.parse(data.join('\n')) })
      waiting?.()
    }
  })
  let read = 0
  return {
    events,
    pings: () => pings,
    async next(match = () => true, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        while (read < events.length) {
          const event = events[read++]!
          if (match(event)) return event
        }
        const left = deadline - Date.now()
        if (left <= 0) throw new Error('no matching server-sent event in time')
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left)
          waiting = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
    },
    async close() {
      destroy()
      await ended
    },
  }
}

/** Waits until `check` holds (polling), or fails after `timeoutMs`. */
export async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 10_000, everyMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('the condition did not hold in time')
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}
