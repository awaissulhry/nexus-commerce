/**
 * 1a — a campaign-manager edit really reaches Amazon (CM-1, CM-2, CM-3, CM-4, CM-5, CM-23).
 *
 * Each arm runs the real enqueue (`update*WithSync`: local row, queue row, typed AdMutation rows, action log) and the
 * real drain/worker, and pins what the worker hands the Amazon client and how the rows settle:
 *   CM-1  a bidding-strategy change is sent, with the placement lanes Amazon holds (read first); none read, none sent.
 *   CM-2  an end date is sent as YYYY-MM-DD; "never expire" is sent as `endDate: null`.
 *   CM-3  "no portfolio" is sent as `portfolioId: null`; a portfolio move is not valued as money by the value cap.
 *   CM-4  rename and portfolio moves are drained, reclaimed after a crash, and expire (never sent) when a day old.
 *   CM-5  a retry waits for its backoff; a newer write to the same field supersedes an older one, which is never sent.
 *   CM-23 a portfolio write reports Amazon's refusal; the Portfolios screen path writes nothing locally on one.
 *
 * PGlite with the production schema. The gate is a stand-in that records its input and allows (mode live); the Amazon
 * client is a recorder with programmable answers. Nothing leaves the process. All ids are made up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import type { GateContext, GateDecision } from '../services/advertising/ads-write-gate.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../services/outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
// Nothing here may open a Redis connection; the enqueue's BullMQ add is best-effort and the drain does the work.
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
const gate = vi.hoisted(() => ({ seen: [] as GateContext[], valueCap: false }))
vi.mock('../services/advertising/ads-write-gate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/advertising/ads-write-gate.js')>()
  return {
    ...real,
    checkAdsWriteGate: async (ctx: GateContext): Promise<GateDecision> => {
      gate.seen.push(ctx)
      // W4-12b — the real gate's value-cap number, with its comparison, where a test asks for it.
      if (gate.valueCap && ctx.payloadValueCents > real.maxWriteValueCents()) {
        return { allowed: false, reason: `payload value ${ctx.payloadValueCents}¢ exceeds cap ${real.maxWriteValueCents()}¢`, deniedAt: 'value_cap' }
      }
      return { allowed: true, mode: 'live', profileId: 'P-TEST' }
    },
    logGateDeny: () => undefined,
    recordSuccessfulWrite: async () => undefined,
    recordCampaignLiveWrite: async () => undefined,
  }
})
type Answer = { ok: boolean; rawResponse?: unknown; error?: string | null }
const amazon = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; externalId: string; patch: Record<string, unknown> }>,
  reads: [] as string[][],
  answers: [] as Answer[],
  campaignsV3: [] as Array<Record<string, unknown>>,
}))
vi.mock('../services/advertising/ads-api-client.js', () => {
  const record = (fn: string) => async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
    amazon.calls.push({ fn, externalId, patch })
    return amazon.answers.shift() ?? { ok: true, rawResponse: {}, error: null }
  }
  return {
    adsMode: () => 'live',
    updateCampaign: record('updateCampaign'),
    updateAdGroup: record('updateAdGroup'),
    updateTarget: record('updateTarget'),
    updateProductAd: record('updateProductAd'),
    updatePortfolio: async (_ctx: unknown, input: { portfolioId: string } & Record<string, unknown>) => {
      amazon.calls.push({ fn: 'updatePortfolio', externalId: input.portfolioId, patch: input })
      return { mode: 'live', ...(amazon.answers.shift() ?? { ok: true, rawResponse: {}, error: null }) }
    },
    listCampaignsV3: async (_ctx: unknown, opts?: { campaignIds?: string[] }) => {
      amazon.reads.push(opts?.campaignIds ?? [])
      return amazon.campaignsV3
    },
  }
})

const { drainAdsSyncOnce, reclaimCrashedAdWrites, expireStalePendingAdWrites } = await import('./ads-sync.worker.js')
const { updateCampaignWithSync, updatePortfolioWithSync } = await import('../services/advertising/ads-mutation.service.js')
const { updatePortfolioById } = await import('../services/advertising/ads-portfolio.service.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const USER = 'user:wr-test' as const
const PORTFOLIO_A = '111122223333444' // Amazon portfolio ids are long numbers; this one is made up
const PORTFOLIO_B = '555566667777888'
const tick = () => new Promise((r) => setTimeout(r, 5))

async function drain() {
  const out = await inside(() => drainAdsSyncOnce(50))
  const rows = await inside(() => database.client.outboundSyncQueue.findMany({
    where: { id: { in: out.results.map((r) => r.queueId) } },
    select: { id: true, syncStatus: true, errorCode: true, errorMessage: true, nextRetryAt: true, retryCount: true },
  }))
  return { out, rows }
}
const queueRow = (id: string) => inside(() => database.client.outboundSyncQueue.findUniqueOrThrow({ where: { id } }))
const mutations = (queueId: string) => inside(() => database.client.adMutation.findMany({
  where: { outboundQueueId: queueId }, select: { field: true, state: true }, orderBy: { field: 'asc' },
}))
async function edit(campaignId: string, patch: Parameters<typeof updateCampaignWithSync>[0]['patch']): Promise<string> {
  const r = await inside(() => updateCampaignWithSync({ campaignId, patch, actor: USER, applyImmediately: true }))
  expect(r.ok, r.error ?? '').toBe(true)
  return r.outboundQueueId!
}

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    const campaign = (id: string, extra: Record<string, unknown> = {}) => db.campaign.create({
      data: {
        id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`,
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra,
      } as never,
    })
    for (const id of ['wr-strat', 'wr-strat-unread', 'wr-strat-nolanes', 'wr-name', 'wr-retry', 'wr-sup', 'wr-race', 'wr-part', 'wr-crash', 'wr-stale']) await campaign(id)
    await campaign('wr-end', { endDate: new Date('2026-11-30T00:00:00Z') })
    await campaign('wr-pf', { portfolioId: PORTFOLIO_A })
    await db.amazonAdsConnection.create({ data: { profileId: 'P-TEST', marketplace: 'IT', mode: 'production', isActive: true } as never })
    await db.amazonAdsPortfolio.create({ data: { id: 'wr-port', profileId: 'P-TEST', externalPortfolioId: PORTFOLIO_B, name: 'Core' } as never })
  })
}, 180_000)
afterAll(async () => { await database?.close() })
beforeEach(() => { gate.seen = []; gate.valueCap = false; amazon.calls = []; amazon.reads = []; amazon.answers = []; amazon.campaignsV3 = [] })

describe('CM-1 — bidding strategy', () => {
  it('is sent, with the placement lanes Amazon holds now (read first), so the lanes are not reset', async () => {
    amazon.campaignsV3 = [{ campaignId: 'EXT-wr-strat', dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 35 }] } }]
    const q = await edit('wr-strat', { biddingStrategy: 'AUTO_FOR_SALES' })
    const { rows } = await drain()
    expect(amazon.reads).toEqual([['EXT-wr-strat']])
    // Before 1a the worker sent `{}` — an empty PUT — and marked it a success.
    expect(amazon.calls).toEqual([{
      fn: 'updateCampaign', externalId: 'EXT-wr-strat',
      patch: { biddingStrategy: 'autoForSales', placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 35 }] },
    }])
    expect(rows.find((r) => r.id === q)?.syncStatus).toBe('SUCCESS')
  })

  it('when Amazon holds no lanes, the strategy goes alone', async () => {
    amazon.campaignsV3 = [{ campaignId: 'EXT-wr-strat-nolanes', dynamicBidding: { strategy: 'LEGACY_FOR_SALES' } }]
    await edit('wr-strat-nolanes', { biddingStrategy: 'AUTO_FOR_SALES' })
    await drain()
    expect(amazon.calls.map((c) => c.patch)).toEqual([{ biddingStrategy: 'autoForSales' }])
  })

  it('when Amazon\'s lanes cannot be read, nothing is sent and the write is retried later', async () => {
    amazon.campaignsV3 = [] // Amazon did not return the campaign
    const q = await edit('wr-strat-unread', { biddingStrategy: 'MANUAL' })
    const { rows } = await drain()
    expect(amazon.calls).toEqual([])
    const row = rows.find((r) => r.id === q)!
    expect(row).toMatchObject({ syncStatus: 'PENDING', retryCount: 1 })
    expect(row.nextRetryAt!.getTime()).toBeGreaterThan(Date.now())
    expect(row.errorMessage).toMatch(/bidding strategy not sent/)
    // Out of the way of the arms below, which sweep every PENDING row.
    await inside(() => database.client.outboundSyncQueue.update({ where: { id: q }, data: { syncStatus: 'CANCELLED' } }))
  })
})

describe('CM-2 — end date', () => {
  it('a new end date is sent as YYYY-MM-DD', async () => {
    await edit('wr-end', { endDate: new Date('2026-12-31') })
    await drain()
    expect(amazon.calls).toEqual([{ fn: 'updateCampaign', externalId: 'EXT-wr-end', patch: { endDate: '2026-12-31' } }])
  })

  it('"never expire" (a cleared end date) is sent as endDate: null, not dropped', async () => {
    await edit('wr-end', { endDate: null })
    await drain()
    expect(amazon.calls).toEqual([{ fn: 'updateCampaign', externalId: 'EXT-wr-end', patch: { endDate: null } }])
  })
})

describe('CM-3 / CM-4 — portfolio moves and renames are drained and sent', () => {
  it('a portfolio move is sent, and the value cap does not read the portfolio id as money', async () => {
    const q = await edit('wr-pf', { portfolioId: PORTFOLIO_B })
    expect((await queueRow(q)).syncType).toBe('AD_CAMPAIGN_PORTFOLIO_UPDATE')
    const { out, rows } = await drain()
    // Before 1a this type was not in the drain list: processed 0, row PENDING for good.
    expect(out.results.map((r) => r.queueId)).toContain(q)
    expect(amazon.calls).toEqual([{ fn: 'updateCampaign', externalId: 'EXT-wr-pf', patch: { portfolioId: PORTFOLIO_B } }])
    expect(gate.seen.map((c) => c.payloadValueCents)).toEqual([0])
    expect(rows.find((r) => r.id === q)?.syncStatus).toBe('SUCCESS')
  })

  it('"no portfolio" (a cleared portfolio) is sent as portfolioId: null, not dropped', async () => {
    await edit('wr-pf', { portfolioId: null })
    await drain()
    expect(amazon.calls).toEqual([{ fn: 'updateCampaign', externalId: 'EXT-wr-pf', patch: { portfolioId: null } }])
  })

  it('a rename is drained and sent', async () => {
    const q = await edit('wr-name', { name: 'wr-name renamed' })
    expect((await queueRow(q)).syncType).toBe('AD_CAMPAIGN_NAME_UPDATE')
    const { rows } = await drain()
    expect(amazon.calls).toEqual([{ fn: 'updateCampaign', externalId: 'EXT-wr-name', patch: { name: 'wr-name renamed' } }])
    expect(rows.find((r) => r.id === q)?.syncStatus).toBe('SUCCESS')
  })

  it('a rename stuck IN_PROGRESS by a crash is reclaimed, then sent', async () => {
    const q = await edit('wr-crash', { name: 'wr-crash renamed' })
    await inside(() => database.client.outboundSyncQueue.update({ where: { id: q }, data: { syncStatus: 'IN_PROGRESS' } }))
    const swept = await inside(() => reclaimCrashedAdWrites(new Date(Date.now() + 31 * 60_000)))
    expect(swept.reclaimed).toBe(1)
    await drain()
    expect(amazon.calls).toEqual([{ fn: 'updateCampaign', externalId: 'EXT-wr-crash', patch: { name: 'wr-crash renamed' } }])
  })

  it('a write still PENDING a day after it was queued is dead-lettered, never sent', async () => {
    const q = await edit('wr-stale', { name: 'wr-stale renamed' })
    const expired = await inside(() => expireStalePendingAdWrites(new Date(Date.now() + 25 * 60 * 60_000)))
    expect(expired).toBe(1)
    expect(await queueRow(q)).toMatchObject({ syncStatus: 'FAILED', isDead: true, errorCode: 'ADS_STALE_PENDING' })
    expect(await mutations(q)).toEqual([{ field: 'name', state: 'FAILED' }])
    await drain()
    expect(amazon.calls).toEqual([])
  })
})

describe('CM-5 — retries wait, and a newer write wins', () => {
  it('a retryable failure waits for nextRetryAt; the drain does not resend it the next minute', async () => {
    amazon.answers = [{ ok: false, error: 'HTTP 429 Too Many Requests' }]
    const q = await edit('wr-retry', { dailyBudget: 31 })
    await drain()
    expect(amazon.calls).toHaveLength(1)
    expect(await queueRow(q)).toMatchObject({ syncStatus: 'PENDING', retryCount: 1 })

    amazon.calls = []
    const again = await drain()
    expect(again.out.results.map((r) => r.queueId)).not.toContain(q)
    expect(amazon.calls).toEqual([])

    await inside(() => database.client.outboundSyncQueue.update({ where: { id: q }, data: { nextRetryAt: new Date(Date.now() - 1_000) } }))
    await drain()
    expect(amazon.calls).toEqual([{ fn: 'updateCampaign', externalId: 'EXT-wr-retry', patch: { dailyBudget: 31 } }])
    expect((await queueRow(q)).syncStatus).toBe('SUCCESS')
  })

  it('two queued writes to one field: only the newer is sent; the older is superseded, visibly', async () => {
    const older = await edit('wr-sup', { dailyBudget: 30 })
    await tick()
    const newer = await edit('wr-sup', { dailyBudget: 40 })
    await drain()
    expect(amazon.calls).toEqual([{ fn: 'updateCampaign', externalId: 'EXT-wr-sup', patch: { dailyBudget: 40 } }])
    expect(await queueRow(older)).toMatchObject({ syncStatus: 'CANCELLED', errorCode: 'ADS_SUPERSEDED' })
    expect(await mutations(older)).toEqual([{ field: 'dailyBudget', state: 'SUPERSEDED' }])
    expect(await mutations(newer)).toEqual([{ field: 'dailyBudget', state: 'APPLIED' }])
    const log = await inside(() => database.client.advertisingActionLog.findFirst({ where: { outboundQueueId: older }, select: { amazonResponseStatus: true } }))
    expect(log?.amazonResponseStatus).toBe('SUPERSEDED')
  })

  it('an older write that failed and comes back after a newer one landed is not resent over it', async () => {
    amazon.answers = [{ ok: false, error: 'HTTP 503 Service Unavailable' }]
    const older = await edit('wr-race', { dailyBudget: 50 })
    await drain() // fails, waits for its backoff
    await tick()
    const newer = await edit('wr-race', { dailyBudget: 60 })
    await drain() // the newer one lands
    expect((await queueRow(newer)).syncStatus).toBe('SUCCESS')

    amazon.calls = []
    await inside(() => database.client.outboundSyncQueue.update({ where: { id: older }, data: { nextRetryAt: new Date(Date.now() - 1_000) } }))
    await drain()
    // Before 1a the older €50 went out here, and Amazon ended on it while Nexus showed €60.
    expect(amazon.calls).toEqual([])
    expect(await queueRow(older)).toMatchObject({ syncStatus: 'CANCELLED', errorCode: 'ADS_SUPERSEDED' })
  })

  it('only the replaced field is held back; the other fields of the older write still go', async () => {
    const older = await edit('wr-part', { dailyBudget: 70, status: 'PAUSED' })
    await tick()
    await edit('wr-part', { dailyBudget: 80 })
    await drain()
    expect(amazon.calls.map((c) => c.patch)).toEqual([{ state: 'paused' }, { dailyBudget: 80 }])
    expect(await mutations(older)).toEqual([{ field: 'dailyBudget', state: 'SUPERSEDED' }, { field: 'status', state: 'APPLIED' }])
    expect((await queueRow(older)).syncStatus).toBe('SUCCESS')
  })
})

describe('CM-23 — portfolio writes read Amazon\'s answer', () => {
  it('a queued portfolio write reaches the client (not refused as "unattributable") and Amazon\'s refusal fails it', async () => {
    const r = await inside(() => updatePortfolioWithSync({ portfolioId: 'wr-port', patch: { name: 'Core 2' }, actor: USER, applyImmediately: true }))
    expect(r.ok).toBe(true)
    amazon.answers = [{ ok: false, error: 'amazon_rejected: [{"errorType":"INVALID_ARGUMENT"}]' }]
    const { rows } = await drain()
    // A portfolio is not a campaign: the gate is asked without one (it used to get null and refuse every one in live mode).
    expect(gate.seen).toHaveLength(1)
    expect(gate.seen[0]!.campaignId).toBeUndefined()
    expect(amazon.calls.map((c) => [c.fn, c.externalId, c.patch.name])).toEqual([['updatePortfolio', PORTFOLIO_B, 'Core 2']])
    // Before 1a: SUCCESS, whatever Amazon said.
    expect(rows.find((x) => x.id === r.outboundQueueId)).toMatchObject({ syncStatus: 'FAILED' })
    expect(rows.find((x) => x.id === r.outboundQueueId)?.errorMessage).toMatch(/amazon_rejected/)
  })

  it('the Portfolios screen path: Amazon refuses → the caller gets the reason and Nexus keeps the old name', async () => {
    await inside(() => database.client.amazonAdsPortfolio.update({ where: { id: 'wr-port' }, data: { name: 'Core' } }))
    amazon.answers = [{ ok: false, error: 'amazon_rejected: [{"errorType":"DUPLICATE_NAME"}]' }]
    const r = await inside(() => updatePortfolioById({ portfolioId: PORTFOLIO_B, name: 'Core 3' }))
    expect(r).toMatchObject({ ok: false, mode: 'live' })
    expect(r.error).toMatch(/DUPLICATE_NAME/)
    const row = await inside(() => database.client.amazonAdsPortfolio.findUniqueOrThrow({ where: { id: 'wr-port' }, select: { name: true } }))
    expect(row.name).toBe('Core')
  })
})

/**
 * W4-12b — a queued portfolio cap change (the bulk-sheet path: bulksheet/apply.ts → updatePortfolioWithSync) goes to
 * Amazon as the WHOLE cap Amazon's v3 PUT /portfolios takes ({ amount, currencyCode, policy, startDate, endDate }); a row
 * that changed only the amount used to go out as `{ amount }`, without its policy and currency.
 */
