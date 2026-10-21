/**
 * Meta step 32 — the dataset, custom conversion and event source group drafts (pure): the ONE unit helper of a custom
 * conversion's default value, the one view of a field, Meta's one-pixel-per-account and 100-conversions rules, from → to
 * lines, what has no undo, the one SPENDS MONEY case (a default-value raise while ad sets optimise on it), and what Meta
 * cannot do by API (event rules, parameter extractors, traffic permissions). Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import {
  accessDraft, conversionCreateDraft, conversionUpdateDraft, conversionValueCents, conversionValueText, datasetCreateDraft, EVENT_SETUP_CANNOT, groupDraft, pixelSettingsDraft, removeDraft,
  signalView,
} from './change-signals.js'
import type { ConversionRow, PixelSettings } from './live-signals.js'
import type { MetaChangeDraft } from './change-draft.js'
import { conversionRuleProblem } from '../../gateway/meta-signals-rules.js'

const ACCOUNT = '1234567890'
const PORTFOLIO = '9876543210'
const PIXEL = '120000000000501'
const CC = '120000000000701'
const draft = (d: MetaChangeDraft | { refusal: string }) => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refusal = (d: MetaChangeDraft | { refusal: string }) => ('refusal' in d ? d.refusal : null)
const SETTINGS: PixelSettings = { id: PIXEL, name: 'Shop A pixel', enableAutomaticMatching: false, automaticMatchingFields: null, firstPartyCookieStatus: 'FIRST_PARTY_COOKIE_ENABLED', dataUseSetting: 'ADVERTISING_AND_ANALYTICS', ownerBusinessId: PORTFOLIO, isUnavailable: false }
const ROW: ConversionRow = { id: CC, name: 'Thank you page', description: null, customEventType: 'PURCHASE', defaultValue: '10', pixelId: PIXEL, rule: '{"url":{"i_contains":"thank-you"}}', isArchived: false, isUnavailable: false }
const noAdSets = { adSets: [], more: false }

describe('units: a custom conversion\'s default value (one helper, both ways)', () => {
  it('minor units → Meta\'s plain decimal of the currency, and back', () => {
    expect(conversionValueText(1250, 'EUR')).toBe('12.5')
    expect(conversionValueText(1200, 'EUR')).toBe('12')
    expect(conversionValueText(5, 'EUR')).toBe('0.05')
    expect(conversionValueText(0, 'EUR')).toBe('0')
    expect(conversionValueText(500, 'JPY')).toBe('500')
    expect(conversionValueText(1001, 'KWD')).toBe('1.001')
    expect(() => conversionValueText(1.5, 'EUR')).toThrow()
    expect(conversionValueCents('12.5', 'EUR')).toBe(1250)
    expect(conversionValueCents('10', 'EUR')).toBe(1000)
    expect(conversionValueCents('500', 'JPY')).toBe(500)
    expect(conversionValueCents(null, 'EUR')).toBeNull()
  })
  it('one view of a field: lists sorted, JSON lists and Meta\'s lists the same, objects by id', () => {
    expect(signalView(['ph', 'em'])).toBe(signalView('["em","ph"]'))
    expect(signalView([{ id: '2' }, { id: '1' }])).toBe('["1","2"]')
    expect(signalView(true)).toBe('true')
    expect(signalView('')).toBeNull()
  })
})

describe('create-meta-dataset', () => {
  it('Meta makes one pixel per ad account: refused when the account has one (6200), with the way to a second', () => {
    expect(refusal(datasetCreateDraft({ level: 'adAccount', name: 'Shop A' }, { adAccountId: ACCOUNT, existing: [PIXEL] }))).toMatch(/6200.*level business/)
    // Ids only (a pixel on the account may also be another Nexus business's).
    expect(refusal(datasetCreateDraft({ level: 'adAccount', name: 'Shop A' }, { adAccountId: ACCOUNT, existing: [PIXEL] }))).not.toMatch(/Shop A pixel/)
  })
  it('a create on the account\'s adspixels edge with its name only; no undo (a dataset cannot be deleted)', () => {
    const d = draft(datasetCreateDraft({ level: 'adAccount', name: 'Shop A' }, { adAccountId: ACCOUNT, existing: [] }))
    expect(d.requests).toMatchObject([{ objectKind: 'adaccount', objectId: `act_${ACCOUNT}`, edge: 'adspixels', params: { name: 'Shop A' }, operation: 'dataset.create', check: 'none', raisesSpend: false, undoable: false }])
    expect(d.warnings.join(' ')).toMatch(/cannot be deleted/)
    expect(d.spendsMoney).toEqual([])
  })
  it('business level is the SDK route (terms, connect after); page / Instagram send dataset_name and say the permission', () => {
    const b = draft(datasetCreateDraft({ level: 'business', name: 'Shop A 2' }, { adAccountId: ACCOUNT, objectId: PORTFOLIO }))
    expect(b.requests[0]).toMatchObject({ objectKind: 'business', objectId: PORTFOLIO, edge: 'adspixels', operation: 'dataset.createInBusiness' })
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
    const before = d.before as { undo: { tool: string; args: Record<string, unknown> } }
    expect(before.undo).toEqual({ tool: 'set-meta-dataset', args: { pixelId: PIXEL, name: 'Shop A pixel', automaticMatching: { enabled: false } } })
  })
  it('analytics only lists the ad sets that lose the signal; an unset value goes back as EMPTY', () => {
    const d = draft(pixelSettingsDraft({ pixelId: PIXEL, dataUse: 'ANALYTICS_ONLY', firstPartyCookieStatus: 'FIRST_PARTY_COOKIE_DISABLED' }, {
      settings: { ...SETTINGS, firstPartyCookieStatus: null },
      adSetsUsing: { adSets: [{ id: '120000000000002', name: 'Ad set B', effectiveStatus: 'ACTIVE' }], more: false },
    }))
    expect(d.warnings.join(' ')).toMatch(/1 ad set optimise on it.*Ad set B/)
    expect((d.before as { undo: { args: Record<string, unknown> } }).undo.args).toMatchObject({ firstPartyCookieStatus: 'EMPTY', dataUse: 'ADVERTISING_AND_ANALYTICS' })
  })
  it('data use back to ads while ad sets optimise on it is SPENDS MONEY (they deliver again; "nothing spends yet" when none is on)', () => {
    const using = (status: string) => ({ adSets: [{ id: '120000000000002', name: 'Ad set B', effectiveStatus: status }], more: false })
    const on = draft(pixelSettingsDraft({ pixelId: PIXEL, dataUse: 'ADVERTISING_AND_ANALYTICS' }, { settings: { ...SETTINGS, dataUseSetting: 'ANALYTICS_ONLY' }, adSetsUsing: using('ACTIVE') }))
    expect(on.spendsMoney[0]).toMatch(/1 is on now/)
    expect(on.requests[0].raisesSpend).toBe(true)
    expect(draft(pixelSettingsDraft({ pixelId: PIXEL, dataUse: 'ADVERTISING_AND_ANALYTICS' }, { settings: { ...SETTINGS, dataUseSetting: 'ANALYTICS_ONLY' }, adSetsUsing: using('PAUSED') })).spendsMoney[0]).toMatch(/nothing spends yet/)
    expect(draft(pixelSettingsDraft({ pixelId: PIXEL, dataUse: 'ANALYTICS_ONLY' }, { settings: SETTINGS, adSetsUsing: using('ACTIVE') })).spendsMoney).toEqual([])
  })
  it('nothing to change, or matching fields while switching it off, is refused in words', () => {
    expect(refusal(pixelSettingsDraft({ pixelId: PIXEL, name: 'Shop A pixel' }, { settings: SETTINGS, adSetsUsing: noAdSets }))).toMatch(/Nothing to change/)
    expect(refusal(pixelSettingsDraft({ pixelId: PIXEL, automaticMatching: { enabled: false, fields: ['em'] } }, { settings: SETTINGS, adSetsUsing: noAdSets }))).toMatch(/enabled true/)
  })
})

describe('set-meta-dataset: an event source group', () => {
  it('create: one request on the portfolio\'s edge, sorted datasets, no way back', () => {
    const d = draft(groupDraft({ action: 'create', name: 'Group A', pixelIds: ['3', '1'] }, { portfolio: PORTFOLIO, adAccountId: ACCOUNT }))
    expect(d.requests[0]).toMatchObject({ objectKind: 'business', objectId: PORTFOLIO, edge: 'event_source_groups', params: { event_sources: '["1","3"]', name: 'Group A' } })
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

describe('set-meta-dataset-access', () => {
  const facts = { pixelId: PIXEL, pixelName: 'Shop A pixel', adAccountId: ACCOUNT, portfolio: PORTFOLIO, ownerBusinessId: PORTFOLIO }
  it('connect / disconnect name the chosen ad account and its portfolio only; disconnect lists the ad sets that lose it', () => {
    const c = draft(accessDraft({ pixelId: PIXEL, action: 'connect-ad-account' }, { ...facts, connected: false }))
    expect(c.requests[0]).toMatchObject({ edge: 'shared_accounts', params: { account_id: ACCOUNT, business: PORTFOLIO } })
    expect(refusal(accessDraft({ pixelId: PIXEL, action: 'connect-ad-account' }, { ...facts, connected: true }))).toMatch(/already connected/)
    expect(c.spendsMoney).toEqual([])
    // Ad sets of the account that optimise on it deliver again once it is connected: SPENDS MONEY.
    const back = draft(accessDraft({ pixelId: PIXEL, action: 'connect-ad-account' }, { ...facts, connected: false, adSetsUsing: { adSets: [{ id: '120000000000002', name: 'Ad set B', effectiveStatus: 'ACTIVE' }], more: false } }))
    expect(back.spendsMoney[0]).toMatch(/Connecting it lets 1 ad set .*1 is on now/)
    expect(back.requests[0].raisesSpend).toBe(true)
    const d = draft(accessDraft({ pixelId: PIXEL, action: 'disconnect-ad-account' }, { ...facts, connected: true, adSetsUsing: { adSets: [{ id: '120000000000002', name: 'Ad set B', effectiveStatus: 'ACTIVE' }], more: false } }))
    expect(d.requests[0]).toMatchObject({ method: 'DELETE', params: { account_id: ACCOUNT, business: PORTFOLIO } })
    expect(d.warnings.join(' ')).toMatch(/1 ad set .*Ad set B/)
    expect((d.before as { undo: unknown }).undo).toEqual({ tool: 'set-meta-dataset-access', args: { pixelId: PIXEL, action: 'connect-ad-account' } })
    // A dataset another portfolio owns: disconnecting it cannot be undone from Nexus.
    expect((draft(accessDraft({ pixelId: PIXEL, action: 'disconnect-ad-account' }, { ...facts, ownerBusinessId: '111', connected: true })).before as { undo: unknown }).undo).toBeNull()
  })
  it('partners: tasks in Meta\'s order, a pending share said; removing has no undo', () => {
    const s = draft(accessDraft({ pixelId: PIXEL, action: 'share-with-partner', partnerBusinessId: '5555', partnerTasks: ['UPLOAD', 'ANALYZE'] }, { ...facts, partners: [] }))
    expect(s.requests[0].params).toEqual({ business: '5555', permitted_tasks: '["ANALYZE","UPLOAD"]' })
    expect(s.warnings.join(' ')).toMatch(/pending request/)
    const r = draft(accessDraft({ pixelId: PIXEL, action: 'remove-partner', partnerBusinessId: '5555' }, { ...facts, partners: ['5555'] }))
    expect(r.requests[0]).toMatchObject({ method: 'DELETE', params: { business: '5555' } })
    expect((r.before as { undo: unknown }).undo).toBeNull()
  })
  it('a person: undo puts back the tasks they had, none when they had none (Meta has no removal)', () => {
    const had = draft(accessDraft({ pixelId: PIXEL, action: 'assign-person', personId: '777', personTasks: ['EDIT', 'ADVERTISE'] }, { ...facts, personTasks: ['ANALYZE'] }))
    expect(had.requests[0].params).toEqual({ user: '777', tasks: '["ADVERTISE","EDIT"]' })
    expect((had.before as { undo: { args: unknown } }).undo.args).toEqual({ pixelId: PIXEL, action: 'assign-person', personId: '777', personTasks: ['ANALYZE'] })
    const fresh = draft(accessDraft({ pixelId: PIXEL, action: 'assign-person', personId: '777', personTasks: ['ADVERTISE'] }, { ...facts, personTasks: null }))
    expect((fresh.before as { undo: unknown; noUndo: string[] }).undo).toBeNull()
  })
  it('server-event partners: the whole list, from → to; unknown now = refused', () => {
    const d = draft(accessDraft({ pixelId: PIXEL, action: 'server-event-partners', serverEventBusinessIds: ['22', '11'] }, { ...facts, serverEventBusinesses: [] }))
    expect(d.requests[0].params).toEqual({ server_events_business_ids: '["11","22"]' })
    expect(refusal(accessDraft({ pixelId: PIXEL, action: 'server-event-partners', serverEventBusinessIds: [] }, { ...facts, serverEventBusinesses: null }))).toMatch(/does not show/)
  })
})

describe('set-meta-custom-conversion', () => {
  const rule = { or: [{ url: { i_contains: 'thank-you' } }] }
  it('counts first: at 100 refused; a list Meta cut is not counted (refused)', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ ...ROW, id: String(i + 1) }))
    expect(refusal(conversionCreateDraft({ name: 'X', pixelId: PIXEL, rule, eventType: 'PURCHASE' }, { adAccountId: ACCOUNT, currency: 'EUR', conversions: many, complete: true, pixelName: null }))).toMatch(/at most 100/)
    expect(refusal(conversionCreateDraft({ name: 'X', pixelId: PIXEL, rule, eventType: 'PURCHASE' }, { adAccountId: ACCOUNT, currency: 'EUR', conversions: [], complete: false, pixelName: null }))).toMatch(/cannot count/)
  })
  it('create: the rule as JSON in one spelling, the value in currency units, the rule fixed said; undo deletes it', () => {
    const d = draft(conversionCreateDraft({ name: 'Thanks', pixelId: PIXEL, rule, eventType: 'PURCHASE', defaultValueCents: 1250 }, { adAccountId: ACCOUNT, currency: 'EUR', conversions: [ROW], complete: true, pixelName: 'Shop A pixel' }))
    expect(d.requests[0]).toMatchObject({ objectKind: 'adaccount', objectId: `act_${ACCOUNT}`, edge: 'customconversions', undoable: false, params: { name: 'Thanks', event_source_id: PIXEL, rule: '{"or":[{"url":{"i_contains":"thank-you"}}]}', custom_event_type: 'PURCHASE', default_conversion_value: '12.5' } })
    expect(d.warnings.join(' ')).toMatch(/never change.*2 of the 100/s)
    expect(refusal(conversionCreateDraft({ name: 'X', pixelId: PIXEL, rule: { url: { is_any: ['a'] } }, eventType: 'PURCHASE' }, { adAccountId: ACCOUNT, currency: 'EUR', conversions: [], complete: true, pixelName: null }))).toMatch(/not a custom conversion operator/)
  })
  it('update: a default-value raise while an ad set optimises on it is SPENDS MONEY (says when none is on); a cut is not', () => {
    const on = draft(conversionUpdateDraft({ customConversionId: CC, defaultValueCents: 2000 }, { row: ROW, currency: 'EUR', adSetsUsing: { adSets: [{ id: '2', name: 'Ad set B', effectiveStatus: 'ACTIVE' }], more: false } }))
    expect(on.spendsMoney[0]).toMatch(/1 is on now/)
    expect(on.requests[0]).toMatchObject({ raisesSpend: true, params: { default_conversion_value: '20' } })
    expect((on.before as { undo: { args: unknown } }).undo.args).toEqual({ action: 'update', customConversionId: CC, defaultValueCents: 1000 })
    const off = draft(conversionUpdateDraft({ customConversionId: CC, defaultValueCents: 2000 }, { row: ROW, currency: 'EUR', adSetsUsing: { adSets: [{ id: '2', name: 'Ad set B', effectiveStatus: 'PAUSED' }], more: false } }))
    expect(off.spendsMoney[0]).toMatch(/nothing spends yet/)
    const cut = draft(conversionUpdateDraft({ customConversionId: CC, defaultValueCents: 500 }, { row: ROW, currency: 'EUR', adSetsUsing: { adSets: [{ id: '2', name: 'Ad set B', effectiveStatus: 'ACTIVE' }], more: false } }))
    expect(cut.spendsMoney).toEqual([])
    expect(refusal(conversionUpdateDraft({ customConversionId: CC, name: 'X' }, { row: { ...ROW, isUnavailable: true }, currency: 'EUR', adSetsUsing: noAdSets }))).toMatch(/2460004/)
  })
})

describe('remove-meta-signal-items', () => {
  it('a custom conversion is one DELETE; an event rule or a parameter extractor answers that Meta cannot', () => {
    const d = draft(removeDraft([{ kind: 'customConversion', id: CC }, { kind: 'eventRule', id: '5' }], { conversions: [{ row: ROW, adSetsUsing: { adSets: [{ id: '2', name: 'Ad set B', effectiveStatus: 'ACTIVE' }], more: false } }] }))
    expect(d.requests).toMatchObject([{ objectKind: 'customconversion', objectId: CC, method: 'DELETE', params: {}, undoable: false }])
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
