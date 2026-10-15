/**
 * Google Ads programme 2, G8a (2026-10-15) — the pure builders of conversion changes: conversion actions, goals, value
 * rules, Shopify sales sent to Google and their adjustments. Request + live state → the operations Google gets, what a
 * person reads (from → to, SPENDS MONEY), what it stands on and what undo needs. Ids, names and amounts are made up.
 */
import { describe, expect, it } from 'vitest'
import { actionChangeDraft, actionRecordAfterRun, actionRemoveDraft, goalChangeDraft, type BiddingContext } from './change-conversions.js'
import { valueRuleChangeDraft, valueRuleRecordAfterRun, type ValueRuleRecord } from './change-value-rules.js'
import {
  adjustDraft, adjustRecordsAfterRun, clickIdOf, e164Phone, normalizedEmail, sha256Hex, uploadDraft, uploadWindowProblem,
  type AdjustRecord, type UploadLive, type UploadOrder,
} from './conversion-upload.js'
import { valueRuleOf, valueRuleSetOf, type LiveValueRule, type LiveValueRuleSet, type SmartBiddingCampaign } from './live-conversions.js'
import type { LiveConversionAction } from './live-account.js'
import type { GoogleChangeDraft } from './change-draft.js'

const CUSTOMER = 'customers/1234567890'
const draft = (out: GoogleChangeDraft | { refusal: string }): GoogleChangeDraft => {
  if ('refusal' in out) throw new Error(`refused: ${out.refusal}`)
  return out
}
const refusal = (out: GoogleChangeDraft | { refusal: string }): string => ('refusal' in out ? out.refusal : 'NOT REFUSED')

const action = (over: Partial<LiveConversionAction> = {}): LiveConversionAction => ({
  conversionActionId: '71', name: 'Purchase A', status: 'ENABLED', type: 'WEBPAGE', category: 'PURCHASE', origin: 'WEBSITE', primary: false,
  includeInConversions: true, counting: 'MANY_PER_CLICK', clickWindowDays: 30, viewWindowDays: 1, defaultValueCents: 100, defaultValueCurrency: 'EUR',
  alwaysUseDefaultValue: false, attribution: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN', dataDrivenStatus: null, ownerCustomerId: '1234567890', ga4: null, ...over,
})
const campaign = (id: string, name: string, bidding: string | null, status = 'ENABLED'): SmartBiddingCampaign => ({ campaignId: id, name, status, bidding })
const bidding = (over: Partial<BiddingContext['goals']> = {}, campaigns = [campaign('21', 'Shop A', 'MAXIMIZE_CONVERSION_VALUE'), campaign('22', 'Search B', 'MANUAL_CPC')]): BiddingContext => ({
  campaigns,
  goals: {
    accountGoals: [{ goal: 'PURCHASE/WEBSITE', category: 'PURCHASE', origin: 'WEBSITE', biddable: true }, { goal: 'SIGNUP/WEBSITE', category: 'SIGNUP', origin: 'WEBSITE', biddable: false }],
    campaigns: [],
    ...over,
  },
})

// ── conversion actions ──────────────────────────────────────────────────────────────────────────────────────────