describe('W4-12b — a queued portfolio cap goes out whole', () => {
  const PF_MONTHLY = '900011112222333' // made-up Amazon portfolio ids
  const PF_RANGE = '900044445555666'
  const PF_BARE = '900077778888999'
  beforeAll(async () => {
    await inside(async () => {
      const db = database.client
      await db.amazonAdsPortfolio.create({ data: { id: 'wr-cap-m', profileId: 'P-TEST', externalPortfolioId: PF_MONTHLY, name: 'Monthly cap', budgetAmount: '100.00', budgetCurrencyCode: 'EUR', budgetPolicy: 'MONTHLY_RECURRING', startDate: new Date('2026-01-01T00:00:00Z') } as never })
      await db.amazonAdsPortfolio.create({ data: { id: 'wr-cap-d', profileId: 'P-TEST', externalPortfolioId: PF_RANGE, name: 'Range cap', budgetAmount: '200.00', budgetCurrencyCode: 'EUR', budgetPolicy: 'DATE_RANGE', startDate: new Date('2026-11-01T00:00:00Z'), endDate: new Date('2026-11-30T00:00:00Z') } as never })
      await db.amazonAdsPortfolio.create({ data: { id: 'wr-cap-none', profileId: 'P-TEST', externalPortfolioId: PF_BARE, name: 'No cap yet' } as never })
    })
  })
  const queueCap = async (portfolioId: string, patch: Parameters<typeof updatePortfolioWithSync>[0]['patch']) => {
    const r = await inside(() => updatePortfolioWithSync({ portfolioId, patch, actor: USER, reason: 'bulksheet import test', applyImmediately: true }))
    expect(r.ok, r.error ?? '').toBe(true)
    return r.outboundQueueId!
  }

  it('an amount-only change is sent with the cap\'s policy and currency (read from the portfolio)', async () => {
    const q = await queueCap('wr-cap-m', { budgetAmount: 150 })
    const { rows } = await drain()
    expect(amazon.calls).toHaveLength(1)
    // Before W4-12b: { amount: 150 } — no policy, no currency.
    expect(amazon.calls[0]!.patch.budget).toEqual({ amount: 150, currencyCode: 'EUR', policy: 'MONTHLY_RECURRING' })
    // A monthly cap carries no dates unless the write changes them (as the Portfolios page sends none).
    expect(amazon.calls[0]!.patch.budget).not.toHaveProperty('startDate')
    expect(rows.find((r) => r.id === q)?.syncStatus).toBe('SUCCESS')
  })

  it('a date-range end date alone is sent with the amount, currency, policy and start date', async () => {
    await queueCap('wr-cap-d', { endDate: '2026-12-15' })
    await drain()
    expect(amazon.calls.map((c) => c.patch.budget)).toEqual([
      { amount: 200, currencyCode: 'EUR', policy: 'DATE_RANGE', startDate: '2026-11-01', endDate: '2026-12-15' },
    ])
  })

  it('the policy as a bulk sheet spells it goes out in Amazon\'s v3 spelling', async () => {
    await queueCap('wr-cap-m', { budgetAmount: 90, budgetPolicy: 'monthlyRecurring' })
    await drain()
    expect(amazon.calls.map((c) => c.patch.budget)).toEqual([{ amount: 90, currencyCode: 'EUR', policy: 'MONTHLY_RECURRING' }])
  })

  it('a cap Nexus cannot complete (no policy anywhere) is not sent: it fails for good, saying why', async () => {
    const q = await queueCap('wr-cap-none', { budgetAmount: 60 })
    const { rows } = await drain()
    expect(amazon.calls).toEqual([])
    const row = rows.find((r) => r.id === q)!
    expect(row).toMatchObject({ syncStatus: 'FAILED', errorCode: 'AMAZON_PERMANENT_REJECTION' })
    expect(row.errorMessage).toMatch(/not sent to Amazon: Nexus holds no budget policy/)
  })

  it('a rename alone still sends no budget at all', async () => {
    await queueCap('wr-cap-m', { name: 'Monthly cap 2' })
    await drain()
    expect(amazon.calls).toHaveLength(1)
    expect(amazon.calls[0]!.patch).toMatchObject({ portfolioId: PF_MONTHLY, name: 'Monthly cap 2' })
    expect(amazon.calls[0]!.patch.budget).toBeUndefined()
  })

  it('the Portfolios page\'s own push (updatePortfolioById) is unchanged: its cap goes out exactly as it builds it', async () => {
    const r = await inside(() => updatePortfolioById({ portfolioId: PF_MONTHLY, budget: { amount: 120, currencyCode: 'EUR', policy: 'monthlyRecurring' } }))
    expect(r).toMatchObject({ ok: true, mode: 'live' })
    expect(amazon.calls.map((c) => c.patch.budget)).toEqual([{ amount: 120, currencyCode: 'EUR', policy: 'monthlyRecurring' }])
  })
})

