import { describe, expect, it } from 'vitest'
import { parseInboxQuery } from '../../inbox/inboxQuery'
import {
  MANAGE_ALERTS,
  RATING_DROP_NO_SUGGEST,
  agoWords,
  alertActions,
  alertApiStatus,
  alertFilterParam,
  alertReviewsLink,
  alertTiles,
  alertTitle,
  bulkHeld,
  bulkLabel,
  bulkPlan,
  bulkResultWords,
  checkWords,
  decisionWords,
  emptyTitle,
  filterChip,
  fixWords,
  parseAlertFilter,
  riseWords,
  shownWords,
  timeToResolveWords,
  toggleFilter,
  whoWords,
  type AlertItem,
  type AlertsAnswer,
} from './alertsModel'

const NOW = Date.parse('2026-10-26T10:34:00Z')

const alert = (over: Partial<AlertItem> = {}): AlertItem => ({
  id: 'a-1',
  status: 'OPEN',
  kind: 'complaint',
  rating: null,
  theme: { key: 'FIT_SIZING', label: 'Fit & sizing' },
  product: { id: 'p-1', sku: 'TJ-BLK', name: 'Touring jacket' },
  market: 'DE',
  channels: ['AMAZON'],
  where: 'Amazon Germany',
  from: 8,
  to: 18,
  multiplier: 2.25,
  basis: '9 of 50 reviews in 7 days',
  count: 9,
  phrases: ['runs small'],
  detectedAt: '2026-10-26T08:00:00Z',
  newToday: true,
  acknowledged: null,
  resolved: null,
  fixes: { open: 0, sent: 0, applied: 0, dismissed: 0 },
  ...over,
})

describe('the status filter', () => {
  it('is Open by default, and every alert with ALL', () => {
    expect(parseAlertFilter(null)).toBe('OPEN')
    expect(parseAlertFilter('resolved')).toBe('RESOLVED')
    expect(parseAlertFilter('all')).toBe('ALL')
    expect(parseAlertFilter('nonsense')).toBe('OPEN')
    expect(alertFilterParam('OPEN')).toBeNull()
    expect(alertFilterParam('ALL')).toBe('ALL')
    expect(alertApiStatus('ALL')).toBeNull()
    expect(alertApiStatus('ACKNOWLEDGED')).toBe('ACKNOWLEDGED')
  })

  it('toggles with the tiles, and says the chip and the empty list', () => {
    expect(toggleFilter('OPEN', 'RESOLVED')).toBe('RESOLVED')
    expect(toggleFilter('RESOLVED', 'RESOLVED')).toBe('ALL')
    expect(filterChip('OPEN')).toEqual({ label: 'Status: Open', removeLabel: 'Remove: Open only — show every alert' })
    expect(filterChip('ALL')).toBeNull()
    expect(emptyTitle('OPEN')).toBe('No open alerts')
    expect(shownWords(3, 'OPEN')).toBe('3 open alerts')
    expect(shownWords(1, 'ALL')).toBe('1 alert')
  })
})

describe('tiles and the check', () => {
  const answer: AlertsAnswer = {
    items: [alert(), alert({ id: 'a-2', newToday: false })],
    count: 2,
    counts: { open: 2, acknowledged: 1, resolved: 4 },
    timeToResolve: { days: 4, change: -2 },
    check: { lastRunAt: '2026-10-26T10:17:00Z', lastStatus: 'SUCCESS', nextRunAt: '2026-10-26T11:17:00Z', schedule: '17 * * * *' },
  }

  it('counts each status and the new ones of today', () => {
    expect(alertTiles(answer).map((t) => [t.label, t.value, t.hint])).toEqual([
      ['Open', '2', '1 new today'],
      ['Acknowledged', '1', 'someone is on it'],
      ['Resolved', '4', 'last 30 days'],
    ])
  })

  it('says the time to resolve, faster being good news', () => {
    expect(timeToResolveWords(answer.timeToResolve)).toEqual({ value: '4 days', delta: { value: '−2 days', positive: true } })
    expect(timeToResolveWords({ days: null, change: null })).toEqual({ value: '—', delta: null })
    expect(timeToResolveWords({ days: 1, change: 0.5 })).toEqual({ value: '1 day', delta: { value: '+0.5 days', positive: false } })
  })

  it('says when the hourly check ran', () => {
    expect(checkWords(answer.check, NOW)).toEqual({ tone: 'success', words: 'Checked 17 min ago' })
    expect(checkWords({ ...answer.check, lastStatus: 'FAILED' }, NOW).tone).toBe('danger')
    expect(checkWords({ ...answer.check, lastRunAt: null }, NOW)).toEqual({ tone: 'neutral', words: 'Not checked yet' })
    expect(agoWords('2026-10-24T10:34:00Z', NOW)).toBe('2 days ago')
  })
})

