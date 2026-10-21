/**
 * Meta step 40 — the drafts of set-meta-account-settings, set-meta-spend-cap and set-meta-insights-features, pure: the
 * Nexus safety rule (nothing changed on a disabled, risk-reviewed, closing, closed or compromised account), the exact
 * requests, what SPENDS MONEY, the spending limit in Meta's WRITE units with the currency and the decimals Nexus counted,
 * the undo arguments and what has no undo (a reset, a real end advertiser / media agency / partner, an insights feature).
 * Made-up ids and names.
 */
import { describe, expect, it } from 'vitest'
import { ACCOUNT_NOT_SENT, accountSettingsDraft, insightsFeatureDraft, metaAccountChangeRefusal, spendCapDraft, trackingView, type AccountSettingsLive } from './change-account-settings.js'
import type { LiveAccountState } from './live-account-settings.js'
import type { MetaChangeDraft } from './change-draft.js'

const PAGE = '120000000000080'
const PIXEL = '120000000000050'
const STATE: LiveAccountState = {
  adAccountId: '1234567890', status: 1, disableReason: 0, currency: 'EUR', name: 'Shop A ads',
  businessInfo: { business_name: 'Shop A', business_street: 'Via A 1', business_street2: null, business_city: 'Città A', business_state: null, business_zip: '00100', business_country_code: 'IT' },
  businessUse: true, dsa: { payor: null, beneficiary: null }, notifications: true,
  parties: { end_advertiser: null, media_agency: 'NONE', partner: 'UNFOUND' }, spendCap: '50000', amountSpent: '12000', pageId: PAGE,
}
const state = (o: Partial<LiveAccountState> = {}): LiveAccountState => ({ ...structuredClone(STATE), ...o })
const live = (o: Partial<AccountSettingsLive> = {}): AccountSettingsLive => ({ state: state(), ...o })
const ok = (d: MetaChangeDraft | { refusal: string }): MetaChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refusal = (d: MetaChangeDraft | { refusal: string }) => ('refusal' in d ? d.refusal : null)

describe('the Nexus safety rule: no change of a disabled ad account', () => {
  it('refuses account_status 2, 7, 100, 101 and disable_reason 15 in words; any other status passes', () => {
    for (const status of [2, 7, 100, 101]) expect(metaAccountChangeRefusal({ adAccountId: '1234567890', status, disableReason: 0 }), String(status)).toMatch(/^Nothing was asked of Meta: ad account 1234567890 is .*Nexus changes nothing on an ad account Meta has disabled/)
    expect(metaAccountChangeRefusal({ adAccountId: '1234567890', status: 1, disableReason: 15 })).toMatch(/reason: Compromised ad account/)
    for (const status of [1, 3, 8, 9]) expect(metaAccountChangeRefusal({ adAccountId: '1234567890', status, disableReason: 0 }), String(status)).toBeNull()
    expect(metaAccountChangeRefusal({ adAccountId: '1234567890', status: null, disableReason: null })).toMatch(/cannot confirm it is not disabled/)
    expect(metaAccountChangeRefusal({ adAccountId: '1234567890', status: 2, disableReason: 3 })).toMatch(/payment risk/)
  })
  it('every draft refuses first, before anything else is judged', () => {
    const disabled = state({ status: 2 })
    expect(refusal(accountSettingsDraft({ name: 'Shop B' }, { state: disabled }))).toMatch(/is disabled/)
    expect(refusal(spendCapDraft({ action: 'lower', capCents: 10000 }, disabled, 'EUR'))).toMatch(/is disabled/)
    expect(refusal(insightsFeatureDraft('comscore', disabled, { name: 'comscore', offered: true, enabled: false, dataFrom: null }))).toMatch(/is disabled/)
    expect(refusal(spendCapDraft({ action: 'remove' }, state({ disableReason: 15 }), 'EUR'))).toMatch(/Compromised/)
  })
})

