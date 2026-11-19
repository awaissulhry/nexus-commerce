import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, placeholdersOf } from '../../../../lib/i18n/messages'
import type { TodayItem } from '../../today/model'
import { countsOf, filterRows, heldOf, listedTarget, openIdOf, rowsOf, selectHeld } from '../inbox'
import { acceptBatch, acceptProduction, acceptSales, counterRequest, listWaitingRequests, refuseRequest, type BrandRequest } from './api'
// F-SA-241 / F-SA-242
import { designHeldWords } from '@nexus/factory-domain/sales/change-requests/apply-plan'
import { applyPlanSchema, getApplyPlan } from './api'
// B-SA-046b: which pieces a design change is for.
import { impactSchema } from './api'
import { DESIGN_APPLIES_WORDS } from '@nexus/factory-domain/sales/change-requests/rules'
import { designOptionsOffered, doneCommandsOf, leftToRun, NO_CHOICES, outcomeHeld, planHeld, reachOf, runInOrder, stepStateOf, stillStateOf, stoppable, stoppableOf, tellHeld, tellRefusalOf, tellsNow, tickOn, type TellTick } from './model'
import { brandRequest, REQUEST_FIXTURES } from './fixtures'
import {
  answerHeld,
  answerProblem,
  batchItemsOf,
  batchLinesOf,
  batchRefusalsOf,
  batchResultsOf,
  cardInputOf,
  counterBodyOf,
  counterHeld,
  doneWordsOf,
  EMPTY_COUNTER,
  followUpOf,
  heldFollowUpOf,
  KNOWN_REQUEST_REFUSALS,
  liftHeld,
  noticeFactsOf,
  REQUEST_INBOX_KIND,
  requestGroupsOf,
  requestRefusalOf,
  teamOf,
  waitsForMe,
} from './model'
import { clearRush, liftCustomerPause, probeOpen } from './use-request-review'

/**
 * F-PR-08 — a customer's requests in Home › Approvals (production plan §3, §5; lead picks L4, L26; review fixes R-08, R-23, R-64):
 * the 'Customer request' source (one row per request, one per batch), what the address opens, the answers held with their reason,
 * the routes each kind answers through, a batch re-checked before Accept all, the follow-ups after an accept, the refusals in words.
 * Walls: PW-H01 (the list reads with no customer filter: the API's wall decides), PW-H01b (another customer's request opens the
 * neutral "not found"), PW-12 (a batch is one customer and one kind; a batch answer names only its own requests).
 */

const { RUSH, HOLD, CANCEL, AGREED, BATCH, BATCH_ROWS } = REQUEST_FIXTURES
// F-CP-160: a reader with the price grain (the money wall's hold of a priced counter-offer is tested on its own).
const free = { offline: false, busy: false, price: true }
const notFound = () => new ApiError('not_found', 404, 'not_found', 'Change request not found.', null, [])
const conflict = (path: string) => new ApiError('conflict', 409, 'invalid_state', 'x', null, [{ path, message: 'x' }])

const todayRow = (kind: string, key: string): TodayItem => ({
  key,
  kind,
  state: 'RUSH',
  category: 'APPROVAL',
  severity: 'MEDIUM',
  severityWord: 'Medium',
  group: 'TODAY',
  record: { type: 'SalesOrder', id: 'so-1', label: 'SO-DEMO-0101' },
  companyId: 'c-1',
  siteId: null,
  partyId: null,
  sentence: '',
  why: '',
  blocks: null,
  words: { sentence: { key: 'x', params: {} }, why: { key: 'y', params: {} }, blocks: null },
  sentenceFigure: null,
  due: { date: '2026-11-01', days: -2, word: 'OVERDUE' },
  since: '2026-11-10T08:00:00.000Z',
  ageDays: 2,
  decide: 'OPEN',
  figures: null,
  condition: 'c',
  actions: { version: 0, verbs: [], assigned: null, acknowledged: null },
})

describe('the Customer request source: one row per request, one per batch (PW-12)', () => {
  it('only what waits on us and this reader may answer; oldest first; a batch of 2+ waiting is ONE group named by the batch', () => {
    const waitingOnCustomer = brandRequest(40, { status: 'COUNTERED', waitingOn: 'CUSTOMER', may: { accept: false, refuse: false, counter: false, counterWithPrice: false } })
    const notMine = brandRequest(41, { may: { accept: false, refuse: false, counter: false, counterWithPrice: false } })
    const groups = requestGroupsOf([HOLD, ...BATCH_ROWS, RUSH, waitingOnCustomer, notMine])
    expect(waitsForMe(RUSH)).toBe(true)
    expect(waitsForMe(waitingOnCustomer)).toBe(false)
    expect(waitsForMe(notMine)).toBe(false)
    // RUSH and HOLD were asked on the 11th, the batch on the 12th: oldest first.
    expect(groups.map((group) => group.openId)).toEqual([RUSH.id, HOLD.id, BATCH])
    const batch = groups.find((group) => group.batchId === BATCH)!
    // Five of the six wait (one was withdrawn): the group holds those five, one customer and one kind.
    expect(batch.requests).toHaveLength(5)
    expect(new Set(batch.requests.map((request) => `${request.party.id}|${request.kind}`)).size).toBe(1)
  })

  it('a batch with one request still waiting is a row of its own; a batch id met with two customers or two kinds is never one group', () => {
    const alone = requestGroupsOf([BATCH_ROWS[0]!])
    expect(alone).toEqual([{ openId: BATCH_ROWS[0]!.id, batchId: null, requests: [BATCH_ROWS[0]] }])
    // The database refuses it; were it read, no group spans two customers: each request is listed alone.
    const other = { ...BATCH_ROWS[1]!, party: { id: 'party-beta', code: 'BETA', name: 'Brand Beta' } }
    const mixed = requestGroupsOf([BATCH_ROWS[0]!, other, BATCH_ROWS[2]!])
    expect(mixed.map((group) => group.requests.length)).toEqual([1, 1, 1])
    expect(mixed.every((group) => group.batchId === null)).toBe(true)
    const twoKinds = requestGroupsOf([BATCH_ROWS[0]!, { ...BATCH_ROWS[1]!, kind: 'HOLD' }])
    expect(twoKinds.every((group) => group.requests.length === 1)).toBe(true)
  })

  it('in the inbox: kind ORDER_CHANGE_REQUEST (the Overview tile’s ?kind= filters to them), waiting view only, never ticked for Approve N', () => {
    const groups = requestGroupsOf([RUSH, ...BATCH_ROWS])
    const rows = rowsOf('waiting', { tasks: [], quotes: [], items: [], requests: groups })
    expect(rows.map((row) => row.source)).toEqual(['request', 'request'])
    expect(rows.every((row) => row.kind === REQUEST_INBOX_KIND)).toBe(true)
    expect(filterRows(rows, { kind: 'ORDER_CHANGE_REQUEST', q: '', changed: false }, () => '')).toHaveLength(2)
    expect(rows.map(openIdOf)).toEqual([RUSH.id, BATCH])
    for (const row of rows) {
      expect(heldOf(row, free)).toBeNull()
      expect(selectHeld(row, free)).toBe('inbox.held.answerAlone')
    }
    expect(heldOf(rows[0]!, { offline: true, busy: false })).toBe('inbox.held.offline')
    for (const view of ['overdue', 'mine', 'decided'] as const) expect(rowsOf(view, { tasks: [], quotes: [], items: [], requests: groups }), view).toEqual([])
  })

  it('Today’s customer request rows are not listed twice once the source is read; not read (or not readable), Today’s rows stay', () => {
    const items = [todayRow('ORDER_CHANGE_REQUEST', 'ocr:1'), todayRow('CHANGE_ORDER', 'co:1')]
    const read = rowsOf('waiting', { tasks: [], quotes: [], items, requests: requestGroupsOf([RUSH]) })
    expect(read.map((row) => row.source)).toEqual(['attention', 'request'])
    expect(read.filter((row) => row.kind === 'ORDER_CHANGE_REQUEST').map((row) => row.source)).toEqual(['request'])
    const unread = rowsOf('waiting', { tasks: [], quotes: [], items, requests: null })
    expect(unread.map((row) => row.kind).sort()).toEqual(['CHANGE_ORDER', 'ORDER_CHANGE_REQUEST'])
    // The tiles: the request rows (a batch one) replace Today's of that kind; a source not read yet is "—".
    const today = { items }
    const reads = { tasks: false, quotes: false, today: true, requests: true }
    expect(countsOf({ tasks: null, quotes: null, today, requests: { rows: 3 }, reads }).waiting).toBe(1 + 3)
    expect(countsOf({ tasks: null, quotes: null, today, requests: { rows: 3 }, reads }).overdue).toBe(1)
    expect(countsOf({ tasks: null, quotes: null, today, requests: null, reads }).waiting).toBeNull()
    expect(countsOf({ tasks: null, quotes: null, today, reads: { tasks: false, quotes: false, today: true } }).waiting).toBe(2)
  })

  it('what a listed row opens: a group its batch, one of its orders alone; a task, a quote; an id no row names: null (asked)', () => {
    const rows = rowsOf('waiting', { tasks: [], quotes: [], items: [], requests: requestGroupsOf([RUSH, ...BATCH_ROWS]) })
    expect(listedTarget(rows, BATCH)).toBe('batch')
    expect(listedTarget(rows, BATCH_ROWS[2]!.id)).toBe('request')
    expect(listedTarget(rows, RUSH.id)).toBe('request')
    expect(listedTarget(rows, 'unknown')).toBeNull()
  })
})

