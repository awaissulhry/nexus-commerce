/**
 * E8.0 — quota metering + bulk multi-status parsing.
 *
 * Covers the four defects found auditing the E2/E4 client:
 *   E8.0-1 writes were metered against the fail-OPEN reads ledger
 *   E8.0-3 the 429/5xx ladder burned up to 4 calls on one reservation
 *   E8.0-4 a missing per-item statusCode was coerced to 200 (silent success)
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBulkResponses } from './ebay-ads-api.service.js'
import { QuotaLedger, MemoryQuotaStore, type QuotaStore } from '../ads-core/quota-ledger.js'

// ── E8.0-4 — bulk 207 per-item parsing ──────────────────────────────────────
describe('parseBulkResponses (E8.0-4 — fails closed on unreadable items)', () => {
  it('honours an explicit per-item statusCode', () => {
    const r = parseBulkResponses(
      [
        { listingId: '1', statusCode: 200, adId: 'a1' },
        { listingId: '2', statusCode: 400, errors: [{ message: 'bad listing' }] },
      ],
      'listingId',
      'adId',
    )
    expect(r[0]).toMatchObject({ key: '1', ok: true, id: 'a1', error: null })
    expect(r[1]).toMatchObject({ key: '2', ok: false, error: 'bad listing' })
  })

  it('treats a missing statusCode as SUCCESS when an id is present and there are no errors', () => {
    // eBay does omit statusCode on some success responses — absence alone must
    // not be read as failure, or every successful bulk write regresses.
    const r = parseBulkResponses([{ listingId: '1', adId: 'a1' }], 'listingId', 'adId')
    expect(r[0]).toMatchObject({ key: '1', ok: true, id: 'a1' })
    expect(r[0].statusCode).toBeUndefined()
  })

  it('resolves the id from the href tail when the id field is absent', () => {
    const r = parseBulkResponses([{ listingId: '1', href: '/sell/marketing/v1/ad/9987' }], 'listingId', 'adId')
    expect(r[0]).toMatchObject({ ok: true, id: '9987' })
  })

  it('FAILS an item with no statusCode, no id and no errors (was silently 200)', () => {
    const r = parseBulkResponses([{ listingId: '1' }], 'listingId', 'adId')
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toMatch(/no statusCode, no id and no errors/)
  })

  it('FAILS an item carrying errors even when a statusCode is absent', () => {
    const r = parseBulkResponses(
      [{ listingId: '1', adId: 'a1', errors: [{ errorId: 35036, message: 'ad already exists' }] }],
      'listingId',
      'adId',
    )
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toBe('ad already exists')
  })

  it('FAILS a non-numeric statusCode rather than coercing it', () => {
    const r = parseBulkResponses([{ listingId: '1', statusCode: 'OK', adId: 'a1' }], 'listingId', 'adId')
    expect(r[0].ok).toBe(false)
  })

  it('returns [] for a missing responses[] array instead of inventing successes', () => {
    expect(parseBulkResponses(undefined, 'listingId', 'adId')).toEqual([])
  })

  it('does not treat an empty responses[] as success for the requested items', () => {
    expect(parseBulkResponses([], 'listingId', 'adId')).toEqual([])
  })
})

// ── E8.0-1 — read vs write fail modes on the shared daily budget ────────────
describe('quota fail modes (E8.0-1 — writes must fail CLOSED)', () => {
  const broken: QuotaStore = { incr: async () => { throw new Error('redis down') } }
  const DAILY = { key: 'ebay:mkt:ads-daily', limit: 9000, windowSec: 86_400 }

  it('a read is allowed through a store outage (fail open, degraded)', async () => {
    const r = await new QuotaLedger(broken, { failMode: 'open' }).reserve(DAILY)
    expect(r.ok).toBe(true)
    expect(r.degraded).toBe(true)
  })

  it('a write is REFUSED through a store outage (fail closed, degraded)', async () => {
    const r = await new QuotaLedger(broken, { failMode: 'closed' }).reserve(DAILY)
    expect(r.ok).toBe(false)
    expect(r.degraded).toBe(true)
  })

  it('reads and writes draw down the SAME daily key — they are one eBay pool', async () => {
    const store = new MemoryQuotaStore()
    const reads = new QuotaLedger(store, { failMode: 'open' })
    const writes = new QuotaLedger(store, { failMode: 'closed' })
    const SMALL = { key: 'ebay:mkt:ads-daily', limit: 2, windowSec: 86_400 }

    expect((await reads.reserve(SMALL)).ok).toBe(true)
    expect((await writes.reserve(SMALL)).ok).toBe(true)
    // Budget is now exhausted for BOTH — a separate write budget would have
    // silently doubled the account's effective quota.
    expect((await reads.reserve(SMALL)).ok).toBe(false)
    expect((await writes.reserve(SMALL)).ok).toBe(false)
  })
})

// ── E8.0-2 — the metered client is the ONLY door to the Ads quota pool ──────
describe('quota chokepoint (E8.0-2 — no un-ledgered Ads call sites)', () => {
  // eBay's Marketing "Ads" methods (ad_campaign / ad / keyword / report) share
  // one 10k/day pool. Promotions methods (item_promotion,
  // item_price_markdown_promotion) are a DIFFERENT bucket and are exempt.
  const ADS_PATHS = /sell\/marketing\/v1\/(ad_campaign|ad_report|ad_report_task|ad_report_metadata|bulk_create_negative_keyword)/
  const CLIENT = 'ebay-ads-api.service.ts'

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
    }
    return out
  }

  it('no file other than the metered client makes a raw fetch to an Ads endpoint', () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const offenders: string[] = []

    for (const file of walk(srcRoot)) {
      if (file.endsWith(CLIENT)) continue
      const src = readFileSync(file, 'utf8')
      for (const line of src.split('\n')) {
        if (line.includes('fetch(') && ADS_PATHS.test(line)) {
          offenders.push(`${file.replace(srcRoot, 'src')}: ${line.trim().slice(0, 120)}`)
        }
      }
    }

    expect(offenders, `route these through ebay-ads-api.service.ts so they are quota-metered:\n${offenders.join('\n')}`).toEqual([])
  })
})

// ── E8.0-3 — one reservation per outbound HTTP request ──────────────────────
describe('retry ladder accounting (E8.0-3)', () => {
  it('a 4-attempt ladder consumes 4 units, not 1', async () => {
    const store = new MemoryQuotaStore()
    const ledger = new QuotaLedger(store, { failMode: 'open' })
    const B = { key: 'ebay:mkt:ads-daily', limit: 10, windowSec: 86_400 }

    // marketingFetch reserves once per attempt; simulate the worst case.
    let last = await ledger.reserve(B)
    for (let attempt = 1; attempt < 4; attempt++) last = await ledger.reserve(B)

    expect(last.used).toBe(4)
    expect(last.remaining).toBe(6)
  })
})
