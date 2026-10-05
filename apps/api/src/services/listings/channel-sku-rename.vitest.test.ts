/**
 * S9 — the pure rules of the writes step: what a SHARED SKU rename does to each listing (`planListingRename`) and the
 * sentence that says it (`skuRenameSummary`); the per-channel live-move rule (`liveChannelSkuMoveRefusal`, S10); the
 * Shopify SKU column's read view (`withWantedShopifySku`); the shared-stock refusal as one plain sentence. No database.
 */
import { describe, expect, it } from 'vitest'
import { planListingRename, productSkuRuleRefusal, skuRenameRefusal, skuRenameSummary, type SkuRenameListingFacts } from './channel-sku-rename.js'
import { channelSkuMoveRefusal, ebayInventoryMoveRefusal, liveChannelSkuMoveRefusal } from './channel-sku-live-move.js'
import { amazonMainRowMove, EBAY_INVENTORY_SKU_MOVE, etsySkuMoveSentence } from '@nexus/shared/publish-actions'
import { withWantedShopifySku } from './shopify-sku-cell.js'

const held = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'EXT-1' }
const draft = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null }
let n = 0
const row = (channel: string, marketplace: string, data: Partial<SkuRenameListingFacts> = {}): SkuRenameListingFacts =>
  ({ id: `l${++n}`, channel, marketplace, aliasKey: '', version: 3, productId: 'p1', ...held, ...data })