describe('the answers, held with the reason before the click', () => {
  it('withdrawn, answered, our counter waiting on them, another team, the answer its state does not take, words, offline', () => {
    expect(answerHeld(RUSH, 'accept', free, '')).toBeNull()
    expect(answerHeld(RUSH, 'refuse', free, '')).toBe('customerRequest.held.words')
    expect(answerHeld(RUSH, 'refuse', free, 'We cannot.')).toBeNull()
    expect(answerHeld(RUSH, 'accept', free, 'x'.repeat(2001))).toBe('customerRequest.held.long')
    expect(answerHeld({ ...RUSH, status: 'WITHDRAWN' }, 'accept', free, '')).toBe('customerRequest.held.withdrawn')
    expect(answerHeld({ ...RUSH, status: 'ACCEPTED', waitingOn: null }, 'refuse', free, 'x')).toBe('customerRequest.held.answered')
    expect(answerHeld({ ...RUSH, status: 'COUNTERED', waitingOn: 'CUSTOMER' }, 'accept', free, '')).toBe('customerRequest.held.waitsOnCustomer')
    const none = { accept: false, refuse: false, counter: false, counterWithPrice: false }
    expect(answerHeld({ ...CANCEL, may: none }, 'accept', free, '')).toBe('customerRequest.held.team.sales')
    expect(answerHeld({ ...RUSH, may: none }, 'refuse', free, 'x')).toBe('customerRequest.held.team.production')
    expect(teamOf('sales.samples.manage')).toBe('samples')
    expect(teamOf('something.else')).toBe('other')
    // A counter the customer said yes to is only accepted; a lapsed one only refused; a resume never countered.
    expect(answerHeld(AGREED, 'refuse', free, 'x')).toBe('customerRequest.held.counterAgreed')
    expect(answerHeld(AGREED, 'counter', free, '')).toBe('customerRequest.held.counteredOnce')
    expect(answerHeld(AGREED, 'accept', free, '')).toBeNull()
    const lapsed = { ...AGREED, counter: { ...AGREED.counter!, state: 'LAPSED' as const }, may: { accept: false, refuse: true, counter: false, counterWithPrice: false } }
    expect(answerHeld(lapsed, 'accept', free, '')).toBe('customerRequest.held.counterLapsed')
    expect(answerHeld({ ...RUSH, kind: 'RESUME', may: { ...RUSH.may, counter: false } }, 'counter', free, '')).toBe('customerRequest.held.noCounterResume')
    expect(answerHeld(RUSH, 'accept', { offline: true, busy: false, price: true }, '')).toBe('customerRequest.held.offline')
    expect(answerHeld(RUSH, 'accept', { offline: false, busy: true, price: true }, '')).toBe('customerRequest.held.busy')
  })

  it('Suggest something else: at least one of date, fee, words; no date in the past; the fee only with the price grain', () => {
    const today = '2026-11-12'
    expect(counterHeld(EMPTY_COUNTER, { withPrice: true, today })).toBe('customerRequest.counter.held.empty')
    expect(counterHeld({ ...EMPTY_COUNTER, date: '2026-11-11' }, { withPrice: true, today })).toBe('customerRequest.counter.held.past')
    expect(counterHeld({ ...EMPTY_COUNTER, date: today }, { withPrice: true, today })).toBeNull()
    expect(counterHeld({ ...EMPTY_COUNTER, fee: 'abc' }, { withPrice: true, today })).toBe('customerRequest.counter.held.fee')
    // A fee typed by a reader without the grain counts for nothing (it is never sent).
    expect(counterHeld({ ...EMPTY_COUNTER, fee: '25' }, { withPrice: false, today })).toBe('customerRequest.counter.held.empty')
    expect(counterHeld({ ...EMPTY_COUNTER, note: 'x'.repeat(2001) }, { withPrice: true, today })).toBe('customerRequest.counter.held.long')
    expect(counterBodyOf({ date: '2026-12-15', fee: '25,50', note: ' We can. ' }, 3, true)).toEqual({ version: 3, date: '2026-12-15', fee: 2550, note: 'We can.' })
    expect(counterBodyOf({ date: '', fee: '0', note: '' }, 1, true)).toEqual({ version: 1, date: null, fee: 0, note: null })
    expect(counterBodyOf({ date: '', fee: '25', note: 'Free.' }, 1, false)).toEqual({ version: 1, date: null, note: 'Free.' })
    expect('fee' in counterBodyOf({ date: '', fee: '', note: 'x' }, 1, true)).toBe(false)
  })

  it('Lift the hold needs why, one line of at most 500', () => {
    expect(liftHeld('  ', false)).toBe('customerRequest.lift.held.reason')
    expect(liftHeld('a\nb', false)).toBe('customerRequest.lift.held.long')
    expect(liftHeld('x'.repeat(501), false)).toBe('customerRequest.lift.held.long')
    expect(liftHeld('The customer called: go on.', true)).toBe('customerRequest.held.busy')
    expect(liftHeld('The customer called: go on.', false)).toBeNull()
  })
})

