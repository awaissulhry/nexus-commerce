import { readFileSync } from 'node:fs' // F-OP-214
import { describe, expect, it } from 'vitest'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import type { CardMessage } from '../card/model'
import { demoThread } from '../demo-data'
import { dayOf, dayWord } from '../parts/time'
import { everyCase, leftKeys, renderView, textOf } from '../parts/testing'
import { designScreen } from './fixtures'
import { arrivedAtEnd, feedRows, isFieldChange, verbKey, walkTarget, whoWords, type FeedEvent, type FeedRow } from './model'
import { FeedCase } from './view/FeedCase'
// B-TH-255
import { HELD_REASONS } from '@nexus/factory-domain/email-in/rules'
import { CATALOGUE } from '../../i18n/messages'
import { HELD_REASON_CODES, hiddenNewLine, waitingMailLine } from './model'
import { FOREIGN_ACTIONS, isStatusStep, stepsWordsOf, stepVerbKey } from './model' // F-OP-214
import { createTranslator, messagesFor } from '../../i18n/messages' // F-OP-214
import { cardOf, eventOf } from '../model' // F-OP-214; tw- W1.1: cardOf's sender key
// tw- W1.1: one order, runs, R5, the tones
import { byTime } from './model'
import { audienceKind, runPlace, sameRun } from './runs'
import { senderKeyOf } from '../card/model'
import { SENDER_TONES, senderTone } from '../parts/tones'

/** B-TH-204 — the feed (T4): the order, day pills, grouping, every state. tw- W1.1: no fold, runs, one sort with the id tie-break. */

const THREAD = demoThread(BRAND_ALPHA)
const kinds = (rows: readonly FeedRow[]) => rows.map((row) => row.kind)
const messageIds = (rows: readonly FeedRow[]) => rows.flatMap((row) => (row.kind === 'message' ? [row.message.id] : []))
const msg = (id: string, at: string, more: Partial<CardMessage> = {}): CardMessage => ({ id, kind: 'theirs', channel: 'EMAIL', author: 'A', authorKind: 'PARTY', at, body: `body ${id}`, mentions: [], files: [], ...more })
const change = (id: string, at: string, who = 'Bea Esempio', more: Partial<FeedEvent> = {}): FeedEvent => ({ id, at, who, actorAudience: 'OFFICE', verb: 'update', status: null, values: [{ field: id, before: '1', after: '2' }], fields: [id], ...more })

describe('oldest at the top, newest at the bottom', () => {
  it('orders the messages by time whatever order they came in (the API answers newest first)', () => {
    const rows = feedRows({ messages: [...THREAD].reverse(), events: [] })
    expect(messageIds(rows)).toEqual([...THREAD].sort(byTime).map((message) => message.id))
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'message', message: { id: [...THREAD].sort(byTime).at(-1)!.id } })
  })

  // ---- tw- W1.1 (B15): ONE order with the id tie-break, for the ids the view walks AND the rows it draws.
  it('two messages at the same instant are ordered by their id, the same way for the rows and for J / K', () => {
    const same = '2026-11-17T09:00:00.000Z'
    const rows = feedRows({ messages: [msg('b', same), msg('a', same), msg('c', '2026-11-17T08:00:00.000Z')], events: [] })
    expect(messageIds(rows)).toEqual(['c', 'a', 'b'])
    expect([msg('b', same), msg('a', same)].sort(byTime).map((message) => message.id)).toEqual(['a', 'b'])
    const view = readFileSync(new URL('./view/Feed.tsx', import.meta.url), 'utf8')
    expect(view).toContain('[...model.messages].sort(byTime)')
    expect(view).not.toMatch(/\.sort\(\(a, b\) => \(a\.at < b\.at/)
  })
})

// ---- B-TH-229 (TH-2, on B-TH-027): the reader's own reading; tw- W1.1 / W1.3: nothing folds — the band "3 unread messages" --------
describe('B-TH-229 / tw- W1.3 — the unread band, and nothing folds', () => {
  const T = [...THREAD].sort(byTime)
  const ids = (rows: readonly FeedRow[]) => rows.flatMap((row) => (row.kind === 'new' ? ['NEW'] : row.kind === 'message' ? [row.message.id] : []))

  it('the band sits right above the first new message; every message is drawn whole (no fold rows any more)', () => {
    const firstNew = T[T.length - 2]
    const rows = feedRows({ messages: T, events: [], firstNewId: firstNew.id, newCount: 2 })
    expect(ids(rows).slice(-4)).toEqual([T[T.length - 3].id, 'NEW', firstNew.id, T[T.length - 1].id])
    expect(rows.find((row) => row.kind === 'new')).toMatchObject({ count: 2 })
    expect(rows.filter((row) => row.kind === 'message')).toHaveLength(T.length)
    expect(kinds(rows).filter((kind) => !['day', 'new', 'message'].includes(kind))).toEqual([])
  })

  it('nothing new: no band', () => {
    expect(feedRows({ messages: T, events: [], firstNewId: null, newCount: 0 }).some((row) => row.kind === 'new')).toBe(false)
  })

  it('the first new message is older than the page read: the band tops the page', () => {
    const rows = feedRows({ messages: T, events: [], firstNewId: 'not-on-this-page', newCount: 240 })
    expect(rows.find((row) => row.kind !== 'day')).toMatchObject({ kind: 'new', count: 240 })
  })

  it('no fold at 500 messages: every one is a message row, oldest first', () => {
    const many = Array.from({ length: 500 }, (_, index) => msg(`m${String(index).padStart(3, '0')}`, new Date(Date.UTC(2026, 10, 17, 8, 0, index)).toISOString()))
    const rows = feedRows({ messages: [...many].reverse(), events: [] })
    expect(rows.filter((row) => row.kind === 'message')).toHaveLength(500)
    expect(messageIds(rows)).toEqual(many.map((message) => message.id))
    expect(readFileSync(new URL('./model.ts', import.meta.url), 'utf8')).not.toMatch(/OPEN_LAST|FOLDED_ROWS|foldedIds|runOpen|openIds/)
  })
})
// ---- end B-TH-229