describe('conversion actions', () => {
  it('a new action is made SECONDARY with sensible counting; nothing spends; the tag and the upload are explained', () => {
    const out = draft(actionChangeDraft(CUSTOMER, 'EUR', { create: [{ name: 'Sales import', type: 'UPLOAD_CLICKS' }, { name: 'Lead form', type: 'WEBPAGE', category: 'SUBMIT_LEAD_FORM' }] }, { actions: [action()], bidding: bidding(), customerId: '1234567890' }))
    expect(out.operations).toEqual([
      { conversionActionOperation: { create: { name: 'Sales import', category: 'PURCHASE', status: 'ENABLED', primaryForGoal: false, countingType: 'MANY_PER_CLICK', type: 'UPLOAD_CLICKS' } } },
      { conversionActionOperation: { create: { name: 'Lead form', category: 'SUBMIT_LEAD_FORM', status: 'ENABLED', primaryForGoal: false, countingType: 'ONE_PER_CLICK', type: 'WEBPAGE' } } },
    ])
    expect(out.spendsMoney).toEqual([])
    expect(out.warnings.join(' ')).toMatch(/upload-google-sales/)
    expect(out.warnings.join(' ')).toMatch(/event snippet/)
    expect(out.warnings.join(' ')).toMatch(/no SUBMIT_LEAD_FORM website goal yet/)
    expect(actionRecordAfterRun(out.after as never, [{ conversionActionResult: { resourceName: `${CUSTOMER}/conversionActions/81` } }, { conversionActionResult: { resourceName: `${CUSTOMER}/conversionActions/82` } }]).created)
      .toEqual([{ conversionActionId: '81', name: 'Sales import', type: 'UPLOAD_CLICKS' }, { conversionActionId: '82', name: 'Lead form', type: 'WEBPAGE' }])
  })

  it('making an action primary and counting longer is SPENDS MONEY naming the Smart Bidding campaign; the mask names only what changes', () => {
    const out = draft(actionChangeDraft(CUSTOMER, 'EUR', { change: [{ conversionActionId: '71', primary: true, clickWindowDays: 60, viewWindowDays: 1 }] }, { actions: [action()], bidding: bidding(), customerId: '1234567890' }))
    expect(out.operations).toEqual([{ conversionActionOperation: {
      update: { resourceName: `${CUSTOMER}/conversionActions/71`, primaryForGoal: true, clickThroughLookbackWindowDays: 60 },
      updateMask: 'primary_for_goal,click_through_lookback_window_days',
    } }])
    expect(out.skipped).toEqual(['"Purchase A" (71): view-through window (days) is already 1.'])
    expect(out.spendsMoney).toHaveLength(1)
    expect(out.spendsMoney[0]).toMatch(/becomes a primary action.*longer click-through window.*1 enabled campaign bids with Smart Bidding for it \("Shop A"\)/)
    expect(out.before).toEqual({ actions: [{ conversionActionId: '71', primary: false, clickWindowDays: 30 }], created: [] })
    expect(out.after).toEqual({ actions: [{ conversionActionId: '71', primary: true, clickWindowDays: 60 }], created: [] })
  })

  it('a higher default value on a primary action spends (value bidding); a default value is written with its currency', () => {
    const out = draft(actionChangeDraft(CUSTOMER, 'EUR', { change: [{ conversionActionId: '71', defaultValueCents: 2500 }] }, { actions: [action({ primary: true })], bidding: bidding(), customerId: '1234567890' }))
    expect(out.operations[0]).toEqual({ conversionActionOperation: {
      update: { resourceName: `${CUSTOMER}/conversionActions/71`, valueSettings: { defaultValue: 25, defaultCurrencyCode: 'EUR' } },
      updateMask: 'value_settings.default_value,value_settings.default_currency_code',
    } })
    expect(out.changes['Purchase A: default value']).toEqual({ from: 'EUR 1.00', to: 'EUR 25.00' })
    expect(out.spendsMoney[0]).toMatch(/higher default value \(value bidding\).*"Shop A"/)
  })

  it('making an action secondary or hidden is a warning, never SPENDS MONEY', () => {
    const out = draft(actionChangeDraft(CUSTOMER, 'EUR', { change: [{ conversionActionId: '71', primary: false, status: 'HIDDEN' }] }, { actions: [action({ primary: true })], bidding: bidding(), customerId: '1234567890' }))
    expect(out.spendsMoney).toEqual([])
    expect(out.warnings.join(' ')).toMatch(/becomes secondary/)
    expect(out.warnings.join(' ')).toMatch(/is hidden/)
  })

  it('refuses Google\'s own actions, another account\'s, a name in use, an unknown action and a window out of range', () => {
    const live = { actions: [action(), action({ conversionActionId: '72', name: 'Store visits', ownerCustomerId: null }), action({ conversionActionId: '73', name: 'Manager sale', ownerCustomerId: '999' })], bidding: bidding(), customerId: '1234567890' }
    expect(refusal(actionChangeDraft(CUSTOMER, 'EUR', { change: [{ conversionActionId: '72', primary: true }] }, live))).toMatch(/Google's own/)
    expect(refusal(actionChangeDraft(CUSTOMER, 'EUR', { change: [{ conversionActionId: '73', primary: true }] }, live))).toMatch(/belongs to account 999/)
    expect(refusal(actionChangeDraft(CUSTOMER, 'EUR', { create: [{ name: 'purchase a', type: 'WEBPAGE' }] }, live))).toMatch(/already exists/)
    expect(refusal(actionChangeDraft(CUSTOMER, 'EUR', { change: [{ conversionActionId: '79', primary: true }] }, live))).toMatch(/not in the account/)
    expect(refusal(actionChangeDraft(CUSTOMER, 'EUR', { change: [{ conversionActionId: '71', clickWindowDays: 91 }] }, live))).toMatch(/1 to 90 days/)
  })

  it('remove: one remove per action, said to be for good; a primary one warns', () => {
    const out = draft(actionRemoveDraft(CUSTOMER, ['71'], { actions: [action({ primary: true })], customerId: '1234567890' }))
    expect(out.operations).toEqual([{ conversionActionOperation: { remove: `${CUSTOMER}/conversionActions/71` } }])
    expect(out.warnings.join(' ')).toMatch(/cannot be restored/)
    expect(out.warnings.join(' ')).toMatch(/primary action/)
  })
})

// ── goals ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('conversion goals', () => {
  it('an account goal made biddable spends for the Smart Bidding campaigns that follow the account', () => {
    const out = draft(goalChangeDraft(CUSTOMER, { accountGoals: [{ category: 'SIGNUP', origin: 'WEBSITE', biddable: true }] }, { bidding: bidding() }))
    expect(out.operations).toEqual([{ customerConversionGoalOperation: { update: { resourceName: `${CUSTOMER}/customerConversionGoals/SIGNUP~WEBSITE`, biddable: true }, updateMask: 'biddable' } }])
    expect(out.spendsMoney[0]).toMatch(/SIGNUP\/WEBSITE becomes biddable.*"Shop A"/)
    expect(out.before).toEqual({ account: [{ category: 'SIGNUP', origin: 'WEBSITE', biddable: false }], campaigns: [], levels: [] })
  })

  it('a campaign goal moves the campaign to its own goals (recorded for undo); back to the account\'s goals sets the level', () => {
    const live = bidding({ campaigns: [{ campaignId: '22', name: 'Search B', status: 'ENABLED', goalsFrom: 'CAMPAIGN', customGoalId: null, biddableGoals: ['SIGNUP/WEBSITE'], differsFromAccount: true }] })
    const own = draft(goalChangeDraft(CUSTOMER, { campaignGoals: [{ campaignId: '21', category: 'PURCHASE', origin: 'WEBSITE', biddable: false }] }, { bidding: live }))
    expect(own.operations).toEqual([{ campaignConversionGoalOperation: { update: { resourceName: `${CUSTOMER}/campaignConversionGoals/21~PURCHASE~WEBSITE`, biddable: false }, updateMask: 'biddable' } }])
    expect(own.before).toMatchObject({ levels: [{ campaignId: '21', goalsFrom: 'CUSTOMER' }] })
    expect(own.warnings.join(' ')).toMatch(/gets goals of its own/)
    const back = draft(goalChangeDraft(CUSTOMER, { useAccountGoals: ['22'] }, { bidding: live }))
    expect(back.operations).toEqual([{ conversionGoalCampaignConfigOperation: { update: { resourceName: `${CUSTOMER}/conversionGoalCampaignConfigs/22`, goalConfigLevel: 'CUSTOMER' }, updateMask: 'goal_config_level' } }])
    // Manual CPC: nothing chases; the goal it loses is a warning.
    expect(back.spendsMoney[0]).toMatch(/starts bidding for PURCHASE\/WEBSITE.*nothing spends more yet/)
    expect(back.warnings.join(' ')).toMatch(/stops bidding for SIGNUP\/WEBSITE/)
    expect(refusal(goalChangeDraft(CUSTOMER, { accountGoals: [{ category: 'STORE_VISIT', origin: 'STORE', biddable: true }] }, { bidding: live }))).toMatch(/no STORE_VISIT goal/)
  })
})

