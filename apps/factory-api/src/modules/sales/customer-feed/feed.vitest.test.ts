import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_FEED_KINDS,
  CUSTOMER_FEED_PAGE,
  CUSTOMER_FEED_TYPES,
  customerFeedKindOf,
  customerFeedTypesOf,
  NEVER_IN_CUSTOMER_FEED,
} from '@nexus/factory-domain/sales/customer-feed/kinds'
import { compareNewestFirst, decodeCursor, encodeCursor, type Positioned, type TimelineCursor } from '@nexus/factory-domain/threads/timeline'
import { NOT_SHAREABLE, THREAD_RECORDS } from '../../../platform/threads/records'
import { customerFeedContract } from './contract'
import { isNewToReader, mergeKey, mergeOrder, topK, type FeedThread } from './feed'
import { manifest } from './manifest'

/**
 * B-SA-060 (sales page plan R4; 13-backend B8; review C-1, BW-4, F-6) — the pure part of "All of <Customer>": which conversations
 * the feed merges, the top-k merge over many threads (newest first, a page of 30, as few message reads as possible) and its cursor
 * (pages without gaps or repeats), what is new to the reader. The database part: ./customer-feed.pg.vitest.test.ts.
 */

const t0 = Date.UTC(2026, 10, 18, 9, 0, 0)
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
type Entry = Positioned & { readonly threadId: string }

/** A made-up world: threads, each with its messages (newest first), and a reader that counts its reads like the API's query. */
function world(spec: Record<string, readonly number[]>) {
  let id = 0
  const threads: (FeedThread & { messages: Entry[] })[] = []
  for (const [name, minutes] of Object.entries(spec)) {
    const threadId = uuid(1000 + threads.length)
    const messages = minutes.map((minute) => ({ at: new Date(t0 + minute * 60_000), id: uuid(++id), threadId })).sort(compareNewestFirst)
    threads.push({ id: threadId, lastMessageAt: messages[0]!.at, messages, name } as FeedThread & { messages: Entry[]; name: string })
  }
  const asked: string[][] = []
  const read = (limit: number, cursor: TimelineCursor | null) => async (some: readonly (FeedThread & { messages: Entry[] })[]) => {
    asked.push(some.map((thread) => thread.id))
    return some
      .flatMap((thread) => thread.messages)
      .filter((entry) => cursor === null || compareNewestFirst(cursor, entry) < 0)
      .sort(compareNewestFirst)
      .slice(0, limit + 1)
  }
  const all = threads.flatMap((thread) => thread.messages).sort(compareNewestFirst)
  return { threads, read, asked, all }
}

/** Every page of the feed, following nextCursor as the screen does. */
async function everyPage(w: ReturnType<typeof world>, limit: number, batch: number): Promise<Entry[][]> {
  const pages: Entry[][] = []
  let cursor: TimelineCursor | null = null
  for (let guard = 0; guard < 100; guard++) {
    const page = await topK(w.threads, cursor, limit, batch, w.read(limit, cursor))
    pages.push(page.items)
    if (!page.more) return pages
    const last = page.items.at(-1)!
    cursor = decodeCursor(encodeCursor(last))
  }
  throw new Error('the pages never ended')
}

