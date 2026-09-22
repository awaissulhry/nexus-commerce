/**
 * P2.1 — the inbound ledger's lifecycle: failure → backoff → dead letters → replay.
 *
 * Every assertion here names a state that did not exist before this package. CX.4a
 * added the columns and wrote none of them: `nextAttemptAt` was null on all 5,256
 * rows in the table, `status = 'dlq'` had never been written once, and `attempts`
 * counted redeliveries rather than attempts. So these tests are not re-stating
 * behaviour — each one is the first thing that would notice the behaviour going away.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, any>

const rows = new Map<string, Row>()
const updates: Array<{ id: string; data: Row }> = []
let rawRows: Row[] = []
let lastRawArgs: unknown[] = []

const prismaMock = {
  webhookEvent: {
    findUnique: vi.fn(async (args: any) => {
      if (args?.where?.id) {
        const row = rows.get(args.where.id)
        if (!row) return null
        return args.select ? Object.fromEntries(Object.keys(args.select).map(key => [key, row[key]])) : row
      }
      const key = args?.where?.channel_externalId
      if (!key) return null
      for (const row of rows.values()) {
        if (row.channel === key.channel && row.externalId === key.externalId) return row
      }
      return null
    }),
    create: vi.fn(async (args: any) => {
      const id = `row-${rows.size + 1}`
      rows.set(id, { id, ...args.data })
      return { id }
    }),
    findMany: vi.fn(async (args: any) => {
      lastRawArgs = [args]
      return rawRows
    }),
    update: vi.fn(async (args: any) => {
      const row = rows.get(args.where.id)
      updates.push({ id: args.where.id, data: args.data })
      if (row) {
        for (const [field, value] of Object.entries(args.data as Row)) {
          row[field] = value && typeof value === 'object' && 'increment' in (value as Row)
            ? (row[field] ?? 0) + (value as Row).increment
            : value
        }
      }
      return row ?? args.data
    }),
  },
  $queryRawUnsafe: vi.fn(async (..._args: unknown[]) => {
    lastRawArgs = _args
    return rawRows
  }),
}

vi.mock('../../../db.js', () => ({ default: prismaMock }))
vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@nexus/database/workspace-context', () => ({ workspaceKey: (key: object) => key }))

const {
  recordInbound, completeInbound, deadLetterInbound, replayInbound,
  dueInboundEvents, inboundBackoffMs, MAX_INBOUND_ATTEMPTS,
} = await import('./ledger.js')

function seed(id: string, row: Row) {
  rows.set(id, { id, channel: 'SHOPIFY', eventType: 'product/update', externalId: id, status: 'failed', attempts: 0, deliveries: 1, archivedAt: null, nextAttemptAt: null, workspaceId: 'ws-1', signatureOk: true, verifiedBy: 'shopify_hmac', ...row })
}

beforeEach(() => {
  rows.clear()
  updates.length = 0
  rawRows = []
  lastRawArgs = []
  vi.clearAllMocks()
})

describe('a redelivery is not a handling attempt', () => {
  it('counts a duplicate arrival as a delivery, leaving the retry budget alone', async () => {
    seed('e1', { channel: 'SHOPIFY', externalId: 'delivery-1', status: 'pending', attempts: 3 })
    const result = await recordInbound({
      channel: 'SHOPIFY', eventType: 'product/update', externalId: 'delivery-1',
      payload: {}, signatureOk: true, verifiedBy: 'shopify_hmac',
    })
    expect(result.duplicate).toBe(true)
    expect(updates[0].data).toEqual({ deliveries: { increment: 1 } })
    // The budget is untouched: an eager channel cannot exhaust the retries of an
    // event nobody has tried to handle even once.
    expect(rows.get('e1')!.attempts).toBe(3)
  })

  it('reports the status the row ALREADY had, so a receiver can tell a retry from a duplicate', async () => {
    seed('e1', { externalId: 'delivery-1', status: 'failed' })
    const result = await recordInbound({
      channel: 'SHOPIFY', eventType: 'product/update', externalId: 'delivery-1',
      payload: {}, signatureOk: true, verifiedBy: 'shopify_hmac',
    })
    // Without this, a channel resending BECAUSE we failed gets a 200 and is dropped.
    expect(result.existingStatus).toBe('failed')
  })
})

describe('a failure schedules', () => {
  it('sets a time to try again and spends one attempt', async () => {
    seed('e1', { attempts: 0, status: 'pending' })
    const before = Date.now()
    await completeInbound('e1', false, 'shopify said no')
    const row = rows.get('e1')!
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(1)
    expect(row.lastError).toBe('shopify said no')
    // The whole point of P2.1: this column used to be null on every row ever written.
    expect(row.nextAttemptAt).toBeInstanceOf(Date)
    expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + inboundBackoffMs(1))
  })

  it('backs off further each time, and never past the cap', () => {
    expect(inboundBackoffMs(1)).toBe(60_000)
    expect(inboundBackoffMs(2)).toBe(120_000)
    expect(inboundBackoffMs(3)).toBe(240_000)
    // A dead event must not be scheduled past the point where anything useful
    // survives to diagnose it with.
    expect(inboundBackoffMs(99)).toBe(6 * 60 * 60 * 1000)
  })

  it('becomes a dead letter once the attempts run out, with no time left on it', async () => {
    seed('e1', { attempts: MAX_INBOUND_ATTEMPTS - 1 })
    await completeInbound('e1', false, 'still broken')
    const row = rows.get('e1')!
    expect(row.status).toBe('dlq')
    expect(row.attempts).toBe(MAX_INBOUND_ATTEMPTS)
    // No time: a dead letter waits for a person, not for a clock.
    expect(row.nextAttemptAt).toBeNull()
  })

  it('clears the time when it finally works', async () => {
    seed('e1', { attempts: 2, nextAttemptAt: new Date() })
    await completeInbound('e1', true)
    const row = rows.get('e1')!
    expect(row.status).toBe('done')
    expect(row.isProcessed).toBe(true)
    expect(row.nextAttemptAt).toBeNull()
    expect(row.lastError).toBeNull()
  })
})

describe('dead-lettering without spending attempts', () => {
  it('goes straight to dead letters for a failure retrying cannot fix', async () => {
    seed('e1', { attempts: 0 })
    await deadLetterInbound('e1', 'no replay handler for AMAZON/anything')
    const row = rows.get('e1')!
    expect(row.status).toBe('dlq')
    expect(row.nextAttemptAt).toBeNull()
    // Unchanged: five identical failures over eight hours tell an operator nothing
    // the first one did not.
    expect(row.attempts).toBe(0)
  })
})

describe('replay', () => {
  it.each(['EBAY', 'ETSY', 'SHOPIFY'])('cannot promote a rejected %s payload into trusted execution', async (channel) => {
    seed('forged', { channel, signatureOk: false, status: 'failed' })
    expect(await replayInbound({ id: 'forged' })).toMatchObject({ ok: false, reason: 'unverified' })
    expect(updates).toHaveLength(0)
  })

  it('refuses missing verification but allows the explicitly trusted SQS transport', async () => {
    seed('unknown', { signatureOk: null, verifiedBy: 'none' })
    expect(await replayInbound({ id: 'unknown' })).toMatchObject({ ok: false, reason: 'unverified' })
    seed('sqs', { channel: 'AMAZON', signatureOk: null, verifiedBy: 'sqs_iam' })
    expect((await replayInbound({ id: 'sqs' })).ok).toBe(true)
    seed('false-sqs', { channel: 'AMAZON', signatureOk: false, verifiedBy: 'sqs_iam' })
    expect((await replayInbound({ id: 'false-sqs' })).reason).toBe('unverified')
  })

  it.each(['EBAY', 'ETSY', 'SHOPIFY'])('does not treat %s as an unsigned SQS transport', async channel => {
    seed('wrong-transport', { channel, signatureOk: null, verifiedBy: 'sqs_iam' })
    expect((await replayInbound({ id: 'wrong-transport' })).reason).toBe('unverified')
    expect(updates).toHaveLength(0)
  })

  it('allows an Amazon Ads event whose trust came from SQS IAM', async () => {
    seed('ads', { channel: 'AMAZON_ADS', signatureOk: null, verifiedBy: 'sqs_iam' })
    expect((await replayInbound({ id: 'ads' })).ok).toBe(true)
  })

  it('gives a dead letter a full budget back and queues it', async () => {
    seed('e1', { status: 'dlq', attempts: MAX_INBOUND_ATTEMPTS, deliveries: 4, lastError: 'boom' })
    const outcome = await replayInbound({ id: 'e1' })
    expect(outcome.ok).toBe(true)
    const row = rows.get('e1')!
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(0)
    expect(row.nextAttemptAt).toBeInstanceOf(Date)
    expect(row.lastError).toBeNull()
    // How often the channel sent this event is history. No button rewrites it.
    expect(row.deliveries).toBe(4)
  })

  it('refuses an archived event instead of replaying an empty payload', async () => {
    seed('e1', { status: 'dlq', archivedAt: new Date(), archiveUri: 's3://somewhere' })
    const outcome = await replayInbound({ id: 'e1' })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('archived')
    expect(rows.get('e1')!.status).toBe('dlq')
  })

  it('refuses an event another business owns', async () => {
    seed('e1', { workspaceId: 'ws-1', status: 'dlq' })
    const outcome = await replayInbound({ id: 'e1', workspaceId: 'ws-2' })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('wrong_workspace')
  })

  it('refuses an event already queued, but NOT one merely stuck at pending', async () => {
    seed('queued', { status: 'pending', nextAttemptAt: new Date() })
    expect((await replayInbound({ id: 'queued' })).reason).toBe('already_pending')

    // The 91 rows sitting at `pending` with no time on them are exactly what the
    // button exists for: a receiver died between recording the arrival and handling
    // it. Refusing every `pending` row would have excluded the only case that needs it.
    seed('stuck', { status: 'pending', nextAttemptAt: null })
    expect((await replayInbound({ id: 'stuck' })).ok).toBe(true)
    expect(rows.get('stuck')!.nextAttemptAt).toBeInstanceOf(Date)
  })
})

describe('what the worker picks up', () => {
  it('selects on the TIME, so a replayed event is collected as readily as a failed one', async () => {
    const now = new Date()
    await dueInboundEvents(25, now)
    const args = lastRawArgs[0] as any
    // Both statuses, or a replayed event would sit forever waiting for a sweep that
    // only looked at failures.
    expect(args.where.status).toEqual({ in: ['failed', 'pending'] })
    expect(args.where.nextAttemptAt).toEqual({ not: null, lte: now })
    // An archived row has no payload to replay.
    expect(args.where.archivedAt).toBeNull()
    expect(args.orderBy).toEqual({ nextAttemptAt: 'asc' })
    expect(args.take).toBe(25)
    expect(args.select).toMatchObject({ signatureOk: true, verifiedBy: true })
  })

  it('goes through the SCOPED model API, never raw SQL', async () => {
    await dueInboundEvents(10, new Date())
    // A raw query is invisible to the scoping client: the first end-to-end run of the
    // sweep read zero rows while a due event sat in the table, because only the
    // database's own row policy filtered it. This is the assertion that noticed.
    expect(prismaMock.webhookEvent.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled()
  })
})
