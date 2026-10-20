/**
 * Meta ads step 2 — the pure rules of Ads › Meta: what the page may show in each state, "Not read" never a 0, money in
 * the account's own currency and "—" when hidden for the role, ratios from the sums, Meta's own words. Made-up names.
 */
import { describe, expect, it } from 'vitest'
import type { MetaAdsDay, MetaAdsOverview, MetaConnection } from '@/lib/meta-ads/contract'
import {
  accountLine, budgetText, chartEmptyText, chartHasMoney, chartPoints, comparedWindow, coverageNote, creativeText, dayRows, effectiveText, incompleteReadNote,
  listCoverageNote, metaPageState, metricTiles, moneyHidden, objectiveLabel, provisionalNote, ratiosOf, readNowNote, statusLabel, sumMetrics, tokenExpiryBanner,
} from './metaAds'

const DAY = 86_400_000
const connection = (over: Partial<MetaConnection> = {}): MetaConnection => ({
  connectionId: 'conn-1', label: 'Meta', state: 'ok', stateText: 'Nexus reads “Shop A” once a day.', authStatus: 'connected',
  systemUser: { id: '120000000000001', name: 'Nexus system user' }, appId: '1234567',
  token: { checkedAt: null, isValid: true, expiresAt: null, neverExpires: true, renewsFrom: null, lastRenewedAt: null, type: 'SYSTEM_USER', typeText: 'System-user token', scopes: ['ads_read'], missing: [], problem: null },
  adAccount: { adAccountId: '1234567890', name: 'Shop A', currency: 'EUR', timeZone: 'Europe/Rome', statusText: 'Active', businessId: null },
  page: null, instagram: null, lastError: null,
  read: { lastReadAt: '2026-10-20T06:52:00Z', lastDataDay: '2026-10-19', nextReadAt: '2026-10-21T06:50:00Z', lastStatus: 'SUCCESS', lastError: null },
  ...over,
})
const metrics = (spendCents: number | null | undefined, extra: Record<string, number> = {}) => ({
  impressions: 1000, clicks: 50, linkClicks: 40, purchases: 2, ctr: 0.05, ...(spendCents === undefined ? {} : { spendCents, purchaseValueCents: spendCents === null ? null : spendCents * 3 }), ...extra,
})
const overview = (over: Partial<MetaAdsOverview> = {}): MetaAdsOverview => ({
  connections: [connection()], connection: connection(), account: null,
  window: { from: '2026-10-18', to: '2026-10-19', provisionalFrom: '2026-10-18' }, currency: 'EUR', timeZone: 'Europe/Rome', dataAsOf: '2026-10-20T06:52:00Z',
  coverage: { daysInWindow: 2, daysRead: 2, missingDays: [] }, totals: metrics(1000), previous: null, days: [],
  ...over,
})

