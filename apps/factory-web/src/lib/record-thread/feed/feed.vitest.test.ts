import { describe, expect, it } from 'vitest'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import type { CardMessage } from '../card/model'
import { demoThread } from '../demo-data'
import { dayOf, dayWord } from '../parts/time'
import { everyCase, leftKeys, renderView, textOf } from '../parts/testing'
import { designScreen } from './fixtures'
import { arrivedAtEnd, feedRows, foldedIds, gistOf, isFieldChange, verbKey, walkTarget, whoWords, type FeedEvent, type FeedRow } from './model'
import { FeedCase } from './view/FeedCase'

/** B-TH-204 — the feed (T4): the order, folding by age (all but the last 3), day lines, grouping, every state. */

const THREAD = demoThread(BRAND_ALPHA)
const kinds = (rows: readonly FeedRow[]) => rows.map((row) => row.kind)
const messageIds = (rows: readonly FeedRow[]) => rows.flatMap((row) => (row.kind === 'message' || row.kind === 'folded' ? [row.message.id] : []))
const msg = (id: string, at: string, more: Partial<CardMessage> = {}): CardMessage => ({ id, kind: 'theirs', channel: 'EMAIL', author: 'A', authorKind: 'PARTY', at, body: `body ${id}`, mentions: [], files: [], ...more })
const change = (id: string, at: string, who = 'Bea Esempio', more: Partial<FeedEvent> = {}): FeedEvent => ({ id, at, who, actorAudience: 'OFFICE', verb: 'update', status: null, values: [{ field: id, before: '1', after: '2' }], fields: [id], ...more })

describe('oldest at the top, newest at the bottom', () => {
  it('orders the messages by time whatever order they came in (the API answers newest first)', () => {
    const rows = feedRows({ messages: [...THREAD].reverse(), events: [] })
    const shown = messageIds(rows)
    const expected = THREAD.map((message) => message.id).filter((id) => shown.includes(id))
    expect(shown).toEqual(expected)
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'message', message: { id: THREAD[THREAD.length - 1].id } })
  })
})