describe('S9 — a product SKU rename, per listing', () => {
  it('a listing the channel holds keeps OLD: its own SKU and the SKU the channel holds are recorded', () => {
    expect(planListingRename(row('AMAZON', 'DE'), 'OLD', 'NEW')).toMatchObject({ outcome: 'keeps', sku: 'OLD', write: { channelSku: 'OLD', liveChannelSku: 'OLD' }, version: 3 })
    // eBay's old store (an extra listing's SKU) was never sent: what eBay holds is the product SKU.
    expect(planListingRename(row('EBAY', 'IT', { aliasKey: 'a1', alias: { sku: 'EB-ALIAS', productId: 'p1' } }), 'OLD', 'NEW'))
      .toMatchObject({ outcome: 'keeps', sku: 'EB-ALIAS', write: { channelSku: 'EB-ALIAS', liveChannelSku: 'OLD' } })
  })

  it('a held listing with its own SKU or a confirmed SKU keeps them; nothing already recorded is written again', () => {
    expect(planListingRename(row('AMAZON', 'IT', { channelSku: 'OWN-IT', liveChannelSku: 'OWN-IT' }), 'OLD', 'NEW')).toMatchObject({ outcome: 'keeps', sku: 'OWN-IT', write: {} })
    expect(planListingRename(row('AMAZON', 'FR', { liveChannelSku: 'OLD' }), 'OLD', 'NEW')).toMatchObject({ outcome: 'keeps', sku: 'OLD', write: { channelSku: 'OLD' } })
    // An Amazon offer (an old store) names what Amazon holds: kept as it is, now in the column.
    expect(planListingRename(row('AMAZON', 'ES', { offers: [{ sku: 'OFFER-ES', isActive: true }] }), 'OLD', 'NEW'))
      .toMatchObject({ outcome: 'keeps', sku: 'OFFER-ES', write: { channelSku: 'OFFER-ES', liveChannelSku: 'OFFER-ES' } })
  })

  it('a still-draft follows NEW: one that follows writes nothing, one an old store or its own SKU pins to OLD is set to NEW', () => {
    expect(planListingRename(row('AMAZON', 'FR', draft), 'OLD', 'NEW')).toMatchObject({ outcome: 'follows', sku: 'NEW', write: {} })
    // Deleted back to a draft: the flat-file copy and the offer still say OLD (the Delete defect) — NEW is what Publish lists.
    expect(planListingRename(row('AMAZON', 'DE', { ...draft, flatFileSnapshot: { item_sku: 'OLD' }, offers: [{ sku: 'OLD', isActive: true }] }), 'OLD', 'NEW'))
      .toMatchObject({ outcome: 'follows', sku: 'NEW', write: { channelSku: 'NEW' } })
    // A draft whose own SKU equals the product SKU follows a second rename too.
    expect(planListingRename(row('AMAZON', 'DE', { ...draft, channelSku: 'OLD' }), 'OLD', 'NEW')).toMatchObject({ outcome: 'follows', write: { channelSku: 'NEW' } })
  })

  it('a still-draft with a SKU of its own, or with no single SKU, is left alone', () => {
    expect(planListingRename(row('EBAY', 'IT', { ...draft, channelSku: 'MINE' }), 'OLD', 'NEW')).toMatchObject({ outcome: 'own', sku: 'MINE', write: {} })
    expect(planListingRename(row('AMAZON', 'IT', { ...draft, flatFileSnapshot: { item_sku: 'A' }, platformAttributes: { sellerSku: 'B' } }), 'OLD', 'NEW'))
      .toMatchObject({ outcome: 'unclear', sku: null, write: {} })
  })

  it('F2 — its own SKU is NEW and following would send exactly NEW: it follows again (own SKU cleared, the held SKU kept)', () => {
    // After OLD → NEW, a held listing keeps OLD as its own SKU; the undo NEW → OLD puts it back to following.
    expect(planListingRename(row('AMAZON', 'DE', { channelSku: 'OLD', liveChannelSku: 'OLD' }), 'NEW', 'OLD'))
      .toMatchObject({ outcome: 'rejoins', sku: 'OLD', write: { channelSku: null } })
    // Nothing recorded of what the channel holds yet: it is recorded (what it holds today), the own SKU still cleared.
    expect(planListingRename(row('EBAY', 'IT', { channelSku: 'NEW' }), 'OLD', 'NEW')).toMatchObject({ outcome: 'rejoins', sku: 'NEW', write: { channelSku: null, liveChannelSku: 'OLD' } })
    // A still-draft too.
    expect(planListingRename(row('AMAZON', 'FR', { ...draft, channelSku: 'NEW' }), 'OLD', 'NEW')).toMatchObject({ outcome: 'rejoins', sku: 'NEW', write: { channelSku: null } })
    // Its old store would send something else: it keeps its own SKU.
    expect(planListingRename(row('AMAZON', 'ES', { channelSku: 'NEW', liveChannelSku: 'X', offers: [{ sku: 'OFFER-ES', isActive: true }] }), 'OLD', 'NEW'))
      .toMatchObject({ outcome: 'keeps', sku: 'NEW', write: {} })
    expect(planListingRename(row('EBAY', 'IT', { ...draft, channelSku: 'NEW', aliasKey: 'a1', alias: { sku: 'EB-ALIAS', productId: 'p1' } }), 'OLD', 'NEW'))
      .toMatchObject({ outcome: 'own', sku: 'NEW', write: {} })
    const listings = [row('AMAZON', 'DE', { channelSku: 'OLD', liveChannelSku: 'OLD' }), row('EBAY', 'IT', { channelSku: 'OLD', liveChannelSku: 'OLD' })]
      .map(r => planListingRename(r, 'NEW', 'OLD'))
    expect(skuRenameSummary({ from: 'NEW', to: 'OLD', listings, parentGaps: [] })).toBe('Amazon · DE and eBay · IT follow the Shared SKU OLD again.')
    expect(skuRenameSummary({ from: 'NEW', to: 'OLD', listings: listings.slice(0, 1), parentGaps: [] })).toBe('Amazon · DE follows the Shared SKU OLD again.')
  })

  it('the sentence: which listings keep OLD (Amazon EU markets each named), drafts follow NEW, own SKUs named', () => {
    const listings = [row('AMAZON', 'DE'), row('AMAZON', 'IT'), row('EBAY', 'IT'), row('AMAZON', 'FR', draft), row('SHOPIFY', 'GLOBAL', { ...draft, channelSku: 'SH-OWN' })]
      .map(r => planListingRename(r, 'OLD', 'NEW'))
    expect(skuRenameSummary({ from: 'OLD', to: 'NEW', listings, parentGaps: [] }))
      .toBe('Amazon · DE, Amazon · IT and eBay · IT keep OLD; the draft follows NEW. Shopify keeps its own SKU SH-OWN.')
    const drafts = [row('AMAZON', 'FR', draft), row('EBAY', 'IT', draft)].map(r => planListingRename(r, 'OLD', 'NEW'))
    expect(skuRenameSummary({ from: 'OLD', to: 'NEW', listings: drafts, parentGaps: [] })).toBe('No channel holds OLD: drafts follow NEW.')
    expect(skuRenameSummary({ from: 'OLD', to: 'NEW', listings: [planListingRename(row('AMAZON', 'DE'), 'OLD', 'NEW')], parentGaps: [] })).toBe('Amazon · DE keeps OLD.')
    expect(skuRenameSummary({ from: 'OLD', to: 'NEW', listings: [], parentGaps: [] })).toBe('')
  })
})

