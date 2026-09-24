import { beforeAll, expect, it, vi } from 'vitest'

/**
 * PLAN A-39 slice b2 (R-43) — the nightly eBay content read, on an in-process PostgreSQL (PGlite) with the REAL due
 * predicate, the REAL sweep, the REAL compare, the REAL writer, and the REAL `ebayContentOurs` for every listing an arm
 * does not stub (so the shell and the variant-listing rules are the shipped ones). eBay's read is injected. What is
 * STORED is the claim.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { MIN_READ_GAP_MS, runEbayContentDrift, describeEbayContentDrift, type EbayRead } from './content-drift.job.js'
import { ebayContentOurs, type EbayOursResult } from '../services/channel-drift/ebay-content-ours.js'
import { EBAY_SHELL_REASON } from '../services/channel-drift/ebay-content-compare.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const T0 = new Date('2026-10-01T03:37:00Z')
let account = ''
const L: Record<string, string> = {}

async function listing(key: string, itemId: string, product: { parentKey?: string; shell?: boolean } = {}) {
  return scoped(async () => {
    const parentId = product.parentKey ? (await prisma.channelListing.findUniqueOrThrow({ where: { id: L[product.parentKey] } })).productId : null
    const productId = (await prisma.product.create({ data: { sku: `EBD-${key}`, name: key, basePrice: 10, parentId,
      ...(product.shell ? { productType: 'EBAY_LISTING_SHELL' } : {}) } })).id
    L[key] = (await prisma.channelListing.create({ data: { productId, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT',
      channelConnectionId: account, externalListingId: itemId, listingStatus: 'ACTIVE' } })).id
  })
}
const item = (title: string, specifics: Record<string, string[]>, status = 'Active') =>
  `<GetItemResponse><Ack>Success</Ack><Item><ItemID>x</ItemID><Title>${title}</Title><ItemSpecifics>${Object.entries(specifics)
    .map(([n, vs]) => `<NameValueList><Name>${n}</Name>${vs.map(v => `<Value>${v}</Value>`).join('')}</NameValueList>`).join('')}</ItemSpecifics>` +
  `<SellingStatus><ListingStatus>${status}</ListingStatus></SellingStatus></Item></GetItemResponse>`
const ours = (key: string, itemId: string, title: string, itemSpecifics: Record<string, string | string[]>): EbayOursResult =>
  ({ ok: true, ours: { listingId: L[key], itemId, accountId: account, market: 'IT', title, itemSpecifics } })
const drift = (key: string) => scoped(() => prisma.channelDrift.findFirst({ where: { channelListingId: L[key] } }))
const clockOf = (row: any) => row?.checkedBySource?.['ebay-content']

beforeAll(async () => {
  await scoped(async () => {
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'drift', isActive: true, externalAccountId: 'EBAYSELLER',
      authStatus: 'connected', managedBy: 'oauth', region: 'IT' } as never })).id
  })
  await listing('same', '1001')                         // the ItemID owner — identical on eBay
  await listing('same-variant', '1001', { parentKey: 'same' }) // a variant's listing on the SAME ItemID — never the unit
  await listing('shell', '1002', { shell: true })       // a shell owner
  await listing('refused', '1003')                      // the builder refuses
  await listing('unreadable', '1004')                   // GetItem throws
  await listing('drifted', '1005')                      // the title differs on eBay
  await listing('ended', '1006')                        // the item is no longer active on eBay
}, 60_000)

it('one night: the owner is compared, a shell and a refusal are NOT compared (no eBay call), a failed read is NOT compared, a difference is an entry — paced ≥ 1 s', async () => {
  const stub: Record<string, EbayOursResult> = {
    [L.same]: ours('same', '1001', 'Giacca FAM', { Marca: 'Xavia', Caratteristiche: ['Ventilata', 'Impermeabile'] }),
    [L.refused]: { ok: false, reason: 'the eBay builder refused: This eBay item is also used by products outside this selection. Review its complete shared listing before publishing.' },
    [L.unreadable]: ours('unreadable', '1004', 'Giacca X', { Marca: 'Xavia' }),
    [L.drifted]: ours('drifted', '1005', 'Giacca Nuova', { Marca: 'Xavia' }),
    [L.ended]: ours('ended', '1006', 'Giacca Vecchia', { Marca: 'Xavia' }),
  }
  const answers: Record<string, () => Promise<EbayRead>> = {
    '1001': async () => ({ success: true, xml: item('Giacca  FAM', { marca: ['Xavia'], Caratteristiche: ['Impermeabile', 'Ventilata'] }) }),
    '1004': async () => { throw new Error('eBay GetItem transport failure: socket hang up') },
    '1005': async () => ({ success: true, xml: item('Giacca Vecchia', { Marca: ['Xavia'] }) }),
    '1006': async () => ({ success: true, xml: item('Giacca Vecchia', { Marca: ['Xavia'] }, 'Completed') }),
  }
  let now = 0
  const starts: Array<{ itemId: string; at: number }> = []
  const report = await scoped(() => runEbayContentDrift({ at: T0, deps: {
    // Unstubbed listings (the shell, the variant listing) go through the REAL ours.
    ours: async id => stub[id] ?? ebayContentOurs(id),
    read: async ({ itemId }) => { starts.push({ itemId, at: now }); now += 250; return answers[itemId]() },
    sleep: async ms => { now += ms },
    clock: () => now,
  } }))

  // The owner, identical after normalisation (spaces, value order, name case): compared, 0 drift, clock set.
  const same = await drift('same')
  expect(same?.driftCount).toBe(0)
  expect(clockOf(same)).toMatchObject({ outcome: 'compared', at: T0.toISOString() })
  // The variant's listing on the same ItemID is never the unit.
  expect(clockOf(await drift('same-variant'))).toBeUndefined()
  // The shell: the exact reason, no eBay call.
  expect(clockOf(await drift('shell'))).toMatchObject({ outcome: 'not_compared', reason: EBAY_SHELL_REASON })
  expect(starts.map(s => s.itemId)).not.toContain('1002')
  // The builder's refusal: its sentence, no eBay call.
  expect(clockOf(await drift('refused'))).toMatchObject({ outcome: 'not_compared', reason: expect.stringContaining('also used by products outside this selection') })
  expect(starts.map(s => s.itemId)).not.toContain('1003')
  // A failed read: not compared, with the reason; no entry; never clean.
  const unreadable = await drift('unreadable')
  expect(clockOf(unreadable)).toMatchObject({ outcome: 'not_compared', reason: expect.stringContaining('the eBay read failed: eBay GetItem transport failure') })
  expect(unreadable?.driftCount).toBe(0)
  expect(unreadable?.driftedFields).toEqual([])
  // An item that is no longer active on eBay: not compared.
  expect(clockOf(await drift('ended'))).toMatchObject({ outcome: 'not_compared', reason: 'the eBay item is not active (Completed)' })
  // The seeded difference: ONE entry, source ebay-content, both values.
  const drifted = await drift('drifted')
  expect(drifted?.driftCount).toBe(1)
  expect(drifted?.driftedFields).toEqual([expect.objectContaining({ field: 'title', ours: 'Giacca Nuova', theirs: 'Giacca Vecchia', source: 'ebay-content' })])

  // The pace: every eBay read starts ≥ 1 s after the previous one.
  expect(starts).toHaveLength(4)
  for (let i = 1; i < starts.length; i++) expect(starts[i].at - starts[i - 1].at).toBeGreaterThanOrEqual(MIN_READ_GAP_MS)
  // The CronRun line (15.7 #2) carries the eBay counts.
  expect(report.tally).toMatchObject({ compared: 2, drifted: 1, notCompared: 4, reads: 4, capped: false })
  expect(describeEbayContentDrift(report)).toMatch(/^ebay-content: compared 2 · drifted 1 · not compared 4 \(.*\) · 4 GetItem · /)
})

it('a dry run counts the due owners and reads nothing', async () => {
  const reads: string[] = []
  const report = await scoped(() => runEbayContentDrift({ at: new Date(T0.getTime() + 2 * 86_400_000), dryRun: true,
    deps: { ours: async () => { throw new Error('a dry run builds nothing') }, read: async ({ itemId }) => { reads.push(itemId); return { success: false, xml: null } } } }))
  // Six parentless owners (same, shell, refused, unreadable, drifted, ended) — never the variant's listing.
  expect(report).toMatchObject({ planned: 6, stoppedBecause: 'dry-run', applied: false })
  expect(reads).toEqual([])
})
