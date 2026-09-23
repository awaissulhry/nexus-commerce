import { afterAll, beforeAll, expect, it, vi } from 'vitest'

/**
 * PLAN A-39 (R-41) — the nightly Amazon content read, on an in-process PostgreSQL (PGlite) with the REAL due predicate,
 * the REAL sweep, the REAL compare and the REAL writer. Only "ours" and Amazon's read are injected (their real seams
 * have their own wiring arm in `content-drift.wiring.vitest.test.ts`). What is STORED is the claim.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { MIN_READ_GAP_MS, runContentDrift, describeContentDrift, type AmazonRead, type ContentDriftDeps } from './content-drift.job.js'
import type { OursResult } from '../services/channel-drift/amazon-content-ours.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const DE = 'A1PA6795UKMFR9'
const T0 = new Date('2026-10-01T03:37:00Z')
const DAY = 86_400_000
let account = ''
const rotation: string[] = []

const entry = (value: string, tag = 'de_DE') => ({ value, marketplace_id: DE, language_tag: tag })
async function listing(sku: string) {
  return scoped(async () => {
    const productId = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10 } })).id
    return (await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: 'DE', channelMarket: 'AMAZON_DE', region: 'EU',
      channelConnectionId: account, externalListingId: `B0${sku.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)}`, listingStatus: 'ACTIVE' } })).id
  })
}
const oursFor = (content: Record<string, unknown>, attributes: Record<string, unknown> = {}): OursResult =>
  ({ ok: true, ours: { listingId: '', sku: 'S', market: 'DE', marketplaceId: DE, accountId: account, tags: ['de_DE'], content: content as never, attributes, notCompared: [] } })
const drift = (id: string) => scoped(() => prisma.channelDrift.findFirst({ where: { channelListingId: id } }))
const clock = (row: any) => row?.checkedBySource?.['amazon-content']

/** Stubs keyed by listing id; any other listing "cannot be built" (not compared) — harmless to the arm at hand. */
function deps(map: Record<string, { ours: OursResult; theirs: AmazonRead }>, extra: Partial<ContentDriftDeps> = {}): ContentDriftDeps & { reads: string[] } {
  const reads: string[] = []
  let current = ''
  return {
    reads,
    ours: async id => { current = id; return map[id]?.ours ?? { ok: false, reason: 'not in this arm' } },
    read: async () => { reads.push(current); return map[current].theirs },
    sleep: async () => undefined,
    ...extra,
  }
}

beforeAll(async () => {
  await scoped(async () => {
    account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'drift', isActive: true, externalAccountId: 'SELLER',
      authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  })
  for (const sku of ['rot-a', 'rot-b', 'rot-c']) rotation.push(await listing(sku))
  rotation.sort()
}, 60_000)
afterAll(async () => { await state.db?.close() })

it('🔴 rotation: 3 listings, a budget of ONE a night — each once, never-checked first, then the OLDEST; night 4 comes back round', async () => {
  const same = { ours: oursFor({ item_name: [entry('Jacke')] }), theirs: { success: true, asin: 'B0X', attributes: { item_name: [entry('Jacke')] } } }
  const map = Object.fromEntries(rotation.map(id => [id, same]))
  const nights: string[] = []
  for (let n = 0; n < 4; n++) {
    let t = 0
    const d = deps(map, { read: async () => { t += 10 * 60_000; return same.theirs } })
    const oursSeen: string[] = []
    const ours = d.ours!
    d.ours = async id => { oursSeen.push(id); return ours(id) }
    const report = await scoped(() => runContentDrift({ at: new Date(T0.getTime() + n * DAY), budgetMs: 10 * 60_000, now: () => t, deps: d }))
    expect(report.stoppedBecause).toBe('budget')
    nights.push(oursSeen[0])
  }
  expect(nights).toEqual([rotation[0], rotation[1], rotation[2], rotation[0]])
})

it('🔴 identical content → the row is kept at 0 and the source\'s clock says compared', async () => {
  const id = await listing('same-1')
  await scoped(() => runContentDrift({ at: new Date(T0.getTime() + 10 * DAY), deps: deps({ [id]: { ours: oursFor({ item_name: [entry('Jacke  Gale')] }), theirs: { success: true, asin: 'B0Y', attributes: { item_name: [entry('Jacke Gale')] } } } }) }))
  const row = await drift(id)
  expect(row).toMatchObject({ driftCount: 0, driftedFields: [] })
  expect(clock(row)).toMatchObject({ outcome: 'compared', differing: 0 })
})