describe('S10 — a held listing\'s SKU change, per channel: allowed where Publish moves it', () => {
  const amazon = { channel: 'AMAZON', marketplace: 'DE', ...held }
  it('Amazon: a variation or a single product moves (Publish creates NEW, deletes OLD); a family\'s main row cannot', () => {
    expect(liveChannelSkuMoveRefusal(amazon, 'P-1', 'P-1-NEW')).toBeNull()
    expect(liveChannelSkuMoveRefusal(amazon, 'P-1', 'P-1-NEW', { mainRow: true })).toBe(amazonMainRowMove('P-1', 'P-1-NEW'))
    expect(amazonMainRowMove('P-1', 'P-1-NEW')).toContain('Nexus cannot move a family\'s main listing on Amazon to a new SKU yet (P-1 → P-1-NEW)')
  })

  it('eBay: a Trading item is renamed in place; an Inventory item is refused with the review\'s sentence', () => {
    const ebay = { channel: 'EBAY', marketplace: 'IT', aliasKey: 'x', ...held, liveChannelSku: 'KEPT' }
    expect(liveChannelSkuMoveRefusal(ebay, 'P-2', 'P-2-NEW')).toBeNull()
    expect(liveChannelSkuMoveRefusal(ebay, 'P-2', 'P-2-NEW', { ebayInventory: true }))
      .toBe('eBay holds KEPT, Nexus holds P-2-NEW. Nexus cannot move an eBay Inventory listing to a new SKU yet: Delete it, then list it again.')
    expect(ebayInventoryMoveRefusal('KEPT', 'P-2-NEW')).toBe(`eBay holds KEPT, Nexus holds P-2-NEW. ${EBAY_INVENTORY_SKU_MOVE}`)
  })

  it('Shopify moves (renamed in place); Etsy cannot (the review\'s Etsy sentence)', () => {
    expect(liveChannelSkuMoveRefusal({ channel: 'SHOPIFY', marketplace: 'GLOBAL', ...held, liveChannelSku: 'SH-1' }, 'P-3', 'SH-2')).toBeNull()
    expect(liveChannelSkuMoveRefusal({ channel: 'ETSY', marketplace: 'GLOBAL', ...held, liveChannelSku: 'ET-1' }, 'P-4', 'ET-2')).toBe(etsySkuMoveSentence('ET-1', 'ET-2'))
  })

  it('back to the SKU the channel holds is no move anywhere, so is following the product SKU when that is what it holds', () => {
    expect(liveChannelSkuMoveRefusal({ channel: 'ETSY', marketplace: 'GLOBAL', ...held, channelSku: 'X', liveChannelSku: 'KEPT' }, 'P-1', 'KEPT')).toBeNull()
    expect(liveChannelSkuMoveRefusal({ ...amazon, channelSku: 'P-1' }, 'P-1', null, { mainRow: true })).toBeNull()
  })

  it('a still-draft or deleted listing takes any SKU, on every channel', () => {
    for (const channel of ['AMAZON', 'EBAY', 'ETSY']) {
      expect(liveChannelSkuMoveRefusal({ channel, marketplace: 'DE', ...draft, liveChannelSku: null, offers: [{ sku: 'OLD', isActive: true }] }, 'P-1', 'ANY', { mainRow: true, ebayInventory: true })).toBeNull()
    }
  })

  it('a held listing with two SKUs on record may name one of them, never a third', () => {
    const two = { channel: 'AMAZON', marketplace: 'DE', ...held, flatFileSnapshot: { item_sku: 'A' }, platformAttributes: { sellerSku: 'B' } }
    expect(liveChannelSkuMoveRefusal(two, 'P-1', 'B')).toBeNull()
    expect(liveChannelSkuMoveRefusal(two, 'P-1', 'C')).toContain('Choose the SKU Amazon · DE holds (B or A).')
  })

  it('another channel cannot move yet', () => {
    expect(channelSkuMoveRefusal('WALMART', 'A', 'B')).toContain('Delete it, then list it again.')
  })
})

