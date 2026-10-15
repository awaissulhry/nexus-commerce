/**
 * Google Ads changes (2026-10-15) — budgets and negative keyword lists, built from a request and the live state (pure):
 * the exact Google operations (temporary ids, snake_case update masks, own budgets never shared), what spends money,
 * what is skipped, what is refused before anything is sent, and the record undo reads.
 */
import { describe, expect, it } from 'vitest'
import { budgetChangeDraft, budgetRecordAfterRun, type BudgetLiveState } from './change-budgets.js'
import { listChangeDraft, type ListLiveState } from './change-lists.js'
import type { LiveCampaign } from './live.js'

const C = 'customers/1234567890'
const campaign = (campaignId: string, name: string, status: string, budget: LiveCampaign['budget']): LiveCampaign => ({
  campaignId, name, status, servingStatus: null, primaryStatus: null, type: 'SHOPPING', subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget,
})
const BUDGETS: BudgetLiveState = {
  budgets: [
    { budgetId: '11', name: 'Shared IT', amountCents: 1500, shared: true, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 1, campaigns: [{ campaignId: '21', name: 'C1', status: 'PAUSED' }] },
    { budgetId: '12', name: null, amountCents: 700, shared: false, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 1, campaigns: [{ campaignId: '22', name: 'C2', status: 'ENABLED' }] },
  ],
  campaigns: [
    campaign('21', 'C1', 'PAUSED', { budgetId: '11', name: 'Shared IT', amountCents: 1500, shared: true }),
    campaign('22', 'C2', 'ENABLED', { budgetId: '12', name: null, amountCents: 700, shared: false }),
  ],
}

