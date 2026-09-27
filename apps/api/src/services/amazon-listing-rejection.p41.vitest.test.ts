/**
 * P4.1b — an Amazon single-item rejection reaches its listing too.
 *
 * ## What was measured (2026-09-20), and how the handover was wrong
 *
 * `PROGRESS.md` §3.1 item 2 said `putListingsItem` / `patchListingsItem` are
 * "**0 occurrences in `apps/api/src`**". Measured: **28 occurrences of
 * `putListingsItem`.** The "0" is true only of the SDK operation STRING
 * (`operation: 'putListingsItem'`, 2 places, both tests), while
 * `AmazonSpApiClient.putListingsItem()` — a real method that sends its own
 * request — sits beside it with a live call site.
 *
 * So the gap was never "there is no producer". Amazon's `issues` array is
 * parsed, logged and handed back, and nothing writes it to `ListingIssue`.
 *
 * ## The rules
 *
 * 1. a named listing wins outright;
 * 2. never resolve without the marketplace — and `normalizeMarketplaceCode`
 *    returns the STRING `'UNKNOWN'`, never null, so the fallback is refused
 *    explicitly;
 * 3. one SKU in one marketplace can still be several listings; all are filed;
 * 4. an accepted write records an EMPTY set on purpose, which is what closes a
 *    rejection once the listing is fixed;
 * 5. offer patches are deliberately NOT filed, because `listings-api` is a
 *    REPLACE source and an offer call's answer would resolve content rejections
 *    it never spoke about.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  recordAmazonListingIssues,
  resolveAmazonListingIds,
} from './listing-issue-recorder.service.js'

const SRC = join(import.meta.dirname, '..')
const IT = 'APJ6JRA9NG5V4'

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
        updateMany: async (a: any) => { written.push({ resolve: a }); return { count: 2 } },
      },
    } as any,
  }
}

const REJECTION = [{ code: '90220', message: 'Il valore per color_name è obbligatorio', severity: 'ERROR', attributeNames: ['color_name'], categories: [] }]

describe('1. a listing the caller named wins outright', () => {
  it('uses it and asks the database nothing', async () => {
    const p = stubPrisma([{ id: 'other' }])
    expect(await resolveAmazonListingIds({ listingId: 'named', sku: 'SKU-1', marketplaceId: IT, prisma: p.client })).toEqual(['named'])
    expect(p.asked).toEqual([])
  })
})

describe('2. never resolve without a marketplace we recognise', () => {
  it('keys the query on the SKU and the 2-letter code', async () => {
    const p = stubPrisma([{ id: 'L1' }])
    await resolveAmazonListingIds({ sku: 'SKU-1', marketplaceId: IT, prisma: p.client })
    expect(p.asked).toHaveLength(1) // positive control
    expect(p.asked[0].where).toEqual({ channel: 'AMAZON', marketplace: 'IT', product: { sku: 'SKU-1' } })
  })

  it('accepts the 2-letter code directly as well as the SP-API id', async () => {
    const p = stubPrisma([{ id: 'L1' }])
    await resolveAmazonListingIds({ sku: 'SKU-1', marketplaceId: 'de', prisma: p.client })
    expect(p.asked[0].where.marketplace).toBe('DE')
  })

  it('refuses an id it does not know, instead of querying for "UNKNOWN"', async () => {
    // 🔴 normalizeMarketplaceCode NEVER returns null — an unknown id becomes the
    // literal string 'UNKNOWN'. Querying for that reads as a clean "no listing
    // carries this SKU" while the truth is "we could not tell which marketplace
    // this was", and it would match any row that really does store 'UNKNOWN'.
    const p = stubPrisma([{ id: 'L1' }])
    expect(await resolveAmazonListingIds({ sku: 'SKU-1', marketplaceId: 'NOT-A-MARKETPLACE', prisma: p.client })).toEqual([])
    expect(p.asked).toEqual([])
  })

  it('refuses a missing SKU or a missing marketplace', async () => {
    const p = stubPrisma([{ id: 'L1' }])
    expect(await resolveAmazonListingIds({ sku: null, marketplaceId: IT, prisma: p.client })).toEqual([])
    expect(await resolveAmazonListingIds({ sku: 'SKU-1', marketplaceId: null, prisma: p.client })).toEqual([])
    expect(p.asked).toEqual([])
  })

  it('does not file Italy’s rejection on the German listing', async () => {
    // The whole reason the marketplace is part of the key: one SKU is listed in
    // several marketplaces at once, and Amazon rejects it per marketplace.
    const p = stubPrisma([{ id: 'L-IT' }])
    await recordAmazonListingIssues({ sku: 'SKU-1', marketplaceId: IT, issues: REJECTION, prisma: p.client })
    expect(p.asked[0].where.marketplace).toBe('IT')
    expect(p.asked[0].where.marketplace).not.toBe('DE')
  })
})

describe('3. a SKU can still be several listings', () => {
  it('files on every one of them', async () => {
    const p = stubPrisma([{ id: 'L1' }, { id: 'L2' }])
    expect(await recordAmazonListingIssues({ sku: 'SKU-1', marketplaceId: IT, issues: REJECTION, prisma: p.client }))
      .toEqual({ listings: 2, issues: 2 })
    expect(p.written.filter((w: any) => w.create).map((w: any) => w.create.listingId).sort()).toEqual(['L1', 'L2'])
  })

  it('files in Amazon’s own words, with the attribute it named', async () => {
    const p = stubPrisma([{ id: 'L1' }])
    await recordAmazonListingIssues({ sku: 'SKU-1', marketplaceId: IT, issues: REJECTION, prisma: p.client })
    const created = p.written.find((w: any) => w.create).create
    expect(created.message).toBe('Il valore per color_name è obbligatorio')
    expect(created.code).toBe('90220')
    expect(created.attributeNames).toEqual(['color_name'])
    expect(created.source).toBe('listings-api')
  })
})

describe('4. an accepted write CLOSES what is no longer true', () => {
  it('records an empty set, which resolves the open listings-api issues', async () => {
    // `listings-api` is a REPLACE source. Without this, a rejection would sit on
    // a healthy listing for ever, which is the false-red twin of a false green.
    const p = stubPrisma([{ id: 'L1' }])
    const result = await recordAmazonListingIssues({ sku: 'SKU-1', marketplaceId: IT, issues: [], prisma: p.client })
    expect(result.listings).toBe(1)
    const resolveCall = p.written.find((w: any) => w.resolve)
    expect(resolveCall, 'an empty set must reach the resolve sweep').toBeTruthy()
    expect(resolveCall.resolve.where.listingId).toBe('L1')
    expect(resolveCall.resolve.where.source).toBe('listings-api')
  })

  it('still reports nothing when no listing carries the SKU', async () => {
    const p = stubPrisma([])
    expect(await recordAmazonListingIssues({ sku: 'SKU-1', marketplaceId: IT, issues: [], prisma: p.client }))
      .toEqual({ listings: 0, issues: 0 })
    expect(p.asked).toHaveLength(1) // it DID ask — that is the difference
  })

  it('never throws', async () => {
    const broken = { channelListing: { findMany: async () => { throw new Error('db down') } } } as any
    await expect(resolveAmazonListingIds({ sku: 'SKU-1', marketplaceId: IT, prisma: broken })).resolves.toEqual([])
  })
})

describe('5. the client files from the content writes, and only those', () => {
  const client = readFileSync(join(SRC, 'clients', 'amazon-sp-api.client.ts'), 'utf8')

  /** The method each `fileListingIssues` call sits inside. */
  function callersOfFiler(): string[] {
    const out: string[] = []
    for (const m of client.matchAll(/await this\.fileListingIssues\(/g)) {
      const before = client.slice(0, m.index)
      const method = [...before.matchAll(/^  (?:private )?async ([a-zA-Z]+)\(/gm)].pop()
      out.push(method ? method[1] : '?')
    }
    return out
  }

  it('files from both paths of both content writes', () => {
    const callers = callersOfFiler()
    expect(callers).toHaveLength(4) // positive control: the wiring is there
    // Two per method: the rejection, and the acceptance that closes it.
    expect(callers.filter((c) => c === 'submitListingPayload')).toHaveLength(2)
    expect(callers.filter((c) => c === 'putListingsItem')).toHaveLength(2)
  })

  it('does NOT file from an offer patch', () => {
    // `listings-api` is a REPLACE source, so an offer call's answer would resolve
    // CONTENT rejections it never spoke about. Named, not forgotten.
    const callers = callersOfFiler()
    expect(callers).not.toContain('patchListingPrice')
    expect(callers).not.toContain('patchPurchasableOffer')
    expect(callers).not.toContain('deleteListingsItem')
    // Control: those methods really do exist, so this is not vacuous.
    expect(client).toContain('async patchListingPrice(')
    expect(client).toContain('async patchPurchasableOffer(')
    expect(client).toContain('async deleteListingsItem(')
  })

  it('reuses the marketplaceId the method already computed', () => {
    // Two names for one fact is the shape of every drift defect here: the
    // submit path must not recompute a default the request did not use.
    expect(client).toMatch(/await this\.fileListingIssues\(sku, marketplaceId, data\.issues\)/)
    expect(client).not.toMatch(/fileListingIssues\(sku, options\.marketplaceId \?\?/)
  })

  it('never lets a failed filing break the write', () => {
    const body = client.slice(client.indexOf('private async fileListingIssues'))
    expect(body.slice(0, 1600)).toContain('catch (error)')
  })
})

describe('the handover claim this package corrected', () => {
  it('putListingsItem is NOT 0 occurrences', () => {
    // The banked rule, re-derived. It said 0; it is not 0.
    const all = readFileSync(join(SRC, 'clients', 'amazon-sp-api.client.ts'), 'utf8')
    expect(all).toContain('async putListingsItem(')
    expect((all.match(/putListingsItem/g) ?? []).length).toBeGreaterThan(5)
  })

  it('and it has a live call site outside the client', () => {
    // It was `routes/marketplaces.routes.ts`'s direct publish until the old product editor, its only caller, was deleted.
    const adapter = readFileSync(join(SRC, 'services', 'listing-wizard', 'amazon-publish.adapter.ts'), 'utf8')
    expect(adapter).toContain('amazonSpApiClient.putListingsItem({')
  })
})
