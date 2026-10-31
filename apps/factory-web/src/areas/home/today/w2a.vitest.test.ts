import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PERSONAL_TEMPLATES } from '@nexus/factory-domain/insights/personal'
import { ALERT_TEMPLATES } from '@nexus/factory-domain/alerts/rules'
import { RULE_ALERT_WHY } from '@nexus/factory-domain/alerts/today'
import { createApiClient } from '../../../lib/api/client'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { fetchComingUp, fetchToday, setMentionDone, setTaskStatus, snoozeMention, snoozeRow, snoozeTask } from './api'
import { designScreen } from './fixtures'
import { inTile, isCategory, offersVerb, ownVerbHeld, ownVerbKey, snoozesUntilChange, snoozeTarget, tileQuery, W2A_TILES, type TodayItem } from './model'
import { pickedProblem, plusDays, snoozeOptions, wallClock, zonedInstant } from './snooze'
import { phraseText } from './words'
import { todayKeys } from './view/TodayView'
import { queueItem } from './links'

/**
 * Today every day (B-W2a-40, on the API of B-W2a-20 and B-W2a-33): the W2a rows (my tasks due, my mentions, the exception
 * rules' alerts), the tiles Due today · Overdue · Mentions, Snooze, Coming up — and the W1 screen kept as it was (its
 * own tests in today.vitest.test.ts).
 */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
