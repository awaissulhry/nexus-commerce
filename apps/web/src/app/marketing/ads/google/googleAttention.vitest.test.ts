/**
 * Google Ads step 1b — the words and rules of the page's new parts (`googleAttention.ts`): the tabs, "Needs a look",
 * "Google acts on its own", Google's recommendations and disapprovals. Node only; every value is made up (the repo is
 * public).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { GoogleActsOnItsOwn, GoogleAlert, GoogleAlertKind, GoogleCampaignAutomation, GoogleOutsideChange, GoogleRead } from '@/lib/google-ads/contract'
import {
  ALERT_KIND_TEXT,
  NOT_READ_YET,
  actsSummary,
  adIssueStatus,
  alertNumbersLine,
  alertSinceText,
  alertTarget,
  alertTone,
  alertsSummary,
  autoApplyRows,
  autoAppliedText,
  codeWords,
  impactExtra,
  outsideChangeRows,
  outsideChangesNote,
  productIssueStatus,
  readNote,
  recommendationsNote,
  signedText,
  sortAlerts,
  viewOf,
  viewParam,
  viewSearch,
  viewTabs,
  wideningCampaigns,
  wideningCell,
  wideningOn,
  wideningTotal,
} from './googleAttention'
import { formatInt, formatMoney } from './googleAds'

const read = (over: Partial<GoogleRead> = {}): GoogleRead => ({
  resource: 'RECOMMENDATIONS', readAt: '2026-10-13T06:30:00.000Z', lastAttemptAt: '2026-10-13T06:30:00.000Z', lastStatus: 'SUCCESS', lastError: null, ...over,
})

describe('the tabs (?view=)', () => {
  it('reads every tab, and anything else is Campaigns', () => {
    for (const v of ['campaigns', 'search-terms', 'products', 'disapprovals', 'on-its-own', 'recommendations'] as const) expect(viewOf(v)).toBe(v)
    expect(viewOf(null)).toBe('campaigns')
    expect(viewOf('')).toBe('campaigns')
    expect(viewOf('keywords')).toBe('campaigns')
  })

  it('Campaigns writes no parameter; every other parameter is kept', () => {
    expect(viewParam('campaigns')).toBeNull()
    expect(viewSearch('from=a&view=products&x=1', 'campaigns')).toBe('from=a&x=1')
    expect(viewSearch('from=a', 'on-its-own')).toBe('from=a&view=on-its-own')
    expect(viewSearch('view=products&campaign=c1&tab=keywords', 'disapprovals')).toBe('view=disapprovals&campaign=c1&tab=keywords')
  })

  it('the six tabs in order, a count only when known (unknown is never 0)', () => {
    const tabs = viewTabs({ campaigns: 12 })
    expect(tabs.map((t) => t.label)).toEqual(['Campaigns', 'Search terms', 'Products', 'Disapprovals', 'Google acts on its own', 'Google’s recommendations'])
    expect(tabs.map((t) => t.count)).toEqual([12, null, null, null, null, null])
    expect(viewTabs({ campaigns: 0 })[0]!.count).toBe(0)
    expect(viewTabs()[0]!.count).toBeNull()
  })
})

describe('read states: never read is "Not read yet", with when Nexus reads next', () => {
  it('never read', () => {
    const n = readNote(read({ readAt: null, lastStatus: null, lastAttemptAt: null }), 'Google’s recommendations', '2026-10-14T06:25:00.000Z', 'UTC')
    expect(n).toEqual({ tone: 'info', title: 'Not read yet', text: 'Nexus has not read Google’s recommendations from Google yet. It reads them in the next daily read (next: 14 Oct 2026, 06:25).' })
    expect(readNote(undefined, 'auto-apply', null)?.text).toBe('Nexus has not read auto-apply from Google yet. It reads them in the next daily read.')
  })

  it('never read because the last try failed or was put off: says why', () => {
    const failed = readNote(read({ readAt: null, lastStatus: 'FAILED', lastError: 'Google refused the query.' }), 'auto-apply', null)
    expect(failed).toMatchObject({ tone: 'warning', title: 'Not read yet' })
    expect(failed!.text).toContain('Google refused the query.')
    expect(readNote(read({ readAt: null, lastStatus: 'SKIPPED_BUDGET' }), 'auto-apply', null)!.text).toMatch(/put off/)
  })

  it('an earlier read on screen after a failed one says which read it shows', () => {
    const n = readNote(read({ lastStatus: 'FAILED', lastError: 'Timeout.' }), 'the campaign settings', null, 'UTC')
    expect(n!.title).toBe('The last read of the campaign settings did not finish')
    expect(n!.text).toContain('This shows the read of 13 Oct 2026, 06:30.')
  })

  it('a good read needs no words', () => {
    expect(readNote(read(), 'auto-apply', null)).toBeNull()
  })
})

const alert = (over: Partial<GoogleAlert>): GoogleAlert => ({
  alertId: 'a1', kind: 'spend_pace', severity: 'warn', title: 'Over its daily budget', body: 'A campaign cost more than its daily budget.',
  campaignId: 'cmp_1', externalCampaignId: '111', campaignName: 'Campaign A', since: '2026-10-12', numbers: null, href: '/x', ...over,
})

describe('Needs a look (R14)', () => {
  it('Open goes where PLAN-1B M4 says, from the kind and the campaign', () => {
    const kinds: Array<[GoogleAlertKind, unknown]> = [
      ['spend_pace', { kind: 'campaign', campaignId: 'cmp_1', tab: 'overview' }],
      ['month_pace', { kind: 'campaign', campaignId: 'cmp_1', tab: 'overview' }],
      ['zero_conversions', { kind: 'campaign', campaignId: 'cmp_1', tab: 'overview' }],
      ['tracking_stopped', { kind: 'campaign', campaignId: 'cmp_1', tab: 'overview' }],
      ['ads_disapproved', { kind: 'view', view: 'disapprovals' }],
      ['products_not_eligible', { kind: 'view', view: 'disapprovals' }],
      ['ads_limited', { kind: 'view', view: 'disapprovals' }],
      ['auto_apply_on', { kind: 'view', view: 'on-its-own' }],
      ['changed_by_google', { kind: 'view', view: 'on-its-own' }],
      ['settings_changed', { kind: 'view', view: 'on-its-own' }],
      ['moved_to_ai_max', { kind: 'view', view: 'on-its-own' }],
    ]
    for (const [kind, target] of kinds) expect(alertTarget({ kind, campaignId: 'cmp_1' })).toEqual(target)
    // About the whole account: the campaigns, never a window without a campaign.
    expect(alertTarget({ kind: 'tracking_stopped', campaignId: null })).toEqual({ kind: 'view', view: 'campaigns' })
    // The server's href is for the bell and MCP only.
    expect(alertTarget({ kind: 'ads_disapproved', campaignId: 'cmp_1' })).not.toHaveProperty('href')
  })

  it('every kind has words for "Not checked yet"', () => {
    expect(Object.keys(ALERT_KIND_TEXT)).toHaveLength(11)
  })

  it('most urgent first, then the newest', () => {
    const sorted = sortAlerts([
      alert({ alertId: 'info', severity: 'info' }),
      alert({ alertId: 'warn-old', severity: 'warn', since: '2026-10-01' }),
      alert({ alertId: 'danger', severity: 'danger' }),
      alert({ alertId: 'warn-new', severity: 'warn', since: '2026-10-12' }),
    ])
    expect(sorted.map((a) => a.alertId)).toEqual(['danger', 'warn-new', 'warn-old', 'info'])
    expect([alertTone('danger'), alertTone('warn'), alertTone('info')]).toEqual(['danger', 'warning', 'info'])
  })

  it('one line of numbers: money in the account currency (EUR, JPY), counts as counts', () => {
    expect(alertNumbersLine({ spendCents: 9500, dailyBudgetCents: 5000, ratio: 1.9 }, 'EUR')).toBe('Cost €95.00 · Daily budget €50.00 · Times the budget 1.9×')
    expect(alertNumbersLine({ spendCents: 9500, clicks: 1234, conversions: 0 }, 'JPY')).toMatch(/^Cost (JP)?¥9,500 · Clicks 1,234 · Conversions 0\.00$/)
  })

  it('no numbers for a role without ad-spend permission, and never a 0 for a number not read', () => {
    expect(alertNumbersLine(null, 'EUR')).toBeNull()
    expect(alertNumbersLine(undefined, 'EUR')).toBeNull()
    expect(alertNumbersLine({ spendCents: null, clicks: 40 }, 'EUR')).toBe('Clicks 40')
    expect(alertNumbersLine({ spendCents: null }, 'EUR')).toBeNull()
    // Money without a currency is left out rather than printed without one.
    expect(alertNumbersLine({ spendCents: 100, clicks: 2 }, null)).toBe('Clicks 2')
    // A key Nexus has no word for is still said in words.
    expect(alertNumbersLine({ priorWeekSpendCents: 100 }, 'EUR')).toBe('Prior week spend €1.00')
  })

  it('"No alerts" only when every check ran; the rest are named with their reason', () => {
    const clear = alertsSummary({ checkedAt: '2026-10-13T06:31:00.000Z', items: [], notChecked: [] }, 'UTC')
    expect(clear.allClear).toBe('No alerts. Nexus ran every check over what it has read, at 13 Oct 2026, 06:31.')
    expect(clear.checked).toBe('Checked 13 Oct 2026, 06:31, over what Nexus has read.')
    const partial = alertsSummary({
      checkedAt: '2026-10-13T06:31:00.000Z', items: [],
      notChecked: [{ kind: 'spend_pace', reason: 'Yesterday is not read yet.' }, { kind: 'spend_pace', reason: 'Twice.' }, { kind: 'auto_apply_on', reason: '' }],
    })
    expect(partial.allClear).toBeNull()
    expect(partial.notChecked).toEqual(['Cost against the daily budget: Yesterday is not read yet.', 'Auto-apply: not read yet.'])
    expect(alertsSummary({ checkedAt: '2026-10-13T06:31:00.000Z', items: [alert({})], notChecked: [] }).allClear).toBeNull()
  })

  it('since', () => {
    expect(alertSinceText('2026-10-12')).toBe('Since 12 Oct 2026')
    expect(alertSinceText(null)).toBeNull()
  })
})

const camp = (over: Partial<GoogleCampaignAutomation> = {}): GoogleCampaignAutomation => ({
  campaignId: 'cmp_1', externalCampaignId: '111', name: 'Campaign A', type: 'SEARCH', status: 'ENABLED',
  aiMax: 'off', campaignBroadMatch: 'off', searchPartners: 'on', displayExpansion: 'off', finalUrlExpansion: 'not_applicable',
  finalUrlExpansionByDefault: false, textCustomization: 'off', dynamicSearchAds: 'off', brandExclusions: null,
  adGroupsWithoutSearchTermMatching: null, movedToAiMaxAt: null, flagsReadAt: '2026-10-13T06:30:00.000Z', ...over,
})

const change = (over: Partial<GoogleOutsideChange> = {}): GoogleOutsideChange => ({
  changedAt: '2026-10-10T10:00:00.000Z', campaignId: 'cmp_1', externalCampaignId: '111', campaignName: 'Campaign A', resourceType: 'CAMPAIGN',
  operation: 'UPDATE', changedFields: ['status'], source: 'google_ads_web', sourceText: 'Google Ads website', who: 'person', watched: false,
  summary: 'Status changed', ...over,
})

function acts(over: Partial<GoogleActsOnItsOwn> = {}): GoogleActsOnItsOwn {
  return {
    read: { autoApply: read({ resource: 'AUTO_APPLY' }), settings: read({ resource: 'CAMPAIGN_SETTINGS' }), adGroups: read({ resource: 'AD_GROUPS' }), campaignNegatives: read({ resource: 'CAMPAIGN_NEGATIVES' }) },
    autoApply: { enabled: [{ type: 'KEYWORD', typeText: 'Add new keywords', since: '2026-09-01', changedAt: null }], paused: [{ type: 'CAMPAIGN_BUDGET', typeText: 'Raise budgets', since: null, changedAt: null }] },
    campaigns: [camp(), camp({ campaignId: 'cmp_2', name: 'Campaign B', searchPartners: 'off' }), camp({ campaignId: 'cmp_3', flagsReadAt: null }), camp({ campaignId: 'cmp_4', status: 'REMOVED' })],
    outsideChanges: {
      nexusWrites: 0, coveredFrom: '2026-09-13T00:00:00.000Z', coveredThrough: '2026-10-13T06:30:00.000Z',
      bySource: [{ source: 'google_automatic', sourceText: 'Google, automatically', count: 3 }, { source: 'google_ads_web', sourceText: 'Google Ads website', count: 2 }],
      items: [change()],
    },
    ...over,
  }
}

describe('Google acts on its own (R12)', () => {
  it('a setting in words: On / Off / — / Not read yet; settings not read are "Not read yet" even if a flag came', () => {
    expect(wideningCell(camp(), 'searchPartners')).toEqual({ text: 'On', tone: 'warning' })
    expect(wideningCell(camp(), 'aiMax')).toEqual({ text: 'Off', tone: 'neutral' })
    expect(wideningCell(camp(), 'finalUrlExpansion').text).toBe('—')
    expect(wideningCell(camp({ aiMax: null }), 'aiMax').text).toBe(NOT_READ_YET)
    expect(wideningCell(camp({ flagsReadAt: null }), 'searchPartners').text).toBe(NOT_READ_YET)
  })

  it('how many are on: null (never 0) when not read; "On in N" over the campaigns shown', () => {
    expect(wideningOn(camp())).toBe(1)
    expect(wideningOn(camp({ flagsReadAt: null }))).toBeNull()
    const rows = [camp(), camp({ searchPartners: 'off' }), camp({ flagsReadAt: null })]
    expect(wideningTotal(rows, 'searchPartners')).toBe('On in 1')
    expect(wideningTotal([camp({ flagsReadAt: null })], 'searchPartners')).toBe('—')
    expect(wideningCampaigns(acts().campaigns).map((c) => c.campaignId)).toEqual(['cmp_1', 'cmp_2', 'cmp_3'])
  })

  it('the summary card: auto-apply, widening settings and changes by Google', () => {
    const s = actsSummary(acts())
    expect(s.autoApply).toEqual({ text: 'On for 1 kind of recommendation', tone: 'warning' })
    expect(s.widening).toEqual({ text: 'On in 1 of 2 campaigns; 1 not read yet', tone: 'warning' })
    // Counted from the full counts per source, not from the ≤200 rows listed.
    expect(s.changes).toEqual({ text: '3 by Google itself, of 5 changes outside Nexus', tone: 'warning', count: 3 })
  })

  it('nothing read is "Not read yet" on every line, never "Off" or 0', () => {
    const s = actsSummary(acts({
      autoApply: null,
      campaigns: [camp({ flagsReadAt: null })],
      outsideChanges: { nexusWrites: 0, coveredFrom: null, coveredThrough: null, bySource: [], items: [] },
    }))
    expect([s.autoApply.text, s.widening.text, s.changes.text]).toEqual([NOT_READ_YET, NOT_READ_YET, NOT_READ_YET])
    expect(s.changes.count).toBeNull()
    expect(actsSummary(acts({ autoApply: { enabled: [], paused: [] } })).autoApply).toEqual({ text: 'Off for every kind', tone: 'success' })
  })

  it('auto-apply rows: the ones that are on first, in Google’s words', () => {
    expect(autoApplyRows(acts().autoApply).map((r) => [r.kind, r.state, r.on])).toEqual([['Add new keywords', 'On', true], ['Raise budgets', 'Paused', false]])
    expect(autoApplyRows(null)).toEqual([])
  })

  it('changes outside Nexus: newest first, who in words, never an e-mail', () => {
    const rows = outsideChangeRows([
      change({ changedAt: '2026-10-01T10:00:00.000Z', summary: 'Budget changed by someone@example.com' }),
      change({ changedAt: '2026-10-05T10:00:00.000Z', who: 'google_auto_apply', source: 'google_automatic', sourceText: 'Google, automatically', campaignName: null, campaignId: null, externalCampaignId: null }),
    ], 'UTC')
    expect(rows.map((r) => [r.when, r.campaign, r.who, r.madeIn, r.what])).toEqual([
      ['5 Oct 2026, 10:00', 'The account', 'Google, by auto-apply', 'Google, automatically', 'Status changed'],
      ['1 Oct 2026, 10:00', 'Campaign A', 'A person in Google Ads', 'Google Ads website', 'Budget changed by a person'],
    ])
  })

  it('says the span read, and when the list shows only the newest changes', () => {
    const o = acts().outsideChanges
    expect(outsideChangesNote(o, 'UTC')).toBe('Changes read from 13 Sep 2026, 00:00 to 13 Oct 2026, 06:30, as Google records them. Google keeps 30 days. The list shows the newest 1 of 5.')
    expect(outsideChangesNote({ ...o, bySource: [{ source: 'google_ads_web', sourceText: 'x', count: 1 }] }, 'UTC')).not.toMatch(/newest/)
    expect(outsideChangesNote({ ...o, coveredThrough: null })).toBe('Nexus has not read the change history from Google yet.')
    expect(outsideChangesNote({ ...o, coveredFrom: null }, 'UTC')).toMatch(/has read none of the last 30 days/)
  })
})

describe('Google’s recommendations (R13)', () => {
  const impact = {
    base: { impressions: 1000, clicks: 50, spendCents: 10_000, conversions: 2, conversionValueCents: 8_000 },
    potential: { impressions: 1500, clicks: 80, spendCents: 15_000, conversions: 3.5, conversionValueCents: 13_000 },
  }

  it('what Google expects one to add: potential less base; no estimate is "—", never 0', () => {
    expect(impactExtra(impact, 'conversions')).toBe(1.5)
    expect(impactExtra(impact, 'spendCents')).toBe(5_000)
    expect(impactExtra(null, 'conversions')).toBeNull()
    expect(impactExtra(undefined, 'clicks')).toBeNull()
    expect(impactExtra({ base: { ...impact.base, spendCents: undefined }, potential: impact.potential }, 'spendCents')).toBeNull()
    expect(signedText(impactExtra(impact, 'clicks'), formatInt)).toBe('+30')
    expect(signedText(-200, (n) => formatMoney(n, 'EUR'))).toBe('−€2.00')
    expect(signedText(null, formatInt)).toBe('—')
  })

  it('says when they were read and that Nexus applies none', () => {
    expect(recommendationsNote(read(), 'UTC')).toBe('Google’s suggestions, read 13 Oct 2026, 06:30. Nexus applies none of them; to apply or dismiss one, use Google Ads. They can be out of date within a day.')
    expect(autoAppliedText(true)).toEqual({ text: 'Yes, by auto-apply', tone: 'warning' })
    expect(autoAppliedText(false).text).toBe('No')
  })

  it('no totals: Google’s estimates overlap', () => {
    const src = readFileSync(fileURLToPath(new URL('./GoogleRecommendationsTab.tsx', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/showTotal/)
    expect(src).not.toMatch(/\btotal:/)
  })
})

describe('disapprovals (R15) and words', () => {
  it('statuses in words', () => {
    expect(adIssueStatus('DISAPPROVED')).toEqual({ text: 'Disapproved', tone: 'danger' })
    expect(adIssueStatus('APPROVED_LIMITED').text).toBe('Limited')
    expect(productIssueStatus('not_eligible')).toEqual({ text: 'Not eligible', tone: 'danger' })
    expect(productIssueStatus(null).text).toBe(NOT_READ_YET)
  })

  it('Google’s codes in words; words stay words', () => {
    expect(codeWords('DESTINATION_NOT_WORKING')).toBe('Destination not working')
    expect(codeWords('Misleading content')).toBe('Misleading content')
    expect(codeWords(null)).toBe('—')
  })
})