describe('S9 — the Shopify SKU column shows exactly the wanted SKU (one rule, S5\'s order)', () => {
  const shown = (row: Record<string, unknown>, productSku = 'P-1', alias?: { sku: string | null; productId: string } | null) =>
    withWantedShopifySku({ channel: 'SHOPIFY', productId: 'p1', aliasKey: '', ...row }, productSku, alias)
  it('own SKU, then the old sheet edit, then the stored native SKU: only that value is left in the SKU stores', () => {
    expect(shown({ channelSku: ' SH-OWN ', platformAttributes: { sku: 'SH-OLD', vendor: 'X' }, overrideData: { listing_sku: 'SH-EDIT', other: 1 } }))
      .toMatchObject({ platformAttributes: { sku: 'SH-OWN', vendor: 'X' }, overrideData: { other: 1 } })
    expect(shown({ platformAttributes: { sku: 'SH-OLD' }, overrideData: { listing_sku: 'SH-EDIT' } }).platformAttributes).toEqual({ sku: 'SH-EDIT' })
    expect(shown({ platformAttributes: { sku: 'SH-OLD' } }).platformAttributes).toEqual({ sku: 'SH-OLD' })
  })
  it('the product SKU: no stored SKU at all (the column\'s rule shows it); a conflict: an empty SKU', () => {
    const blank = shown({ platformAttributes: { sku: '' }, overrideData: { listing_sku: null } })
    expect([blank.platformAttributes, blank.overrideData]).toEqual([{}, {}])
    expect(shown({ aliasKey: 'a1', platformAttributes: { sku: 'SH-A' } }, 'P-1', { sku: 'SH-B', productId: 'p1' }).platformAttributes).toEqual({ sku: null })
    expect(shown({ aliasKey: 'a1' }, 'P-1', { sku: 'SH-ALIAS', productId: 'p1' }).platformAttributes).toEqual({ sku: 'SH-ALIAS' })
  })
  it('another channel: the row as it is', () => {
    const amazon = { channel: 'AMAZON', channelSku: 'A-OWN', platformAttributes: {} }
    expect(withWantedShopifySku(amazon, 'P-1')).toBe(amazon)
  })
})

describe('S9 — the shared-stock guard refuses a rename in one plain sentence', () => {
  const dbError = (sentence: string) => Object.assign(new Error(`Invalid prisma.product.update() invocation:\n\nDatabase error. Code: \`23514\`. Message: \`${sentence}\``), { code: 'P2010' })
  it('borrower and lender, each naming what to do; any other error is not this one', () => {
    expect(skuRenameRefusal(dbError('JACKET-M sells from the stock of Xavia Racing. Disconnect it first (Matrix, Stock source), then change it.')))
      .toBe('JACKET-M sells from the stock of Xavia Racing, and the SKU is what connects them: disconnect it first (Matrix, Stock source), then rename it.')
    expect(skuRenameRefusal(dbError('JACKET-M shares its stock with Motovento. Disconnect it there first, then change it.')))
      .toBe('JACKET-M shares its stock with Motovento, and the SKU is what connects them: disconnect it in Motovento first, then rename it.')
    expect(skuRenameRefusal(new Error('unique constraint failed'))).toBeNull()
  })
})

describe('S11 follow-up — the product-SKU rule on a Shared rename (the sheet\'s own check, on the server)', () => {
  it('a NEW SKU follows the rule: trimmed, at most 100 characters, letters, numbers, dots, hyphens and underscores', () => {
    expect(productSkuRuleRefusal('OLD-1', 'NEW_1.a-b')).toBeNull()
    expect(productSkuRuleRefusal('OLD-1', '  NEW-1  ')).toBeNull()
    expect(productSkuRuleRefusal('OLD-1', 'NEW 1')).toBe('Use only letters, numbers, dots (.), hyphens (-) and underscores (_). No spaces.')
    expect(productSkuRuleRefusal('OLD-1', 'NEW/1')).toBe('Use only letters, numbers, dots (.), hyphens (-) and underscores (_). No spaces.')
    expect(productSkuRuleRefusal('OLD-1', 'A'.repeat(101))).toBe('A SKU can have up to 100 characters. This one has 101.')
    expect(productSkuRuleRefusal('OLD-1', 'A'.repeat(100))).toBeNull()
  })
  it('a SKU the product already has is never refused, even one that breaks the rule', () => {
    expect(productSkuRuleRefusal('OLD SKU/1', 'OLD SKU/1')).toBeNull()
    expect(productSkuRuleRefusal('OLD SKU/1', ' OLD SKU/1 ')).toBeNull()
    // Leaving it for a valid SKU is a rename like any other.
    expect(productSkuRuleRefusal('OLD SKU/1', 'OLD-SKU-1')).toBeNull()
  })
})
