import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CODE_WORDS, MESSAGE_TEMPLATES } from '@nexus/factory-domain/notifications/rules'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { designScreen as shellScreen } from '../../../shell/office/fixtures'
import { fetchCounts, fetchNotifications, markDone, markRead, markTabRead, muteProblem, muteRecord, readProblem, saveDigest, snoozeNotifications, wakeNotifications, writeProblem } from './api'
import { designScreen } from './fixtures'
import { bellWords, digestProblem, digestTimes, freshCount, idsOf, openAddress, pageKey, stateOf, tabOf, unreadOf, whenGroup, writeHeld, type Notification } from './model'
import { notificationKeys } from './view/NotificationsView'
import { sentenceWords } from './words'

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

const COUNTS = { unread: 2, complete: true, tabs: [{ tab: 'ALL', unread: 2 }, { tab: 'MENTION', unread: 1 }, { tab: 'ASSIGNMENT', unread: 1 }, { tab: 'APPROVAL', unread: 0 }, { tab: 'SYSTEM', unread: 0 }] }
const base: Notification = {
  id: 'n1',
  category: 'MENTION',
  eventType: 'thread.user_mentioned',
  record: { type: 'SalesOrder', id: 'so1', label: 'SO-1' },
  companyId: 'c1',
  anchor: 'message:m1',
  messageKey: 'notifications.mentioned',
  params: { actorId: 'u1' },
  sentence: 'Ada mentioned you on SO-1',
  actor: { id: 'u1', name: 'Ada' },
  people: { u1: 'Ada' },
  state: 'OPEN',
  read: false,
  readAt: null,
  doneAt: null,
  snoozed: null,
  createdAt: '2026-10-29T09:00:00.000Z',
  group: { key: 'n1', count: 1, ids: ['n1'] },
}
const LIST = { asOf: '2026-10-29T09:42:00.000Z', tab: 'ALL', state: 'OPEN', counts: COUNTS, items: [base], nextCursor: null, live: { events: ['notification.created'] } }