// ---- the routes ------------------------------------------------------------------------------------------------------------------

interface Call {
  readonly method: 'GET' | 'POST' | 'PATCH'
  readonly path: string
  readonly query?: unknown
  readonly body?: unknown
  readonly key?: string
}

/**
 * A fake API that records each call and answers from `answer` (or throws what it returns as an Error). The answer is checked by the
 * call's own schema as the client does, unless `raw` (the follow-ups read other areas' whole records: only which writes go is held).
 */
function fakeApi(answer: (call: Call) => unknown, raw = false): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = []
  const reply = (call: Call, schema?: { parse: (value: unknown) => unknown }) => {
    calls.push(call)
    const value = answer(call)
    if (value instanceof Error) throw value
    return schema && !raw ? schema.parse(value) : value
  }
  const api = {
    get: async (path: string, options: { query?: unknown; schema?: { parse: (value: unknown) => unknown } } = {}) => reply({ method: 'GET', path, query: options.query }, options.schema),
    post: async (path: string, options: { body?: unknown; idempotencyKey?: string; schema?: { parse: (value: unknown) => unknown } } = {}) => reply({ method: 'POST', path, body: options.body, ...(options.idempotencyKey ? { key: options.idempotencyKey } : {}) }, options.schema),
    request: async (method: 'PATCH', path: string, options: { body?: unknown; schema?: { parse: (value: unknown) => unknown } } = {}) => reply({ method, path, body: options.body }, options.schema),
  } as unknown as ApiClient
  return { api, calls }
}

const done = (kind: BrandRequest['kind'], extra: Record<string, unknown> = {}) => ({ done: { kind, paused: [], resumed: [], urgency: null, rushed: [], rushSkipped: null, repromise: null, sampleRound: null, words: { en: 'Done.', it: 'Fatto.' }, ...extra } })

describe('each kind answers through its own route (plan §3: Sales for change, cancel, split; production for the others)', () => {
  it('PW-H01: the list asks what waits, with no customer, company or kind filter — the API’s wall decides whose come back', async () => {
    const { api, calls } = fakeApi(() => ({ asOf: '2026-11-12T10:00:00.000Z', items: [RUSH], count: 1, waitingByKind: [{ kind: 'RUSH', count: 1 }], live: { events: [] } }))
    const read = await listWaitingRequests(api)
    expect(read.items.map((item) => item.id)).toEqual([RUSH.id])
    expect(calls).toEqual([{ method: 'GET', path: '/production/brand-requests', query: { status: 'WAITING', limit: 200 } }])
    expect(JSON.stringify(calls[0]!.query)).not.toMatch(/partyId|companyId|kind/)
  })

  it('Accept: Sales’ route for a cancel; production’s for a rush with rushFloor (the two accepts), never rushFloor on another kind', async () => {
    const { api, calls } = fakeApi((call) => (call.path.startsWith('/sales/') ? { request: {}, orderCancelled: false, cancelFee: null, split: null } : done(call.path.includes(HOLD.id) ? 'HOLD' : 'RUSH')))
    await acceptSales(api, CANCEL.id, { version: 2, answer: '  Noted. ' }, 'k-1')
    await acceptProduction(api, RUSH.id, { version: 1, answer: '', rushFloor: true }, 'k-2')
    await acceptProduction(api, HOLD.id, { version: 1, answer: null }, 'k-3')
    expect(calls).toEqual([
      { method: 'POST', path: `/sales/change-requests/${CANCEL.id}/accept`, body: { version: 2, answer: 'Noted.' }, key: 'k-1' },
      { method: 'POST', path: `/production/brand-requests/${RUSH.id}/accept`, body: { version: 1, answer: null, rushFloor: true }, key: 'k-2' },
      { method: 'POST', path: `/production/brand-requests/${HOLD.id}/accept`, body: { version: 1, answer: null }, key: 'k-3' },
    ])
  })

  it('Refuse with the words the customer reads: Sales’ route for its kinds, production’s for the others; Suggest something else is production’s', async () => {
    const { api, calls } = fakeApi((call) => (call.path.endsWith('/counter') ? { request: {}, approvalRequestId: 'ap-1' } : { request: { id: 'r' } }))
    await refuseRequest(api, CANCEL, { version: 2, answer: ' Not possible: it is cut. ' }, 'k-4')
    await refuseRequest(api, RUSH, { version: 1, answer: 'Not this week.' }, 'k-5')
    await counterRequest(api, RUSH.id, counterBodyOf({ date: '2026-12-15', fee: '', note: 'By 15 Dec.' }, 1, false), 'k-6')
    expect(calls.map((call) => call.path)).toEqual([`/sales/change-requests/${CANCEL.id}/refuse`, `/production/brand-requests/${RUSH.id}/refuse`, `/production/brand-requests/${RUSH.id}/counter`])
    expect(calls[0]!.body).toEqual({ version: 2, answer: 'Not possible: it is cut.' })
    // No fee key at all without the price grain (a money field sent without it is refused).
    expect(calls[2]!.body).toEqual({ version: 1, date: '2026-12-15', note: 'By 15 Dec.' })
  })

  it('PW-12: a batch answer names only that batch’s own requests, each at the version read', async () => {
    const lines = batchLinesOf(BATCH_ROWS, 'accept', true)
    const items = batchItemsOf(lines)
    const { api, calls } = fakeApi(() => ({ batchId: BATCH, results: [], notFound: 0, requests: [] }))
    await acceptBatch(api, BATCH, { items, answer: null }, 'k-7')
    expect(calls[0]!.path).toBe(`/production/brand-requests/batches/${BATCH}/accept`)
    const sent = (calls[0]!.body as { items: { requestId: string; version: number }[] }).items
    expect(sent.map((item) => item.requestId).every((requestId) => BATCH_ROWS.some((row) => row.id === requestId))).toBe(true)
    expect(sent).toHaveLength(5)
    expect('rushFloor' in (calls[0]!.body as object)).toBe(false)
  })
})

