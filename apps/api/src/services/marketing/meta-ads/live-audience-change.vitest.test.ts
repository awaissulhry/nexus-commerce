/**
 * Meta step 31 — the live reads an audience change stands on: the active ad sets that read the existing-customer list
 * (an existing-customer budget cap, or a customer goal that excludes existing customers — never one with neither), and
 * who an audience is shared with (unread is null, never "nobody"). Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, more: false, asked: null as Record<string, unknown> | null, sharing: null as unknown }))
vi.mock('./live-audiences.js', async (importActual) => ({
  ...(await importActual<typeof import('./live-audiences.js')>()),
  readRows: vi.fn(async (_c: string, _op: string, path: string, query: Record<string, unknown>) => { h.asked = { path, ...query }; return { rows: h.rows, more: h.more } }),
  audiencesView: vi.fn(async () => h.sharing),
}))

import { liveAudienceSharing, liveExistingCustomerUsers } from './live-audience-change.js'
import type { MetaChosenAccount } from './live.js'

const ACCOUNT = { connectionId: 'm-1', adAccountId: '1234567890' } as MetaChosenAccount
beforeEach(() => { h.rows = []; h.more = false; h.asked = null; h.sharing = null })

describe('liveExistingCustomerUsers', () => {
  it('the ACTIVE ad sets with an existing-customer budget share or a goal that excludes existing customers, only those', async () => {
    h.rows = [
      { id: '120000000000002', name: 'Cap', campaign_id: '120000000000001', existing_customer_budget_percentage: 20 },
      { id: '120000000000003', name: 'Broad', campaign_id: '120000000000001', ad_set_goal: { type: 0 } },
      { id: '120000000000004', name: 'New only', campaign_id: '120000000000001', ad_set_goal: { type: 2, existing_customers_exclusions: ['1'] } },
      { id: '120000000000005', name: 'Plain', campaign_id: '120000000000001' },
    ]
    expect(await liveExistingCustomerUsers(ACCOUNT)).toEqual({
      adSets: [{ id: '120000000000002', name: 'Cap', campaignId: '120000000000001' }, { id: '120000000000004', name: 'New only', campaignId: '120000000000001' }],
      problem: null,
    })
    expect(h.asked).toMatchObject({ path: 'act_1234567890/adsets', effective_status: ['ACTIVE'], fields: 'id,name,campaign_id,existing_customer_budget_percentage,ad_set_goal' })
    h.more = true
    expect((await liveExistingCustomerUsers(ACCOUNT)).problem).toMatch(/more active ad sets than Nexus reads/)
  })
})

describe('liveAudienceSharing', () => {
  it('re-review N1 — Meta did not answer who it is shared with: accounts null and the problem, never an empty list', async () => {
    h.sharing = { recipients: [], sharedWithAdAccounts: { refused: 'Meta refused it' } }
    expect(await liveAudienceSharing(ACCOUNT, '120000000000040')).toEqual({ accounts: null, problem: expect.stringMatching(/could not read who the audience is shared with \(Meta refused it\)/) })
    h.sharing = { recipients: [], sharedWithAdAccounts: [{ adAccountId: '1234567891', takenByAnotherBusiness: false }] }
    expect(await liveAudienceSharing(ACCOUNT, '120000000000040')).toEqual({ accounts: ['1234567891'], problem: null })
    h.sharing = { recipients: [], sharedWithAdAccounts: [{ adAccountId: '1234567891', takenByAnotherBusiness: true }] }
    expect((await liveAudienceSharing(ACCOUNT, '120000000000040')).problem).toMatch(/another business in Nexus uses/)
  })
})
