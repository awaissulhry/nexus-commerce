/**
 * Google Ads programme 2, G8b — the account's settings, users, links and billing, built from a request and the live state
 * (pure): the exact Google request, what spends money, the warnings, what is refused before anything is sent (the last
 * administrator, Nexus's own login, a confirm flag missing, what Google cannot do), and the record undo reads.
 */
import { describe, expect, it } from 'vitest'
import { accountSettingsDraft, AUTO_TAGGING_OFF, settingsNow, settingsUndoArgs, TRACKING_CHANGED, type AccountSettingsRecord } from './change-account-settings.js'
import { ACCESS_LEVEL_NOTE, userAccessDraft, userAccessNow, userAccessUndo, type UserAccessRecord } from './change-account-users.js'
import { CANNOT, linkDraft, linkNow, linkUndo, type LinkRecord } from './change-account-links.js'
import { billingDraft, billingNow, billingUndo, NO_CARD, type BillingRecord } from './change-account-billing.js'
import { adminSettingsOf, type LiveAccessState, type LiveBillingState, type LiveBudgetProposal, type LiveLinkState } from './live-account-admin.js'
import type { GoogleChangeDraft } from './change-draft.js'

const C = 'customers/1234567890'
const ok = (d: GoogleChangeDraft | { refusal: string }): GoogleChangeDraft => {
  if ('refusal' in d) throw new Error(d.refusal)
  return d
}
const refusal = (d: GoogleChangeDraft | { refusal: string }): string => ('refusal' in d ? d.refusal : `not refused: ${d.summary}`)

const SETTINGS = adminSettingsOf({
  customer: {
    id: '1234567890', descriptiveName: 'Shop A', currencyCode: 'EUR', timeZone: 'Europe/Rome', autoTaggingEnabled: true,
    callReportingSetting: { callReportingEnabled: true, callConversionReportingEnabled: false }, videoBrandSafetySuitability: 'STANDARD_INVENTORY',
  },
})

describe('accountSettingsDraft', () => {
  it('one customerOperation update with exactly the fields asked for; a template taken away is masked and left out', () => {
    const d = ok(accountSettingsDraft(C, { autoTagging: false, trackingTemplate: '{lpurl}?src=a', finalUrlSuffix: '', name: 'Shop A' }, SETTINGS))
    expect(d.operations).toEqual([{ customerOperation: { update: { resourceName: C, autoTaggingEnabled: false, trackingUrlTemplate: '{lpurl}?src=a' }, updateMask: 'auto_tagging_enabled,tracking_url_template' } }])
    expect(d.skipped).toEqual(['Account final URL suffix is already (none).', 'Account name is already Shop A.'])
    expect(d.warnings).toEqual([AUTO_TAGGING_OFF, TRACKING_CHANGED])
    expect(d.spendsMoney).toEqual([])
    expect(d.before).toEqual({ settings: { autoTagging: true, trackingTemplate: null } })
    expect(d.after).toEqual({ settings: { autoTagging: false, trackingTemplate: '{lpurl}?src=a' } })
    // Undo sets them back (a template that was none is taken away).
    expect(settingsUndoArgs(d.before as AccountSettingsRecord)).toEqual({ autoTagging: true, trackingTemplate: '' })
    const cleared = ok(accountSettingsDraft(C, { trackingTemplate: '' }, { ...SETTINGS, trackingTemplate: '{lpurl}?src=a' }))
    expect(cleared.operations).toEqual([{ customerOperation: { update: { resourceName: C }, updateMask: 'tracking_url_template' } }])
  })

  it('call reporting and brand safety: the nested setting, its mask paths, and the warnings', () => {
    const d = ok(accountSettingsDraft(C, { callReporting: false, callConversionActionId: '77', videoBrandSafety: 'EXPANDED_INVENTORY' }, SETTINGS))
    expect(d.operations).toEqual([{ customerOperation: {
      update: { resourceName: C, callReportingSetting: { callReportingEnabled: false, callConversionAction: `${C}/conversionActions/77` }, videoBrandSafetySuitability: 'EXPANDED_INVENTORY' },
      updateMask: 'call_reporting_setting.call_reporting_enabled,call_reporting_setting.call_conversion_action,video_brand_safety_suitability',
    } }])
    expect(d.warnings.join(' ')).toMatch(/Call reporting OFF.*only while call conversion reporting is on.*Expanded inventory/)
    // STANDARD → EXPANDED shows video ads on more content: SPENDS MONEY. Narrower is not; nor is anything else here.
    expect(d.spendsMoney).toEqual(['Video brand safety STANDARD_INVENTORY → EXPANDED_INVENTORY: video ads can show on more content, so they can spend more.'])
    expect(ok(accountSettingsDraft(C, { videoBrandSafety: 'STANDARD_INVENTORY' }, { ...SETTINGS, videoBrandSafety: 'LIMITED_INVENTORY' })).spendsMoney).toHaveLength(1)
    expect(ok(accountSettingsDraft(C, { videoBrandSafety: 'LIMITED_INVENTORY' }, SETTINGS)).spendsMoney).toEqual([])
    expect(ok(accountSettingsDraft(C, { videoBrandSafety: 'EXPANDED_INVENTORY' }, { ...SETTINGS, videoBrandSafety: null })).spendsMoney).toHaveLength(1)
  })

  it('refuses Google\'s URL rules, an empty name and nothing to change, before anything is sent', () => {
    expect(refusal(accountSettingsDraft(C, { trackingTemplate: 'track.example/?u={lpurl}', finalUrlSuffix: '?a=1' }, SETTINGS))).toMatch(/must start with http:\/\/, https:\/\/ or \{lpurl\}.*cannot begin with "\?" or "&"/)
    expect(refusal(accountSettingsDraft(C, { autoTagging: true }, SETTINGS))).toBe('Nothing to change: Auto-tagging is already on.')
    expect(refusal(accountSettingsDraft(C, {}, SETTINGS))).toMatch(/Name at least one setting/)
    expect(refusal(accountSettingsDraft(C, { autoTagging: false }, null))).toMatch(/did not answer/)
  })

  it('undo\'s "current" reads the same fields back', () => {
    const after: AccountSettingsRecord = { settings: { autoTagging: false } }
    expect(settingsNow(after, { ...SETTINGS, autoTagging: false })).toEqual(after)
    expect(settingsNow(after, SETTINGS)).toEqual({ settings: { autoTagging: true } })
  })
})