describe('a batch: read again, each checked, the current ones answered (as Approve N)', () => {
  it('each line current or left out with why; the answer’s results by request; a refused call read back onto each request', () => {
    const lines = batchLinesOf(BATCH_ROWS, 'accept', true)
    expect(lines.filter((line) => line.leftOut === null)).toHaveLength(5)
    expect(lines.find((line) => line.leftOut !== null)?.leftOut).toBe('customerRequest.held.withdrawn')
    // Refusing all checks each request’s right, not the words (the dialog checks them once).
    expect(batchLinesOf(BATCH_ROWS, 'refuse', true).filter((line) => line.leftOut === null)).toHaveLength(5)
    const results = batchResultsOf({ results: [{ requestId: 'a', orderId: 'o', orderNumber: 'SO-1', done: true, words: { en: 'Done', it: 'Fatto' }, problem: null }, { requestId: 'b', orderId: 'o2', orderNumber: 'SO-2', done: false, words: null, problem: { code: 'SHIPMENT_PREPARED', message: 'x' } }] })
    expect(results).toEqual({ a: { ok: true, words: { en: 'Done', it: 'Fatto' }, code: null }, b: { ok: false, words: null, code: 'SHIPMENT_PREPARED' } })
    const items = [{ requestId: 'a', version: 1 }, { requestId: 'b', version: 2 }]
    const nothing = new ApiError('conflict', 409, 'conflict', 'Nothing was answered: see each request.', null, [{ path: 'body/items/0/NO_WORK' }, { path: 'body/items/1/request/COUNTER_LAPSED' }])
    expect(batchRefusalsOf(nothing, items)).toEqual({ a: { ok: false, words: null, code: 'NO_WORK' }, b: { ok: false, words: null, code: 'COUNTER_LAPSED' } })
    expect(batchRefusalsOf(new ApiError('forbidden', 403, 'forbidden', 'x'), items)).toBeNull()
  })
})

describe('after an accept: what it did, and "Lift the hold" / "Clear rush" instead of a generic undo (R-23)', () => {
  const wo = (n: number, changed: boolean) => ({ id: `wo-${n}`, number: `WO-DEMO-020${n}`, status: 'ON_HOLD', changed })

  it('a pause offers Lift the hold over every work order it paused; a rush of the floor Clear rush only where it set the rush', () => {
    expect(followUpOf(HOLD.id, { kind: 'HOLD', paused: [wo(1, true), wo(2, false)], rushed: [] })).toEqual({ kind: 'lift', requestId: HOLD.id, workOrders: [{ id: 'wo-1', number: 'WO-DEMO-0201' }, { id: 'wo-2', number: 'WO-DEMO-0202' }] })
    expect(followUpOf(RUSH.id, { kind: 'RUSH', paused: [], rushed: [wo(1, true), wo(2, false)] })).toEqual({ kind: 'clearRush', requestId: RUSH.id, workOrders: [{ id: 'wo-1', number: 'WO-DEMO-0201' }] })
    // Accept as urgent rushes nothing: no follow-up; a resume, a sample round neither.
    expect(followUpOf(RUSH.id, { kind: 'RUSH', paused: [], rushed: [] })).toBeNull()
    expect(followUpOf(RUSH.id, { kind: 'RESUME', paused: [], rushed: [] })).toBeNull()
    // An accepted pause opened later: its work orders still held (impact read) offer Lift the hold.
    expect(heldFollowUpOf({ ...HOLD, status: 'ACCEPTED' }, { workOrders: [{ id: 'wo-1', number: 'WO-DEMO-0201', status: 'ON_HOLD', held: true, mixed: false }, { id: 'wo-2', number: 'WO-DEMO-0202', status: 'RELEASED', held: false, mixed: false }] })?.workOrders).toEqual([{ id: 'wo-1', number: 'WO-DEMO-0201' }])
    expect(heldFollowUpOf(HOLD, { workOrders: [] })).toBeNull()
  })

  it('what the accept said beside, in order; the notice names the kind and the order number in both languages', () => {
    const accepted = done('RUSH', { urgency: { urgency: 'URGENT', already: false, use: { words: { en: '4 of 3 urgent used · 1 agreed with us', it: '4 su 3 urgenti usati · 1 concordato con noi' } } }, rushSkipped: { en: 'WO-9 left alone', it: 'WO-9 lasciato' } }).done
    expect(doneWordsOf(accepted as never).map((words) => words.en)).toEqual(['Done.', '4 of 3 urgent used · 1 agreed with us', 'WO-9 left alone'])
    expect(doneWordsOf({ orderCancelled: false, split: null })).toEqual([])
    const facts = noticeFactsOf(RUSH)
    expect(facts.kindLabel).toEqual({ en: 'Urgent – asked', it: 'Urgente – richiesto' })
    expect(facts.record.label).toBe(RUSH.orderNumber)
  })

  it('Lift the hold lifts only THIS request’s customer pause on each work order (another hold stays); Clear rush only a rush still set', async () => {
    const hold = (workOrderId: string, id: string, kind: 'BRAND' | 'PRODUCTION', requestId: string | null) => ({ id: `${workOrderId}-${id}`, workOrderId, kind, status: 'ACTIVE', requestId, version: kind === 'BRAND' ? 2 : 1 })
    const pause = fakeApi((call) => {
      if (call.method === 'GET' && call.path.endsWith('/holds')) {
        const workOrderId = call.path.split('/')[3]!
        if (workOrderId === 'wo-2') return new Error('down')
        if (workOrderId === 'wo-3') return { holds: [hold(workOrderId, 'ours', 'PRODUCTION', null)] }
        return { holds: [hold(workOrderId, 'brand', 'BRAND', HOLD.id), hold(workOrderId, 'ours', 'PRODUCTION', null), hold(workOrderId, 'other', 'BRAND', 'another-request')] }
      }
      if (call.path.endsWith('/lift')) return { lifted: false }
      return new Error(`unexpected ${call.method} ${call.path}`)
    }, true)
    const workOrders = [1, 2, 3].map((n) => ({ id: `wo-${n}`, number: `WO-DEMO-020${n}` }))
    const lifted = await liftCustomerPause(pause.api, { kind: 'lift', requestId: HOLD.id, workOrders }, ' The customer called. ')
    // One lifted; one could not be read (named, the others go on); one holds nothing of this pause any more.
    expect(lifted).toEqual({ lifted: ['WO-DEMO-0201'], none: ['WO-DEMO-0203'], failed: ['WO-DEMO-0202'] })
    const lifts = pause.calls.filter((call) => call.path.endsWith('/lift'))
    expect(lifts).toEqual([{ method: 'POST', path: '/production/work-orders/wo-1/holds/wo-1-brand/lift', body: { version: 2, reason: 'The customer called.' }, key: expect.any(String) }])

    const rush = fakeApi((call) => (call.method === 'GET' ? { workOrder: { id: call.path.split('/').at(-1), rush: call.path.endsWith('wo-1'), version: 7 } } : { workOrder: { id: 'wo-1', rush: false, version: 8 } }), true)
    const cleared = await clearRush(rush.api, { kind: 'clearRush', requestId: RUSH.id, workOrders: workOrders.slice(0, 2) })
    expect(cleared).toEqual({ cleared: ['WO-DEMO-0201', 'WO-DEMO-0202'], failed: [] })
    // Each work order read first; only the one still rushed is written, rush false at the version read.
    expect(rush.calls.filter((call) => call.method === 'PATCH')).toEqual([{ method: 'PATCH', path: '/production/work-orders/wo-1', body: { version: 7, rush: false } }])
  })
})

