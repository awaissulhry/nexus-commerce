/**
 * P4.6f — the Etsy content refresh.
 *
 * The case that carries this slice is the last describe block. P4.3a found
 * `syncInventoryFromEtsy` writing Etsy's quantities straight into `ProductVariation.stock` and
 * `Product.totalStock`, past the resolver, the shared-stock pool and the audit. A job written to
 * "fix staleness" by copying Etsy's numbers back in would be that defect rebuilt with a better
 * excuse, so the columns this job may write are asserted as a **closed set**, not spot-checked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  gets: [] as string[],
  answers: new Map<string, unknown>(),
  updates: [] as Array<{ where: unknown; data: Record<string, unknown> }>,
  listings: [] as Array<{ id: string; listingStatus: string }>,
  connections: [{ id: 'etsy-1' }] as Array<{ id: string }>,
  readerThrows: null as Error | null,
  getThrows: null as Error | null,
}))

vi.mock('../services/connection-resolver.service.js', () => ({ listActiveConnections: vi.fn(async () => h.connections) }))
vi.mock('../db.js', () => ({
  default: {
    channelListing: {
      findMany: vi.fn(async () => h.listings),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => { h.updates.push(args); return {} }),
    },
  },
}))
vi.mock('../services/etsy/read-client.js', () => ({
  etsyReader: vi.fn(async () => {
    if (h.readerThrows) throw h.readerThrows
    return {
      shopId: '42',
      get: vi.fn(async (path: string) => {
        h.gets.push(path)
        if (h.getThrows) throw h.getThrows
        const state = /state=([a-z_]+)/.exec(path)?.[1] ?? ''
        const offset = Number(/offset=(\d+)/.exec(path)?.[1] ?? '0')
        return offset === 0 ? (h.answers.get(state) ?? { results: [] }) : { results: [] }
      }),
    }
  }),
}))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: vi.fn(async (_n: string, fn: () => Promise<unknown>) => await fn()) }))
vi.mock('../utils/logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { validate: () => true, schedule: vi.fn(() => ({ stop: () => {} })) } }))

import {
  ETSY_LISTING_STATES, ETSY_STATE_TO_LISTING_STATUS, refreshEtsyContent, runEtsyContentRefresh,
} from './etsy-content-refresh.job.js'

beforeEach(() => {
  h.gets = []; h.updates = []; h.answers = new Map(); h.readerThrows = null; h.getThrows = null
  h.listings = [{ id: 'cl-1', listingStatus: 'ACTIVE' }]
  h.connections = [{ id: 'etsy-1' }]
})
afterEach(() => { vi.clearAllMocks() })

describe('P4.6f — the state map is Etsy\'s own enum', () => {
  it('every state Etsy publishes has a mapping — no listing falls through', () => {
    for (const state of ETSY_LISTING_STATES) {
      expect(ETSY_STATE_TO_LISTING_STATUS[state]).toBeTruthy()
    }
    expect(ETSY_LISTING_STATES).toEqual(['active', 'inactive', 'sold_out', 'draft', 'expired', 'removed'])
  })
  it('🔴 sold_out is ACTIVE, not INACTIVE — it is listed and visible, with a quantity we may not write', () => {
    expect(ETSY_STATE_TO_LISTING_STATUS.sold_out).toBe('ACTIVE')
    // Calling it INACTIVE would make the push lock refuse a live listing that only needs restocking.
    expect(ETSY_STATE_TO_LISTING_STATUS.inactive).toBe('INACTIVE')
  })
  it('expired and removed both END the listing, which is what the push lock reads', () => {
    expect(ETSY_STATE_TO_LISTING_STATUS.expired).toBe('ENDED')
    expect(ETSY_STATE_TO_LISTING_STATUS.removed).toBe('ENDED')
  })
})

describe('P4.6f — the sweep', () => {
  it('🔴 asks for ALL SIX states — asking once would only ever see the healthy ones', () => {
    // getListingsByShop takes one state per call and has no "all"; its DEFAULT is `active`, so a
    // single call would never notice the listing that went `expired`.
    return refreshEtsyContent().then(() => {
      for (const state of ETSY_LISTING_STATES) {
        expect(h.gets.some((p) => p.includes(`state=${state}`))).toBe(true)
      }
      expect(h.gets[0]).toBe('/shops/42/listings?state=active&limit=100&offset=0')
    })
  })

  it('a matched listing is freshened, and a changed status is counted', async () => {
    h.answers.set('expired', { results: [{ listing_id: 700, state: 'expired' }] })
    const report = await refreshEtsyContent()
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].data.listingStatus).toBe('ENDED')
    expect(h.updates[0].data.lastSyncedAt).toBeInstanceOf(Date)
    expect(h.updates[0].data.lastSyncStatus).toBe('SUCCESS')
    expect(report).toMatchObject({ accounts: 1, listingsSeen: 1, matched: 1, freshened: 1, statusChanged: 1, unmatched: 0 })
  })

  it('a listing whose status has NOT changed is still freshened — the stamp is the point', async () => {
    h.answers.set('active', { results: [{ listing_id: 700, state: 'active' }] })
    const report = await refreshEtsyContent()
    expect(report).toMatchObject({ freshened: 1, statusChanged: 0 })
    expect(h.updates[0].data.lastSyncedAt).toBeInstanceOf(Date)
  })

  it('a listing Etsy has that Nexus does not is counted, not invented', async () => {
    h.answers.set('active', { results: [{ listing_id: 700, state: 'active' }] })
    h.listings = []
    const report = await refreshEtsyContent()
    expect(report).toMatchObject({ listingsSeen: 1, matched: 0, unmatched: 1, freshened: 0 })
    expect(h.updates).toEqual([])
  })

  it.each([[0], ['abc'], [null], [undefined], [-1]])('an unusable listing id (%p) is skipped', async (id) => {
    h.answers.set('active', { results: [{ listing_id: id, state: 'active' }] })
    const report = await refreshEtsyContent()
    expect(report.listingsSeen).toBe(0)
    expect(h.updates).toEqual([])
  })

  it('an account whose shop cannot be read is recorded, and the sweep carries on', async () => {
    h.connections = [{ id: 'etsy-1' }, { id: 'etsy-2' }]
    h.readerThrows = new Error('The Etsy account has no verified shop identity.')
    const report = await refreshEtsyContent()
    expect(report.accounts).toBe(2)
    expect(report.errors).toHaveLength(2)
    expect(report.errors[0].error).toContain('no verified shop identity')
  })

  it('one state failing does not lose the other five', async () => {
    h.getThrows = new Error('Etsy could not read this resource (HTTP 503).')
    const report = await refreshEtsyContent()
    expect(report.errors).toHaveLength(6)
    expect(report.errors.map((e) => e.state)).toEqual([...ETSY_LISTING_STATES])
  })

  it('the run summary names the error count, so a failed sweep does not read like a quiet one', async () => {
    h.getThrows = new Error('HTTP 503')
    await runEtsyContentRefresh()
    const { recordCronRun } = await import('../utils/cron-observability.js')
    const summary = await vi.mocked(recordCronRun).mock.results[0].value as { summary: string }
    expect(summary.summary).toContain('6 error(s)')
    expect(summary.summary).toContain('0 freshened')
  })
})

describe('P4.6f — 🔴🔴 THE RULE: Etsy never writes Nexus\'s stock or price', () => {
  it('the columns written are a CLOSED SET of exactly three', async () => {
    h.answers.set('active', { results: [{ listing_id: 700, state: 'active' }] })
    h.answers.set('sold_out', { results: [{ listing_id: 701, state: 'sold_out' }] })
    await refreshEtsyContent()
    expect(h.updates.length).toBeGreaterThan(0)
    for (const update of h.updates) {
      // Derived from the call, not spot-checked: a new field added to this write fails here.
      expect(Object.keys(update.data).sort()).toEqual(['lastSyncStatus', 'lastSyncedAt', 'listingStatus'])
    }
  })

  it('none of the forbidden columns appears, even when Etsy sends them', async () => {
    // Etsy's listing payload carries quantity, price, title and sku. P4.3a: none of them may
    // cross into Nexus from a channel read.
    h.answers.set('active', {
      results: [{ listing_id: 700, state: 'active', quantity: 99, price: { amount: 1, divisor: 100 }, title: 'From Etsy', sku: ['X'] }],
    })
    await refreshEtsyContent()
    const written = new Set(h.updates.flatMap((u) => Object.keys(u.data)))
    for (const forbidden of ['quantity', 'price', 'stock', 'totalStock', 'title', 'sku', 'salePrice', 'stockBuffer']) {
      expect([...written]).not.toContain(forbidden)
    }
    // POSITIVE CONTROL: the write really happened, so the absence above is a rule and not a no-op.
    expect(written).toEqual(new Set(['listingStatus', 'lastSyncedAt', 'lastSyncStatus']))
  })

  it('the match is per ACCOUNT as well as per id — listing ids are per shop', async () => {
    h.answers.set('active', { results: [{ listing_id: 700, state: 'active' }] })
    await refreshEtsyContent()
    const db = (await import('../db.js')).default as unknown as { channelListing: { findMany: ReturnType<typeof vi.fn> } }
    expect(db.channelListing.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { channel: 'ETSY', externalListingId: '700', channelConnectionId: 'etsy-1' },
    }))
  })
})