describe('what the page may show', () => {
  it('not connected, a token problem, a missing permission, no account chosen: words and one way forward to Settings', () => {
    expect(metaPageState({ loading: false, error: null, overview: overview({ connections: [], connection: null }) })).toMatchObject({ kind: 'not_connected', showData: false, action: { href: '/settings/channels/meta' } })
    for (const state of ['sign_in_needed', 'token_problem', 'permission_missing', 'choose_account'] as const) {
      const c = connection({ state, stateText: `the ${state} sentence` })
      const view = metaPageState({ loading: false, error: null, overview: overview({ connection: c, connections: [c] }) })
      expect(view).toMatchObject({ kind: state, showData: false, canReadNow: false, action: { href: '/settings/channels/meta' } })
    }
  })
  it('the first read pending offers Read now and no numbers; a failed first read shows no numbers', () => {
    const pending = connection({ state: 'first_read_pending', read: { ...connection().read, lastDataDay: null } })
    expect(metaPageState({ loading: false, error: null, overview: overview({ connection: pending }), timeZone: 'UTC' })).toMatchObject({ kind: 'first_read_pending', showData: false, canReadNow: true })
    const failed = connection({ state: 'read_failed', read: { ...connection().read, lastDataDay: null, lastError: 'Meta asked Nexus to slow down.' } })
    expect(metaPageState({ loading: false, error: null, overview: overview({ connection: failed }) })).toMatchObject({ kind: 'read_failed', showData: false })
  })
  it('a failed read with an earlier good one shows the numbers under a danger banner naming the newest day', () => {
    const failed = connection({ state: 'read_failed', read: { ...connection().read, lastError: 'Meta did not answer.' } })
    const view = metaPageState({ loading: false, error: null, overview: overview({ connection: failed }) })
    expect(view).toMatchObject({ kind: 'read_failed', showData: true, banner: { tone: 'danger', text: expect.stringMatching(/19 Oct 2026/) } })
  })
  it('a read that lost the token, with a good token check since: the banner says what is true now, not "make a new token"', () => {
    const lost = (checkedAt: string | null) => connection({
      state: 'read_failed',
      stateText: 'The last read of “Shop A” stopped because Meta refused the token then; the token has been checked valid since, and Nexus reads again now.',
      token: { ...connection().token, checkedAt },
      read: { ...connection().read, lastStatus: 'AUTH_LOST', lastReadAt: '2026-10-20T06:50:00.000Z', lastError: 'Meta no longer accepts this business\'s system-user token. Make a new token in Meta Business settings.' },
    })
    const after = metaPageState({ loading: false, error: null, overview: overview({ connection: lost('2026-10-20T09:00:00.000Z') }) })
    expect(after).toMatchObject({ kind: 'read_failed', banner: { text: expect.stringMatching(/checked valid since, and Nexus reads again now/) } })
    expect(`${after.banner?.title} ${after.banner?.text}`).not.toMatch(/Make a new token/)
    // No good check after the failed read: the read's own sentence stands.
    const before = metaPageState({ loading: false, error: null, overview: overview({ connection: lost('2026-10-20T05:00:00.000Z') }) })
    expect(before).toMatchObject({ kind: 'read_failed', banner: { text: expect.stringMatching(/Make a new token/) } })
  })
  it('ok shows the numbers; a token 14 days or less from expiry adds a warning with the date', () => {
    const now = Date.UTC(2026, 9, 20)
    expect(metaPageState({ loading: false, error: null, overview: overview(), now })).toMatchObject({ kind: 'ok', showData: true, banner: null })
    const soon = connection({ token: { ...connection().token, neverExpires: false, expiresAt: new Date(now + 10 * DAY).toISOString() } })
    expect(tokenExpiryBanner(soon, now)).toMatchObject({ tone: 'warning', title: 'The Meta token expires on 30 Oct 2026' })
    expect(tokenExpiryBanner(connection({ token: { ...connection().token, expiresAt: new Date(now + 40 * DAY).toISOString() } }), now)).toBeNull()
  })
  it('a PARTIAL or THROTTLED last read is a warning with its own sentence, never a plain ok', () => {
    expect(metaPageState({ loading: false, error: null, overview: overview() })).toMatchObject({ kind: 'ok', readNote: null })
    const partial = connection({ read: { ...connection().read, lastStatus: 'PARTIAL', lastError: 'The ad numbers could not be read.' } })
    expect(metaPageState({ loading: false, error: null, overview: overview({ connection: partial, connections: [partial] }) })).toMatchObject({
      kind: 'ok', showData: true, readNote: { tone: 'warning', title: 'The last read from Meta was not complete', text: expect.stringMatching(/^The ad numbers could not be read\. Some numbers below may be missing/) },
    })
    const throttled = connection({ read: { ...connection().read, lastStatus: 'THROTTLED', lastError: null } })
    expect(incompleteReadNote(throttled)).toMatchObject({ title: expect.stringMatching(/slow down/), text: expect.stringMatching(/^Meta asked Nexus to slow down\./) })
    expect(incompleteReadNote(connection())).toBeNull()
  })
  it('each list says its own missing days, and a list never read says so plainly', () => {
    expect(listCoverageNote('ad sets', { daysInWindow: 3, daysRead: 3, missingDays: [] })).toBeNull()
    expect(listCoverageNote('ads', { daysInWindow: 3, daysRead: 1, missingDays: ['2026-10-17', '2026-10-18'] })).toBe('The ads have no Meta numbers for 17 Oct – 18 Oct 2026; their numbers and totals leave those days out.')
    expect(listCoverageNote('ad sets', { daysInWindow: 3, daysRead: 0, missingDays: ['2026-10-17', '2026-10-18', '2026-10-19'] })).toMatch(/has not read the ad sets' numbers for these days yet/)
    expect(listCoverageNote('campaigns', null)).toBeNull()
  })
  it('money hidden for the role says so in the chart, never "nothing spent"; nothing spent says that', () => {
    const hiddenDays: MetaAdsDay[] = [
      { date: '2026-10-18', provisional: false, read: true, reach: 10, impressions: 100, clicks: 5, linkClicks: 4, purchases: 1 },
      { date: '2026-10-19', provisional: true, read: false, reach: null, impressions: null, clicks: null, linkClicks: null, purchases: null },
    ]
    expect(moneyHidden(hiddenDays)).toBe(true)
    expect(chartHasMoney(hiddenDays)).toBe(false)
    expect(chartEmptyText(hiddenDays)).toBe('Money is hidden for your role.')
    const nothing: MetaAdsDay[] = [{ date: '2026-10-18', provisional: false, read: true, reach: 0, impressions: 0, clicks: 0, linkClicks: 0, spendCents: 0, purchases: 0, purchaseValueCents: 0 }]
    expect(moneyHidden(nothing)).toBe(false)
    expect(chartEmptyText(nothing)).toBe('No amount spent or purchase value to draw for these days.')
    // No day read at all is not "hidden" either.
    expect(moneyHidden([hiddenDays[1]!])).toBe(false)
  })
  it('a failed load says so; while loading nothing is claimed', () => {
    expect(metaPageState({ loading: false, error: 'The server did not answer.', overview: null })).toMatchObject({ kind: 'load_error', text: 'The server did not answer.' })
    expect(metaPageState({ loading: true, error: null, overview: null })).toMatchObject({ kind: 'loading', showData: false })
  })
})

describe('numbers', () => {
  it('a day not read is "Not read" with no number, never 0; the chart leaves a gap', () => {
    const days: MetaAdsDay[] = [
      { date: '2026-10-19', provisional: true, read: true, reach: 300, impressions: 1000, clicks: 50, linkClicks: 40, spendCents: 1234, purchases: 2, purchaseValueCents: 5000 },
      { date: '2026-10-18', provisional: false, read: false, reach: null, impressions: null, clicks: null, linkClicks: null, spendCents: null, purchases: null, purchaseValueCents: null },
    ]
    expect(dayRows(days, 'EUR').map((r) => r.cells)).toEqual([
      ['19 Oct 2026', 'Can still change', '1,000', '50', '€12.34', '2', '€50.00'],
      ['18 Oct 2026', 'Not read', '—', '—', '—', '—', '—'],
    ])
    const points = chartPoints([...days].reverse(), 'EUR')
    expect(points[0]).toEqual({ day: '18 Oct' })
    expect(points[1]).toMatchObject({ spend: 12.34, value: 50 })
    expect(chartHasMoney(days)).toBe(true)
  })
  it('money hidden for the role is "—" with a hint, never 0; ratios come from the sums', () => {
    const tiles = metricTiles(overview({ totals: metrics(undefined) }))
    expect(tiles.find((t) => t.key === 'spend')).toMatchObject({ value: '—', hint: 'Hidden for your role' })
    expect(tiles.find((t) => t.key === 'roas')?.value).toBe('—')
    const s = sumMetrics([metrics(1000), metrics(3000), null])
    expect(s).toMatchObject({ spendCents: 4000, purchaseValueCents: 12000, clicks: 100, purchases: 4 })
    expect(ratiosOf(s)).toMatchObject({ roas: 3, cpcCents: 40, costPerPurchaseCents: 1000, ctr: 0.05 })
    expect(sumMetrics([metrics(1000), metrics(null)])?.spendCents).toBeNull()
  })
  it('compares only when every day of both windows was read', () => {
    const previous = { ...metrics(500), from: '2026-10-16', to: '2026-10-17' }
    expect(comparedWindow(overview({ previous }))).toEqual(previous)
    expect(comparedWindow(overview({ previous, coverage: { daysInWindow: 2, daysRead: 1, missingDays: ['2026-10-18'] } }))).toBeNull()
    expect(metricTiles(overview({ previous })).find((t) => t.key === 'spend')?.delta).toEqual({ text: '▲ 100.0%', good: false })
  })
  it('days not read are named, and late attribution is said', () => {
    expect(coverageNote(overview({ coverage: { daysInWindow: 3, daysRead: 1, missingDays: ['2026-10-17', '2026-10-18'] } }))).toBe('No Meta numbers for 17 Oct – 18 Oct 2026; totals leave them out.')
    expect(provisionalNote(3)).toMatch(/last 3 days can still change: Meta adds purchases up to each ad set's attribution window later/)
    // Since 2025-06-10: on-Meta purchases on the impression's day, purchases in the shop on the day they happen; 28 days re-read.
    expect(provisionalNote(1)).toMatch(/on the day of the ad's impression, purchases in the shop on the day they happen.*28 days/)
  })
  it('the account line: status, and the spending limit or none', () => {
    expect(accountLine({ currency: 'EUR', account: { adAccountId: '1', name: 'Shop A', statusText: 'Active', accountStatus: 1, disableReason: 0, amountSpentCents: 1500, spendCapCents: 50000, balanceCents: 0, settingsReadAt: null, lastReadAt: null, lastSyncStatus: null, lastSyncError: null } }))
      .toEqual(['Status: Active', 'spending limit €500.00, €15.00 spent toward it'])
    expect(accountLine({ currency: 'EUR', account: { adAccountId: '1', name: null, statusText: null, accountStatus: null, disableReason: null, spendCapCents: null, settingsReadAt: null, lastReadAt: null, lastSyncStatus: null, lastSyncError: null } }))
      .toEqual(['Status: not read yet', 'no account spending limit'])
  })
})

describe('Meta\'s words', () => {
  it('statuses, effective statuses, objectives, budgets and creatives', () => {
    expect(statusLabel('ACTIVE')).toBe('Active')
    expect(statusLabel('DELETED')).toBe('Deleted')
    expect(statusLabel(null)).toBe('Not read yet')
    expect(effectiveText('ACTIVE', 'CAMPAIGN_PAUSED')).toBe('Campaign paused')
    expect(effectiveText('ACTIVE', 'DISAPPROVED')).toBe('Rejected')
    expect(effectiveText('PAUSED', 'PAUSED')).toBeNull()
    expect(objectiveLabel('OUTCOME_SALES')).toBe('Sales')
    expect(budgetText({ dailyBudgetCents: 5000, lifetimeBudgetCents: null }, 'EUR')).toBe('€50.00 a day')
    expect(budgetText({ dailyBudgetCents: null, lifetimeBudgetCents: 90000 }, 'EUR')).toBe('€900.00 in total')
    expect(budgetText({ dailyBudgetCents: null, lifetimeBudgetCents: null }, 'EUR')).toBe('On the ad sets')
    expect(budgetText({}, 'EUR')).toBe('—')
    expect(budgetText({ dailyBudgetCents: 500 }, 'JPY')).toMatch(/¥500 a day$/)
    expect(creativeText({ creative: { name: 'n', title: null, body: 'Light summer jacket', objectType: null, thumbnailUrl: null } })).toBe('Light summer jacket')
  })
  it('Read now says what happened', () => {
    expect(readNowNote({ queued: true, reason: null }).tone).toBe('success')
    expect(readNowNote({ queued: false, reason: 'Nexus read this Meta ad account at 06:52 UTC.' }).text).toMatch(/did not start a new read: Nexus read/)
    expect(readNowNote({ error: 'offline' }).tone).toBe('danger')
  })
})
