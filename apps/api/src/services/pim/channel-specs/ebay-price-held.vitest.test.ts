/**
 * 🔴 PLAN Step 1.5 — the eBay price is held on BOTH halves: the column states it, the writer refuses.
 *
 * WHY IT IS HELD. A price typed in the sheet does NOT reach `writeChannelPrices`. It goes
 * bulk-edit.service.ts → channelValueMutation → a raw column write on `ChannelListing.price`.
 * Measured 2026-09-22: `bulk-edit.service.ts` contains ZERO occurrences of `writeChannelPrices`,
 * `PRICE_UPDATE` or `PriceChangeEvent`. So the edit skips the enqueue — it may never reach eBay at
 * all — plus the audit row, the PriceChangeEvent and the sale window, and it guards on
 * `Product.version` while the Matrix guards `ChannelListing.version`.
 *
 * WHY THIS FILE EXISTS. The plan names `scripts/check-silent-disabled.mjs` as this step's gate.
 * That script parses JSX elements carrying both `disabled` and `title` (its own header says so) —
 * a web-control ratchet that cannot see an API field spec or a wire field. Without this the step
 * would ship with no gate at all.
 *
 * 🔴 THE ARM THAT MATTERS MOST is the last one. The first attempt at this step used
 * `readOnlyReason`, which held the column correctly and SILENTLY DELETED the field's master
 * mapping, because `master-default-rule.ts:8` returns null for anything carrying it. The suite
 * caught it as `expected null to match object { source: 'basePrice' }`. That regression is pinned
 * here so the next person cannot reintroduce it by "tidying" the two reason fields into one.
 */
import { expect, it } from 'vitest'
import { EBAY_PRICE_HELD_REASON, ebaySpecFromCache } from './ebay.js'
import { buildSheetColumns } from '../sheet-columns.service.js'
import { CHANNEL_FIELD_MAP } from '../channel-field-map.js'
import { masterDefaultRule } from '../mapping/master-default-rule.js'
import { sourceOwner } from '../mapping/source-definition-plan.js'
import type { ChannelFieldSpec } from './types.js'

const spec = () => ebaySpecFromCache({ marketplace: 'IT', categoryId: '57988', aspects: [], conditions: [] } as never)
const field = (key: string): ChannelFieldSpec | undefined => spec().fields.find(f => f.key === key)

const coordinate = { channel: 'EBAY' as const, marketplace: 'IT', label: 'eBay · IT', inMarket: true }
const column = (key: string) =>
  buildSheetColumns({ fields: [], specs: [{ coordinate, spec: spec() }], coordinates: [coordinate], scopeKind: 'channel' })
    .columns.find(c => c.channels?.[coordinate.label]?.key === key)

// ── Half 1: the column states the hold ────────────────────────────
it('the price COLUMN is not editable and carries the reason where it can be read', () => {
  const price = column('price')
  expect(price).toBeDefined()
  expect(price!.editable).toBe(false)
  expect(price!.formulaWritable).toBe(false)
  expect(price!.helpText).toBe(EBAY_PRICE_HELD_REASON)
})

it('positive control — the quantity COLUMN beside it is still editable', () => {
  expect(column('quantity')!.editable).toBe(true)
})

// ── The write side is NOT held here — see the plan, amendment A-12 ──
//
// A generic wire-field block on `ebay_price` was built and REVERTED: `ebay_price` is this repo's
// canonical "mapped channel field" fixture, and refusing it broke 19 arms across 3 files covering
// #689 equality, #700 listing-CAS, #703 alias routing, account resolution, recalc scoping and
// inheritance pinning — several of which are genuinely ABOUT price. Step 2.2 refuses it properly,
// at the price door, and deletes the hold below in the same change.

it('🔴 the ROUTING is untouched — only the write is held', () => {
  // Dropping `ebay_price` from CHANNEL_FIELD_MAP would break the value reader, the formula writer
  // and information-validation; dropping `price` from studio-sheet's CHANNEL_WRITABLE would route
  // an eBay price edit to the MASTER basePrice. Neither was done.
  expect(CHANNEL_FIELD_MAP.ebay_price).toBe('price')
})

// ── The regression that cost the first attempt ────────────────────
it('🔴 the master→channel price mapping SURVIVES the hold', () => {
  const masterKeys = new Set(['basePrice', 'name', 'description'])
  const price = field('price')!
  expect(price.readOnlyReason).toBeUndefined()          // the ownership fact is NOT set
  expect(price.editHeldReason).toBe(EBAY_PRICE_HELD_REASON)
  // `readOnlyReason` here would make this null — that is the exact failure the suite caught.
  expect(masterDefaultRule({ ...price, masterKey: 'basePrice' }, masterKeys)).toMatchObject({ source: 'basePrice' })
})

it('🔴 the price is still OURS — the hold does not relabel its source owner', () => {
  const price = field('price')!
  // `readOnlyReason` would make source-definition-plan.ts:66 answer "Channel-reported data".
  expect(sourceOwner({ ...price, masterKey: 'basePrice' })?.label).not.toBe('Channel-reported data')
})

it('🔴 the channel fact stays true: eBay CAN change a live price', () => {
  // `editable` is mapped to the column's `editableOnExisting` — "the CHANNEL cannot change this on
  // an EXISTING listing". Setting it false to express OUR hold would record a false channel fact.
  expect(field('price')!.editable).toBe(true)
})
