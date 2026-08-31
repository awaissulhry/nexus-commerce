// EV.1 — Redis Streams driver.
//
// One stream per shard (`nexus.events.v1.<n>`), consumer groups for durability,
// XAUTOCLAIM to recover work from a replica that died mid-handler.
//
// Two connection rules that are load-bearing:
//
//  1. Consumers get their OWN client. XREADGROUP BLOCK occupies a connection
//     for the whole block interval; sharing the BullMQ client would stall every
//     queue in the process behind our read loop.
//  2. The publish path uses a separate non-blocking client, so a slow consumer
//     can never delay the relay.
//
// Streams are capped with MAXLEN ~ (approximate trimming — it only drops whole
// nodes, so it is far cheaper than exact). Retention here is a REPLAY window,
// not storage: the outbox is the durable record, and a consumer that falls
// further behind than the cap has to be replayed from Postgres, not Redis.

import Redis from 'ioredis'
import { resolveRedisTarget } from '../queue.js'
import { logger } from '../../utils/logger.js'
import { deserialiseEnvelope, serialiseEnvelope, type EventEnvelope } from '@nexus/events'
import {
  allStreamKeys,
  shardCount,
  shardFor,
  streamKey,
  type BroadcastOptions,
  type BrokerMessage,
  type EventBroker,
  type SubscribeOptions,
} from './broker.js'

const ENVELOPE_FIELD = 'envelope'
const BLOCK_MS = 5_000
const BATCH = 64
/** Reclaim work from a consumer that has held a message this long without acking. */
const CLAIM_IDLE_MS = 60_000

function streamMaxLen(): number {
  const raw = Number(process.env.EVENT_STREAM_MAXLEN ?? '100000')
  return Number.isInteger(raw) && raw > 0 ? raw : 100_000
}

function newClient(): Redis {
  const target = resolveRedisTarget(process.env)
  return target.kind === 'url'
    ? new Redis(target.url, target.options)
    : new Redis({ host: target.host, port: target.port, ...target.options })
}

export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL || process.env.REDIS_HOST)
}

type RawEntry = [id: string, fields: string[]]
type RawStream = [stream: string, entries: RawEntry[]]

export class RedisStreamsBroker implements EventBroker {
  readonly name = 'redis-streams'
  private publisher: Redis | null = null
  private consumers: Redis[] = []
  private stopping = false

  private pub(): Redis {
    if (!this.publisher) this.publisher = newClient()
    return this.publisher
  }

  async publish(envelopes: EventEnvelope[]): Promise<void> {
    if (envelopes.length === 0) return
    const pipeline = this.pub().pipeline()
    const maxLen = streamMaxLen()
    for (const envelope of envelopes) {
      const shard = shardFor(envelope.subject)
      // '~' = approximate trim. Exact trimming on every XADD is O(n) and would
      // put the cost of retention on the hot publish path.
      pipeline.xadd(streamKey(shard), 'MAXLEN', '~', String(maxLen), '*', ENVELOPE_FIELD, serialiseEnvelope(envelope))
    }
    const results = await pipeline.exec()
    const failure = results?.find(([err]) => err)
    if (failure?.[0]) throw failure[0]
  }

  async subscribe(options: SubscribeOptions): Promise<() => Promise<void>> {
    const streams = allStreamKeys()
    const client = newClient()
    this.consumers.push(client)

    for (const stream of streams) {
      try {
        // MKSTREAM so a group can be created before the first event exists —
        // otherwise a fresh environment cannot subscribe until something is
        // published, and the first event would be missed.
        await client.xgroup('CREATE', stream, options.group, '0', 'MKSTREAM')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('BUSYGROUP')) throw error
      }
    }

    let running = true
    const loop = (async () => {
      while (running && !this.stopping) {
        try {
          await this.reclaim(client, streams, options)
          const response = (await client.xreadgroup(
            'GROUP',
            options.group,
            options.consumer,
            'COUNT',
            BATCH,
            'BLOCK',
            BLOCK_MS,
            'STREAMS',
            ...streams,
            ...streams.map(() => '>'),
          )) as RawStream[] | null
          if (!response) continue
          for (const [stream, entries] of response) {
            for (const entry of entries) {
              await this.dispatch(client, stream, options, entry)
            }
          }
        } catch (error) {
          if (!running || this.stopping) break
          logger.error('event broker: consumer loop error', {
            group: options.group,
            error: error instanceof Error ? error.message : String(error),
          })
          // Back off so an unreachable Redis cannot spin this loop hot.
          await new Promise((resolve) => setTimeout(resolve, 2_000))
        }
      }
    })()

