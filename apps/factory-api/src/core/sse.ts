import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { Redis } from 'ioredis'
import { EVENT_CATALOGUE, type EventCatalogue } from '@nexus/factory-domain/events/catalogue'
import { liveMessage, type LiveMessage } from '@nexus/factory-domain/events/envelope'
import { liveViewFor } from '@nexus/factory-domain/events/live'
import { loadFactoryEnv } from '../env'
import { actorOf, requireContext } from './context'
import { ApiError } from './errors'
import type { Log } from './queue'

/**
 * Live screens (plan A1 §3.5, ported from Commerce's apps/api/src/lib/sse.ts): the worker's dispatcher publishes a
 * small "record changed" message per event on Redis pub/sub, one channel per tenant (`<prefix>:live:<tenantId>`); the
 * API's SSE endpoint (`GET /live`, platform/outbox/routes.ts) streams to each signed-in screen what that viewer may see:
 * `liveViewFor` (factory-domain/events/live.ts) decides per message and per viewer, from the API's own catalogue and the
 * viewer's grants. Never another tenant's event (the channel and the message are both checked), never a money field,
 * the floor only its own site's floor events. No database polling per client.
 *
 * One process holds ONE subscriber connection (LiveFeed) and subscribes a tenant's channel while a screen of that
 * tenant is connected. Messages are hints: a screen that reconnects refetches; there is no replay (Last-Event-ID).
 *
 * Wire format (text/event-stream):
 *   retry: 5000
 *   event: ready        once, when the subscription is live
 *   : ping              every heartbeatMs (default 20 s; A1: 25 s or less), so proxies keep the stream open
 *   id: <eventId>
 *   event: change
 *   data: {"eventId","type","version","subject","companyId","siteId","occurredAt","fields"}
 */

/** The pub/sub channel of one tenant's live messages. */
export function liveChannel(prefix: string, tenantId: string): string {
  return `${prefix}:live:${tenantId}`
}

/** Publishes one live message on its tenant's channel (the dispatcher). Returns the number of receiving processes. */
export async function publishLive(redis: Redis, prefix: string, message: LiveMessage): Promise<number> {
  return redis.publish(liveChannel(prefix, message.tenantId), JSON.stringify(liveMessage.parse(message)))
}

type Listener = (message: LiveMessage) => void


/** One subscriber connection per process, fanning a tenant's messages out to the screens of that tenant. */
export class LiveFeed {
  readonly #connect: () => Redis
  readonly #log: Log | undefined
  readonly #readyTimeoutMs: number
  readonly prefix: string
  #subscriber: Redis | undefined
  readonly #listeners = new Map<string, Set<Listener>>()
  /** Per tenant: the SUBSCRIBE of its channel, which every listener of that tenant waits for. */
  readonly #subscribed = new Map<string, Promise<unknown>>()
  #closed = false

  /** `readyTimeoutMs`: how long a new screen waits for the subscriber connection (default 5 s). */
  constructor(options: { readonly connect: () => Redis; readonly prefix: string; readonly log?: Log; readonly readyTimeoutMs?: number }) {
    this.#connect = options.connect
    this.prefix = options.prefix
    this.#log = options.log
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 5_000
  }