// ---- tw- W1.1 (10-design §3; D1, D3; R5): sides and runs --------------------------------------------------------------------------
describe('tw- W1.1 — sides and runs: one sender, one audience, one day, nothing between', () => {
  const at = (minute: number, day = 17) => new Date(Date.UTC(2026, 10, day, 8, minute)).toISOString()
  const note = (id: string, who: string, minute: number, more: Partial<CardMessage> = {}): CardMessage => ({ id, kind: 'note', channel: 'APP', author: who, authorKind: 'USER', at: at(minute), body: id, mentions: [], files: [], senderKey: `USER:${who}`, ...more })
  const places = (rows: readonly FeedRow[]) => rows.flatMap((row) => (row.kind === 'message' ? [`${row.message.id}:${row.run.first ? 'F' : '-'}${row.run.last ? 'L' : '-'}${row.run.showName ? 'N' : '-'}${row.run.side === 'mine' ? 'M' : 'O'}`] : []))

  it('three notes of one person in a row are ONE run: the name and the tile once, the last bubble ends it', () => {
    const rows = feedRows({ messages: [note('c1', 'carlo', 40), note('c2', 'carlo', 41), note('c3', 'carlo', 41)], events: [] })
    expect(places(rows)).toEqual(['c1:F-NO', 'c2:---O', 'c3:-L-O'])
  })

  it('the audience changes the run (a note, then an email of the same person); another person starts a run', () => {
    const email: CardMessage = { ...note('b2', 'bea', 55), kind: 'ours', channel: 'EMAIL' }
    expect(places(feedRows({ messages: [note('b1', 'bea', 31), email, note('a1', 'alex', 56)], events: [] }))).toEqual(['b1:FLNO', 'b2:FLNO', 'a1:FLNO'])
    expect(audienceKind({ kind: 'floor' })).toBe('note')
    expect(audienceKind({ kind: 'theirs' })).toBe('shared')
  })

  it('a day pill, a step or the unread band between two of the same person: two runs', () => {
    const late = note('c2', 'carlo', 10, { at: at(10, 18) })
    expect(places(feedRows({ messages: [note('c1', 'carlo', 40), late], events: [] }))).toEqual(['c1:FLNO', 'c2:FLNO'])
    expect(places(feedRows({ messages: [note('c1', 'carlo', 40), note('c2', 'carlo', 42)], events: [change('e', at(41))] }))).toEqual(['c1:FLNO', 'c2:FLNO'])
    expect(places(feedRows({ messages: [note('c1', 'carlo', 40), note('c2', 'carlo', 42)], events: [], firstNewId: 'c2', newCount: 1 }))).toEqual(['c1:FLNO', 'c2:FLNO'])
  })

  it('a bubble that starts with a quote or files stays in its run (no tail) but names its sender again (W-018)', () => {
    const quoting = note('c2', 'carlo', 41, { replyTo: { id: 'x', author: 'Lia Modello', excerpt: 'Hello', at: at(1) } })
    expect(places(feedRows({ messages: [note('c1', 'carlo', 40), quoting], events: [] }))).toEqual(['c1:F-NO', 'c2:-LNO'])
  })

  it('mine: on the right, never a name; my own messages run together too', () => {
    const mine = (id: string, minute: number) => note(id, 'me', minute, { mine: true })
    expect(places(feedRows({ messages: [mine('m1', 1), mine('m2', 2)], events: [] }))).toEqual(['m1:F--M', 'm2:-L-M'])
  })

  it('R5: two hidden floor notes in a row are two runs with the same neutral colour, never keyed on an id', () => {
    const api = (id: string) => cardOf({ id, direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'WORKER', id: 'worker-1', name: null }, authorHidden: true, forFloor: true, body: id, attachments: [], at: at(id === 'w1' ? 1 : 2) }, { emails: new Map(), names: new Map() })
    const [one, two] = [api('w1'), api('w2')]
    expect(one.senderKey).toBeUndefined()
    expect(two.senderKey).toBeUndefined()
    expect(senderKeyOf({ kind: 'WORKER', id: 'worker-1', name: 'Nino Telaio' }, true)).toBeUndefined()
    expect(places(feedRows({ messages: [one, two], events: [] }))).toEqual(['w1:FLNO', 'w2:FLNO'])
    expect(sameRun(one, two)).toBe(false)
    expect(senderTone(one.senderKey)).toBe('slate')
    expect(senderTone(two.senderKey)).toBe('slate')
    // A named worker (the gate open) runs normally, with a person colour.
    const named = (id: string, minute: number) => note(id, 'nino', minute, { kind: 'floor', authorKind: 'WORKER', senderKey: 'WORKER:nino' })
    expect(places(feedRows({ messages: [named('n1', 1), named('n2', 2)], events: [] }))).toEqual(['n1:F-NO', 'n2:-L-O'])
    expect(senderTone('WORKER:nino')).not.toBe('slate')
  })

  it('the sender key: kind + id; a party with no id by its name; the system and a hidden writer none', () => {
    expect(senderKeyOf({ kind: 'USER', id: 'u1', name: 'Bea Esempio' })).toBe('USER:u1')
    expect(senderKeyOf({ kind: 'PARTY', id: null, name: 'Lia Modello' })).toBe('PARTY~Lia Modello')
    expect(senderKeyOf({ kind: 'SYSTEM', id: 's1', name: 'Nexus Factory' })).toBeUndefined()
    expect(senderKeyOf({ kind: 'USER', id: null, name: 'Bea Esempio' })).toBeUndefined()
    expect(cardOf({ id: 'm', direction: 'INBOUND', channel: 'EMAIL', author: { kind: 'PARTY', id: 'p1', name: 'Lia Modello' }, authorHidden: false, forFloor: false, body: 'x', attachments: [], at: at(1) }, { emails: new Map(), names: new Map() }).senderKey).toBe('PARTY:p1')
  })

  // tw- fx2 (walk G-7, Z27): every DS group tone but yellow (the office note's) — eight; slate stays the no-key tone.
  it('one tone per sender: the same key the same tone everywhere; eight person tones, never yellow; slate without a key', () => {
    expect(senderTone('USER:u1')).toBe(senderTone('USER:u1'))
    expect([...SENDER_TONES]).toEqual(['purple', 'emerald', 'pink', 'orange', 'blue', 'cyan', 'violet', 'red'])
    const seen = new Set(Array.from({ length: 200 }, (_, index) => senderTone(`USER:${index}`)))
    expect([...seen].sort()).toEqual([...SENDER_TONES].sort())
    for (const tone of seen) expect(['yellow', 'amber', 'slate']).not.toContain(tone)
    expect(senderTone(null)).toBe('slate')
    expect(senderTone(undefined)).toBe('slate')
  })

  it('on paper every message stands alone, on the left, with its name (R18)', () => {
    const mine = note('m1', 'me', 1, { mine: true })
    expect(runPlace(null, mine, null, { paper: true })).toEqual({ side: 'others', first: true, last: true, showName: true })
    expect(places(feedRows({ messages: [note('c1', 'carlo', 40), note('c2', 'carlo', 41)], events: [], paper: true }))).toEqual(['c1:FLNO', 'c2:FLNO'])
  })
})
// ---- end tw- W1.1