describe('Notifications call the API through its one client (SCR-005)', () => {
  it('reads my list by tab and state, and the bell’s counts', async () => {
    const list = client(() => json(200, LIST))
    const answer = await fetchNotifications(list.api, { tab: 'MENTION', state: 'SNOOZED', cursor: 'c2' })
    expect(list.sent().url).toBe('/api/notifications?tab=MENTION&state=SNOOZED&cursor=c2&limit=50')
    expect(list.sent().headers.get('x-factory-company')).toBe('DEMO')
    expect(answer.items[0]!.id).toBe('n1')
    const bell = client(() => json(200, { asOf: LIST.asOf, ...COUNTS, live: LIST.live }))
    expect((await fetchCounts(bell.api)).unread).toBe(2)
    expect(bell.sent().url).toBe('/api/notifications/counts')
  })

  it('read, done (and back), snooze, wake, mark a tab read and mute: my own rows, with the CSRF token and an idempotency key', async () => {
    const writes = client(() => json(200, { changed: 1, unknown: [] }))
    await markRead(writes.api, ['n1'])
    await markDone(writes.api, ['n1', 'n2'], false)
    await snoozeNotifications(writes.api, ['n1'], null)
    await wakeNotifications(writes.api, ['n1'])
    await markTabRead(writes.api, 'MENTION')
    await muteRecord(writes.api, { type: 'SalesOrder', id: 'so 1' })
    const calls = [0, 1, 2, 3, 4, 5].map((index) => writes.sent(index))
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/notifications/read',
      'POST /api/notifications/done',
      'POST /api/notifications/snooze',
      'POST /api/notifications/wake',
      'POST /api/notifications/read',
      'PUT /api/threads/SalesOrder/so%201/followers/me',
    ])
    expect(calls.map((call) => call.body)).toEqual([{ ids: ['n1'], read: true }, { ids: ['n1', 'n2'], done: false }, { ids: ['n1'], until: null }, { ids: ['n1'] }, { tab: 'MENTION', read: true }, { following: true, muted: true }])
    for (const call of calls) {
      expect(call.headers.get('x-csrf-token')).toBe('csrf-1')
      expect(call.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it('the digest is saved with the version as read; days in order', async () => {
    const digest = { on: true, sendTime: '08:00', weekdays: [1, 3], categories: ['MENTION'], locale: 'it', lastSentAt: null, version: 4 }
    const save = client(() => json(200, { digest }))
    expect((await saveDigest(save.api, { on: true, sendTime: '08:00', weekdays: [3, 1], categories: ['MENTION'] }, 3)).version).toBe(4)
    expect(save.sent().method).toBe('PUT')
    expect(save.sent().body).toEqual({ on: true, sendTime: '08:00', weekdays: [1, 3], categories: ['MENTION'], version: 3 })
  })

  it('problems are this page’s words, never the API’s', () => {
    expect(readProblem(new ApiError('unavailable', 503, 'unavailable', 'x'))).toBe('problem.offline')
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'problem.changed', tone: 'warning', reload: true })
    expect(muteProblem(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('notice.muteNoRecord')
    expect(readProblem(new Error('boom'))).toBe('problem.read')
  })
})

describe('the rules of the screen', () => {
  it('the address: a known tab or All, a known state or To look at', () => {
    expect(tabOf('MENTION')).toBe('MENTION')
    expect(tabOf('NOPE')).toBe('ALL')
    expect(stateOf('DONE')).toBe('DONE')
    expect(stateOf(null)).toBe('OPEN')
  })

  it('Today · Yesterday · Earlier by the site’s calendar day (Rome), not the browser’s', () => {
    const now = Date.UTC(2026, 9, 29, 9, 42)
    expect(whenGroup('2026-10-29T00:30:00.000Z', now)).toBe('TODAY')
    // 23:30 UTC on the 28th is 00:30 on the 29th in Rome.
    expect(whenGroup('2026-10-28T23:30:00.000Z', now)).toBe('TODAY')
    expect(whenGroup('2026-10-28T10:00:00.000Z', now)).toBe('YESTERDAY')
    expect(whenGroup('2026-10-20T10:00:00.000Z', now)).toBe('EARLIER')
  })

  it('a folded group acts on every notification it stands for', () => {
    const rows = [{ id: 'a', group: { key: 'a', count: 3, ids: ['a', 'b', 'c'] } }, { id: 'd', group: { key: 'd', count: 1, ids: ['d'] } }]
    expect(idsOf(rows, ['a', 'd'])).toEqual(['a', 'b', 'c', 'd'])
    expect(idsOf(rows, ['d'])).toEqual(['d'])
    expect(freshCount([{ id: 'a' }], [{ id: 'a' }, { id: 'x' }])).toBe(1)
  })

  it('Enter opens the record at its place: a task, Today’s row, an approval, an alert, else the record', () => {
    const built = OFFICE_PAGES
    expect(openAddress({ ...base, anchor: 'task:t1' }, built)).toBe('/home/tasks?open=t1')
    expect(openAddress({ ...base, anchor: 'today:MENTION:so1:n1' }, built)).toBe(`/home/today?open=${encodeURIComponent('MENTION:so1:n1')}`)
    expect(openAddress({ ...base, anchor: 'approval:r1' }, built)).toBe('/home/approvals?open=r1')
    expect(openAddress({ ...base, anchor: 'alert:a1' }, built)).toMatch(/^\/(home\/alerts\?open=a1|records\/Alert\/a1)/)
    expect(openAddress({ ...base, anchor: 'message:m1' }, built)).toBe('/sales/orders/so1')
    expect(openAddress({ ...base, anchor: null }, built)).toBe('/sales/orders/so1')
  })

  it('the keys: e done, h snooze, m mute, ⇧E mark all read; writes held offline or while one is sent', () => {
    expect(pageKey({ key: 'e', shiftKey: false })).toBe('done')
    expect(pageKey({ key: 'E', shiftKey: true })).toBe('allRead')
    expect(pageKey({ key: 'h', shiftKey: false })).toBe('snooze')
    expect(pageKey({ key: 'm', shiftKey: false })).toBe('mute')
    expect(pageKey({ key: 'x', shiftKey: false })).toBeNull()
    expect(writeHeld({ live: 'offline', busy: false })).toBe('held.offline')
    expect(writeHeld({ live: 'live', busy: true })).toBe('held.busy')
    expect(writeHeld({ live: 'connecting', busy: false })).toBeNull()
    const en = createTranslator('en', CATALOGUE.en['home-notifications']!)
    expect(notificationKeys(en).map((entry) => entry.keys.join('+'))).toEqual(['e', 'h', 'm', '⇧+e'])
  })

  it('the digest: a time, at least one day and one kind', () => {
    expect(digestProblem({ on: true, sendTime: '8:00', weekdays: [1], categories: ['MENTION'] })).toBe('digest.problem.time')
    expect(digestProblem({ on: true, sendTime: '08:00', weekdays: [], categories: ['MENTION'] })).toBe('digest.problem.days')
    expect(digestProblem({ on: true, sendTime: '08:00', weekdays: [1], categories: [] })).toBe('digest.problem.kinds')
    expect(digestProblem({ on: false, sendTime: '08:00', weekdays: [1], categories: ['ALERT'] })).toBeNull()
    expect(digestTimes('07:45')).toContain('07:45')
    expect(digestTimes('08:00').filter((time) => time === '08:00')).toHaveLength(1)
  })

  it('the bell: an unknown count shows no badge, never 0; more than 1000 is said so', () => {
    expect(bellWords({ status: 'loading' })).toEqual({ key: 'topbar.bell.label', count: 0, badge: null })
    expect(bellWords({ status: 'error' })).toEqual({ key: 'topbar.bell.unknown', count: 0, badge: null })
    expect(bellWords({ status: 'ready', unread: 0, complete: true }).badge).toBeNull()
    expect(bellWords({ status: 'ready', unread: 4, complete: true })).toEqual({ key: 'topbar.bell.count', count: 4, badge: 4 })
    expect(bellWords({ status: 'ready', unread: 1000, complete: false }).key).toBe('topbar.bell.countMore')
    expect(unreadOf(null, 'ALL')).toBeNull()
    expect(unreadOf(COUNTS as never, 'MENTION')).toBe(1)
  })
})

describe('a notification in the person’s language (PLT-152)', () => {
  const en = createTranslator('en', CATALOGUE.en['home-notifications']!)
  const it_ = createTranslator('it', CATALOGUE.it['home-notifications']!)

  it('every message key the domain can send has its words in both languages; the English is the domain’s own', () => {
    for (const [key, words] of Object.entries(MESSAGE_TEMPLATES)) {
      expect(CATALOGUE.en['home-notifications']![`w.${key}`], key).toBe(words.en)
      expect(CATALOGUE.it['home-notifications']![`w.${key}`], key).toBeTruthy()
    }
    for (const [code, words] of Object.entries(CODE_WORDS.status)) {
      expect(CATALOGUE.en['home-notifications']![`w.status.${code}`]).toBe(words.en)
      expect(CATALOGUE.it['home-notifications']![`w.status.${code}`]).toBe(words.it)
    }
  })

  it('people by id, a decision in words, an unknown key as "News on"; the system when nobody caused it', () => {
    expect(sentenceWords(base, en, 'en')).toBe('Ada mentioned you on SO-1')
    expect(sentenceWords(base, it_, 'it')).toBe('Ada ti ha menzionato su SO-1')
    const decided = { ...base, messageKey: 'notifications.approval.quote_decided', params: { actorId: 'u1', status: 'REJECTED' } }
    expect(sentenceWords(decided, it_, 'it')).toBe('Ada ha rifiutato la tua richiesta di approvazione del preventivo SO-1')
    expect(sentenceWords({ ...base, messageKey: 'notifications.unknown.kind' }, en, 'en')).toBe('News on SO-1')
    expect(sentenceWords({ ...base, actor: null, params: { title: 'Rule' }, messageKey: 'notifications.alert.raised' }, en, 'en')).toBe('Alert on SO-1: Rule')
    expect(sentenceWords({ ...base, actor: null, params: {}, people: {} }, en, 'en')).toBe('The system mentioned you on SO-1')
  })

  it('an amount only while the params hold it (the API drops it for a reader without the grain), in the reader’s format', () => {
    const asked = { ...base, messageKey: 'notifications.approval.quote_requested', params: { actorId: 'u1', netAmount: { $money: 'price', value: { minor: 624000, currency: 'EUR' } }, marginPct: { $money: 'margin', value: '18.25' } } }
    expect(sentenceWords(asked, en, 'en')).toBe('Ada asks you to approve quote SO-1 (€6,240.00, margin 18.3 %)')
    // Italian: a decimal comma; four digits take no group separator (Intl's own rule for it-IT).
    expect(sentenceWords(asked, it_, 'it')).toMatch(/^Ada ti chiede di approvare il preventivo SO-1 \(6\.?240,00\s€, margine 18,3 %\)$/)
    expect(sentenceWords({ ...asked, params: { actorId: 'u1' } }, en, 'en')).toBe('Ada asks you to approve quote SO-1')
  })
})

describe('every design case draws in both languages with no key left on screen', () => {
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  for (const locale of LOCALES) {
    it(`SCR-005 in ${locale}: ${designScreen.cases.length} cases`, () => {
      for (const item of designScreen.cases) {
        const html = render(designScreen as DesignScreen<unknown>, item.model, locale)
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(/\b(?:band|tab|tabs|tiles|list|col|category|when|stateWord|state|bulk|empty|notice|problem|digest|held|keys|w|refused|live|offline)\.[a-zA-Z0-9]+(?:\.[a-zA-Z0-9_]+)*\b/)?.[0] ?? null, `SCR-005/${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('the design cases: every state, made-up data only', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const wanted of ['normal', 'selected', 'grouped', 'snoozed', 'done', 'preferences', 'snooze', 'offline', 'empty', 'loading', 'error', 'no-permission']) expect(ids).toContain(wanted)
    expect(JSON.stringify(designScreen.cases)).not.toMatch(/@(?!example\.)[a-z0-9-]+\.(com|it|net)/i)
  })

  // The grid draws its rows in the browser only: the rows' words are checked through the function its cells call.
  const rowsOf = (id: string) => {
    const model = designScreen.cases.find((entry) => entry.id === id)!.model
    return model.list.status === 'ready' ? model.list.data.items : []
  }

  it('every row of every case reads as a sentence in both languages (no key, no "News on" for a known kind)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, CATALOGUE[locale]['home-notifications']!)
      for (const item of designScreen.cases) {
        for (const row of rowsOf(item.id)) {
          const text = sentenceWords(row, t, locale)
          expect(text, `${item.id}/${row.messageKey} (${locale})`).not.toMatch(/\bw\.|notifications\.|\{[a-z]+\}/)
          expect(text, `${item.id}/${row.messageKey} (${locale})`).not.toMatch(/^(News on|Novità su) /)
        }
      }
    }
  })

  it('money only as the API sent it: the row without the grain shows no amount', () => {
    const en = createTranslator('en', CATALOGUE.en['home-notifications']!)
    for (const row of rowsOf('no-grain')) expect(sentenceWords(row, en, 'en')).not.toMatch(/€|EUR|margin \d/)
    expect(rowsOf('normal').map((row) => sentenceWords(row, en, 'en'))).toContain('Marta Demo asks you to approve quote Q-2026-0142 (€6,240.00, margin 18.2 %)')
  })

  it('the keys sit in ONE info icon in the list footer, never above the list', () => {
    const html = render(designScreen as DesignScreen<unknown>, designScreen.cases.find((entry) => entry.id === 'normal')!.model, 'en')
    const head = html.slice(0, html.indexOf('nds-grid-card'))
    expect(head).not.toMatch(/<kbd/i)
  })

  it('the bell in the top bar: its count in words, no badge for an unknown count', () => {
    const bell = (id: string) => render(shellScreen as DesignScreen<unknown>, shellScreen.cases.find((entry) => entry.id === id)!.model, 'en')
    expect(bell('bell')).toContain('Notifications: 4 unread')
    expect(bell('bell')).toContain('nds-tbtn-badge')
    expect(bell('bell-unknown')).toContain('the count is not available now')
    expect(bell('bell-unknown')).not.toContain('nds-tbtn-badge')
    expect(bell('bell-none')).not.toContain('nds-tbtn-badge')
    expect(bell('bell-many')).toContain('99+')
    // No bell for a case without one (a person who does not reach Home).
    expect(bell('owner')).not.toContain('Notifications: ')
  })
})
