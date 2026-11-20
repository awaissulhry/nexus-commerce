import { readFileSync } from 'node:fs'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ComponentType } from 'react'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { renderView, textOf } from '../../../../../lib/record-thread/parts/testing'
import { order } from '../../_demo/fixtures'
import { designScreen } from '../fixtures'
import { SO2_BLOCKERS } from '../fixtures' // F-OP-301
import { CONFIRMED_READ, HEADLINE, LINES, PRODUCTION_READ } from './fixtures'
import { GATE, PEOPLE } from './fixtures' // F-OO-208
import { datesSchema, peopleSchema, productionSchema } from './api' // F-OO-208
import { orderSchema, type Order } from '../../api' // F-OO-208
import { mergeRead } from './model' // F-OO-100: each section's own rules are tested in its file (where, progress, people, dates, linked, facts)
import { changesBadgeOf, changesDotOf, rowWordsOf, waitingCardOf, waitingOf, type WaitingRow } from './model' // F-OP-103 (F-OO-202: whoActsNextOf is gone)
import { orderWaitingOf } from './model' // F-OP-301
// ---- F-OO-204: the request rows and their doors (the world of the design cases, a row drawn alone, the row's age) ----
import { createElement } from 'react'
import { render } from '../../../../../lib/record-thread/parts/testing'
import { RQ_ASK, RQ_ASKED, RQ_COUNTERED, requestsWorld } from '../fixtures'
import { askWordsOf, rowAgeOf } from '../changes/model'
import { WaitingRowItem } from '../view/RequestsSection'
import type { OrderRecordModel } from '../record-model'
// ---- end F-OO-204