describe('day lines in the company’s time zone, words in the reader’s language', () => {
  it('a message at 00:30 in Rome is on the Rome day, not the UTC day', () => {
    expect(dayOf('2026-11-16T23:30:00.000Z')).toBe('2026-11-17')
    const rows = feedRows({ messages: [msg('a', '2026-11-16T22:30:00.000Z'), msg('b', '2026-11-16T23:30:00.000Z')], events: [] })
    expect(rows.filter((row) => row.kind === 'day').map((row) => (row.kind === 'day' ? row.day : ''))).toEqual(['2026-11-16', '2026-11-17'])
  })

  // tw- W1.1 (10-design §7): the weekday only inside 7 days, then the date; no time-zone tooltip per day (S12).
  it('Today, Yesterday, the weekday inside 7 days, then the date (a past year adds it)', () => {
    expect(dayWord('2026-11-17', '2026-11-17', 'en')).toEqual({ kind: 'today' })
    expect(dayWord('2026-11-16', '2026-11-17', 'it')).toEqual({ kind: 'yesterday' })
    expect(dayWord('2026-11-13', '2026-11-17', 'en')).toEqual({ kind: 'date', text: 'Friday' })
    expect(dayWord('2026-11-13', '2026-11-17', 'it')).toEqual({ kind: 'date', text: 'venerdì' })
    expect(dayWord('2026-11-11', '2026-11-17', 'en')).toEqual({ kind: 'date', text: 'Wednesday' })
    expect(dayWord('2026-11-10', '2026-11-17', 'en')).toEqual({ kind: 'date', text: '10 November' })
    expect(dayWord('2026-11-03', '2026-11-17', 'it')).toEqual({ kind: 'date', text: '3 novembre' })
    expect(dayWord('2025-10-20', '2026-11-17', 'en')).toEqual({ kind: 'date', text: '20 October 2025' })
    expect(dayWord('2025-10-20', '2026-11-17', 'it')).toEqual({ kind: 'date', text: '20 ottobre 2025' })
    expect(dayWord('2026-03-01', '2026-03-02', 'en')).toEqual({ kind: 'yesterday' })
    expect(readFileSync(new URL('./view/Feed.tsx', import.meta.url), 'utf8')).not.toContain("t('day.zone')")
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

  // tw- W1.1: nothing folds, so a step among old messages is drawn where it happened (a pill), never swallowed.
  it('a step among old messages is a row of its own, in time order', () => {
    const early = change('early', THREAD[1].at, 'Bea Esempio', { verb: 'create' })
    const rows = feedRows({ messages: THREAD, events: [early] })
    expect(rows.some((row) => row.kind === 'step' && row.event.id === 'early')).toBe(true)
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
    for (const [locale, id, html] of cases) expect(leftKeys(html, ['state', 'older', 'day', 'fold', 'folded', 'step', 'changes', 'who', 'verb', 'live', 'feed', 'mark', 'delivery', 'down', 'pinned', 'unread', 'foot', 'quote', 'org']), `${locale} ${id}`).toEqual([])
  })

  it('the states say what to do next', () => {
    const text = (id: string, locale: 'en' | 'it' = 'en') => textOf(cases.find(([l, c]) => l === locale && c === id)?.[2] ?? '')
    // tw- fx2 (G-15): ONE line.
    expect(text('empty')).toContain('No messages yet')
    expect(text('empty')).not.toContain('Write the first one below.')
    expect(text('loading')).toContain('Reading the thread…')
    expect(text('error')).toContain('Could not load the thread What you typed in the box below is kept.')
    expect(text('older-failed')).toContain('Could not load earlier messages Retry')
    expect(text('offline')).toContain('Offline · as of 10:44')
    expect(text('forbidden')).toContain('You cannot read this thread')
    expect(text('forbidden')).not.toContain('threads.read')
    expect(text('conversation')).toContain('5 changes by Bea Esempio · Show')
    expect(text('conversation')).toContain('Today')
    // tw- W1.3: no fold and no "Show 50 earlier" — older pages come as the person scrolls up; a pill only while one is read.
    expect(text('conversation')).not.toMatch(/earlier messages|Show 50 earlier/)
    expect(text('conversation', 'it')).not.toMatch(/messaggi precedenti|Mostra i 50 precedenti/)
    expect(text('older-loading')).toContain('Reading earlier messages…')
    expect(text('older-loading', 'it')).toContain('Lettura dei messaggi precedenti…')
  })

  // tw- W1.3: every message is an article (no fold any more: the count is the case's messages).
  it('the feed is a named feed of articles', () => {
    const html = renderView(FeedCase, designScreen.cases[0].model)
    expect(html).toContain('role="feed"')
    expect(html).toContain('aria-label="Thread messages, oldest first"')
    expect((html.match(/<article /g) ?? []).length).toBe(designScreen.cases[0].model.messages.length)
  })

  it('the brand wall: Brand Beta’s copy shows nothing of Brand Alpha (B-TH-203)', () => {
    for (const [, id, html] of cases) {
      if (id !== 'brand-beta') continue
      expect(scanText(textOf(html), BRAND_ALPHA)).toEqual([])
      expect(textOf(html)).toContain(BRAND_BETA.portalPerson.name)
    }
  })
})

// ---- B-TH-255 (B-TH-079; T1-F05, T4-F10): the quiet lines at the end — what the View hides, the mail that waits for a person ------
describe('B-TH-255 — the held-mail line by right, the hidden-new line, folded erased and files-only messages', () => {
  const REVIEW = '/w/demo/home/mail-to-sort'
  const base = designScreen.cases[0]!.model
  const html = (model: typeof base, locale: 'en' | 'it' = 'en') => renderView(FeedCase, model, locale)

  it('the codes are factory-domain’s (HELD_REASONS + TRIAGE); every reason and line has words in it and en', () => {
    expect([...HELD_REASON_CODES].sort()).toEqual([...HELD_REASONS, 'TRIAGE'].sort())
    for (const locale of ['en', 'it'] as const) {
      const words = CATALOGUE[locale]['record-thread-feed'] ?? {}
      for (const code of [...HELD_REASON_CODES, 'other']) expect(words[`waiting.reason.${code}`], `${locale} ${code}`).toBeTruthy()
      for (const key of ['waiting.review_one', 'waiting.reviewWhy_other', 'waiting.reviewMany', 'waiting.colleague_one', 'waiting.colleague_other', 'waiting.colleagueMany', 'waiting.open', 'hidden.line_one', 'hidden.showAll']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })

  it('with email.triage: how many, why (each reason once, in words) and Review → Home › Mail to sort', () => {
    expect(waitingMailLine(null)).toBeNull()
    expect(waitingMailLine({ count: 0, reasons: [], mayReview: true, reviewHref: REVIEW })).toBeNull()
    expect(waitingMailLine({ count: 2, reasons: ['UNKNOWN_SENDER', 'THREAD_CLOSED', 'UNKNOWN_SENDER', 'NEW_CODE'], mayReview: true, reviewHref: REVIEW })).toEqual({
      key: 'waiting.review',
      count: 2,
      reasons: ['waiting.reason.UNKNOWN_SENDER', 'waiting.reason.THREAD_CLOSED', 'waiting.reason.other'],
      href: REVIEW,
    })
    expect(waitingMailLine({ count: 50, reasons: ['SPAM'], mayReview: true, reviewHref: REVIEW })?.key).toBe('waiting.reviewMany')
    const text = textOf(html({ ...base, waitingMail: { count: 1, reasons: ['UNKNOWN_SENDER'], mayReview: true, reviewHref: REVIEW } }))
    expect(text).toContain('1 email waits in Mail to sort — sender not a contact · Review') // tw- W2.4 (§13): one word set
    expect(html({ ...base, waitingMail: { count: 1, reasons: ['UNKNOWN_SENDER'], mayReview: true, reviewHref: REVIEW } })).toContain(`href="${REVIEW}"`)
    expect(textOf(html({ ...base, waitingMail: { count: 2, reasons: ['UNKNOWN_SENDER', 'THREAD_CLOSED'], mayReview: true, reviewHref: REVIEW } }, 'it'))).toContain('2 email attendono in Posta da smistare — mittente non tra i contatti, questo thread è chiuso · Controlla')
  })

  it('without email.triage: "A reply waits for a colleague to check it" — never why, never a sender, never a link (W07, W08, W22, W34)', () => {
    const line = waitingMailLine({ count: 1, reasons: ['UNKNOWN_SENDER', 'DMARC_FAIL'], mayReview: false, reviewHref: REVIEW })
    expect(line).toEqual({ key: 'waiting.colleague', count: 1, reasons: [], href: null })
    const rendered = html({ ...base, waitingMail: { count: 1, reasons: ['UNKNOWN_SENDER', 'DMARC_FAIL'], mayReview: false, reviewHref: REVIEW } })
    const text = textOf(rendered)
    expect(text).toContain('A reply waits for a colleague to check it')
    for (const reason of ['sender not a contact', 'failed its check', 'Mail to sort', 'Review']) expect(text).not.toContain(reason)
    expect(rendered).not.toContain('mail-to-sort')
    // The design feed's own messages carry @mentions and addresses: the line alone (an empty feed) adds no sender.
    const alone = textOf(html({ ...base, messages: [], events: [], more: false, waitingMail: { count: 1, reasons: ['UNKNOWN_SENDER', 'DMARC_FAIL'], mayReview: false, reviewHref: REVIEW } }))
    expect(alone).toContain('A reply waits for a colleague to check it')
    expect(alone).not.toMatch(/@/)
    expect(textOf(html({ ...base, waitingMail: { count: 3, reasons: ['SPAM'], mayReview: false, reviewHref: null } }))).toContain('3 replies wait for a colleague to check them')
  })

  it('a view that hides news says so at the end: "1 new message hidden by this view · Show all"; nothing on All', () => {
    expect(hiddenNewLine(0)).toBeNull()
    expect(hiddenNewLine(undefined)).toBeNull()
    expect(hiddenNewLine(3)).toEqual({ count: 3 })
    const shown = renderView(FeedCase, { ...base, hiddenNew: 1 })
    expect(textOf(shown)).toContain('1 new message hidden by this view · Show all')
    expect(textOf(renderView(FeedCase, { ...base, hiddenNew: 2 }, 'it'))).toContain('2 nuovi messaggi nascosti da questa vista')
    expect(textOf(renderView(FeedCase, base))).not.toContain('hidden by this view')
    // Even a view that hides every message (an empty feed) still says what it hides.
    expect(textOf(renderView(FeedCase, { ...base, messages: [], events: [], more: false, hiddenNew: 4 }))).toContain('4 new messages hidden by this view')
  })

  // tw- W1.3: nothing folds — an erased message and one of files only are drawn whole, each in its own words.
  it('an erased message says so in the feed; a message of files only shows its files — never an empty bubble that looks erased', () => {
    const depth = designScreen.cases.find((item) => item.id === 'erased-files')!
    const html = renderView(FeedCase, depth.model)
    const text = textOf(html)
    expect(text).toContain('Message removed after a privacy request')
    expect(text).toContain('collar.jpg')
    expect(html).toContain('aria-label="Open sizes.pdf"')
  })

  it('the B-TH-255 cases draw with no key left; Brand Beta never shows in Brand Alpha’s lines', () => {
    for (const [locale, id, rendered] of everyCase(designScreen)) {
      expect(leftKeys(rendered, ['waiting', 'hidden', 'erased', 'filesOnly']), `${locale} ${id}`).toEqual([])
      if (id.startsWith('waiting') || id === 'hidden-new' || id === 'erased-files' || id === 'runs') expect(scanText(textOf(rendered), BRAND_BETA), `${locale} ${id}`).toEqual([])
    }
    expect(designScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['waiting-review', 'waiting-two', 'waiting-colleague', 'hidden-new', 'erased-files']))
  })
})
// ---- end B-TH-255

// ---- F-OP-214 (order page plan N4; 11-dock §6.1, D1): other modules' steps in their own words; a run of steps folds into one line --------
describe('F-OP-214 — feed quality: "Nexus Factory added a task", "5 steps by Nexus Factory · Show", a status step never folds', () => {
  const SYSTEM = { who: null, actorAudience: 'SYSTEM' as const }
  const step = (id: string, at: string, more: Partial<FeedEvent> = {}): FeedEvent => ({ id, at, ...SYSTEM, verb: 'create', action: 'tasks.create', status: null, values: [], fields: [], ...more })
  const steps = (rows: readonly FeedRow[]) => rows.flatMap((row) => (row.kind === 'steps' ? [row.events.map((event) => event.id)] : row.kind === 'step' ? [[`1:${row.event.id}`]] : []))

  it('another module\'s step reads in its own words; "created the record" only for the record\'s own module', () => {
    expect(FOREIGN_ACTIONS['tasks.create']).toBe('addedTask')
    expect(stepVerbKey({ verb: 'create', action: 'tasks.create' })).toBe('verb.addedTask')
    expect(stepVerbKey({ verb: 'complete', action: 'tasks.complete' })).toBe('verb.completedTask')
    expect(stepVerbKey({ verb: 'reopen', action: 'tasks.reopen' })).toBe('verb.reopenedTask')
    expect(stepVerbKey({ verb: 'assign', action: 'tasks.assign' })).toBe('verb.assignedTask')
    expect(stepVerbKey({ verb: 'completeUpload', action: 'files.completeUpload' })).toBe('verb.uploaded')
    expect(stepVerbKey({ verb: 'create', action: 'sales.orders.create' })).toBe('verb.created')
    // Another module's create without its own words: never "created the record".
    expect(stepVerbKey({ verb: 'create', action: 'tasks.somethingNew' })).toBe('verb.changed')
    expect(stepVerbKey({ verb: 'create' })).toBe('verb.created')
    // The history entry keeps its whole action.
    const entry = { id: 'h1', at: '2026-11-12T09:00:00.000Z', action: 'tasks.create', actor: { id: null, audience: 'SYSTEM' }, actorHidden: false, status: null, before: null, after: { taskId: 't1' }, fields: [] }
    expect(eventOf(entry as never, new Map())).toMatchObject({ verb: 'create', action: 'tasks.create' })
  })

  it('2+ consecutive steps of the same actor within an hour fold; another actor, more than an hour later or another day splits the run', () => {
    const rows = feedRows({
      messages: [],
      events: [
        step('a', '2026-11-12T09:00:00Z'),
        step('b', '2026-11-12T09:10:00Z'),
        step('c', '2026-11-12T09:20:00Z'),
        step('d', '2026-11-12T09:25:00Z', { who: 'Bea Esempio', actorAudience: 'OFFICE' }),
        step('e', '2026-11-12T10:30:00Z'),
        step('f', '2026-11-12T10:40:00Z'),
        step('g', '2026-11-13T10:41:00Z'),
      ],
    })
    expect(steps(rows)).toEqual([['a', 'b', 'c'], ['1:d'], ['e', 'f'], ['1:g']])
  })

  it('a status step never folds and ends the run; a field change keeps its own group (unchanged)', () => {
    const status = step('s', '2026-11-12T09:05:00Z', { verb: 'setStatus', action: 'sales.orders.setStatus', status: { from: 'DRAFT', to: 'CONFIRMED' } })
    expect(isStatusStep(status)).toBe(true)
    expect(isStatusStep(step('x', '2026-11-12T09:00:00Z'))).toBe(false)
    const rows = feedRows({ messages: [], events: [step('a', '2026-11-12T09:00:00Z'), status, step('b', '2026-11-12T09:06:00Z'), step('c', '2026-11-12T09:07:00Z'), change('u', '2026-11-12T09:08:00Z')] })
    expect(kinds(rows)).toEqual(['day', 'step', 'step', 'steps', 'changes'])
    expect(steps(rows)).toEqual([['1:a'], ['1:s'], ['b', 'c']])
    // A message between two steps splits them too (only consecutive steps fold).
    const split = feedRows({ messages: [msg('m', '2026-11-12T09:01:00Z')], events: [step('a', '2026-11-12T09:00:00Z'), step('b', '2026-11-12T09:02:00Z')] })
    expect(kinds(split)).toEqual(['day', 'step', 'message', 'step'])
  })

  it('the run\'s words: "Nexus Factory added 5 tasks" when all are the same, else "5 steps by Nexus Factory"; the floor gate kept', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id, index) => step(id, `2026-11-12T09:0${index}:00Z`))
    expect(stepsWordsOf(five)).toEqual({ key: 'steps.many.addedTask', count: 5 })
    expect(stepsWordsOf([five[0]!, step('z', '2026-11-12T09:09:00Z', { verb: 'issue', action: 'sales.orders.issue' })])).toEqual({ key: 'steps.text', count: 2 })
    for (const locale of ['en', 'it'] as const) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-feed'])['record-thread-feed']!)
      expect(t('steps.many.addedTask', { count: 5, who: 'Nexus Factory' })).toBe(locale === 'en' ? 'Nexus Factory added 5 tasks' : 'Nexus Factory ha aggiunto 5 attività')
      expect(t('steps.text', { count: 5, who: 'Nexus Factory' })).toBe(locale === 'en' ? '5 steps by Nexus Factory' : '5 passaggi di Nexus Factory')
      expect(t('verb.addedTask'), locale).toBe(locale === 'en' ? 'added a task' : "ha aggiunto un'attività")
      for (const verb of ['completedTask', 'reopenedTask', 'assignedTask']) expect(t(`verb.${verb}`), `${locale} ${verb}`).not.toBe(`verb.${verb}`)
    }
    // A floor person behind the gate folds with the same gate only, and the line says "A person on the floor", never a name.
    const floor = (id: string, at: string) => step(id, at, { who: 'Ugo Operaio', whoHidden: true, actorAudience: 'FLOOR' })
    const rows = feedRows({ messages: [], events: [floor('f1', '2026-11-12T09:00:00Z'), floor('f2', '2026-11-12T09:01:00Z')] })
    const run = rows.find((row) => row.kind === 'steps')
    expect(run && run.kind === 'steps' ? whoWords(run.events[0]!) : null).toEqual({ key: 'who.floorPerson' })
  })

  it('the view draws the run with Show (aria-expanded) and lists each step in place; a lone step reads its own words', () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    const feed = source('./view/Feed.tsx')
    expect(feed).toContain("if (row.kind === 'steps') {")
    expect(feed).toContain('{t(words.key, { count: words.count, who: \'text\' in who ? who.text : t(who.key) })}')
    expect(feed).toContain('verb: t(stepVerbKey(event)) /* F-OP-214 */')
    expect(feed).toContain('<ul id={listId} className="fw-rt-changes" hidden={!showChanges}>')
  })
})
// ---- end F-OP-214