    return async () => {
      running = false
      await loop.catch(() => {})
      await client.quit().catch(() => {})
      this.consumers = this.consumers.filter((c) => c !== client)
    }
  }

  /**
   * Broadcast listener: plain XREAD from `$`, no consumer group.
   *
   * Deliberately stateless on the Redis side. A per-process consumer group
   * would leave a group behind on every ungraceful restart, each with its own
   * pending list, and nothing would ever collect them. XREAD holds its cursor
   * in this process, so a dead replica leaves nothing at all.
   */
  async subscribeBroadcast(options: BroadcastOptions): Promise<() => Promise<void>> {
    const streams = allStreamKeys()
    const client = newClient()
    this.consumers.push(client)

    // '$' = only entries added from now on. A broadcast listener has no
    // backlog by definition — it is not durable, and replaying history into an
    // SSE fan-out on every boot would spam every connected browser.
    const cursors = new Map<string, string>(streams.map((s) => [s, '$']))

    let running = true
    const loop = (async () => {
      while (running && !this.stopping) {
        try {
          const keys = [...cursors.keys()]
          const response = (await client.xread(
            'COUNT', BATCH, 'BLOCK', BLOCK_MS, 'STREAMS',
            ...keys,
            ...keys.map((k) => cursors.get(k) ?? '$'),
          )) as RawStream[] | null
          if (!response) continue

          for (const [stream, entries] of response) {
            for (const [id, fields] of entries) {
              cursors.set(stream, id)
              const index = fields.indexOf(ENVELOPE_FIELD)
              const raw = index >= 0 ? fields[index + 1] : undefined
              if (!raw) continue
              let message: BrokerMessage
              try {
                message = { ackId: id, shard: Number(stream.split('.').pop() ?? 0), envelope: deserialiseEnvelope(raw) }
              } catch {
                continue
              }
              try {
                await options.handler(message)
              } catch (error) {
                options.onError?.(error, message)
              }
            }
          }
        } catch (error) {
          if (!running || this.stopping) break
          logger.error('event broker: broadcast loop error', {
            error: error instanceof Error ? error.message : String(error),
          })
          await new Promise((resolve) => setTimeout(resolve, 2_000))
        }
      }
    })()

    return async () => {
      running = false
      await loop.catch(() => {})
      await client.quit().catch(() => {})
      this.consumers = this.consumers.filter((c) => c !== client)
    }
  }

  /**
   * Recover messages a dead consumer never acked. Without this, a replica that
   * is killed mid-handler strands its in-flight events in the group's pending
   * list forever — they are neither delivered nor lost, which is the worst of
   * both and invisible until someone asks why one product stopped updating.
   */
  private async reclaim(client: Redis, streams: string[], options: SubscribeOptions): Promise<void> {
    for (const stream of streams) {
      try {
        const [, entries] = (await client.xautoclaim(
          stream,
          options.group,
          options.consumer,
          CLAIM_IDLE_MS,
          '0',
          'COUNT',
          BATCH,
        )) as [string, RawEntry[]]
        for (const entry of entries ?? []) {
          await this.dispatch(client, stream, options, entry)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // NOGROUP just means nothing has been published to this shard yet.
        if (!message.includes('NOGROUP')) throw error
      }
    }
  }

  private async dispatch(
    client: Redis,
    stream: string,
    options: SubscribeOptions,
    [id, fields]: RawEntry,
  ): Promise<void> {
    const index = fields.indexOf(ENVELOPE_FIELD)
    const raw = index >= 0 ? fields[index + 1] : undefined
    if (!raw) {
      // Unreadable entry: ack it. Leaving it pending would make it a permanent
      // redelivery loop, and it can never become readable.
      logger.warn('event broker: entry has no envelope field, acking', { stream, id })
      await client.xack(stream, options.group, id)
      return
    }

    let message: BrokerMessage
    try {
      message = {
        ackId: id,
        shard: Number(stream.split('.').pop() ?? 0),
        envelope: deserialiseEnvelope(raw),
      }
    } catch (error) {
      logger.error('event broker: undeserialisable envelope, acking to avoid a poison loop', {
        stream,
        id,
        error: error instanceof Error ? error.message : String(error),
      })
      await client.xack(stream, options.group, id)
      return
    }

    try {
      await options.handler(message)
      await client.xack(stream, options.group, id)
    } catch (error) {
      // NOT acked: it stays pending and XAUTOCLAIM will redeliver it.
      options.onError?.(error, message)
      logger.warn('event broker: handler failed, leaving message pending for redelivery', {
        group: options.group,
        type: message.envelope.type,
        eventId: message.envelope.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async close(): Promise<void> {
    this.stopping = true
    await Promise.all(this.consumers.map((c) => c.quit().catch(() => {})))
    this.consumers = []
    await this.publisher?.quit().catch(() => {})
    this.publisher = null
  }
}

/** Diagnostics for the health endpoint: per-shard depth and per-group lag. */
export async function streamStats(): Promise<
  Array<{ stream: string; length: number; groups: Array<{ name: string; pending: number }> }>
> {
  if (!isRedisConfigured()) return []
  const client = newClient()
  try {
    const out = []
    for (const stream of allStreamKeys(shardCount())) {
      let length = 0
      let groups: Array<{ name: string; pending: number }> = []
      try {
        length = await client.xlen(stream)
        const raw = (await client.xinfo('GROUPS', stream)) as unknown[]
        groups = (raw ?? []).map((g) => {
          const flat = g as unknown[]
          const map = new Map<string, unknown>()
          for (let i = 0; i < flat.length; i += 2) map.set(String(flat[i]), flat[i + 1])
          return { name: String(map.get('name')), pending: Number(map.get('pending') ?? 0) }
        })
      } catch {
        // Stream does not exist yet — report it as empty rather than failing health.
      }
      out.push({ stream, length, groups })
    }
    return out
  } finally {
    await client.quit().catch(() => {})
  }
}