/**
 * F-SA-232 (sales page plan N2; 10-order-page §2.1 O1, O2; review OW-6, OW-7, C-3) — Overview's rules and its cases: the headline
 * sentence per state, the five stages, who acts next, the health only from the reads (never "On track" in the band), "Not counted
 * here" never 0, made to measure grouped per style × colourway, the line's sizes window, and a re-read that keeps the other parts.
 *
 * F-OO-100 (order overview lane: one file per section): each section's rules are tested beside them (where.vitest, progress.vitest,
 * people.vitest, dates.vitest, linked.vitest, facts.vitest); this file keeps the layout, the draws and the cross-section parity
 * (the ONE waiting list read by the header, the cards and the Changes tab).
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
// F-OO-100: the Overview is OverviewTab.tsx and one file per card (view/overview/); its rules are model.ts and one file per section.
const CARDS = ['WhereCard', 'ProgressCard', 'PeopleCard', 'DatesCard', 'RequestsCard', 'LinkedCard', 'FactsCard'] as const
const SECTIONS = ['where', 'progress', 'people', 'dates', 'linked', 'facts'] as const
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const overviewViews = () => [read('../view/OverviewTab.tsx'), ...CARDS.map((card) => read(`../view/overview/${card}.tsx`))].join('\n')
const overviewRules = () => [read('./model.ts'), ...SECTIONS.map((section) => read(`./${section}.ts`))].join('\n')

describe('the production read on the page: a re-read keeps the other parts', () => {
  it('a re-read of some parts keeps the others (and their withheld keys); the newest time wins', () => {
    const first = { ...PRODUCTION_READ, withheld: ['people', 'dates.forecast'] }
    const next = { ...PRODUCTION_READ, asOf: '2026-11-18T09:50:00Z', parts: ['lines' as const], withheld: [], lines: [LINES[0]!], headline: undefined }
    const merged = mergeRead(first, next)
    expect(merged.lines).toHaveLength(1)
    expect(merged.headline).toEqual(PRODUCTION_READ.headline)
    expect(merged.asOf).toBe('2026-11-18T09:50:00Z')
    expect(merged.withheld).toEqual(['people', 'dates.forecast'])
    expect(mergeRead(null, next)).toBe(next)
  })
})

describe('the Overview cases draw in both languages, never a 0 for a step not counted, never a worker', () => {
  // F-OO-103: rewritten — who acts next, the ex-factory slip and the bundles left section 1 (each lives in one other place: the F-OO-103
  // block below proves it); the band keeps At risk and Urgent (customer).
  it('in production: the sentence, the band\'s At risk and Urgent (customer), the stages, "Not counted here"', () => {
    const text = textOf(draw('overview'))
    // F-OO-101: the headline is the status and the stage ("In production · Sewing"); "· 1 line ahead" is not said (F8).
    expect(text).not.toMatch(/line ahead|riga avanti/)
    for (const words of ['Where it is now', 'In production · Sewing', 'Waiting on us', 'At risk', 'Urgent (customer)', 'Progress by line', 'Cut and bundled', 'Checked', 'Shipped', 'Not counted here', 'Total · 2 lines', 'Pieces as of']) expect(text, words).toContain(words)
    const it = textOf(draw('overview', 'it'))
    for (const words of ['A che punto è', 'In produzione · Confezione', 'Avanzamento per riga', 'Tagliati e in fasci', 'Spediti', 'Non contato qui', 'Urgente (cliente)']) expect(it, words).toContain(words)
    expect(text).not.toMatch(/\b(?:operator|operatore|station|postazione)\b/i)
  })

  // F-OO-103: rewritten — the deposit note on Preparing left section 1 (the deposit strip says it, F-OO-105).
  it('before any work order: Confirmed · Preparing (F-OO-101), "Not in work orders yet" (F-OO-121: no "Nothing cut yet")', () => {
    const text = textOf(draw('overview-confirmed'))
    for (const words of ['Confirmed · Preparing', 'Not in work orders yet']) expect(text, words).toContain(words)
    expect(text).not.toContain('Work orders are made after the deposit')
    // F-OO-121: the card no longer says "Nothing cut yet" (each line's "—" and its pill say it).
    expect(text).not.toContain('Nothing cut yet')
  })

  it('loading says it reads (no figure), a failed read says so in this part only with Try again', () => {
    expect(textOf(draw('overview-loading'))).not.toMatch(/Total · /)
    const failed = textOf(draw('overview-failed'))
    expect(failed).toContain('Try again')
    expect(failed).toContain('Lines') // the rest of the page stays: the tabs
  })

  it('every overview word exists in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['tab.overview', 'tab.attention', 'overview.where', 'overview.progress', 'overview.notInWorkOrders', 'overview.piecesAsOf', 'overview.headline.shipped', 'overview.headline.delivered', 'overview.col.line', 'overview.sizes.label', 'overview.sizes.finish', 'overview.sizes.units', 'overview.sizes.openLines']) expect(t(key), `${locale}: ${key}`).not.toBe(key)
      for (const key of ['overview.total', 'mtm.units']) expect(t(key, { count: 2, stage: 'x' }), `${locale}: ${key}`).not.toBe(key)
      // F-OO-103: section 1's own facts left the catalogue with the card's facts (Next dates' Promised row has its own words, F-OO-141).
      for (const key of ['overview.fact.who', 'overview.fact.exFactory', 'overview.fact.health', 'overview.fact.customer', 'overview.fact.inWork', 'overview.afterDeposit', 'overview.exFactory', 'overview.exFactoryMovedOnly', 'overview.exFactoryMoved']) expect(t(key, { date: 'x', count: 1, days: '+1' }), `${locale}: ${key}`).toBe(key)
      expect(t('overview.bundles', { count: 2, stage: 'x' }), `${locale}: overview.bundles`).toBe('overview.bundles')
      const p = createTranslator(locale, messagesFor(locale, ['production']).production!)
      expect(p('parts.pieces.stages.SHIPPED')).not.toBe('parts.pieces.stages.SHIPPED')
    }
  })
})

// ---- F-SA-233: People, Next dates, Requests & changes, Linked records, Order facts ------------------------------------------------
describe('Overview’s facts (F-SA-233)', () => {
  // F-OO-202: rewritten — the deposit is a hold (Where it is now's strip), so the card lists no row of it: it holds requests only.
  // F-OO-205: rewritten — no "latest change" on the card any more (Changes › History tells it): the card reads nothing of the order.
  it('requests & changes: the ONE waiting list\'s request rows on us and on the customer (F-OP-103) and still to do — no latest amendment', () => {
    const rows = waitingOf(CONFIRMED_READ, { requests: [], approvals: [], recordPayment: false, locale: 'en' })
    expect(rows).toMatchObject([{ kind: 'DEPOSIT', on: 'BRAND', place: 'HOLD' }])
    expect(waitingCardOf(rows, CONFIRMED_READ)).toEqual({ onUs: [], onCustomer: [], still: [], nothing: true })
    expect(waitingCardOf([], null)).toEqual({ onUs: [], onCustomer: [], still: [], nothing: true })
  })

  it('the cards draw in both languages; the custom fields and the record chain moved to Overview', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(draw('overview', locale))
      // F-OP-103: the case's open request waits on us (the ONE waiting list's row), so "Nothing waits" is not said.
      // F-OO-204: the group's head says "Waiting on us · 1" / "Tocca a noi · 1" (the Changes tab's own words).
      for (const words of locale === 'en' ? ['People', 'Next dates', 'Requests & changes', 'Linked records', 'Order facts', 'Waiting on us · 1'] : ['Persone', 'Prossime date', 'Richieste e modifiche', 'Record collegati', "Dati dell'ordine", 'Tocca a noi · 1']) expect(text, words).toContain(words)
      expect(text).not.toContain(locale === 'en' ? 'Nothing waits on us or on the customer' : 'Niente aspetta noi o il cliente')
    }
    const container = readFileSync(new URL('../OrderRecord.tsx', import.meta.url), 'utf8')
    // F-OO-211: built once on Overview and handed down as customFields (beside Order facts), no longer the frame's slot.
    expect(container).toContain("const customFields = value && tab === 'overview' ? <RecordCustomFields ")
    const lines = readFileSync(new URL('../view/LinesTab.tsx', import.meta.url), 'utf8')
    expect(lines).not.toContain('function RecordChain')
  })
})

// ---- F-OP-103 (order page plan N1; 10-order-page §3.2; 13-backend B4; review R-21, R-22): the ONE waiting list -----------------------
describe('F-OP-103: the ONE waiting list — every blocker and open yes is one row with one door; the card, who acts next and the badge read it', () => {
  const words = (en: string) => ({ en, it: `${en} (it)` })
  const blocker = (kind: string, on: 'US' | 'BRAND' | 'SUPPLIER' | 'WORKSHOP', since: string | null, ref: { type: string; id: string; messageId?: string } | null = null, sub: 'REQUEST' | 'COUNTER' | 'PROBLEM' | 'REPROMISE' | null = null) => ({ kind, on, words: words(kind), since, ref, sub })
  const headlineWith = (blockers: ReturnType<typeof blocker>[]) => ({ headline: { ...HEADLINE, waiting: { ...HEADLINE.waiting, blockers } } })
  const request = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'CHANGE', status: 'OPEN', counter: null, ...over }) as never
  const yesTask = (over: Record<string, unknown> = {}) => ({
    taskId: 't-1',
    kind: 'SALES_ORDER_CHANGE',
    kindLabel: { en: 'Order change', it: 'Modifica ordine' },
    requestedAt: '2026-11-10T08:00:00Z',
    requester: { name: 'Luca Prova', me: false },
    approver: { kind: 'ROLE' as const, name: 'Finance', me: false },
    version: 2,
    requireStepUp: false,
    approve: { allowed: false, why: 'It changed since you looked: the request was asked about another version of the record. Ask again.' },
    reject: { allowed: true, why: null },
    withdraw: { allowed: false, why: null },
    ...over,
  })
  const inputs = { requests: [request('r-open'), request('r-agreed', { status: 'COUNTERED', counter: { state: 'AGREED' } }), request('r-lapsed', { status: 'COUNTERED', counter: { state: 'LAPSED' } })], approvals: [], recordPayment: true, locale: 'en' }
  const all = headlineWith([
    blocker('BRAND_REQUEST', 'US', '2026-11-18T09:00:00Z', { type: 'OrderChangeRequest', id: 'r-open' }, 'REQUEST'),
    blocker('BRAND_REQUEST', 'US', '2026-11-17T09:00:00Z', { type: 'OrderChangeRequest', id: 'r-agreed' }, 'COUNTER'),
    blocker('BRAND_REQUEST', 'US', '2026-11-16T09:00:00Z', { type: 'OrderChangeRequest', id: 'r-lapsed' }, 'COUNTER'),
    blocker('BRAND_REQUEST', 'US', '2026-10-30T09:00:00Z', { type: 'ProductionIssue', id: 'p-1', messageId: 'm-1' }, 'PROBLEM'),
    blocker('BRAND_REQUEST', 'US', '2026-11-12T09:00:00Z', { type: 'ApprovalRequest', id: 'a-refused' }, 'REPROMISE'),
    blocker('APPROVAL', 'BRAND', '2026-11-14T09:00:00Z', { type: 'ApprovalRequest', id: 'a-1' }),
    blocker('PARTNER_TASK', 'BRAND', '2026-11-15T09:00:00Z', { type: 'PartnerTask', id: 'pt-1' }),
    blocker('DEPOSIT', 'BRAND', '2026-10-28T15:00:00Z', { type: 'DepositRequest', id: 'd-1' }),
    blocker('BRAND_PAUSE', 'BRAND', '2026-11-13T09:00:00Z', { type: 'WorkOrder', id: 'wo-1' }),
    blocker('QUALITY_HOLD', 'US', '2026-11-11T09:00:00Z', { type: 'WorkOrder', id: 'wo-2' }),
    blocker('NO_MOVE', 'US', null, null),
    blocker('MATERIAL_SHORT', 'SUPPLIER', null, null),
    blocker('GATE', 'US', '2026-11-09T09:00:00Z', { type: 'OrderGate', id: 'g-1' }),
    blocker('SUBCONTRACT', 'WORKSHOP', '2026-11-08T09:00:00Z', { type: 'WorkOrder', id: 'wo-3' }),
  ])
  const byKind = (rows: readonly WaitingRow[], kind: string, sub: string | null = null) => rows.filter((row) => row.kind === kind && row.sub === sub)

  it('every sub-kind of a customer request: Answer… (the review window), Reply in the thread at its message, the refused date on Production', () => {
    const rows = waitingOf(all, inputs)
    const [open] = byKind(rows, 'BRAND_REQUEST', 'REQUEST')
    expect(open!.door).toMatchObject({ kind: 'answer', requestId: 'r-open', request: { id: 'r-open' } })
    expect(open!.words).toEqual({ kind: 'phrase', phrase: { key: 'band.asks' }, requestKind: 'CHANGE' })
    const counters = byKind(rows, 'BRAND_REQUEST', 'COUNTER')
    // An agreed or lapsed counter-offer waits on US (B4 fixes the count): its words say which.
    expect(counters.map((row) => [row.on, row.door.kind, row.words.kind === 'phrase' ? row.words.phrase.key : null])).toEqual([
      ['US', 'answer', 'waiting.counterLapsed'],
      ['US', 'answer', 'waiting.counterAgreed'],
    ])
    expect(byKind(rows, 'BRAND_REQUEST', 'PROBLEM')[0]).toMatchObject({ door: { kind: 'reply', messageId: 'm-1' }, words: { kind: 'phrase', phrase: { key: 'waiting.problem' } } })
    // Decide… (F-OP-105) is deferred: the refused date's door is Production › Dates, where the promise is changed.
    expect(byKind(rows, 'BRAND_REQUEST', 'REPROMISE')[0]).toMatchObject({ door: { kind: 'tab', tab: 'production', anchor: 'dates' }, words: { kind: 'phrase', phrase: { key: 'waiting.repromise' } } })
    // A request this page did not read (yet): Answer… still names it; the view sends it to Changes, where it is listed.
    expect(waitingOf(all, { ...inputs, requests: null }).find((row) => row.sub === 'REQUEST')!.door).toEqual({ kind: 'answer', requestId: 'r-open', request: null })
    expect(waitingOf(all, { ...inputs, requests: null }).find((row) => row.sub === 'REQUEST')!.words).toEqual({ kind: 'api', words: words('BRAND_REQUEST') })
  })

  // F-OO-204: rewritten — what waits on the customer has no dead "Changes ›" any more: our open counter-offer opens the ONE review
  // window (Open…), what we asked is theirs to answer (Their turn).
  it('every other kind has one door: Open… for our counter-offer, Their turn for what we asked, Record the payment (or Money), Production › holds / dates', () => {
    const rows = waitingOf(all, inputs)
    expect(byKind(rows, 'APPROVAL')[0]!.door).toEqual({ kind: 'their' })
    expect(byKind(rows, 'PARTNER_TASK')[0]!.door).toEqual({ kind: 'their' })
    const counter = waitingOf(headlineWith([blocker('APPROVAL', 'BRAND', '2026-11-13T09:00:00Z', { type: 'OrderChangeRequest', id: 'r-open' })]), inputs)[0]!
    expect(counter.door).toMatchObject({ kind: 'open', requestId: 'r-open', request: { id: 'r-open' } })
    expect(waitingOf(headlineWith([blocker('APPROVAL', 'BRAND', null, { type: 'OrderChangeRequest', id: 'r-open' })]), { ...inputs, requests: null })[0]!.door).toEqual({ kind: 'open', requestId: 'r-open', request: null })
    expect(byKind(rows, 'DEPOSIT')[0]!.door).toEqual({ kind: 'payment', requestId: 'd-1' })
    expect(byKind(waitingOf(all, { ...inputs, recordPayment: false }), 'DEPOSIT')[0]!.door).toEqual({ kind: 'tab', tab: 'money', anchor: null })
    // F-OP-116: the customer's pause on a work order the reader reaches is lifted in place (F-OP-114's Lift); no ref: Production › holds.
    expect(byKind(rows, 'BRAND_PAUSE')[0]!.door).toEqual({ kind: 'lift', workOrderId: 'wo-1' })
    expect(byKind(waitingOf(headlineWith([blocker('BRAND_PAUSE', 'BRAND', null, null)]), inputs), 'BRAND_PAUSE')[0]!.door).toEqual({ kind: 'tab', tab: 'production', anchor: 'holds' })
    for (const kind of ['QUALITY_HOLD', 'NO_MOVE', 'SUBCONTRACT']) expect(byKind(rows, kind)[0]!.door, kind).toEqual({ kind: 'tab', tab: 'production', anchor: 'holds' })
    for (const kind of ['MATERIAL_SHORT', 'GATE']) expect(byKind(rows, kind)[0]!.door, kind).toEqual({ kind: 'tab', tab: 'production', anchor: 'dates' })
    // Every row has exactly one door, and the API's own words wherever the page has none of its own.
    expect(rows.every((row) => typeof row.door.kind === 'string')).toBe(true)
    expect(byKind(rows, 'GATE')[0]!.words).toEqual({ kind: 'api', words: words('GATE') })
  })

  it('an open yes of the order is a row on us with the yes in place — the old change\'s yes (W39-02) too, its STALE yes held, its no open', async () => {
    const { yesDoorOf } = await import('../../depth/model')
    const rows = waitingOf(headlineWith([]), { ...inputs, approvals: [yesTask()] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'YES', on: 'US', since: '2026-11-10T08:00:00Z', words: { kind: 'phrase', phrase: { key: 'waiting.yes', params: { kind: 'Order change' } } }, door: { kind: 'yes', task: { taskId: 't-1' } } })
    const door = rows[0]!.door
    if (door.kind !== 'yes') throw new Error('a yes row')
    expect(yesDoorOf(door.task)).toMatchObject({ kind: 'decide', confirmHeld: { key: 'approval.refused.STALE' }, refuseHeld: null })
    expect(waitingOf(headlineWith([]), { ...inputs, approvals: [yesTask()], locale: 'it' })[0]!.words).toMatchObject({ phrase: { params: { kind: 'Modifica ordine' } } })
  })

  // F-OO-202: rewritten — who acts next is gone (F14: the keeper's `waitingOn` stays the one rule, for the orders list and the portal);
  // the card counts the request rows only; the holds and the dates are the same call's own lists, oldest first too.
  it('oldest first (no known start last); the card counts the request rows on us and on the customer; holds and dates apart', () => {
    const rows = waitingOf(all, { ...inputs, approvals: [yesTask()] })
    const since = rows.map((row) => row.since)
    const known = since.filter((value): value is string => value !== null)
    expect(known).toEqual([...known].sort())
    expect(since.slice(-2)).toEqual([null, null])
    expect(rows[0]).toMatchObject({ kind: 'DEPOSIT', since: '2026-10-28T15:00:00Z', place: 'HOLD' })
    const card = waitingCardOf(rows, null)
    expect(card.onUs.map((row) => [row.kind, row.sub])).toEqual([['BRAND_REQUEST', 'PROBLEM'], ['YES', null], ['BRAND_REQUEST', 'COUNTER'], ['BRAND_REQUEST', 'COUNTER'], ['BRAND_REQUEST', 'REQUEST']])
    expect(card.onCustomer.map((row) => row.kind)).toEqual(['APPROVAL', 'PARTNER_TASK'])
    // A supplier's or a workshop's wait is a date (Next dates): in neither count.
    expect([...card.onUs, ...card.onCustomer].some((row) => row.on === 'SUPPLIER' || row.on === 'WORKSHOP')).toBe(false)
    expect(rows.filter((row) => row.place === 'HOLD').map((row) => row.kind)).toEqual(['DEPOSIT', 'QUALITY_HOLD', 'BRAND_PAUSE', 'NO_MOVE'])
    expect(rows.filter((row) => row.place === 'DATE').map((row) => [row.kind, row.sub])).toEqual([['SUBCONTRACT', null], ['GATE', null], ['BRAND_REQUEST', 'REPROMISE'], ['MATERIAL_SHORT', null]])
  })

  it('R-22: the Changes badge counts the card\'s own rows — waiting on us, on the customer, still to do (F-OO-202: requests only)', () => {
    const rows = waitingOf(all, inputs)
    const card = waitingCardOf(rows, { ...PRODUCTION_READ, changes: { openRequests: [], stillToDo: { rows: [{ kind: 'WORK_ORDER_CHANGE', ref: null, words: { en: 'x', it: 'x' }, since: '2026-11-17T13:02:00Z', waitingOn: 'PLANNER', mayAct: true, requestId: null }], count: 1, workOrdersLeftOut: 0 } } })
    expect(changesBadgeOf(card)).toBe(card.onUs.length + card.onCustomer.length + 1)
    // F-OO-202: 4 requests on us, 2 on the customer, 1 still — never a hold or a date (of the 14 rows only the 6 requests count; it was 13).
    expect(changesBadgeOf(card)).toBe(rows.filter((row) => row.place === 'REQUEST').length + 1)
    expect(changesBadgeOf(card)).toBe(7)
    expect(changesBadgeOf(waitingCardOf([], null))).toBe(0)
  })

  it('a row\'s words: the API\'s own in the page\'s language, or the phrase with the customer and the request\'s kind', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      const rows = waitingOf(all, { ...inputs, locale, approvals: [yesTask()] })
      for (const row of rows) {
        const said = rowWordsOf(row, { t, kindWords: (kind) => `«${kind}»`, locale, customer: 'Brand Alpha' })
        expect(said, `${locale} ${row.key}`).not.toMatch(/\b(?:waiting|band)\.[a-zA-Z]+/)
        expect(said, `${locale} ${row.key}`).not.toContain('{')
      }
      const open = rows.find((row) => row.sub === 'REQUEST')!
      expect(rowWordsOf(open, { t, kindWords: () => 'CHANGE-WORDS', locale, customer: 'Brand Alpha' })).toBe(locale === 'en' ? 'Brand Alpha asks: CHANGE-WORDS' : 'Brand Alpha chiede: CHANGE-WORDS')
      expect(rowWordsOf(rows.find((row) => row.kind === 'GATE')!, { t, kindWords: String, locale, customer: '' })).toBe(locale === 'en' ? 'GATE' : 'GATE (it)')
    }
  })

  it('the words exist in both languages; the web knows the domain\'s sub-kinds; the replaced counts are gone', async () => {
    const { BLOCKER_SUBS } = await import('./api')
    const domain = await import('@nexus/factory-domain/production-brand/waiting')
    expect([...BLOCKER_SUBS]).toEqual([...domain.BLOCKER_SUBS])
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['waiting.reply', 'waiting.noThread', 'waiting.counterAgreed', 'waiting.counterLapsed', 'waiting.go.production', 'waiting.go.money', 'waiting.go.changes', 'deposit.record', 'changes.still.since']) expect(t(key, { when: 'x' }), `${locale} ${key}`).not.toBe(key)
      for (const [key, params] of [['waiting.onUs', { count: 2 }], ['waiting.onCustomer', { count: 1, customer: 'Brand Alpha' }], ['waiting.problem', { customer: 'Brand Alpha' }], ['waiting.repromise', { customer: 'Brand Alpha' }], ['waiting.yes', { kind: 'x' }]] as const) expect(t(key, params), `${locale} ${key}`).not.toBe(key)
      expect(t('overview.requests.onUs', { count: 1 })).toBe('overview.requests.onUs')
    }
    const source = readFileSync(new URL('./model.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('export function requestCountsOf')
    expect(source).not.toContain('export function waitingInputOf')
  })

  it('the card and its doors: each row its one door in place (the review window, the thread\'s reply, the yes, the payment, a tab link)', () => {
    const view = readFileSync(new URL('../view/RequestsSection.tsx', import.meta.url), 'utf8')
    expect(view).toContain("frame?.compose?.({ messageId: door.messageId, mode: 'reply' })")
    expect(view).toContain("actions?.onDialog?.({ kind: 'depositPayment', requestId: door.requestId })")
    expect(view).toContain('<YesDoorView door={yesDoorOf(door.task, model.busy)} onYes={actions?.yes} />')
    expect(view).toContain('<TabLink href={`${tabHref(recordHref, tab, search)}${anchor ? `#${anchor}` : \'\'}`}>')
    const tab = readFileSync(new URL('../view/OverviewTab.tsx', import.meta.url), 'utf8')
    // F-OP-301: through the ONE call the badge and the Changes tab make too.
    expect(tab).toContain('const waiting = orderWaitingOf(order, model, locale)')
    // F-OO-100: "Where it is now" is its own file. F-OO-103: it says no "who acts next" any more (Requests & changes' groups do), so it
    // reads neither the list's first row nor the kept `headline.waiting`.
    const where = read('../view/overview/WhereCard.tsx')
    expect(where).not.toContain('waiting.next')
    expect(where).not.toMatch(/headline\??\.waiting/)
    // R-21: the dock does not read this list (its pill names the thread).
    const dock = readFileSync(new URL('../dock/OrderDock.tsx', import.meta.url), 'utf8')
    expect(dock).not.toContain('waitingOf(')
  })

  it('the overview case draws the open request\'s row with its door in both languages', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(draw('overview', locale))
      expect(text).toContain(locale === 'en' ? 'Waiting on us · 1' : 'Tocca a noi · 1') // F-OO-204
      expect(text).toContain(locale === 'en' ? 'A customer request waits for our answer' : 'Una richiesta del cliente aspetta la nostra risposta')
      expect(text).toContain(locale === 'en' ? 'Changes ›' : 'Modifiche ›')
      // F-OO-205: the head's link carries the Changes badge's number.
      expect(text).toContain(locale === 'en' ? 'Changes (1) ›' : 'Modifiche (1) ›')
    }
  })
})
// ---- end F-OP-103

// ---- F-OP-104 (order page plan N1; 10-order-page §3.1, §3.3, §3.4; review N-1, R-19): Overview's doors ----------------------------
describe('F-OP-104: Overview doors — the stages a real link, Open in Production, the dates changed in place, who answers the customer', () => {
  it('StageStrip: with stageHref the stages are ONE real link (its name; the promise is the page\'s); production pages keep it as it was', async () => {
    const { createElement } = await import('react')
    const { render } = await import('../../../../../lib/record-thread/parts/testing')
    const { StageStrip } = await import('../../../../../lib/production/view/StageStrip')
    const promise = { date: '2026-12-15', history: [{ on: '2026-11-10', from: '2026-12-09', to: '2026-12-15', reason: null }] }
    const href = '/w/demo/sales/orders/o1?tab=production&thread=all#work-orders'
    const door = render(createElement(StageStrip, { face: 'office', stage: 'SEWING', promise, stageHref: href, stageLinkLabel: 'Open the work orders in Production · now Sewing' }))
    expect(door).toContain(`href="${href.replace(/&/g, '&amp;')}"`)
    expect(door).toContain('aria-label="Open the work orders in Production · now Sewing"')
    expect(door).toContain('class="fw-prp-strip-go"')
    // A link holds no other control: the promise's history (a disclosure) is not inside it.
    expect(door).not.toContain('<details')
    const plain = render(createElement(StageStrip, { face: 'office', stage: 'SEWING', promise }))
    expect(plain).not.toContain('<a ')
    expect(plain).toContain('<details')
    // No stage known: no link (nothing to open), the "—" as before.
    expect(render(createElement(StageStrip, { face: 'office', stage: null, stageHref: href }))).not.toContain('<a ')
    const css = readFileSync(new URL('../../../../../lib/production/production-parts.css', import.meta.url), 'utf8')
    expect(css).toContain('.fw-prp-strip-go:focus-visible')
  })

  it('the overview draws its doors: the stages\' link, Open the dates, Change… on the promise and the requested date, the backup\'s page', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw('overview', locale)
      const text = textOf(html)
      expect(html).toContain('class="fw-prp-strip-go"')
      expect(html).toMatch(/href="[^"]*\?tab=production[^"]*#work-orders"/)
      expect(html).toMatch(/href="[^"]*\?tab=production[^"]*#dates"/)
      expect(text).toContain(locale === 'en' ? 'Change…' : 'Cambia…')
      expect(text).toContain(locale === 'en' ? 'Promised' : 'Promesso')
      expect(text).toContain(locale === 'en' ? 'Requested' : 'Richiesto')
    }
    const source = overviewViews() // F-OO-100: OverviewTab and its cards
    expect(source).not.toMatch(/\?tab=/)
    expect(source).toContain("onClick={() => frame?.openDoor?.('owner')}")
    expect(source).toContain("onClick={() => actions?.onDialog?.({ kind: 'promise' })}")
    expect(source).toContain('onClick={() => actions?.onRequestedChange?.()}')
    // F-OO-126: the line window's Open in Production lands on the work orders (was the line's row, #line-<id>).
    expect(source).toContain("#work-orders`}>{t('doors.openInProduction')}")
    const model = overviewRules() // F-OO-100: model.ts and the section files (linked.ts builds the tab links)
    expect(model).not.toMatch(/`\$\{record\}\?tab=/)
  })

  // F-OO-144 (order overview, review F7): the requested date's Change… opens its small dialog in the page's one slot — the hop to Lines
  // went; the Lines edit mode's field keeps its id.
  it('the requested date\'s Change…: its small dialog in the page\'s one slot (no hop to Lines); the Lines field keeps its id', async () => {
    const { REQUESTED_FIELD_ID } = await import('./model')
    const acts = readFileSync(new URL('../use-overview-acts.ts', import.meta.url), 'utf8')
    expect(acts).toContain("onRequestedChange: () => input.setDialog?.({ kind: 'requested' })")
    expect(acts).not.toContain('input.focus?.(REQUESTED_FIELD_ID)')
    const container = readFileSync(new URL('../OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain('useOverviewActs({ startAmend: () => lines.actions.onAmendStart?.(), focus: (anchor) => setFocusRow({ anchor, at: Date.now() }), setDialog /* F-OO-144 */')
    const lines = readFileSync(new URL('../view/LinesTab.tsx', import.meta.url), 'utf8')
    expect(lines).toContain('<DateField id={REQUESTED_FIELD_ID}')
    expect(REQUESTED_FIELD_ID).toBe('amend-requested-date')
    // The view never imports an acts hook (view-boundaries rule 2): the id lives in the pure model.
    expect(lines).not.toContain("from '../use-overview-acts'")
  })

  it('the words exist in both languages (office "tu")', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['doors.openInProduction', 'doors.change', 'doors.ownDates']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      for (const [key, params] of [['doors.stages', { stage: 'x' }], ['doors.backupFor', { customer: 'Brand Alpha' }], ['doors.backupElsewhere', { customer: 'Brand Alpha' }]] as const) expect(t(key, params), `${locale} ${key}`).not.toBe(key)
    }
  })
})
// ---- end F-OP-104