// ---- F-MS-107 (set the stage by hand; R6, R20): the order's History says it — the set (or a change), the clear and the keeper's end,
// each in its own words; never a status step; a run of them folds with its plural words; the floor gate stays the backstop.
describe('F-MS-107 — the History says a stage set by hand, cleared, or ended by the floor', () => {
  const OFFICE = { who: 'Bea Esempio', actorAudience: 'OFFICE' as const }
  const act = (id: string, at: string, action: string, more: Partial<FeedEvent> = {}): FeedEvent => ({ id, at, ...OFFICE, verb: action.slice(action.lastIndexOf('.') + 1), action, status: null, values: [], fields: [], ...more })
  const words = (locale: 'en' | 'it') => createTranslator(locale, messagesFor(locale, ['record-thread-feed'])['record-thread-feed']!)

  it('each act reads in its own words (the API\'s action names, as B-MS-004 / B-MS-005 write them)', () => {
    expect(FOREIGN_ACTIONS['production.setBrandStage']).toBe('setStageByHand')
    expect(FOREIGN_ACTIONS['production.clearBrandStage']).toBe('clearedStageByHand')
    expect(FOREIGN_ACTIONS['production.brandKeeper.handCleared']).toBe('stageByHandEnded')
    expect(stepVerbKey({ verb: 'setBrandStage', action: 'production.setBrandStage' })).toBe('verb.setStageByHand')
    expect(stepVerbKey({ verb: 'clearBrandStage', action: 'production.clearBrandStage' })).toBe('verb.clearedStageByHand')
    expect(stepVerbKey({ verb: 'handCleared', action: 'production.brandKeeper.handCleared' })).toBe('verb.stageByHandEnded')
    const en = words('en')
    const it_ = words('it')
    expect(en('step.text', { who: 'Bea Esempio', verb: en('verb.setStageByHand') })).toBe('Bea Esempio set the stage by hand')
    expect(it_('step.text', { who: 'Bea Esempio', verb: it_('verb.setStageByHand') })).toBe('Bea Esempio ha impostato la fase a mano')
    expect(en('step.text', { who: 'Bea Esempio', verb: en('verb.clearedStageByHand') })).toBe('Bea Esempio cleared the stage set by hand')
    expect(it_('step.text', { who: 'Bea Esempio', verb: it_('verb.clearedStageByHand') })).toBe('Bea Esempio ha tolto la fase impostata a mano')
    // The keeper's end (the floor reached it, the order left production, no line left): Nexus Factory, true in every case.
    expect(en('step.text', { who: en('who.SYSTEM'), verb: en('verb.stageByHandEnded') })).toBe("Nexus Factory ended the stage set by hand: the floor's own stage shows again")
    expect(it_('step.text', { who: it_('who.SYSTEM'), verb: it_('verb.stageByHandEnded') })).toBe('Nexus Factory ha chiuso la fase impostata a mano: si vede di nuovo la fase del reparto')
  })

  it('no status step is made of them: the audit rows carry no `status` key, so they never stand alone as a status move', () => {
    const entry = { id: 'h1', at: '2026-11-20T09:00:00.000Z', action: 'production.setBrandStage', actor: { id: 'u1', audience: 'OFFICE' }, actorHidden: false, status: null, before: null, after: { from: 'PREPARING', to: 'SEWING', floor: 'PREPARING', reasonCode: 'OUTAGE', note: 'Made-up: the scanners of hall two are down' }, fields: [] }
    const event = eventOf(entry as never, new Map([['u1', 'Bea Esempio']]))
    expect(event).toMatchObject({ verb: 'setBrandStage', action: 'production.setBrandStage', status: null, who: 'Bea Esempio' })
    expect(isStatusStep(event)).toBe(false)
    expect(isFieldChange(event)).toBe(false)
    // Without audit.read the API sends no before / after: no value and no note reach the feed.
    expect(eventOf({ ...entry, after: null } as never, new Map()).values).toEqual([])
    const rows = feedRows({ messages: [], events: [act('s', '2026-11-20T09:00:00Z', 'production.setBrandStage'), change('u', '2026-11-20T09:01:00Z')] })
    expect(kinds(rows)).toEqual(['day', 'step', 'changes'])
  })

  it('a run of two folds with the plural words; a set then a clear folds as "2 steps by …"; another actor splits', () => {
    const two = [act('a', '2026-11-20T09:00:00Z', 'production.setBrandStage'), act('b', '2026-11-20T09:20:00Z', 'production.setBrandStage')]
    const rows = feedRows({ messages: [], events: two })
    expect(kinds(rows)).toEqual(['day', 'steps'])
    expect(stepsWordsOf(two)).toEqual({ key: 'steps.many.setStageByHand', count: 2 })
    expect(words('en')('steps.many.setStageByHand', { count: 2, who: 'Bea Esempio' })).toBe('Bea Esempio set the stage by hand 2 times')
    expect(words('it')('steps.many.setStageByHand', { count: 2, who: 'Bea Esempio' })).toBe('Bea Esempio ha impostato la fase a mano 2 volte')
    const ended = [act('k1', '2026-11-20T09:00:00Z', 'production.brandKeeper.handCleared', { who: null, actorAudience: 'SYSTEM' }), act('k2', '2026-11-20T09:05:00Z', 'production.brandKeeper.handCleared', { who: null, actorAudience: 'SYSTEM' })]
    expect(stepsWordsOf(ended)).toEqual({ key: 'steps.many.stageByHandEnded', count: 2 })
    expect(words('en')('steps.many.stageByHandEnded', { count: 2, who: 'Nexus Factory' })).toBe('Nexus Factory ended the stage set by hand 2 times')
    const mixed = [act('a', '2026-11-20T09:00:00Z', 'production.setBrandStage'), act('c', '2026-11-20T09:10:00Z', 'production.clearBrandStage')]
    expect(stepsWordsOf(mixed)).toEqual({ key: 'steps.text', count: 2 })
    const split = feedRows({ messages: [], events: [act('a', '2026-11-20T09:00:00Z', 'production.setBrandStage'), act('k', '2026-11-20T09:10:00Z', 'production.brandKeeper.handCleared', { who: null, actorAudience: 'SYSTEM' })] })
    expect(kinds(split)).toEqual(['day', 'step', 'step'])
  })

  it('the floor gate stays the backstop (R20): a floor worker behind it is "A person on the floor", never a name', () => {
    expect(whoWords(act('f', '2026-11-20T09:00:00Z', 'production.setBrandStage', { who: 'Ugo Operaio', whoHidden: true, actorAudience: 'FLOOR' }))).toEqual({ key: 'who.floorPerson' })
    expect(whoWords(act('o', '2026-11-20T09:00:00Z', 'production.setBrandStage'))).toEqual({ text: 'Bea Esempio' })
  })

  it('every word in both languages, the plurals in pairs', () => {
    for (const locale of ['en', 'it'] as const) {
      const t = words(locale)
      for (const verb of ['setStageByHand', 'clearedStageByHand', 'stageByHandEnded']) {
        expect(t(`verb.${verb}`), `${locale} ${verb}`).not.toBe(`verb.${verb}`)
        expect(t(`steps.many.${verb}`, { count: 1, who: 'W' }), `${locale} ${verb} one`).toMatch(/^W .* 1 \S+$/)
        expect(t(`steps.many.${verb}`, { count: 3, who: 'W' }), `${locale} ${verb} other`).toMatch(/^W .* 3 \S+$/)
        expect(Object.keys(CATALOGUE[locale]['record-thread-feed'] ?? {}).filter((key) => key.startsWith(`steps.many.${verb}_`)).sort(), `${locale} ${verb}`).toEqual([`steps.many.${verb}_one`, `steps.many.${verb}_other`])
      }
    }
  })
})
// ---- end F-MS-107

