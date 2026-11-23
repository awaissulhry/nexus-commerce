import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import type { ApiClient } from '../../../../lib/api/client'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { barFrom, manyHeld, MANY_MAX, NO_ACT, planOf, receiptOf, refusedWords, type ManyRecord, type ManyResult } from './model'
import { quoteBarOf, quoteRecordOf, type QuoteBarRights } from '../../quotes/list/bar'
import { quoteActOf } from '../../quotes/list/acts'
import { ROWS as QUOTE_ROWS } from '../../quotes/list/fixtures'
import type { QuoteListRow } from '../../quotes/api'
import { incomingBarOf, type IncomingRecord } from '../../inquiries/bar'
import { incomingActOf } from '../../inquiries/acts'
import { CATALOGUE_ROW, CHANGE_ROW, ROWS as REQUEST_ROWS } from '../../inquiries/demo/fixtures'
import { incomingRowOf } from '../../inquiries/model'

/**
 * F-CQ-201 … 203 (customer page › Quotes & incoming, 10-design §6, §8; settles C9, C10, C12, C36): the ONE many-acts window (the plan
 * before the click, the receipt that names each record, Run the rest again), the bars per role (an act without its right is NOT drawn;
 * held with words only by the ticked rows' state; ≤ 3 + More ▾), and each loop's "Not on (why)". Pure: no DOM, no API (a made-up client
 * answers the runs).
 */

type Row = ManyRecord & { readonly open: boolean }
const rows: Row[] = [
  { id: 'a', label: 'SEED-QT-0011', href: null, open: true },
  { id: 'b', label: 'SEED-QT-0012', href: null, open: false },
  { id: 'c', label: 'SEED-QT-0013', href: null, open: true },
]
const why = { ns: 'before-order', key: 'acts.why.closed' }

