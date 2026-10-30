import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { markMoney } from '../money/marked'
import {
  DIGEST_DEFAULT_CATEGORIES,
  digestCategoriesOf,
  digestDue,
  digestProblems,
  digestText,
  groupKeyFor,
  GROUP_WINDOW_MS,
  isSnoozedNow,
  MESSAGE_KEYS,
  MESSAGE_TEMPLATES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TABS,
  peopleOf,
  sentenceOf,
  snoozeProblem,
  stateOf,
  TAB_CATEGORIES,
} from './rules'

const NOW = new Date('2026-10-30T09:00:00.000Z')
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000)
const MARCO = '00000000-0000-7000-8000-00000000000a'
const names = new Map([[MARCO, 'Marco']])

describe('the notification centre (B-W2a-20: PLT-138, PLT-142, PLT-152)', () => {
  it('has a sentence in English and Italian for every message key, and every tab names real categories', () => {
    for (const key of MESSAGE_KEYS) {
      expect(MESSAGE_TEMPLATES[key].en, key).toBeTruthy()
      expect(MESSAGE_TEMPLATES[key].it, key).toBeTruthy()
      expect(MESSAGE_TEMPLATES[key].en.match(/\{\w+\}/g)?.sort(), key).toEqual(MESSAGE_TEMPLATES[key].it.match(/\{\w+\}/g)?.sort())
    }
    for (const tab of NOTIFICATION_TABS) for (const category of TAB_CATEGORIES[tab]) expect(NOTIFICATION_CATEGORIES).toContain(category)
    expect(TAB_CATEGORIES.ALL).toEqual(NOTIFICATION_CATEGORIES)
    // Following a record is news in All; System is what the system told me.
    expect(TAB_CATEGORIES.SYSTEM).toEqual(['SYSTEM', 'ALERT'])
  })

  it('builds the sentence for its reader: names read when shown, an amount only when the params hold it (the reader had the grain)', () => {
    const base = { messageKey: 'notifications.approval.quote_requested', recordLabel: 'Q-2026-0142', actorId: MARCO }
    expect(sentenceOf({ ...base, params: { actorId: MARCO } }, names, 'en')).toBe('Marco asks you to approve quote Q-2026-0142')
    const priced = { actorId: MARCO, netAmount: markMoney('price', { minor: 624000, currency: 'EUR' }), marginPct: markMoney('margin', '18.2500') }
    expect(sentenceOf({ ...base, params: priced }, names, 'en')).toBe('Marco asks you to approve quote Q-2026-0142 (EUR 6240.00, margin 18.3 %)')
    expect(sentenceOf({ ...base, params: priced }, names, 'it')).toBe('Marco ti chiede di approvare il preventivo Q-2026-0142 (EUR 6240.00, margine 18.3 %)')
    // A reader who lost a grain: the API's grain filter dropped the marked value, so the sentence has none.
    expect(sentenceOf({ ...base, params: { actorId: MARCO } }, names, 'it')).not.toMatch(/EUR|margine/)
    expect(sentenceOf({ messageKey: 'notifications.mentioned', params: {}, recordLabel: 'PO-1', actorId: null }, names, 'en')).toBe('The system mentioned you on PO-1')
    expect(sentenceOf({ messageKey: 'notifications.mentioned', params: {}, recordLabel: 'PO-1', actorId: 'someone-gone' }, names, 'it')).toBe('Qualcuno ti ha menzionato su PO-1')
    expect(sentenceOf({ messageKey: 'notifications.approval.quote_decided', params: { actorId: MARCO, status: 'REJECTED' }, recordLabel: 'Q-1', actorId: MARCO }, names, 'en')).toBe('Marco rejected your approval request for quote Q-1')
    expect(peopleOf({ params: { actorId: MARCO }, actorId: null })).toEqual([MARCO])
  })

  it('groups notifications of one person, record and kind that come within 15 minutes', () => {
    expect(groupKeyFor(null, 'own', NOW)).toBe('own')
    expect(groupKeyFor({ id: 'first', groupKey: 'first', createdAt: minutes(-5) }, 'own', NOW)).toBe('first')
    expect(groupKeyFor({ id: 'first', groupKey: null, createdAt: minutes(-5) }, 'own', NOW)).toBe('first')
    expect(groupKeyFor({ id: 'old', groupKey: 'old', createdAt: new Date(NOW.getTime() - GROUP_WINDOW_MS - 1) }, 'own', NOW)).toBe('own')
  })

  it('snoozes until a later time (at most 90 days), or until new activity on the record', () => {
    expect(snoozeProblem(minutes(60), NOW)).toBeNull()
    expect(snoozeProblem(null, NOW)).toBeNull()
    expect(snoozeProblem(minutes(-1), NOW)).toMatch(/later/)
    expect(snoozeProblem(new Date(NOW.getTime() + 91 * 86_400_000), NOW)).toMatch(/90 days/)
    const untilTime = { snoozedAt: minutes(-10), snoozedUntil: minutes(10), doneAt: null }
    expect(isSnoozedNow(untilTime, NOW, null)).toBe(true)
    expect(stateOf(untilTime, minutes(11), null)).toBe('OPEN')
    const untilActivity = { snoozedAt: minutes(-10), snoozedUntil: null, doneAt: null }
    expect(stateOf(untilActivity, NOW, minutes(-10))).toBe('SNOOZED')
    expect(stateOf(untilActivity, NOW, minutes(-5))).toBe('OPEN')
    expect(stateOf({ ...untilActivity, doneAt: NOW }, NOW, null)).toBe('DONE')
  })

  it('keeps the digest off until turned on, checks its settings, and is due once a day at its time on its weekdays', () => {
    expect(digestProblems({ on: true, sendTime: '08:00', weekdays: [1, 2, 3, 4, 5], categories: ['MENTION'] })).toEqual([])
    expect(digestProblems({ on: true, sendTime: '8:00', weekdays: [5, 1], categories: [] }).map((issue) => issue.path)).toEqual(['body/sendTime', 'body/weekdays', 'body/categories'])
    expect(digestCategoriesOf({})).toEqual(DIGEST_DEFAULT_CATEGORIES)
    expect(digestCategoriesOf({ categories: ['FOLLOWING', 'nonsense'] })).toEqual(['FOLLOWING'])
    expect(digestDue({ sendTime: '08:00', weekdays: [1, 2, 3, 4, 5] }, { weekday: 5, clock: '08:15' }, false)).toBe(true)
    expect(digestDue({ sendTime: '08:00', weekdays: [1, 2, 3, 4, 5] }, { weekday: 5, clock: '07:45' }, false)).toBe(false)
    expect(digestDue({ sendTime: '08:00', weekdays: [1, 2, 3, 4, 5] }, { weekday: 6, clock: '09:00' }, false)).toBe(false)
    expect(digestDue({ sendTime: '08:00', weekdays: [1, 2, 3, 4, 5] }, { weekday: 5, clock: '09:00' }, true)).toBe(false)
    const text = digestText([{ messageKey: 'notifications.mentioned', params: { actorId: MARCO }, recordLabel: 'SO-1', actorId: MARCO }], 3, names, 'it')
    expect(text.subject).toBe('4 notifiche da guardare')
    expect(text.lines).toEqual(['• Marco ti ha menzionato su SO-1', '… e altre 3 nell’app.'])
  })

  it('declares its events; the live one names no person', () => {
    const created = EVENT_CATALOGUE.get('notification.created', 1)
    expect(created.live?.permission).toBe('home.view')
    expect(Object.keys(created.payload.shape)).not.toContain('userId')
    expect(EVENT_CATALOGUE.get('notification.digest_sent', 1).live).toBeNull()
  })
})