function client(...answers: Array<() => Response>) {
  let index = 0
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => (answers[Math.min(index++, answers.length - 1)] ?? (() => json(500, {})))())
  const api = createApiClient({ baseUrl: '/api', fetch: fetch as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-1' })
  const sent = (call = 0) => {
    const [url, init] = fetch.mock.calls[call]!
    return { url, method: init.method, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined }
  }
  return { api, fetch, sent }
}

const TODAY = {
  asOf: '2026-10-29T09:42:00.000Z',
  today: '2026-10-29',
  counts: { total: 0, now: 0, tiles: [{ tile: 'ALL', count: 0, complete: true }, { tile: 'TASK', count: 0, complete: true }], byKind: [] },
  total: 0,
  items: [],
  nextCursor: null,
  handled: { today: 0 },
  live: { events: ['task.assigned'] },
}

const row = (extra: Partial<TodayItem>): Pick<TodayItem, 'kind' | 'key' | 'record' | 'category' | 'actions' | 'due'> => ({
  kind: 'ORDER_PROMISE',
  key: 'ORDER_PROMISE:o1',
  record: { type: 'SalesOrder', id: 'o1', label: 'SO-1' },
  category: 'ALERT',
  actions: { version: 2, verbs: ['ASSIGN', 'RESOLVE', 'ACKNOWLEDGE'], assigned: null, acknowledged: null },
  due: null,
  ...extra,
})

describe('Today asks for the W2a rows and filters by the W2a tiles', () => {
  it('include=TASKS,MENTIONS,ALERTS; a due tile is `due`, a mention tile a category; W1 calls unchanged', async () => {
    const today = client(() => json(200, TODAY))
    const answer = await fetchToday(today.api, { include: ['TASKS', 'MENTIONS', 'ALERTS'], ...tileQuery('DUE_TODAY') })
    expect(today.sent().url).toBe('/api/home/today?due=TODAY&include=TASKS%2CMENTIONS%2CALERTS&limit=50')
    // The API may count a category the screen has no tile for (TASK): the answer is read, the container leaves it out.
    expect(answer.counts.tiles.map((tile) => tile.tile)).toEqual(['ALL', 'TASK'])
    await fetchToday(today.api, { include: ['TASKS'], ...tileQuery('MENTION') })
    expect(today.sent(1).url).toBe('/api/home/today?category=MENTION&include=TASKS&limit=50')
    await fetchToday(today.api, { ...tileQuery('OVERDUE') })
    expect(today.sent(2).url).toBe('/api/home/today?due=OVERDUE&limit=50')
    expect(tileQuery(null)).toEqual({})
    expect(tileQuery('ALERT')).toEqual({ category: 'ALERT' })
  })

  it('the six tiles in the design’s order, Alerts on my records kept last; ?tile= takes only those', () => {
    expect(W2A_TILES).toEqual(['ALL', 'APPROVAL', 'DUE_TODAY', 'OVERDUE', 'MENTION', 'ALERT'])
    expect(['APPROVAL', 'DUE_TODAY', 'OVERDUE', 'MENTION', 'ALERT'].every(isCategory)).toBe(true)
    expect([null, 'ALL', 'TASK', 'NOPE'].some(isCategory)).toBe(false)
    expect(inTile(row({ due: { date: '2026-10-29', days: 0, word: 'TODAY' } }), 'DUE_TODAY')).toBe(true)
    expect(inTile(row({ due: { date: '2026-10-27', days: -2, word: 'OVERDUE' } }), 'DUE_TODAY')).toBe(false)
    expect(inTile(row({ due: { date: '2026-10-27', days: -2, word: 'OVERDUE' } }), 'OVERDUE')).toBe(true)
    expect(inTile(row({ category: 'MENTION' }), 'MENTION')).toBe(true)
    expect(inTile(row({}), null)).toBe(true)
  })

  it('Coming up is read from its own route', async () => {
    const coming = client(() => json(200, { asOf: TODAY.asOf, today: TODAY.today, calendar: null, kinds: ['TASK'], complete: [{ kind: 'TASK', complete: true }], days: [{ date: '2026-10-30', working: true, items: [] }], live: { events: ['task.changed'] } }))
    expect((await fetchComingUp(coming.api)).days).toHaveLength(1)
    expect(coming.sent().url).toBe('/api/home/coming-up')
  })
})

describe('my own rows: Done (e) and Snooze (h); an alert the reader may snooze: Snooze', () => {
  const task = row({ kind: 'TASK_DUE', key: 'TASK_DUE:t1', category: 'TASK', record: { type: 'Task', id: 't1', label: 'Call' }, actions: { version: 0, verbs: [], assigned: null, acknowledged: null } })
  const mention = row({ kind: 'MENTION', key: 'MENTION:q1:n1', category: 'MENTION', record: { type: 'Quote', id: 'q1', label: 'Q-1' }, actions: { version: 0, verbs: [], assigned: null, acknowledged: null } })
  const ruleAlert = row({ kind: 'RULE_ALERT', key: 'RULE_ALERT:a1', record: { type: 'Alert', id: 'a1', label: 'SO-1' }, actions: { version: 0, verbs: [], assigned: null, acknowledged: null, snoozable: false } })
  const snoozable = row({ actions: { version: 2, verbs: ['ACKNOWLEDGE'], assigned: null, acknowledged: null, snoozable: true } })

  it('which rows take which verb, and why one is held', () => {
    expect([offersVerb(task, 'DONE'), offersVerb(task, 'SNOOZE'), offersVerb(mention, 'DONE'), offersVerb(mention, 'SNOOZE')]).toEqual([true, true, true, true])
    expect([offersVerb(snoozable, 'SNOOZE'), offersVerb(snoozable, 'DONE'), offersVerb(row({}), 'SNOOZE'), offersVerb(ruleAlert, 'SNOOZE')]).toEqual([true, false, false, false])
    expect(ownVerbHeld(task, 'DONE', { live: 'live', busy: false })).toBeNull()
    expect(ownVerbHeld(task, 'DONE', { live: 'offline', busy: false })).toBe('today.actions.held.offline')
    expect(ownVerbHeld(task, 'SNOOZE', { live: 'live', busy: true })).toBe('today.actions.held.busy')
    expect(ownVerbHeld(ruleAlert, 'SNOOZE', { live: 'live', busy: false })).toBe('today.actions.held.review')
    expect(ownVerbKey('e', { alt: false, ctrl: false, meta: false, inField: false })).toBe('DONE')
    expect(ownVerbKey('h', { alt: false, ctrl: false, meta: false, inField: false })).toBe('SNOOZE')
    expect(ownVerbKey('h', { alt: false, ctrl: false, meta: false, inField: true })).toBeNull()
    expect(ownVerbKey('e', { alt: false, ctrl: false, meta: true, inField: false })).toBeNull()
  })

  it('a task through the task (its version read first), a mention through its notification, an alert through its row', async () => {
    expect(snoozeTarget(task)).toEqual({ kind: 'task', taskId: 't1' })
    expect(snoozeTarget(mention)).toEqual({ kind: 'notification', notificationId: 'n1' })
    expect(snoozeTarget(snoozable)).toEqual({ kind: 'row', key: 'ORDER_PROMISE:o1' })
    expect([snoozesUntilChange(task), snoozesUntilChange(mention), snoozesUntilChange(snoozable)]).toEqual([false, true, true])

    const read = () => json(200, { task: { id: 't1', version: 7, status: 'OPEN' } })
    const done = client(read, () => json(200, {}))
    await setTaskStatus(done.api, 't1', 'DONE')
    expect(done.sent(0)).toMatchObject({ url: '/api/tasks/t1', method: 'GET' })
    expect(done.sent(1)).toMatchObject({ url: '/api/tasks/t1/status', method: 'POST', body: { version: 7, status: 'DONE' } })
    expect(done.sent(1).headers.get('x-csrf-token')).toBe('csrf-1')
    expect(done.sent(1).headers.get('idempotency-key')).toBeTruthy()
    const later = client(read, () => json(200, {}))
    await snoozeTask(later.api, 't1', '2026-10-30T07:00:00.000Z')
    expect(later.sent(1)).toMatchObject({ url: '/api/tasks/t1/snooze', body: { version: 7, until: '2026-10-30T07:00:00.000Z' } })

    const note = client(() => json(200, { changed: 1, unknown: [] }))
    await setMentionDone(note.api, 'n1', true)
    expect(note.sent()).toMatchObject({ url: '/api/notifications/done', body: { ids: ['n1'], done: true } })
    await snoozeMention(note.api, 'n1', null)
    expect(note.sent(1)).toMatchObject({ url: '/api/notifications/snooze', body: { ids: ['n1'], until: null } })

    const alert = client(() => json(200, {}))
    await snoozeRow(alert.api, { key: 'LOT_HOLD:l1', condition: 'c'.repeat(32), actions: { version: 3, verbs: [], assigned: null, acknowledged: null } }, null)
    expect(alert.sent()).toMatchObject({ url: '/api/home/today/rows/LOT_HOLD%3Al1/snooze', body: { condition: 'c'.repeat(32), version: 3, until: null } })
  })

  it('the keys icon says e is Done or Acknowledge, and h snoozes (W2a); W1’s list is unchanged', () => {
    const en = createTranslator('en', CATALOGUE.en.home!)
    expect(todayKeys(en, true).map((entry) => entry.keys.join(''))).toEqual(['jk', '↵', 'e', 'h', 'a', 'r'])
    expect(todayKeys(en).map((entry) => entry.keys.join(''))).toEqual(['jk', '↵', 'e', 'a', 'r'])
  })
})

describe('where a W2a row opens', () => {
  it('my task on My tasks; an exception rule’s alert in its popup on Home › Alerts (B-W2a-78)', () => {
    const base: Omit<TodayItem, 'key' | 'kind' | 'state' | 'category' | 'record'> = { severity: 'HIGH', severityWord: '', group: 'NOW', companyId: 'c1', siteId: null, partyId: null, sentence: '', why: '', blocks: null, words: { sentence: { key: 'x', params: {} }, why: { key: 'x', params: {} }, blocks: null }, sentenceFigure: null, due: null, since: '2026-10-29T09:00:00.000Z', ageDays: 0, decide: 'OPEN', figures: null, condition: 'c'.repeat(32), actions: { version: 0, verbs: [], assigned: null, acknowledged: null } }
    const task = queueItem({ ...base, key: 'TASK_DUE:t1', kind: 'TASK_DUE', state: 'TODAY', category: 'TASK', record: { type: 'Task', id: 't1', label: 'Call' } }, '/w/DEMO')
    expect(task.href).toBe('/w/DEMO/home/tasks?open=t1')
    const alert = queueItem({ ...base, key: 'RULE_ALERT:a1', kind: 'RULE_ALERT', state: 'OPEN', category: 'ALERT', record: { type: 'Alert', id: 'a1', label: 'SO-1' } }, '/w/DEMO')
    expect(alert.href).toBe('/w/DEMO/home/alerts?open=a1')
  })
})

describe('Snooze until: the site’s times', () => {
  // Thursday 29 October 2026, 10:42 in Rome (winter time, UTC+1).
  const THURSDAY = Date.UTC(2026, 9, 29, 9, 42)

  it('Later today 16:00 · Tomorrow 08:00 · Monday 08:00 · Pick · Until something changes', () => {
    expect(snoozeOptions(THURSDAY, { untilChange: true })).toEqual([
      { choice: 'LATER_TODAY', until: '2026-10-29T15:00:00.000Z' },
      { choice: 'TOMORROW', until: '2026-10-30T07:00:00.000Z' },
      { choice: 'MONDAY', until: '2026-11-02T07:00:00.000Z' },
      { choice: 'PICK', until: null },
      { choice: 'UNTIL_CHANGE', until: null },
    ])
    // After 16:00 there is no "later today"; a task has no "until something changes".
    expect(snoozeOptions(Date.UTC(2026, 9, 29, 16, 30), { untilChange: false }).map((option) => option.choice)).toEqual(['TOMORROW', 'MONDAY', 'PICK'])
    // On a Sunday tomorrow is Monday: said once. On a Monday, Monday is a week on.
    expect(snoozeOptions(Date.UTC(2026, 10, 1, 8), { untilChange: false }).map((option) => option.choice)).toEqual(['LATER_TODAY', 'TOMORROW', 'PICK'])
    expect(snoozeOptions(Date.UTC(2026, 10, 2, 8), { untilChange: false }).find((option) => option.choice === 'MONDAY')?.until).toBe('2026-11-09T07:00:00.000Z')
  })

  it('summer time and the day boundary are the zone’s, not the browser’s', () => {
    expect(new Date(zonedInstant('2026-07-01', '08:00')).toISOString()).toBe('2026-07-01T06:00:00.000Z')
    expect(new Date(zonedInstant('2026-03-29', '08:00')).toISOString()).toBe('2026-03-29T06:00:00.000Z')
    expect(wallClock(Date.UTC(2026, 9, 29, 23, 30))).toEqual({ day: '2026-10-30', time: '00:30', weekday: 5 })
    expect(plusDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('a picked moment: later than now and within the limit', () => {
    expect(pickedProblem('', THURSDAY, 90)).toBe('today.snooze.pickFirst')
    expect(pickedProblem('2026-10-29T08:00:00.000Z', THURSDAY, 90)).toBe('today.snooze.past')
    expect(pickedProblem('2027-03-01T08:00:00.000Z', THURSDAY, 90)).toBe('today.snooze.tooFar')
    expect(pickedProblem('2026-11-02T07:00:00.000Z', THURSDAY, 90)).toBeNull()
  })
})

describe('the W2a rows in the person’s language', () => {
  const en = createTranslator('en', CATALOGUE.en.home!)
  const it_ = createTranslator('it', CATALOGUE.it.home!)

  it('every phrase of insights/personal and of the exception rules has its words in both languages; the English is the domain’s', () => {
    for (const [key, template] of Object.entries(PERSONAL_TEMPLATES)) {
      expect(CATALOGUE.en.home![`today.w.${key}`], key).toBe(template)
      expect(CATALOGUE.it.home![`today.w.${key}`], key).toBeTruthy()
    }
    for (const [key, words] of Object.entries(ALERT_TEMPLATES)) {
      expect(CATALOGUE.en.home![`today.w.${key}`], key).toBe(words.en)
      expect(CATALOGUE.it.home![`today.w.${key}`], key).toBe(words.it)
    }
    for (const [key, template] of Object.entries(RULE_ALERT_WHY)) {
      expect(CATALOGUE.en.home![`today.w.${key}`], key).toBe(template)
      expect(CATALOGUE.it.home![`today.w.${key}`], key).toBeTruthy()
    }
    expect(CATALOGUE.it.home!['today.w.alerts.UNKNOWN']).toBeTruthy()
  })

  it('a task overdue, a mention and Coming up in Italian (dates the person’s way)', () => {
    const overdue = { key: 'TASK_DUE.OVERDUE', params: { title: 'Chiamare', count: 2, dueDate: '2026-10-27' } }
    expect(phraseText(overdue, it_, 'it')).toBe('La tua attività "Chiamare" è in ritardo di 2 giorni: scadeva il 27/10/2026.')
    expect(phraseText(overdue, en, 'en')).toBe('Your task "Chiamare" is 2 days overdue: it was due on 27/10/2026.')
    expect(phraseText({ key: 'MENTION.NOTE', params: { actor: 'Marco', record: 'Q-1' } }, it_, 'it')).toBe('Marco ti ha menzionato in una nota su Q-1.')
    expect(phraseText({ key: 'COMING.ORDER', params: { number: 'SO-1', customer: 'Club' } }, it_, 'it')).toBe("L'ordine SO-1 per Club è promesso.")
  })

  it('the W2a design cases: Coming up and the six tiles drawn, no English on the Italian page', () => {
    const view = designScreen.view as ComponentType<{ model: unknown }>
    const html = (id: string, locale: 'en' | 'it') => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(view, { model: designScreen.cases.find((entry) => entry.id === id)!.model })))
    const owner = html('w2a-owner', 'it')
    expect(owner).toContain('In arrivo')
    expect(owner).toContain('In scadenza oggi')
    expect(owner).toContain('ti ha menzionato in una nota')
    expect(owner).not.toMatch(/Your task|mentioned you|Coming up/)
    expect(html('w2a-coming-empty', 'en')).toContain('Nothing scheduled for you in the next 5 working days.')
    expect(html('w2a-owner', 'en')).toContain('fw-today-agenda')
  })
})