// ---- F-OP-301 (walk #1, #2, #3; plan N1 "Waiting"): the header, the card, the Changes badge and the Changes tab read ONE list ------
describe('F-OP-301: one waiting list for the header, the card, the Changes badge and the Changes tab (the walk\'s SO-0002 and SO-0003)', () => {
  const amendments = { count: 0, latestRevision: null, latestAt: null }
  const so2Request = { id: '0190f0e2-3080-7000-8000-000000000821', status: 'OPEN', kind: 'CHANGE', counter: null } as never
  const readWith = (blockers: unknown[], waiting: { on: 'US' | 'BRAND'; since: string | null }, still: unknown[] = []) =>
    ({ status: 'ready', read: { ...PRODUCTION_READ, headline: { ...HEADLINE, waiting: { ...HEADLINE.waiting, ...waiting, blockers } }, changes: { openRequests: [], stillToDo: { rows: still, count: still.length, workOrdersLeftOut: 0 } } } }) as never
  const page = (production: unknown, requests: unknown[] | null = [so2Request]) => ({ production: production as never, requests: requests ? { value: requests as never } : null, can: { recordPayment: false } })

  // F-OO-202: rewritten (D8) — the two gates are dates (Next dates), so the card and the badge count the change request on us, the yes we
  // asked of the customer and Still to do: SEED-SO-0002's 1 + 1 + 1 = 3 (it was 5: the two gates counted too).
  it('SO-0002: a change request waits on us, a yes we asked on the customer, one step still to do — the badge 3; its two gates are dates', () => {
    const still = { kind: 'WORK_ORDER_CHANGE', ref: null, words: { en: 'SEED-WO-0001: make 54 → 0', it: 'SEED-WO-0001: fai 54 → 0' }, since: '2026-11-16T09:00:00Z', waitingOn: 'PLANNER', mayAct: false, requestId: null }
    const waiting = orderWaitingOf({ openApprovals: [], amendments }, page(readWith(SO2_BLOCKERS, { on: 'BRAND', since: '2026-11-05T09:00:00Z' }, [still])), 'en')
    if (waiting.status !== 'ready') throw new Error('ready')
    expect(waiting.card.onUs.map((row) => row.kind)).toEqual(['BRAND_REQUEST'])
    expect(waiting.card.onCustomer.map((row) => [row.kind, row.ref])).toEqual([['APPROVAL', { type: 'ApprovalRequest', id: '0190f0e2-6262-7000-8000-000000000001' }]])
    expect(waiting.card.still).toHaveLength(1)
    expect(changesBadgeOf(waiting.card)).toBe(3)
    // The old count (every row + still) was 5; the gates are Next dates' own rows now, counted there and only there.
    expect(waiting.rows.length + waiting.card.still.length).toBe(5)
    expect(waiting.dates.map((row) => [row.kind, row.ref?.id])).toEqual([['GATE', '0190f0e2-6161-7000-8000-000000000001'], ['GATE', '0190f0e2-6161-7000-8000-000000000002']])
    expect(waiting.holds).toEqual([])
    // The change request's row opens the review window with the request the page read.
    expect(waiting.card.onUs[0]!.door).toMatchObject({ kind: 'answer', request: { id: '0190f0e2-3080-7000-8000-000000000821' } })
  })

  // F-OO-202: rewritten — no "who acts next" any more (F14): the call says nothing waits in every place; the kept wait is read by nobody.
  it('SO-0003: nothing waits — no request, no hold, no date, badge 0 (never the kept "Waiting on us · 5 d"); a step still to do counts', () => {
    const waiting = orderWaitingOf({ openApprovals: [], amendments }, page(readWith([], { on: 'US', since: '2026-11-14T17:00:00Z' }), null), 'en')
    if (waiting.status !== 'ready') throw new Error('ready')
    expect(waiting.card.nothing).toBe(true)
    expect(changesBadgeOf(waiting.card)).toBe(0)
    expect([waiting.rows, waiting.holds, waiting.dates]).toEqual([[], [], []])
    expect('next' in waiting).toBe(false)
    // A Still to do row (the card's third list) is something to do: the card is not empty and the badge counts it.
    const still = { kind: 'EXTRA_PIECES', ref: null, words: { en: 'Scrap 2', it: 'Scarta 2' }, since: '2026-11-17T13:02:00Z', waitingOn: 'CUSTOMER', mayAct: false, requestId: null }
    const withStill = orderWaitingOf({ openApprovals: [], amendments }, page(readWith([], { on: 'US', since: '2026-11-14T17:00:00Z' }, [still]), null), 'en')
    if (withStill.status !== 'ready') throw new Error('ready')
    expect(withStill.card.nothing).toBe(false)
    expect(changesBadgeOf(withStill.card)).toBe(1)
  })

  it('walk #3: before the production read is in, nothing is claimed (loading); a failed read says so; never "Nothing waits"', () => {
    expect(orderWaitingOf({ openApprovals: [], amendments }, page({ status: 'loading' }), 'en')).toEqual({ status: 'loading' })
    expect(orderWaitingOf({ openApprovals: [], amendments }, page({ status: 'failed', problem: 'problem.read.unavailable' }), 'en')).toEqual({ status: 'failed', problem: 'problem.read.unavailable' })
    for (const id of ['overview-loading', 'overview-failed', 'f-op-301-reading-changes']) {
      for (const locale of ['en', 'it'] as const) {
        const text = textOf(draw(id, locale))
        for (const nothing of locale === 'en' ? ['Nothing waits on us or on the customer', 'Nothing waits on us', 'Nothing waits on the customer'] : ['Niente aspetta noi o il cliente']) expect(text, `${id} ${locale}`).not.toContain(nothing)
      }
    }
    expect(textOf(draw('overview-loading'))).toContain('Loading Requests & changes')
    expect(textOf(draw('f-op-301-reading-changes'))).toContain('Loading Waiting on the customer')
  })

  // F-OO-202: rewritten — the cards and the Changes tab list the request rows (the two gates went to Next dates): 1 + 1 on both pages.
  it('the pages agree: Overview says 1 + 1, the Changes tab lists the same request and the yes we asked; SO-0003\'s header says nothing waits', () => {
    const overview = textOf(draw('f-op-301-so2-overview'))
    // F-OO-204: the groups' heads in the Changes tab's words ("Waiting on us · 1").
    expect(overview).toContain('Waiting on us · 1')
    expect(overview).toContain('Waiting on Moto Demo S.r.l. · 1')
    expect(overview).not.toContain('Waiting on us · 3')
    // F-OO-205 (lead note, W03): the design case has SO-0002's step still to do — the card's head says the badge's real 3.
    expect(overview).toContain('Still to do · 1')
    expect(overview).toContain('Changes (3) ›')
    const changes = textOf(draw('f-op-301-so2-changes'))
    expect(changes.split('1 waiting').length - 1).toBe(2)
    expect(changes).not.toContain('3 waiting')
    expect(changes).not.toContain('A gate is not passed yet')
    expect(changes).toContain("Waiting for the customer's yes")
    expect(changes).not.toContain('Nothing waits on the customer')
    expect(changes).not.toContain('Nothing waits on us')
    // On Changes no row has a door back to Changes itself.
    expect(changes).not.toContain('Changes ›')
    const so3 = textOf(draw('f-op-301-so3-overview')).replace(/\s+/g, ' ')
    // F-OO-103: rewritten — section 1 names no wait any more, so the kept "Waiting on us · 5 d" is said nowhere; the card says its own
    // words once (it was twice: Who acts next and the card).
    expect(so3).not.toContain('Who acts next')
    expect(so3).not.toContain('Waiting on us · 5 d')
    // F-OO-205: the card's empty words are "No request or change waits" (never "Nothing waits": a hold or a date may).
    expect(so3.split('No request or change waits').length - 1).toBe(1)
    expect(so3).not.toContain('Nothing waits')
    // The badge and the dot read the same call (no second rule in the page).
    const page = readFileSync(new URL('../view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(page).toContain('const waiting = orderWaitingOf(order, model, locale)')
    const section = readFileSync(new URL('../view/RequestsSection.tsx', import.meta.url), 'utf8')
    expect(section).toContain('const waiting = orderWaitingOf(order, model, locale)')
    expect(section).not.toContain('waitingOnCustomerOf')
  })
})
// ---- end F-OP-301

// ---- F-OP-302 (walk #4, #20): Progress by line — the line's pills never run over the Ordered number, never cut on a phone ---------
describe('F-OP-302: Progress by line — the line column has room and its pills wrap on their own row', () => {
  it('the line gets a third of the fixed-layout table; its pills sit outside the one-line sub (cut at 375, over "Ordered" at 1440)', () => {
    for (const id of ['overview', 'overview-confirmed']) {
      const html = draw(id)
      expect(html, id).toContain('style="width:34%"')
      expect(html, id).not.toMatch(/class="fw-so-cell-sub"[^>]*>[^<]*<span class="nds-tag/)
    }
    const confirmed = draw('overview-confirmed')
    // F-OO-121: a pill in the line cell keeps its words in its title (one line; the line's window shows them whole).
    expect(confirmed).toMatch(/<span class="fw-so-inline"><span class="nds-tag[^"]*"[^>]*>Not in work orders yet<\/span>/)
  })
})
// ---- end F-OP-302

// ---- F-OP-304 (walk #7): Changes › Still to do never says "Nothing left to do" above rows ------------------------------------------
describe('F-OP-304: Still to do — "Nothing left to do" only when nothing stands and nothing was made extra', () => {
  it('pieces made extra with no step left: their own heading and list, no "Nothing left to do"; nothing at all: the empty words', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(draw('f-op-304-still-extra', locale))
      expect(text).not.toContain(locale === 'en' ? 'Nothing left to do for the accepted changes.' : 'Per le modifiche accettate non resta nulla da fare.')
      expect(text).toContain(locale === 'en' ? 'Made extra' : 'Fatti in più')
      // F-OO-121: the API's words since B-OO-015 (the floor holds a cut order's planned lines too).
      expect(text).toContain(locale === 'en' ? 'Line 10 · 1 48 more than ordered: cut or planned to cut' : "Riga 10 · 1 48 in più dell'ordine: tagliati o da tagliare")
    }
    // F-OO-205: SO-0002's case has its step still to do now; the case with nothing left is the Changes tab with no request waiting.
    expect(textOf(draw('f-oo-204-changes-nothing'))).toContain('Nothing left to do for the accepted changes.')
  })
})
// ---- end F-OP-304

// ---- F-OP-306 (walk #21): invoices for a reader without invoices.view — one rule and one wording on Money and Overview -----------
describe('F-OP-306: no invoice row and no invoice number without invoices.view; the Money tab\'s one sentence in both places', () => {
  it('Money lists no invoice and says the sentence; Overview › Linked records says the same sentence alone; the Money badge counts deposits only', async () => {
    const { tabCountOf } = await import('../../model')
    for (const locale of ['en', 'it'] as const) {
      const sentence = locale === 'en' ? 'Invoices are shown to people who see invoices.' : 'Le fatture sono visibili a chi vede le fatture.'
      const moneyHtml = draw('w2a-margin-no-grain', locale)
      expect(textOf(moneyHtml)).toContain(sentence)
      expect(moneyHtml).not.toContain('id="about-Invoice-') // no invoice row
      const overview = textOf(draw('f-op-301-so2-overview', locale)).replace(/\s+/g, ' ')
      expect(overview).toContain(sentence)
      expect(overview).not.toMatch(/needs the invoices right|serve il permesso fatture/)
    }
    // Who sees invoices still sees their rows and their count.
    const finance = draw('w2a-margin')
    expect(textOf(finance)).not.toContain('Invoices are shown to people who see invoices.')
    expect(finance).toContain('id="about-Invoice-')
    // F-OO-206 (Owner D8): the chain by the one rule (no badges) — SO-2026-0088 shipped: 2 issued invoices, its deposit paid; one more
    // request still open (the balance before shipping) is the only number a reader without invoices.view gets.
    const shipped = order('SHIPPED')
    const asked = { ...shipped, chain: { ...shipped.chain, depositRequests: [...shipped.chain.depositRequests, { ...shipped.chain.depositRequests[0]!, id: '0190f0e2-3131-7000-8000-000000000009', status: 'OPEN' as const, stepKind: 'BEFORE_SHIPPING' as const }] } }
    expect(tabCountOf('money', asked, { viewInvoices: false })).toBe(1)
    expect(tabCountOf('money', asked, { viewInvoices: true })).toBe(3)
    expect(tabCountOf('money', shipped, { viewInvoices: false })).toBe(0)
  })
})
// ---- end F-OP-306

// ---- F-OO-100 (order overview lane): the Overview split by section — a clean move, no behaviour change ---------------------------
describe('F-OO-100: OverviewTab keeps the layout, each card is its own file, each section its own rules; no card fetches', () => {
  it('OverviewTab draws the seven cards in their order, makes the ONE call of the waiting list and keeps the band\'s two parts', () => {
    const tab = read('../view/OverviewTab.tsx')
    const at = CARDS.map((card) => tab.indexOf(`<${card} `))
    expect(at.every((index) => index > 0), at.join(',')).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(tab.match(/orderWaitingOf\(/g)).toHaveLength(1)
    for (const part of ['export function BandHealth(', 'export function BandUrgency(']) expect(tab, part).toContain(part)
    // The page imports the tab and the band's two parts from the same file as before (no order page file changed).
    expect(read('../view/OrderRecordView.tsx')).toContain("import { BandHealth, BandUrgency, OverviewTab } from './OverviewTab'")
  })

  it('no card imports a hook file, the API client or fetch (view-boundaries rule 2); the order page lane\'s markers moved with their cards', () => {
    for (const card of CARDS) {
      const text = read(`../view/overview/${card}.tsx`)
      expect(text, card).not.toMatch(/from '[^']*\/use-[a-z-]+'/)
      expect(text, card).not.toMatch(/from '[^']*\/lib\/api\//)
      expect(text, card).not.toContain('fetch(')
    }
    expect(read('../view/overview/WhereCard.tsx')).toContain('// F-OP-301 (walk #2):')
    expect(read('../view/overview/RequestsCard.tsx')).toContain('// F-OP-301 (walk #3):')
    expect(read('../view/overview/ProgressCard.tsx')).toContain('// F-OP-302 (walk #4):')
    expect(read('../view/overview/LinkedCard.tsx')).toContain('// F-OP-306 (walk #21):')
  })

  it('model.ts keeps what more than one place reads (the ONE waiting list among it); each section\'s rules live in its own file', () => {
    const model = read('./model.ts')
    for (const name of ['export function orderWaitingOf(', 'export function waitingOf(', 'export function healthInputOf(', 'export function bandHealthOf(', 'export const readOf', 'export function mergeRead(', 'export const REQUESTED_FIELD_ID', 'export const say']) expect(model, name).toContain(name)
    // F-OO-202 (F14): "who acts next" left with its only drawing — the keeper's waitingOn is the one rule.
    expect(model).not.toContain('export function whoActsNextOf(')
    // F-OO-103: where.ts keeps the headline and the stages (the facts' rules left with the facts).
    const homes = { where: ['headlineOf', 'stageStripOf'], progress: ['lineRowsOf', 'totalOf', 'lineSizesOf', 'figureFaceOf', 'linePillsOf', 'madeExtraSizesOf'] /* F-OO-121: walkOf and lineStageOf went */, people: ['placeLinesOf' /* F-OO-134: replaces placeWords */], dates: ['nextDatesOf'], linked: ['linkedRowsOf'] /* F-OO-207: the rows by the one count rule */ } as const
    for (const [section, names] of Object.entries(homes)) {
      const text = read(`./${section}.ts`)
      for (const name of names) {
        expect(text, `${section}: ${name}`).toContain(`export function ${name}(`)
        expect(model, `model.ts: ${name}`).not.toContain(`export function ${name}(`)
      }
    }
    expect(read('./facts.ts')).toContain('export const languageOf')
    // The section files read model.ts, never the other way round (one direction, no cycle).
    expect(model).not.toMatch(/from '\.\/(?:where|progress|people|dates|linked|facts)'/)
  })
})
// ---- end F-OO-100

// ---- F-OO-208 (13-backend §14; B-OO-008, B-OO-010, B-OO-013): the read schemas in one step — every new field optional ------------
describe('F-OO-208: the page reads the new fields, and still reads an older answer without them', () => {
  it('production read: who answers the customer and why, a place\'s kind and since, a gate\'s version and moves — with and without', () => {
    // With: each new field is read as the API sends it.
    const read = productionSchema.parse({ ...PRODUCTION_READ, people: PEOPLE, dates: { ...PRODUCTION_READ.dates!, gates: [GATE] } })
    expect(read.people?.answersCustomer).toEqual({ id: PEOPLE.answersCustomer!.id, name: 'Bea Esempio', active: true, source: 'SUPERVISOR' })
    expect(read.people?.places.map((place) => [place.kind, place.since])).toEqual([
      ['PLANT', null],
      ['WORKSHOP', '2026-11-10'],
    ])
    expect(read.dates?.gates[0]).toMatchObject({ version: 3, actions: { pass: { allowed: true, refusal: null }, startBefore: { allowed: false, refusal: { code: 'OWN_GATE' } }, edit: { allowed: true }, remove: { allowed: false, needs: 'planning.milestones.manage' } } })
    // Without (an older answer): the same parts read, the new fields absent — nothing refused, nothing made up.
    const answerer = PEOPLE.answersCustomer!
    const olderPeople = { ...PEOPLE, answersCustomer: { id: answerer.id, name: answerer.name, active: answerer.active }, places: PEOPLE.places.map((place) => ({ site: place.site, line: place.line, team: place.team, workshop: place.workshop })) }
    const people = peopleSchema.parse(olderPeople)
    expect(people.answersCustomer).toEqual({ id: answerer.id, name: 'Bea Esempio', active: true })
    expect(people.places.map((place) => [place.workshop?.name ?? place.site?.code, place.kind, place.since])).toEqual([
      ['STAB-N', undefined, undefined],
      ['Laboratorio Esempio', undefined, undefined],
    ])
    const olderGate = Object.fromEntries(Object.entries(GATE).filter(([key]) => key !== 'version' && key !== 'actions'))
    const dates = datesSchema.parse({ ...PRODUCTION_READ.dates!, gates: [olderGate] })
    expect(dates.gates[0]).toMatchObject({ id: GATE.id, kind: 'PP_SAMPLE', state: 'WAITING' })
    expect([dates.gates[0]!.version, dates.gates[0]!.actions]).toEqual([undefined, undefined])
    expect(productionSchema.safeParse(PRODUCTION_READ).success).toBe(true)
    // The lists are the API's own: an unknown source, place kind or refusal code is not read as something else.
    expect(peopleSchema.safeParse({ ...PEOPLE, answersCustomer: { ...answerer, source: 'SOMEONE' } }).success).toBe(false)
    expect(peopleSchema.safeParse({ ...PEOPLE, places: [{ ...PEOPLE.places[0]!, kind: 'STATION' }] }).success).toBe(false)
    expect(datesSchema.safeParse({ ...PRODUCTION_READ.dates!, gates: [{ ...GATE, actions: { ...GATE.actions!, pass: { allowed: false, refusal: { code: 'NOT_A_CODE', message: 'x' }, needs: null } } }] }).success).toBe(false)
  })

  it('order read: the office note, the Incoterm, its place and ship complete — with and without', () => {
    const fields = orderSchema.pick({ internalNote: true, incoterm: true, incotermPlace: true, shipComplete: true })
    expect(fields.parse({ internalNote: 'Solo ufficio: imballo doppio.', incoterm: 'EXW', incotermPlace: 'Monza', shipComplete: true })).toEqual({ internalNote: 'Solo ufficio: imballo doppio.', incoterm: 'EXW', incotermPlace: 'Monza', shipComplete: true })
    expect(fields.parse({ internalNote: null, incoterm: null, incotermPlace: null, shipComplete: false })).toEqual({ internalNote: null, incoterm: null, incotermPlace: null, shipComplete: false })
    expect(fields.parse({})).toEqual({})
    // A whole older answer (the demo order has none of the four) still parses; a newer one keeps them.
    expect(orderSchema.safeParse(order('IN_PRODUCTION')).success).toBe(true)
    expect(orderSchema.parse({ ...order('IN_PRODUCTION'), internalNote: 'x', incoterm: 'DAP', incotermPlace: null, shipComplete: false })).toMatchObject({ internalNote: 'x', incoterm: 'DAP', incotermPlace: null, shipComplete: false })
    // Optional in the type too: a page that reads them says what is there, and nothing when an older answer lacks them.
    expectTypeOf<Order['incoterm']>().toEqualTypeOf<string | null | undefined>()
    expectTypeOf<Order['shipComplete']>().toEqualTypeOf<boolean | undefined>()
  })
})
// ---- end F-OO-208

// ---- F-OO-201 (review F4: the pairs): sections 1 and 2 full width, then the cards in pairs — one rule at 720 px, a card alone spans -
describe('F-OO-201: the Overview draws two full-width cards, then three pairs; a pair is 2 columns from 720 px, a card alone spans', () => {
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
  /** The element whose opening tag starts at `at` in React's static markup: where it ends, where each direct child starts. */
  const elementAt = (html: string, at: number): { readonly end: number; readonly children: readonly number[] } => {
    const tag = /<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g
    tag.lastIndex = at
    let depth = 0
    const children: number[] = []
    for (let match = tag.exec(html); match; match = tag.exec(html)) {
      const [, closing, name, selfClosing] = match
      if (closing) {
        depth -= 1
        if (depth === 0) return { end: tag.lastIndex, children }
        continue
      }
      if (depth === 1) children.push(match.index)
      if (!VOID.has(name!.toLowerCase()) && !selfClosing) depth += 1
    }
    throw new Error(`the element at ${at} never closes`)
  }
  /** A card's heading (the first `fw-so-h2` inside the element at `at`), as a reader sees it. */
  const headOf = (html: string, at: number): string | null => {
    const match = /<h2 class="fw-so-h2">([^<]*)<\/h2>/.exec(html.slice(at, elementAt(html, at).end))
    return match ? textOf(match[1]!) : null
  }

  it('draws [People, Next dates], [Requests & changes, Linked records], [Order facts] as .fw-so-ov-pair after Where and Progress, in order', () => {
    const want = {
      en: { full: ['Where it is now', 'Progress by line'], pairs: [['People', 'Next dates'], ['Requests & changes', 'Linked records'], ['Order facts']] },
      it: { full: ['A che punto è', 'Avanzamento per riga'], pairs: [['Persone', 'Prossime date'], ['Richieste e modifiche', 'Record collegati'], ["Dati dell'ordine"]] },
    } as const
    for (const locale of ['en', 'it'] as const) {
      const html = draw('overview', locale)
      const root = html.indexOf('<div class="fw-so-overview">')
      expect(root, locale).toBeGreaterThan(-1)
      const children = elementAt(html, root).children
      // Where it is now, Progress by line, then three pairs: nothing else at the Overview's top level.
      expect(children, locale).toHaveLength(5)
      expect(children.slice(0, 2).map((at) => headOf(html, at))).toEqual(want[locale].full)
      const pairs = children.slice(2)
      for (const at of pairs) expect(html.startsWith('<div class="fw-so-ov-pair">', at), locale).toBe(true)
      expect(pairs.map((at) => elementAt(html, at).children.map((card) => headOf(html, card)))).toEqual(want[locale].pairs)
    }
    // The old one-grid wrapper is gone from the page.
    expect(draw('overview')).not.toContain('fw-so-overview-cards')
  })

  it('a card alone in its pair spans the row: Order facts while Custom fields are not in the pair; a pair of two stays two', () => {
    const html = draw('overview')
    const pairs = [...html.matchAll(/<div class="fw-so-ov-pair">/g)].map((match) => match.index!)
    expect(pairs.map((at) => elementAt(html, at).children.length)).toEqual([2, 2, 1])
    expect(read('../view/overview/overview.css')).toMatch(/\.fw-so-ov-pair > :only-child \{\s*grid-column: 1 \/ -1;\s*\}/)
  })

  it('the css: the Overview is the container; 1 column, 2 equal ones from 720 px; the cards stretch; the shared row and the facts\' columns', () => {
    const css = read('../view/overview/overview.css')
    expect(css).toMatch(/\.fw-so-overview \{\s*container: fw-so-ov \/ inline-size;\s*\}/)
    expect(css).toMatch(/\.fw-so-ov-pair \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);\s*align-items: stretch;/)
    expect(css).toMatch(/@container fw-so-ov \(min-width: 720px\) \{\s*\.fw-so-ov-pair \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/)
    // Every card reads its own width: the doors wrap under the words below a 480 px card; Facts and Custom fields go 2 columns from 800 px.
    expect(css).toMatch(/\.fw-so-overview > :not\(\.fw-so-ov-pair\),\s*\.fw-so-ov-pair > \* \{\s*container: fw-so-ov-card \/ inline-size;/)
    expect(css).toMatch(/\.fw-so-ov-row \{\s*display: grid;\s*grid-template-columns: max-content minmax\(0, 1fr\) auto;/)
    expect(css).toMatch(/@container fw-so-ov-card \(max-width: 479px\) \{[^@]*\.fw-so-ov-row > \.fw-so-ov-doors \{\s*grid-column: 1 \/ -1;\s*justify-self: end;/)
    expect(css).toMatch(/@container fw-so-ov-card \(min-width: 800px\) \{\s*\.fw-so-ov-cols \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/)
    // Tokens only (no raw colour, no new size outside the scale).
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    const tab = read('../view/OverviewTab.tsx')
    expect(tab).toContain("import './overview/overview.css'")
    expect(tab).not.toContain('fw-so-overview-cards')
    // orders.css lost only the old grid rule (the order page lane's file: nothing else of it changed).
    const orders = read('../../orders.css')
    expect(orders).not.toMatch(/\.fw-so-overview-cards \{/)
    for (const kept of ['.fw-so-overview {', '.fw-so-datelist {']) expect(orders, kept).toContain(kept)
    // F-OO-207: Linked records' count chips left with their card's rows (record/view/overview/linked.css).
    for (const gone of ['.fw-so-linked {', '.fw-so-countbtn {']) expect(orders, gone).not.toContain(gone)
    // F-OO-103: "Where it is now"'s own rules left it for the card's own file.
    expect(read('../view/overview/where.css')).toContain('.fw-so-where {')
  })
})
// ---- end F-OO-201

// ---- F-OO-211 (11-design §8.1, §8.2): the custom fields are the 7 + 8 pair's second card; with none, Order facts takes the row --------
describe('F-OO-211: Custom fields beside Order facts (order page only); none → Order facts spans the row; Read-only has no Edit', () => {
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
  /** The markup of the element whose opening tag starts at `at`, and where each direct child starts in it. */
  const elementAt = (html: string, at: number): { readonly markup: string; readonly children: readonly number[] } => {
    const tag = /<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g
    tag.lastIndex = at
    let depth = 0
    const children: number[] = []
    for (let match = tag.exec(html); match; match = tag.exec(html)) {
      const [, closing, name, selfClosing] = match
      if (closing) {
        depth -= 1
        if (depth === 0) return { markup: html.slice(at, tag.lastIndex), children }
        continue
      }
      if (depth === 1) children.push(match.index)
      if (!VOID.has(name!.toLowerCase()) && !selfClosing) depth += 1
    }
    throw new Error(`the element at ${at} never closes`)
  }
  /** The Overview's last pair (Order facts and, when given, Custom fields): its cards' text, in order. */
  const lastPair = (html: string) => {
    const at = [...html.matchAll(/<div class="fw-so-ov-pair">/g)].map((match) => match.index!).at(-1)!
    const pair = elementAt(html, at)
    return { cards: pair.children.map((child) => textOf(elementAt(html, child).markup)), markup: pair.markup }
  }

  it('with fields: the third pair holds Order facts then Custom fields (EN + IT); drawn once — never again at the body\'s end', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw('f-oo-211-facts-fields', locale)
      const { cards } = lastPair(html)
      expect(cards, locale).toHaveLength(2)
      expect(cards[0], locale).toContain(locale === 'en' ? 'Order facts' : "Dati dell'ordine")
      expect(cards[1], locale).toContain(locale === 'en' ? 'Custom fields' : 'Campi personalizzati')
      expect(cards[1], locale).toContain(locale === 'en' ? 'Not filled: Box type (required), Fair date' : 'Non compilati: Tipo di scatola (obbligatorio), Data della fiera')
      expect(html.split('fw-cf-card').length - 1, locale).toBe(1)
    }
  })

  it('without fields (none applies, or the reader may not see them): Order facts alone in its pair, spanning the row (the overview case)', () => {
    const html = draw('overview')
    expect(html).not.toContain('fw-cf-card')
    const { cards } = lastPair(html)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toContain('Order facts')
  })

  it('Read-only: the values beside Order facts and no Edit; a closed order holds Edit in words; the order changed first: Save again / Discard mine', () => {
    const readOnly = lastPair(draw('f-oo-211-fields-read-only'))
    expect(readOnly.cards[1]).toContain('Custom fields')
    expect(readOnly.cards[1]).not.toMatch(/\bEdit\b/)
    const closed = lastPair(draw('f-oo-213-closed')).markup
    expect(closed).toMatch(/aria-description="SO-2026-\d{4} is closed or cancelled: its fields no longer change\."/)
    const changed = lastPair(draw('f-oo-213-order-changed')).cards[1]!
    for (const words of ['Someone changed SO-2026-', 'Save again', 'Discard mine']) expect(changed, words).toContain(words)
  })
})
// ---- end F-OO-211

// ---- F-OO-102 (order overview §1.2; review F11): the headline and the dots read ONE state — the overview drawn before, after and without production
describe('F-OO-102: "Where it is now" per state — waiting no dots, shipped every stage done, cancelled where the work had reached', () => {
  const milestones = (html: string, state: string) => html.match(new RegExp(`class="nds-milestone" data-state="${state}"`, 'g'))?.length ?? 0

  it('in production and shipped: the dots and their quiet line ("set by the floor and quality"); shipped is every stage done, none now', () => {
    for (const locale of ['en', 'it'] as const) {
      const setBy = locale === 'en' ? 'Stages are set by the floor and quality, never by hand' : 'Le fasi le segnano il reparto e la qualità, mai a mano'
      const now = draw('overview', locale)
      expect(milestones(now, 'current'), locale).toBe(1)
      expect(textOf(now)).toContain(setBy)
      const shipped = draw('f-oo-102-shipped', locale)
      expect(milestones(shipped, 'done'), locale).toBe(5)
      expect(milestones(shipped, 'current') + milestones(shipped, 'todo'), locale).toBe(0)
      expect(textOf(shipped)).toMatch(locale === 'en' ? /Shipped \d{2}\/\d{2}\/\d{4}/ : /Spedito il \d{2}\/\d{2}\/\d{4}/)
      expect(textOf(shipped)).toContain(setBy)
      // The link never says "now" of a shipped order.
      expect(shipped).toContain(locale === 'en' ? 'aria-label="Open the work orders in Production · every stage done"' : 'aria-label="Apri gli ordini di lavoro in Produzione · tutte le fasi completate"')
    }
  })

  it('waiting for a yes and cancelled: no dots at all (never "Preparing · Now"), the quiet line says why — and no "set by" line', () => {
    for (const locale of ['en', 'it'] as const) {
      const waiting = draw('f-oo-102-waiting', locale)
      expect(waiting, locale).not.toContain('class="nds-milestones')
      expect(textOf(waiting)).toContain(locale === 'en' ? 'Waiting for a yes' : 'In attesa di approvazione')
      expect(textOf(waiting)).toContain(locale === 'en' ? 'Production starts once the order is confirmed' : "La produzione parte quando l'ordine è confermato")
      const cancelled = draw('f-oo-102-cancelled', locale)
      expect(cancelled, locale).not.toContain('class="nds-milestones')
      expect(textOf(cancelled)).toContain(locale === 'en' ? 'Work had reached Cutting when it was cancelled' : 'Il lavoro era arrivato a Taglio quando è stato annullato')
      for (const html of [waiting, cancelled]) expect(textOf(html)).not.toContain(locale === 'en' ? 'Stages are set by the floor' : 'Le fasi le segnano il reparto')
    }
  })
})
// ---- end F-OO-102

// ---- F-OO-103 (order overview §1.1, §1.6; review F8, F14): the section 1 frame — what it keeps, what left and where each lives on ----
describe('F-OO-103: "Where it is now" keeps its title, Live, the headline and the stages; the facts left, each to one other place', () => {
  /** Section 1's own markup: from its card up to the next card's heading (Progress by line). */
  const sectionOne = (html: string): string => {
    const from = html.indexOf('fw-so-where')
    const title = html.indexOf('<h2 class="fw-so-h2">', from)
    return html.slice(from, html.indexOf('<h2 class="fw-so-h2">', title + 1))
  }
  const CASES = ['overview', 'overview-confirmed', 'f-oo-102-waiting', 'f-oo-102-shipped', 'f-oo-102-cancelled', 'f-op-301-so2-overview', 'f-op-301-so3-overview']
  const GONE = {
    en: ['Who acts next', 'Waiting on', 'Nothing waits', 'Ex-factory', 'moved', 'Health', 'At risk', 'On track', 'Urgent', 'In work', 'Bundles in work', 'Work orders are made after the deposit'],
    it: ['Chi deve agire', 'Tocca a', 'Niente aspetta', 'Franco fabbrica', 'spostata', 'A rischio', 'Urgente', 'Fasci in lavorazione', "Gli ordini di lavoro si fanno dopo l'acconto"],
  } as const

  it('design cases: none of the removed facts in section 1 — Who acts next, Ex-factory, Health, Customer · Urgent, In work, the deposit note', () => {
    for (const locale of ['en', 'it'] as const) {
      for (const id of CASES) {
        const html = sectionOne(draw(id, locale))
        expect(html, `${locale} ${id}`).toContain(locale === 'en' ? 'Where it is now' : 'A che punto è')
        const text = textOf(html)
        for (const words of GONE[locale]) expect(text, `${locale} ${id}: ${words}`).not.toContain(words)
        // No facts grid (the DS KeyValue) in section 1 any more.
        expect(html, `${locale} ${id}`).not.toContain('nds-kv')
      }
    }
    // Each fact lives on in ONE other place: the band keeps At risk and the customer's Urgent; Requests & changes says who waits.
    const page = textOf(draw('overview'))
    for (const words of ['At risk', 'Urgent (customer)', 'Waiting on us · 1' /* F-OO-204 */]) expect(page, words).toContain(words)
  })

  it('it keeps the title, "Live · as of", the headline (with its quiet line) and the stages\' one link, in this order', () => {
    const html = sectionOne(draw('overview'))
    const at = ['<h2 class="fw-so-h2">Where it is now</h2>', 'fw-prp-fresh', '<p class="fw-so-headline">In production · Sewing</p>', 'class="fw-prp-strip-go"', 'Stages are set by the floor and quality, never by hand'].map((part) => html.indexOf(part))
    expect(at.every((index) => index >= 0), at.join(',')).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // Waiting for a yes and cancelled keep the title, Live and the headline with its quiet line; there are no dots to link.
    for (const id of ['f-oo-102-waiting', 'f-oo-102-cancelled']) {
      const frame = sectionOne(draw(id))
      expect(frame, id).toContain('fw-prp-fresh')
      expect(frame, id).toMatch(/<p class="fw-so-headline">[^<]+<\/p><p class="fw-so-hint">[^<]+<\/p>/)
      expect(frame, id).not.toContain('fw-prp-strip')
    }
  })

  it('the frame\'s source: a strips slot and a moves slot in place, no fact\'s part left; its own where.css (tokens only, no container of its own)', () => {
    const card = read('../view/overview/WhereCard.tsx')
    const strips = card.indexOf('F-OO-103: the strips slot')
    const stages = card.indexOf('<StageStrip')
    const moves = card.indexOf('F-OO-103: the moves slot')
    expect(strips).toBeGreaterThan(card.indexOf('className="fw-so-headline"'))
    expect(stages).toBeGreaterThan(strips)
    expect(moves).toBeGreaterThan(stages)
    for (const gone of ['KeyValue', 'WaitingOnPill', 'HealthPill', 'exFactoryOf', 'inWorkOf', 'preparingNote', 'whoActsNext', "'overview.fact.", 'board.customerUrgent']) expect(card, gone).not.toContain(gone)
    expect(card).toContain("import './where.css'")
    const css = read('../view/overview/where.css')
    for (const rule of ['.fw-so-where {', '.fw-so-where-said {', '.fw-so-headline {', '.fw-so-where-stages {']) expect(css, rule).toContain(rule)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\bpx\b/)
    expect(css).not.toMatch(/container(?:-type|-name)?:/)
    // so/orders.css lost the card's rules (the order page lane's file: only these lines), and keeps a pointer to where they went.
    const orders = read('../../orders.css')
    expect(orders).not.toMatch(/\.fw-so-where \{|\.fw-so-headline \{/)
    expect(orders).toContain('record/view/overview/where.css')
  })
})
// ---- end F-OO-103

// ---- F-OO-202 (review F15, F14; plan §9; Owner D8): ONE waiting call with places — the domain's map; the card holds requests only ----
describe('F-OO-202: one waiting call, each row in its place — holds to Where it is now, dates to Next dates, requests to the card and the badge', () => {
  const amendments = { count: 0, latestRevision: null, latestAt: null }
  const words = (en: string) => ({ en, it: `${en} (it)` })
  const blocker = (kind: string, on: 'US' | 'BRAND' | 'SUPPLIER' | 'WORKSHOP', since: string | null, ref: { type: string; id: string } | null = null, sub: 'REQUEST' | 'COUNTER' | 'PROBLEM' | 'REPROMISE' | null = null) => ({ kind, on, words: words(kind), since, ref, sub })
  const task = (kind: string, taskId: string, requestedAt: string) =>
    ({ taskId, kind, kindLabel: { en: kind, it: kind }, requestedAt, requester: { name: 'Luca Prova', me: false }, approver: { kind: 'ROLE' as const, name: 'Finance', me: false }, version: 1, requireStepUp: false, approve: { allowed: true, why: null }, reject: { allowed: true, why: null }, withdraw: { allowed: false, why: null } })
  const stateOf = (blockers: ReturnType<typeof blocker>[], approvals: ReturnType<typeof task>[] = [], still: unknown[] = []) => {
    const production = { status: 'ready', read: { ...PRODUCTION_READ, headline: { ...HEADLINE, waiting: { ...HEADLINE.waiting, blockers } }, changes: { openRequests: [], stillToDo: { rows: still, count: still.length, workOrdersLeftOut: 0 } } } } as never
    const state = orderWaitingOf({ openApprovals: approvals, amendments }, { production, requests: { value: [] }, can: { recordPayment: true } }, 'en')
    if (state.status !== 'ready') throw new Error('ready')
    return state
  }

  it('each kind lands in the place the domain gives it — keyed on kind + sub (a refused new date is a date), a yes by its kind; an unknown kind stays a request', async () => {
    const domain = await import('@nexus/factory-domain/production-brand/waiting')
    const blockers = domain.BLOCKER_KINDS.flatMap((kind) => (kind === 'BRAND_REQUEST' ? domain.BLOCKER_SUBS.map((sub) => blocker(kind, 'US', '2026-11-10T09:00:00Z', { type: 'OrderChangeRequest', id: `r-${sub}` }, sub)) : [blocker(kind, domain.BLOCKER_OWNER[kind], '2026-11-10T09:00:00Z', { type: 'Record', id: kind })]))
    const state = stateOf(blockers, domain.ORDER_YES_KINDS.map((kind, index) => task(kind, `t-${index}`, '2026-11-10T09:00:00Z')))
    for (const row of state.rows) {
      const want = row.door.kind === 'yes' ? domain.YES_PLACE[row.door.task.kind as (typeof domain.ORDER_YES_KINDS)[number]] : domain.placeOf({ kind: row.kind as (typeof domain.BLOCKER_KINDS)[number], sub: row.sub as (typeof domain.BLOCKER_SUBS)[number] | null })
      expect(row.place, row.key).toBe(want)
    }
    const placeOfRow = (kind: string, sub: string | null = null) => state.rows.find((row) => row.kind === kind && row.sub === sub)!.place
    // The review's settled map (F3, F15): holds stop the work, dates have a day, requests need an answer.
    for (const kind of ['DEPOSIT', 'BRAND_PAUSE', 'QUALITY_HOLD', 'NONCONFORMANCE', 'RELEASE_CHECK', 'NO_MOVE']) expect(placeOfRow(kind), kind).toBe('HOLD')
    for (const kind of ['GATE', 'MATERIAL_SHORT', 'SUBCONTRACT', 'CUSTOMER_MATERIAL']) expect(placeOfRow(kind), kind).toBe('DATE')
    for (const kind of ['APPROVAL', 'PARTNER_TASK']) expect(placeOfRow(kind), kind).toBe('REQUEST')
    expect(['REQUEST', 'COUNTER', 'PROBLEM', 'REPROMISE'].map((sub) => placeOfRow('BRAND_REQUEST', sub))).toEqual(['REQUEST', 'REQUEST', 'REQUEST', 'DATE'])
    const yes = state.rows.filter((row) => row.kind === 'YES').map((row) => [row.door.kind === 'yes' ? row.door.task.kind : null, row.place])
    expect(yes).toEqual([['SALES_ORDER', 'HOLD'], ['SALES_ORDER_CHANGE', 'REQUEST'], ['CREDIT_OVERRIDE', 'HOLD']])
    // Never hidden: a kind or a yes this page does not know yet is a request (on the card and the badge).
    const unknown = stateOf([blocker('SOMETHING_NEW', 'US', null)], [task('SOME_OTHER_YES', 't-x', '2026-11-11T09:00:00Z')])
    expect(unknown.rows.map((row) => row.place)).toEqual(['REQUEST', 'REQUEST'])
    expect(changesBadgeOf(unknown.card)).toBe(2)
  })

  it('the card holds the request rows only; the holds and the dates are counted apart, never twice — every row in exactly one place', () => {
    const blockers = [
      blocker('BRAND_REQUEST', 'US', '2026-11-18T09:00:00Z', { type: 'OrderChangeRequest', id: 'r-open' }, 'REQUEST'),
      blocker('BRAND_REQUEST', 'US', '2026-11-12T09:00:00Z', { type: 'ApprovalRequest', id: 'a-refused' }, 'REPROMISE'),
      blocker('APPROVAL', 'BRAND', '2026-11-14T09:00:00Z', { type: 'ApprovalRequest', id: 'a-1' }),
      blocker('DEPOSIT', 'BRAND', '2026-10-28T15:00:00Z', { type: 'DepositRequest', id: 'd-1' }),
      blocker('BRAND_PAUSE', 'BRAND', '2026-11-13T09:00:00Z', { type: 'WorkOrder', id: 'wo-1' }),
      blocker('BRAND_PAUSE', 'BRAND', '2026-11-13T09:00:00Z', { type: 'WorkOrder', id: 'wo-2' }),
      blocker('QUALITY_HOLD', 'US', '2026-11-11T09:00:00Z', { type: 'WorkOrder', id: 'wo-3' }),
      blocker('GATE', 'US', '2026-11-09T09:00:00Z', { type: 'OrderGate', id: 'g-1' }),
      blocker('MATERIAL_SHORT', 'SUPPLIER', null),
      blocker('SUBCONTRACT', 'WORKSHOP', '2026-11-08T09:00:00Z', { type: 'WorkOrder', id: 'wo-4' }),
    ]
    const still = { kind: 'WORK_ORDER_CHANGE', ref: null, words: { en: 'x', it: 'x' }, since: '2026-11-17T13:02:00Z', waitingOn: 'PLANNER', mayAct: true, requestId: null }
    const state = stateOf(blockers, [task('CREDIT_OVERRIDE', 't-credit', '2026-11-01T09:00:00Z'), task('SALES_ORDER_CHANGE', 't-change', '2026-11-10T08:00:00Z')], [still])
    const keys = (rows: readonly WaitingRow[]) => rows.map((row) => row.key)
    const placed = [...keys(state.card.onUs), ...keys(state.card.onCustomer), ...keys(state.holds), ...keys(state.dates)]
    expect(new Set(placed).size, 'never twice').toBe(placed.length)
    expect([...placed].sort(), 'every row once').toEqual([...keys(state.rows)].sort())
    expect(state.card.onUs.map((row) => [row.kind, row.place])).toEqual([['YES', 'REQUEST'], ['BRAND_REQUEST', 'REQUEST']])
    expect(state.card.onCustomer.map((row) => row.kind)).toEqual(['APPROVAL'])
    // No folding here (F-OO-104 groups the holds into one strip per kind): the customer's pause on two work orders is two rows, oldest first.
    expect(state.holds.map((row) => [row.kind, row.ref?.id ?? null])).toEqual([['DEPOSIT', 'd-1'], ['YES', null], ['QUALITY_HOLD', 'wo-3'], ['BRAND_PAUSE', 'wo-1'], ['BRAND_PAUSE', 'wo-2']])
    expect(state.dates.map((row) => [row.kind, row.sub])).toEqual([['SUBCONTRACT', null], ['GATE', null], ['BRAND_REQUEST', 'REPROMISE'], ['MATERIAL_SHORT', null]])
    // changesBadgeOf = request rows + Still to do: 2 on us + 1 on the customer + 1 still (the credit yes, the holds and the dates are not in it).
    expect(changesBadgeOf(state.card)).toBe(4)
    // The Changes dot no longer lights for a credit yes this reader decides (it sits with the holds, section 1); an old change's yes still does.
    expect(state.card.onUs.some((row) => row.door.kind === 'yes' && row.door.task.kind === 'CREDIT_OVERRIDE')).toBe(false)
    expect(changesDotOf(stateOf([], [task('CREDIT_OVERRIDE', 't-credit', '2026-11-01T09:00:00Z')]).card)).toBe(false)
    expect(changesDotOf(stateOf([], [task('SALES_ORDER_CHANGE', 't-change', '2026-11-10T08:00:00Z')]).card)).toBe(true)
    // After production only the requests stay in the read (B-OO-007); the same call then has no hold and no date to hand out.
    const shipped = stateOf(blockers.filter((row) => row.kind === 'BRAND_REQUEST' && row.sub === 'REQUEST'))
    expect([shipped.holds, shipped.dates, shipped.card.onUs.map((row) => row.kind)]).toEqual([[], [], ['BRAND_REQUEST']])
  })

  it('source: no whoActsNextOf and no `next` left; the places come from the domain (no web map); the badge, the tab and the cards call it unchanged', () => {
    const model = read('./model.ts')
    for (const gone of ['whoActsNextOf(', 'interface WhoActsNext', 'next: WhoActsNext', 'REQUEST_KINDS']) expect(model, gone).not.toContain(gone)
    expect(model).toContain("from '@nexus/factory-domain/production-brand/waiting'")
    expect(model).toMatch(/placeOf\(\{ kind: blocker\.kind as BlockerKind, sub: blocker\.sub \?\? null \}\)/)
    expect(model).toContain('YES_PLACE[kind as OrderYesKind]')
    // No place is written by hand in the web: no `GATE: 'DATE'`-like map of its own.
    expect(model).not.toMatch(/\b[A-Z_]+:\s*'(?:HOLD|DATE|REQUEST)'/)
    // The keeper's waitingOn stays the ONE rule of who the order waits on (the orders list and the portal read it); the web never copies it.
    const domain = readFileSync(new URL('../../../../../../../../packages/factory-domain/src/production-brand/waiting.ts', import.meta.url), 'utf8')
    expect(domain).toContain('export function waitingOn(blockers: readonly Blocker[]): Waiting {')
    expect(model).not.toContain('waitingOn(')
    // OrderRecordView (the badge and the dot), RequestsSection (the Changes tab) and OverviewTab (the cards) make the same call as before.
    for (const file of ['../view/OrderRecordView.tsx', '../view/RequestsSection.tsx', '../view/OverviewTab.tsx']) expect(read(file), file).toContain('const waiting = orderWaitingOf(order, model, locale)')
    for (const file of ['../view/OrderRecordView.tsx', '../view/RequestsSection.tsx', '../view/OverviewTab.tsx', '../view/overview/WhereCard.tsx', '../view/overview/RequestsCard.tsx']) expect(read(file), file).not.toMatch(/waiting\.next\b|whoActsNext/)
  })
})
// ---- end F-OO-202

// ---- F-OO-204 (order overview §5.2, §5.3; review F6): the request rows and their doors — the age, the words, Open…, Their turn ----
describe('F-OO-204: request rows — the age, the words of §5.2, Open… on our counter-offer, Their turn for what we asked; one Still to do door', () => {
  const orderOf = (record: OrderRecordModel): Order => (record.order as { status: 'ready'; value: Order }).value
  const stateOf = (record: OrderRecordModel, locale: 'en' | 'it' = 'en') => {
    const state = orderWaitingOf(orderOf(record), record, locale)
    if (state.status !== 'ready') throw new Error('ready')
    return state
  }
  /** One row drawn alone, as Overview's card draws it (or Changes'). */
  const drawRow = (record: OrderRecordModel, row: WaitingRow, locale: 'en' | 'it' = 'en', more: { here?: 'changes'; readOnly?: boolean } = {}) => render(createElement('ul', null, createElement(WaitingRowItem, { row, order: orderOf(record), model: record, ...more })), locale)
  /** The list item that holds these words, as drawn. */
  const itemOf = (html: string, words: string): string => {
    const at = html.indexOf(words)
    if (at < 0) throw new Error(`not drawn: ${words}`)
    return html.slice(html.lastIndexOf('<li', at), html.indexOf('</li>', at))
  }

  it('the age: counted to the read that listed the row ("15 d"), the shortest for a start after it, "—" without a start; no read: to now', () => {
    expect(rowAgeOf('2026-11-03T09:00:00Z', '2026-11-18T09:42:00Z')).toEqual({ key: 'parts.age.days', params: { count: 15 } })
    expect(rowAgeOf('2026-11-18T05:42:00Z', '2026-11-18T09:42:00Z')).toEqual({ key: 'parts.age.hours', params: { count: 4 } })
    expect(rowAgeOf('2026-11-18T09:12:00Z', '2026-11-18T09:42:00Z')).toEqual({ key: 'parts.age.minutes', params: { count: 30 } })
    expect(rowAgeOf('2026-11-18T10:00:00Z', '2026-11-18T09:42:00Z')).toEqual({ key: 'parts.age.minutes', params: { count: 1 } })
    expect(rowAgeOf(null, '2026-11-18T09:42:00Z')).toBeNull()
    expect(rowAgeOf('2026-11-16T09:42:00Z', null, Date.parse('2026-11-18T09:42:00Z'))).toEqual({ key: 'parts.age.days', params: { count: 2 } })
  })

  it('the words of §5.2: a request said whole, the agreed counter-offer and our open one name it (never the fee); the holds are not rows here', () => {
    const { record } = requestsWorld('sales', 'overview')
    const state = stateOf(record)
    expect(state.card.onUs.map((row) => [row.kind, row.sub])).toEqual([['BRAND_REQUEST', 'REQUEST'], ['BRAND_REQUEST', 'COUNTER'], ['BRAND_REQUEST', 'PROBLEM']])
    expect(state.card.onCustomer.map((row) => [row.kind, row.door.kind])).toEqual([['APPROVAL', 'their'], ['APPROVAL', 'their'], ['APPROVAL', 'open'], ['PARTNER_TASK', 'their'], ['APPROVAL', 'their']])
    const counter = state.card.onCustomer.find((row) => row.door.kind === 'open')!
    expect(counter.door).toMatchObject({ kind: 'open', requestId: RQ_COUNTERED.id, request: { id: RQ_COUNTERED.id } })
    expect(counter.words).toEqual({ kind: 'phrase', phrase: { key: 'waiting.counterOpen' }, requestKind: 'CHANGE' })
    const want = {
      en: ['Moto Demo S.r.l. asks: Change · line 10 · M 40 → 36', 'Moto Demo S.r.l. agreed to your counter-offer: Change · line 10 · L 30 → 32', 'Our counter-offer: Change · line 20 · L 2 → 3'],
      it: ['Moto Demo S.r.l. chiede: Modifica · riga 10 · M 40 → 36', 'Moto Demo S.r.l. ha accettato la tua controproposta: Modifica · riga 10 · L 30 → 32', 'La nostra controproposta: Modifica · riga 20 · L 2 → 3'],
    } as const
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      const p = createTranslator(locale, messagesFor(locale, ['production']).production!)
      const say = { t, kindWords: (kind: string) => p(`parts.request.kind.${kind}`), locale, customer: 'Moto Demo S.r.l.', askWords: (request: typeof RQ_ASK) => askWordsOf(request, { kind: p(`parts.request.kind.${request.kind}`), say: t, day: String }) }
      const rows = stateOf(record, locale).card
      expect([rows.onUs[0]!, rows.onUs[1]!, rows.onCustomer[2]!].map((row) => rowWordsOf(row, say)), locale).toEqual(want[locale])
      // A priced counter-offer says the same words: the fee is never on the row (the review window shows it to who may see prices).
      const priced = { ...counter, door: { kind: 'open' as const, requestId: RQ_COUNTERED.id, request: { ...RQ_COUNTERED, counter: { ...RQ_COUNTERED.counter!, fee: 12000, priced: true } } } }
      expect(rowWordsOf(priced, say)).toBe(want[locale][2])
      // Without askWords (a reader of the list alone) the kind is said, as before.
      expect(rowWordsOf(rows.onUs[0]!, { ...say, askWords: undefined })).toBe(locale === 'en' ? 'Moto Demo S.r.l. asks: Change' : 'Moto Demo S.r.l. chiede: Modifica')
    }
    // The customer's pause on two work orders and the quality hold are Where it is now's (one strip per kind there): no row on this card.
    expect(state.holds.map((row) => row.kind)).toEqual(['BRAND_PAUSE', 'BRAND_PAUSE', 'QUALITY_HOLD'])
    expect([...state.card.onUs, ...state.card.onCustomer].some((row) => row.place !== 'REQUEST')).toBe(false)
  })

  it('Overview\'s row: words | age | door — Answer… and Open… are real links to the ONE review window; what we asked says "Their turn", no button', () => {
    const { record } = requestsWorld('sales', 'overview')
    const state = stateOf(record)
    const ask = drawRow(record, state.card.onUs[0]!)
    expect(ask).toContain('<li class="fw-so-ov-row fw-so-rq-row">')
    expect(textOf(ask)).toContain('Moto Demo S.r.l. asks: Change · line 10 · M 40 → 36')
    // (the attribute's spelling is React's: matched without case)
    expect(ask).toMatch(/<time class="fw-so-rq-age" datetime="2026-11-03T09:00:00Z" title="since [^"]+">15 d<\/time>/i)
    expect(ask).toMatch(new RegExp(`<a [^>]*href="[^"]*\\?tab=changes&amp;open=${RQ_ASK.id}"[^>]*>Answer…</a>`))
    const counter = drawRow(record, state.card.onCustomer.find((row) => row.door.kind === 'open')!)
    expect(textOf(counter)).toContain('Our counter-offer: Change · line 20 · L 2 → 3')
    expect(textOf(counter)).toContain('5 d')
    expect(counter).toMatch(new RegExp(`<a [^>]*href="[^"]*\\?tab=changes&amp;open=${RQ_COUNTERED.id}"[^>]*>Open…</a>`))
    for (const locale of ['en', 'it'] as const) {
      const artwork = drawRow(record, state.card.onCustomer[0]!, locale)
      expect(textOf(artwork)).toContain(`${RQ_ASKED[0]!.question} · ${locale === 'en' ? 'due' : 'entro il'} `)
      expect(textOf(artwork)).toContain(locale === 'en' ? 'Their turn' : 'Tocca a loro')
      expect(artwork).not.toContain('<button')
      expect(artwork).not.toContain('<a ')
      // A task on the customer's portal: the API's words, Their turn.
      const task = textOf(drawRow(record, state.card.onCustomer.find((row) => row.kind === 'PARTNER_TASK')!, locale))
      expect(task).toContain(locale === 'en' ? "An open task on the customer's portal" : 'Un compito aperto nel portale del cliente')
      expect(task).toContain(locale === 'en' ? 'Their turn' : 'Tocca a loro')
    }
    // Read-only: the words and the age, never a door (Their turn is words, so it stays).
    for (const row of [...state.card.onUs, ...state.card.onCustomer]) {
      const html = drawRow(record, row, 'en', { readOnly: true })
      expect(html, row.key).not.toContain('<button')
      expect(html, row.key).not.toContain('nds-btn')
    }
  })

  it('Changes: the head\'s quiet line; our counter-offer in the card\'s words with Open…; what we asked with its due day and state, no button', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw('f-oo-204-changes', locale)
      const text = textOf(html)
      expect(text).toContain(locale === 'en' ? 'Holds are on Overview · dates are in Next dates' : 'I blocchi sono in Panoramica · le date in Prossime date')
      expect(text).toContain(locale === 'en' ? 'Our counter-offer: Change · line 20 · L 2 → 3' : 'La nostra controproposta: Modifica · riga 20 · L 2 → 3')
      expect(text).not.toMatch(/Counter-offer sent|Controproposta inviata/)
      // What we asked: its own question, its due day and its state (the record-approvals' words) — and no door on Changes.
      const artwork = itemOf(html, RQ_ASKED[0]!.question)
      expect(textOf(artwork)).toContain(locale === 'en' ? 'Waiting for the answer' : 'In attesa di risposta')
      expect(artwork).not.toContain('<button')
      expect(artwork).not.toContain('<a ')
      // Their turn is the card's word: the Changes tab says it with its list's own title ("Waiting on the customer").
      expect(text).not.toContain(locale === 'en' ? 'Their turn' : 'Tocca a loro')
      // Still to do keeps its state pill on Changes (the card leaves it out).
      expect(text).toContain(locale === 'en' ? 'Waiting for planning' : 'Aspetta la pianificazione')
    }
    expect(draw('f-oo-204-changes')).toMatch(new RegExp(`<a [^>]*href="[^"]*\\?tab=changes&amp;open=${RQ_COUNTERED.id}"[^>]*>Open…</a>`))
    // The head line comes first, before the two lists.
    const html = draw('f-oo-204-changes')
    expect(html.indexOf('Holds are on Overview')).toBeLessThan(html.indexOf('<h2 class="fw-so-h2">Waiting on us</h2>'))
  })

  it('Changes with no request waiting: "No request waits on …" (never "Nothing waits": a hold and a gate wait, on Overview)', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(draw('f-oo-204-changes-nothing', locale))
      for (const words of locale === 'en' ? ['No request waits on us', 'No request waits on the customer', 'Holds are on Overview · dates are in Next dates'] : ['Nessuna richiesta aspetta noi', 'Nessuna richiesta aspetta il cliente', 'I blocchi sono in Panoramica']) expect(text, words).toContain(words)
      expect(text).not.toMatch(/Nothing waits|Niente aspetta/)
    }
  })

  it('one copy of the Still to do door (Changes\' rows and Overview\'s card); the words exist in both languages', () => {
    const section = read('../view/RequestsSection.tsx')
    expect(section).toContain('export function StillDoorView(')
    expect(section.match(/stillDoorsOf\(/g)).toHaveLength(1)
    const stillRow = section.slice(section.indexOf('export function StillRow('), section.indexOf('export function StillDoorView('))
    expect(stillRow).toContain('<StillDoorView row={row} order={order} model={model} actions={actions} />')
    expect(stillRow).not.toContain("door.kind === 'change'")
    // The rows' tab doors never point at Changes any more (what waits on the customer has its own door).
    expect(read('./model.ts')).not.toContain("tab: 'changes'")
    for (const locale of LOCALES) {
      const words = messagesFor(locale, ['orders']).orders!
      for (const key of ['waiting.counterOpen', 'waiting.open', 'waiting.theirTurn', 'requests.changesNote', 'waiting.counterAgreed', 'waiting.counterLapsed', 'waiting.onUs_one', 'waiting.onCustomer_other']) expect(words[key]?.trim(), `${locale} ${key}`).toBeTruthy()
      expect(words['changes.onUs.countered'], locale).toBeUndefined()
    }
    const en = messagesFor('en', ['orders']).orders!
    const it = messagesFor('it', ['orders']).orders!
    expect([en['waiting.theirTurn'], it['waiting.theirTurn']]).toEqual(['Their turn', 'Tocca a loro'])
    expect([en['waiting.onUs_other'], it['waiting.onUs_other']]).toEqual(['Waiting on us · {count}', 'Tocca a noi · {count}'])
    for (const key of ['waiting.counterOpen', 'waiting.counterAgreed', 'waiting.counterLapsed', 'waiting.onCustomer_one']) expect(it[key]!.match(/\{\w+\}/g)?.sort(), key).toEqual(en[key]!.match(/\{\w+\}/g)?.sort())
  })
})
// ---- end F-OO-204

// ---- F-OO-205 (order overview §5.2; review F15): the Requests & changes card — three groups, their counts, the caps, the foot ------
describe('F-OO-205: Requests & changes — Waiting on us · N, Waiting on <customer> · N, Still to do · N; "Changes (N) ›"; the Told line; Read-only', () => {
  /** The card's own markup: from its root up to the next card's heading (Linked records). */
  const cardOf = (html: string): string => {
    const from = html.indexOf('fw-so-rq"')
    if (from < 0) throw new Error('no Requests & changes card')
    const title = html.indexOf('<h2 class="fw-so-h2">', from)
    const next = html.indexOf('<h2 class="fw-so-h2">', title + 1)
    return html.slice(from, next < 0 ? undefined : next)
  }
  const WORDS = {
    en: ['Requests & changes', 'Changes (12) ›', 'Waiting on us · 3', 'Moto Demo S.r.l. asks: Change · line 10 · M 40 → 36', '15 d', 'Moto Demo S.r.l. agreed to your counter-offer: Change · line 10 · L 30 → 32', 'Moto Demo S.r.l. reported a problem', 'Waiting on Moto Demo S.r.l. · 5', 'Our counter-offer: Change · line 20 · L 2 → 3', 'Their turn', '2 more on Changes ›', 'Still to do · 4', 'WO-00021: make 54 → 0 · Planning', '4 d', '1 more on Changes ›', 'Told about changes: 4 people'],
    it: ['Richieste e modifiche', 'Modifiche (12) ›', 'Tocca a noi · 3', 'Moto Demo S.r.l. chiede: Modifica · riga 10 · M 40 → 36', '15 g', 'Moto Demo S.r.l. ha accettato la tua controproposta: Modifica · riga 10 · L 30 → 32', 'Moto Demo S.r.l. ha segnalato un problema', 'Tocca a Moto Demo S.r.l. · 5', 'La nostra controproposta: Modifica · riga 20 · L 2 → 3', 'Tocca a loro', 'Altri 2 in Modifiche ›', 'Ancora da fare · 4', 'WO-00021: produci 54 → 0 · Pianificazione', '4 g', '1 altro in Modifiche ›', 'Avvisati delle modifiche: 4 persone'],
  } as const

  it('draws EN + IT: the three groups with their counts, every row on us, 3 of the customer\'s and of Still to do, then "N more on Changes ›"', () => {
    for (const locale of ['en', 'it'] as const) {
      const card = cardOf(draw('f-oo-205-requests', locale))
      const text = textOf(card)
      for (const words of WORDS[locale]) expect(text, `${locale}: ${words}`).toContain(words)
      // The groups in their order, each its own list of rows.
      const heads = WORDS[locale].filter((words) => /· \d$/.test(words)).map((words) => text.indexOf(words))
      expect([...heads].sort((a, b) => a - b), locale).toEqual(heads)
      expect(card.match(/<ul class="fw-so-rq-list">/g), locale).toHaveLength(3)
    }
    const card = cardOf(draw('f-oo-205-requests'))
    const text = textOf(card)
    // Cut at 3: the task on the portal and the print proof (the customer's 4th and 5th), the collar change (the 4th step) are on Changes.
    for (const words of ["An open task on the customer's portal", RQ_ASKED[2]!.question, 'Change the collar on DEMO-JKT-01']) expect(text, words).not.toContain(words)
    expect(card.match(/<li class="fw-so-ov-row fw-so-rq-row">/g)).toHaveLength(3 + 3 + 3)
    // Every row on us has its door in place: Answer… for the change and the agreed counter-offer, Reply in the thread for the problem.
    expect(text.match(/Answer…/g)).toHaveLength(2)
    expect(text).toContain('Reply in the thread')
    // The links: Changes, and Changes › Still to do for the cut steps.
    expect(card).toMatch(/href="[^"]*\?tab=changes"[^>]*>2 more on Changes ›</)
    expect(card).toMatch(/href="[^"]*\?tab=changes#still-to-do"[^>]*>1 more on Changes ›</)
    // No state pill (Changes' own), no Discuss on a row, no "Latest change", and none of the order's holds (the customer's pause on
    // two work orders is Where it is now's ONE strip).
    for (const gone of ['Waiting for planning', 'Your turn', 'Latest change', 'The customer paused the work', 'A quality hold stops the work', 'A gate is not passed yet']) expect(text, gone).not.toContain(gone)
    expect(card).not.toContain('Discuss')
  })

  it('nothing to answer: "No request or change waits", and where the hold and the date are — never "Nothing waits"', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(cardOf(draw('f-oo-205-nothing', locale)))
      expect(text).toContain(locale === 'en' ? 'No request or change waits' : 'Nessuna richiesta o modifica in attesa')
      expect(text).toContain(locale === 'en' ? 'What holds the order: see Where it is now · Dates that wait: see Next dates' : "Cosa ferma l'ordine: vedi A che punto è · Date in attesa: vedi Prossime date")
      expect(text).toContain(locale === 'en' ? 'Changes (0) ›' : 'Modifiche (0) ›')
      expect(text).not.toMatch(/Nothing waits|Niente aspetta/)
    }
    // Nothing waits at all (SO-0003): the empty words alone, no pointer.
    const so3 = textOf(cardOf(draw('f-op-301-so3-overview')))
    expect(so3).toContain('No request or change waits')
    expect(so3).not.toContain('see Where it is now')
  })

  it('Read-only: the same rows, their ages and Their turn — no <button>, no door', () => {
    for (const locale of ['en', 'it'] as const) {
      const card = cardOf(draw('f-oo-205-read-only', locale))
      expect(card, locale).not.toContain('<button')
      expect(card, locale).not.toContain('nds-btn')
      const text = textOf(card)
      for (const words of locale === 'en' ? ['Waiting on us · 3', '15 d', 'Their turn', 'Still to do · 4', 'Told about changes: 4 people'] : ['Tocca a noi · 3', '15 g', 'Tocca a loro', 'Ancora da fare · 4']) expect(text, words).toContain(words)
    }
    // Who may act sees the doors in the same card (the sales case): held ones too, with their words.
    expect(cardOf(draw('f-oo-205-requests'))).toContain('nds-btn')
  })

  it('source and css: the ONE Still to do door, its own requests.css (the shared row, subgrid, the 480 / 360 rules, tokens only, no container)', () => {
    const card = read('../view/overview/RequestsCard.tsx')
    expect(card).toContain("import './requests.css'")
    expect(card).toContain('<StillDoorView row={row} order={order} model={model} actions={actions} />')
    expect(card).toContain('changesBadgeOf(card)')
    expect(card).toContain("t('told.aboutChanges', { count: told })")
    for (const gone of ['card.latest', 'overview.requests.latest', '<StillRow', 'WithMessages']) expect(card, gone).not.toContain(gone)
    for (const gone of ['readonly latest', 'latestRevision']) expect(read('./model.ts'), gone).not.toContain(gone)
    const css = read('../view/overview/requests.css')
    expect(css).toMatch(/\.fw-so-rq-list \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) max-content auto;/)
    expect(css).toMatch(/\.fw-so-rq-list > \.fw-so-ov-row \{\s*grid-column: 1 \/ -1;\s*grid-template-columns: subgrid;/)
    expect(css).toMatch(/@container fw-so-ov-card \(max-width: 479px\)/)
    expect(css).toMatch(/@container fw-so-ov-card \(max-width: 359px\)/)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    expect(css).not.toContain('container:')
    for (const locale of LOCALES) {
      const words = messagesFor(locale, ['orders']).orders!
      for (const key of ['requests.changesCount', 'requests.more_one', 'requests.more_other', 'requests.seeHolds', 'requests.seeDates', 'overview.requests.nothing', 'overview.requests.still', 'told.aboutChanges_one', 'told.aboutChanges_other']) expect(words[key]?.trim(), `${locale} ${key}`).toBeTruthy()
      for (const key of ['overview.requests.changes', 'overview.requests.latest']) expect(words[key], `${locale} ${key}`).toBeUndefined()
    }
  })
})
// ---- end F-OO-205
