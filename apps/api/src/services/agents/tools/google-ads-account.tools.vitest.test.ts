/**
 * Google Ads programme 2, G8b (2026-10-15) — the account tools as the approval gate uses them (the account, the live reads
 * and Google are stand-ins). Settings: a customerOperation mutate Google checks first. Users: Google cannot check them
 * first, so the preview sends nothing to Google and names the person by a masked e-mail address. Links and billing: Google
 * checks an unlink and an account budget proposal first (their method's validate_only), not the others. What the Google
 * Ads API cannot do is answered in words before anything is read. Google's refusal at the Explorer access level is said
 * plainly, never a success. Each run is ONE call, as the person who approved it; undo puts it back where Google allows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  send: vi.fn(),
  check: vi.fn(),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  reads: { settings: 0, access: 0, links: 0, billing: 0 },
  live: { settings: null as unknown, access: null as unknown, links: null as unknown, billing: null as unknown },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop A', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live-account-admin.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-account-admin.js')>()),
  liveAdminSettings: vi.fn(async () => { h.reads.settings += 1; return structuredClone(h.live.settings) }),
  liveAccessState: vi.fn(async () => { h.reads.access += 1; return structuredClone(h.live.access) }),
  liveLinkState: vi.fn(async () => { h.reads.links += 1; return structuredClone(h.live.links) }),
  liveBillingState: vi.fn(async () => { h.reads.billing += 1; return structuredClone(h.live.billing) }),
}))
vi.mock('../../marketing/google-ads/account-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/account-client.js')>()),
  sendAccountOperations: h.send,
  checkAccountOperations: h.check,
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { GOOGLE_ADS_ACCOUNT_TOOLS } from './google-ads-account.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { accessRefusal } from '../../marketing/google-ads/account-client.js'
import { adminSettingsOf } from '../../marketing/google-ads/live-account-admin.js'
import { parseGoogleAdsFailure } from '../../marketing/google-ads/errors.js'
import { GoogleAdsWriteError } from '../../marketing/google-ads/write-client.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_ACCOUNT_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const pick = (p: unknown) => { const { basis, plan, reach } = p as Record<string, unknown>; return { basis, plan, reach } }
const C = 'customers/1234567890'

/** Google's answer when the Cloud project's access level does not allow a service (AuthorizationError v25). */
const explorerRefusal = (path: 'customerUserAccessInvitations:mutate' | 'accountBudgetProposals:mutate') => new GoogleAdsWriteError(
  accessRefusal(path, parseGoogleAdsFailure(403, JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', errors: [{ errorCode: { authorizationError: 'SERVICE_ACCESS_DENIED' }, message: 'The developer specified does not have access to the service.' }] }] } }))),
  'ads.account', 'refused', 1,
)

beforeEach(() => {
  h.mutate.mockReset(); h.send.mockReset(); h.check.mockReset(); h.enqueue.mockClear()
  h.reads = { settings: 0, access: 0, links: 0, billing: 0 }
  vi.unstubAllEnvs()
  h.live.settings = adminSettingsOf({ customer: { id: '1234567890', descriptiveName: 'Shop A', currencyCode: 'EUR', timeZone: 'Europe/Rome', autoTaggingEnabled: true, callReportingSetting: { callReportingEnabled: true } } })
  h.live.access = {
    users: [
      { userId: '61', email: 'owner@example.com', role: 'ADMIN', since: null },
      { userId: '62', email: 'staff@example.com', role: 'STANDARD', since: null },
    ],
    invitations: [],
    nexusLogin: 'owner@example.com',
  }
  h.live.links = { merchantLinks: [{ linkId: '41', merchantCenterId: '555' }], invitations: [], videos: [] }
  h.live.billing = {
    setups: [{ billingSetupId: '81', status: 'APPROVED', paymentsAccountId: '1111-2222-3333-4444', paymentsAccountName: 'Payer A', start: '2026-01-01 00:00:00', end: null }],
    budgets: [], proposals: [],
  }
})

describe('the account tools keep the Google change contract', () => {
  it('each a Nexus change a person approves; its re-check fields declared; users need users.manage, billing the ad-spend view', () => {
    for (const t of GOOGLE_ADS_ACCOUNT_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, riskTier: 'high', requiresApprovalDefault: true })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
      expect(t.undo).toBeDefined()
    }
    expect(tool('set-google-user-access').requires).toContain(F.usersManage)
    expect(tool('set-google-billing').requires).toContain(FIELDS.financialsAdspendView)
    expect(tool('set-google-account-settings').description).toContain('Google checks the change first (validate_only)')
    expect(tool('set-google-user-access').description).toContain('Google CANNOT check this change first')
    for (const name of ['set-google-account-links', 'set-google-billing']) expect(tool(name).description).toContain('where its method allows it')
  })
})

