/**
 * Google Ads changes (2026-10-15) — the change tools as the approval gate uses them (Google, the account and the live
 * reads are stand-ins): the preview is built on Google's check (validate_only) and says what spends money; a change Google
 * would refuse is never queued; the gate's re-check reads again without asking Google to check twice; a run happens only
 * as an approved request, only when nothing it stands on moved, as ONE request with validateOnly false; undo puts back
 * what the change did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  live: { campaigns: [] as unknown[], budgets: [] as unknown[], lists: [] as unknown[] },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveCampaigns: vi.fn(async () => structuredClone(h.live.campaigns)),
  liveBudgets: vi.fn(async () => structuredClone(h.live.budgets)),
  liveNegativeLists: vi.fn(async () => structuredClone(h.live.lists)),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { GOOGLE_ADS_CHANGE_TOOLS } from './google-ads-change.tools.js'
import { GoogleAdsWriteError } from '../../marketing/google-ads/write-client.js'
import { localFailure } from '../../marketing/google-ads/errors.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_CHANGE_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })

const C1 = { campaignId: '21', name: 'Shop A', status: 'PAUSED', servingStatus: null, primaryStatus: null, type: 'SHOPPING', subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: { budgetId: '12', name: null, amountCents: 1500, shared: false } }
const C3 = { ...C1, campaignId: '23', name: 'Search B', type: 'SEARCH', status: 'ENABLED', budget: { budgetId: '13', name: null, amountCents: 700, shared: false } }

beforeEach(() => {
  h.mutate.mockReset()
  h.enqueue.mockClear()
  vi.unstubAllEnvs()
  h.live.campaigns = [C1, C3]
  h.live.budgets = [
    { budgetId: '12', name: null, amountCents: 1500, shared: false, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 1, campaigns: [{ campaignId: '21', name: C1.name, status: 'PAUSED' }] },
    { budgetId: '13', name: null, amountCents: 700, shared: false, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 1, campaigns: [{ campaignId: '23', name: C3.name, status: 'ENABLED' }] },
  ]
  h.live.lists = [{ listId: '31', name: 'Negativi', keywordCount: 1, campaigns: [], keywords: [{ criterionId: '401', text: 'gratis', matchType: 'PHRASE' }] }]
})

describe('set-google-budget', () => {
  const ask = { create: { name: 'Shared C', budgetCents: 1500 }, campaigns: [{ campaignId: '21', budgetId: 'new' }, { campaignId: '23', budgetId: 'new' }] }

  it('is a Nexus change a person approves: alwaysAsk, ask at most, reaches Google, its re-check fields declared', () => {
    for (const t of GOOGLE_ADS_CHANGE_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
    }
  })

  it('preview: Google checks it (validateOnly) and it says what spends money', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 3, requestId: null })
    const out = await tool('set-google-budget').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    expect(h.mutate.mock.calls[0][1]).toHaveLength(3)
    expect(out.preview).toMatchObject({
      spendsMoney: true,
      spendsMoneyBecause: [
        'Gives "Search B" a bigger daily budget: EUR 7.00 → EUR 15.00.',
        'In all, the daily budgets of the enabled campaigns rise from EUR 7.00 to EUR 15.00.',
      ],
      warnings: [
        'SPENDS MONEY (your decision): Gives "Search B" a bigger daily budget: EUR 7.00 → EUR 15.00.',
        'SPENDS MONEY (your decision): In all, the daily budgets of the enabled campaigns rise from EUR 7.00 to EUR 15.00.',
      ],
      googleCheck: { checked: true, accepted: true },
      reach: { mode: 'live', accountId: 'g-1', customerId: '1234567890' },
      operations: 3,
      account: { currency: 'EUR' },
    })
  })

  it('a change Google would refuse is never queued: the answer says why', async () => {
    h.mutate.mockRejectedValue(new GoogleAdsWriteError({ ...localFailure('x', 'X'), errors: [{ group: 'campaignBudgetError', code: 'NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT', message: 'A money amount was not a multiple of a minimum unit.', path: 'mutate_operations[0].campaign_budget_operation.create.amount_micros' }] }, 'ads.mutate.check', 'refused', 3))
    const out = await tool('set-google-budget').handler(ask, asker)
    expect(out).toEqual({ ok: false, error: 'Not queued: Google Ads refused it: A money amount was not a multiple of a minimum unit. (at mutate_operations[0].campaign_budget_operation.create.amount_micros). Nothing was changed.' })
  })

  it('the gate\'s re-check reads again but does not ask Google to check twice; the facts compare equal', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 3, requestId: null })
    const first = await tool('set-google-budget').handler(ask, asker)
    h.mutate.mockClear()
    const again = await tool('set-google-budget').handler(ask, recheck)
    expect(h.mutate).not.toHaveBeenCalled()
    const pick = (p: unknown) => { const { basis, plan, reach } = p as Record<string, unknown>; return { basis, plan, reach } }
    expect(pick(again.preview)).toEqual(pick(first.preview))
  })

  it('runs only as an approved request, as ONE request with validateOnly false; the record has Google\'s new id', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 3, requestId: null })
    const preview = (await tool('set-google-budget').handler(ask, asker)).preview
    expect((await tool('set-google-budget').execute!(ask, asker)).error).toMatch(/runs only as an approved request/)
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{ campaignBudgetResult: { resourceName: 'customers/1234567890/campaignBudgets/99' } }, {}, {}], ops: 3, requestId: 'r' })
    const run = await tool('set-google-budget').execute!(ask, approved(preview))
    expect(run.ok).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][2]).toMatchObject({ validateOnly: false })
    const account = { accountId: 'g-1', customerId: '1234567890' }
    expect(run.change).toEqual({
      before: { amounts: [], campaigns: [{ campaignId: '21', budgetId: '12' }, { campaignId: '23', budgetId: '13' }], ...account },
      after: { amounts: [], campaigns: [{ campaignId: '21', budgetId: '99' }, { campaignId: '23', budgetId: '99' }], createdBudgetId: '99', ...account },
    })
    expect(h.enqueue).toHaveBeenCalledWith({ customerId: '1234567890', kind: 'MANUAL' })
    // Undo moves the campaigns back to their own budgets, through the same tool.
    const undo = tool('set-google-budget').undo!.request(run.change!)
    expect(undo).toMatchObject({ tool: 'set-google-budget', args: { accountId: 'g-1', campaigns: [{ campaignId: '21', budgetId: '12' }, { campaignId: '23', budgetId: '13' }] } })
    expect(tool('set-google-budget').input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })

  it('never by a rule: a run the business\'s rule decided is refused before anything is sent', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 3, requestId: null })
    const preview = (await tool('set-google-budget').handler(ask, asker)).preview
    h.mutate.mockClear()
    const byRule = await tool('set-google-budget').execute!(ask, { ...approved(preview), approvedByPerson: false, decidedVia: 'auto' })
    expect(byRule.error).toMatch(/only when a person approved it, never by a rule/)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('Google did not confirm: "Not confirmed", never "Not run"', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 3, requestId: null })
    const preview = (await tool('set-google-budget').handler(ask, asker)).preview
    h.mutate.mockReset()
    h.mutate.mockRejectedValue(new GoogleAdsWriteError({ ...localFailure('x', 'TIMEOUT') }, 'ads.mutate', 'unknown', 3))
    const run = await tool('set-google-budget').execute!(ask, approved(preview))
    expect(run.error).toBe('Not confirmed: x')
  })

  it('not sent when the account moved since it was approved', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 3, requestId: null })
    const preview = (await tool('set-google-budget').handler(ask, asker)).preview
    ;(h.live.campaigns[1] as typeof C3).budget = { ...C3.budget, amountCents: 900 }
    ;(h.live.budgets[1] as { amountCents: number }).amountCents = 900
    h.mutate.mockClear()
    const run = await tool('set-google-budget').execute!(ask, approved(preview))
    expect(run.ok).toBe(false)
    expect(run.error).toMatch(/changed since this was approved/)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('writes switched off: the preview says it is not sent, the run refuses', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', 'off')
    h.mutate.mockResolvedValue({ responses: [], ops: 3, requestId: null })
    const preview = (await tool('set-google-budget').handler(ask, asker)).preview as { warnings: string[]; reach: { mode: string } }
    expect(preview.reach.mode).toBe('off')
    expect(preview.warnings).toContain('Google Ads writes are switched off in Nexus (NEXUS_GOOGLE_ADS_WRITES=off): after approval this change is NOT sent to Google.')
    h.mutate.mockClear()
    const run = await tool('set-google-budget').execute!(ask, approved(preview))
    expect(run.error).toMatch(/switched off/)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})

describe('set-google-negative-list', () => {
  it('adds and attaches in one request; undo removes and detaches what it did', async () => {
    const ask = { listId: '31', addKeywords: [{ text: 'cheap', matchType: 'PHRASE' }], attachCampaignIds: ['21'] }
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const preview = (await tool('set-google-negative-list').handler(ask, asker)).preview
    expect(preview).toMatchObject({ spendsMoney: false, operations: 2, totals: { keywordsAdded: 1, campaignsAttached: 1 } })
    h.mutate.mockResolvedValue({ responses: [{}, {}], ops: 2, requestId: null })
    const run = await tool('set-google-negative-list').execute!(ask, approved(preview))
    expect(run.change?.after).toEqual({ listId: '31', added: [{ text: 'cheap', matchType: 'PHRASE' }], removed: [], attached: ['21'], detached: [], accountId: 'g-1', customerId: '1234567890' })
    // Now the list holds the keyword and is on C1: nothing moved since, so undo may run.
    h.live.lists = [{ listId: '31', name: 'Negativi', keywordCount: 2, campaigns: [{ campaignId: '21', name: C1.name, status: 'PAUSED' }], keywords: [{ criterionId: '401', text: 'gratis', matchType: 'PHRASE' }, { criterionId: '402', text: 'cheap', matchType: 'PHRASE' }] }]
    expect(await tool('set-google-negative-list').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-negative-list').undo!.request(run.change!)
    expect(undo).toMatchObject({ tool: 'set-google-negative-list', args: { listId: '31', removeKeywords: [{ text: 'cheap', matchType: 'PHRASE' }], detachCampaignIds: ['21'] } })
  })
})
