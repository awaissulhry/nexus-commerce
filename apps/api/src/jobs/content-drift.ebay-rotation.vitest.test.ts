import { beforeAll, expect, it, vi } from 'vitest'

/**
 * PLAN A-39 slice b2 (R-43) — the eBay pass's rotation and its nightly read cap, on PGlite with the REAL due predicate and
 * the REAL writer's per-source clock. A night allowed ONE read must take the never-checked owners first, then the oldest,
 * so three owners are each read once in three nights — never the same one every night (A-30's defect, in a new place).
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { EBAY_MAX_READS_PER_NIGHT, runEbayContentDrift, type EbayContentDriftDeps } from './content-drift.job.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const T0 = new Date('2026-10-01T03:37:00Z')
const DAY = 86_400_000
let account = ''
const owners: string[] = []
const itemOf = new Map<string, string>()

const XML = '<Item><Title>Same</Title><ItemSpecifics><NameValueList><Name>Marca</Name><Value>Xavia</Value></NameValueList></ItemSpecifics><SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus></Item>'
function deps(reads: string[]): EbayContentDriftDeps {
  return {
    ours: async id => ({ ok: true, ours: { listingId: id, itemId: itemOf.get(id)!, accountId: account, market: 'IT', title: 'Same', itemSpecifics: { Marca: 'Xavia' } } }),
    read: async ({ itemId }) => { reads.push(itemId); return { success: true, xml: XML } },
    sleep: async () => undefined,
  }
}
const night = async (n: number, maxReads: number) => {
  const reads: string[] = []
  const report = await scoped(() => runEbayContentDrift({ at: new Date(T0.getTime() + n * DAY), maxReads, deps: deps(reads) }))
  return { reads, report }
}

beforeAll(async () => {
  await scoped(async () => {
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'rotation', isActive: true, externalAccountId: 'EBAYROT',
      authStatus: 'connected', managedBy: 'oauth', region: 'IT' } as never })).id
    for (const [i, sku] of ['rot-a', 'rot-b', 'rot-c'].entries()) {
      const productId = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10 } })).id
      const id = (await prisma.channelListing.create({ data: { productId, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT',
        channelConnectionId: account, externalListingId: `20${i}`, listingStatus: 'ACTIVE' } })).id
      owners.push(id)
      itemOf.set(id, `20${i}`)
    }
  })
  owners.sort()
}, 60_000)

it('one read a night: each owner is read once over three nights (never-checked first), then the OLDEST comes round again', async () => {
  const order = owners.map(id => itemOf.get(id)!)
  const n1 = await night(0, 1)
  const n2 = await night(1, 1)
  const n3 = await night(2, 1)
  const n4 = await night(3, 1)
  expect([n1.reads, n2.reads, n3.reads]).toEqual([[order[0]], [order[1]], [order[2]]])
  // Night 4: all three were checked; the oldest (night 1's) goes first.
  expect(n4.reads).toEqual([order[0]])
  expect(n1.report.tally.capped).toBe(true)
})

it('the nightly read cap: with every owner due, a cap of 2 reads 2 and leaves the third DUE (its clock does not move)', async () => {
  const at = 20
  const before = await scoped(() => prisma.channelDrift.findMany({ where: { channelListingId: { in: owners } }, select: { channelListingId: true, checkedBySource: true } }))
  const { reads, report } = await night(at, 2)
  expect(reads).toHaveLength(2)
  expect(report.tally).toMatchObject({ reads: 2, capped: true })
  const after = await scoped(() => prisma.channelDrift.findMany({ where: { channelListingId: { in: owners } }, select: { channelListingId: true, checkedBySource: true } }))
  const moved = after.filter(r => (r.checkedBySource as any)['ebay-content'].at === new Date(T0.getTime() + at * DAY).toISOString())
  expect(moved).toHaveLength(2)
  const untouched = after.find(r => !moved.includes(r))!
  expect((untouched.checkedBySource as any)['ebay-content']).toEqual((before.find(b => b.channelListingId === untouched.channelListingId)!.checkedBySource as any)['ebay-content'])
  // Control: the production cap reads all three.
  const control = await night(at + 1, EBAY_MAX_READS_PER_NIGHT)
  expect(control.reads).toHaveLength(3)
  expect(control.report.tally.capped).toBe(false)
})