/**
 * W4-12b — a portfolio cap is in major units (AmazonAdsPortfolio.budgetAmount, as the action log's budget fields), so the
 * write gate's value cap counts it ×100, as the Portfolios page's own push does. It was counted as cents: 100× too small.
 */
describe('W4-12b — the value cap counts a portfolio cap in minor units', () => {
  beforeAll(async () => {
    await inside(() => database.client.amazonAdsPortfolio.create({ data: { id: 'wr-cap-v', profileId: 'P-TEST', externalPortfolioId: '900012121212121', name: 'Valued cap', budgetAmount: '100.00', budgetCurrencyCode: 'EUR', budgetPolicy: 'MONTHLY_RECURRING' } as never }))
  })
  const queueAmount = async (budgetAmount: number) => {
    const r = await inside(() => updatePortfolioWithSync({ portfolioId: 'wr-cap-v', patch: { budgetAmount }, actor: USER, reason: 'bulksheet import test', applyImmediately: true }))
    expect(r.ok, r.error ?? '').toBe(true)
    return r.outboundQueueId!
  }

  it('a €3 cap is worth 300 cents to the gate', async () => {
    await queueAmount(3)
    await drain()
    expect(gate.seen.map((c) => c.payloadValueCents)).toEqual([300])
  })

  it('a €600 cap is refused by the €500 value cap, and nothing reaches Amazon (it passed as 600 cents before)', async () => {
    gate.valueCap = true
    const q = await queueAmount(600)
    const { rows } = await drain()
    expect(gate.seen.map((c) => c.payloadValueCents)).toEqual([60_000])
    expect(amazon.calls).toEqual([])
    expect(rows.find((r) => r.id === q)).toMatchObject({ syncStatus: 'SKIPPED', errorCode: 'WRITE_GATE_DENIED' })
    expect(rows.find((r) => r.id === q)?.errorMessage).toMatch(/value_cap/)
  })

  it('a €400 cap passes the same value cap and is sent', async () => {
    gate.valueCap = true
    await queueAmount(400)
    await drain()
    expect(gate.seen.map((c) => c.payloadValueCents)).toEqual([40_000])
    expect(amazon.calls.map((c) => (c.patch.budget as { amount?: number }).amount)).toEqual([400])
  })
})