describe('one alert', () => {
  it('words the rise, who is on it, and its fixes', () => {
    expect(alertTitle(alert())).toBe('Fit & sizing comes up 2.3× as often')
    expect(alertTitle(alert({ multiplier: 3 }))).toBe('Fit & sizing comes up 3× as often')
    expect(riseWords(alert())).toBe('8% → 18% of reviews (9 of 50 reviews in 7 days)')
    expect(whoWords(alert(), NOW)).toBeNull()
    expect(whoWords(alert({ status: 'ACKNOWLEDGED', acknowledged: { by: 'Teammate A', at: '2026-10-26T07:34:00Z' } }), NOW)).toBe('Acknowledged by Teammate A · 3 h ago')
    expect(whoWords(alert({ status: 'RESOLVED', resolved: { by: 'Teammate B', at: '2026-10-24T10:34:00Z' } }), NOW)).toBe('Resolved by Teammate B · 2 days ago')
    expect(fixWords(alert())).toBeNull()
    expect(fixWords(alert({ fixes: { open: 2, sent: 0, applied: 0, dismissed: 1 } }))).toBe('2 fixes in Fixes')
    expect(fixWords(alert({ fixes: { open: 0, sent: 1, applied: 0, dismissed: 0 } }))).toBe('1 fix sent for approval')
  })

  it('shows only the buttons that can work', () => {
    expect(alertActions(alert())).toEqual({ acknowledge: true, resolve: true, reopen: false, suggest: true, suggestHeld: null })
    expect(alertActions(alert({ status: 'ACKNOWLEDGED' }))).toEqual({ acknowledge: false, resolve: true, reopen: true, suggest: true, suggestHeld: null })
    expect(alertActions(alert({ status: 'RESOLVED' }))).toEqual({ acknowledge: false, resolve: false, reopen: true, suggest: false, suggestHeld: null })
    expect(alertActions(alert({ fixes: { open: 1, sent: 0, applied: 0, dismissed: 0 } })).suggest).toBe(false)
  })

  it('opens its own reviews in the Inbox: negative, theme, market, the product by id, the period holding its 7 days (A5)', () => {
    const detected = Date.parse(alert().detectedAt)
    const atOnce = alertReviewsLink(alert(), { channel: null }, detected)
    expect(atOnce.href).toBe('/marketing/reviews/inbox?period=7d&channel=AMAZON&market=DE&mood=NEGATIVE&theme=FIT_SIZING&product=p-1')
    expect(atOnce.label).toBe('See the 9 reviews')
    const q = parseInboxQuery(atOnce.href.slice(atOnce.href.indexOf('?'))).query
    expect(q).toMatchObject({ period: '7d', channels: ['AMAZON'], markets: ['DE'], moods: ['NEGATIVE'], themes: ['FIT_SIZING'], product: 'p-1' })
    // Later, the Inbox's shortest period that still holds the alert's 7 days is 30 days: the label no longer names a count.
    const later = alertReviewsLink(alert(), { channel: null }, detected + 3 * 86_400_000)
    expect(later.href).toContain('period=30d')
    expect(later.label).toBe('See the negative reviews')
    expect(alertReviewsLink(alert({ channels: ['AMAZON', 'EBAY'], product: null }), { channel: 'EBAY' }, detected).href).toBe('/marketing/reviews/inbox?period=7d&channel=EBAY&market=DE&mood=NEGATIVE&theme=FIT_SIZING')
  })
})