  /**
   * The subscriber, once ready (a command sent before ioredis's ready check would meet subscriber mode). Redis that does
   * not answer within readyTimeoutMs is a 503 for this screen; ioredis keeps reconnecting for the next one.
   */
  async #connection(): Promise<Redis> {
    if (!this.#subscriber) {
      const subscriber = this.#connect()
      subscriber.on('message', (channel: string, text: string) => this.#deliver(channel, text))
      subscriber.on('error', (error) => this.#log?.warn({ err: error }, 'live feed: Redis subscriber error'))
      this.#subscriber = subscriber
    }
    const subscriber = this.#subscriber
    if (subscriber.status !== 'ready') {
      try {
        await once(subscriber, 'ready', { signal: AbortSignal.timeout(this.#readyTimeoutMs) })
      } catch {
        throw new ApiError('not_ready', 'Live updates are not available right now.')
      }
    }
    return subscriber
  }

  #deliver(channel: string, text: string): void {
    const tenantId = channel.startsWith(`${this.prefix}:live:`) ? channel.slice(this.prefix.length + 6) : undefined
    const listeners = tenantId === undefined ? undefined : this.#listeners.get(tenantId)
    if (!listeners || listeners.size === 0) return
    let message: LiveMessage
    try {
      message = liveMessage.parse(JSON.parse(text))
    } catch {
      this.#log?.warn({ channel }, 'live feed: a message that is not a live message was dropped')
      return
    }
    // The channel names the tenant, and so must the message: a message on the wrong channel goes nowhere.
    if (message.tenantId !== tenantId) return
    for (const listener of listeners) {
      try {
        listener(message)
      } catch (error) {
        this.#log?.warn({ err: error }, 'live feed: a listener failed')
      }
    }
  }

  /** Listens to one tenant's messages; resolves once subscribed, with the function that stops listening. */
  async listen(tenantId: string, listener: Listener): Promise<() => Promise<void>> {
    if (this.#closed) throw new ApiError('not_ready', 'Live updates are closing.')
    let listeners = this.#listeners.get(tenantId)
    const first = !listeners
    if (!listeners) {
      listeners = new Set()
      this.#listeners.set(tenantId, listeners)
    }
    listeners.add(listener)
    if (first) this.#subscribed.set(tenantId, this.#connection().then((subscriber) => subscriber.subscribe(liveChannel(this.prefix, tenantId))))
    try {
      await this.#subscribed.get(tenantId)
    } catch (error) {
      listeners.delete(listener)
      if (listeners.size === 0 && this.#listeners.get(tenantId) === listeners) {
        this.#listeners.delete(tenantId)
        this.#subscribed.delete(tenantId)
      }
      throw error
    }
    let done = false
    return async () => {
      if (done) return
      done = true
      const set = this.#listeners.get(tenantId)
      set?.delete(listener)
      if (set && set.size === 0) {
        this.#listeners.delete(tenantId)
        this.#subscribed.delete(tenantId)
        if (!this.#closed) await this.#subscriber?.unsubscribe(liveChannel(this.prefix, tenantId)).catch(() => {})
      }
    }
  }

  /** The tenants with a screen connected (tests, monitoring). */
  tenants(): string[] {
    return [...this.#listeners.keys()].sort()
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#listeners.clear()
    this.#subscribed.clear()
    this.#subscriber?.disconnect()
    this.#subscriber = undefined
  }
}

let configured: LiveFeed | undefined
let fromEnv: LiveFeed | undefined

/** Sets the process's live feed (the API's index.ts or a test); undefined goes back to the one made from the env. */
export function useLiveFeed(feed: LiveFeed | undefined): void {
  configured = feed
}

/** The process's live feed: the configured one, else one made on first use from apps/factory-api/.env (Redis, prefix). */
export function processLiveFeed(): LiveFeed {
  if (configured) return configured
  if (!fromEnv) {
    const env = loadFactoryEnv()
    fromEnv = new LiveFeed({ prefix: env.FACTORY_QUEUE_PREFIX, connect: () => new Redis(env.FACTORY_REDIS_URL, { maxRetriesPerRequest: null }) })
  }
  return fromEnv
}

/** Closes the feed made from the env, if any (the app's onClose). A configured feed belongs to whoever set it. */
export async function closeProcessLiveFeed(): Promise<void> {
  const feed = fromEnv
  fromEnv = undefined
  await feed?.close()
}

export interface LiveStreamOptions {
  readonly feed: LiveFeed
  readonly catalogue?: EventCatalogue
  /** Default 20 s. */
  readonly heartbeatMs?: number
  /** Called with the stream's closer; the route ends every open stream when the app closes. */
  readonly track?: (close: () => void) => () => void
}

/** A stream that falls this far behind (a stalled screen) is ended; the screen reconnects and refetches. */
const MAX_BUFFERED_BYTES = 1_048_576

/** Answers a request with the viewer's live stream. The route's manifest admits only office and floor sessions. */
export async function serveLiveStream(request: FastifyRequest, reply: FastifyReply, options: LiveStreamOptions): Promise<FastifyReply> {
  const context = requireContext(request)
  if (context.audience !== 'office' && context.audience !== 'floor') throw new ApiError('internal_error', 'Live updates serve office and floor screens only.')
  const actor = actorOf(context)
  const catalogue = options.catalogue ?? EVENT_CATALOGUE
  const stream = new PassThrough()
  const socket = reply.raw.socket
  let open = true
  let unlisten: (() => Promise<void>) | undefined
  let untrack: (() => void) | undefined
  let heartbeat: NodeJS.Timeout | undefined

  const close = (): void => {
    if (!open) return
    open = false
    clearInterval(heartbeat)
    untrack?.()
    void unlisten?.()
    stream.end()
    // A screen that stopped reading cannot hold the socket (or a shutdown) open: it is cut after a grace second.
    setTimeout(() => socket?.destroy(), 1_000).unref()
  }
  const send = (text: string): void => {
    if (!open) return
    if (stream.writableLength > MAX_BUFFERED_BYTES) return close()
    stream.write(text)
  }

  reply.raw.once('close', close)
  const stop = await options.feed.listen(context.tenantId, (message) => {
    const view = liveViewFor(message, actor, catalogue)
    if (view) send(`id: ${view.eventId}\nevent: change\ndata: ${JSON.stringify(view)}\n\n`)
  })
  if (!open) {
    // The screen left while the subscription was being made.
    void stop()
  } else {
    unlisten = stop
    untrack = options.track?.(close)
    heartbeat = setInterval(() => send(': ping\n\n'), options.heartbeatMs ?? 20_000)
    heartbeat.unref()
    send('retry: 5000\n\nevent: ready\ndata: {}\n\n')
  }
  return reply
    .header('content-type', 'text/event-stream; charset=utf-8')
    .header('cache-control', 'no-cache, no-transform')
    .header('x-accel-buffering', 'no')
    // A stream is never reused for another request: when it ends (the screen left, or the app closes) the socket
    // closes with it, so a shutdown does not wait out the keep-alive timeout.
    .header('connection', 'close')
    .send(stream)
}