const ACCESS: LiveAccessState = {
  users: [
    { userId: '61', email: 'owner@example.com', role: 'ADMIN', since: '2026-01-01 10:00:00' },
    { userId: '62', email: 'staff@example.com', role: 'STANDARD', since: '2026-02-01 10:00:00' },
  ],
  invitations: [
    { invitationId: '71', email: 'new@example.com', role: 'READ_ONLY', status: 'PENDING', sentAt: '2026-10-01 10:00:00' },
    { invitationId: '72', email: 'old@example.com', role: 'STANDARD', status: 'EXPIRED', sentAt: '2026-01-01 10:00:00' },
  ],
  nexusLogin: 'owner@example.com',
}

describe('userAccessDraft', () => {
  it('an invitation names the role plainly and the person by a MASKED address (the preview is kept with the approval); the full address only in the request', () => {
    const d = ok(userAccessDraft(C, { action: 'invite', email: 'person@example.com', role: 'ADMIN' }, ACCESS))
    expect(d.summary).toBe('Invite p***@example.com to the Google Ads account as Admin (full access: users, billing and everything else).')
    expect(d.operations).toEqual([{ accountCall: { path: 'customerUserAccessInvitations:mutate', body: { operation: { create: { emailAddress: 'person@example.com', accessRole: 'ADMIN' } } } } }])
    expect(d.warnings).toEqual([
      expect.stringMatching(/^Google e-mails an invitation to p\*\*\*@example\.com/),
      expect.stringMatching(/becomes an administrator/),
      ACCESS_LEVEL_NOTE,
    ])
    expect(d.spendsMoney).toEqual([])
    // Nothing a person sees in the preview carries the full address.
    expect(JSON.stringify([d.summary, d.changes, d.warnings, d.skipped])).not.toContain('person@example.com')
  })

  it('refuses an address that already has access or a pending invitation, and a bad address', () => {
    expect(refusal(userAccessDraft(C, { action: 'invite', email: 'Staff@Example.com', role: 'READ_ONLY' }, ACCESS))).toMatch(/already has access to this account as STANDARD \(user 62\)/)
    expect(refusal(userAccessDraft(C, { action: 'invite', email: 'new@example.com', role: 'STANDARD' }, ACCESS))).toMatch(/already invited \(invitation 71/)
    expect(refusal(userAccessDraft(C, { action: 'invite', email: 'not an address', role: 'STANDARD' }, ACCESS))).toMatch(/valid address/)
    // An expired invitation does not block a new one.
    ok(userAccessDraft(C, { action: 'invite', email: 'old@example.com', role: 'STANDARD' }, ACCESS))
  })

  it('never the last administrator, never Nexus\'s own login, a removal only with confirmRemove', () => {
    expect(refusal(userAccessDraft(C, { action: 'remove', userId: '62' }, ACCESS))).toMatch(/needs confirmRemove: true/)
    expect(refusal(userAccessDraft(C, { action: 'remove', userId: '61', confirmRemove: true }, ACCESS))).toMatch(/only administrator/)
    expect(refusal(userAccessDraft(C, { action: 'change-role', userId: '61', role: 'STANDARD' }, ACCESS))).toMatch(/only administrator/)
    const twoAdmins: LiveAccessState = { ...ACCESS, users: [...ACCESS.users, { userId: '63', email: 'second@example.com', role: 'ADMIN', since: null }] }
    expect(refusal(userAccessDraft(C, { action: 'remove', userId: '61', confirmRemove: true }, twoAdmins))).toMatch(/Google login Nexus signs in with/)
    expect(refusal(userAccessDraft(C, { action: 'change-role', userId: '61', role: 'READ_ONLY' }, twoAdmins))).toMatch(/Google login Nexus signs in with/)
    const removal = ok(userAccessDraft(C, { action: 'remove', userId: '63', confirmRemove: true }, twoAdmins))
    expect(removal.operations).toEqual([{ accountCall: { path: 'customerUserAccesses:mutate', body: { operation: { remove: `${C}/customerUserAccesses/63` } } } }])
    expect(removal.summary).toBe('Remove the access of s***@example.com (user 63) to the Google Ads account (role now: Admin (full access: users, billing and everything else)).')
    expect(JSON.stringify([removal.summary, removal.changes, removal.warnings])).not.toContain('second@example.com')
  })

  it('a role change: an update of access_role only; undo sets the old role back', () => {
    const d = ok(userAccessDraft(C, { action: 'change-role', userId: '62', role: 'READ_ONLY' }, ACCESS))
    expect(d.operations).toEqual([{ accountCall: { path: 'customerUserAccesses:mutate', body: { operation: { update: { resourceName: `${C}/customerUserAccesses/62`, accessRole: 'READ_ONLY' }, updateMask: 'access_role' } } } }])
    expect(d.summary).toBe('Change the role of s***@example.com (user 62) in the Google Ads account from Standard (changes campaigns; cannot manage users) to Read only (sees the account; cannot change it).')
    expect(userAccessUndo(d.before as UserAccessRecord, d.after as UserAccessRecord)).toEqual({ args: { action: 'change-role', userId: '62', role: 'STANDARD' } })
    expect(refusal(userAccessDraft(C, { action: 'change-role', userId: '62', role: 'STANDARD' }, ACCESS))).toMatch(/already has the role STANDARD/)
  })

  it('undo: an invitation is cancelled, a cancelled one sent again, a removed person invited again; a held change has nothing to undo', () => {
    const invited: UserAccessRecord = { action: 'invite', email: 'person@example.com', role: 'STANDARD', userId: null, invitationId: '73', present: true }
    expect(userAccessUndo({ ...invited, present: false, invitationId: null }, invited)).toEqual({ args: { action: 'cancel-invitation', invitationId: '73' } })
    expect(userAccessUndo(invited, { ...invited, review: 'customers/1234567890/multiPartyAuthReviews/1' })).toEqual({ refusal: expect.stringMatching(/second administrator/) })
    const cancel = ok(userAccessDraft(C, { action: 'cancel-invitation', invitationId: '71' }, ACCESS))
    expect(userAccessUndo(cancel.before as UserAccessRecord, cancel.after as UserAccessRecord)).toEqual({ args: { action: 'invite', email: 'new@example.com', role: 'READ_ONLY' } })
    expect(refusal(userAccessDraft(C, { action: 'cancel-invitation', invitationId: '72' }, ACCESS))).toMatch(/is EXPIRED/)
    const removed: UserAccessRecord = { action: 'remove', email: 'staff@example.com', role: 'STANDARD', userId: '62', invitationId: null, present: false }
    expect(userAccessUndo({ ...removed, present: true }, removed)).toEqual({ args: { action: 'invite', email: 'staff@example.com', role: 'STANDARD' } })
    // "current": an accepted invitation is no longer pending (undo then refuses: it changed since).
    expect(userAccessNow({ ...invited, invitationId: '71' }, ACCESS)).toMatchObject({ present: true, role: 'READ_ONLY' })
    expect(userAccessNow(invited, ACCESS)).toMatchObject({ present: false })
  })
})

const LINKS: LiveLinkState = {
  merchantLinks: [{ linkId: '41', merchantCenterId: '555' }],
  invitations: [
    { invitationId: '42', type: 'MERCHANT_CENTER', status: 'PENDING_APPROVAL', merchantCenterId: '556' },
    { invitationId: '45', type: 'MERCHANT_CENTER', status: 'REJECTED', merchantCenterId: '557' },
  ],
  videos: [
    { linkId: '43~44', status: 'REQUESTED', channelId: 'UCabcdefghijklmnopqrstuv', videoId: 'abcdefghijk' },
    { linkId: '43~46', status: 'PENDING_APPROVAL', channelId: 'UCabcdefghijklmnopqrstuv', videoId: 'bcdefghijkl' },
  ],
  chosenMerchantCenterIds: ['555', '556', '558'],
}

describe('linkDraft', () => {
  it('Merchant Center: a direct link, accepting its request, unlinking with confirmUnlink; the exact calls', () => {
    const link = ok(linkDraft(C, { action: 'link-merchant-center', merchantCenterId: '558' }, LINKS))
    expect(link.operations).toEqual([{ accountCall: { path: 'productLinks:create', body: { productLink: { merchantCenter: { merchantCenterId: '558' } } } } }])
    expect(link.warnings[0]).toMatch(/administrator of BOTH accounts/)
    expect(link.spendsMoney).toEqual(['Linking Merchant Center 558 lets enabled Shopping and Performance Max campaigns that use it show product ads (again): they can spend.'])
    const accept = ok(linkDraft(C, { action: 'accept-merchant-request', invitationId: '42' }, LINKS))
    expect(accept.operations).toEqual([{ accountCall: { path: 'productLinkInvitations:update', body: { resourceName: `${C}/productLinkInvitations/42`, productLinkInvitationStatus: 'ACCEPTED' } } }])
    expect(accept.spendsMoney).toEqual([expect.stringMatching(/^Linking Merchant Center 556 lets enabled Shopping and Performance Max campaigns/)])
    expect(refusal(linkDraft(C, { action: 'unlink-merchant-center', merchantCenterId: '555' }, LINKS))).toMatch(/needs confirmUnlink: true/)
    const unlink = ok(linkDraft(C, { action: 'unlink-merchant-center', merchantCenterId: '555', confirmUnlink: true }, LINKS))
    expect(unlink.operations).toEqual([{ accountCall: { path: 'productLinks:remove', body: { resourceName: `${C}/productLinks/41` } } }])
    expect(unlink.warnings[0]).toMatch(/stop showing product ads/)
    expect(refusal(linkDraft(C, { action: 'link-merchant-center', merchantCenterId: '555' }, LINKS))).toMatch(/already linked/)
    expect(refusal(linkDraft(C, { action: 'link-merchant-center', merchantCenterId: '556' }, LINKS))).toMatch(/already sent a link request \(42/)
    expect(refusal(linkDraft(C, { action: 'accept-merchant-request', invitationId: '45' }, LINKS))).toMatch(/is REJECTED/)
  })

  it('ids never cross businesses: only the Merchant Center this business chose is linked or accepted; the chosen ids are facts', () => {
    expect(refusal(linkDraft(C, { action: 'link-merchant-center', merchantCenterId: '559' }, LINKS))).toBe('Merchant Center 559 is not the Merchant Center account this business chose in Nexus (555, 556, 558): Nexus links only that one, so ids never cross businesses. Nothing was changed.')
    expect(refusal(linkDraft(C, { action: 'link-merchant-center', merchantCenterId: '558' }, { ...LINKS, chosenMerchantCenterIds: [] }))).toMatch(/^This business has not chosen a Merchant Center account in Nexus: choose it first/)
    expect(refusal(linkDraft(C, { action: 'accept-merchant-request', invitationId: '42' }, { ...LINKS, chosenMerchantCenterIds: ['558'] }))).toMatch(/Merchant Center 556 is not the Merchant Center account this business chose/)
    // Rejecting another account's request crosses nothing: allowed, and it spends nothing.
    expect(ok(linkDraft(C, { action: 'reject-merchant-request', invitationId: '42' }, { ...LINKS, chosenMerchantCenterIds: [] })).spendsMoney).toEqual([])
    // A run re-checks the choice: a different chosen list is a different basis.
    const a = ok(linkDraft(C, { action: 'link-merchant-center', merchantCenterId: '558' }, LINKS))
    const b = ok(linkDraft(C, { action: 'link-merchant-center', merchantCenterId: '558' }, { ...LINKS, chosenMerchantCenterIds: ['558'] }))
    expect(a.stands).not.toEqual(b.stands)
    // The undo of an unlink is a link: the same rule and the same SPENDS MONEY line.
    expect(linkUndo({ action: 'unlink-merchant-center', merchantCenterId: '558', state: 'linked' }, { action: 'unlink-merchant-center', merchantCenterId: '558', state: 'none' })).toEqual({ args: { action: 'link-merchant-center', merchantCenterId: '558' } })
  })

  it('YouTube: a request, taking it back, accepting a creator\'s request; ids checked', () => {
    const request = ok(linkDraft(C, { action: 'request-video-link', channelId: 'UCabcdefghijklmnopqrstuv', videoId: 'cdefghijklm' }, LINKS))
    expect(request.operations).toEqual([{ accountCall: { path: 'dataLinks:create', body: { dataLink: { youtubeVideo: { channelId: 'UCabcdefghijklmnopqrstuv', videoId: 'cdefghijklm' } } } } }])
    expect(refusal(linkDraft(C, { action: 'request-video-link', channelId: 'UCabcdefghijklmnopqrstuv', videoId: 'abcdefghijk' }, LINKS))).toMatch(/already has a link \(43~44, REQUESTED\)/)
    expect(refusal(linkDraft(C, { action: 'request-video-link', channelId: 'channel', videoId: 'cdefghijklm' }, LINKS))).toMatch(/starts with "UC"/)
    const revoke = ok(linkDraft(C, { action: 'revoke-video-request', videoLinkId: '43~44' }, LINKS))
    expect(revoke.operations).toEqual([{ accountCall: { path: 'dataLinks:update', body: { resourceName: `${C}/dataLinks/43~44`, dataLinkStatus: 'REVOKED' } } }])
    const accept = ok(linkDraft(C, { action: 'accept-video-link', videoLinkId: '43~46' }, LINKS))
    expect(accept.operations).toEqual([{ accountCall: { path: 'dataLinks:update', body: { resourceName: `${C}/dataLinks/43~46`, dataLinkStatus: 'ENABLED' } } }])
    expect(refusal(linkDraft(C, { action: 'remove-video-link', videoLinkId: '43~44' }, LINKS))).toMatch(/only a linked video/)
  })

  it('GA4, a Merchant Center request from Google Ads, a YouTube channel and a Business Profile: answered in words, never sent', () => {
    expect(refusal(linkDraft(C, { action: 'link-ga4' }, LINKS))).toBe(CANNOT['link-ga4'])
    expect(CANNOT['link-ga4']).toMatch(/Analytics Admin API.*analytics\.edit/)
    expect(refusal(linkDraft(C, { action: 'request-merchant-link', merchantCenterId: '558' }, LINKS))).toMatch(/cannot send a link request to a Merchant Center account/)
    expect(refusal(linkDraft(C, { action: 'link-youtube-channel' }, LINKS))).toMatch(/cannot link a YouTube channel.*request-video-link/)
    expect(refusal(linkDraft(C, { action: 'link-business-profile' }, LINKS))).toMatch(/location asset set.*business\.manage/)
  })

  it('undo: a link is unlinked, an unlink linked again, a request taken back; a rejection cannot come back', () => {
    const linked: LinkRecord = { action: 'link-merchant-center', merchantCenterId: '555', state: 'linked' }
    expect(linkNow(linked, LINKS)).toEqual(linked)
    expect(linkUndo({ ...linked, state: 'none' }, linked)).toEqual({ args: { action: 'unlink-merchant-center', merchantCenterId: '555', confirmUnlink: true } })
    expect(linkUndo(linked, { ...linked, action: 'unlink-merchant-center', state: 'none' })).toEqual({ args: { action: 'link-merchant-center', merchantCenterId: '555' } })
    const requested: LinkRecord = { action: 'request-video-link', channelId: 'UCabcdefghijklmnopqrstuv', videoId: 'abcdefghijk', videoLinkId: '43~44', state: 'REQUESTED' }
    expect(linkNow(requested, LINKS)).toEqual(requested)
    expect(linkUndo(requested, requested)).toEqual({ args: { action: 'revoke-video-request', videoLinkId: '43~44' } })
    expect(linkUndo(linked, { action: 'reject-merchant-request', invitationId: '42', merchantCenterId: '556', state: 'rejected' })).toEqual({ refusal: expect.stringMatching(/cannot come back/) })
  })
})

const BILLING: LiveBillingState = {
  setups: [{ billingSetupId: '81', status: 'APPROVED', paymentsAccountId: '1111-2222-3333-4444', paymentsAccountName: 'Payer A', start: '2026-01-01 00:00:00', end: null }],
  budgets: [{
    accountBudgetId: '91', name: 'Budget A', status: 'APPROVED', billingSetupId: '81', start: '2026-01-01 00:00:00', end: null, endType: 'FOREVER',
    spendingLimitCents: 500000, spendingLimitType: null, amountServedCents: 120000, pending: null,
  }],
  proposals: [{ proposalId: '95', status: 'PENDING', type: 'UPDATE', accountBudgetId: '91', billingSetupId: '81', name: 'Budget A', spendingLimitCents: 600000, spendingLimitType: null, createdAt: '2026-10-15 10:00:00', end: null, endType: null }],
}
const PAYMENTS = ['1111-2222-3333-4444', '1111-2222-3333-5555']
const proposal = (p: Partial<LiveBudgetProposal>): LiveBudgetProposal => ({ ...BILLING.proposals[0], ...p })
const TODAY = '2026-10-15'

describe('billingDraft', () => {
  it('a payment card: no API can add one (answered, nothing sent)', () => {
    expect(refusal(billingDraft(C, 'EUR', TODAY, { action: 'add-payment-card' }, BILLING))).toBe(NO_CARD)
  })

  it('a higher spending limit is SPENDS MONEY; a lower one stops all ads when reached (warning); below what was spent is refused', () => {
    const up = ok(billingDraft(C, 'EUR', TODAY, { action: 'change-account-budget', accountBudgetId: '91', spendingLimitCents: 600000 }, BILLING))
    expect(up.operations).toEqual([{ accountCall: { path: 'accountBudgetProposals:mutate', body: { operation: {
      create: { proposalType: 'UPDATE', accountBudget: `${C}/accountBudgets/91`, proposedSpendingLimitMicros: '6000000000' }, updateMask: 'proposed_spending_limit_micros',
    } } } }])
    expect(up.spendsMoney).toEqual(['Raises the account\'s spending limit from EUR 5000.00 to EUR 6000.00.'])
    expect(up.before).toEqual({ action: 'change-account-budget', accountBudgetId: '91', budget: { name: 'Budget A', spendingLimitCents: 500000, unlimited: false, endDate: null }, state: 'APPROVED' })
    expect(billingUndo(up.before as BillingRecord, up.after as BillingRecord)).toEqual({ args: { action: 'change-account-budget', accountBudgetId: '91', name: 'Budget A', spendingLimitCents: 500000 } })
    const down = ok(billingDraft(C, 'EUR', TODAY, { action: 'change-account-budget', accountBudgetId: '91', spendingLimitCents: 300000 }, BILLING))
    expect(down.spendsMoney).toEqual([])
    expect(down.warnings.join(' ')).toMatch(/ALL its ads stop until the limit is raised \(spent so far: EUR 1200.00\)/)
    expect(refusal(billingDraft(C, 'EUR', TODAY, { action: 'change-account-budget', accountBudgetId: '91', spendingLimitCents: 100000 }, BILLING))).toMatch(/already spent EUR 1200.00/)
    const open = ok(billingDraft(C, 'EUR', TODAY, { action: 'change-account-budget', accountBudgetId: '91', unlimited: true }, BILLING))
    expect(open.spendsMoney[0]).toMatch(/spend with no limit/)
  })

  it('a new budget: SPENDS MONEY, after the running one ends; Google allows one active budget', () => {
    expect(refusal(billingDraft(C, 'EUR', TODAY, { action: 'propose-account-budget', name: 'Budget B', spendingLimitCents: 100000 }, BILLING))).toMatch(/Google allows one active account budget/)
    const ending = { ...BILLING, budgets: [{ ...BILLING.budgets[0], end: '2026-10-31 23:59:59', endType: null }] }
    const d = ok(billingDraft(C, 'EUR', TODAY, { action: 'propose-account-budget', name: 'Budget B', spendingLimitCents: 100000, startDate: '2026-11-01', endDate: '2026-11-30' }, ending))
    expect(d.operations).toEqual([{ accountCall: { path: 'accountBudgetProposals:mutate', body: { operation: { create: {
      proposalType: 'CREATE', billingSetup: `${C}/billingSetups/81`, proposedName: 'Budget B', proposedStartDateTime: '2026-11-01 00:00:00',
      proposedEndDateTime: '2026-11-30 23:59:59', proposedSpendingLimitMicros: '1000000000',
    } } } } }])
    expect(d.spendsMoney).toEqual(['A new account budget lets the account spend up to EUR 1000.00 from 2026-11-01 to 2026-11-30.'])
    expect(refusal(billingDraft(C, 'EUR', TODAY, { action: 'propose-account-budget', name: 'Budget B', spendingLimitCents: 100000, startDate: TODAY }, ending))).toMatch(/must be after today/)
    expect(refusal(billingDraft(C, 'EUR', TODAY, { action: 'propose-account-budget', name: 'Budget B', spendingLimitCents: 100000 }, { setups: [], budgets: [], proposals: [] }))).toMatch(/no billing setup.*monthly invoicing/)
  })

  it('ending a budget needs confirmEnd and cannot be undone; a pending proposal is cancelled; a billing setup for an existing payments account', () => {
    expect(refusal(billingDraft(C, 'EUR', TODAY, { action: 'end-account-budget', accountBudgetId: '91' }, BILLING))).toMatch(/needs confirmEnd: true.*ALL its ads stop/)
    const end = ok(billingDraft(C, 'EUR', TODAY, { action: 'end-account-budget', accountBudgetId: '91', confirmEnd: true }, BILLING))
    expect(end.operations).toEqual([{ accountCall: { path: 'accountBudgetProposals:mutate', body: { operation: { create: { proposalType: 'END', accountBudget: `${C}/accountBudgets/91` } } } } }])
    expect(billingUndo(end.before as BillingRecord, end.after as BillingRecord)).toEqual({ refusal: expect.stringMatching(/cannot be restarted/) })
    const cancel = ok(billingDraft(C, 'EUR', TODAY, { action: 'cancel-proposal', proposalId: '95' }, BILLING))
    expect(cancel.operations).toEqual([{ accountCall: { path: 'accountBudgetProposals:mutate', body: { operation: { remove: `${C}/accountBudgetProposals/95` } } } }])
    // A wrong or missing id: the refusal names the proposals waiting now (the billing view shows them without an id).
    expect(refusal(billingDraft(C, 'EUR', TODAY, { action: 'cancel-proposal', proposalId: '96' }, BILLING))).toMatch(/Waiting now: 95 \(UPDATE, "Budget A"\)\.$/)
    expect(refusal(billingDraft(C, 'EUR', TODAY, { action: 'create-billing-setup', paymentsAccountId: '1111-2222-3333-5555' }, BILLING, PAYMENTS))).toMatch(/already has an approved billing setup/)
    const setup = ok(billingDraft(C, 'EUR', TODAY, { action: 'create-billing-setup', paymentsAccountId: '1111-2222-3333-5555', startDate: '2026-12-01' }, BILLING, PAYMENTS))
    expect(setup.operations).toEqual([{ accountCall: { path: 'billingSetups:mutate', body: { operation: { create: { paymentsAccount: `${C}/paymentsAccounts/1111-2222-3333-5555`, startDateTime: '2026-12-01 00:00:00' } } } } }])
    expect(setup.spendsMoney).toHaveLength(1)
    expect(refusal(billingDraft(C, 'EUR', TODAY, { action: 'cancel-billing-setup', billingSetupId: '81' }, BILLING))).toMatch(/Google cancels only a pending setup/)
  })

  it('a billing setup only for a payments account Google lists for this account (ids never cross accounts)', () => {
    const ask = { action: 'create-billing-setup' as const, paymentsAccountId: '1111-2222-3333-6666', startDate: '2026-12-01' }
    expect(refusal(billingDraft(C, 'EUR', TODAY, ask, BILLING, PAYMENTS))).toBe('Payments account 1111-2222-3333-6666 is not one Google lists for this Google Ads account (it lists 1111-2222-3333-4444, 1111-2222-3333-5555): Nexus uses only those, so an id never crosses accounts. Nothing was changed.')
    expect(refusal(billingDraft(C, 'EUR', TODAY, ask, BILLING, null))).toMatch(/could not read the payments accounts/)
    // Google may write the id as 16 digits: the same account.
    ok(billingDraft(C, 'EUR', TODAY, { ...ask, paymentsAccountId: '1111-2222-3333-5555' }, BILLING, ['1111222233335555']))
  })

  it('what was served is no fact: a change or an end is not "moved" while ads keep serving; only "new limit ≥ served" is', () => {
    const later = { ...BILLING, budgets: [{ ...BILLING.budgets[0], amountServedCents: 130000 }] }
    const ask = { action: 'change-account-budget' as const, accountBudgetId: '91', spendingLimitCents: 300000 }
    const a = ok(billingDraft(C, 'EUR', TODAY, ask, BILLING))
    expect(ok(billingDraft(C, 'EUR', TODAY, ask, later)).stands).toEqual(a.stands)
    expect(a.stands).toMatchObject({ limitAtLeastServed: true })
    expect(JSON.stringify(a.stands)).not.toMatch(/served(Cents)?"?:\s*1/)
    const end = { action: 'end-account-budget' as const, accountBudgetId: '91', confirmEnd: true }
    expect(ok(billingDraft(C, 'EUR', TODAY, end, later)).stands).toEqual(ok(billingDraft(C, 'EUR', TODAY, end, BILLING)).stands)
  })

  it('cancelling a waiting proposal that would end, lower, shorten or remove the budget: SPENDS MONEY (it keeps running as it is)', () => {
    const cancel = (p: Partial<LiveBudgetProposal>) => ok(billingDraft(C, 'EUR', TODAY, { action: 'cancel-proposal', proposalId: '95' }, { ...BILLING, proposals: [proposal(p)] })).spendsMoney
    // Proposal 95 raises the limit (EUR 5000 → 6000): cancelling it spends nothing more.
    expect(cancel({})).toEqual([])
    expect(cancel({ type: 'END' })).toEqual(['The proposal would have ended "Budget A": cancelling it keeps the budget running, so the account keeps spending.'])
    expect(cancel({ spendingLimitCents: 300000 })).toEqual(['Cancelling the proposal keeps "Budget A" as it is: its spending limit stays EUR 5000.00 instead of EUR 3000.00.'])
    expect(cancel({ spendingLimitCents: null, end: '2026-10-31 23:59:59' })).toEqual(['Cancelling the proposal keeps "Budget A" as it is: it keeps running with no end instead of ending on 2026-10-31.'])
    expect(cancel({ type: 'REMOVE' })).toEqual([expect.stringMatching(/would have removed "Budget A" before it starts/)])
    expect(cancel({ type: 'CREATE', accountBudgetId: null })).toEqual([])
  })

  it('REMOVE: an approved budget that has not started (confirmRemove); a running one is ended, a not-started one is not', () => {
    const future = { ...BILLING, budgets: [{ ...BILLING.budgets[0], accountBudgetId: '92', start: '2026-11-01 00:00:00', amountServedCents: 0 }], proposals: [] }
    expect(refusal(billingDraft(C, 'EUR', TODAY, { action: 'remove-account-budget', accountBudgetId: '92' }, future))).toMatch(/needs confirmRemove: true/)
    const d = ok(billingDraft(C, 'EUR', TODAY, { action: 'remove-account-budget', accountBudgetId: '92', confirmRemove: true }, future))
    expect(d.operations).toEqual([{ accountCall: { path: 'accountBudgetProposals:mutate', body: { operation: { create: { proposalType: 'REMOVE', accountBudget: `${C}/accountBudgets/92` } } } } }])
    expect(d.spendsMoney).toEqual([])
    expect(billingUndo(d.before as BillingRecord, d.after as BillingRecord)).toEqual({ refusal: expect.stringMatching(/removed account budget cannot come back/) })
    expect(refusal(billingDraft(C, 'EUR', TODAY, { action: 'end-account-budget', accountBudgetId: '92', confirmEnd: true }, future))).toMatch(/has not started .*remove-account-budget/)
    expect(refusal(billingDraft(C, 'EUR', TODAY, { action: 'remove-account-budget', accountBudgetId: '91', confirmRemove: true }, BILLING))).toMatch(/started on 2026-01-01.*end-account-budget/)
  })

  it('a new budget: refused while a new one waits on that billing setup; a purchase order number goes with it; undo names REMOVE or END', () => {
    const open = { ...BILLING, budgets: [], proposals: [proposal({ proposalId: '96', type: 'CREATE', accountBudgetId: null, name: 'Budget B' })] }
    expect(refusal(billingDraft(C, 'EUR', TODAY, { action: 'propose-account-budget', name: 'Budget C', spendingLimitCents: 100000 }, open))).toBe('A new account budget for billing setup 81 is already waiting for Google\'s review (proposal 96, "Budget B"): wait for it, or cancel it first (cancel-proposal).')
    const free = { ...BILLING, budgets: [], proposals: [] }
    const d = ok(billingDraft(C, 'EUR', TODAY, { action: 'propose-account-budget', name: 'Budget C', spendingLimitCents: 100000, startDate: '2026-11-01', purchaseOrderNumber: 'PO-1' }, free))
    expect(d.operations[0]).toMatchObject({ accountCall: { body: { operation: { create: { proposalType: 'CREATE', proposedPurchaseOrderNumber: 'PO-1' } } } } })
    // The waiting proposals are facts: a new one appearing moves the basis.
    expect(d.stands).not.toEqual(ok(billingDraft(C, 'EUR', TODAY, { action: 'propose-account-budget', name: 'Budget C', spendingLimitCents: 100000, startDate: '2026-11-01', purchaseOrderNumber: 'PO-1' }, { ...free, proposals: [proposal({ proposalId: '97', type: 'END' })] })).stands)
    const after = { ...(d.after as BillingRecord), proposalId: null }
    expect(billingUndo(d.before as BillingRecord, after)).toEqual({ refusal: expect.stringMatching(/remove the budget with remove-account-budget before it starts \(2026-11-01\); from then on, end it with end-account-budget/) })
    expect(billingUndo(d.before as BillingRecord, { ...after, budget: { ...after.budget!, startDate: null } })).toEqual({ refusal: expect.stringMatching(/it starts at once: end it with end-account-budget/) })
  })

  it('undo of a proposal: cancel it while Google has not decided', () => {
    const after: BillingRecord = { action: 'propose-account-budget', billingSetupId: '81', proposalId: '95', budget: null, state: 'PENDING' }
    expect(billingNow(after, BILLING)).toEqual(after)
    expect(billingNow(after, { ...BILLING, proposals: [] })).toMatchObject({ state: 'decided' })
    expect(billingUndo(after, after)).toEqual({ args: { action: 'cancel-proposal', proposalId: '95' } })
  })
})
