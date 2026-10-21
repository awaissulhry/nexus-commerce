/**
 * Meta ads step 30, review F5 — the batch ledger on a real PostgreSQL (PGlite, the production schema and every
 * business policy, business profiles ON): 1000 changes of one delivery recorded, claimed and finished in a few round
 * trips well inside Meta's answer time; a redelivery adds to `deliveries` and keeps the first verdict; an identity that
 * differs is refused; a batch claim takes only what claimInbound would; done, handed back and failed rows end as the
 * single-row claim would leave them; one business never sees or claims another's rows. Made-up ids.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) }))
vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { recordInbound, recordInboundBatch } = await import('./ledger.js')
const { claimInboundMany, finishInboundClaimMany } = await import('./claims.js')

const A = 'ledger_batch_alpha'
const B = 'ledger_batch_bravo'
const inWs = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const rec = (i: number, over: Record<string, unknown> = {}) => ({
  channel: 'META', eventType: 'ad_account.effective_status', externalId: `meta:batch-${i}`, payload: { appId: '1234567890123', entryId: '1234567890', field: 'effective_status', i },
  signatureOk: true, verifiedBy: 'meta_hmac' as const, connectionId: 'conn-a', status: 'pending' as const, ...over,
})

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('the batch ledger', () => {
  it('1000 changes recorded, claimed and finished in a few round trips; due at once; well inside Meta\'s answer time', async () => {
    const started = Date.now()
    const written = await inWs(A, () => recordInboundBatch(Array.from({ length: 1000 }, (_, i) => rec(i))))
    expect(written.every((w) => w.id && !w.duplicate)).toBe(true)
    const { claims } = await inWs(A, () => claimInboundMany(written.map((w) => w.id as string)))
    expect(claims).toHaveLength(1000)
    // Review N2 — failures grouped per (reason, attempt): two reasons here, each row keeps its own.
    await inWs(A, () => finishInboundClaimMany(claims, { done: claims.slice(0, 990).map((c) => c.id), release: claims.slice(990, 995).map((c) => c.id), failed: claims.slice(995).map((c, i) => ({ id: c.id, error: i < 3 ? 'queue down' : 'notice failed' })) }))
    expect(Date.now() - started).toBeLessThan(4_000)
    const rows = await inWs(A, () => database.client.webhookEvent.findMany({ where: { externalId: { startsWith: 'meta:batch-' } }, select: { status: true, attempts: true, processingToken: true, nextAttemptAt: true, verifiedBy: true } }))
    const count = (status: string, attempts: number) => rows.filter((r) => r.status === status && r.attempts === attempts && r.processingToken === null).length
    expect(count('done', 1)).toBe(990)
    // Handed back unspent: pending, attempt given back, due now.
    expect(count('pending', 0)).toBe(5)
    // Failed: one attempt spent, retried after its backoff.
    expect(count('failed', 1)).toBe(5)
    expect(rows.every((r) => r.verifiedBy === 'meta_hmac')).toBe(true)
    const failedRows = await inWs(A, () => database.client.webhookEvent.findMany({ where: { externalId: { startsWith: 'meta:batch-' }, status: 'failed' }, select: { lastError: true, nextAttemptAt: true } }))
    expect(failedRows.map((r) => r.lastError).sort()).toEqual(['notice failed', 'notice failed', 'queue down', 'queue down', 'queue down'])
    expect(failedRows.every((r) => r.nextAttemptAt && r.nextAttemptAt.getTime() > Date.now())).toBe(true)
  }, 60_000)

  it('a rejected Meta delivery keeps its X-Hub-Signature-256 header in verificationHeaders (and no other header)', async () => {
    await inWs(A, () => recordInbound({
      channel: 'META', eventType: 'unverified', externalId: 'meta-unverified:1234567890123:2026-10-21T09', payload: { appId: '1234567890123', firstDigest: 'ab' },
      headers: { 'x-hub-signature-256': 'sha256=00ff', authorization: 'Bearer not-kept', cookie: 'not-kept' }, rawBody: null, connectionId: 'conn-a',
      signatureOk: false, verifiedBy: 'none', status: 'failed', lastError: 'mismatch',
    }))
    const row = await inWs(A, () => database.client.webhookEvent.findFirstOrThrow({ where: { externalId: 'meta-unverified:1234567890123:2026-10-21T09' }, select: { verificationHeaders: true, rawBody: true, signatureOk: true } }))
    expect(row).toEqual({ verificationHeaders: { 'x-hub-signature-256': 'sha256=00ff' }, rawBody: null, signatureOk: false })
  })

  it('a redelivery adds to deliveries and reports the stored status; an identity that differs is refused; inside one batch too', async () => {
    const again = await inWs(A, () => recordInboundBatch([rec(0), rec(0), rec(1, { connectionId: 'conn-other' }), rec(2000)]))
    expect(again[0]).toMatchObject({ duplicate: true, existingStatus: 'done' })
    expect(again[1]).toMatchObject({ duplicate: true, existingStatus: 'done' })
    expect(again[2]).toEqual({ id: null, duplicate: true, conflict: 'identity_mismatch' })
    expect(again[3]).toMatchObject({ duplicate: false })
    const row = await inWs(A, () => database.client.webhookEvent.findFirstOrThrow({ where: { externalId: 'meta:batch-0' }, select: { deliveries: true, status: true } }))
    expect(row).toEqual({ deliveries: 3, status: 'done' })
  })

  it('refuses what the batch writer does not take: no delivery id, unverified, eBay', async () => {
    for (const bad of [rec(3000, { externalId: null }), rec(3001, { signatureOk: false }), rec(3002, { channel: 'EBAY' })]) {
      expect(await inWs(A, () => recordInboundBatch([bad as never]))).toEqual([{ id: null, duplicate: false }])
    }
  })

  it('one business never sees or claims another\'s rows; a claimed or finished row is not claimed again', async () => {
    const [mine] = await inWs(B, () => recordInboundBatch([rec(0)]))
    expect(mine).toMatchObject({ duplicate: false })
    const aRow = await inWs(A, () => database.client.webhookEvent.findFirstOrThrow({ where: { externalId: 'meta:batch-2000' }, select: { id: true } }))
    expect((await inWs(B, () => claimInboundMany([aRow.id, mine.id as string]))).claims.map((c) => c.id)).toEqual([mine.id])
    expect((await inWs(B, () => claimInboundMany([mine.id as string]))).claims).toEqual([])
    const done = await inWs(A, () => database.client.webhookEvent.findFirstOrThrow({ where: { externalId: 'meta:batch-0' }, select: { id: true } }))
    expect((await inWs(A, () => claimInboundMany([done.id]))).claims).toEqual([])
  })
})