describe('set-meta-account-settings', () => {
  it('a rename: one POST /act_<id> with name, read back in the same request, undo the old name; Meta has no check', () => {
    const d = ok(accountSettingsDraft({ name: 'Shop A — new 🏍️' }, live()))
    expect(d.requests).toHaveLength(1)
    expect(d.requests[0]).toMatchObject({ objectId: 'act_1234567890', objectKind: 'adaccount', params: { name: 'Shop A — new 🏍️' }, check: 'none', readBackInPost: true, operation: 'account.settings', expect: { name: 'Shop A — new 🏍️' }, readBackFields: 'id,name', raisesSpend: false })
    expect(d.spendsMoney).toEqual([])
    expect((d.before as { undo: unknown }).undo).toEqual({ name: 'Shop A ads' })
    expect(d.warnings.join(' ')).toMatch(/Meta has no check for an ad account change/)
    // Fix round 1 (B-6) — Meta reads the first admin's name for an unnamed account: the undo could write a person's name.
    expect(d.warnings.join(' ')).toMatch(/first admin's name .* PERSON's name/)
    // Fix round 1 (B-5) — currency and time zone: not sent by Nexus; Meta's v26 Updating table lists neither.
    expect(ACCOUNT_NOT_SENT.join(' ')).toMatch(/Nexus does not send them .*Updating table .* lists neither/)
    expect(refusal(accountSettingsDraft({ name: 'Shop A ads' }, live()))).toMatch(/already named/)
    expect(refusal(accountSettingsDraft({}, live()))).toMatch(/attribution per ad set \(set-meta-ad-set/)
  })
  it('business info: business-use accounts only; the seven keys merged (unchanged ones as they are); undo the old parts', () => {
    expect(refusal(accountSettingsDraft({ businessInfo: { city: 'Città B' } }, live({ state: state({ businessUse: false }) })))).toMatch(/personal purposes/)
    const d = ok(accountSettingsDraft({ businessInfo: { city: 'Città B', street2: 'Scala B', zip: null } }, live()))
    expect(JSON.parse(d.requests[0].params.business_info)).toEqual({ business_name: 'Shop A', business_street: 'Via A 1', business_street2: 'Scala B', business_city: 'Città B', business_zip: '', business_country_code: 'IT' })
    // Fix round 1 (B-4) — every key sent is read back and judged, the unchanged ones too.
    expect(d.requests[0].expect).toEqual({ business_name: 'Shop A', business_street: 'Via A 1', business_street2: 'Scala B', business_city: 'Città B', business_zip: '', business_country_code: 'IT' })
    expect(d.requests[0].readBackFields!.split(',')).toEqual(expect.arrayContaining(['business_name', 'business_street', 'business_street2', 'business_city', 'business_state', 'business_zip', 'business_country_code']))
    expect((d.before as { undo: Record<string, unknown> }).undo.businessInfo).toEqual({ street2: null, city: 'Città A', zip: '00100' })
    expect(d.warnings.join(' ')).toMatch(/LIVE-PROBES AA-041/)
  })
  it('EU payer and beneficiary: both or clear both; the undo puts back the pair (or clears it)', () => {
    const set = ok(accountSettingsDraft({ dsa: { payor: 'Shop A', beneficiary: 'Shop A' } }, live()))
    expect(set.requests[0].params).toEqual({ default_dsa_payor: 'Shop A', default_dsa_beneficiary: 'Shop A' })
    expect((set.before as { undo: unknown }).undo).toEqual({ dsa: { clear: true } })
    const clear = ok(accountSettingsDraft({ dsa: { clear: true } }, live({ state: state({ dsa: { payor: 'Shop A', beneficiary: 'Shop B' } }) })))
    expect(clear.requests[0].params).toEqual({ default_dsa_payor: '', default_dsa_beneficiary: '' })
    expect((clear.before as { undo: unknown }).undo).toEqual({ dsa: { payor: 'Shop A', beneficiary: 'Shop B' } })
    expect(clear.warnings.join(' ')).toMatch(/needs its own \(set-meta-ad-set dsa\)/)
    expect(refusal(accountSettingsDraft({ dsa: { clear: true } }, live()))).toMatch(/no EU payer and beneficiary to clear/)
  })
  it('notifications: says plainly they are the SYSTEM USER\'s own, not the Owner\'s', () => {
    const d = ok(accountSettingsDraft({ notifications: false }, live()))
    expect(d.requests[0].params).toEqual({ is_notifications_enabled: 'false' })
    expect(d.warnings.join(' ')).toMatch(/SYSTEM USER's own notifications for the account — not the Owner's/)
    expect((d.before as { undo: unknown }).undo).toEqual({ notifications: true })
  })
  it('end advertiser / media agency / partner: the chosen Page is FOR GOOD (no undo, said); a real media agency is never changed', () => {
    const d = ok(accountSettingsDraft({ endAdvertiser: 'chosen-page' }, live()))
    expect(d.requests[0].params).toEqual({ end_advertiser: PAGE })
    expect(d.warnings.join(' ')).toMatch(/cannot be changed again after this .*one-way/)
    expect((d.before as { undo: unknown; noUndo: string[] }).undo).toBeNull()
    expect((d.before as { noUndo: string[] }).noUndo.join(' ')).toMatch(/FOR GOOD/)
    expect(refusal(accountSettingsDraft({ mediaAgency: 'chosen-page' }, live({ state: state({ parties: { end_advertiser: null, media_agency: '120000000000099', partner: null } }) })))).toMatch(/cannot be changed any more/)
    // Fix round 1 (B-2) — a set end advertiser too (reference/ad-account Creating: "you cannot change it").
    expect(refusal(accountSettingsDraft({ endAdvertiser: 'chosen-page' }, live({ state: state({ parties: { end_advertiser: '120000000000099', media_agency: 'NONE', partner: null } }) })))).toMatch(/end advertiser is set .*Creating \/\{business_id\}\/adaccount/)
    expect(refusal(accountSettingsDraft({ endAdvertiser: 'NONE' }, live({ state: state({ parties: { end_advertiser: '120000000000099', media_agency: 'NONE', partner: null } }) })))).toMatch(/cannot be changed any more/)
    expect(refusal(accountSettingsDraft({ partner: 'chosen-page' }, live({ state: state({ pageId: null }) })))).toMatch(/no Page chosen/)
    const back = ok(accountSettingsDraft({ mediaAgency: 'UNFOUND' }, live()))
    expect((back.before as { undo: unknown }).undo).toEqual({ mediaAgency: 'NONE' })
  })
  it('the agency declaration: read first (a Business Manager admin only), merged, never an e-mail; undo the old one', () => {
    expect(refusal(accountSettingsDraft({ agencyDeclaration: { confirmAgency: true, clientName: 'Client A' } }, live({ agency: { notRead: 'Meta refused it (200).' } })))).toMatch(/Business Manager admin/)
    const d = ok(accountSettingsDraft({ agencyDeclaration: { confirmAgency: true, clientName: 'Client B', clientPaysInvoices: true } }, live({ agency: { declaration: { client_name: 'Client A', agency_representing_client: '1' } } })))
    expect(JSON.parse(d.requests[0].params.agency_client_declaration)).toEqual({ agency_representing_client: '1', client_name: 'Client B', is_client_paying_invoices: '1' })
    expect(d.requests[0].params.agency_client_declaration).not.toMatch(/email/)
    expect((d.before as { undo: unknown }).undo).toEqual({ agencyDeclaration: { confirmAgency: true, clientName: 'Client A', agencyRepresentingClient: true } })
    expect(d.warnings.join(' ')).toMatch(/only for an AGENCY that runs ads for a client/)
  })
  it('tracking specs: the whole list on act_<id>/tracking, a second request; own pixels and the chosen Page only; foreign specs never risked', () => {
    const current = [{ 'action.type': ['offsite_conversion'], fb_pixel: [PIXEL] }]
    const d = ok(accountSettingsDraft({ name: 'Shop B', trackingSpecs: [{ kind: 'pixel', pixelId: PIXEL }, { kind: 'page', action: 'like' }] }, live({ tracking: current, pixels: new Set([PIXEL]) })))
    expect(d.requests.map((r) => [r.step, r.operation, r.edge ?? null])).toEqual([[1, 'account.settings', null], [2, 'account.tracking', 'tracking']])
    expect(JSON.parse(d.requests[1].params.tracking_specs)).toEqual([{ 'action.type': ['like'], page: [PAGE] }, { 'action.type': ['offsite_conversion'], fb_pixel: [PIXEL] }])
    expect((d.before as { undo: Record<string, unknown> }).undo.trackingSpecs).toEqual([{ kind: 'pixel', pixelId: PIXEL }])
    expect(d.warnings.join(' ')).toMatch(/adds to the list or replaces it is not documented \(LIVE-PROBES AA-054\)/)
    expect(d.warnings.join(' ')).toMatch(/30 s/)
    expect(refusal(accountSettingsDraft({ trackingSpecs: [{ kind: 'pixel', pixelId: '120000000000051' }] }, live({ tracking: [], pixels: new Set([PIXEL]) })))).toMatch(/not one of the chosen ad account's own pixels/)
    expect(refusal(accountSettingsDraft({ trackingSpecs: [] }, live({ tracking: [{ 'action.type': ['app_install'], application: ['1'] }], pixels: null })))).toMatch(/does not send.*could drop those/)
    expect(refusal(accountSettingsDraft({ trackingSpecs: [{ kind: 'pixel', pixelId: PIXEL }] }, live({ tracking: [{ 'action.type': 'offsite_conversion', fb_pixel: Number(PIXEL) }], pixels: new Set([PIXEL]) })))).toMatch(/already as asked/)
    expect(trackingView([{ fb_pixel: [PIXEL], 'action.type': ['offsite_conversion'] }])).toBe(trackingView(current))
    // Fix round 1 (A-F4) — a live spec on another Page, or of a pixel not the account's own, is never risked (its undo could not put it back).
    expect(refusal(accountSettingsDraft({ trackingSpecs: [{ kind: 'pixel', pixelId: PIXEL }] }, live({ tracking: [{ 'action.type': ['like'], page: ['120000000000099'] }], pixels: new Set([PIXEL]) })))).toMatch(/does not send/)
    expect(refusal(accountSettingsDraft({ trackingSpecs: [{ kind: 'pixel', pixelId: PIXEL }] }, live({ tracking: [{ 'action.type': ['offsite_conversion'], fb_pixel: ['120000000000051'] }], pixels: new Set([PIXEL]) })))).toMatch(/does not send/)
    // Fix round 1 (B-3) — never an empty list; the first specs of an account have no undo (no API removes one).
    expect(refusal(accountSettingsDraft({ trackingSpecs: [] }, live({ tracking: current, pixels: new Set([PIXEL]) })))).toMatch(/does not send an empty list/)
    const first = ok(accountSettingsDraft({ trackingSpecs: [{ kind: 'pixel', pixelId: PIXEL }] }, live({ tracking: [], pixels: new Set([PIXEL]) })))
    expect((first.before as { undo: unknown }).undo).toBeNull()
    expect((first.before as { noUndo: string[] }).noUndo.join(' ')).toMatch(/may stay FOR GOOD/)
  })
})

describe('set-meta-spend-cap', () => {
  it('a raise: Meta\'s standard string with the currency and the decimals Nexus counted, SPENDS MONEY, undo the old limit', () => {
    const d = ok(spendCapDraft({ action: 'raise', capCents: 75000 }, state(), 'EUR'))
    expect(d.requests[0]).toMatchObject({ objectId: 'act_1234567890', objectKind: 'adaccount', params: { spend_cap: '750.00' }, expect: { spend_cap: '75000', currency: 'EUR' }, readBackFields: 'id,spend_cap,amount_spent,currency', raisesSpend: true, readBackInPost: true, check: 'none', operation: 'account.spendCap' })
    expect(Object.values(d.changes)[0]).toEqual({ from: '500.00 EUR (Meta reads 50000 in hundredths of EUR)', to: '"750.00" EUR — Nexus counted 75000 minor units in 2 decimals (750.00 EUR); Meta takes the limit in the currency\'s standard units' })
    expect(d.spendsMoney).toEqual(['The spending limit goes up from 500.00 EUR to 750.00 EUR: the account can spend 250.00 EUR more before Meta pauses its campaigns.'])
    expect((d.before as { undo: unknown }).undo).toEqual({ action: 'set', capCents: 50000 })
    expect(d.warnings.join(' ')).toMatch(/10 spending-limit changes a day/)
    expect(refusal(spendCapDraft({ action: 'raise', capCents: 40000 }, state(), 'EUR'))).toMatch(/not higher than the limit now/)
    expect(refusal(spendCapDraft({ action: 'raise', capCents: 40000 }, state({ spendCap: '0' }), 'EUR'))).toMatch(/no spending limit to raise/)
  })
  it('a lower limit, or a first limit, is not SPENDS MONEY; a limit at or below the amount spent is said', () => {
    const lower = ok(spendCapDraft({ action: 'lower', capCents: 10000 }, state(), 'EUR'))
    expect(lower.spendsMoney).toEqual([])
    expect(lower.requests[0].raisesSpend).toBe(false)
    expect(lower.warnings.join(' ')).toMatch(/not above what the account has spent against it \(120\.00 EUR\)/)
    const first = ok(spendCapDraft({ action: 'set', capCents: 30000 }, state({ spendCap: '0' }), 'EUR'))
    expect(first.spendsMoney).toEqual([])
    expect((first.before as { undo: unknown }).undo).toEqual({ action: 'remove' })
    expect(refusal(spendCapDraft({ action: 'lower', capCents: 60000 }, state(), 'EUR'))).toMatch(/not lower/)
    expect(ok(spendCapDraft({ action: 'set', capCents: 60000 }, state(), 'EUR')).spendsMoney).toHaveLength(1)
    expect(refusal(spendCapDraft({ action: 'set', capCents: 50000 }, state(), 'EUR'))).toMatch(/already 500\.00 EUR/)
  })
  it('0 is refused (Meta reads it as no limit); an amount Meta cannot hold exactly is refused, never rounded', () => {
    expect(refusal(spendCapDraft({ action: 'set', capCents: 0 }, state(), 'EUR'))).toMatch(/0 means "no limit"/)
    expect(refusal(spendCapDraft({ action: 'set' }, state(), 'EUR'))).toMatch(/names the new limit/)
    // TWD: Nexus counts 2 decimals, Meta whole units — 12.50 cannot go; 12.00 goes as "12".
    expect(refusal(spendCapDraft({ action: 'set', capCents: 1250 }, state({ currency: 'TWD', spendCap: '0' }), 'TWD'))).toMatch(/counts TWD in whole units/)
    const twd = ok(spendCapDraft({ action: 'set', capCents: 1200 }, state({ currency: 'TWD', spendCap: '0' }), 'TWD'))
    expect(twd.requests[0].params).toEqual({ spend_cap: '12' })
    expect(twd.requests[0].expect).toEqual({ spend_cap: '12', currency: 'TWD' })
    expect(Object.values(twd.changes)[0].to).toMatch(/^"12" TWD — Nexus counted 1200 minor units in 2 decimals/)
    // JPY: no decimals at all.
    expect(ok(spendCapDraft({ action: 'set', capCents: 125000 }, state({ currency: 'JPY', spendCap: '0' }), 'JPY')).requests[0].params).toEqual({ spend_cap: '125000' })
    // BHD: Nexus counts 3 decimals, Meta hundredths.
    expect(ok(spendCapDraft({ action: 'set', capCents: 1250 }, state({ currency: 'BHD', spendCap: '0' }), 'BHD')).requests[0].params).toEqual({ spend_cap: '1.25' })
    expect(refusal(spendCapDraft({ action: 'set', capCents: 1255 }, state({ currency: 'BHD', spendCap: '0' }), 'BHD'))).toMatch(/hundredths/)
  })
  it('the currency is Meta\'s live one; a different one in Nexus, or none, refuses', () => {
    expect(refusal(spendCapDraft({ action: 'set', capCents: 60000 }, state({ currency: 'USD' }), 'EUR'))).toMatch(/Nexus has the account in EUR, Meta now says USD/)
    expect(refusal(spendCapDraft({ action: 'set', capCents: 60000 }, state({ currency: null }), 'EUR'))).toMatch(/did not say the ad account's currency/)
  })
  it('remove: spend_cap_action=delete, SPENDS MONEY, undo sets the old limit again', () => {
    const d = ok(spendCapDraft({ action: 'remove' }, state(), 'EUR'))
    expect(d.requests[0]).toMatchObject({ params: { spend_cap_action: 'delete' }, expect: { spend_cap: '0', currency: 'EUR' }, raisesSpend: true })
    expect(d.spendsMoney[0]).toMatch(/spend without any limit/)
    expect((d.before as { undo: unknown }).undo).toEqual({ action: 'set', capCents: 50000 })
    expect(refusal(spendCapDraft({ action: 'remove' }, state({ spendCap: '0' }), 'EUR'))).toMatch(/has no spending limit/)
  })
  it('reset: spend_cap_action=reset, SPENDS MONEY when a limit is set, NO undo (said)', () => {
    const d = ok(spendCapDraft({ action: 'reset' }, state(), 'EUR'))
    expect(d.requests[0]).toMatchObject({ params: { spend_cap_action: 'reset' }, raisesSpend: true, undoable: false })
    expect(d.requests[0].expect).toEqual({ currency: 'EUR' })
    expect(d.spendsMoney[0]).toMatch(/whole limit \(500\.00 EUR\) again/)
    expect((d.before as { undo: unknown }).undo).toBeNull()
    expect(d.warnings.join(' ')).toMatch(/NO undo/)
    expect(d.requests[0].doneSentence!({ node: { amount_spent: '0' }, readBack: 'same-request', waitedMs: 0 })).toMatch(/amount spent now reads 0\.00 EUR/)
    const noCap = ok(spendCapDraft({ action: 'reset' }, state({ spendCap: '0' }), 'EUR'))
    expect(noCap.spendsMoney).toEqual([])
    expect(refusal(spendCapDraft({ action: 'reset' }, state({ amountSpent: '0' }), 'EUR'))).toMatch(/spent nothing/)
  })
  it('fix round 1 (A-F1) — a limit Meta did not send, or sent in a form Nexus cannot read, refuses: never "no limit"', () => {
    for (const cap of ['500.00', 'abc', '-1', '-50000', '5e4', '12345678901234567890', 'unsafe:1e+21', '9007199254740993', '', '050000']) {
      expect(refusal(spendCapDraft({ action: 'set', capCents: 100000000 }, state({ spendCap: cap }), 'EUR')), cap).toMatch(/cannot read .*spending limit now/)
    }
    expect(refusal(spendCapDraft({ action: 'set', capCents: 100000000 }, state({ spendCap: null }), 'EUR'))).toMatch(/did not send .*spending limit/)
    expect(refusal(spendCapDraft({ action: 'remove' }, state({ spendCap: 'abc' }), 'EUR'))).toMatch(/cannot read/)
    expect(ok(spendCapDraft({ action: 'set', capCents: 30000 }, state({ spendCap: '0' }), 'EUR')).spendsMoney).toEqual([])
  })
  it('fix round 1 (A-F3) — a limit Nexus cannot hold exactly in its minor units (PKR: 0 decimals, Meta hundredths) refuses', () => {
    expect(refusal(spendCapDraft({ action: 'lower', capCents: 100 }, state({ currency: 'PKR', spendCap: '12345' }), 'PKR'))).toMatch(/cannot show or put back exactly/)
    const exact = ok(spendCapDraft({ action: 'lower', capCents: 100 }, state({ currency: 'PKR', spendCap: '12300' }), 'PKR'))
    expect(exact.requests[0].params).toEqual({ spend_cap: '100.00' })
    expect((exact.before as { undo: unknown }).undo).toEqual({ action: 'set', capCents: 123 })
  })
  it('stands on the limit, never on the amount spent (it moves while the account delivers)', () => {
    const a = ok(spendCapDraft({ action: 'raise', capCents: 75000 }, state({ amountSpent: '12000' }), 'EUR'))
    const b = ok(spendCapDraft({ action: 'raise', capCents: 75000 }, state({ amountSpent: '12999' }), 'EUR'))
    expect(a.stands).toEqual(b.stands)
    expect(ok(spendCapDraft({ action: 'raise', capCents: 75000 }, state({ spendCap: '60000' }), 'EUR')).stands).not.toEqual(a.stands)
  })
})

describe('set-meta-insights-features', () => {
  it('one POST on act_<id>/insights/feature-settings; CANNOT BE UNDONE (said); refused when already on or not offered', () => {
    const d = ok(insightsFeatureDraft('impression_device', state(), { name: 'impression_device', offered: true, enabled: false, dataFrom: null }))
    expect(d.requests[0]).toMatchObject({ objectId: 'act_1234567890', objectKind: 'adaccount', edge: 'insights/feature-settings', params: { feature_name: 'impression_device' }, undoable: false, raisesSpend: false })
    expect(d.warnings.join(' ')).toMatch(/CANNOT BE UNDONE: Meta has no API to switch an insights feature off/)
    expect(d.warnings.join(' ')).toMatch(/does not name the permission/)
    expect(refusal(insightsFeatureDraft('comscore', state(), { name: 'comscore', offered: true, enabled: true, dataFrom: '2026-07-15' }))).toMatch(/already switched on .*data from 2026-07-15/)
    expect(refusal(insightsFeatureDraft('comscore', state(), { name: 'comscore', offered: false, enabled: false, dataFrom: null }))).toMatch(/does not list comscore/)
    expect(ok(insightsFeatureDraft('comscore', state(), { name: 'comscore', offered: null, enabled: null, dataFrom: null })).requests).toHaveLength(1)
  })
})