// ── value rules ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('conversion value rules', () => {
  const rule = (over: Partial<LiveValueRule> = {}): LiveValueRule => ({ valueRuleId: '91', status: 'ENABLED', operation: 'MULTIPLY', value: 1.2, devices: ['MOBILE'], locations: null, audiences: null, dimensions: ['DEVICE'], ownerCustomerId: '1234567890', ...over })
  const set = (over: Partial<LiveValueRuleSet> = {}): LiveValueRuleSet => ({ ruleSetId: '95', status: 'ENABLED', attachment: 'CUSTOMER', campaignId: null, ruleIds: ['91'], dimensions: ['DEVICE'], categories: [], ownerCustomerId: '1234567890', ...over })
  const campaigns = [campaign('21', 'Shop A', 'TARGET_ROAS')]

  it('a new rule is made PAUSED and joins the account\'s rule set (its dimensions widened); nothing spends', () => {
    const out = draft(valueRuleChangeDraft(CUSTOMER, 'EUR', { create: [{ add: 500, locations: { include: ['2380'] } }] }, { rules: [rule()], sets: [set()], campaigns }))
    expect(out.operations).toEqual([
      { conversionValueRuleOperation: { create: { resourceName: `${CUSTOMER}/conversionValueRules/-1`, action: { operation: 'ADD', value: 5 }, geoLocationCondition: { geoTargetConstants: ['geoTargetConstants/2380'], geoMatchType: 'ANY' }, status: 'PAUSED' } } },
      { conversionValueRuleSetOperation: { update: { resourceName: `${CUSTOMER}/conversionValueRuleSets/95`, conversionValueRules: [`${CUSTOMER}/conversionValueRules/91`, `${CUSTOMER}/conversionValueRules/-1`], dimensions: ['DEVICE', 'GEO_LOCATION'] }, updateMask: 'conversion_value_rules,dimensions' } },
    ])
    expect(out.spendsMoney).toEqual([])
    const after = valueRuleRecordAfterRun(out.after as ValueRuleRecord, [{ conversionValueRuleResult: { resourceName: `${CUSTOMER}/conversionValueRules/92` } }, { conversionValueRuleSetResult: { resourceName: `${CUSTOMER}/conversionValueRuleSets/95` } }])
    expect(after.created).toEqual([{ valueRuleId: '92', status: 'PAUSED' }])
  })

  it('an enabled rule for a campaign with no rule set makes a set (temporary ids) and spends for value bidding there', () => {
    const out = draft(valueRuleChangeDraft(CUSTOMER, 'EUR', { create: [{ multiply: 1.5, devices: ['DESKTOP'], campaignId: '21', enable: true }] }, { rules: [], sets: [], campaigns }))
    expect(out.operations[1]).toEqual({ conversionValueRuleSetOperation: { create: {
      resourceName: `${CUSTOMER}/conversionValueRuleSets/-2`, attachmentType: 'CAMPAIGN', campaign: `${CUSTOMER}/campaigns/21`,
      conversionValueRules: [`${CUSTOMER}/conversionValueRules/-1`], dimensions: ['DEVICE'],
    } } })
    expect(out.spendsMoney[0]).toMatch(/raises conversion values in campaign "Shop A".*"Shop A"/)
  })

  it('raising a rule spends, lowering warns; at most two conditions; multiply 0.5 to 10', () => {
    const up = draft(valueRuleChangeDraft(CUSTOMER, 'EUR', { change: [{ valueRuleId: '91', multiply: 2 }] }, { rules: [rule()], sets: [set()], campaigns }))
    expect(up.operations).toEqual([{ conversionValueRuleOperation: { update: { resourceName: `${CUSTOMER}/conversionValueRules/91`, action: { operation: 'MULTIPLY', value: 2 } }, updateMask: 'action.operation,action.value' } }])
    expect(up.spendsMoney).toHaveLength(1)
    expect(up.before).toEqual({ rules: [{ valueRuleId: '91', operation: 'MULTIPLY', multiply: 1.2 }], created: [] })
    const down = draft(valueRuleChangeDraft(CUSTOMER, 'EUR', { change: [{ valueRuleId: '91', multiply: 0.8 }] }, { rules: [rule()], sets: [set()], campaigns }))
    expect(down.spendsMoney).toEqual([])
    expect(down.warnings.join(' ')).toMatch(/lowers conversion values/)
    expect(refusal(valueRuleChangeDraft(CUSTOMER, 'EUR', { create: [{ add: 100, devices: ['MOBILE'], locations: { include: ['2380'] }, audiences: { userLists: ['301'] } }] }, { rules: [], sets: [], campaigns }))).toMatch(/at most two conditions/)
    expect(refusal(valueRuleChangeDraft(CUSTOMER, 'EUR', { create: [{ multiply: 11, devices: ['MOBILE'] }] }, { rules: [], sets: [], campaigns }))).toMatch(/0.5 to 10/)
  })

  it('reads rules and rule sets from Google\'s rows', () => {
    expect(valueRuleOf({ conversionValueRule: { id: '91', status: 'ENABLED', action: { operation: 'ADD', value: 5 }, geoLocationCondition: { geoTargetConstants: ['geoTargetConstants/2380'], geoMatchType: 'ANY' }, ownerCustomer: CUSTOMER } }))
      .toMatchObject({ valueRuleId: '91', operation: 'ADD', value: 5, dimensions: ['GEO_LOCATION'], locations: { include: ['2380'] }, ownerCustomerId: '1234567890' })
    expect(valueRuleSetOf({ conversionValueRuleSet: { id: '95', attachmentType: 'CAMPAIGN', campaign: `${CUSTOMER}/campaigns/21`, conversionValueRules: [`${CUSTOMER}/conversionValueRules/91`], dimensions: ['DEVICE'] } }))
      .toMatchObject({ ruleSetId: '95', attachment: 'CAMPAIGN', campaignId: '21', ruleIds: ['91'] })
  })
})