describe('`?open=<id>` no row names: an engine request, a customer request, a batch — or the neutral "not found" (PW-H01b)', () => {
  it('asks in that order, each only with its read right; another customer’s request (404) is "none", never named', async () => {
    const seen = (found: 'task' | 'request' | 'batch' | null) =>
      fakeApi((call) => {
        if (call.path.startsWith('/approvals/tasks/')) return found === 'task' ? { task: {} } : notFound()
        if (call.path.startsWith('/production/brand-requests/')) return found === 'request' ? { asOf: 'x', request: RUSH, counterApproval: null, batch: [] } : notFound()
        return { asOf: 'x', items: found === 'batch' ? BATCH_ROWS : [], count: 0, waitingByKind: [], live: { events: [] } }
      })
    const task = seen('task')
    // getTask parses the task's full shape; a bare answer is a parse failure — any failure but 404 stays the task review's to say.
    expect(await probeOpen(task.api, 'id-1', { tasks: true, requests: true })).toBe('task')
    expect(await probeOpen(seen('request').api, RUSH.id, { tasks: true, requests: true })).toBe('request')
    expect(await probeOpen(seen('batch').api, BATCH, { tasks: true, requests: true })).toBe('batch')
    const foreign = seen(null)
    expect(await probeOpen(foreign.api, 'brand-a-request', { tasks: true, requests: true })).toBe('none')
    expect(foreign.calls.map((call) => call.path)).toEqual(['/approvals/tasks/brand-a-request', '/production/brand-requests/brand-a-request', '/production/brand-requests'])
    expect(foreign.calls[2]!.query).toEqual({ batchId: 'brand-a-request', status: 'ALL', limit: 200 })
    // Without approvals.view the engine is not asked; without a request read right neither are the customer's requests.
    const narrow = seen(null)
    expect(await probeOpen(narrow.api, 'x', { tasks: false, requests: false })).toBe('none')
    expect(narrow.calls).toEqual([])
  })
})

describe('refusals and the request in words', () => {
  it('a refusal’s code from the API (request/<CODE>, its last part) in our words; a move reads again; other kinds their problem', () => {
    expect(requestRefusalOf([{ path: 'request/NO_WORK' }])).toBe('NO_WORK')
    expect(requestRefusalOf([{ path: 'request/shipToAddressId/ADDRESS_GONE' }])).toBe('ADDRESS_GONE')
    expect(answerProblem(conflict('request/NO_WORK'))).toEqual({ key: 'customerRequest.refusal.NO_WORK', reload: true })
    expect(answerProblem(conflict('request/BRAND_NEW_CODE'))).toEqual({ key: 'customerRequest.refusal.other', reload: true })
    expect(answerProblem(new ApiError('conflict', 409, 'stale_version', 'x'))).toEqual({ key: 'customerRequest.refusal.moved', reload: true })
    expect(answerProblem(notFound())).toEqual({ key: 'customerRequest.refusal.gone', reload: true })
    expect(answerProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'customerRequest.problem.forbidden', reload: false })
    expect(answerProblem(new Error('x'))).toEqual({ key: 'customerRequest.problem.internal', reload: false })
  })

  it('the card: each size asked old → new, a whole-order cancel, the need-by date; the fee only when the API sent it (the price grain)', () => {
    const say = (key: string, params?: Record<string, string | number>) => `${key}${params ? JSON.stringify(params) : ''}`
    const words = { say, locale: 'en' as const, day: (value: string) => `day:${value}`, money: (minor: number, currency: string) => `${currency} ${minor / 100}` }
    const cancel = cardInputOf(CANCEL, null, words)
    expect(cancel.changes).toEqual([{ id: `${CANCEL.cells[0]!.lineId}:`, label: 'customerRequest.change.cell{"line":2,"style":"JKT-DEMO-02 · NERO","size":"customerRequest.change.wholeLine"}', from: '40', to: '0' }])
    expect(cancel.impact).toEqual({ frozen: ['Line 2 · M: cut already — a price applies'], earliest: null, price: 'PRICED', priceText: 'EUR 360' })
    const blind = cardInputOf({ ...CANCEL, cancelFee: { pct: null, words: CANCEL.cancelFee!.words, currency: 'EUR' } }, null, words)
    expect(blind.impact?.price).toBe('MAY_APPLY')
    expect(blind.impact?.priceText).toBeNull()
    const rush = cardInputOf(RUSH, null, words)
    expect(rush.changes).toEqual([{ id: 'date', label: 'customerRequest.change.neededBy', from: '—', to: 'day:2026-12-10' }])
    expect(rush.impact?.earliest).toEqual({ best: '2026-12-08' })
    expect(rush.note).toBe(RUSH.note)
  })
})

// ---- every word in both languages ------------------------------------------------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SOURCES = [...readdirSync(HERE).filter((name) => /\.tsx?$/.test(name) && !name.includes('.vitest.') && name !== 'fixtures.ts').map((name) => join(HERE, name)), ...readdirSync(join(HERE, 'view')).map((name) => join(HERE, 'view', name))]