it('🔴 a seeded title difference → ONE entry, ours and theirs', async () => {
  const id = await listing('diff-1')
  await scoped(() => runContentDrift({ at: new Date(T0.getTime() + 11 * DAY), deps: deps({ [id]: { ours: oursFor({ item_name: [entry('Motorradjacke Gale')] }), theirs: { success: true, asin: 'B0Z', attributes: { item_name: [entry('Giacca moto Gale')] } } } }) }))
  const row = await drift(id)
  expect(row?.driftCount).toBe(1)
  expect(row?.driftedFields).toEqual([expect.objectContaining({ field: 'item_name[de_DE]', ours: 'Motorradjacke Gale', theirs: 'Giacca moto Gale', source: 'amazon-content' })])
})

it('🔴 our DE text missing → NOT compared (R-LX-6): no entry, the clock says why', async () => {
  const id = await listing('nolang-1')
  await scoped(() => runContentDrift({ at: new Date(T0.getTime() + 12 * DAY), deps: deps({ [id]: { ours: oursFor({ item_name: [entry('Giacca', 'it_IT')] }), theirs: { success: true, asin: 'B0W', attributes: { item_name: [entry('Anders')] } } } }) }))
  const row = await drift(id)
  expect(row?.driftCount).toBe(0)
  expect(clock(row)).toMatchObject({ outcome: 'not_compared' })
  expect(clock(row).reason).toMatch(/R-LX-6/)
})

it('🔴 a 404 (asin null) → NOT compared with the reason — never clean', async () => {
  const id = await listing('gone-1')
  await scoped(() => runContentDrift({ at: new Date(T0.getTime() + 13 * DAY), deps: deps({ [id]: { ours: oursFor({ item_name: [entry('Jacke')] }), theirs: { success: true, asin: null, attributes: null } } }) }))
  expect(clock(await drift(id))).toMatchObject({ outcome: 'not_compared', reason: expect.stringMatching(/404/) })
})

it('🔴 the pace: successive Amazon reads start at least 1 s apart', async () => {
  const ids = [await listing('pace-1'), await listing('pace-2'), await listing('pace-3')]
  let now = 5_000
  const starts: number[] = []
  const same = (id: string) => [id, { ours: oursFor({ item_name: [entry('Jacke')] }), theirs: { success: true, asin: 'B0P', attributes: { item_name: [entry('Jacke')] } } }] as const
  const d = deps(Object.fromEntries(ids.map(same)), {
    clock: () => now,
    sleep: async ms => { now += ms },
    read: async () => { starts.push(now); now += 200; return { success: true, asin: 'B0P', attributes: { item_name: [entry('Jacke')] } } },
  })
  await scoped(() => runContentDrift({ at: new Date(T0.getTime() + 14 * DAY), deps: d }))
  expect(starts.length).toBeGreaterThanOrEqual(3)
  for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(MIN_READ_GAP_MS)
})

it('the dry run COUNTS what is due and reads nothing, writes nothing', async () => {
  const id = await listing('dry-1')
  const d = deps({ [id]: { ours: oursFor({}), theirs: { success: true, asin: 'B0D', attributes: {} } } })
  const inScope = await scoped(() => prisma.channelListing.count({ where: { channel: 'AMAZON', externalListingId: { not: null }, channelConnectionId: { not: null }, listingStatus: { in: ['ACTIVE', 'INACTIVE'] } } }))
  const report = await scoped(() => runContentDrift({ dryRun: true, at: new Date(T0.getTime() + 100 * DAY), deps: d }))
  expect(report.planned).toBe(inScope)
  expect(d.reads).toEqual([])
  expect(await drift(id)).toBeNull()
})

it('15.7 #2 — the CronRun line carries compared, drifted, not compared and the reasons', async () => {
  const line = describeContentDrift({ name: 'content-drift', planned: 3, processed: 3, produced: 3, failed: 0, remaining: 0, stoppedBecause: 'complete', ms: 1, failures: [], applied: true,
    tally: { compared: 2, drifted: 1, notCompared: 1, reasons: { 'Amazon answered 404': 1 } } })
  expect(line).toMatch(/compared 2 · drifted 1 · not compared 1 \(Amazon answered 404 ×1\)/)
})
