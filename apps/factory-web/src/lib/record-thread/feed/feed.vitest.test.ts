import { readFileSync } from 'node:fs' // F-OP-214
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
// B-TH-255
import { HELD_REASONS } from '@nexus/factory-domain/email-in/rules'
import { CATALOGUE } from '../../i18n/messages'
import { foldedGist, HELD_REASON_CODES, hiddenNewLine, waitingMailLine } from './model'
import { FOREIGN_ACTIONS, isStatusStep, stepsWordsOf, stepVerbKey } from './model' // F-OP-214
import { createTranslator, messagesFor } from '../../i18n/messages' // F-OP-214
import { eventOf } from '../model' // F-OP-214

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
    expect(text).toContain('1 mail for this conversation waits in Mail to sort — sender not a contact · Review')
    expect(html({ ...base, waitingMail: { count: 1, reasons: ['UNKNOWN_SENDER'], mayReview: true, reviewHref: REVIEW } })).toContain(`href="${REVIEW}"`)
    expect(textOf(html({ ...base, waitingMail: { count: 2, reasons: ['UNKNOWN_SENDER', 'THREAD_CLOSED'], mayReview: true, reviewHref: REVIEW } }, 'it'))).toContain('2 e-mail per questa conversazione attendono in Posta da smistare — mittente non tra i contatti, questa conversazione è chiusa · Controlla')
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

  it('a folded erased message says so; a folded message of files only names its files — never an empty line that looks erased', () => {
    expect(foldedGist({ body: '', files: [], erased: true })).toEqual({ key: 'erased.short' })
    expect(foldedGist({ body: '', files: [{ id: 'f', name: 'a.jpg', sizeBytes: 1, contentType: 'image/jpeg', status: 'AVAILABLE' }] })).toEqual({ key: 'filesOnly.line', count: 1 })
    expect(foldedGist({ body: '', files: [], hiddenFiles: 2 })).toEqual({ key: 'filesOnly.line', count: 2 })
    expect(foldedGist({ body: 'Hello\nthere', files: [] })).toEqual({ text: 'Hello' })
    const depth = designScreen.cases.find((item) => item.id === 'folded-depth')!
    const text = textOf(renderView(FeedCase, depth.model))
    expect(text).toContain('Message removed (privacy request)')
    expect(text).toContain('2 files')
  })

  it('the B-TH-255 cases draw with no key left; Brand Beta never shows in Brand Alpha’s lines', () => {
    for (const [locale, id, rendered] of everyCase(designScreen)) {
      expect(leftKeys(rendered, ['waiting', 'hidden', 'erased', 'filesOnly']), `${locale} ${id}`).toEqual([])
      if (id.startsWith('waiting') || id === 'hidden-new' || id === 'folded-depth') expect(scanText(textOf(rendered), BRAND_BETA), `${locale} ${id}`).toEqual([])
    }
    expect(designScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['waiting-review', 'waiting-two', 'waiting-colleague', 'hidden-new', 'folded-depth']))
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
