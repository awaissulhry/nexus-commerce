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
import { changesBadgeOf, rowWordsOf, waitingCardOf, waitingOf, whoActsNextOf, type WaitingRow } from './model' // F-OP-103
import { orderWaitingOf } from './model' // F-OP-301

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
  it('in production: the sentence, who acts next, the ex-factory slip, Urgent (customer), the bundles, the stages, "Not counted here"', () => {
    const text = textOf(draw('overview'))
    for (const words of ['Where it is now', 'Sewing · 1 line ahead', 'Waiting on us', 'moved 2×', '+6 d since first promised', 'At risk', 'Urgent (customer)', 'Bundles in work: 3 at Sewing', 'Progress by line', 'Cut and bundled', 'Checked', 'Shipped', 'Not counted here', 'Total · 2 lines', 'Pieces as of']) expect(text, words).toContain(words)
    const it = textOf(draw('overview', 'it'))
    for (const words of ['A che punto è', 'Confezione · 1 riga avanti', 'Avanzamento per riga', 'Tagliati e in fasci', 'Spediti', 'Non contato qui', 'Urgente (cliente)', 'Fasci in lavorazione: 3 a Confezione']) expect(it, words).toContain(words)
    expect(text).not.toMatch(/\b(?:operator|operatore|station|postazione)\b/i)
  })

  it('before any work order: Confirmed · waiting for the deposit, Preparing with why, "Not in work orders yet", "Nothing cut yet"', () => {
    const text = textOf(draw('overview-confirmed'))
    for (const words of ['Confirmed · waiting for the deposit', 'Work orders are made after the deposit', 'Not in work orders yet', 'Nothing cut yet']) expect(text, words).toContain(words)
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
      for (const key of ['tab.overview', 'tab.attention', 'overview.where', 'overview.progress', 'overview.progressHint', 'overview.notInWorkOrders', 'overview.afterDeposit', 'overview.piecesAsOf', 'overview.headline.waitingDeposit', 'overview.headline.shipped', 'overview.headline.delivered', 'overview.fact.who', 'overview.fact.exFactory', 'overview.fact.health', 'overview.fact.customer', 'overview.fact.inWork', 'overview.col.line', 'overview.sizes.label', 'overview.sizes.finish', 'overview.sizes.units', 'overview.sizes.openLines']) expect(t(key), `${locale}: ${key}`).not.toBe(key)
      for (const key of ['overview.ahead', 'overview.bundles', 'overview.total', 'overview.madeExtra', 'mtm.units']) expect(t(key, { count: 2, stage: 'x' }), `${locale}: ${key}`).not.toBe(key)
      const p = createTranslator(locale, messagesFor(locale, ['production']).production!)
      expect(p('parts.pieces.stages.SHIPPED')).not.toBe('parts.pieces.stages.SHIPPED')
    }
  })
})