describe('budgetChangeDraft', () => {
  it('a new shared budget and two campaigns on it: one request, the new budget first with a temporary id', () => {
    const d = budgetChangeDraft(C, 'EUR', { create: { name: 'Shared B', budgetCents: 1500 }, campaigns: [{ campaignId: '21', budgetId: 'new' }, { campaignId: '22', budgetId: 'new' }] }, BUDGETS)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { campaignBudgetOperation: { create: { resourceName: `${C}/campaignBudgets/-1`, name: 'Shared B', amountMicros: '15000000', explicitlyShared: true, deliveryMethod: 'STANDARD' } } },
      { campaignOperation: { update: { resourceName: `${C}/campaigns/21`, campaignBudget: `${C}/campaignBudgets/-1` }, updateMask: 'campaign_budget' } },
      { campaignOperation: { update: { resourceName: `${C}/campaigns/22`, campaignBudget: `${C}/campaignBudgets/-1` }, updateMask: 'campaign_budget' } },
    ])
    // C2 had EUR 7.00 of its own and gets EUR 15.00: a raise; C1 stays at EUR 15.00.
    expect(d.spendsMoney).toEqual([
      'Gives "C2" a bigger daily budget: EUR 7.00 → EUR 15.00.',
      'In all, the daily budgets of the enabled campaigns rise from EUR 7.00 to EUR 15.00.',
    ])
    expect(d.warnings).toEqual(['"C1" leaves the shared budget "Shared IT"; the other campaigns on it keep it.'])
    expect(d.changes['new shared budget "Shared B"']).toEqual({ from: '(none)', to: 'EUR 15.00 a day' })
    expect(d.summary).toBe('Google Ads budgets: make the shared budget "Shared B" (EUR 15.00 a day); put 2 campaigns on the budget asked.')
    expect(d.before).toEqual({ amounts: [], campaigns: [{ campaignId: '21', budgetId: '11' }, { campaignId: '22', budgetId: '12' }] })
    const after = budgetRecordAfterRun(d.after as never, [{ campaignBudgetResult: { resourceName: `${C}/campaignBudgets/99` } }, {}, {}])
    expect(after).toEqual({ amounts: [], campaigns: [{ campaignId: '21', budgetId: '99' }, { campaignId: '22', budgetId: '99' }], createdBudgetId: '99' })
  })

  it('a raise is SPENDS MONEY (with the campaigns it reaches); a cut is not; an unchanged amount is skipped', () => {
    const d = budgetChangeDraft(C, 'EUR', { amounts: [{ budgetId: '11', budgetCents: 2500 }, { budgetId: '12', budgetCents: 500 }] }, BUDGETS)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations[0]).toEqual({ campaignBudgetOperation: { update: { resourceName: `${C}/campaignBudgets/11`, amountMicros: '25000000' }, updateMask: 'amount_micros' } })
    expect(d.spendsMoney).toEqual(['Raises "Shared IT" from EUR 15.00 to EUR 25.00 a day (no campaign on it is enabled now: nothing spends until one is).'])
    const same = budgetChangeDraft(C, 'EUR', { amounts: [{ budgetId: '11', budgetCents: 1500 }] }, BUDGETS)
    expect(same).toEqual({ refusal: 'Nothing to change: "Shared IT" is already EUR 15.00 a day.' })
  })

  it('detach to a budget of its own: a new budget that is NOT shared (Google\'s default is shared), its id from its own operation', () => {
    const d = budgetChangeDraft(C, 'EUR', { campaigns: [{ campaignId: '21', ownBudgetCents: 800 }] }, BUDGETS)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations[0]).toEqual({ campaignBudgetOperation: { create: { resourceName: `${C}/campaignBudgets/-2`, amountMicros: '8000000', explicitlyShared: false, deliveryMethod: 'STANDARD' } } })
    expect(d.spendsMoney).toEqual([])
    const after = budgetRecordAfterRun(d.after as never, [{ campaignBudgetResult: { resourceName: `${C}/campaignBudgets/55` } }, {}])
    expect(after.campaigns).toEqual([{ campaignId: '21', budgetId: '55' }])
  })

  it('the whole account: an ENABLED campaign leaving a shared budget for a smaller one of its own still raises the total', () => {
    const shared: BudgetLiveState = {
      budgets: [{ budgetId: '11', name: 'Shared IT', amountCents: 10000, shared: true, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 2, campaigns: [{ campaignId: '21', name: 'C1', status: 'ENABLED' }, { campaignId: '22', name: 'C2', status: 'ENABLED' }] }],
      campaigns: [
        campaign('21', 'C1', 'ENABLED', { budgetId: '11', name: 'Shared IT', amountCents: 10000, shared: true }),
        campaign('22', 'C2', 'ENABLED', { budgetId: '11', name: 'Shared IT', amountCents: 10000, shared: true }),
      ],
    }
    const d = budgetChangeDraft(C, 'EUR', { campaigns: [{ campaignId: '21', ownBudgetCents: 5000 }] }, shared)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.spendsMoney).toEqual(['In all, the daily budgets of the enabled campaigns rise from EUR 100.00 to EUR 150.00.'])
  })

  it('refused before anything is sent', () => {
    expect(budgetChangeDraft(C, 'EUR', {}, BUDGETS)).toEqual({ refusal: 'Say what to change: create, amounts, renames or campaigns.' })
    expect(budgetChangeDraft(C, 'EUR', { create: { name: 'shared it', budgetCents: 100 } }, BUDGETS)).toMatchObject({ refusal: expect.stringContaining('already exists') })
    expect(budgetChangeDraft(C, 'EUR', { amounts: [{ budgetId: '99', budgetCents: 100 }] }, BUDGETS)).toMatchObject({ refusal: expect.stringContaining('not in this account') })
    expect(budgetChangeDraft(C, 'EUR', { campaigns: [{ campaignId: '21', budgetId: 'new' }] }, BUDGETS)).toMatchObject({ refusal: expect.stringContaining('needs create') })
    expect(budgetChangeDraft(C, 'EUR', { campaigns: [{ campaignId: '21', budgetId: '12' }] }, BUDGETS)).toMatchObject({ refusal: expect.stringContaining('own budget of another campaign') })
    expect(budgetChangeDraft(C, 'EUR', { campaigns: [{ campaignId: '21', budgetId: '11', ownBudgetCents: 5 }] }, BUDGETS)).toMatchObject({ refusal: expect.stringContaining('not both') })
  })
})

