/**
 * P4.2b — an eBay Inventory-API offer rejection reaches its listing.
 *
 * ## The decision this slice had to make first
 *
 * `pushVariationGroup` — the Inventory-API publisher shared by the flat-file push
 * AND the image publish — has **12 `results.push` sites**, and they are two
 * different kinds of thing:
 *
 *   eBay's verdicts   `inventory_item PUT 400: …`, `offer create 400: …`,
 *                     `offer update 400: …`   (an eBay HTTP answer in hand)
 *   OUR validation    "No images found for this SKU", "No DE price set",
 *                     "No existing offer — run Full Publish first"
 *
 * Filing every `ERROR` row would dress our own validation up as an eBay
 * rejection. P3.2's contract is *"a rejected change shows on the listing **in the
 * channel's words**"*, and our validation is not the channel's words — it already
 * reaches the operator as a per-row result in the push response.
 *
 * So **four** sites file, and eight do not. The census below is derived from the
 * source so the split cannot quietly drift.
 *
 * ## And a retryable answer is NOT filed
 *
 * P3.1's rule: *"a 429 or a socket reset is our problem to retry, not a defect in
 * the operator's listing, and filing them would bury the four real rejections
 * under a thousand throttles."* `classifyChannelAnswer` marks a 5xx and eBay's
 * own retry errorIds retryable; `recordVerdictOnListing` drops those. The same
 * file already marks 25604 / 25001 `isTransientItemErr` and retries them itself,
 * so filing them would contradict its own behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordEbayOfferRejection, resolveEbayListingIdsBySku } from './listing-issue-recorder.service.js'

const SRC = join(import.meta.dirname, '..')
const push = readFileSync(join(SRC, 'services', 'ebay-variation-push.service.ts'), 'utf8')

function stubPrisma(rows: Array<{ id: string }>) {
  const asked: any[] = []
  const written: any[] = []
  return {
    asked,
    written,
    client: {
      channelListing: { findMany: async (a: any) => { asked.push(a); return rows } },
      listingIssue: {
        upsert: async (a: any) => { written.push(a); return {} },
        updateMany: async () => ({ count: 0 }),
      },
    } as any,
  }
}

/** eBay's real refusal shape. */
const REFUSAL = JSON.stringify({ errors: [{ errorId: 25002, message: 'A user error has occurred. The merchantLocationKey is missing.', longMessage: 'merchantLocationKey is required' }] })
const TRANSIENT = JSON.stringify({ errors: [{ errorId: 25604, message: 'Internal error. Please retry.' }] })

beforeEach(() => vi.restoreAllMocks())

/* ── resolution ───────────────────────────────────────────────────────────── */

describe('the listing is resolved by SKU, market AND account', () => {
  it('keys on all three', async () => {
    const p = stubPrisma([{ id: 'L1' }])
    await resolveEbayListingIdsBySku({ sku: 'SKU-1', marketplace: 'de', connectionId: 'conn-A', prisma: p.client })
    expect(p.asked).toHaveLength(1) // positive control
    expect(p.asked[0].where).toEqual({
      channel: 'EBAY', marketplace: 'DE', channelConnectionId: 'conn-A', product: { sku: 'SKU-1' },
    })
  })

  it('never resolves without the account', async () => {
    // The MAP.3 refusal: one seller's rejection must not reach another's listing.
    const p = stubPrisma([{ id: 'L1' }])
    expect(await resolveEbayListingIdsBySku({ sku: 'SKU-1', marketplace: 'DE', connectionId: null, prisma: p.client })).toEqual([])
    expect(p.asked).toEqual([])
  })

  it('returns every listing the SKU holds, not the first', async () => {
    const p = stubPrisma([{ id: 'L1' }, { id: 'L2' }])
    expect(await resolveEbayListingIdsBySku({ sku: 'S', marketplace: 'DE', connectionId: 'c', prisma: p.client })).toEqual(['L1', 'L2'])
  })

  it('a named listing wins outright, with no query', async () => {
    const p = stubPrisma([{ id: 'other' }])
    expect(await resolveEbayListingIdsBySku({ listingId: 'named', sku: 'S', marketplace: 'DE', connectionId: 'c', prisma: p.client })).toEqual(['named'])
    expect(p.asked).toEqual([])
  })

  it('never throws', async () => {
    const broken = { channelListing: { findMany: async () => { throw new Error('db down') } } } as any
    await expect(resolveEbayListingIdsBySku({ sku: 'S', marketplace: 'DE', connectionId: 'c', prisma: broken })).resolves.toEqual([])
  })
})

