/**
 * GALE incident #3 regression — the push-mode routing decision.
 * Feed mode must NEVER handle shared/duplicate-SKU payloads, and since P1.6 (R-6) the row count never
 * chooses the feed lane: only an explicit mode:'feed' does.
 * Run: npx vitest run apps/api/src/services/ebay-push-mode.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import { decideEbayPushMode } from './ebay-push-mode.js'

const uniqueRows = (n: number) => Array.from({ length: n }, (_, i) => ({ sku: `SKU-${i}` }))

describe('decideEbayPushMode', () => {
  it('THE INCIDENT: 84 shared rows over the feed threshold → api (never feed)', () => {
    // 5 listings × ~17 children, same child SKUs repeated (shared model).
    const rows: Array<{ sku: string; shared_sku_listing: boolean }> = []
    for (let listing = 0; listing < 5; listing++) {
      for (let child = 0; child < 17; child++) {
        rows.push({ sku: `CHILD-${child}`, shared_sku_listing: true })
      }
    }
    expect(rows.length).toBeGreaterThan(50)
    const d = decideEbayPushMode(rows, undefined)
    expect(d.mode).toBe('api')
    expect(d.forcedApi).toBe(true)
    expect(d.hasSharedRow).toBe(true)
    expect(d.hasDuplicateSku).toBe(true)
  })

  it('duplicate SKUs alone (no shared flag) force api over the threshold', () => {
    const rows = [...uniqueRows(60), { sku: 'SKU-0' }] // 61 rows, one dup
    const d = decideEbayPushMode(rows, undefined)
    expect(d.mode).toBe('api')
    expect(d.hasDuplicateSku).toBe(true)
    expect(d.forcedApi).toBe(true)
  })

  it('a single _shared synthesized row forces api', () => {
    const rows = [...uniqueRows(60), { sku: 'X', _shared: true }]
    expect(decideEbayPushMode(rows, undefined).mode).toBe('api')
  })

  it('P1.6 — a large UNIQUE-SKU push takes the API lane: the row count no longer chooses feed', () => {
    const d = decideEbayPushMode(uniqueRows(80), undefined)
    expect(d.mode).toBe('api')
    expect(d.forcedApi).toBe(false)
    expect(d.hasSharedRow).toBe(false)
    expect(d.hasDuplicateSku).toBe(false)
  })

  it('P1.6 — no row count reaches the feed lane by itself', () => {
    for (const n of [10, 51, 200, 2000]) expect(decideEbayPushMode(uniqueRows(n), undefined).mode).toBe('api')
  })

  it('P1.6 — an explicit mode:feed on a clean unique payload is still honoured', () => {
    expect(decideEbayPushMode(uniqueRows(80), 'feed').mode).toBe('feed')
  })

  it('explicit mode:api is always honored and is NOT a forced override', () => {
    const d = decideEbayPushMode(uniqueRows(80), 'api')
    expect(d.mode).toBe('api')
    expect(d.forcedApi).toBe(false)
  })

  it('explicit mode:feed on a shared payload is still overridden to api (safety wins)', () => {
    const rows = [{ sku: 'A', shared_sku_listing: true }, { sku: 'A', shared_sku_listing: true }]
    expect(decideEbayPushMode(rows, 'feed').mode).toBe('api')
  })

  it('blank SKUs never count as duplicates', () => {
    const rows = [{ sku: '' }, { sku: '' }, ...uniqueRows(60)]
    const d = decideEbayPushMode(rows, undefined)
    expect(d.hasDuplicateSku).toBe(false)
    expect(d.mode).toBe('api')
  })
})
