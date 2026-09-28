import { expect, it, vi } from 'vitest'

/**
 * Images rebuild W2 (A2) — Nexus addresses an eBay Inventory listing by the family's parent SKU and SKUs, which belong to
 * the main listing. An alias on the Inventory API is refused before anything is read or sent.
 */
const reads = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => { reads.calls++; return 'live' } }))

import { INVENTORY_ALIAS_REFUSAL, prepareEbayInventoryPublication } from './studio-publication-ebay.js'

it('refuses an eBay Inventory alias before it checks, reads or builds anything', async () => {
  const facts = { scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'account' }, destination: { familyId: 'family', aliasKey: 'alias-1' },
    parent: { id: 'family', sku: 'FAM' }, products: [], listings: [], resolved: [], issues: [] }
  await expect(prepareEbayInventoryPublication(facts as never)).rejects.toThrow(INVENTORY_ALIAS_REFUSAL)
  expect(reads.calls).toBe(0)
})