describe('every word of the customer request window exists in it and en, with the same placeholders', () => {
  it('each customerRequest key the files name (literally or built from CR) is in both catalogues', () => {
    const keys = new Set<string>()
    for (const file of SOURCES) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/(?:customerRequest|\$\{CR\})\.([A-Za-z0-9_.]*[A-Za-z0-9_])[`'"]/g)) keys.add(`customerRequest.${match[1]}`)
    }
    for (const code of KNOWN_REQUEST_REFUSALS) keys.add(`customerRequest.refusal.${code}`)
    for (const team of ['sales', 'production', 'samples', 'other']) keys.add(`customerRequest.team.${team}`).add(`customerRequest.held.team.${team}`)
    for (const kind of ['PRE_PRODUCTION', 'SIZE_SET', 'TOP_OF_PRODUCTION', 'BRAND']) keys.add(`customerRequest.sample.${kind}`)
    for (const kind of ['lift', 'clearRush']) keys.add(`customerRequest.followUp.held.${kind}`)
    for (const kind of ['forbidden', 'invalid', 'unavailable', 'rate_limited', 'signed_out', 'internal']) keys.add(`customerRequest.problem.${kind}`)
    expect(keys.size).toBeGreaterThan(100)
    for (const locale of LOCALES) {
      const dictionary = CATALOGUE[locale].approvals ?? {}
      expect([...keys].filter((key) => !(key in dictionary)), locale).toEqual([])
    }
    const en = CATALOGUE.en.approvals ?? {}
    const it_ = CATALOGUE.it.approvals ?? {}
    for (const key of Object.keys(en).filter((entry) => entry.startsWith('customerRequest.'))) {
      expect(it_[key]?.trim(), `it ${key}`).toBeTruthy()
      expect(placeholdersOf(it_[key] ?? ''), key).toEqual(placeholdersOf(en[key] ?? ''))
    }
  })

  it('the inbox’s own words (approvals-depth): the kind, the rows, who answers, the notices — in both languages', () => {
    const depth = ['kind.ORDER_CHANGE_REQUEST', 'row.request', 'row.batch', 'row.orders', 'row.requestAsker', 'row.chip.frozen', 'row.chip.priced', 'row.chip.earliest', 'inbox.held.answerAlone', /* fix-pr-6: the window's nav noun */ 'review.noun']
    for (const team of ['sales', 'production', 'samples', 'other']) depth.push(`rule.team.${team}`)
    for (const notice of ['requestAccepted', 'requestRushed', 'requestRefused', 'requestCountered', 'batchAccepted', 'batchRefused', 'holdLifted', 'holdNotLifted', 'holdNothing', 'rushCleared', 'rushNotCleared']) depth.push(`notice.${notice}`)
    for (const locale of LOCALES) expect(depth.filter((key) => !((CATALOGUE[locale]['approvals-depth'] ?? {})[key]?.trim())), locale).toEqual([])
    expect(CATALOGUE.it['approvals-depth']?.['kind.ORDER_CHANGE_REQUEST']).toBe('Richiesta del cliente')
    expect(CATALOGUE.en.approvals?.['customerRequest.acceptRush']).toBe('Accept and rush the floor')
    expect(CATALOGUE.en.approvals?.['customerRequest.followUp.lift']).toBe('Lift the hold')
    expect(CATALOGUE.en.approvals?.['customerRequest.followUp.clearRush']).toBe('Clear rush')
  })
})

// ── F-SA-241 / F-SA-242 (sales page plan P5, P6', R1, R3, R8; 14-change-flow §3.2–§3.4, §4.2; lead picks Round 4; review R-6) ──
describe('F-SA-241: the window’s new parts from the apply plan — On the floor now, Extra pieces, What happens next, Done', () => {
  const { CHANGE, PLAN, PLAN_AFTER, WO } = REQUEST_FIXTURES

  it('Accept waits on the plan in order: the change not possible as it stands, then the extra pieces unpicked, then an outcome not this reader’s', () => {
    expect(planHeld(PLAN, NO_CHOICES)).toEqual({ words: PLAN.extra.words })
    expect(planHeld(PLAN, { extraOutcome: 'LEFTOVER', stops: [] })).toBeNull()
    expect(planHeld(PLAN, { extraOutcome: 'SCRAP', stops: [] })).toBeNull()
    const noPrice = { ...PLAN, extra: { ...PLAN.extra, outcomes: PLAN.extra.outcomes.map((option) => (option.outcome === 'CHARGE' ? { ...option, mayChoose: false } : option)) } }
    expect(planHeld(noPrice, { extraOutcome: 'CHARGE', stops: [] })).toEqual({ words: noPrice.extra.outcomes[0]!.needsWords })
    // A colourway already cut (the record's own preview, F-SA-242) is said before the extra pieces.
    const colour = { words: { en: 'Already cut in Black: 40 pieces. Suggest something else or refuse.', it: 'Già tagliati in Nero: 40 pezzi. Proponi altro o rifiuta.' } }
    const held = { ...PLAN, next: PLAN.next.map((step) => (step.kind === 'AMEND' ? { ...step, state: 'NOT_POSSIBLE' as const, why: colour.words } : step)) }
    expect(planHeld(held, NO_CHOICES)).toEqual(colour)
    // No plan (not read, no orders.view): nothing claimed, answerHeld's own reasons stay.
    expect(planHeld(null)).toBeNull()
    // Round 4: no outcome is picked for the reader; one it may not choose is held with why, never hidden.
    expect(NO_CHOICES.extraOutcome).toBeNull()
    expect(outcomeHeld({ mayChoose: false, needsWords: { en: 'x', it: 'y' } })).toEqual({ en: 'x', it: 'y' })
    expect(outcomeHeld({ mayChoose: true, needsWords: { en: 'x', it: 'y' } })).toBeNull()
  })

  it('each step’s state in words, before and after Accept; the order’s Still to do rows in the same words', () => {
    const [amend, lower] = PLAN.next
    expect(stepStateOf(amend!, false).key).toBe('customerRequest.next.state.thisAccept')
    expect(stepStateOf(lower!, false).key).toBe('customerRequest.next.state.afterAccept')
    const [amendDone, proposed] = PLAN_AFTER.next
    expect(stepStateOf(amendDone!, true)).toMatchObject({ word: 'done', tone: 'success' })
    expect(stepStateOf(proposed!, true)).toMatchObject({ word: 'yourTurn' })
    expect(stepStateOf({ ...proposed!, mayDoNow: false }, true).key).toBe('customerRequest.next.state.waiting.PLANNER')
    expect(stepStateOf({ ...proposed!, state: 'LEFT_AS_IS' }, true).word).toBe('leftAsIs')
    expect(stepStateOf({ ...proposed!, team: 'PRODUCT', kind: 'ECO', mayDoNow: false }, true).key).toBe('customerRequest.next.state.waiting.PRODUCT')
    expect(stillStateOf({ kind: 'EXTRA_PIECES', waitingOn: 'PLANNER', mayAct: true }).word).toBe('needsDecision')
    expect(stillStateOf({ kind: 'REPROMISE', waitingOn: 'SALES', mayAct: true }).word).toBe('yourTurn')
    expect(stillStateOf({ kind: 'STYLE_CHANGE', waitingOn: 'PRODUCT', mayAct: false }).key).toBe('customerRequest.next.state.waiting.PRODUCT')
  })

  it('Finish what is started / Stop now: only for a work order the reader reaches with bundles in work, once each', () => {
    expect(stoppableOf(PLAN)).toEqual([{ id: WO.id, number: WO.number, bundles: 2 }])
    const twice = { ...PLAN, next: [...PLAN.next, { ...PLAN.next[1]!, seq: 3, kind: 'MAKE_MORE' as const }] }
    expect(stoppableOf(twice)).toHaveLength(1)
    expect(stoppable({ ...PLAN.next[1]!, bundles: 0 })).toBe(false)
    expect(stoppable({ ...PLAN.next[1]!, workOrder: null })).toBe(false)
    expect(stoppable({ ...PLAN.next[1]!, bundles: undefined })).toBe(false)
    expect(stoppable(PLAN.next[0]!)).toBe(false)
  })

  // F-OP-116 (B1): the applies go first, the stops after — a hold placed first made its own work order refuse the change (ON_HOLD).
  it('after Accept (B1): each work-order change this reader may carry out now first, then the stops — every one its own command', () => {
    const commands = doneCommandsOf(PLAN_AFTER, [WO])
    expect(commands.map((command) => command.key)).toEqual([`apply:${PLAN_AFTER.next[1]!.ref!.id}`, `stop:${WO.id}`])
    // A proposal not this reader's (no workorders.manage over it) is a door, never a command.
    expect(doneCommandsOf({ next: PLAN_AFTER.next.map((step) => ({ ...step, mayDoNow: false })) }, [])).toEqual([])
    expect(leftToRun(commands, { [`apply:${PLAN_AFTER.next[1]!.ref!.id}`]: { phase: 'done' } }).map((command) => command.kind)).toEqual(['stop'])
  })

  // F-OP-116 (R-17): with auto-apply on, Accept carried the change out in its own command — the window never applies it again.
  it('after an auto-applying Accept (R-17): a change in the answer\'s workOrders.applied[] is no command; the stops then go at once', async () => {
    const { atAcceptOf } = await import('./model')
    const applied = [PLAN_AFTER.next[1]!.ref!.id]
    const commands = doneCommandsOf(PLAN_AFTER, [WO], applied)
    expect(commands.map((command) => command.key)).toEqual([`stop:${WO.id}`])
    expect(atAcceptOf(commands).map((command) => command.key)).toEqual([`stop:${WO.id}`])
    // A change still to carry out by this reader: nothing runs by itself ("Do the next steps" runs the apply first, the stop after).
    expect(atAcceptOf(doneCommandsOf(PLAN_AFTER, [WO]))).toEqual([])
    expect(atAcceptOf(doneCommandsOf(PLAN_AFTER, []))).toEqual([])
    const source = readFileSync(new URL('./use-request-review.ts', import.meta.url), 'utf8')
    expect(source).toContain('doneCommandsOf(after, stops, (accepted.workOrders?.applied ?? []).map((entry) => entry.changeId))')
    expect(source).toContain('const stopNow = atAcceptOf(commands)')
  })

  it('"Do the next steps" runs one after another and stops at the FIRST refusal (the rest stay to do, nothing rolled back)', async () => {
    const commands = [{ key: `stop:${WO.id}`, kind: 'stop' as const, workOrder: { id: WO.id, number: WO.number } }, { key: 'apply:other', kind: 'apply' as const, changeId: 'other', workOrder: null, words: { en: 'x', it: 'y' } }]
    const seen: string[] = []
    const states: Record<string, string> = {}
    const result = await runInOrder(
      commands,
      async (command) => {
        seen.push(command.key)
        return command.kind === 'apply' ? { phase: 'refused', key: 'workOrderChange.refusal.CHANGED_SINCE' } : { phase: 'done' }
      },
      (key, state) => (states[key] = state.phase),
    )
    expect(result).toEqual({ done: 1, refused: commands[1]!.key })
    expect(seen).toEqual([commands[0]!.key, commands[1]!.key])
    expect(states).toEqual({ [commands[0]!.key]: 'done', [commands[1]!.key]: 'refused' })
  })

  it('Accept sends the outcome chosen (and nothing when none); the plan is read with orders.view from its own route', async () => {
    const { api, calls } = fakeApi((call) => (call.path.endsWith('/apply-plan') ? PLAN : { request: {}, orderCancelled: false, cancelFee: null, split: null, workOrders: { proposed: [], extra: [], extraOutcome: 'LEFTOVER' }, styleChanges: [] }))
    await acceptSales(api, CHANGE.id, { version: 1, answer: null, extraOutcome: 'LEFTOVER' }, 'k-41')
    await acceptSales(api, CHANGE.id, { version: 1, answer: null, extraOutcome: null }, 'k-42')
    const plan = await getApplyPlan(api, CHANGE.id)
    expect(calls[0]).toEqual({ method: 'POST', path: `/sales/change-requests/${CHANGE.id}/accept`, body: { version: 1, answer: null, extraOutcome: 'LEFTOVER' }, key: 'k-41' })
    expect(calls[1]!.body).toEqual({ version: 1, answer: null })
    expect(calls[2]).toEqual({ method: 'GET', path: `/sales/change-requests/${CHANGE.id}/apply-plan`, query: undefined })
    expect(plan.next[1]!.bundles).toBe(2)
    // An older answer without the step's bundles still reads (no count: no Stop now).
    const older: Record<string, unknown> = { ...PLAN.next[1]! }
    delete older.bundles
    expect(applyPlanSchema.parse({ ...PLAN, next: [PLAN.next[0], older] }).next[1]!.bundles).toBeUndefined()
  })

  it('the window draws every part for every door; a door other than Approvals brings the approvals layout with it', () => {
    const view = readFileSync(join(HERE, 'view', 'RequestReview.tsx'), 'utf8')
    expect(view).toContain("import '../../approvals.css'")
    for (const part of ['<FloorNow plan={plan} />', '<ExtraPieces', '<NextSteps', '<DoneSteps']) expect(view).toContain(part)
    // Accept held by the plan's reason too (words, before the click), Close or Next request › after it, Esc closes the done view the same way.
    expect(view).toContain('const acceptHeld = acceptHeldKey ? t(acceptHeldKey) : planHeldText')
    expect(view).toContain("done.next === 'next' ? t(`${CR}.done.nextRequest`) : t(`${CR}.done.close`)")
    expect(view).toContain('onClose={() => (done ? actions?.onDoneClose?.() : nav.onOpen?.(null))}')
    const container = readFileSync(join(HERE, 'use-request-review.ts'), 'utf8')
    // Stop now = a production hold, its own Idempotency-Key; a work-order change carried out at the version read (each its own command).
    expect(container).toContain('placeProductionHold(api, command.workOrder.id')
    expect(container).toContain('applyWorkOrderChange(api, command.changeId, { version: change.version }, keyOf(command))')
    expect(container).toContain('extraOutcome: choices.extraOutcome')
    // Approvals says Next request ›, every other door Close.
    expect(readFileSync(join(HERE, '..', 'Approvals.tsx'), 'utf8')).toContain("doneNext: 'next'")
    expect(readFileSync(join(HERE, 'use-request-review-door.ts'), 'utf8')).toContain("doneNext: 'close'")
  })
})

describe('F-SA-242: the words in the order’s conversation, and the held reasons', () => {
  const { CHANGE, PLAN } = REQUEST_FIXTURES
  const tick = (over: Partial<TellTick> = {}): TellTick => ({ chosen: null, reach: 'portal', sent: 'no', compose: null, ...over })

  it('the tick is on when words are typed (never automatic), held "Type the words first" or "No way to reach <customer>"', () => {
    expect(tickOn(tick(), '')).toBe(false)
    expect(tickOn(tick(), 'Yes: M 36.')).toBe(true)
    expect(tickOn(tick({ chosen: false }), 'Yes: M 36.')).toBe(false)
    expect(tellHeld(tick(), '  ')).toBe('customerRequest.tell.held.words')
    expect(tellHeld(tick({ reach: 'none' }), 'Yes')).toBe('customerRequest.tell.held.reach')
    expect(tellsNow(tick(), 'Yes')).toBe(true)
    expect(tellsNow(tick({ chosen: false }), 'Yes')).toBe(false)
    expect(tellsNow(tick({ reach: 'none' }), 'Yes')).toBe(false)
    // A request is asked in the portal: reached there until the portal says nobody reads it any more.
    expect(reachOf(CHANGE, false)).toBe('portal')
    expect(reachOf(CHANGE, true)).toBe('none')
    expect(reachOf({ askedBy: null }, false)).toBe('none')
    expect(tellRefusalOf('notice.portal.NO_PORTAL')).toBe('customerRequest.tell.held.reach')
    expect(tellRefusalOf('notice.portal.CLOSED')).toBe('customerRequest.tell.refused.closed')
    expect(tellRefusalOf(null)).toBe('customerRequest.tell.refused.other')
  })

  it('the words go through the thread’s own send (the composer’s portal reply call, the composer untouched), only after the answer took', () => {
    const container = readFileSync(join(HERE, 'use-request-review.ts'), 'utf8')
    expect(container).toContain("postPortalReplyKeyed(api, { type: 'SalesOrder', id: about.orderId }, { body: text.trim(), attachments: [] }, newIdempotencyKey())")
    expect(container).toContain('if (told) void tellNow(request, words)')
    expect(container).not.toMatch(/lib\/record-thread\/composer/)
  })

  it('held colour and style reasons: a design change of our own collection offers Options… only while no work order makes the line', () => {
    const style = (inWork: boolean) => ({
      ...PLAN,
      request: { ...PLAN.request, kind: 'DESIGN' as const },
      next: [{ ...PLAN.next[0]!, kind: 'STYLE_CHANGE' as const, state: 'NOT_POSSIBLE' as const, why: designHeldWords('OWN_COLLECTION', inWork) }],
    })
    expect(designOptionsOffered(style(false))).toBe(true)
    expect(designOptionsOffered(style(true))).toBe(false)
    expect(designOptionsOffered(PLAN)).toBe(false)
    expect(planHeld(style(true))).toEqual({ words: designHeldWords('OWN_COLLECTION', true) })
    // No private-label copy door (R3): the window offers Suggest something else, Refuse and (maybe) Options… only.
    const view = readFileSync(join(HERE, 'view', 'RequestReview.tsx'), 'utf8')
    expect(view).not.toMatch(/privateLabelCopy|makeCopy|copyStyle/)
    expect(view).toContain('t(`${CR}.design.options`)')
  })

  it('every new word in it + en with the same placeholders, the built keys too (states by team, outcomes)', () => {
    const keys = ['tell.tick', 'tell.held.words', 'tell.held.reach', 'tell.open', 'tell.send', 'tell.sent', 'design.options', 'floor.title', 'floor.withheld', 'extra.title', 'extra.pick', 'next.title', 'next.finish', 'next.stop', 'next.stopWords', 'next.changeNow', 'done.title', 'done.runAll', 'done.nextRequest', 'done.close', 'done.nothingLeft']
    for (const word of ['thisAccept', 'afterAccept', 'done', 'yourTurn', 'needsDecision', 'leftAsIs', 'notPossible']) keys.push(`next.state.${word}`)
    for (const team of ['PLANNER', 'PRODUCT', 'FINANCE', 'CUSTOMER', 'SALES']) keys.push(`next.state.waiting.${team}`)
    for (const outcome of ['CHARGE', 'LEFTOVER', 'SCRAP']) keys.push(`extra.outcome.${outcome}`)
    for (const locale of LOCALES) {
      const dictionary = CATALOGUE[locale].approvals ?? {}
      expect(keys.filter((key) => !dictionary[`customerRequest.${key}`]?.trim()), locale).toEqual([])
    }
    expect(CATALOGUE.en.approvals?.['customerRequest.tell.tick']).toBe("Also write it in the order's conversation")
    expect(CATALOGUE.it.approvals?.['customerRequest.tell.tick']).toBe("Scrivilo anche nella conversazione dell'ordine")
    expect(CATALOGUE.it.approvals?.['customerRequest.next.state.yourTurn']).toBe('Tocca a te')
    expect(CATALOGUE.it.approvals?.['customerRequest.next.stop']).toBe('Ferma ora')
    expect(placeholdersOf(CATALOGUE.it.approvals?.['customerRequest.tell.held.reach'] ?? '')).toEqual(['customer'])
  })
})
// ── end F-SA-241 / F-SA-242 ──

// ── B-SA-046b (14-change-flow §2.4): the window says which pieces the customer's design change is for ──────────────────────────
describe("B-SA-046b: the review window says which pieces the customer's design change is for", () => {
  it('reads the choice from the impact (kept at Send and now), and an impact without one reads none', () => {
    const base = { kind: 'DESIGN', frozen: [], blocked: false, priced: true, pricedWords: null, earliest: null, notes: [], words: { en: 'x', it: 'x' } }
    expect(impactSchema.parse({ ...base, appliesTo: 'ALSO_MADE' }).appliesTo).toBe('ALSO_MADE')
    expect(impactSchema.parse({ ...base, appliesTo: null }).appliesTo).toBeNull()
    expect(impactSchema.parse(base).appliesTo).toBeUndefined()
    expect(impactSchema.safeParse({ ...base, appliesTo: 'EVERYTHING' }).success).toBe(false)
  })

  it('draws it first in the impact list, in the same words for every reader (both languages)', () => {
    const view = readFileSync(join(HERE, 'view', 'RequestReview.tsx'), 'utf8')
    expect(view).toContain('said(DESIGN_APPLIES_WORDS[impact.now.appliesTo], locale)')
    expect(view.indexOf('DESIGN_APPLIES_WORDS[impact.now.appliesTo]')).toBeLessThan(view.indexOf('impact.now.earliest.words'))
    expect(DESIGN_APPLIES_WORDS.ALSO_MADE.en).toBe('Also for the pieces already made (rework may cost)')
    expect(DESIGN_APPLIES_WORDS.ALSO_MADE.it).toBe('Vale anche per i pezzi già fatti (la rilavorazione può costare)')
  })
})
// ── end B-SA-046b ──