// ---- B-TH-229 (TH-2, on B-TH-027): the reader's own reading ----------------------------------------------------------------
describe('B-TH-229 — New since your last visit, and read messages fold', () => {
  // The demo thread in the feed's order (time, then id).
  const T = [...THREAD].sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? -1 : 1))
  const ids = (rows: readonly FeedRow[]) => rows.flatMap((row) => (row.kind === 'new' ? ['NEW'] : row.kind === 'message' ? [row.message.id] : row.kind === 'folded' ? [`~${row.message.id}`] : row.kind === 'fold' ? [`fold:${row.count}`] : []))

  it('the line sits right above the first new message; the read ones before it fold, except the one they answer', () => {
    const firstNew = T[T.length - 2]
    const rows = feedRows({ messages: T, events: [], firstNewId: firstNew.id, newCount: 2 })
    const order = ids(rows)
    expect(order.slice(-4)).toEqual([T[T.length - 3].id, 'NEW', firstNew.id, T[T.length - 1].id])
    expect(rows.find((row) => row.kind === 'new')).toMatchObject({ count: 2 })
    // Every read message before the one they answer folds (the old run in one line, the two before it one line each).
    expect(foldedIds(T, [], null, firstNew.id, 2)).toHaveLength(T.length - 3)
    expect(rows.filter((row) => row.kind === 'message')).toHaveLength(3)
  })

  it('many new: every new message stays open (never folded by age), however old', () => {
    const firstNew = T[5]
    const rows = feedRows({ messages: T, events: [], firstNewId: firstNew.id, newCount: T.length - 5 })
    const open = rows.flatMap((row) => (row.kind === 'message' ? [row.message.id] : []))
    expect(open).toEqual(T.slice(4).map((message) => message.id))
    expect(ids(rows).indexOf('NEW')).toBe(ids(rows).indexOf(firstNew.id) - 1)
  })

  it('nothing new: no line, and the feed folds by age as before (all but the last 3)', () => {
    const rows = feedRows({ messages: T, events: [], firstNewId: null, newCount: 0 })
    expect(rows.some((row) => row.kind === 'new')).toBe(false)
    expect(foldedIds(T, [], null, null, 0)).toEqual(foldedIds(T))
  })

  it('the first new message is older than the page read: the line tops the page, nothing folds, 200+ is said by the view', () => {
    const rows = feedRows({ messages: T, events: [], firstNewId: 'not-on-this-page', newCount: 240 })
    expect(rows.find((row) => row.kind !== 'day')).toMatchObject({ kind: 'new', count: 240 })
    expect(rows.some((row) => row.kind === 'folded' || row.kind === 'fold')).toBe(false)
  })

  it('a link to a message still opens it among read ones; a message on its way never folds', () => {
    const firstNew = T[T.length - 1]
    expect(foldedIds(T, [], T[3].id, firstNew.id, 1)).not.toContain(T[3].id)
    const sending = [...T.slice(0, 4).map((message, index) => (index === 1 ? { ...message, outbox: { state: 'sending' as const } } : message))]
    expect(foldedIds(sending as CardMessage[], [], null, sending[3].id, 1)).not.toContain(sending[1].id)
  })

  it('every case draws the line in words (it + en), "200+" above 200, and the bar beside it', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = renderView(FeedCase, designScreen.cases.find((entry) => entry.id === 'unread')!.model, locale)
      expect(textOf(html)).toMatch(locale === 'en' ? /New since your last visit · 2 messages/ : /Nuovo dalla tua ultima visita · 2 messaggi/)
      expect(html).toContain('data-feed-new')
      const many = renderView(FeedCase, designScreen.cases.find((entry) => entry.id === 'unread-many')!.model, locale)
      expect(textOf(many)).toMatch(locale === 'en' ? /200\+ messages/ : /oltre 200 messaggi/)
      const bar = renderView(FeedCase, designScreen.cases.find((entry) => entry.id === 'unread-bar')!.model, locale)
      expect(textOf(bar)).toMatch(locale === 'en' ? /8 new messages/ : /8 nuovi messaggi/)
    }
  })
})
// ---- end B-TH-229

describe('older messages fold by age (PR-08: all but the last 3)', () => {
  it('the oldest run is one line, the two before the open ones one line each, the last three open', () => {
    const rows = feedRows({ messages: THREAD, events: [] })
    const fold = rows.find((row) => row.kind === 'fold')
    expect(fold).toMatchObject({ count: 13 })
    expect(rows.filter((row) => row.kind === 'folded')).toHaveLength(2)
    expect(rows.filter((row) => row.kind === 'message').map((row) => (row.kind === 'message' ? row.message.id : ''))).toEqual(THREAD.slice(-3).map((message) => message.id))
    expect(foldedIds(THREAD)).toHaveLength(15)
  })

  it('one message never folds; a few fold one line each, without a fold line for a single one', () => {
    expect(kinds(feedRows({ messages: THREAD.slice(-1), events: [] }))).toEqual(['day', 'message'])
    const four = feedRows({ messages: THREAD.slice(-4), events: [] })
    expect(four.filter((row) => row.kind === 'folded')).toHaveLength(1)
    expect(four.some((row) => row.kind === 'fold')).toBe(false)
    const six = feedRows({ messages: THREAD.slice(-6), events: [] })
    expect(six.filter((row) => row.kind === 'folded')).toHaveLength(3)
    expect(six.some((row) => row.kind === 'fold')).toBe(false)
  })

  it('“12 earlier messages” opened shows each one line; a message opened in place shows whole', () => {
    const opened = feedRows({ messages: THREAD, events: [], runOpen: true })
    expect(opened.some((row) => row.kind === 'fold')).toBe(false)
    expect(opened.filter((row) => row.kind === 'folded')).toHaveLength(15)
    const one = feedRows({ messages: THREAD, events: [], runOpen: true, openIds: [THREAD[0].id] })
    expect(one.find((row) => row.kind === 'message')).toMatchObject({ message: { id: THREAD[0].id } })
  })

  it('a link to a message opens it, and opens the old run around it', () => {
    const rows = feedRows({ messages: THREAD, events: [], anchorId: THREAD[4].id })
    expect(rows.some((row) => row.kind === 'fold')).toBe(false)
    expect(rows.find((row) => row.kind === 'message')).toMatchObject({ message: { id: THREAD[4].id } })
  })

  it('a message on its way or not sent never folds', () => {
    const sending = { ...THREAD[0], outbox: { state: 'sending' as const } }
    expect(foldedIds([sending, ...THREAD.slice(1)])).not.toContain(THREAD[0].id)
  })

  it('a folded line shows the first words', () => {
    expect(gistOf('\n\nHello Alex,\nmore')).toBe('Hello Alex,')
    expect(gistOf('x'.repeat(200))).toHaveLength(140)
  })
})