describe('a rating drop', () => {
  const drop = alert({
    id: 'd-1', kind: 'rating_drop', rating: { before: 4.4, now: 3.9, change: -0.47 }, theme: { key: 'RATING_DROP', label: 'Rating drop' },
    channels: ['SHOPIFY'], where: 'Shopify Germany', from: null, to: null, multiplier: null, basis: '6 rated reviews in 7 days · 22 in the 28 days before', count: 6,
  })

  it('says how far the stars fell, from what to what', () => {
    expect(alertTitle(drop)).toBe('Rating fell 0.5 stars')
    expect(alertTitle({ ...drop, rating: { before: 4, now: 3, change: -1 } })).toBe('Rating fell 1.0 star')
    expect(riseWords(drop)).toBe('4.4 → 3.9 stars (6 rated reviews in 7 days · 22 in the 28 days before)')
    expect(decisionWords('RESOLVED', drop)).toBe('Resolved: Rating drop · Shopify Germany. If the drop is still there 7 days from now, a new alert opens.')
  })

  it('opens every review of its product (by id) in its market: no theme, no mood, never a count', () => {
    const detected = Date.parse(drop.detectedAt)
    expect(alertReviewsLink(drop, { channel: null }, detected)).toEqual({
      href: '/marketing/reviews/inbox?period=7d&channel=SHOPIFY&market=DE&product=p-1',
      label: 'See the product’s reviews',
    })
    expect(alertReviewsLink(drop, { channel: null }, detected + 3 * 86_400_000).href).toContain('period=30d')
  })

  it('takes Acknowledge and Resolve like any alert; Suggest fixes holds with why', () => {
    expect(alertActions(drop)).toEqual({ acknowledge: true, resolve: true, reopen: false, suggest: true, suggestHeld: RATING_DROP_NO_SUGGEST })
    expect(bulkPlan([drop], 'acknowledge').apply).toEqual(['d-1'])
    const plan = bulkPlan([drop], 'suggest')
    expect(plan).toEqual({ apply: [], held: [{ id: 'd-1', words: RATING_DROP_NO_SUGGEST }] })
    expect(bulkHeld(true, 'suggest', 1, plan)).toBe(RATING_DROP_NO_SUGGEST)
    expect(bulkHeld(true, 'suggest', 2, bulkPlan([drop, alert({ id: 'r', status: 'RESOLVED' })], 'suggest'))).toBe('No ticked alert can ask for fixes: each is resolved, has fixes already, or is a rating drop.')
  })
})

describe('the bulk bar', () => {
  const open = alert({ id: 'o' })
  const acked = alert({ id: 'k', status: 'ACKNOWLEDGED' })
  const done = alert({ id: 'r', status: 'RESOLVED' })
  const withFix = alert({ id: 'f', fixes: { open: 1, sent: 0, applied: 0, dismissed: 0 } })

  it('counts the alerts an action changes and names why it leaves the others', () => {
    const ack = bulkPlan([open, acked, done], 'acknowledge')
    expect(ack.apply).toEqual(['o'])
    expect(ack.held).toEqual([{ id: 'k', words: 'Already acknowledged.' }, { id: 'r', words: 'Already resolved: reopen it first.' }])
    expect(bulkLabel('acknowledge', ack)).toBe('Acknowledge 1')
    expect(bulkPlan([open, acked, done], 'resolve').apply).toEqual(['o', 'k'])
    expect(bulkPlan([open, done, withFix], 'suggest')).toEqual({ apply: ['o'], held: [{ id: 'r', words: 'Resolved: reopen it to ask for fixes.' }, { id: 'f', words: 'It has fixes already: they are on the Fixes page.' }] })
  })

  it('holds a button with why: the permission, nothing it applies to, more than 5 to suggest for', () => {
    const none = bulkPlan([acked, done], 'acknowledge')
    expect(bulkHeld(true, 'acknowledge', 2, none)).toBe('Every ticked alert is already acknowledged or resolved.')
    expect(bulkHeld(true, 'resolve', 1, bulkPlan([done], 'resolve'))).toBe('Every ticked alert is already resolved.')
    expect(bulkHeld(false, 'resolve', 1, bulkPlan([open], 'resolve'))).toBe(MANAGE_ALERTS)
    const six = bulkPlan(Array.from({ length: 6 }, (_, i) => alert({ id: `s${i}` })), 'suggest')
    expect(bulkHeld(true, 'suggest', 6, six)).toBe('Suggest fixes works on up to 5 alerts at a time: untick 1.')
    expect(bulkHeld(true, 'suggest', 1, bulkPlan([open], 'suggest'))).toBeNull()
    expect(bulkLabel('suggest', bulkPlan([open], 'suggest'))).toBe('Suggest fixes for 1')
  })

  it('says the result in the server’s count', () => {
    expect(bulkResultWords('acknowledge', 2, [])).toBe('2 alerts acknowledged')
    expect(bulkResultWords('resolve', 1, [{ words: 'Already resolved.' }])).toBe('1 alert resolved · 1 left out: Already resolved.')
    expect(bulkResultWords('suggest', 2, [], 5)).toBe('5 fixes suggested for 2 alerts')
  })
})
