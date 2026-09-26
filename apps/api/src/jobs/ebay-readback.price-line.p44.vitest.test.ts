/**
 * P4.4 (CX) B2 — the cron line of the eBay read-back carries the Trading price arm BESIDE the quantity
 * arm (a clean quantity run with drifted prices must not read as a clean run), marked "(heal off)".
 */
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ tick: null as null | (() => Promise<void>), summaries: [] as string[] }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { validate: () => true, schedule: (_s: string, fn: () => Promise<void>) => { h.tick = fn; return { stop() {} } } } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_name: string, fn: () => Promise<string>) => { h.summaries.push(await fn()) } }))
vi.mock('../services/ebay-inventory-readback.service.js', () => ({
  readBackEbayInventory: async () => ({ checked: 3, recorded: 1, errors: 0, capped: false }),
  readBackEbayTradingQuantities: async () => ({
    items: 4, skusChecked: 7, mismatches: 0, logged: 0, healedProducts: 0, resolved: 0, endedMemberships: 0, errors: 0, capped: false, driftRecorded: 5, driftUnmapped: 2,
    price: { compared: 4, mismatches: 2, currencyMismatches: 1, logged: 3, skipped: 1, nullPrice: 1, fallback: 1, unread: 2 },
  }),
}))

const { startEbayReadbackCron } = await import('./ebay-readback.job.js')

describe('P4.4 (CX) — the ebay-readback cron line', () => {
  it('keeps the quantity line as it was and appends the price arm, heal off', async () => {
    startEbayReadbackCron()
    await h.tick!()
    expect(h.summaries).toEqual([
      'inv checked=3 recorded=1 errors=0 · trading items=4 skus=7 mismatch=0 logged=0 healed=0 resolved=0 ended=0 errors=0'
      + ' · drift recorded=5 unmapped=2 · price compared=4 mismatches=2 currency=1 logged=3 skipped=1 null=1 fallback=1 unread=2 (heal off)',
    ])
  })
})
