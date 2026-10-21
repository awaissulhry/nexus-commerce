/**
 * Meta step 32 — the dataset, custom conversion and event source group drafts (pure): the ONE unit helper of a custom
 * conversion's default value (create only), the one view of a field, Meta's one-pixel-per-account and 100-conversions
 * rules, from → to lines, what has no undo (a value Meta did not show is never assumed), what can make the account spend
 * more (giving ad sets their dataset back — judged by the configured status of each ad set and its campaign, and never
 * "none" from a list Nexus read only in part), and what Meta cannot do by API. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import {
  accessDraft, conversionClaimDraft, conversionCreateDraft, conversionUpdateDraft, conversionValueText, datasetCreateDraft, DEFAULT_VALUE_UPDATE_HELD, EVENT_SETUP_CANNOT, groupDraft,
  pixelSettingsDraft, removeDraft, SETUP_CANNOT, signalView,
} from './change-signals.js'
import { adSetOn, type AdSetUsing, type ConversionRow, type PixelSettings } from './live-signals.js'
import type { MetaChangeDraft } from './change-draft.js'
import { conversionRuleProblem } from '../../gateway/meta-signals-rules.js'

const ACCOUNT = '1234567890'
const PORTFOLIO = '9876543210'
const PIXEL = '120000000000501'
const CC = '120000000000701'
const draft = (d: MetaChangeDraft | { refusal: string }) => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refusal = (d: MetaChangeDraft | { refusal: string }) => ('refusal' in d ? d.refusal : null)
const SETTINGS: PixelSettings = { id: PIXEL, name: 'Shop A pixel', enableAutomaticMatching: false, automaticMatchingFields: null, firstPartyCookieStatus: 'FIRST_PARTY_COOKIE_ENABLED', dataUseSetting: 'ADVERTISING_AND_ANALYTICS', ownerBusinessId: PORTFOLIO, isUnavailable: false }
const ROW: ConversionRow = { id: CC, name: 'Thank you page', description: null, customEventType: 'PURCHASE', defaultValue: '10', pixelId: PIXEL, rule: '{"url":{"i_contains":"thank-you"}}', isArchived: false, isUnavailable: false, businessId: null }
const noAdSets = { adSets: [], more: false }
const adSet = (status: string | null, campaignStatus: string | null = 'ACTIVE'): AdSetUsing => ({ id: '120000000000002', name: 'Ad set B', status, campaignStatus, on: adSetOn(status, campaignStatus) })
const using = (status: string | null, campaignStatus: string | null = 'ACTIVE', more = false) => ({ adSets: [adSet(status, campaignStatus)], more })

describe('units and views', () => {
  it('a default value: minor units → Meta\'s plain decimal of the currency (create only)', () => {
    expect(conversionValueText(1250, 'EUR')).toBe('12.5')
    expect(conversionValueText(1200, 'EUR')).toBe('12')
    expect(conversionValueText(5, 'EUR')).toBe('0.05')
    expect(conversionValueText(0, 'EUR')).toBe('0')
    expect(conversionValueText(500, 'JPY')).toBe('500')
    expect(conversionValueText(1001, 'KWD')).toBe('1.001')
    expect(() => conversionValueText(1.5, 'EUR')).toThrow()
  })
  it('one view of a field: lists sorted, JSON lists and Meta\'s lists the same, objects by id', () => {
    expect(signalView(['ph', 'em'])).toBe(signalView('["em","ph"]'))
    expect(signalView([{ id: '2' }, { id: '1' }])).toBe('["1","2"]')
    expect(signalView(true)).toBe('true')
    expect(signalView('')).toBeNull()
  })
  it('review A2 — an ad set is off only by its own or its campaign\'s configured status; unknown counts as on', () => {
    expect(adSetOn('ACTIVE', 'ACTIVE')).toBe(true)
    expect(adSetOn('ACTIVE', 'PAUSED')).toBe(false)
    expect(adSetOn('PAUSED', 'ACTIVE')).toBe(false)
    expect(adSetOn('ARCHIVED', null)).toBe(false)
    expect(adSetOn(null, null)).toBe(true)
    expect(adSetOn('IN_PROCESS', 'ACTIVE')).toBe(true)
  })
})

describe('create-meta-dataset', () => {
  it('Meta makes one pixel per ad account: refused when the account has one (6200), with the way to a second; ids only', () => {
    expect(refusal(datasetCreateDraft({ level: 'adAccount', name: 'Shop A' }, { adAccountId: ACCOUNT, existing: [PIXEL] }))).toMatch(new RegExp(`${PIXEL}.*6200.*level business`))
  })
  it('a create on the account\'s adspixels edge with its name only; no undo (a dataset cannot be deleted)', () => {
    const d = draft(datasetCreateDraft({ level: 'adAccount', name: 'Shop A' }, { adAccountId: ACCOUNT, existing: [] }))
    expect(d.requests).toMatchObject([{ objectKind: 'adaccount', objectId: `act_${ACCOUNT}`, edge: 'adspixels', params: { name: 'Shop A' }, operation: 'dataset.create', check: 'none', raisesSpend: false, undoable: false }])
    expect(d.warnings.join(' ')).toMatch(/cannot be deleted/)
    expect(d.spendsMoney).toEqual([])
  })
  it('business level is the SDK route (terms, connect after); page / Instagram send dataset_name and say the permission', () => {
    const b = draft(datasetCreateDraft({ level: 'business', name: 'Shop A 2' }, { adAccountId: ACCOUNT, objectId: PORTFOLIO }))
    expect(b.requests[0]).toMatchObject({ objectKind: 'datasetportfolio', objectId: PORTFOLIO, edge: 'adspixels', operation: 'dataset.createInBusiness' })
    expect(b.warnings.join(' ')).toMatch(/SDK.*Business Tools terms/)
    const p = draft(datasetCreateDraft({ level: 'page', name: 'Shop A chats' }, { adAccountId: ACCOUNT, objectId: '120000000000010' }))
    expect(p.requests[0]).toMatchObject({ objectKind: 'page', edge: 'dataset', params: { dataset_name: 'Shop A chats' } })
    expect(p.warnings.join(' ')).toMatch(/page_events/)
  })
})

describe('set-meta-dataset: a pixel\'s settings', () => {
  it('from → to only for what moves; undo holds the old values; the GDPR sentence for automatic matching', () => {
    const d = draft(pixelSettingsDraft({ pixelId: PIXEL, name: 'Shop A', automaticMatching: { enabled: true, fields: ['ph', 'em'] }, dataUse: 'ADVERTISING_AND_ANALYTICS' }, { settings: SETTINGS, adSetsUsing: noAdSets }))
    expect(d.requests[0].params).toEqual({ name: 'Shop A', enable_automatic_matching: 'true', automatic_matching_fields: '["em","ph"]' })
    expect(d.requests[0].expect).toEqual({ name: 'Shop A', enable_automatic_matching: 'true' })
    expect(d.skipped.join(' ')).toMatch(/data use is already/)
    expect(d.warnings.join(' ')).toMatch(/GDPR/)
    expect((d.before as { undo: unknown }).undo).toEqual({ tool: 'set-meta-dataset', args: { pixelId: PIXEL, name: 'Shop A pixel', automaticMatching: { enabled: false } } })
  })
  it('analytics only lists the ad sets that lose the signal', () => {
    const d = draft(pixelSettingsDraft({ pixelId: PIXEL, dataUse: 'ANALYTICS_ONLY' }, { settings: SETTINGS, adSetsUsing: using('ACTIVE') }))
    expect(d.warnings.join(' ')).toMatch(/1 ad set optimise on it.*Ad set B/)
    expect(d.spendsMoney).toEqual([])
    expect((d.before as { undo: { args: Record<string, unknown> } }).undo.args).toMatchObject({ dataUse: 'ADVERTISING_AND_ANALYTICS' })
  })
  it('review A6 — a value Meta did not show is never taken for EMPTY: it is sent, and undo says it cannot put it back', () => {
    const d = draft(pixelSettingsDraft({ pixelId: PIXEL, firstPartyCookieStatus: 'EMPTY', dataUse: 'EMPTY' }, { settings: { ...SETTINGS, firstPartyCookieStatus: null, dataUseSetting: null }, adSetsUsing: noAdSets }))
    expect(d.requests[0].params).toEqual({ first_party_cookie_status: 'EMPTY', data_use_setting: 'EMPTY' })
    expect(d.before).toMatchObject({ undo: null, noUndo: [expect.stringMatching(/first-party cookie/), expect.stringMatching(/data use/)] })
  })
  it('data use back to ads lets ad sets deliver again: SPENDS MONEY by the configured status of the ad set AND its campaign', () => {
    const back = (adSetsUsing: { adSets: AdSetUsing[]; more: boolean }, from: string | null = 'ANALYTICS_ONLY') =>
      draft(pixelSettingsDraft({ pixelId: PIXEL, dataUse: 'ADVERTISING_AND_ANALYTICS' }, { settings: { ...SETTINGS, dataUseSetting: from }, adSetsUsing }))
    const on = back(using('ACTIVE'))
    expect(on.spendsMoney[0]).toMatch(/1 is on now/)
    expect(on.requests[0].raisesSpend).toBe(true)
    // Its campaign paused: nothing spends yet (an ad set's own ACTIVE is not enough).
    expect(back(using('ACTIVE', 'PAUSED')).spendsMoney[0]).toMatch(/nothing spends yet/)
    // A status Meta did not give counts as on.
    expect(back(using(null, null)).spendsMoney[0]).toMatch(/1 is on now/)
    // Review A3 — none matched among the first 500 ad sets: still SPENDS MONEY.
    expect(back({ adSets: [], more: true }).spendsMoney[0]).toMatch(/read only the first 500 ad sets/)
    expect(back(using('PAUSED', 'ACTIVE', true)).spendsMoney[0]).toMatch(/ones beyond them may be/)
    // From a data use Meta did not show (it may have been analytics only): SPENDS MONEY all the same.
    expect(back(using('ACTIVE'), null).spendsMoney).toHaveLength(1)
    expect(back(noAdSets).spendsMoney).toEqual([])
  })
  it('nothing to change, or matching fields while switching it off, is refused in words', () => {
    expect(refusal(pixelSettingsDraft({ pixelId: PIXEL, name: 'Shop A pixel' }, { settings: SETTINGS, adSetsUsing: noAdSets }))).toMatch(/Nothing to change/)
    expect(refusal(pixelSettingsDraft({ pixelId: PIXEL, automaticMatching: { enabled: false, fields: ['em'] } }, { settings: SETTINGS, adSetsUsing: noAdSets }))).toMatch(/enabled true/)
  })
  it('says what Meta cannot change by API, and where the reads are', () => {
    expect(SETUP_CANNOT).toMatch(/event rules, parameter extractors, domain-control rules or traffic permissions/)
    expect(SETUP_CANNOT).toMatch(/view event-setup.*does not read traffic permissions yet/)
  })
})

describe('set-meta-dataset: an event source group', () => {
  it('create: one request on the portfolio\'s edge, sorted datasets, no way back', () => {
    const d = draft(groupDraft({ action: 'create', name: 'Group A', pixelIds: ['3', '1'] }, { portfolio: PORTFOLIO, adAccountId: ACCOUNT }))
    expect(d.requests[0]).toMatchObject({ objectKind: 'datasetportfolio', objectId: PORTFOLIO, edge: 'event_source_groups', params: { event_sources: '["1","3"]', name: 'Group A' } })
    expect(d.before).toMatchObject({ undo: null })
  })
  it('update: from → to and its undo; share: the chosen ad account only', () => {
    const group = { id: '120000000000801', name: 'Group A', pixelIds: ['1'] }
    const u = draft(groupDraft({ action: 'update', groupId: group.id, pixelIds: ['1', '2'] }, { portfolio: PORTFOLIO, adAccountId: ACCOUNT, group }))
    expect(u.requests[0].params).toEqual({ event_sources: '["1","2"]' })
    expect((u.before as { undo: unknown }).undo).toEqual({ tool: 'set-meta-dataset', args: { eventSourceGroup: { action: 'update', groupId: group.id, pixelIds: ['1'] } } })
    const s = draft(groupDraft({ action: 'share', groupId: group.id }, { portfolio: PORTFOLIO, adAccountId: ACCOUNT, group }))
    expect(s.requests[0]).toMatchObject({ objectKind: 'eventsourcegroup', edge: 'shared_accounts', params: { accounts: `["${ACCOUNT}"]` } })
  })
})

describe('set-meta-dataset-access: the chosen ad account only', () => {
  const facts = { pixelId: PIXEL, pixelName: 'Shop A pixel', adAccountId: ACCOUNT, portfolio: PORTFOLIO, ownerBusinessId: PORTFOLIO }
  it('connect / disconnect name the chosen ad account and its portfolio only; disconnect lists the ad sets that lose it', () => {
    const c = draft(accessDraft({ pixelId: PIXEL, action: 'connect-ad-account' }, { ...facts, connected: false, adSetsUsing: noAdSets }))
    expect(c.requests[0]).toMatchObject({ edge: 'shared_accounts', params: { account_id: ACCOUNT, business: PORTFOLIO } })
    expect(c.spendsMoney).toEqual([])
    expect(refusal(accessDraft({ pixelId: PIXEL, action: 'connect-ad-account' }, { ...facts, connected: true }))).toMatch(/already connected/)
    const d = draft(accessDraft({ pixelId: PIXEL, action: 'disconnect-ad-account' }, { ...facts, connected: true, adSetsUsing: using('ACTIVE') }))
    expect(d.requests[0]).toMatchObject({ method: 'DELETE', params: { account_id: ACCOUNT, business: PORTFOLIO } })
    expect(d.warnings.join(' ')).toMatch(/1 ad set .*Ad set B/)
    expect((d.before as { undo: unknown }).undo).toEqual({ tool: 'set-meta-dataset-access', args: { pixelId: PIXEL, action: 'connect-ad-account' } })
    // A dataset another portfolio owns: disconnecting it cannot be undone from Nexus.
    expect((draft(accessDraft({ pixelId: PIXEL, action: 'disconnect-ad-account' }, { ...facts, ownerBusinessId: '111', connected: true })).before as { undo: unknown }).undo).toBeNull()
  })
  it('connecting a dataset ad sets optimise on is SPENDS MONEY; a list read in part is never "none"', () => {
    const back = draft(accessDraft({ pixelId: PIXEL, action: 'connect-ad-account' }, { ...facts, connected: false, adSetsUsing: using('ACTIVE') }))
    expect(back.spendsMoney[0]).toMatch(/Connecting it lets 1 ad set .*1 is on now/)
    expect(back.requests[0].raisesSpend).toBe(true)
    expect(draft(accessDraft({ pixelId: PIXEL, action: 'connect-ad-account' }, { ...facts, connected: false, adSetsUsing: { adSets: [], more: true } })).spendsMoney[0]).toMatch(/first 500/)
  })
})

describe('set-meta-custom-conversion', () => {
  const rule = { or: [{ url: { i_contains: 'thank-you' } }] }
  it('counts first: at 100 refused; a list Meta cut is not counted (refused)', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ ...ROW, id: String(i + 1) }))
    expect(refusal(conversionCreateDraft({ name: 'X', pixelId: PIXEL, rule, eventType: 'PURCHASE' }, { adAccountId: ACCOUNT, currency: 'EUR', conversions: many, complete: true, pixelName: null }))).toMatch(/at most 100/)
    expect(refusal(conversionCreateDraft({ name: 'X', pixelId: PIXEL, rule, eventType: 'PURCHASE' }, { adAccountId: ACCOUNT, currency: 'EUR', conversions: [], complete: false, pixelName: null }))).toMatch(/cannot count/)
  })
  it('create: the rule as JSON in one spelling, the value in currency units, the rule fixed said', () => {
    const d = draft(conversionCreateDraft({ name: 'Thanks', pixelId: PIXEL, rule, eventType: 'PURCHASE', defaultValueCents: 1250 }, { adAccountId: ACCOUNT, currency: 'EUR', conversions: [ROW], complete: true, pixelName: 'Shop A pixel' }))
    expect(d.requests[0]).toMatchObject({ objectKind: 'adaccount', objectId: `act_${ACCOUNT}`, edge: 'customconversions', undoable: false, params: { name: 'Thanks', event_source_id: PIXEL, rule: '{"or":[{"url":{"i_contains":"thank-you"}}]}', custom_event_type: 'PURCHASE', default_conversion_value: '12.5' } })
    expect(d.warnings.join(' ')).toMatch(/never change.*2 of the 100/s)
    expect(refusal(conversionCreateDraft({ name: 'X', pixelId: PIXEL, rule: { url: { is_any: ['a'] } }, eventType: 'PURCHASE' }, { adAccountId: ACCOUNT, currency: 'EUR', conversions: [], complete: true, pixelName: null }))).toMatch(/not a custom conversion operator/)
  })
  it('review B1 — update: name and description only; a default value is refused (its read-back unit is not documented)', () => {
    expect(refusal(conversionUpdateDraft({ customConversionId: CC, defaultValueCents: 2000 }, { row: ROW }))).toBe(DEFAULT_VALUE_UPDATE_HELD)
    const d = draft(conversionUpdateDraft({ customConversionId: CC, name: 'Thanks' }, { row: ROW }))
    expect(d.requests[0]).toMatchObject({ objectKind: 'datasetconversion', params: { name: 'Thanks' }, raisesSpend: false })
    expect(d.spendsMoney).toEqual([])
    expect((d.before as { undo: { args: unknown } }).undo.args).toEqual({ action: 'update', customConversionId: CC, name: 'Thank you page' })
    expect(refusal(conversionUpdateDraft({ customConversionId: CC, name: 'X' }, { row: { ...ROW, isUnavailable: true } }))).toMatch(/2460004/)
  })
  it('review B2 — claim only one no portfolio holds: the chosen one\'s needs nothing, another\'s is refused', () => {
    expect(draft(conversionClaimDraft({ row: ROW, portfolio: PORTFOLIO })).requests[0]).toMatchObject({ objectKind: 'datasetportfolio', objectId: PORTFOLIO, params: { custom_conversion_id: CC } })
    expect(refusal(conversionClaimDraft({ row: { ...ROW, businessId: PORTFOLIO }, portfolio: PORTFOLIO }))).toMatch(/Nothing to change/)
    expect(refusal(conversionClaimDraft({ row: { ...ROW, businessId: '5555' }, portfolio: PORTFOLIO }))).toMatch(/another business portfolio/)
  })
})

describe('remove-meta-signal-items', () => {
  it('a custom conversion is one DELETE; an event rule or a parameter extractor answers that Meta cannot', () => {
    const d = draft(removeDraft([{ kind: 'customConversion', id: CC }, { kind: 'eventRule', id: '5' }], { conversions: [{ row: ROW, adSetsUsing: using('ACTIVE') }] }))
    expect(d.requests).toMatchObject([{ objectKind: 'datasetconversion', objectId: CC, method: 'DELETE', params: {}, undoable: false }])
    expect(d.skipped[0]).toContain(EVENT_SETUP_CANNOT)
    expect(d.warnings.join(' ')).toMatch(/for good.*Ad set B/s)
    expect(refusal(removeDraft([{ kind: 'parameterExtractor', id: '6' }], { conversions: [] }))).toMatch(/Meta cannot change this by API/)
  })
})

describe('the rule judge (gateway and tool alike)', () => {
  it('takes Meta\'s documented examples; refuses depth, too many conditions, a text compared as a number', () => {
    expect(conversionRuleProblem({ and: [{ event: { eq: 'Purchase' } }, { value: { gt: 100 } }] })).toBeNull()
    expect(conversionRuleProblem({ or: [{ url: { i_contains: 'thankyou.html' } }, { url: { i_contains: 'confirmation.html' } }] })).toBeNull()
    expect(conversionRuleProblem({ and: [{ or: [{ and: [{ url: { eq: 'a' } }] }] }] })).toMatch(/3 levels/)
    expect(conversionRuleProblem({ or: Array.from({ length: 11 }, () => ({ url: { eq: 'a' } })) })).toMatch(/1 to 10/)
    expect(conversionRuleProblem({ value: { gt: '100' } })).toMatch(/number/)
    expect(conversionRuleProblem({ URL: { eq: 'a' } })).toMatch(/not a rule field/)
  })
})
