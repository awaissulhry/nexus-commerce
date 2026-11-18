import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { markMoney } from '../money/marked'
import {
  batchGroupKey,
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
  recordsInGroup,
  sentenceOf,
  snoozeProblem,
  stateOf,
  TAB_CATEGORIES,
  // B-SA-051
  CHANGE_WHAT_MAX,
  changeWhatOf,
  orderChangeBatch,
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

  // F-PR-05b: the bell of an issue's task names its customer ({customer}) and no person.
  it('says a reported problem and an issue going up with the customer’s name, never a person', () => {
    const base = { recordLabel: 'SO-7', actorId: null }
    expect(sentenceOf({ ...base, messageKey: 'notifications.production.problemReported', params: { customer: 'Brand Alpha', count: 1 } }, names, 'en')).toBe('Brand Alpha reported a problem on SO-7: answer in the order’s thread')
    expect(sentenceOf({ ...base, messageKey: 'notifications.production.problemReportedMany', params: { customer: 'Brand Alpha', count: 3 } }, names, 'it')).toBe('Brand Alpha ha segnalato un problema su 3 ordini: rispondi nella conversazione di SO-7')
    expect(sentenceOf({ ...base, messageKey: 'notifications.production.issueEscalatedBackup', params: { customer: 'Brand Alpha', count: 1 } }, names, 'en')).toBe('No answer after 1 working day on SO-7 (Brand Alpha): it now waits on you')
    expect(sentenceOf({ ...base, messageKey: 'notifications.production.issueEscalatedOwner', params: { customer: 'Brand Alpha', count: 1 } }, names, 'en')).toBe('No answer after 2 working days on SO-7 (Brand Alpha): it now waits on the Owner and Admin')
    for (const key of ['notifications.production.problemReported', 'notifications.production.issueEscalatedBackup', 'notifications.production.issueEscalatedOwner'] as const) expect(MESSAGE_TEMPLATES[key].en).not.toContain('{actor}')
  })

  it('groups notifications of one person, record and kind that come within 15 minutes', () => {
    expect(groupKeyFor(null, 'own', NOW)).toBe('own')
    expect(groupKeyFor({ id: 'first', groupKey: 'first', createdAt: minutes(-5) }, 'own', NOW)).toBe('first')
    expect(groupKeyFor({ id: 'first', groupKey: null, createdAt: minutes(-5) }, 'own', NOW)).toBe('first')
    expect(groupKeyFor({ id: 'old', groupKey: 'old', createdAt: new Date(NOW.getTime() - GROUP_WINDOW_MS - 1) }, 'own', NOW)).toBe('own')
  })

  it('B-TH-045: a batch is one group per reader and kind, whatever its records; the group says how many records it holds', () => {
    const batch = '0190f0e2-0000-7000-8000-00000000b045'
    expect(batchGroupKey(batch, 'MENTION')).toBe(`batch:${batch}:MENTION`)
    expect(batchGroupKey(batch, 'MENTION')).not.toBe(batchGroupKey(batch, 'FOLLOWING'))
    expect(recordsInGroup([{ recordType: 'SalesOrder', recordId: 'a' }, { recordType: 'SalesOrder', recordId: 'b' }, { recordType: 'SalesOrder', recordId: 'a' }])).toBe(2)
    expect(recordsInGroup([])).toBe(0)
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

// ── B-SA-051 ──
/**
 * B-SA-051 (Sales page plan R9 "ONE bell mechanism per change", P8; review C-7): a change of a sales order is ONE bell item per
 * reader and change — the batch of the command and the order; its sentence says what changed (the change note's first line) and
 * the steps still to do; a work order's followers read it as their work order's order. thread.message_posted names who made it,
 * the order and the count, never in its live fields.
 */
describe('one bell item per change of an order (B-SA-051)', () => {
  const ORDER = '0190f0e2-0000-7000-8000-0000000005a1'
  const OTHER = '0190f0e2-0000-7000-8000-0000000005a2'

  it('names one batch per command and order: the same for the system line, the floor notes and the order’s own move', () => {
    expect(orderChangeBatch('req-1', ORDER)).toBe(orderChangeBatch('req-1', ORDER))
    expect(orderChangeBatch('req-1', ORDER)).not.toBe(orderChangeBatch('req-2', ORDER))
    expect(orderChangeBatch('req-1', ORDER)).not.toBe(orderChangeBatch('req-1', OTHER))
    expect(batchGroupKey(orderChangeBatch('req-1', ORDER), 'FOLLOWING')).toBe(`batch:order-change:req-1:${ORDER}:FOLLOWING`)
  })

  it('quotes what changed: the first line, trimmed, without its closing stop, cut at 120 characters', () => {
    expect(changeWhatOf('Change accepted · Bea Esempio · 10:42\nBrand Alpha asked (portal, 10:05): line 2 · M 40 → 36.')).toBe('Change accepted · Bea Esempio · 10:42')
    expect(changeWhatOf('\n  Done: order amended (revision 3).  \nNext: …')).toBe('Done: order amended (revision 3)')
    expect(changeWhatOf('')).toBe('')
    const long = changeWhatOf(`Order changed: ${'line 2 · M 40 → 36 · '.repeat(10)}`)
    expect(long.length).toBeLessThanOrEqual(CHANGE_WHAT_MAX)
    expect(long.startsWith('Order changed: line 2 · M 40 → 36')).toBe(true)
    expect(long.endsWith('…')).toBe(true)
  })

  it('says it in both languages, with the steps still to do, and on a work order’s face names its order', () => {
    const base = { recordLabel: 'SO-0142', actorId: null }
    expect(sentenceOf({ ...base, messageKey: 'notifications.following.change', params: { what: 'Refused · Bea Esempio · 10:42' } }, names, 'en')).toBe('SO-0142 changed: Refused · Bea Esempio · 10:42.')
    expect(sentenceOf({ ...base, messageKey: 'notifications.following.changeStep', params: { what: 'Change accepted' } }, names, 'it')).toBe('SO-0142 cambiato: Change accepted. Ancora 1 passo da fare.')
    expect(sentenceOf({ ...base, messageKey: 'notifications.following.changeSteps', params: { what: 'Change accepted', count: 2 } }, names, 'en')).toBe('SO-0142 changed: Change accepted. 2 steps still to do.')
    expect(sentenceOf({ ...base, messageKey: 'notifications.following.changeSteps', params: { what: 'Modifica accettata', count: 3 } }, names, 'it')).toBe('SO-0142 cambiato: Modifica accettata. Ancora 3 passi da fare.')
    expect(sentenceOf({ recordLabel: 'WO-0142', actorId: null, messageKey: 'notifications.following.orderChange', params: { what: 'size M now 36', number: 'SO-0142' } }, names, 'en')).toBe('WO-0142: its order SO-0142 changed — size M now 36.')
    expect(sentenceOf({ recordLabel: 'WO-0142', actorId: null, messageKey: 'notifications.following.orderChange', params: { what: 'taglia M ora 36', number: 'SO-0142' } }, names, 'it')).toBe('WO-0142: il suo ordine SO-0142 è cambiato — taglia M ora 36.')
    // A change's words never name the person who made it (he is not told; the others read the change, not a name in the sentence).
    for (const key of ['notifications.following.change', 'notifications.following.changeStep', 'notifications.following.changeSteps', 'notifications.following.orderChange'] as const) {
      expect(MESSAGE_KEYS).toContain(key)
      for (const locale of ['en', 'it'] as const) expect(MESSAGE_TEMPLATES[key][locale]).not.toContain('{actor}')
    }
  })

  it('thread.message_posted names who made the change (or nobody of the office), the order and the count, never on a screen', () => {
    const posted = EVENT_CATALOGUE.get('thread.message_posted', 1)
    const shape = posted.payload.shape
    for (const value of [ORDER, null, undefined]) expect(shape.causedById!.safeParse(value).success).toBe(true)
    expect(shape.causedById!.safeParse('Bea Esempio').success).toBe(false)
    expect(shape.orderId!.safeParse(ORDER).success).toBe(true)
    expect(shape.orderId!.safeParse(undefined).success).toBe(true)
    expect(shape.stillToDo!.safeParse(2).success).toBe(true)
    expect(shape.stillToDo!.safeParse(-1).success).toBe(false)
    expect(shape.stillToDo!.safeParse(1.5).success).toBe(false)
    for (const key of ['causedById', 'orderId', 'stillToDo']) expect(posted.live!.fields).not.toContain(key)
    // An older message (no change keys) still parses.
    expect(posted.payload.safeParse({ threadId: ORDER, messageId: OTHER, recordType: 'SalesOrder', recordId: ORDER, direction: 'INTERNAL_NOTE', audience: 'OFFICE' }).success).toBe(true)
  })
})
// ── end B-SA-051 ──
