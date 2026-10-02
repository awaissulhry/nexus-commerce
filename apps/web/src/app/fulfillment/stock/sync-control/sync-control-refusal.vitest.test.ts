/**
 * Sync Control — a pin to 0 on eBay is refused while the account's out-of-stock option is OFF or unreadable (eBay would
 * END the listing): the API answers 409 with code EBAY_ZERO_REFUSED and the sentence. Every surface that runs an action
 * (listings view, products view, one product) shows that sentence in the design system's Banner, not as a failure.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ebayZeroRefusal } from './sync-control-shared'

const SENTENCE = 'TEST-SKU-1 on eBay IT: Refused — eBay ends a listing pinned at 0 … Nothing was changed.'

describe('the eBay pin-to-0 refusal', () => {
  it('is read from the 409 by its code, never from status or words alone', () => {
    expect(ebayZeroRefusal(409, { error: SENTENCE, code: 'EBAY_ZERO_REFUSED', refused: [] })).toBe(SENTENCE)
    expect(ebayZeroRefusal(409, { error: 'Amazon keeps ONE quantity …', euExpandRequired: true })).toBeNull()
    expect(ebayZeroRefusal(400, { error: SENTENCE, code: 'EBAY_ZERO_REFUSED' })).toBeNull()
    expect(ebayZeroRefusal(409, null)).toBeNull()
  })

  it('is shown in a Banner on every surface that runs an action', () => {
    const read = (file: string) => readFileSync(path.join(__dirname, file), 'utf8')
    for (const file of ['SyncControlClient.tsx', 'product/[masterId]/ProductDetailClient.tsx']) {
      const source = read(file)
      expect(source, file).toMatch(/ebayZeroRefusal\(/)
      expect(source, file).toMatch(/<Banner[^>]*tone="danger"/)
    }
    // The products view hands it to the listings page, which shows it.
    expect(read('SyncProductsGrid.tsx')).toMatch(/ebayZeroRefusal\(/)
    expect(read('SyncControlClient.tsx')).toMatch(/refuse=\{setRefusal\}/)
  })
})
