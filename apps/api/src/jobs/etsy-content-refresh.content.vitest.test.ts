/**
 * E5a — the Etsy content refresh with its content pass: the pages carry the pass's includes; a page Etsy refuses with
 * them (400), or does not answer in time, is read once more as before and its statuses are still written; the columns
 * the job writes stay the closed set of three (p46); the run's summary names the content counts; and a direct call, or
 * the kill switch, makes no pass at all (the p46 suite is untouched). The pass itself is mocked here
 * (services/channel-drift/etsy-content-pass.vitest.test.ts covers it). Fake ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  gets: [] as string[],
  answers: new Map<string, unknown>(),
  updates: [] as Array<{ where: unknown; data: Record<string, unknown> }>,
  listings: [] as Array<{ id: string; listingStatus: string }>,
  connections: [{ id: 'etsy-1' }] as Array<{ id: string }>,
  /** path → error to throw for exactly that path. */
  failures: new Map<string, Error>(),
  updateManys: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  dbNow: new Date('2031-01-02T03:04:05.000Z'),
  // The mocked content pass.
  includes: '&includes=Inventory,Images,Translations',
  calls: [] as Array<[string, ...unknown[]]>,
  startThrows: null as Error | null,
  tally: { listings: 1, compared: 1, drifted: 1, notCompared: 2, reasons: { 'the listing ended on Etsy (expired)': 2 }, extraCalls: 3, errors: 0 } as
    { listings: number; compared: number; drifted: number; notCompared: number; reasons: Record<string, number>; extraCalls: number; errors: number },
}))
const TALLY = { listings: 1, compared: 1, drifted: 1, notCompared: 2, reasons: { 'the listing ended on Etsy (expired)': 2 }, extraCalls: 3, errors: 0 }