// ---- tw- W1.3 (10-design §6, §7; D10, P12, P20; R13): no fold, the top sentinel, pills, the unread band, the down button, the flash -----
import { FLASH_MS, shouldLoadOlder } from './model'

describe('tw- W1.3 — the feed: older pages on scroll, pills, one unread count, the flash', () => {
  const view = readFileSync(new URL('./view/Feed.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('./feed.css', import.meta.url), 'utf8')
  const caseOf = (id: string) => designScreen.cases.find((item) => item.id === id)!.model

  it('the top sentinel asks for the next older page once per page — never while one is read, after a failure (Retry) or with none left', () => {
    expect(shouldLoadOlder({ more: true, older: 'idle', count: 50, askedAt: null })).toBe(true)
    expect(shouldLoadOlder({ more: true, older: 'idle', count: 50, askedAt: 50 })).toBe(false)
    expect(shouldLoadOlder({ more: true, older: 'idle', count: 100, askedAt: 50 })).toBe(true)
    expect(shouldLoadOlder({ more: true, older: 'loading', count: 100, askedAt: 50 })).toBe(false)
    expect(shouldLoadOlder({ more: true, older: 'failed', count: 100, askedAt: 50 })).toBe(false)
    expect(shouldLoadOlder({ more: false, older: 'idle', count: 100, askedAt: null })).toBe(false)
    expect(view).toContain('new IntersectionObserver(')
    expect(view).toContain('if (!shouldLoadOlder({ more, older, count: ids.length, askedAt: askedAt.current })) return')
    expect(view).toContain('askedAt.current = ids.length')
    expect(view).not.toContain("t('older.show'")
  })

  it('every row that is not a message is a centred pill; the day pill has no time-zone tooltip; a pin pill says who pinned', () => {
    const html = renderView(FeedCase, caseOf('conversation'))
    expect(html).toContain('class="fw-rt-pillrow is-day"')
    expect(html).not.toContain('title="Days and times')
    expect(html).toMatch(/class="fw-rt-pill fw-rt-event[^"]*" data-event-ids=/)
    const rows = feedRows({ messages: [], events: [], pins: [{ messageId: 'm1', at: '2026-11-17T08:11:00.000Z', by: 'Alex Demo' }] })
    expect(kinds(rows)).toEqual(['day', 'pin'])
    expect(textOf(renderView(FeedCase, caseOf('runs')))).toContain('Alex Demo pinned a message')
    expect(textOf(renderView(FeedCase, caseOf('runs'), 'it'))).toContain('Alex Demo ha fissato un messaggio')
  })

  it('the runs case: one tile and one name for Carlo’s three notes, mine with neither, two hidden floor writers two runs', () => {
    const html = renderView(FeedCase, caseOf('runs'))
    expect(textOf(html).match(/Carlo Prova/g)?.length).toBe(2) // once on his run (+ once in Bea's @mention)
    expect(html.match(/fw-rt-av is-run is-hidden/g)?.length).toBe(2)
    expect(html).toContain('data-message-id="run-6"')
    expect(html).toMatch(/class="fw-rt-msg is-ours is-mine is-start" id="message-run-6"/)
    expect(html).toContain('class="fw-rt-quote fw-rt-tone-')
  })

  it('ONE unread count (P12): the band "3 unread messages" (200+ said), the round down button with the reader’s own newCount (R13)', () => {
    for (const locale of ['en', 'it'] as const) {
      const band = renderView(FeedCase, caseOf('unread'), locale)
      expect(textOf(band)).toContain(locale === 'en' ? '2 unread messages' : '2 messaggi non letti')
      expect(band).toContain('data-feed-new')
      expect(textOf(band)).not.toMatch(/New since your last visit|Nuovo dalla tua ultima visita/)
      expect(textOf(renderView(FeedCase, caseOf('unread-many'), locale))).toContain(locale === 'en' ? '200+ unread messages' : 'oltre 200 messaggi non letti')
      const down = renderView(FeedCase, caseOf('unread-bar'), locale)
      expect(down).toContain(`aria-label="${locale === 'en' ? 'Go to the newest message' : 'Vai al messaggio più recente'}"`)
      expect(down).toContain('<span class="fw-rt-down-n">8</span>')
    }
    expect(renderView(FeedCase, caseOf('conversation'))).not.toContain('fw-rt-down')
    // The count is the reader's own: what the model says, then what arrived while they were higher up — nobody else's reading.
    expect(view).toContain('useState(model.newCount ?? 0)')
    expect(view).toContain('if (line && !atBottom.current) setNewCount(model.newSince ?? 0)')
    expect(view).toContain('setNewCount((count) => count + arrived)')
    expect(view).not.toContain('fw-rt-newbar')
  })

  it('the flash names the row: the whole row of the jumped-to message, FLASH_MS as ONE constant, a still tint with reduced motion', () => {
    const html = renderView(FeedCase, caseOf('flash'))
    expect(html.match(/data-flash=""/g)?.length).toBe(1)
    expect(html).toMatch(/<article class="fw-rt-msg [^"]*" id="message-run-1" data-message-id="run-1"[^>]* data-flash=""/)
    expect(html).toContain(`--fw-rt-flash-ms:${FLASH_MS}ms`)
    expect(FLASH_MS).toBe(1500)
    expect(css).toMatch(/\.fw-rt-msg\[data-flash\]::before \{[^}]*background: var\(--nds-tonal-border\);[^}]*animation: fw-rt-flash var\(--fw-rt-flash-ms\)/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.fw-rt-msg\[data-flash\]::before \{\s*animation-name: fw-rt-flash-still;/)
    // One constant: no other 1500 in the feed's or the card's code and styles.
    for (const file of ['./view/Feed.tsx', './feed.css', '../card/view/MessageCard.tsx', '../card/card.css']) expect(readFileSync(new URL(file, import.meta.url), 'utf8'), file).not.toMatch(/1500|1\.5s/)
    expect(renderView(FeedCase, caseOf('conversation'))).not.toContain('data-flash')
  })

  it('R answers the focused message (its own way); J / K stay; the floating day; nothing yellow in the feed’s own pills', () => {
    expect(view).toContain("if (key === 'r') {")
    expect(view).toContain('replyWay(message, model.context) !== null')
    expect(view).toContain('actions.onReply(message.id)')
    expect(view).toContain('fw-rt-float')
    expect(css).not.toMatch(/warning/)
    expect(css).not.toMatch(/rgba?\(|hsla?\(|color-mix\(|#[0-9a-f]{3,8}\b/i)
  })
})
// ---- end tw- W1.3


// ---- tw- W2.4 (THE THREAD REBUILD; the lead's rule for pills; B6; S13): status words, never a code; the second step said ----------
import { statusMove } from './view/Feed'
import { createTranslator as wordsOf, messagesFor as catalogueOf } from '../../i18n/messages'

describe('tw- W2.4 — the step and change pills show the record types’ status WORDS, never a raw code', () => {
  const feedT = (locale: 'en' | 'it') => wordsOf(locale, catalogueOf(locale, ['record-thread-feed'])['record-thread-feed']!)
  const statusT = (locale: 'en' | 'it') => wordsOf(locale, catalogueOf(locale, ['search'])['search']!)

  it('a known move in words ("Confirmed → Shipped"); only the new status has words: it alone; no words at all: the step’s label alone', () => {
    const t = feedT('en')
    const s = statusT('en')
    expect(statusMove({ from: 'CONFIRMED', to: 'SHIPPED' }, t, s)).toBe(`${s('status.CONFIRMED')} → ${s('status.SHIPPED')}`)
    expect(statusMove({ from: 'CONFIRMED', to: 'SHIPPED' }, t, s)).not.toMatch(/CONFIRMED|SHIPPED/)
    expect(statusMove({ from: 'SOME_NEW_CODE', to: 'SHIPPED' }, t, s)).toBe(s('status.SHIPPED'))
    expect(statusMove({ from: 'CONFIRMED', to: 'SOME_NEW_CODE' }, t, s)).toBeNull()
    expect(statusMove(null, t, s)).toBeNull()
    expect(statusMove({ from: 'CONFIRMED', to: 'SHIPPED' }, feedT('it'), statusT('it'))).not.toMatch(/CONFIRMED|SHIPPED/)
  })

  it('the feed never draws a status code: the step pill and the change list both say it through statusMove', () => {
    const source = readFileSync(new URL('./view/Feed.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain("t('step.status', { from: event.status.from ?? '—', to: event.status.to ?? '—' })")
    expect(source).toContain('const move = statusMove(event.status, t, statusWords)')
    expect(source).toContain("value.field === 'status' ? (statusMove({ from: value.before, to: value.after }, t, statusWords) ?? value.field)")
    const thread = readFileSync(new URL('../parts/ThreadMessages.tsx', import.meta.url), 'utf8')
    expect(thread).toContain("'search'] as const")
  })
})

describe('tw- W2.4 — the states in the new face (S13, B6)', () => {
  it('a read that waits for the second step says how to open it; a missing right says the role, in both languages', () => {
    for (const [locale, words, role] of [['en', 'Confirm it’s you', 'Your role does not include it.'], ['it', 'Conferma che sei tu', 'Il tuo ruolo non lo comprende.']] as const) {
      const t = feedT(locale)
      expect(t('state.stepUp').replace("'", '’')).toContain(words)
      expect(t('state.forbiddenBody')).toBe(role)
    }
    const source = readFileSync(new URL('./view/Feed.tsx', import.meta.url), 'utf8')
    expect(source).toContain("description={model.forbiddenWhy === 'stepUp' ? t('state.stepUp')")
  })
  const feedT = (locale: 'en' | 'it') => wordsOf(locale, catalogueOf(locale, ['record-thread-feed'])['record-thread-feed']!)

  it('one word set: "thread" (IT too) and "email" in the thread’s words, never "conversation" / "conversazione" / "e-mail" (All of keeps its words until its own step)', () => {
    for (const locale of ['en', 'it'] as const) {
      for (const name of ['record-thread-feed', 'record-thread-card', 'record-thread-composer', 'record-thread-head', 'record-thread-files-view', 'record-thread-popups', 'record-thread-attach']) {
        // files-view `upload.happens` names the order's file group as the API words it ("Ordine e conversazione"): the server's name, kept.
        for (const [key, text] of Object.entries(CATALOGUE[locale][name] ?? {}).filter(([key]) => key !== 'upload.happens')) expect(text, `${locale} ${name} ${key}`).not.toMatch(/conversation|conversazion|e-mail/i)
      }
      for (const [key, text] of Object.entries(CATALOGUE[locale]['record-thread'] ?? {}).filter(([key]) => !key.startsWith('allOfCustomer.'))) expect(text, `${locale} ${key}`).not.toMatch(/conversation|conversazion|e-mail/i)
    }
  })
})
// ---- end tw- W2.4

// ---- tw- fx2 (the walk: G-1, G-7, G-12, G-15) ---------------------------------------------------------------------------------------
describe('tw- fx2 — the feed after the walk', () => {
  const feedSource = () => readFileSync(new URL('./view/Feed.tsx', import.meta.url), 'utf8')
  it('G-1: a feed drawn hidden (the phone before its thread view opens) opens once it has a height — at the band, else the newest', () => {
    const source = feedSource()
    expect(source).toContain("if (feed.clientHeight === 0 && typeof ResizeObserver !== 'undefined') return // tw- fx2 (G-1): not shown yet")
    expect(source).toContain('if (feed.clientHeight > 0) setShown((count) => count + 1)')
    expect(source).toContain('}, [model.state, model.context.anchorId, model.newSince, rows, shown])')
    expect(source).toContain('if (line && !atBottom.current) setNewCount(model.newSince ?? 0)')
  })

  it('G-7: one colour per person inside the list (the list’s tones handed to every bubble)', () => {
    const source = feedSource()
    expect(source).toContain('tones: tonesFor(model.messages.map((message) => message.senderKey))')
    expect(source).toContain('context={listContext}')
  })

  it('G-12: J / K walk the list and stop there (a page’s own list keys never get them too)', () => {
    const source = feedSource()
    const walk = source.slice(source.indexOf("if (key !== 'j' && key !== 'k') return"), source.indexOf('revealInList(element) // tw- fx2 (G-3): the list only'))
    expect(walk).toContain('event.preventDefault()')
    expect(walk).toContain('event.stopPropagation()')
  })
})
// ---- end tw- fx2
