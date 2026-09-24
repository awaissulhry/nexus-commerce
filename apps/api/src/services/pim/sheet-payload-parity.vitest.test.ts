import { afterAll, beforeAll, expect, it, vi } from 'vitest'

/**
 * PLAN Step 3.2's GATE (15.7 #1) — M2 as a recurring check on a fixture: the sheet and the payload say the same thing.
 *
 * M2 measured it once, on the local catalogue (`docs/product-cheat/tools/payload-capture.mts`): 0 value disagreements on
 * the attributes the resolver owns. This keeps it true on every push. One product, one Amazon·IT listing, a cached
 * category schema, values stored where the sheet stores them (the listing's `overrideData`) — then BOTH readers:
 *   · the SHEET: `getStudioSheet`, channel scope — what the operator sees;
 *   · the PAYLOAD: `readPublicationFacts` → `prepareAmazonPublication` — the studio publish's own feed message, built
 *     and never sent. (Not `applyResolvedMappingToAmazonFeed` alone: it serialises only mapped fields, and a listing
 *     setting is serialised one level up, by the studio builder — a gate on half the builder measured nothing.)
 * Every sheet value is serialised with the payload's own serialiser and compared per attribute. A reader that drifts —
 * the sheet ranking another store first, the payload serialising a root differently — goes red.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
// The feed builder's schema hints read the category schema through `getSchema`; the cached row below is fresh, so no
// provider call is made — any fetch is a failure of the fixture, not a network read.
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a gate: ${String(url)}`) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { getStudioSheet } from './studio-sheet.service.js'
import { resolveBatch } from './mapping/resolve-batch.service.js'
import { loadAmazonSpec } from './channel-specs/index.js'
import { attributesFromCells } from './mapping/schema-requirements.js'
import { readPublicationFacts } from './studio-publication-plan.js'
import { prepareAmazonPublication } from './studio-publication-amazon.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const MP = 'APJ6JRA9NG5V4'
const one = (extra: Record<string, unknown>) => ({ type: 'array', maxItems: 1, selectors: ['marketplace_id'],
  items: { type: 'object', properties: { value: { type: 'string', ...extra }, marketplace_id: { const: MP } } } })
// Three resolver-owned attributes (text, closed list, text) — the kinds M2 compared.
const STORED = { part_number: 'XP-100', color: 'Nero', material: 'Mesh' }
let productId = '', account = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: MP } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'parity', isActive: true, externalAccountId: 'SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
    schemaDefinition: { properties: { part_number: one({ maxLength: 40 }), color: one({ maxLength: 50 }), material: one({ enum: ['Mesh', 'Leather'] }) } } } })
  productId = (await prisma.product.create({ data: { sku: 'parity-a', name: 'Parity', basePrice: 10, productType: 'COAT', fulfillmentMethod: 'FBM' } as never })).id
  // A LIVE listing (an ASIN): the studio then builds a partial update, which needs no gallery.
  await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account,
    externalListingId: 'B0PARITY01', overrideData: STORED } })
}), 60_000)
afterAll(async () => { await state.db?.close() })

/** Scalar leaves of an attribute, without the envelope's selectors. */
const leaves = (v: unknown): string[] => v == null ? [] : Array.isArray(v) ? v.flatMap(leaves)
  : typeof v === 'object' ? Object.entries(v as object).filter(([k]) => k !== 'marketplace_id' && k !== 'language_tag').flatMap(([, x]) => leaves(x)) : [String(v)]

async function bothSides() {
  return scoped(async () => {
    const spec = await loadAmazonSpec('IT', 'COAT', account)
    const sheet = await getStudioSheet({ productId, scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it', accountId: account, includeMapping: true } as never)
    const row = (sheet.rows as any[]).find(r => r.id === productId)
    const resolved = await resolveBatch({ channel: 'AMAZON', marketplace: 'IT', channelConnectionId: account, aliasKey: '', productIds: [productId], includeCatalogue: true })
    const sheetValues: Record<string, unknown> = {}
    for (const f of resolved.catalogue?.fields ?? []) {
      const key = [f.sheetKey, `attr_${f.sheetKey ?? f.fieldKey}`, f.fieldKey].find((k: string | undefined) => k && row?.values?.[k] !== undefined)
      const value = key ? row.values[key]?.value : undefined
      if (value != null && value !== '' && !(Array.isArray(value) && !value.length) && f.fieldKey !== 'productType') sheetValues[f.fieldKey] = value
    }
    const facts = await readPublicationFacts(productId, { channel: 'AMAZON', marketplace: 'IT', accountId: account })
    const message = (await prepareAmazonPublication(facts)).feed.messages[0]
    const payload = (message.attributes ?? Object.fromEntries((message.patches ?? []).filter((p: any) => p.op === 'replace').map((p: any) => [p.path.replace('/attributes/', ''), p.value]))) as Record<string, unknown>
    return { expected: attributesFromCells(spec, sheetValues) as Record<string, unknown>, payload, sheetValues }
  })
}

it('🔴 the sheet and the payload agree on every resolver-owned attribute (M2 = 0)', async () => {
  const { expected, payload, sheetValues } = await bothSides()
  // Positive control: the sheet SHOWS the three stored values — a sheet that showed nothing would "agree" vacuously.
  expect(Object.values(sheetValues).map(String).sort()).toEqual(Object.values(STORED).sort())
  const sheetRoots = Object.keys(expected).sort()
  const differ = sheetRoots.filter(r => JSON.stringify(leaves(expected[r]).sort()) !== JSON.stringify(leaves(payload[r]).sort()))
  expect({ sheetRoots, differ }).toEqual({ sheetRoots: ['color', 'material', 'part_number'], differ: [] })
  // What the payload sends beyond the sheet's values comes only from its own builders (offer, stock, content, parentage).
  const OWN_BUILDERS = new Set(['purchasable_offer', 'fulfillment_availability', 'item_name', 'product_description', 'bullet_point', 'generic_keyword', 'condition_type', 'parentage_level', 'list_price'])
  expect(Object.keys(payload).filter(r => !(r in expected) && !OWN_BUILDERS.has(r))).toEqual([])
})

it('control: the comparison SEES a difference — a value the payload does not carry is caught', async () => {
  const { expected, payload } = await bothSides()
  const tampered = { ...payload, color: [{ value: 'Rosso', marketplace_id: MP }] }
  const differ = Object.keys(expected).filter(r => JSON.stringify(leaves(expected[r]).sort()) !== JSON.stringify(leaves(tampered[r]).sort()))
  expect(differ).toEqual(['color'])
})
