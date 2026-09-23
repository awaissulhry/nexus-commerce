/**
 * Step 1.5's temporary hold is lifted by Step 2.2. Keep the column, routing and
 * master-mapping controls: readOnlyReason means channel ownership, never a local hold.
 * Persistence and enqueue behavior are gated on PostgreSQL in price-door-reset.vitest.test.ts.
 */
import { expect, it } from 'vitest'
import { ebaySpecFromCache } from './ebay.js'
import { buildSheetColumns } from '../sheet-columns.service.js'
import { CHANNEL_FIELD_MAP } from '../channel-field-map.js'
import { masterDefaultRule } from '../mapping/master-default-rule.js'
import { sourceOwner } from '../mapping/source-definition-plan.js'
import type { ChannelFieldSpec } from './types.js'
import { AMAZON_LISTING_STORES, AMAZON_MASTER_LINKS } from './amazon.js'

const spec = () => ebaySpecFromCache({ marketplace: 'IT', categoryId: '57988', aspects: [], conditions: [] } as never)
const field = (key: string): ChannelFieldSpec | undefined => spec().fields.find(f => f.key === key)

const coordinate = { channel: 'EBAY' as const, marketplace: 'IT', label: 'eBay · IT', inMarket: true }
const column = (key: string) =>
  buildSheetColumns({ fields: [], specs: [{ coordinate, spec: spec() }], coordinates: [coordinate], scopeKind: 'channel' })
    .columns.find(c => c.channels?.[coordinate.label]?.key === key)

// The sheet offers the price door.
it('Step 2.2 lifts the price hold: the column is editable through the price door', () => {
  const price = column('price')
  expect(price).toBeDefined()
  expect(price!.editable).toBe(true)
  expect(price!.formulaWritable).not.toBe(false) // unset means the ordinary editability rule applies
  expect(field('price')!.editHeldReason).toBeUndefined()
})

it('positive control — the quantity COLUMN beside it is still editable', () => {
  expect(column('quantity')!.editable).toBe(true)
})

it('🔴 the routing still addresses the listing price', () => {
  // Dropping `ebay_price` from CHANNEL_FIELD_MAP would break the value reader, the formula writer
  // and information-validation; dropping `price` from studio-sheet's CHANNEL_WRITABLE would route
  // an eBay price edit to the MASTER basePrice. Neither was done.
  expect(CHANNEL_FIELD_MAP.ebay_price).toBe('price')
})

// ── The regression that cost the first attempt ────────────────────
it('🔴 the master→channel price mapping survives the handoff', () => {
  const masterKeys = new Set(['basePrice', 'name', 'description'])
  const price = field('price')!
  expect(price.readOnlyReason).toBeUndefined()          // the ownership fact is NOT set
  expect(price.editHeldReason).toBeUndefined()
  // `readOnlyReason` here would make this null — that is the exact failure the suite caught.
  expect(masterDefaultRule({ ...price, masterKey: 'basePrice' }, masterKeys)).toMatchObject({ source: 'basePrice' })
})

it('🔴 the price is still OURS — the handoff does not relabel its source owner', () => {
  const price = field('price')!
  // `readOnlyReason` would make source-definition-plan.ts:66 answer "Channel-reported data".
  expect(sourceOwner({ ...price, masterKey: 'basePrice' })?.label).not.toBe('Channel-reported data')
})

it('🔴 the channel fact stays true: eBay CAN change a live price', () => {
  // `editable` is mapped to the column's `editableOnExisting` — "the CHANNEL cannot change this on
  // an EXISTING listing". Setting it false to express OUR hold would record a false channel fact.
  expect(field('price')!.editable).toBe(true)
})

// Review §3a / Step 2.2 Cost when: Amazon's price PATCH replaces the whole purchasable_offer and
// drops a sale price (amazon-sp-api.client.ts patchListingPrice). The sheet may join that door
// only after the sale price survives. Adding an Amazon price column must fail here, not ship.
it('🔴 the sheet has no Amazon price column that could reach the sale-price-wiping PATCH', () => {
  const amazonStores = [...Object.values(AMAZON_LISTING_STORES),
    ...Object.values(AMAZON_MASTER_LINKS).map(link => link.channelStore)]
  expect(amazonStores.filter(store => store?.kind === 'listingColumn' && store.column === 'price')).toEqual([])
  expect(Object.entries(CHANNEL_FIELD_MAP).filter(([key, column]) => key.startsWith('amazon_') && column === 'price')).toEqual([])
  // Positive control: the eBay price column is found by the same test.
  expect(Object.entries(CHANNEL_FIELD_MAP).filter(([key, column]) => key.startsWith('ebay_') && column === 'price')).toHaveLength(1)
})