describe('day lines in the company’s time zone, words in the reader’s language', () => {
  it('a message at 00:30 in Rome is on the Rome day, not the UTC day', () => {
    expect(dayOf('2026-11-16T23:30:00.000Z')).toBe('2026-11-17')
    const rows = feedRows({ messages: [msg('a', '2026-11-16T22:30:00.000Z'), msg('b', '2026-11-16T23:30:00.000Z')], events: [] })
    expect(rows.filter((row) => row.kind === 'day').map((row) => (row.kind === 'day' ? row.day : ''))).toEqual(['2026-11-16', '2026-11-17'])
  })

  it('Today, Yesterday, the weekday and date', () => {
    expect(dayWord('2026-11-17', '2026-11-17', 'en')).toEqual({ kind: 'today' })
    expect(dayWord('2026-11-16', '2026-11-17', 'it')).toEqual({ kind: 'yesterday' })
    expect(dayWord('2026-11-13', '2026-11-17', 'en')).toEqual({ kind: 'date', text: 'Friday 13 Nov' })
    expect(dayWord('2026-11-13', '2026-11-17', 'it')).toEqual({ kind: 'date', text: 'venerdì 13 nov' })
    expect(dayWord('2025-12-01', '2026-11-17', 'en').kind === 'date' && (dayWord('2025-12-01', '2026-11-17', 'en') as { text: string }).text).toContain('2025')
    expect(dayWord('2026-03-01', '2026-03-02', 'en')).toEqual({ kind: 'yesterday' })
  })
})

describe('quiet record steps and grouped changes', () => {
  it('field changes by one person in the same hour are one line; another person or an hour later starts a new one', () => {
    const rows = feedRows({
      messages: [],
      events: [change('a', '2026-11-12T15:40:00Z'), change('b', '2026-11-12T15:45:00Z'), change('c', '2026-11-12T15:50:00Z'), change('d', '2026-11-12T15:55:00Z', 'Carlo Prova'), change('e', '2026-11-12T17:10:00Z', 'Carlo Prova')],
    })
    const groups = rows.filter((row) => row.kind === 'changes')
    expect(groups.map((row) => (row.kind === 'changes' ? row.events.map((event) => event.id) : []))).toEqual([['a', 'b', 'c'], ['d'], ['e']])
  })

  it('a status move or another verb is a record step, never grouped', () => {
    const status = change('s', '2026-11-12T15:41:00Z', 'Bea Esempio', { verb: 'setStatus', status: { from: 'DRAFT', to: 'CONFIRMED' } })
    expect(isFieldChange(status)).toBe(false)
    expect(kinds(feedRows({ messages: [], events: [change('a', '2026-11-12T15:40:00Z'), status, change('b', '2026-11-12T15:42:00Z')] }))).toEqual(['day', 'changes', 'step', 'changes'])
    expect(verbKey('setStatus')).toBe('verb.statusChanged')
    expect(verbKey('somethingNew')).toBe('verb.changed')
  })

  it('who did it: the name, the floor behind the gate, else the audience', () => {
    expect(whoWords({ who: 'Bea', actorAudience: 'OFFICE' })).toEqual({ text: 'Bea' })
    expect(whoWords({ who: 'Ugo', whoHidden: true, actorAudience: 'FLOOR' })).toEqual({ key: 'who.floorPerson' })
    expect(whoWords({ who: null, actorAudience: 'SYSTEM' })).toEqual({ key: 'who.SYSTEM' })
  })

  it('steps inside the folded run fold with it', () => {
    const early = change('early', THREAD[1].at, 'Bea Esempio', { verb: 'create' })
    const rows = feedRows({ messages: THREAD, events: [early] })
    expect(rows.some((row) => row.kind === 'step')).toBe(false)
  })
})