describe('set-google-account-settings', () => {
  const ask = { autoTagging: false, trackingTemplate: '{lpurl}?src=a' }

  it('Google checks the customerOperation first; the run sends it once as the approver; undo sets the old values back', async () => {
    h.mutate.mockResolvedValue({ responses: [] })
    const out = await tool('set-google-account-settings').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][1]).toEqual([{ customerOperation: { update: { resourceName: C, autoTaggingEnabled: false, trackingUrlTemplate: '{lpurl}?src=a' }, updateMask: 'auto_tagging_enabled,tracking_url_template' } }])
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    expect(out.preview).toMatchObject({ googleCheck: { checked: true }, spendsMoney: false, warnings: expect.arrayContaining([expect.stringMatching(/^Auto-tagging OFF/)]) })
    // The gate's re-check reads again and does not ask Google twice.
    const again = await tool('set-google-account-settings').handler(ask, recheck)
    expect(pick(again.preview)).toEqual(pick(out.preview))
    expect(h.mutate).toHaveBeenCalledTimes(1)

    expect((await tool('set-google-account-settings').execute!(ask, asker)).error).toMatch(/runs only as an approved request/)
    h.mutate.mockResolvedValue({ responses: [{}] })
    const run = await tool('set-google-account-settings').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.mutate.mock.calls[1][2]).toMatchObject({ validateOnly: false })
    expect(run.change).toEqual({
      before: { settings: { autoTagging: true, trackingTemplate: null }, accountId: 'g-1', customerId: '1234567890' },
      after: { settings: { autoTagging: false, trackingTemplate: '{lpurl}?src=a' }, accountId: 'g-1', customerId: '1234567890' },
    })
    h.live.settings = { ...(h.live.settings as object), autoTagging: false, trackingTemplate: '{lpurl}?src=a' }
    expect(await tool('set-google-account-settings').undo!.current(run.change!)).toEqual(run.change!.after)
    expect(tool('set-google-account-settings').undo!.request(run.change!)).toEqual({
      tool: 'set-google-account-settings',
      args: { accountId: 'g-1', autoTagging: true, trackingTemplate: '', why: 'undo of an earlier change of the Google Ads account settings' },
    })
  })
})