vi.mock('../services/connection-resolver.service.js', () => ({ listActiveConnections: vi.fn(async () => h.connections) }))
vi.mock('../db.js', () => ({
  default: {
    channelListing: {
      findMany: vi.fn(async () => h.listings),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => { h.updates.push(args); return {} }),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => { h.updateManys.push(args); return { count: 0 } }),
    },
    $queryRaw: vi.fn(async () => [{ now: h.dbNow }]),
  },
}))
vi.mock('../services/etsy/read-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/etsy/read-client.js')>()
  return {
    ...original,
    etsyReader: vi.fn(async () => ({
      shopId: '90000001',
      get: vi.fn(async (path: string) => {
        h.gets.push(path)
        const failure = h.failures.get(path)
        if (failure) throw failure
        const state = /state=([a-z_]+)/.exec(path)?.[1] ?? ''
        const offset = Number(/offset=(\d+)/.exec(path)?.[1] ?? '0')
        return offset === 0 ? (h.answers.get(state) ?? { results: [] }) : { results: [] }
      }),
    })),
  }
})
vi.mock('../services/channel-drift/etsy-content-pass.js', () => ({
  startEtsyContentPass: vi.fn(async (input: { accountId: string; at: Date }) => {
    h.calls.push(['start', input.accountId, input.at])
    if (h.startThrows) throw h.startThrows
    return {
      includes: (state: string) => (['active', 'inactive', 'sold_out', 'draft'].includes(state) ? h.includes : ''),
      collect: (row: Record<string, unknown>, state: string) => { h.calls.push(['collect', row.listing_id, state]) },
      pageWithoutContent: (state: string, ids: string[], cause?: string) => { h.calls.push(['plain', state, ids, cause]) },
      finish: async () => { h.calls.push(['finish']); return h.tally },
    }
  }),
}))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: vi.fn(async (_n: string, fn: () => Promise<unknown>) => await fn()) }))
vi.mock('../utils/logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { validate: () => true, schedule: vi.fn(() => ({ stop: () => {} })) } }))

import prisma from '../db.js'
import { EtsyReadError } from '../services/etsy/read-client.js'
import { startEtsyContentPass } from '../services/channel-drift/etsy-content-pass.js'
import { refreshEtsyContent, runEtsyContentRefresh } from './etsy-content-refresh.job.js'

const page = (state: string, includes = true) => `/shops/90000001/listings?state=${state}&limit=100&offset=0${includes ? h.includes : ''}`
const noAnswer = (errorClass: 'timeout' | 'network') => Object.assign(new Error('Etsy did not answer (GET /shops/:id/listings): timeout'), { name: 'GatewayNoAnswer', errorClass })

beforeEach(() => {
  h.gets = []; h.updates = []; h.answers = new Map(); h.failures = new Map(); h.updateManys = []; h.calls = []; h.startThrows = null
  h.tally = structuredClone(TALLY)
  h.listings = [{ id: 'cl-1', listingStatus: 'ACTIVE' }]
  h.connections = [{ id: 'etsy-1' }]
  vi.mocked(prisma.channelListing.findMany).mockImplementation((async () => h.listings) as never)
  delete process.env.NEXUS_ETSY_CONTENT_DRIFT
})
afterEach(() => { vi.clearAllMocks(); delete process.env.NEXUS_ETSY_CONTENT_DRIFT })

describe('E5a — the pages carry the content pass\'s includes', () => {
  it('the four compared states ask for the listing details; expired and removed pages stay as they were', async () => {
    await refreshEtsyContent({ content: true })
    expect(h.gets).toEqual([page('active'), page('inactive'), page('sold_out'), page('draft'), page('expired', false), page('removed', false)])
    expect(h.calls[0]).toEqual(['start', 'etsy-1', h.dbNow])
  })

  it('every matched row is handed to the pass; a row Nexus does not have is not', async () => {
    h.answers.set('active', { results: [{ listing_id: 9000000001, state: 'active' }] })
    h.answers.set('expired', { results: [{ listing_id: 9000000002, state: 'expired' }] })
    vi.mocked(prisma.channelListing.findMany).mockImplementation((async (args: { where: { externalListingId: string } }) =>
      args.where.externalListingId === '9000000001' ? h.listings : []) as never)
    const report = await refreshEtsyContent({ content: true })
    expect(h.calls.filter(call => call[0] === 'collect')).toEqual([['collect', 9000000001, 'active']])
    expect(h.calls.at(-1)).toEqual(['finish'])
    expect(report.content).toEqual(h.tally)
  })

  it('Etsy refuses the includes (400): the page is read once more as before, its statuses are written, the pass is told', async () => {
    h.answers.set('active', { results: [{ listing_id: 9000000001, state: 'active' }] })
    h.failures.set(page('active'), new EtsyReadError(400))
    const report = await refreshEtsyContent({ content: true })
    expect(h.gets.slice(0, 2)).toEqual([page('active'), page('active', false)])
    expect(h.calls).toContainEqual(['plain', 'active', ['9000000001'], 'refused'])
    expect(h.updates.map((u) => u.data)).toEqual([{ listingStatus: 'ACTIVE', lastSyncedAt: h.dbNow, lastSyncStatus: 'SUCCESS' }])
    expect(report.errors).toEqual([])
    expect(h.updateManys.filter((u) => u.data.lastSyncStatus === 'FAILED')).toEqual([])
  })

  it('Etsy does not answer the heavier page in time: read once more as before, the pass is told why', async () => {
    h.answers.set('draft', { results: [{ listing_id: 9000000001, state: 'draft' }] })
    h.failures.set(page('draft'), noAnswer('timeout'))
    const report = await refreshEtsyContent({ content: true })
    expect(h.gets.filter((path) => path.includes('state=draft'))).toEqual([page('draft'), page('draft', false)])
    expect(h.calls).toContainEqual(['plain', 'draft', ['9000000001'], 'timeout'])
    expect(report.errors).toEqual([])
  })

  // E5a review M3 — ANY failure of a page WITH the includes: read once more as before, so the statuses are never lost to
  // the content read; the pass is told (a refusal stops the includes for the run; the rest skip that page's content).
  it.each([
    ['400', () => new EtsyReadError(400), 'refused'],
    ['422', () => new EtsyReadError(422), 'refused'],
    ['429', () => new EtsyReadError(429), 'failed'],
    ['500', () => new EtsyReadError(500), 'failed'],
    ['503', () => new EtsyReadError(503), 'failed'],
    ['a network drop', () => noAnswer('network'), 'failed'],
    ['a timeout', () => noAnswer('timeout'), 'timeout'],
    ['an unexpected error', () => new Error('socket hang up'), 'failed'],
  ])('an includes page fails with %s: read once more as before, statuses written, the pass told (%s)', async (_name, failure, cause) => {
    h.answers.set('active', { results: [{ listing_id: 9000000001, state: 'active' }] })
    h.failures.set(page('active'), failure())
    const report = await refreshEtsyContent({ content: true })
    expect(h.gets.filter((path) => path.includes('state=active'))).toEqual([page('active'), page('active', false)])
    expect(h.calls).toContainEqual(['plain', 'active', ['9000000001'], cause])
    expect(h.updates.map((u) => u.data)).toEqual([{ listingStatus: 'ACTIVE', lastSyncedAt: h.dbNow, lastSyncStatus: 'SUCCESS' }])
    expect(report.errors).toEqual([])
    expect(h.updateManys.filter((u) => u.data.lastSyncStatus === 'FAILED')).toEqual([])
  })

  it('the plain re-read failing too, or a page without includes failing, is handled as it always was: the state fails', async () => {
    h.failures.set(page('active'), new EtsyReadError(503))
    h.failures.set(page('active', false), new EtsyReadError(503))
    h.failures.set(page('expired', false), new EtsyReadError(503))
    const report = await refreshEtsyContent({ content: true })
    expect(h.gets.filter((path) => path.includes('state=active') || path.includes('state=expired'))).toEqual([page('active'), page('active', false), page('expired', false)])
    expect(report.errors.map((e) => e.state)).toEqual(['active', 'expired'])
    expect(h.calls.filter(call => call[0] === 'plain')).toEqual([])
  })

  it('🔴 the columns written stay the CLOSED SET of three, with the pass running', async () => {
    h.answers.set('active', { results: [{ listing_id: 9000000001, state: 'active', quantity: 99, price: { amount: 1, divisor: 100 }, title: 'From Etsy',
      inventory: { products: [] }, images: [], translations: [] }] })
    await refreshEtsyContent({ content: true })
    expect(h.updates.length).toBeGreaterThan(0)
    for (const update of h.updates) expect(Object.keys(update.data).sort()).toEqual(['lastSyncStatus', 'lastSyncedAt', 'listingStatus'])
  })

  it('a pass that cannot start never takes the status sweep down', async () => {
    h.answers.set('active', { results: [{ listing_id: 9000000001, state: 'active' }] })
    h.startThrows = new Error('module failed to load: boom')
    const report = await refreshEtsyContent({ content: true })
    expect(h.gets).toEqual(['active', 'inactive', 'sold_out', 'draft', 'expired', 'removed'].map((state) => page(state, false)))
    expect(h.updates).toHaveLength(1)
    expect(report.errors).toEqual([])
    expect(report.content).toMatchObject({ errors: 1, reasons: { 'the content pass could not start': 1 } })
    expect(report.contentSkipped).toEqual([{ accountId: 'etsy-1', reason: 'the content pass could not start' }])
  })
})

describe('E5a — on for the cron, off for a direct call, and a kill switch', () => {
  it('refreshEtsyContent() without options makes no pass: the pages are exactly as before', async () => {
    const report = await refreshEtsyContent()
    expect(startEtsyContentPass).not.toHaveBeenCalled()
    expect(h.gets[0]).toBe('/shops/90000001/listings?state=active&limit=100&offset=0')
    expect(report.content).toEqual({ listings: 0, compared: 0, drifted: 0, notCompared: 0, reasons: {}, extraCalls: 0, errors: 0 })
  })

  it('the cron runs the pass, and its summary names the content counts', async () => {
    await runEtsyContentRefresh()
    expect(startEtsyContentPass).toHaveBeenCalledTimes(1)
    const { recordCronRun } = await import('../utils/cron-observability.js')
    const summary = await vi.mocked(recordCronRun).mock.results[0].value as { summary: string }
    expect(summary.summary).toContain(' · content: 1 compared, 1 differ, 2 not compared, 3 extra Etsy call(s), 0 content error(s)')
  })

  // E5a review R2-2 — a pass that did not run is named, never read as "nothing to compare".
  it('a pass that did not run (another holds the account\'s lease) is named in the summary; an account with nothing to compare is not', async () => {
    const { recordCronRun } = await import('../utils/cron-observability.js')
    h.tally = { listings: 0, compared: 0, drifted: 0, notCompared: 0, reasons: { 'a content pass of this Etsy account is already running': 1 }, extraCalls: 0, errors: 0 }
    const report = await runEtsyContentRefresh()
    expect(report.contentSkipped).toEqual([{ accountId: 'etsy-1', reason: 'a content pass of this Etsy account is already running' }])
    const skipped = await vi.mocked(recordCronRun).mock.results[0].value as { summary: string }
    expect(skipped.summary).toContain(' · content pass skipped (1 account(s)): a content pass of this Etsy account is already running')
    h.tally = { listings: 0, compared: 0, drifted: 0, notCompared: 0, reasons: {}, extraCalls: 0, errors: 0 }
    const quiet = await runEtsyContentRefresh()
    expect(quiet.contentSkipped).toEqual([])
    const nothing = await vi.mocked(recordCronRun).mock.results[1].value as { summary: string }
    expect(nothing.summary).not.toContain('skipped')
  })

  it('NEXUS_ETSY_CONTENT_DRIFT=0 turns it off', async () => {
    process.env.NEXUS_ETSY_CONTENT_DRIFT = '0'
    await runEtsyContentRefresh()
    expect(startEtsyContentPass).not.toHaveBeenCalled()
    expect(h.gets.every((path) => !path.includes('includes='))).toBe(true)
  })

  it('an account whose reader cannot be made gets no pass', async () => {
    const { etsyReader } = await import('../services/etsy/read-client.js')
    vi.mocked(etsyReader).mockRejectedValueOnce(new Error('The Etsy account has no verified shop identity.'))
    await refreshEtsyContent({ content: true })
    expect(startEtsyContentPass).not.toHaveBeenCalled()
  })
})