describe('keys and live updates', () => {
  it('J / K walk the messages from the focused one; from outside, J starts at the first and K at the last', () => {
    expect(walkTarget(['a', 'b', 'c'], 'b', 'j')).toBe('c')
    expect(walkTarget(['a', 'b', 'c'], 'b', 'k')).toBe('a')
    expect(walkTarget(['a', 'b', 'c'], 'c', 'j')).toBe('c')
    expect(walkTarget(['a', 'b', 'c'], null, 'k')).toBe('c')
    expect(walkTarget(['a', 'b', 'c'], null, 'j')).toBe('a')
    expect(walkTarget([], null, 'j')).toBeNull()
  })

  it('counts only messages that arrived at the end: an earlier page is not new', () => {
    expect(arrivedAtEnd(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(2)
    expect(arrivedAtEnd(['c', 'd'], ['a', 'b', 'c', 'd'])).toBe(0)
    expect(arrivedAtEnd([], ['a'])).toBe(0)
  })
})

describe('SCR-006-feed: every state in words, both languages', () => {
  const cases = everyCase(designScreen)

  it('draws every case with no message key left on screen', () => {
    for (const [locale, id, html] of cases) expect(leftKeys(html, ['state', 'older', 'day', 'fold', 'folded', 'step', 'changes', 'who', 'verb', 'live', 'feed', 'mark', 'delivery']), `${locale} ${id}`).toEqual([])
  })

  it('the states say what to do next', () => {
    const text = (id: string, locale: 'en' | 'it' = 'en') => textOf(cases.find(([l, c]) => l === locale && c === id)?.[2] ?? '')
    expect(text('empty')).toContain('No messages yet Write the first one below.')
    expect(text('loading')).toContain('Reading the thread…')
    expect(text('error')).toContain('Could not load the thread What you typed in the box below is kept.')
    expect(text('older-failed')).toContain('Could not load earlier messages Retry')
    expect(text('offline')).toContain('Offline · as of 10:44')
    expect(text('forbidden')).toContain('You cannot read this thread')
    expect(text('forbidden')).not.toContain('threads.read')
    expect(text('conversation')).toContain('13 earlier messages')
    expect(text('conversation')).toContain('5 changes by Bea Esempio · Show')
    expect(text('conversation')).toContain('Today')
    expect(text('conversation', 'it')).toContain('13 messaggi precedenti')
    expect(text('conversation')).toContain('Show 50 earlier')
  })

  it('the feed is a named feed of articles', () => {
    const html = renderView(FeedCase, designScreen.cases[0].model)
    expect(html).toContain('role="feed"')
    expect(html).toContain('aria-label="Thread messages, oldest first"')
    expect((html.match(/<article /g) ?? []).length).toBe(3)
  })

  it('the brand wall: Brand Beta’s copy shows nothing of Brand Alpha (B-TH-203)', () => {
    for (const [, id, html] of cases) {
      if (id !== 'brand-beta') continue
      expect(scanText(textOf(html), BRAND_ALPHA)).toEqual([])
      expect(textOf(html)).toContain(BRAND_BETA.portalPerson.name)
    }
  })
})