// ---- F-SA-233: People, Next dates, Requests & changes, Linked records, Order facts ------------------------------------------------
describe('Overview’s facts (F-SA-233)', () => {
  it('requests & changes: the ONE waiting list on us and on the customer (F-OP-103), still to do, the latest amendment', () => {
    const rows = waitingOf(CONFIRMED_READ, { requests: [], approvals: [], recordPayment: false, locale: 'en' })
    expect(waitingCardOf(rows, CONFIRMED_READ, { amendments: { count: 2, latestRevision: 2, latestAt: '2026-11-12T16:48:00Z' } })).toMatchObject({ onUs: [], onCustomer: [{ kind: 'DEPOSIT', on: 'BRAND' }], still: [], latest: { revision: 2, at: '2026-11-12T16:48:00Z' }, nothing: false })
    expect(waitingCardOf([], null, { amendments: { count: 0, latestRevision: null, latestAt: null } })).toEqual({ onUs: [], onCustomer: [], still: [], latest: null, nothing: true })
  })

  it('the cards draw in both languages; the custom fields and the record chain moved to Overview', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(draw('overview', locale))
      // F-OP-103: the case's open request waits on us (the ONE waiting list's row), so "Nothing waits" is not said.
      for (const words of locale === 'en' ? ['People', 'Next dates', 'Requests & changes', 'Linked records', 'Order facts', 'Waiting on us: 1'] : ['Persone', 'Prossime date', 'Richieste e modifiche', 'Record collegati', "Dati dell'ordine", 'In attesa di noi: 1']) expect(text, words).toContain(words)
      expect(text).not.toContain(locale === 'en' ? 'Nothing waits on us or on the customer' : 'Niente aspetta noi o il cliente')
    }
    const container = readFileSync(new URL('../OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain("fields={value && tab === 'overview' ?")
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

  it('every other kind has one door: Changes for what the customer decides, Record the payment (or Money), Production › holds / dates', () => {
    const rows = waitingOf(all, inputs)
    expect(byKind(rows, 'APPROVAL')[0]!.door).toEqual({ kind: 'tab', tab: 'changes', anchor: null })
    expect(byKind(rows, 'PARTNER_TASK')[0]!.door).toEqual({ kind: 'tab', tab: 'changes', anchor: null })
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

  it('oldest first (no known start last); on-us and on-customer counts; who acts next is the card\'s first row', () => {
    const rows = waitingOf(all, { ...inputs, approvals: [yesTask()] })
    const since = rows.map((row) => row.since)
    const known = since.filter((value): value is string => value !== null)
    expect(known).toEqual([...known].sort())
    expect(since.slice(-2)).toEqual([null, null])
    expect(rows[0]).toMatchObject({ kind: 'DEPOSIT', since: '2026-10-28T15:00:00Z' })
    const card = waitingCardOf(rows, null, { amendments: { count: 0, latestRevision: null, latestAt: null } })
    expect(card.onUs.length).toBe(rows.filter((row) => row.on === 'US').length)
    expect(card.onUs.map((row) => row.kind)).toContain('YES')
    expect(card.onCustomer.map((row) => row.kind)).toEqual(['DEPOSIT', 'BRAND_PAUSE', 'APPROVAL', 'PARTNER_TASK'])
    // A supplier's or a workshop's wait is production's: in neither count (Who acts next still names it when it comes first).
    expect([...card.onUs, ...card.onCustomer].some((row) => row.on === 'SUPPLIER' || row.on === 'WORKSHOP')).toBe(false)
    const next = whoActsNextOf(rows, HEADLINE)
    expect(next.row).toBe(rows[0])
    expect(next).toMatchObject({ who: 'BRAND', since: '2026-10-28T15:00:00Z', kind: 'record' })
    expect(whoActsNextOf(waitingOf(headlineWith([]), { ...inputs, approvals: [yesTask()] }), HEADLINE)).toMatchObject({ who: 'US', kind: 'request' })
  })

  it('R-22: the Changes badge counts the card\'s own rows — waiting on us, on the customer, still to do', () => {
    const rows = waitingOf(all, inputs)
    const card = waitingCardOf(rows, { ...PRODUCTION_READ, changes: { openRequests: [], stillToDo: { rows: [{ kind: 'WORK_ORDER_CHANGE', ref: null, words: { en: 'x', it: 'x' }, since: '2026-11-17T13:02:00Z', waitingOn: 'PLANNER', mayAct: true, requestId: null }], count: 1, workOrdersLeftOut: 0 } } }, { amendments: { count: 0, latestRevision: null, latestAt: null } })
    expect(changesBadgeOf(card)).toBe(card.onUs.length + card.onCustomer.length + 1)
    expect(changesBadgeOf(waitingCardOf([], null, { amendments: { count: 0, latestRevision: null, latestAt: null } }))).toBe(0)
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
    // F-OO-100: "Where it is now" is its own file; it reads the state of OverviewTab's one call.
    expect(read('../view/overview/WhereCard.tsx')).toContain("const next = waiting.status === 'ready' ? waiting.next : null")
    // R-21: the dock does not read this list (its pill names the thread).
    const dock = readFileSync(new URL('../dock/OrderDock.tsx', import.meta.url), 'utf8')
    expect(dock).not.toContain('waitingOf(')
  })

  it('the overview case draws the open request\'s row with its door in both languages', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(draw('overview', locale))
      expect(text).toContain(locale === 'en' ? 'Waiting on us: 1' : 'In attesa di noi: 1')
      expect(text).toContain(locale === 'en' ? 'A customer request waits for our answer' : 'Una richiesta del cliente aspetta la nostra risposta')
      expect(text).toContain(locale === 'en' ? 'Changes ›' : 'Modifiche ›')
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
    expect(source).toContain("#line-${row.lineIds[0] ?? row.id}")
    const model = overviewRules() // F-OO-100: model.ts and the section files (linked.ts builds the tab links)
    expect(model).not.toMatch(/`\$\{record\}\?tab=/)
  })

  it('the requested date\'s Change…: edit mode on Lines, its field focused (the container\'s one focus); the field carries the id', async () => {
    const { REQUESTED_FIELD_ID } = await import('./model')
    const acts = readFileSync(new URL('../use-overview-acts.ts', import.meta.url), 'utf8')
    expect(acts).toContain('input.startAmend?.()')
    expect(acts).toContain('input.focus?.(REQUESTED_FIELD_ID)')
    const container = readFileSync(new URL('../OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain('useOverviewActs({ startAmend: () => lines.actions.onAmendStart?.(), focus: (anchor) => setFocusRow({ anchor, at: Date.now() }) })')
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

  it('SO-0002: two gates and a change request wait on us, a yes we asked waits on the customer — 3 + 1 everywhere, the badge 4', () => {
    const waiting = orderWaitingOf({ openApprovals: [], amendments }, page(readWith(SO2_BLOCKERS, { on: 'BRAND', since: '2026-11-05T09:00:00Z' })), 'en')
    if (waiting.status !== 'ready') throw new Error('ready')
    expect(waiting.card.onUs.map((row) => row.kind)).toEqual(['GATE', 'GATE', 'BRAND_REQUEST'])
    expect(waiting.card.onCustomer.map((row) => [row.kind, row.ref])).toEqual([['APPROVAL', { type: 'ApprovalRequest', id: '0190f0e2-6262-7000-8000-000000000001' }]])
    expect(changesBadgeOf(waiting.card)).toBe(4)
    // Who acts next is the card's first row (the oldest gate), its since the card's.
    expect(waiting.next).toMatchObject({ who: 'US', since: '2026-11-02T08:00:00Z', row: waiting.rows[0] })
    // The change request's row opens the review window with the request the page read.
    expect(waiting.card.onUs[2]!.door).toMatchObject({ kind: 'answer', request: { id: '0190f0e2-3080-7000-8000-000000000821' } })
  })

  it('SO-0003: nothing waits — Who acts next says nobody (the card\'s "Nothing waits"), never the kept "Waiting on us · 5 d"', () => {
    const waiting = orderWaitingOf({ openApprovals: [], amendments }, page(readWith([], { on: 'US', since: '2026-11-14T17:00:00Z' }), null), 'en')
    if (waiting.status !== 'ready') throw new Error('ready')
    expect(waiting.card.nothing).toBe(true)
    expect(changesBadgeOf(waiting.card)).toBe(0)
    expect(waiting.next).toEqual({ who: null, since: null, kind: 'record', row: null, still: null })
    // A Still to do row (the card's third list) names who acts when no waiting row stands: ours, or the customer's.
    const still = { kind: 'EXTRA_PIECES', ref: null, words: { en: 'Scrap 2', it: 'Scarta 2' }, since: '2026-11-17T13:02:00Z', waitingOn: 'CUSTOMER', mayAct: false, requestId: null }
    const withStill = orderWaitingOf({ openApprovals: [], amendments }, page(readWith([], { on: 'US', since: '2026-11-14T17:00:00Z' }, [still]), null), 'en')
    if (withStill.status !== 'ready') throw new Error('ready')
    expect(withStill.card.nothing).toBe(false)
    expect(withStill.next).toMatchObject({ who: 'BRAND', since: '2026-11-17T13:02:00Z', still })
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

  it('the pages agree: Overview says 3 + 1, the Changes tab lists the same 3 and the yes we asked; SO-0003\'s header says nothing waits', () => {
    const overview = textOf(draw('f-op-301-so2-overview'))
    expect(overview).toContain('Waiting on us: 3')
    expect(overview).toContain('Waiting on Moto Demo S.r.l.: 1')
    const changes = textOf(draw('f-op-301-so2-changes'))
    expect(changes).toContain('3 waiting')
    expect(changes).toContain('1 waiting')
    expect(changes).toContain('A gate is not passed yet')
    expect(changes).toContain("Waiting for the customer's yes")
    expect(changes).not.toContain('Nothing waits on the customer')
    expect(changes).not.toContain('Nothing waits on us')
    // On Changes no row has a door back to Changes itself.
    expect(changes).not.toContain('Changes ›')
    const so3 = textOf(draw('f-op-301-so3-overview')).replace(/\s+/g, ' ')
    // The header's fact says the card's own words (the kept "Waiting on us · 5 d" is not said); the card says them too.
    expect(so3).toContain('Who acts next Nothing waits on us or on the customer')
    expect(so3.split('Nothing waits on us or on the customer').length - 1).toBe(2)
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
    expect(confirmed).toMatch(/<span class="fw-so-inline"><span class="nds-tag[^"]*">Not in work orders yet<\/span>/)
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
      expect(text).toContain(locale === 'en' ? 'Line 10 · Made extra: 1' : 'Riga 10 · Fatti in più: 1')
    }
    expect(textOf(draw('f-op-301-so2-changes'))).toContain('Nothing left to do for the accepted changes.')
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
    const badged = { ...order('SHIPPED'), badges: { money: { invoices: 2, openDeposits: 1 }, shipments: 4 } }
    expect(tabCountOf('money', badged, { viewInvoices: false })).toBe(1)
    expect(tabCountOf('money', badged, { viewInvoices: true })).toBe(3)
    expect(tabCountOf('money', order('SHIPPED'), { viewInvoices: false })).toBeNull()
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
    for (const name of ['export function orderWaitingOf(', 'export function waitingOf(', 'export function whoActsNextOf(', 'export function healthInputOf(', 'export function bandHealthOf(', 'export const readOf', 'export function mergeRead(', 'export const REQUESTED_FIELD_ID', 'export const say']) expect(model, name).toContain(name)
    const homes = { where: ['headlineOf', 'stageStripOf', 'preparingNote', 'inWorkOf', 'exFactoryOf'], progress: ['lineStageOf', 'lineRowsOf', 'totalOf', 'lineSizesOf', 'walkOf'], people: ['placeWords'], dates: ['nextDatesOf'], linked: ['linkedRecordsOf'] } as const
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
    for (const kept of ['.fw-so-overview {', '.fw-so-where {', '.fw-so-datelist {', '.fw-so-linked {', '.fw-so-countbtn {']) expect(orders, kept).toContain(kept)
  })
})
// ---- end F-OO-201