describe('F-CQ-201: the many-acts window — the plan, the hold, the receipt', () => {
  it('the plan says what it runs on and what not, with why beside each — before the click', () => {
    const plan = planOf(rows, { notOn: (row) => (row.open ? null : why) })
    expect(plan.runs.map((row) => row.id)).toEqual(['a', 'c'])
    expect(plan.notOn).toEqual([{ record: rows[1], why }])
  })

  it('held with words: nothing to run on, a text too short or too long, a record\'s field missing, too many', () => {
    const none = planOf(rows, { notOn: () => why })
    expect(manyHeld(none, null, '', {}, null)).toEqual({ ns: 'orders-sheet', key: 'commands.many.nothing' })
    const plan = planOf(rows, { notOn: () => null })
    const text = { label: why, required: true, min: 3, max: 10 }
    expect(manyHeld(plan, text, 'ok', {}, null)).toEqual({ ns: 'before-order', key: 'acts.held.text', params: { min: 3 } })
    expect(manyHeld(plan, text, 'far too long here', {}, null)).toEqual({ ns: 'before-order', key: 'acts.held.long', params: { max: 10 } })
    expect(manyHeld(plan, text, 'fine', {}, null)).toBeNull()
    const field = (row: Row) => (row.id === 'c' ? { label: why, required: true, max: 20 } : null)
    expect(manyHeld(plan, null, '', {}, field)).toEqual({ ns: 'before-order', key: 'acts.held.field', params: { number: 'SEED-QT-0013' } })
    expect(manyHeld(plan, null, '', { c: 'PO-7' }, field)).toBeNull()
    const many = Array.from({ length: MANY_MAX + 1 }, (_, index) => ({ id: `r${index}`, label: `R${index}`, href: null, open: true }))
    expect(manyHeld(planOf(many, { notOn: () => null }), null, '', {}, null)).toEqual({ ns: 'before-order', key: 'acts.held.tooMany', params: { max: MANY_MAX } })
  })

  it('the receipt counts and names: done, not done, the rest to run again', () => {
    const results: ManyResult[] = [
      { id: 'a', label: 'SEED-QT-0011', href: null, done: true, words: { ns: 'before-order', key: 'acts.done.cancelled' } },
      { id: 'c', label: 'SEED-QT-0013', href: null, done: false, words: { ns: 'orders-sheet', key: 'commands.many.stale', params: { number: 'SEED-QT-0013' } } },
    ]
    expect(receiptOf(results)).toEqual({ done: 1, left: 1, rest: ['c'] })
  })

  it('a refusal in words, named by its record (never the API\'s message): changed meanwhile, the state, the right, gone', () => {
    const moved = new ApiError('conflict', 409, 'version_conflict', 'x')
    expect(refusedWords(moved, 'SEED-QT-0011')).toEqual({ ns: 'orders-sheet', key: 'commands.many.stale', params: { number: 'SEED-QT-0011' } })
    const state = new ApiError('conflict', 409, 'invalid_state', 'x')
    expect(refusedWords(state, 'SEED-QT-0011')).toEqual({ ns: 'before-order', key: 'acts.why.state' })
    expect(refusedWords(state, 'SEED-QT-0011', why)).toBe(why)
    expect(refusedWords(new ApiError('forbidden', 403, 'forbidden', 'x'), 'X').key).toBe('acts.why.forbidden')
    expect(refusedWords(new ApiError('not_found', 404, 'not_found', 'x'), 'X').key).toBe('acts.why.gone')
    expect(refusedWords(new Error('boom'), 'X').key).toBe('acts.why.failed')
  })

  it('the hook: one batchId per run, each record with its own version; Run the rest again on fresh rows; nothing runs before the click', () => {
    const hook = readFileSync(new URL('./use-many-act.ts', import.meta.url), 'utf8')
    expect(hook).toContain('const batchId = newBatchId()')
    expect(hook).toContain("now.act.run(record, { text: now.typed, field: now.fields[record.id] ?? '', batchId })")
    expect(hook).toContain('told.current.rowOf?.(id)')
    const view = readFileSync(new URL('./view/ManyActDialog.tsx', import.meta.url), 'utf8')
    expect(view).toContain("key: 'commands.runs'")
    expect(view).toContain("key: 'commands.many.runRest'")
    expect(view).toContain("key: 'commands.many.notDone'")
    expect(view).not.toMatch(/\bdisabled=\{/)
  })
})

describe('F-CQ-201: the bars — never an act for a missing right, held with words by the state, 3 + More ▾', () => {
  // F-CQ-304: + threads.post (Ask / Reply to N) and partners.tasks.manage (the to-do: "Ask"; without it "Reply").
  const OWNER: QuoteBarRights = { can: { manage: true, send: true }, grains: { price: true }, tasks: true, orders: true, threads: true, customerTasks: true }
  const SALES: QuoteBarRights = { can: { manage: true, send: true }, grains: { price: false }, tasks: true, orders: true, threads: true, customerTasks: true }
  const FINANCE: QuoteBarRights = { can: { manage: false, send: false }, grains: { price: true }, tasks: true, orders: false, threads: true, customerTasks: false }
  const READER: QuoteBarRights = { can: { manage: false, send: false }, grains: { price: false }, tasks: false, orders: false, threads: false, customerTasks: false }
  const draft = QUOTE_ROWS.find((row) => row.status === 'DRAFT')!
  const sent = QUOTE_ROWS.find((row) => row.status === 'SENT')!
  const ids = (bar: ReturnType<typeof quoteBarOf>) => [bar.promoted.map((act) => act.id), bar.more.map((act) => act.id)]

  it('quotes: the Owner draws all six (Ask leads; 3 + More ▾); Sales without prices never sees Send a new link (money wall)', () => {
    const owner = quoteBarOf(OWNER, [draft, { ...sent, partyId: draft.partyId }], 'Seed Racing')
    expect(ids(owner)).toEqual([['ask', 'addTask', 'cancel'], ['askApproval', 'makeOrders', 'newLink']])
    expect(owner.promoted[0]!.label).toEqual({ ns: 'before-order', key: 'acts.label.askAbout', params: { customer: 'Seed Racing', count: 2 } })
    expect(ids(quoteBarOf(SALES, [draft, sent], 'Seed Racing'))).toEqual([['ask', 'addTask', 'cancel'], ['askApproval', 'makeOrders']])
  })

  it('F-CQ-304: Ask / Reply to N — "Reply" without the customer\'s to-dos; held in its own words for two customers or more than 50', () => {
    const finance = quoteBarOf(FINANCE, [draft], 'Seed Racing')
    expect(finance.promoted[0]).toMatchObject({ id: 'ask', label: { ns: 'orders-sheet', key: 'bulk.reply', params: { customer: 'Seed Racing', count: 1 } }, held: null })
    const two = quoteBarOf(OWNER, [draft, { ...sent, partyId: 'another-customer' }], null)
    expect(two.promoted[0]!.held).toEqual({ ns: 'orders-sheet', key: 'reply.oneCustomer' })
    const many = Array.from({ length: 51 }, (_, index) => ({ ...draft, id: `q${index}` }))
    expect(quoteBarOf(OWNER, many, 'Seed Racing').promoted[0]!.held).toEqual({ ns: 'orders-sheet', key: 'reply.tooMany', params: { max: 50 } })
  })

  it('quotes: Finance draws only its own (Reply, Add task), the next allowed act moves up; Read-only draws none and the line says so', () => {
    const finance = quoteBarOf(FINANCE, [draft], null)
    expect(ids(finance)).toEqual([['ask', 'addTask'], []])
    expect(finance.note).toBeNull()
    const reader = quoteBarOf(READER, [draft], null)
    expect(ids(reader)).toEqual([[], []])
    expect(reader.note).toBe(NO_ACT)
  })

  it('quotes: held only by the ticked rows\' state, in words (never "Cancel 0" without why)', () => {
    const accepted = QUOTE_ROWS.find((row) => row.status === 'ACCEPTED')!
    const bar = quoteBarOf(OWNER, [accepted], null)
    expect(bar.promoted.find((act) => act.id === 'cancel')!.held).toEqual({ ns: 'before-order', key: 'acts.held.notOpen', params: { count: 1 } })
    expect(bar.more.find((act) => act.id === 'askApproval')!.held).toEqual({ ns: 'before-order', key: 'acts.held.notDraft', params: { count: 1 } }) // F-CQ-304: under More ▾ now
    expect(bar.more.find((act) => act.id === 'newLink')!.held?.key).toBe('acts.held.notSent')
    expect(barFrom([{ id: 'x', right: false, label: why, held: null }], null, NO_ACT).note).toBe(NO_ACT)
  })

  it('incoming: Assign · Ask · Decline, More ▾ Mark lost · Reply · Add task for who answers requests; the production manager none of the sales acts', () => {
    const request = incomingRowOf(REQUEST_ROWS[0]!)
    const owner = incomingBarOf({ manage: true, tasks: true, threads: true }, [request, CATALOGUE_ROW], 'Seed Racing')
    expect([owner.promoted.map((act) => act.id), owner.more.map((act) => act.id)]).toEqual([['assign', 'askInfo', 'decline'], ['lost', 'reply', 'addTask']])
    // F-CQ-304: Reply runs on every ticked row (a request and a portal order alike), in the orders sheet's own words.
    expect(owner.more.find((act) => act.id === 'reply')!.label).toEqual({ ns: 'orders-sheet', key: 'bulk.reply', params: { customer: 'Seed Racing', count: 2 } })
    // A portal order ticked: one line says it is answered one at a time; the counts count the open requests only.
    expect(owner.note).toEqual({ ns: 'before-order', key: 'acts.portalOne', params: { count: 1 } })
    expect(owner.promoted[0]!.label).toEqual({ ns: 'sales-inquiries', key: 'bulk.assign', params: { count: 1 } })
    const production = incomingBarOf({ manage: false, tasks: true, threads: true }, [request], null)
    expect(production.promoted.map((act) => act.id)).toEqual(['reply', 'addTask'])
    expect(production.note).toBeNull()
    expect(incomingBarOf({ manage: false, tasks: false, threads: false }, [request], null).note).toBe(NO_ACT)
    // Only portal orders ticked: the request acts are held with why ("Assign 0" never runs).
    const portals = incomingBarOf({ manage: true, tasks: false, threads: false }, [CATALOGUE_ROW], null)
    expect(portals.promoted[0]!.held).toEqual({ ns: 'before-order', key: 'acts.held.notRequest', params: { count: 1 } })
  })
})

describe('F-CQ-202 / F-CQ-203: each loop says why it does not run on a record (C12, C36)', () => {
  const api = {} as ApiClient
  const day = (date: string) => date
  const quote = (patch: Partial<QuoteListRow>) => quoteRecordOf({ ...QUOTE_ROWS[0]!, ...patch }, '/w/DEMO')
  const waits = (reason: 'NOT_MADE' | 'PO_NUMBER_REQUIRED' | 'ACCOUNT_ON_HOLD' | 'NO_SALES_ORDER_SERIES') => quote({ status: 'ACCEPTED', versionId: 'v-1', order: { state: 'WAITS', id: null, number: null, status: null, reason, words: null } })

  it('Cancel N: a closed quote is never cancelled; a sent one needs a reason', () => {
    const act = quoteActOf('cancel', api, [quote({ status: 'SENT' })], day)
    expect(act.notOn(quote({ status: 'ACCEPTED' }))?.key).toBe('acts.why.quoteClosed')
    expect(act.notOn(quote({ status: 'DRAFT' }))).toBeNull()
    expect(act.text?.([quote({ status: 'SENT' })])?.required).toBe(true)
    expect(act.text?.([quote({ status: 'DRAFT' })])?.required).toBe(false)
  })

  it('Cancel N: a sent quote refused by its state is named a firm offer with its last day (Q4-B3)', async () => {
    const refusing = { post: async () => Promise.reject(new ApiError('conflict', 409, 'invalid_state', 'x')) } as unknown as ApiClient
    const row = quote({ status: 'SENT', validUntil: '2026-11-26' })
    const answer = await quoteActOf('cancel', refusing, [row], day).run(row, { text: 'They changed their mind', field: '', batchId: 'b-1' })
    expect(answer).toEqual({ done: false, why: { ns: 'before-order', key: 'acts.why.firmOffer', params: { date: '2026-11-26' } } })
  })

  it('Make the orders for N: only an accepted quote whose order waits (NOT_MADE); the PO number typed where the terms need one (C36)', () => {
    const act = quoteActOf('makeOrders', api, [waits('NOT_MADE')], day)
    expect(act.notOn(waits('NOT_MADE'))).toBeNull()
    expect(act.notOn(waits('PO_NUMBER_REQUIRED'))).toBeNull()
    expect(act.field?.(waits('PO_NUMBER_REQUIRED'))).toMatchObject({ required: true })
    expect(act.field?.(waits('NOT_MADE'))).toBeNull()
    expect(act.notOn(waits('ACCOUNT_ON_HOLD'))).toEqual({ ns: 'sales', key: 'list.where.orderWaits.ACCOUNT_ON_HOLD' })
    expect(act.notOn(waits('NO_SALES_ORDER_SERIES'))).toEqual({ ns: 'sales', key: 'list.where.orderWaits.NO_SALES_ORDER_SERIES' })
    expect(act.notOn(quote({ status: 'SENT' }))?.key).toBe('acts.why.notAccepted')
    expect(act.notOn({ ...waits('NOT_MADE'), versionId: null })?.key).toBe('acts.why.readAgain')
  })

  it('Ask for approval on N: drafts only; Send a new link to N: sent ones only', () => {
    const ask = quoteActOf('askApproval', api, [quote({ status: 'DRAFT' })], day)
    expect(ask.notOn(quote({ status: 'PENDING_APPROVAL' }))?.key).toBe('acts.why.waitingAlready')
    expect(ask.notOn(quote({ status: 'APPROVED' }))?.key).toBe('acts.why.approvedAlready')
    expect(ask.notOn(quote({ status: 'DRAFT' }))).toBeNull()
    expect(quoteActOf('newLink', api, [], day).notOn(quote({ status: 'DRAFT' }))?.key).toBe('acts.why.notSent')
  })

  it('Mark N lost / Ask about N requests: a portal order is answered on its own; asked already; closed', () => {
    const record = (row: ReturnType<typeof incomingRowOf>): IncomingRecord => ({ ...row, label: row.number, href: null })
    const fresh = record(incomingRowOf({ ...REQUEST_ROWS[0]!, status: 'NEW' }))
    const waiting = record(incomingRowOf({ ...REQUEST_ROWS[0]!, status: 'NEED_INFO' }))
    const closed = record(incomingRowOf({ ...REQUEST_ROWS[0]!, status: 'LOST' }))
    const portal = record(CATALOGUE_ROW)
    const lost = incomingActOf('lost', api, [fresh])
    expect(lost.notOn(fresh)).toBeNull()
    expect(lost.notOn(portal)?.key).toBe('acts.why.portalOwn')
    expect(lost.notOn(closed)?.key).toBe('acts.why.closed')
    expect(lost.text?.([fresh])?.required).toBe(true)
    const ask = incomingActOf('askInfo', api, [fresh])
    expect(ask.notOn(fresh)).toBeNull()
    expect(ask.notOn(waiting)?.key).toBe('acts.why.askedAlready')
    expect(ask.notOn(record(CHANGE_ROW))?.key).toBe('acts.why.askPortal')
    // C2: one request's question starts from the company's words for it (request.need_info); more start empty.
    expect(ask.start).toBeTypeOf('function')
  })
})

describe('F-CQ-201 … 203: the words in both languages (no key left, every placeholder said)', () => {
  it('the acts, the holds, the reasons, the receipts and the task window\'s record nouns', () => {
    for (const locale of LOCALES) {
      const b = createTranslator(locale, messagesFor(locale, ['before-order'])['before-order']!)
      const params = { count: 2, customer: 'Seed Racing', max: 50, min: 3, number: 'SEED-QT-0012', date: '26/11/2026', why: 'x', name: 'Seed Person', rest: 1 }
      const keys = [
        ...['askApproval', 'makeOrders', 'newLink', 'markLost', 'askAbout', 'askAboutAny'].map((key) => `acts.label.${key}`),
        ...['notOpen', 'notDraft', 'noWait', 'notSent', 'notRequest', 'notAskable', 'tooMany', 'text', 'long', 'field'].map((key) => `acts.held.${key}`),
        ...['askApproval', 'makeOrders', 'newLink', 'markLost', 'askInfo'].flatMap((key) => [`acts.title.${key}`, `acts.go.${key}`, `acts.body.${key}`]),
        ...['quoteClosed', 'firmOffer', 'waitingAlready', 'approvedAlready', 'notDraft', 'approvalRefused', 'notAccepted', 'hasOrder', 'readAgain', 'notSent', 'mailFailed', 'portalOwn', 'closed', 'askPortal', 'askedAlready', 'state', 'forbidden', 'gone', 'invalid', 'later', 'failed'].map((key) => `acts.why.${key}`),
        ...['cancelled', 'asked', 'orderMade', 'linkSent', 'lost', 'askedInfo'].map((key) => `acts.done.${key}`),
        'acts.portalOne', 'acts.noAct', 'acts.more', 'acts.moreLabel', 'acts.close', 'acts.back', 'acts.records', 'acts.notOnWhy', 'acts.field.po', 'acts.field.question',
        ...['quote', 'request'].flatMap((noun) => ['title', 'assigneeHint', 'supervisor', 'noSupervisor', 'where', 'held.none', 'held.tooMany', 'made', 'due'].map((key) => `tasks.${noun}.${key}`)),
      ]
      for (const key of keys) {
        const line = b(key, params)
        expect(line, `${locale} ${key}`).not.toBe(key)
        expect(line, `${locale} ${key}`).not.toContain('{')
      }
      expect(b('acts.label.askApproval', params), locale).not.toMatch(/Finance|Amministrazione/)
    }
  })
})