describe('set-google-user-access', () => {
  const invite = { action: 'invite', email: 'person@example.com', role: 'STANDARD' }

  it('the preview sends nothing to Google, says Google cannot check it, and names the person by a masked address', async () => {
    const out = await tool('set-google-user-access').handler(invite, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); expect(h.check).not.toHaveBeenCalled()
    expect(out.preview).toMatchObject({ googleCheck: { checked: false, sentence: expect.stringMatching(/^Google cannot check a user change first/) }, spendsMoney: false, operations: 1 })
    expect(JSON.stringify(out.preview)).not.toContain('person@example.com')
    expect((out.preview as { summary: string }).summary).toBe('Invite p***@example.com to the Google Ads account as Standard (changes campaigns; cannot manage users).')
  })

  it('runs ONE invitation as the approver; records the invitation Google made; undo cancels it', async () => {
    const preview = (await tool('set-google-user-access').handler(invite, asker)).preview
    h.send.mockResolvedValue({ responses: [{ accountResult: { resourceName: `${C}/customerUserAccessInvitations/73` } }] })
    const run = await tool('set-google-user-access').execute!(invite, approved(preview))
    expect(run.ok).toBe(true)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send.mock.calls[0][1]).toEqual([{ accountCall: { path: 'customerUserAccessInvitations:mutate', body: { operation: { create: { emailAddress: 'person@example.com', accessRole: 'STANDARD' } } } } }])
    expect(run.data).toMatchObject({ done: 'done', invitationId: '73' })
    expect(run.change!.after).toMatchObject({ action: 'invite', invitationId: '73', present: true })
    expect(tool('set-google-user-access').undo!.request(run.change!)).toEqual({
      tool: 'set-google-user-access',
      args: { accountId: 'g-1', action: 'cancel-invitation', invitationId: '73', why: 'undo of an earlier change of who may use the Google Ads account' },
    })
  })

  it('a change Google holds for a second administrator is said so, and has nothing to undo yet', async () => {
    const ask = { action: 'change-role', userId: '62', role: 'READ_ONLY' }
    const preview = (await tool('set-google-user-access').handler(ask, asker)).preview
    h.send.mockResolvedValue({ responses: [{ accountResult: {}, accountReview: { resourceName: `${C}/multiPartyAuthReviews/5` } }] })
    const run = await tool('set-google-user-access').execute!(ask, approved(preview))
    expect(run.data).toMatchObject({ done: 'held for a second administrator', note: expect.stringMatching(/multi-party approval/) })
    expect(tool('set-google-user-access').undo!.request(run.change!)).toEqual({ refusal: expect.stringMatching(/second administrator's approval/) })
  })

  it('never the last administrator; refused before anything is sent', async () => {
    const out = await tool('set-google-user-access').handler({ action: 'change-role', userId: '61', role: 'STANDARD' }, asker)
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/only administrator/) })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('refused at the Explorer access level: the run says so plainly with Google\'s own code, never a success', async () => {
    const preview = (await tool('set-google-user-access').handler(invite, asker)).preview
    h.send.mockRejectedValue(explorerRefusal('customerUserAccessInvitations:mutate'))
    const run = await tool('set-google-user-access').execute!(invite, approved(preview))
    expect(run.ok).toBe(false)
    expect(run.error).toMatch(/^Not run: Google refused it \(SERVICE_ACCESS_DENIED: .*Explorer access level.*user management.*Admin › Access and security\. Nothing was changed\.$/)
    expect(run.change).toBeUndefined()
  })
})

describe('set-google-account-links', () => {
  it('an unlink is checked by Google first (RemoveProductLink validate_only); a direct link is not', async () => {
    h.check.mockResolvedValue({ resourceName: null, review: null })
    const unlink = await tool('set-google-account-links').handler({ action: 'unlink-merchant-center', merchantCenterId: '555', confirmUnlink: true }, asker)
    expect(unlink.ok).toBe(true)
    expect(h.check).toHaveBeenCalledTimes(1)
    expect(h.check.mock.calls[0][1]).toEqual([{ accountCall: { path: 'productLinks:remove', body: { resourceName: `${C}/productLinks/41` } } }])
    expect(unlink.preview).toMatchObject({ googleCheck: { checked: true } })
    const link = await tool('set-google-account-links').handler({ action: 'link-merchant-center', merchantCenterId: '558' }, asker)
    expect(link.preview).toMatchObject({ googleCheck: { checked: false, sentence: expect.stringMatching(/^Google cannot check this link change first/) } })
    expect(h.check).toHaveBeenCalledTimes(1)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('GA4, a YouTube channel and a Business Profile: answered in words, before anything is read or sent', async () => {
    for (const action of ['link-ga4', 'link-youtube-channel', 'link-business-profile', 'request-merchant-link']) {
      const out = await tool('set-google-account-links').handler({ action }, asker)
      expect(out.ok, action).toBe(false)
      const run = await tool('set-google-account-links').execute!({ action }, approved({}))
      expect(run.ok, action).toBe(false)
    }
    expect((await tool('set-google-account-links').handler({ action: 'link-ga4' }, asker)).error).toMatch(/cannot link Google Analytics 4/)
    expect(h.reads.links).toBe(0)
    expect(h.send).not.toHaveBeenCalled(); expect(h.check).not.toHaveBeenCalled()
  })

  it('a video request runs once; its link id recorded; undo takes the request back', async () => {
    const ask = { action: 'request-video-link', channelId: 'UCabcdefghijklmnopqrstuv', videoId: 'abcdefghijk' }
    const preview = (await tool('set-google-account-links').handler(ask, asker)).preview
    h.send.mockResolvedValue({ responses: [{ accountResult: { resourceName: `${C}/dataLinks/43~44` } }] })
    const run = await tool('set-google-account-links').execute!(ask, approved(preview))
    expect(run.ok).toBe(true)
    expect(run.change!.after).toMatchObject({ action: 'request-video-link', videoLinkId: '43~44' })
    expect(tool('set-google-account-links').undo!.request(run.change!)).toMatchObject({ tool: 'set-google-account-links', args: { action: 'revoke-video-request', videoLinkId: '43~44' } })
  })
})

describe('set-google-billing', () => {
  const propose = { action: 'propose-account-budget', name: 'Budget A', spendingLimitCents: 50000 }

  it('a payment card: no API can add one (answered before anything is read)', async () => {
    const out = await tool('set-google-billing').handler({ action: 'add-payment-card' }, asker)
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/^No API can add or change a payment card/) })
    expect(h.reads.billing).toBe(0)
  })

  it('a new account budget: Google checks the proposal first; SPENDS MONEY; the run records the proposal; undo cancels it while it waits', async () => {
    h.check.mockResolvedValue({ resourceName: null, review: null })
    const out = await tool('set-google-billing').handler(propose, asker)
    expect(out.ok).toBe(true)
    expect(h.check).toHaveBeenCalledTimes(1)
    expect(h.check.mock.calls[0][1]).toEqual([{ accountCall: { path: 'accountBudgetProposals:mutate', body: { operation: { create: {
      proposalType: 'CREATE', billingSetup: `${C}/billingSetups/81`, proposedName: 'Budget A', proposedStartTimeType: 'NOW', proposedEndTimeType: 'FOREVER', proposedSpendingLimitMicros: '500000000',
    } } } } }])
    expect(out.preview).toMatchObject({ googleCheck: { checked: true }, spendsMoney: true, spendsMoneyBecause: ['A new account budget lets the account spend up to EUR 500.00 from now until it is ended.'] })
    h.send.mockResolvedValue({ responses: [{ accountResult: { resourceName: `${C}/accountBudgetProposals/95` } }] })
    const run = await tool('set-google-billing').execute!(propose, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(run.change!.after).toMatchObject({ action: 'propose-account-budget', proposalId: '95', state: 'PENDING' })
    expect(tool('set-google-billing').undo!.request(run.change!)).toMatchObject({ tool: 'set-google-billing', args: { action: 'cancel-proposal', proposalId: '95' } })
  })

  it('a billing setup is not checked first (no validate_only); refused at the Explorer access level, the preview says so plainly', async () => {
    const setup = await tool('set-google-billing').handler({ action: 'create-billing-setup', paymentsAccountId: '1111-2222-3333-5555', startDate: '2099-01-01' }, asker)
    expect(setup.preview).toMatchObject({ googleCheck: { checked: false, sentence: expect.stringMatching(/^Google cannot check a billing setup first/) }, spendsMoney: true })
    expect(h.check).not.toHaveBeenCalled()
    h.check.mockRejectedValue(explorerRefusal('accountBudgetProposals:mutate'))
    const out = await tool('set-google-billing').handler(propose, asker)
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/^Google refused it \(SERVICE_ACCESS_DENIED: .*Explorer access level.*account budgets.*Billing › Account budgets\. Nothing was changed\.$/) })
  })
})
