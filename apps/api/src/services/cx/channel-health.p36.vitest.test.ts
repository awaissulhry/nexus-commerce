/**
 * P3.6 — *each channel shows error rate, slow calls, backlog age and dead letters
 * against a target*, and one trace id follows a change from the click to the channel's
 * answer.
 *
 * On a real PostgreSQL with the generated schema and the real profile policies,
 * profiles ON.
 *
 * The tests that matter most are about not showing a false green:
 *  - `no_data` is its own verdict and never rolls up as `meeting`;
 *  - a target is a number that can be MISSED;
 *  - zero dead letters is a MEASUREMENT (the ledger answered none), while zero calls
 *    is an ABSENCE (there was nothing to ask) — and they must not look alike.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, { get: (_t, p) => (database.client as unknown as Record<string, unknown>)[p as string] }),
}))

const WS = 'nexus_legacy_workspace'
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inWs = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: [] }, work)

const NOW = new Date('2026-09-20T12:00:00.000Z')
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000)

describe('P3.6 — the four numbers, against a target', () => {
  let svc: typeof import('./channel-health.service.js')
  const q = (sql: string, params: unknown[] = []) => database.db.query(sql, params)

  const call = (o: { id: string; channel: string; op: string; ok: boolean; ms: number; at: Date; trace?: string }) =>
    q(`INSERT INTO "OutboundApiCallLog" ("workspaceId", id, channel, operation, method, endpoint, success, "statusCode", "latencyMs", "traceId", "createdAt")
       VALUES ($1,$2,$3,$4,'POST','https://e.test/x',$5,$6,$7,$8,$9)`,
      [WS, o.id, o.channel, o.op, o.ok, o.ok ? 200 : 500, o.ms, o.trace ?? null, o.at])

  const webhook = (id: string, channel: string, status: string, at: Date) =>
    q(`INSERT INTO "WebhookEvent" ("workspaceId", id, channel, "externalId", "eventType", payload, "isProcessed", status, "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$2,'t','{}'::jsonb,false,$4,$5,$5)`, [WS, id, channel, status, at])

  const queued = (id: string, channel: string, at: Date) =>
    // `syncType` is plain TEXT here, not an enum — taken from information_schema
    // rather than guessed from the Prisma field's look.
    q(`INSERT INTO "OutboundSyncQueue" ("workspaceId", id, "productId", "targetChannel", "syncType", "syncStatus", payload, "createdAt", "updatedAt")
       VALUES ($1,$2,'P-1',$3::"SyncChannel",'QUANTITY_UPDATE','PENDING'::"OutboundSyncStatus",'{}'::jsonb,$4,$4)`,
      [WS, id, channel, at])

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    svc = await import('./channel-health.service.js')
    await q(`INSERT INTO "Product" ("workspaceId", id, sku, name, "basePrice", "updatedAt")
             VALUES ($1,'P-1','SKU-1','One',10,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [WS])
  }, 120_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  })

  beforeEach(async () => {
    await q(`DELETE FROM "OutboundApiCallLog"`)
    await q(`DELETE FROM "WebhookEvent"`)
    await q(`DELETE FROM "OutboundSyncQueue"`)
    for (const k of ['NEXUS_SLO_ERROR_RATE_PCT', 'NEXUS_SLO_SLOW_CALL_MS', 'NEXUS_SLO_SLOW_CALL_PCT', 'NEXUS_SLO_BACKLOG_AGE_HOURS', 'NEXUS_SLO_DEAD_LETTERS']) delete process.env[k]
  })

  const health = async (channel: string) => {
    const all = await inWs(() => svc.channelHealth({ since: ago(24), until: NOW }))
    return all.find((c) => c.channel === channel)!
  }

  describe('error rate against its target', () => {
    it('meets the target when almost everything works', async () => {
      for (let i = 0; i < 100; i++) await call({ id: `ok-${i}`, channel: 'SHOPIFY', op: 'graphql.node', ok: i > 0, ms: 100, at: ago(2) })
      const h = await health('SHOPIFY')
      expect(h.errorRate.value).toBe(1)
      expect(h.errorRate.target).toBe(2)
      expect(h.errorRate.verdict).toBe('meeting')
      expect(h.errorRate.sampleSize).toBe(100)
    })

    it('MISSES the target when it should — a target that cannot be missed is decoration', async () => {
      for (let i = 0; i < 10; i++) await call({ id: `bad-${i}`, channel: 'EBAY', op: 'trading.Add', ok: i > 2, ms: 100, at: ago(2) })
      const h = await health('EBAY')
      expect(h.errorRate.value).toBe(30)
      expect(h.errorRate.verdict).toBe('missing')
      expect(h.errorRate.note).toContain('over the 2% target')
    })

    it('reads its target from the env override', async () => {
      process.env.NEXUS_SLO_ERROR_RATE_PCT = '50'
      for (let i = 0; i < 10; i++) await call({ id: `e-${i}`, channel: 'EBAY', op: 'x', ok: i > 2, ms: 100, at: ago(2) })
      expect((await health('EBAY')).errorRate.verdict).toBe('meeting')
    })
  })

  describe('slow calls', () => {
    it('counts calls over the threshold, not the average', async () => {
      // An average hides a tail: 99 fast calls and one 30-second call averages fine.
      for (let i = 0; i < 99; i++) await call({ id: `f-${i}`, channel: 'SHOPIFY', op: 'graphql.node', ok: true, ms: 50, at: ago(2) })
      await call({ id: 'slow-1', channel: 'SHOPIFY', op: 'graphql.node', ok: true, ms: 30_000, at: ago(2) })
      const h = await health('SHOPIFY')
      expect(h.slowCalls.value).toBe(1)
      expect(h.slowCalls.verdict).toBe('meeting')
    })

    it('misses when too many are slow', async () => {
      for (let i = 0; i < 10; i++) await call({ id: `s-${i}`, channel: 'SHOPIFY', op: 'graphql.node', ok: true, ms: i < 3 ? 9000 : 50, at: ago(2) })
      const h = await health('SHOPIFY')
      expect(h.slowCalls.value).toBe(30)
      expect(h.slowCalls.verdict).toBe('missing')
    })
  })

  describe('backlog age — the OLDEST waiting change, not a count', () => {
    it('reports how long the oldest has waited', async () => {
      await queued('q-new', 'SHOPIFY', ago(0.2))
      await queued('q-old', 'SHOPIFY', ago(9))
      const h = await health('SHOPIFY')
      expect(h.backlogAge.value).toBe(9)
      expect(h.backlogAge.verdict).toBe('missing')
      expect(h.backlogAge.note).toContain('waiting 9 h')
    })

    it('🔴 one change stuck for days beats ninety queued a minute ago', async () => {
      // A COUNT cannot tell these apart, which is why the metric is an age.
      for (let i = 0; i < 90; i++) await queued(`fresh-${i}`, 'EBAY', ago(0.01))
      const fresh = await health('EBAY')
      expect(fresh.backlogAge.verdict).toBe('meeting')

      await queued('stuck', 'EBAY', ago(227))
      const stuck = await health('EBAY')
      expect(stuck.backlogAge.value).toBe(227)
      expect(stuck.backlogAge.verdict).toBe('missing')
    })

    it('says nothing is waiting when nothing is', async () => {
      const h = await health('ETSY')
      expect(h.backlogAge.verdict).toBe('no_data')
      expect(h.backlogAge.note).toContain('Nothing is waiting')
    })
  })

  describe('dead letters', () => {
    it('misses on a single one — a dead letter always needs a person', async () => {
      await webhook('d-1', 'AMAZON', 'dlq', ago(2))
      const h = await health('AMAZON')
      expect(h.deadLetters.value).toBe(1)
      expect(h.deadLetters.target).toBe(0)
      expect(h.deadLetters.verdict).toBe('missing')
    })

    it('🔴 ZERO dead letters is a MEASUREMENT, not an absence', async () => {
      // The ledger was asked and answered none. That is a pass, and it must not look
      // like "no calls", which is a question that could not be asked.
      await webhook('done-1', 'AMAZON', 'done', ago(2))
      const h = await health('AMAZON')
      expect(h.deadLetters.value).toBe(0)
      expect(h.deadLetters.verdict).toBe('meeting')
      expect(h.deadLetters.sampleSize).toBe(1)
    })
  })

  describe('🔴 no_data is never a pass', () => {
    it('a channel with nothing at all is no_data, not meeting', async () => {
      const h = await health('ETSY')
      expect(h.calls).toBe(0)
      expect(h.errorRate.value).toBeNull()
      expect(h.errorRate.verdict).toBe('no_data')
      expect(h.slowCalls.verdict).toBe('no_data')
      expect(h.backlogAge.verdict).toBe('no_data')
    })

    it('every metric carries a sentence even with no data', async () => {
      const h = await health('ETSY')
      for (const m of [h.errorRate, h.slowCalls, h.backlogAge, h.deadLetters]) {
        expect(m.note.length).toBeGreaterThan(10)
      }
    })

    it('rollUp: missing beats everything', () => {
      expect(svc.rollUp(['meeting', 'missing', 'no_data'])).toBe('missing')
    })

    it('rollUp: no_data alone stays no_data — it never becomes meeting', () => {
      expect(svc.rollUp(['no_data', 'no_data'])).toBe('no_data')
    })

    it('rollUp: one real pass beside no_data is meeting', () => {
      expect(svc.rollUp(['no_data', 'meeting'])).toBe('meeting')
    })

    it('a channel whose ONLY signal is a dead letter still reports missing', async () => {
      await webhook('only', 'ETSY', 'dlq', ago(1))
      const h = await health('ETSY')
      expect(h.calls).toBe(0)
      expect(h.verdict).toBe('missing')
    })
  })

  describe('per operation', () => {
    it('puts the worst error rate first, not the busiest', async () => {
      for (let i = 0; i < 500; i++) await call({ id: `busy-${i}`, channel: 'AMAZON', op: 'ads PUT /sp/keywords', ok: true, ms: 50, at: ago(2) })
      for (let i = 0; i < 3; i++) await call({ id: `broken-${i}`, channel: 'AMAZON', op: 'getListingsItem', ok: false, ms: 50, at: ago(2) })
      const h = await health('AMAZON')
      expect(h.operations[0].operation).toBe('getListingsItem')
      expect(h.operations[0].errorRate.value).toBe(100)
      expect(h.operations[0].calls).toBe(3)
    })

    it('leaves out calls outside the window', async () => {
      await call({ id: 'ancient', channel: 'SHOPIFY', op: 'x', ok: false, ms: 50, at: ago(72) })
      const h = await health('SHOPIFY')
      expect(h.calls).toBe(0)
      expect(h.errorRate.verdict).toBe('no_data')
    })
  })

  describe('the trace that follows ONE change', () => {
    it('returns every call the change made, in order', async () => {
      await call({ id: 't-2', channel: 'EBAY', op: 'trading.Add', ok: true, ms: 80, at: ago(1), trace: 'trace-A' })
      await call({ id: 't-1', channel: 'EBAY', op: 'trading.Verify', ok: true, ms: 60, at: ago(2), trace: 'trace-A' })
      await call({ id: 'other', channel: 'EBAY', op: 'trading.Add', ok: true, ms: 60, at: ago(1), trace: 'trace-B' })
      const calls = await inWs(() => svc.callsForTrace('trace-A'))
      expect(calls.map((c) => c.id)).toEqual(['t-1', 't-2'])
    })

    it('never returns another change’s calls', async () => {
      await call({ id: 'mine', channel: 'EBAY', op: 'x', ok: true, ms: 60, at: ago(1), trace: 'trace-A' })
      await call({ id: 'theirs', channel: 'EBAY', op: 'x', ok: true, ms: 60, at: ago(1), trace: 'trace-B' })
      const calls = await inWs(() => svc.callsForTrace('trace-A'))
      expect(calls.map((c) => c.id)).toEqual(['mine'])
    })

    it('answers empty for a trace with nothing, rather than everything', async () => {
      await call({ id: 'untraced', channel: 'EBAY', op: 'x', ok: true, ms: 60, at: ago(1) })
      expect(await inWs(() => svc.callsForTrace('trace-none'))).toEqual([])
    })
  })
})

describe('P3.6 — a trace id is a CHANGE id, a request id is a RUN id', () => {
  it('getTraceId falls back to the request id on an HTTP request', async () => {
    const { runWithRequestId, getTraceId } = await import('../../utils/request-context.js')
    // A change made directly in a request, with no queue row between, IS that request.
    expect(runWithRequestId('req-1', 'http', () => getTraceId())).toBe('req-1')
  })

  it('🔴 getTraceId does NOT fall back on a cron tick', async () => {
    const { runWithRequestId, getTraceId } = await import('../../utils/request-context.js')
    // One tick id covers up to 1,243 calls. Returning it as a trace would make every
    // one of those calls look like the same change — worse than admitting there is none.
    expect(runWithRequestId('cron-1', 'cron', () => getTraceId())).toBeUndefined()
  })

  it('runWithTraceId binds the change and keeps the surrounding run id', async () => {
    const { runWithRequestId, runWithTraceId, getTraceId, getRequestId } = await import('../../utils/request-context.js')
    const seen = runWithRequestId('cron-tick', 'cron', () =>
      runWithTraceId('trace-from-the-row', () => ({ trace: getTraceId(), run: getRequestId() })))
    expect(seen).toEqual({ trace: 'trace-from-the-row', run: 'cron-tick' })
  })

  it('a row with no trace leaves the context alone', async () => {
    const { runWithRequestId, runWithTraceId, getTraceId } = await import('../../utils/request-context.js')
    expect(runWithRequestId('cron-tick', 'cron', () => runWithTraceId(null, () => getTraceId()))).toBeUndefined()
  })
})