// ── sales sent to Google ────────────────────────────────────────────────────────────────────────────────────────

describe('the click id and the buyer\'s contact, as Google asks', () => {
  it('finds gclid (then gbraid, then wbraid) on the landing page or in a note attribute', () => {
    expect(clickIdOf({ landing_site: '/products/a?utm_source=google&gclid=Cj0KCQjw-test_1' })).toEqual({ kind: 'gclid', value: 'Cj0KCQjw-test_1' })
    expect(clickIdOf({ landing_site: 'https://shop.example/?wbraid=Wb0test-123&gbraid=Gb0test-123' })).toEqual({ kind: 'gbraid', value: 'Gb0test-123' })
    expect(clickIdOf({ landing_site: '/', note_attributes: [{ name: 'GCLID', value: 'Cj0KCQjw-note' }] })).toEqual({ kind: 'gclid', value: 'Cj0KCQjw-note' })
    expect(clickIdOf({ landing_site: '/?gclid=<script>' })).toBeNull()
    expect(clickIdOf(null)).toBeNull()
  })

  it('normalises email (gmail dots and +suffix) and phone (E.164) before SHA-256', () => {
    expect(normalizedEmail('  Jane.Doe+shop@GMail.com ')).toBe('janedoe@gmail.com')
    expect(normalizedEmail('Jane.Doe@example.com')).toBe('jane.doe@example.com')
    expect(normalizedEmail('not an email')).toBeNull()
    expect(e164Phone('+39 333 123 4567')).toBe('+393331234567')
    expect(e164Phone('0039 333 1234567')).toBe('+393331234567')
    expect(e164Phone('333 1234567')).toBeNull()
    expect(sha256Hex('janedoe@gmail.com')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('upload-google-sales: Shopify orders → events', () => {
  const NOW = new Date('2026-10-15T12:00:00Z')
  const order = (id: string, over: Partial<UploadOrder> = {}, metadata: Record<string, unknown> = {}): UploadOrder => ({
    orderId: `n-${id}`, shopifyOrderId: id, status: 'PROCESSING', purchaseDate: new Date('2026-10-10T09:00:00Z'), createdAt: new Date('2026-10-10T09:00:05Z'),
    totalCents: 4990, currency: 'EUR', email: 'jane.doe@example.com', metadata: { name: `#${id}`, currency: 'EUR', current_total_price: '49.90', current_subtotal_price: '40.00', landing_site: '/?gclid=Cj0KCQjw-test', phone: '+39 333 123 4567', ...metadata }, ...over,
  })
  const live = (over: Partial<UploadLive> = {}): UploadLive => ({
    customerId: '1234567890', currency: 'EUR', actions: [action({ conversionActionId: '72', name: 'Sales import', type: 'UPLOAD_CLICKS', primary: true })], conversionCustomerId: '1234567890',
    acceptedCustomerDataTerms: true, orders: [], alreadySent: new Map(), chasers: [campaign('21', 'Shop A', 'MAXIMIZE_CONVERSION_VALUE')], countsForBidding: true, now: NOW, ...over,
  })
  const ask = { conversionActionId: '72', from: '2026-10-10', to: '2026-10-14', value: 'total' as const, enhanced: false, withoutClickId: false }

  it('sends only sales with a click id; leaves out test, cancelled, refunded, already sent and click-less orders, each named', () => {
    const orders = [
      order('5001'),
      order('5002', {}, { landing_site: '/' }),
      order('5003', {}, { test: true }),
      order('5004', { status: 'CANCELLED' }),
      order('5005', {}, { financial_status: 'refunded' }),
      order('5006'),
    ]
    const out = draft(uploadDraft(ask, live({ orders, alreadySent: new Map([['5006', '72']]) })))
    expect(out.operations).toEqual([{ transactionId: '5001', eventTimestamp: '2026-10-10T09:00:00.000Z', eventSource: 'WEB', conversionValue: 49.9, currency: 'EUR', adIdentifiers: { gclid: 'Cj0KCQjw-test' } }])
    expect(out.summary).toBe('Send 1 sale (EUR 49.90) from Shopify to the conversion action "Sales import" (72).')
    expect(out.skipped.join(' ')).toMatch(/no Google click id.*: #5002\./)
    expect(out.skipped.join(' ')).toMatch(/Shopify test orders: #5003/)
    expect(out.skipped.join(' ')).toMatch(/cancelled or refunded: #5004, #5005/)
    expect(out.skipped.join(' ')).toMatch(/already sent to this action.*#5006/)
    expect(out.spendsMoney[0]).toMatch(/count for automatic bidding.*"Shop A"/)
    // Nothing personal is sent without enhanced.
    expect(JSON.stringify(out.operations)).not.toMatch(/userData|jane/)
    expect(out.after).toMatchObject({ conversionActionId: '72', sent: [{ orderId: '5001', valueCents: 4990, currency: 'EUR', clickId: 'gclid', enhanced: false }] })
  })

  it('enhanced: hashed email and phone only, with consent and Google\'s customer data terms; subtotal on ask', () => {
    const out = draft(uploadDraft({ ...ask, value: 'subtotal', enhanced: true, adUserDataConsent: 'GRANTED' }, live({ orders: [order('5001')] })))
    expect(out.operations).toEqual([{
      transactionId: '5001', eventTimestamp: '2026-10-10T09:00:00.000Z', eventSource: 'WEB', conversionValue: 40, currency: 'EUR', adIdentifiers: { gclid: 'Cj0KCQjw-test' },
      userData: { userIdentifiers: [{ emailAddress: sha256Hex('jane.doe@example.com') }, { phoneNumber: sha256Hex('+393331234567') }] },
      consent: { adUserData: 'CONSENT_GRANTED' },
    }])
    expect(JSON.stringify(out.operations)).not.toMatch(/jane|333/)
    expect(out.warnings.join(' ')).toMatch(/hashed \(SHA-256/)
    expect(refusal(uploadDraft({ ...ask, enhanced: true }, live({ orders: [order('5001')] })))).toMatch(/consent/)
    expect(refusal(uploadDraft({ ...ask, enhanced: true, adUserDataConsent: 'GRANTED' }, live({ orders: [order('5001')], acceptedCustomerDataTerms: false })))).toMatch(/customer data terms/)
    expect(refusal(uploadDraft({ ...ask, withoutClickId: true }, live({ orders: [order('5001')] })))).toMatch(/needs enhanced/)
  })

  it('refuses a day still running, days older than Google keeps a click, a website-tag action and a cross-account setup', () => {
    expect(uploadWindowProblem({ from: '2026-10-14', to: '2026-10-15' }, NOW)).toMatch(/before today/)
    expect(uploadWindowProblem({ from: '2026-07-01', to: '2026-07-02' }, NOW)).toMatch(/90 days/)
    expect(uploadWindowProblem({ orderIds: ['5001'], from: '2026-10-10' }, NOW)).toMatch(/not both/)
    expect(refusal(uploadDraft(ask, live({ actions: [action({ conversionActionId: '72' })], orders: [order('5001')] })))).toMatch(/is WEBPAGE/)
    expect(refusal(uploadDraft(ask, live({ conversionCustomerId: '999', orders: [order('5001')] })))).toMatch(/managed in account 999/)
    expect(refusal(uploadDraft({ ...ask, from: undefined, to: undefined, orderIds: ['5009'] }, live({ orders: [order('5001')] })))).toMatch(/No Nexus Shopify order 5009/)
  })
})

describe('adjust-google-sales: retractions and restatements', () => {
  const order = (id: string): UploadOrder => ({ orderId: `n-${id}`, shopifyOrderId: id, status: 'PROCESSING', purchaseDate: null, createdAt: new Date('2026-10-10T09:00:00Z'), totalCents: 4990, currency: 'EUR', email: null, metadata: { name: `#${id}` } })
  const live = () => ({
    actions: [action({ conversionActionId: '72', name: 'Sales import', type: 'UPLOAD_CLICKS', primary: true })], currency: 'EUR',
    orders: new Map([['5001', order('5001')], ['5002', order('5002')]]), sentHere: new Set(['5001']), retracted: new Set<string>(),
    known: new Map([['5001', { valueCents: 4990, currency: 'EUR' }]]), chasers: [campaign('21', 'Shop A', 'TARGET_ROAS')], countsForBidding: true,
  })

  it('retractions then restatements, each named by order id; the value Nexus gave before is kept for undo', () => {
    const out = draft(adjustDraft(CUSTOMER, { conversionActionId: '72', retract: ['5002'], restate: [{ orderId: '5001', valueCents: 2990 }] }, live()))
    expect(out.operations).toEqual([
      { conversionAction: `${CUSTOMER}/conversionActions/72`, adjustmentType: 'RETRACTION', orderId: '5002' },
      { conversionAction: `${CUSTOMER}/conversionActions/72`, adjustmentType: 'RESTATEMENT', orderId: '5001', restatementValue: { adjustedValue: 29.9, currencyCode: 'EUR' } },
    ])
    expect(out.changes['#5001']).toEqual({ from: 'EUR 49.90', to: 'EUR 29.90' })
    expect(out.warnings.join(' ')).toMatch(/Nexus did not send #5002/)
    expect(out.spendsMoney).toHaveLength(1)
    // Google took the restatement, refused the retraction: only what it took is recorded.
    const run = adjustRecordsAfterRun({ before: out.before as AdjustRecord, after: out.after as AdjustRecord }, [{ ok: false, why: 'Conversion not found (CONVERSION_NOT_FOUND)' }, { ok: true }])
    expect(run.after).toEqual({ conversionActionId: '72', retracted: [], restated: [{ orderId: '5001', valueCents: 2990, currency: 'EUR' }] })
    expect(run.before).toEqual({ conversionActionId: '72', retracted: [], restated: [{ orderId: '5001', valueCents: 4990, currency: 'EUR' }] })
    expect(run.refused).toEqual([{ orderId: '5002', why: 'Conversion not found (CONVERSION_NOT_FOUND)' }])
  })

  it('never restates a retracted sale; skips one retracted before', () => {
    const l = { ...live(), retracted: new Set(['5001']) }
    expect(refusal(adjustDraft(CUSTOMER, { conversionActionId: '72', restate: [{ orderId: '5001', valueCents: 100 }] }, l))).toMatch(/does not restate a retracted sale/)
    expect(refusal(adjustDraft(CUSTOMER, { conversionActionId: '72', retract: ['5001'] }, l))).toMatch(/already retracted/)
    expect(refusal(adjustDraft(CUSTOMER, { conversionActionId: '72', retract: ['5099'] }, live()))).toMatch(/No Nexus Shopify order/)
  })
})