describe('B-SA-060 which conversations the feed reads', () => {
  it('customer-side record types only: never a work order, hold or NCR (NOT_SHAREABLE), a supplier record, or a change request (its order’s conversation)', () => {
    for (const type of NOT_SHAREABLE) expect(customerFeedKindOf(type), type).toBeNull()
    for (const type of NEVER_IN_CUSTOMER_FEED) expect(Object.hasOwn(CUSTOMER_FEED_TYPES, type), type).toBe(false)
    expect(NEVER_IN_CUSTOMER_FEED).toEqual(expect.arrayContaining(['WorkOrder', 'QualityHold', 'Nonconformance', 'OrderChangeRequest', 'PurchaseOrder', 'SubcontractOrder']))
    // The types the plan names (R4 / 15-steps B-SA-060) are all in it, each with a kind of the Kind ▾ filter.
    for (const type of ['Party', 'Inquiry', 'Quote', 'SalesOrder', 'Shipment', 'Ddt', 'Invoice', 'ReturnAuthorisation', 'RepairOrder', 'Complaint', 'SampleRound', 'ServiceCase', 'Project', 'MeasurementProfile']) {
      expect(CUSTOMER_FEED_KINDS).toContain(customerFeedKindOf(type))
    }
    // Every type it reads is a record type that has a conversation (platform/threads/records.ts), so its own read decides who opens it.
    for (const type of Object.keys(CUSTOMER_FEED_TYPES)) expect(Object.hasOwn(THREAD_RECORDS, type), type).toBe(true)
  })

  it('Kind ▾ narrows the types; nothing asked = every type', () => {
    expect(customerFeedTypesOf([])).toEqual(Object.keys(CUSTOMER_FEED_TYPES))
    expect(customerFeedTypesOf(undefined)).toEqual(Object.keys(CUSTOMER_FEED_TYPES))
    expect(customerFeedTypesOf(['QUOTES'])).toEqual(['Quote'])
    expect(customerFeedTypesOf(['GENERAL', 'AFTER_SALES'])).toEqual(['Party', 'MeasurementProfile', 'ReturnAuthorisation', 'RepairOrder', 'Complaint', 'ServiceCase'])
  })

  it('the route: office only, threads.read checked per record; the query takes pages of 30 at most, a view and kinds', () => {
    expect(manifest['GET /sales/customers/:partyId/feed']).toEqual({ audiences: ['office'], permission: 'threads.read', scope: 'record' })
    const query = customerFeedContract.querystring
    const plain = query.parse({})
    expect([plain.limit, plain.audience, plain.kinds ?? []]).toEqual([CUSTOMER_FEED_PAGE, 'ALL', []])
    expect(query.parse({ kinds: 'ORDERS, QUOTES,ORDERS', audience: 'OFFICE', limit: '10' })).toMatchObject({ limit: 10, audience: 'OFFICE', kinds: ['ORDERS', 'QUOTES'] })
    expect(query.safeParse({ limit: '31' }).success).toBe(false)
    expect(query.safeParse({ kinds: 'WORK' }).success).toBe(false)
    // No `include=work` (review BW-4): an unknown term is refused, never read.
    expect(query.safeParse({ include: 'work' }).success).toBe(false)
  })

  it('the feed writes nothing and reads no work order', () => {
    const source = readFileSync(new URL('./feed.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\bcommand\(/)
    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/)
    expect(source).not.toMatch(/client\.workOrder\b/)
    expect(source).not.toContain('moveMark')
  })
})

describe('B-SA-060 the top-k merge', () => {
  it('a thread’s key is its newest message, no later than the cursor; the order is newest possible first', () => {
    const a = { id: uuid(1), lastMessageAt: new Date(t0 + 60_000) }
    const b = { id: uuid(2), lastMessageAt: new Date(t0 + 120_000) }
    expect(mergeKey(a, null)).toBe(t0 + 60_000)
    expect(mergeKey(b, { at: new Date(t0 + 90_000), id: uuid(9) })).toBe(t0 + 90_000)
    expect(mergeOrder([a, b], null).map((thread) => thread.id)).toEqual([uuid(2), uuid(1)])
    // Same key: the larger id first, as the feed's own order.
    expect(mergeOrder([a, b], { at: new Date(t0 + 30_000), id: uuid(9) }).map((thread) => thread.id)).toEqual([uuid(2), uuid(1)])
  })

  it('merges three threads newest first, exactly as one sorted list', async () => {
    const w = world({ order: [50, 40, 10, 5], quote: [45, 20, 2], general: [30, 25, 1] })
    const page = await topK(w.threads, null, 30, 50, w.read(30, null))
    expect(page.items.map((entry) => entry.id)).toEqual(w.all.map((entry) => entry.id))
    expect(page.more).toBe(false)
    expect(page.reads).toBe(1)
  })

  it('pages follow without gaps or repeats, whatever the page and batch sizes', async () => {
    const spec: Record<string, number[]> = {}
    for (let thread = 0; thread < 23; thread++) spec[`t${thread}`] = Array.from({ length: (thread % 7) + 1 }, (_, n) => (thread * 37 + n * 11) % 400)
    const w = world(spec)
    for (const [limit, batch] of [
      [30, 50],
      [30, 4],
      [7, 3],
      [1, 1],
    ] as const) {
      const pages = await everyPage(w, limit, batch)
      const seen = pages.flat().map((entry) => entry.id)
      expect(new Set(seen).size, `${limit}/${batch}`).toBe(seen.length)
      expect(seen, `${limit}/${batch}`).toEqual(w.all.map((entry) => entry.id))
      for (const page of pages.slice(0, -1)) expect(page.length).toBe(limit)
    }
  })

  it('messages of the same instant in two threads: none lost at a page edge (the id decides, the tie is read)', async () => {
    const w = world({ a: [10, 10, 10], b: [10, 10], c: [10] })
    const pages = await everyPage(w, 2, 1)
    expect(pages.flat().map((entry) => entry.id)).toEqual(w.all.map((entry) => entry.id))
  })

  it('stops reading threads once none can still beat the page: many quiet threads cost no extra query', async () => {
    const spec: Record<string, number[]> = { busy: Array.from({ length: 40 }, (_, n) => 1000 + n) }
    for (let thread = 0; thread < 120; thread++) spec[`quiet${thread}`] = [thread]
    const w = world(spec)
    const page = await topK(w.threads, null, 30, 50, w.read(30, null))
    expect(page.items).toHaveLength(30)
    expect(page.more).toBe(true)
    expect(page.items.every((entry) => entry.threadId === w.threads[0]!.id)).toBe(true)
    // The busy thread is first in merge order: its batch fills the page, the next batch's newest is older than the 31st entry.
    expect(page.reads).toBe(1)
    expect(w.asked).toHaveLength(1)
  })

  it('an empty customer: no read at all, no page after it', async () => {
    const page = await topK([], null, 30, 50, async () => [])
    expect(page).toEqual({ items: [], more: false, reads: 0 })
  })
})

describe('B-SA-060 new to the reader', () => {
  const mark = { at: new Date(t0 + 60_000), id: uuid(50) }
  it('after the reader’s own mark, never their own message; no mark: every message of others', () => {
    expect(isNewToReader({ at: new Date(t0 + 120_000), id: uuid(60), authorId: null }, uuid(7), mark)).toBe(true)
    expect(isNewToReader({ at: new Date(t0 + 30_000), id: uuid(40), authorId: null }, uuid(7), mark)).toBe(false)
    expect(isNewToReader({ at: mark.at, id: mark.id, authorId: uuid(8) }, uuid(7), mark)).toBe(false)
    expect(isNewToReader({ at: mark.at, id: uuid(51), authorId: uuid(8) }, uuid(7), mark)).toBe(true)
    expect(isNewToReader({ at: new Date(t0 + 120_000), id: uuid(60), authorId: uuid(7) }, uuid(7), mark)).toBe(false)
    expect(isNewToReader({ at: new Date(t0), id: uuid(1), authorId: uuid(8) }, uuid(7), null)).toBe(true)
  })
})