/* ── behaviour: what gets filed, and what does not ────────────────────────── */

describe('a real refusal is filed, in eBay’s own words', () => {
  it('files eBay’s code and message on every listing for the SKU', async () => {
    const p = stubPrisma([{ id: 'L1' }, { id: 'L2' }])
    const out = await recordEbayOfferRejection({
      sku: 'SKU-1', marketplace: 'DE', connectionId: 'conn-A', status: 400, body: REFUSAL, prisma: p.client,
    })
    expect(out.listings).toBe(2)
    const created = p.written.filter((w: any) => w.create)
    expect(created.map((w: any) => w.create.listingId).sort()).toEqual(['L1', 'L2'])
    expect(created[0].create.source).toBe('ebay-write')
    expect(String(created[0].create.code)).toContain('25002')
    expect(String(created[0].create.message)).toMatch(/merchantLocationKey/i)
  })

  it('does not paste the raw body as the message', async () => {
    // The answer is CLASSIFIED (P3.1's vocabulary), not dumped. A raw JSON blob
    // on a listing row is not "the channel's words" to an operator.
    const p = stubPrisma([{ id: 'L1' }])
    await recordEbayOfferRejection({ sku: 'S', marketplace: 'DE', connectionId: 'c', status: 400, body: REFUSAL, prisma: p.client })
    const created = p.written.find((w: any) => w.create).create
    expect(String(created.message)).not.toContain('{"errors"')
  })
})

describe('a RETRYABLE answer is not filed', () => {
  it('drops a 5xx', async () => {
    const p = stubPrisma([{ id: 'L1' }])
    expect(await recordEbayOfferRejection({ sku: 'S', marketplace: 'DE', connectionId: 'c', status: 503, body: '', prisma: p.client }))
      .toEqual({ listings: 0, issues: 0 })
    // It did not even look for a listing — there is nothing to file.
    expect(p.asked).toEqual([])
    expect(p.written).toEqual([])
  })

  it('drops eBay’s own retry errorId, the one this file already retries', async () => {
    const p = stubPrisma([{ id: 'L1' }])
    expect(await recordEbayOfferRejection({ sku: 'S', marketplace: 'DE', connectionId: 'c', status: 500, body: TRANSIENT, prisma: p.client }))
      .toEqual({ listings: 0, issues: 0 })
    expect(p.written).toEqual([])
  })

  it('POSITIVE CONTROL — the same path DOES file a 400', async () => {
    // Without this, "drops everything" would pass the two tests above.
    const p = stubPrisma([{ id: 'L1' }])
    expect((await recordEbayOfferRejection({ sku: 'S', marketplace: 'DE', connectionId: 'c', status: 400, body: REFUSAL, prisma: p.client })).listings).toBe(1)
  })
})

/* ── the split, derived from source ───────────────────────────────────────── */

describe('only eBay’s verdicts are filed, and the split is derived', () => {
  it('files from exactly the four sites that hold an eBay answer', () => {
    expect((push.match(/await recordEbayOfferRejection\(\{/g) ?? []).length).toBe(4)
  })

  it('every filing call passes eBay’s OWN status and body', () => {
    // A call that invented a status, or passed our own message as the body,
    // would file our validation in eBay's name.
    const calls = push.match(/await recordEbayOfferRejection\(\{[^}]*\}\)/g) ?? []
    expect(calls).toHaveLength(4) // positive control
    for (const call of calls) {
      expect(call).toMatch(/status: \w+\.status/)
      expect(call).toMatch(/body: err/)
      expect(call).toContain('connectionId')
      expect(call).toContain('marketplace: mp')
    }
  })

  it('does NOT file from our own validation messages', () => {
    // Each of these is our check, never an eBay answer. They must stay
    // per-row results in the push response and never reach a listing.
    const OURS = [
      'No images found for this SKU',
      'No ${mp} price set for ${sku}',
      'No existing offer for ${sku}',
    ]
    for (const ours of OURS) {
      const i = push.indexOf(ours)
      expect(i, `"${ours}" should still exist as our own message`).toBeGreaterThan(0)
      // No filing call within the surrounding block.
      expect(push.slice(Math.max(0, i - 400), i + 400)).not.toContain('recordEbayOfferRejection')
    }
  })

  it('the file still reports every error to the operator', () => {
    // Filing is IN ADDITION to the per-row result, never instead of it: the
    // push response is what the operator is looking at when they press Publish.
    expect((push.match(/results\.push\(\{/g) ?? []).length).toBeGreaterThanOrEqual(12)
  })
})