const LISTS: ListLiveState = {
  lists: [{
    listId: '31', name: 'List A', keywordCount: 2, campaigns: [{ campaignId: '21', name: 'C1', status: 'PAUSED' }],
    keywords: [{ criterionId: '401', text: 'gratis', matchType: 'PHRASE' }, { criterionId: '402', text: 'usata', matchType: 'BROAD' }],
  }],
  campaigns: BUDGETS.campaigns,
}

describe('listChangeDraft', () => {
  it('a new list with keywords, attached to two campaigns: one request, the list first with a temporary id', () => {
    const d = listChangeDraft(C, { create: { name: 'List B' }, addKeywords: [{ text: 'cheap', matchType: 'PHRASE' }, { text: 'Cheap', matchType: 'PHRASE' }, { text: 'kids', matchType: 'EXACT' }], attachCampaignIds: ['21', '22'] }, LISTS)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { sharedSetOperation: { create: { resourceName: `${C}/sharedSets/-1`, name: 'List B', type: 'NEGATIVE_KEYWORDS' } } },
      { sharedCriterionOperation: { create: { sharedSet: `${C}/sharedSets/-1`, keyword: { text: 'cheap', matchType: 'PHRASE' } } } },
      { sharedCriterionOperation: { create: { sharedSet: `${C}/sharedSets/-1`, keyword: { text: 'kids', matchType: 'EXACT' } } } },
      { campaignSharedSetOperation: { create: { campaign: `${C}/campaigns/21`, sharedSet: `${C}/sharedSets/-1` } } },
      { campaignSharedSetOperation: { create: { campaign: `${C}/campaigns/22`, sharedSet: `${C}/sharedSets/-1` } } },
    ])
    expect(d.spendsMoney).toEqual([])
    expect(d.totals).toMatchObject({ keywordsAdded: 2, campaignsAttached: 2 })
  })

  it('an existing list: skips what is already so; removes by Google\'s criterion; detach warns that more searches show ads', () => {
    const d = listChangeDraft(C, { listId: '31', addKeywords: [{ text: 'Gratis', matchType: 'PHRASE' }], removeKeywords: [{ text: 'usata', matchType: 'BROAD' }], attachCampaignIds: ['21'], detachCampaignIds: [] }, LISTS)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ sharedCriterionOperation: { remove: `${C}/sharedCriteria/31~402` } }])
    expect(d.skipped).toEqual(['"Gratis" is already in "List A".', '"List A" is already on "C1".'])
    expect(d.spendsMoney).toEqual(['Removes 1 negative keyword from "List A", which 1 campaign use: more searches can show their ads (no campaign it reaches is enabled now: nothing spends until one is).'])
    const off = listChangeDraft(C, { listId: '31', detachCampaignIds: ['21'] }, LISTS)
    if ('refusal' in off) throw new Error(off.refusal)
    expect(off.operations).toEqual([{ campaignSharedSetOperation: { remove: `${C}/campaignSharedSets/21~31` } }])
    expect(off.after).toMatchObject({ listId: '31', detached: ['21'] })
  })

  it('refused before anything is sent', () => {
    expect(listChangeDraft(C, { listId: '31', create: { name: 'x' } }, LISTS)).toMatchObject({ refusal: expect.stringContaining('not both') })
    expect(listChangeDraft(C, { create: { name: 'list a' } }, LISTS)).toMatchObject({ refusal: expect.stringContaining('already exists') })
    expect(listChangeDraft(C, { listId: '99', addKeywords: [{ text: 'x', matchType: 'EXACT' }] }, LISTS)).toMatchObject({ refusal: expect.stringContaining('not in this account') })
    expect(listChangeDraft(C, { listId: '31', addKeywords: [{ text: 'a b c d e f g h i j k', matchType: 'EXACT' }] }, LISTS)).toMatchObject({ refusal: expect.stringContaining('more than 10 words') })
    expect(listChangeDraft(C, { listId: '31', attachCampaignIds: ['99'] }, LISTS)).toMatchObject({ refusal: expect.stringContaining('not in this account') })
    expect(listChangeDraft(C, { listId: '31', addKeywords: [{ text: 'gratis', matchType: 'PHRASE' }] }, LISTS)).toMatchObject({ refusal: expect.stringContaining('Nothing to change') })
  })
})
