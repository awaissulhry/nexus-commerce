import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PARTNER_MESSAGE_TEMPLATES } from '@nexus/factory-domain/portal/notifications/messages'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import type { ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import type { Locale } from '../../../../lib/i18n/locales'
import { render, textOf } from '../../../../lib/record-thread/parts/testing'
import { scanText } from '../../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../../lib/testing/two-brands'
import { downloadProduction, urgencyAnswerSchema, type ProductionList, type ProductionRow, type UndoAnswer, type Urgency, type UrgencyAnswer } from '../api'
import { markedNotice, NS } from '../model'
import { ProductionListView, type ProductionListModel } from '../view/ProductionListView'
import type { BulkReviewModel } from '../view/BulkReview'
import { downloadFilesZip, withdrawAskBatch, type WithdrawAnswer } from './api'
import {
  BULK_MAX,
  bulkBarOf,
  doneLineOf,
  keepPicked,
  markReviewOf,
  outcomeOf,
  phoneBarOf,
  pickedRowsOf,
  problemOrdersOfRows,
  refusedOutcomeOf,
  reviewHeldOf,
  reviewLeadOf,
  reviewSaveOf,
  reviewTitleOf,
  topReviewOf,
  undoLineOf,
  zipNameOf,
  zipProblemOf,
  type BulkFacts,
} from './model'

// The DS review draws in a Modal (a portal in the browser); on the server render of a test its body is drawn in place.
vi.mock('@nexus/ui/patterns', async (original) => {
  const actual = await original<typeof import('@nexus/ui/patterns')>()
  const ReviewChangesModal = (props: import('@nexus/ui/patterns').ReviewChangesModalProps) =>
    props.open
      ? createElement(
          'section',
          { role: 'dialog' },
          createElement('h2', null, props.title),
          createElement('p', null, props.summary as ReactNode),
          createElement(actual.ReviewChangesPanel, { changes: props.changes, ...(props.state ? { state: props.state } : {}), lead: props.lead, ...(props.doneLine ? { doneLine: props.doneLine } : {}), ...(props.labels ? { labels: props.labels } : {}), ack: false, onAckChange: () => undefined }),
          props.state?.phase === 'done' ? (props.onUndo ? createElement('button', null, props.labels?.undo ?? 'Undo') : null) : createElement('button', null, props.saveLabel),
        )
      : null
  return { ...actual, ReviewChangesModal }
})

/**
 * F-PR-23a — the bulk bar on My production (production plan §1 "Bulk", §3, §5; 17-web-r2 §1.5; lead picks L25; walls PW-11, PW-12):
 * the bar on the first pick (count, Select all, Mark urgent · Mark regular · Move to top, More ▾ Report a problem · Download files ·
 * Export; a phone keeps two), at most 50 at a time, the review before Send that names each order and what will happen (urgent now,
 * asked of us over the limit or from Cutting, cannot and why), one result per row, Undo (urgency back, asks withdrawn), the zip and
 * the picked rows' file; Brand Beta's bar and review hold nothing of Brand Alpha and never the office's series. Made-up data only.
 */

const t = (locale: Locale) => createTranslator(locale, CATALOGUE[locale][NS] ?? {})
const en = t('en')
const it_ = t('it')
const w = (text: string) => ({ it: text, en: text })
const OFFICE_SERIES = /\b(?:SO|INQ|QT|RQ|WO)-\d{4}-\d+/

function urgency(over: Partial<Urgency> = {}): Urgency {
  return { code: 'REGULAR', words: { it: 'Normale', en: 'Regular' }, urgentRank: null, asked: false, askedWords: null, byUs: false, byUsWords: null, locked: false, lockWords: null, ...over }
}
const URGENT = (rank: number) => urgency({ code: 'URGENT', words: { it: 'Urgente', en: 'Urgent' }, urgentRank: rank })
const STAGE = (code: 'PREPARING' | 'CUTTING' | 'SEWING') => ({ code, words: w(code), since: '2026-11-10', next: null })

function row(id: string, seq: number, over: Partial<ProductionRow> = {}): ProductionRow {
  return {
    id,
    customerRef: `${BRAND_BETA.customerRef}-${id}`,
    // The office's own number: in the read, never drawn.
    number: BRAND_BETA.numbers.order,
    yourNumber: customerNumberOf('ORDER', seq),
    orderedOn: '2026-10-05',
    styles: [{ code: BRAND_BETA.numbers.style, name: 'Rider jacket' }],
    pieces: 120,
    promiseDate: '2026-12-02',
    originalPromiseDate: null,
    promiseMoved: false,
    stage: STAGE('PREPARING'),
    health: null,
    waiting: { code: 'US', words: w('Waiting on us'), since: null },
    marks: { onHold: false, paused: false, partlyShipped: false, changePending: false, words: [] },
    urgency: urgency(),
    next: null,
    count: null,
    ...over,
  }
}

const USE = { used: 2, max: 3, agreed: 0, left: 1, over: false, words: { it: '2 urgenti su 3', en: '2 of 3 urgent used' } }
// b1, b2 urgent; b3, b4 regular before Cutting; b5 cut; b6 locked by us; b7 asked already.
const ROWS: ProductionRow[] = [
  row('b1', 1, { urgency: URGENT(1) }),
  row('b2', 2, { urgency: URGENT(2) }),
  row('b3', 3),
  row('b4', 4),
  row('b5', 5, { stage: STAGE('CUTTING') }),
  row('b6', 6, { urgency: urgency({ locked: true, lockWords: { it: 'Riportato a normale da noi: materiale non arrivato', en: 'Set to Regular by us: material not in' } }) }),
  row('b7', 7, { urgency: urgency({ asked: true, askedWords: { it: 'Urgente – richiesto', en: 'Urgent – asked' } }) }),
]

function list(over: Partial<ProductionList> = {}): ProductionList {
  return {
    asOf: '2026-11-18T09:42:00.000Z',
    level: 'STATUS',
    levelWords: w('Status only'),
    urgencyOn: true,
    urgentUse: USE,
    chip: 'ALL',
    chips: [{ chip: 'ALL', count: ROWS.length, words: w('All in production') }],
    count: ROWS.length,
    items: ROWS,
    live: { events: [] },
    ...over,
  }
}

const FACTS: BulkFacts = { urgencyOn: true, mayMark: true, mayAsk: true, mayReport: true, mayFiles: true, preview: false, offline: false, busy: false }
const pick = (...ids: string[]) => pickedRowsOf(ROWS, ids)
const conflict = (paths: string[], kind: 'conflict' | 'not_found' = 'conflict') => new ApiError(kind, kind === 'conflict' ? 409 : 404, kind, 'refused', null, paths.map((path) => ({ path, message: 'English for the logs' })))

function answer(over: Partial<UrgencyAnswer> = {}): UrgencyAnswer {
  return { batchId: 'batch-1', results: [], notFound: 0, use: USE, replayed: false, askBatchId: null, ...over }
}
const result = (orderId: string, over: Partial<UrgencyAnswer['results'][number]> = {}): UrgencyAnswer['results'][number] => ({ orderId, number: BRAND_BETA.numbers.order, customerRef: null, outcome: 'DONE', done: true, words: null, ask: null, urgency: 'URGENT', urgentRank: 3, asked: null, ...over })

describe('the bar on the first pick (L25: at most five actions, More ▾, at most 50)', () => {
  it('count, Select all, the marks and Move to top, then More ▾ Report a problem · Download files · Export', () => {
    const bar = bulkBarOf(pick('b3', 'b4'), ROWS.length, FACTS, en)
    expect(bar.count).toBe(2)
    expect(bar.selectAll).toBe('Select all 7')
    expect(bar.actions.map((action) => action.id)).toEqual(['URGENT', 'REGULAR', 'TOP'])
    expect(bar.actions.length).toBeLessThanOrEqual(5)
    expect(bar.more.map((action) => action.id)).toEqual(['REPORT', 'FILES', 'EXPORT'])
    expect(bulkBarOf(ROWS, ROWS.length, FACTS, en).selectAll).toBeNull()
  })

  it('each action held with its words: all urgent, all regular, Move to top on Regular rows says "Mark urgent first"', () => {
    const regular = bulkBarOf(pick('b3', 'b4'), ROWS.length, FACTS, en)
    expect(regular.actions.find((action) => action.id === 'URGENT')?.held).toBeNull()
    expect(regular.actions.find((action) => action.id === 'REGULAR')?.held).toBe('The orders you picked are regular already.')
    expect(regular.actions.find((action) => action.id === 'TOP')?.held).toBe('Mark urgent first: Move to top changes the order of your urgent orders only.')
    const urgent = bulkBarOf(pick('b1', 'b2'), ROWS.length, FACTS, en)
    expect(urgent.actions.find((action) => action.id === 'URGENT')?.held).toBe('The orders you picked are urgent already.')
    expect(urgent.actions.find((action) => action.id === 'TOP')?.held).toBeNull()
  })

  it('63 picked: every action held "You picked 63. At most 50 at a time."; a preview and no connection hold them too', () => {
    const many = Array.from({ length: 63 }, (_, index) => row(`m${index}`, index + 10))
    const bar = bulkBarOf(many, many.length, FACTS, en)
    expect(BULK_MAX).toBe(50)
    for (const action of [...bar.actions, ...bar.more]) expect(action.held, action.id).toBe('You picked 63. At most 50 at a time.')
    expect(bulkBarOf(pick('b3'), ROWS.length, { ...FACTS, preview: true }, en).actions[0]?.held).toBe('A preview reads only.')
    expect(bulkBarOf(pick('b3'), ROWS.length, { ...FACTS, offline: true }, it_).more.find((action) => action.id === 'REPORT')?.held).toBe('Nessuna connessione: riprovate quando tornate online.')
  })

  it('urgency off or a role that may not mark: no mark and no Move to top drawn; Report and Download files by right; Export always', () => {
    expect(bulkBarOf(pick('b3'), ROWS.length, { ...FACTS, urgencyOn: false }, en).actions).toEqual([])
    expect(bulkBarOf(pick('b3'), ROWS.length, { ...FACTS, mayMark: false }, en).actions).toEqual([])
    expect(bulkBarOf(pick('b3'), ROWS.length, { ...FACTS, mayReport: false, mayFiles: false }, en).more.map((action) => action.id)).toEqual(['EXPORT'])
  })

  it('a phone keeps Mark urgent and Mark regular; Move to top joins More ▾ first', () => {
    const phone = phoneBarOf(bulkBarOf(pick('b1', 'b3'), ROWS.length, FACTS, en))
    expect(phone.actions.map((action) => action.id)).toEqual(['URGENT', 'REGULAR'])
    expect(phone.more.map((action) => action.id)).toEqual(['TOP', 'REPORT', 'FILES', 'EXPORT'])
  })

  it('the selection keeps only rows still in the list, in the list’s order', () => {
    expect(keepPicked(['b4', 'gone', 'b1'], ROWS)).toEqual(['b4', 'b1'])
    expect(pickedRowsOf(ROWS, ['b4', 'b1']).map((item) => item.id)).toEqual(['b1', 'b4'])
  })
})

describe('the review before Send names each order and what will happen', () => {
  it('Mark urgent: inside the quota at once (its own place), over it or from Cutting asked of us, our lock and an ask held, urgent ones stay', () => {
    const review = markReviewOf(pick('b2', 'b3', 'b4', 'b5', 'b6', 'b7'), 'URGENT', USE, FACTS, 'en', en)
    expect(review.rows.map((entry) => [entry.id, entry.will, entry.next])).toEqual([
      ['b2', 'SAME', 'Stays as it is'],
      ['b3', 'NOW', 'Urgent 3'],
      ['b4', 'ASK_QUOTA', 'Urgent – asked'],
      ['b5', 'ASK_CUT', 'Urgent – asked'],
      ['b6', 'CANNOT', 'Stays as it is'],
      ['b7', 'CANNOT', 'Stays as it is'],
    ])
    expect(review.rows.find((entry) => entry.id === 'b4')?.note).toBe('Over your limit (3 urgent): asked of us, we answer you.')
    expect(review.rows.find((entry) => entry.id === 'b5')?.note).toBe('Cutting has started on this order: asked of us, we answer you.')
    expect(review.rows.find((entry) => entry.id === 'b6')?.note).toBe('Set to Regular by us: material not in')
    expect(review.rows.find((entry) => entry.id === 'b7')?.note).toBe('You asked us to make it urgent: we answer you soon.')
    expect(review.send).toEqual(['b3', 'b4', 'b5'])
    expect(review.counts).toEqual({ now: 1, asked: 2, same: 1, cannot: 2 })
    expect(reviewTitleOf(review, en)).toBe('Mark 6 orders urgent')
    expect(reviewSaveOf(review, en)).toBe('Mark 1 · ask 2')
    expect(reviewLeadOf(review, USE, en)).toBe('You may mark 1 more order urgent at once (2 of 3 used). Over that, or once cutting has started, the order is asked of us and we answer each one.')
    expect(reviewHeldOf(review, FACTS, en)).toBeNull()
  })

  it('a role that may not ask: over the quota and from Cutting it cannot, with why; nothing to send holds Send', () => {
    const review = markReviewOf(pick('b4', 'b5'), 'URGENT', { ...USE, used: 3, left: 0 }, { mayAsk: false }, 'en', en)
    expect(review.rows.map((entry) => entry.will)).toEqual(['CANNOT', 'CANNOT'])
    expect(review.rows[0]?.note).toBe('3 of 3 urgent used. Set one back to Regular first.')
    expect(review.rows[1]?.note).toBe('Cutting has started on this order. Asking us needs the Buyer or Production role.')
    expect(reviewHeldOf(review, FACTS, en)).toBe('Nothing to send: each order you picked is as it should be already, or cannot change now.')
  })

  it('Mark regular: always free for an urgent order; a regular one stays', () => {
    const review = markReviewOf(pick('b1', 'b3'), 'REGULAR', USE, FACTS, 'en', en)
    expect(review.rows.map((entry) => [entry.will, entry.next])).toEqual([
      ['NOW', 'Regular'],
      ['SAME', 'Stays as it is'],
    ])
    expect(review.send).toEqual(['b1'])
    expect(reviewSaveOf(review, en)).toBe('Mark 1 regular')
    expect(reviewSaveOf(review, it_)).toBe('Segna 1 normale')
  })

  it('Move to top: the picked urgent orders first in their order, the others after; a Regular row says "Mark urgent first"', () => {
    const rows = [row('u1', 1, { urgency: URGENT(1) }), row('u2', 2, { urgency: URGENT(2) }), row('u3', 3, { urgency: URGENT(3) }), row('r4', 4)]
    const review = topReviewOf(pickedRowsOf(rows, ['u3', 'u2', 'r4']), rows, 'en', en)
    expect(review.order).toEqual(['u2', 'u3', 'u1'])
    expect(review.rows.map((entry) => [entry.id, entry.will, entry.next])).toEqual([
      ['u2', 'NOW', 'Urgent 1'],
      ['u3', 'NOW', 'Urgent 2'],
      ['r4', 'CANNOT', 'Stays as it is'],
    ])
    expect(review.rows[2]?.note).toBe('Mark urgent first: Move to top changes the order of your urgent orders only.')
    const top = topReviewOf(pickedRowsOf(rows, ['u1']), rows, 'en', en)
    expect(top.order).toBeNull()
    expect(top.rows[0]?.note).toBe('At the top already.')
    expect(reviewHeldOf(top, FACTS, en)).toBe('Nothing to send: each order you picked is as it should be already, or cannot change now.')
  })
})

describe('after Send: one result per row, Undo', () => {
  it('done with its own place, asked of us, refused in its words, an id not in the answer "not found"; the Done line counts', () => {
    const review = markReviewOf(pick('b2', 'b3', 'b4', 'b5'), 'URGENT', USE, FACTS, 'en', en)
    const outcome = outcomeOf(
      review,
      answer({
        askBatchId: 'asks-1',
        results: [
          result('b3', { urgentRank: 3 }),
          result('b4', { done: false, outcome: 'ASK_OVER_QUOTA', urgency: null, urgentRank: null, asked: { requestId: 'r-1', words: w('Asked: we answer you.') } }),
        ],
      }),
      'en',
      en,
    )
    expect(outcome.results.b2).toEqual({ ok: false, words: 'Not sent: Urgent already.', tone: 'neutral' })
    expect(outcome.results.b3).toEqual({ ok: true, words: 'Urgent 3', tone: 'success' })
    expect(outcome.results.b4).toEqual({ ok: true, words: 'Asked of us: we answer you.', tone: 'info' })
    expect(outcome.results.b5).toEqual({ ok: false, words: 'Not found among your orders in production.', tone: 'danger' })
    expect(outcome.undo).toEqual({ batchId: 'batch-1', askBatchId: 'asks-1' })
    expect(doneLineOf(outcome, en)).toEqual({ line: '1 done · 1 asked of us · 1 not done', tone: 'warning' })
    expect(doneLineOf(outcome, it_).line).toBe('1 fatto · 1 chiesto a noi · 1 non fatto')
  })

  it('nothing changed and nothing asked (409): each row in our words at its place; no answer: the review stays and Send tries again', () => {
    const review = markReviewOf(pick('b3', 'b5'), 'URGENT', USE, FACTS, 'en', en)
    const refused = refusedOutcomeOf(review, conflict(['body/orderIds/0/LOCKED', 'body/orderIds/1/WAITING']), en)
    expect(refused.problem).toBeNull()
    expect(refused.outcome?.results.b3?.words).toBe('We set this order to Regular: it stays Regular for now.')
    expect(refused.outcome?.results.b5?.words).toBe('This could not be asked for this order.')
    expect(refused.outcome?.undo).toBeNull()
    expect(refusedOutcomeOf(review, new ApiError('unavailable', 503, 'unavailable', 'down', null, []), en)).toEqual({ outcome: null, problem: 'Not sent: we could not be reached. Send again: nothing is done twice.' })
  })

  it('a new order refused because the list changed says so on each row (never who)', () => {
    const rows = [row('u1', 1, { urgency: URGENT(1) }), row('u2', 2, { urgency: URGENT(2) })]
    const review = topReviewOf(pickedRowsOf(rows, ['u2']), rows, 'en', en)
    const refused = refusedOutcomeOf(review, conflict(['body/orderIds/CHANGED_SINCE/US/10:42']), en)
    expect(refused.outcome?.results.u2?.words).toBe('Your urgent orders changed since you opened this: read the list again.')
  })

  it('Undo: the urgency put back (and what changed since is left), what was asked of us withdrawn', () => {
    const undone: UndoAnswer = { ...answer(), undone: 'batch-1', skipped: [{ orderId: 'b3', number: BRAND_BETA.numbers.order, customerRef: null, words: w('Changed since') }] }
    const withdrawn: WithdrawAnswer = {
      batchId: 'asks-1',
      results: [
        { requestId: 'r-1', orderId: 'b4', number: BRAND_BETA.numbers.order, customerRef: null, kind: 'RUSH', done: true, outcome: 'WITHDRAWN', words: w('Withdrawn.') },
        { requestId: 'r-2', orderId: 'b5', number: BRAND_BETA.numbers.order, customerRef: null, kind: 'RUSH', done: false, outcome: 'ANSWERED', words: w('Answered.') },
      ],
      replayed: false,
    }
    expect(undoLineOf(undone, withdrawn, en)).toBe('Put back; 1 order had changed since and is left as it is. 1 withdrawn; 1 left as they are: we had answered them already.')
    expect(undoLineOf(null, { ...withdrawn, results: withdrawn.results.slice(0, 1) }, en)).toBe('1 request asked of us is withdrawn.')
  })

  it('a single row (F-PR-11) that became "Urgent – asked" says so with Undo of the ask (B-PR-46a: 200, not 409)', () => {
    const notice = markedNotice(answer({ batchId: null, askBatchId: 'asks-9', results: [result('b4', { done: false, outcome: 'ASK_CUT', urgency: null, urgentRank: null, words: w('Cutting has started on this order: sent to us as "Urgent – asked": we answer you.'), asked: { requestId: 'r-9', words: w('Asked: we answer you.') } })] }), ROWS[3]!, 'en', en)
    expect(notice).toEqual({ tone: 'info', words: `${BRAND_BETA.customerRef}-b4 · Your order 4: Cutting has started on this order: sent to us as "Urgent – asked": we answer you.`, undoAsks: 'asks-9' })
  })

  it('the mark’s answer parses with and without the asked rows', () => {
    expect(urgencyAnswerSchema.parse({ batchId: null, results: [result('b4', { asked: { requestId: 'r-1', words: w('x') } })], notFound: 1, use: null, replayed: false, askBatchId: 'asks-1' }).askBatchId).toBe('asks-1')
    const old = urgencyAnswerSchema.parse({ batchId: 'b', results: [{ ...result('b3'), asked: undefined }], notFound: 0, use: null, replayed: false })
    expect(old.askBatchId).toBeUndefined()
  })
})

describe('More ▾: Report a problem, Download files, Export', () => {
  it('Report a problem names each picked order by its own name (THE F-PR-24 dialog holds Send over 50)', () => {
    expect(problemOrdersOfRows(pick('b3', 'b4'), 'en', en)).toEqual([
      { id: 'b3', name: `${BRAND_BETA.customerRef}-b3 · Your order 3` },
      { id: 'b4', name: `${BRAND_BETA.customerRef}-b4 · Your order 4` },
    ])
  })

  it('Download files: one POST with the picked ids; refusals in the API’s words; the zip’s name is ours, never the office’s series', async () => {
    const calls: unknown[] = []
    const api = { bytes: async (path: string, options: unknown) => (calls.push({ path, options }), new Uint8Array([80, 75])) } as unknown as ApiClient
    await downloadFilesZip(api, ['b3', 'b4'])
    expect(calls).toEqual([{ path: '/portal/production/files/zip', options: { method: 'POST', body: { orderIds: ['b3', 'b4'] } } }])
    const none = conflict(['problem/NOTHING_TO_ZIP'])
    expect(zipProblemOf(none, it_)).toBe('Per questi ordini non ci sono ancora file da scaricare.')
    expect(zipProblemOf(conflict(['problem/TOO_MANY_FILES']), en)).toBe('A zip holds at most 400 files: pick fewer orders.')
    expect(zipProblemOf(conflict(['body/orderIds'], 'not_found'), en)).toBe('We could not find the orders you picked.')
    expect(zipNameOf('2026-11-18', en)).toBe('My production files 2026-11-18.zip')
    expect(zipNameOf('2026-11-18', en)).not.toMatch(OFFICE_SERIES)
  })

  it('Export: the server’s file of the picked rows only (orderIds), in the person’s language; Undo of an ask: one POST', async () => {
    const calls: Array<{ path: string; options: { query?: Record<string, unknown> } }> = []
    const api = {
      bytes: async (path: string, options: { query?: Record<string, unknown> }) => (calls.push({ path, options }), new Uint8Array([1])),
      post: async (path: string, options: unknown) => (calls.push({ path, options: options as { query?: Record<string, unknown> } }), { batchId: 'asks-1', results: [], replayed: false }),
    } as unknown as ApiClient
    await downloadProduction(api, { chip: null, q: null, locale: 'it', orderIds: ['b3', 'b4'] })
    expect(calls[0]?.options.query).toMatchObject({ format: 'csv', locale: 'it', orderIds: 'b3,b4' })
    await withdrawAskBatch(api, 'asks-1', 'key-1')
    expect(calls[1]?.path).toBe('/portal/production/asks/asks-1/withdraw')
  })
})

// ---- the page as Brand Beta reads it (PW-11, PW-12) -----------------------------------------------------------------------------
function model(over: Partial<ProductionListModel> = {}): ProductionListModel {
  return { state: 'ready', read: list(), chip: null, q: '', prefix: `/p/${BRAND_BETA.code}`, updates: 0, offlineSince: null, mayMark: true, preview: false, busy: [], notice: null, collapsed: [], dialog: null, now: Date.parse('2026-11-18T10:00:00.000Z'), ...over }
}
const draw = (over: Partial<ProductionListModel> = {}, locale: Locale = 'en') => render(createElement(ProductionListView, { model: model(over), actions: { onSelect: () => undefined } }), locale)

function reviewModel(locale: Locale, done: boolean): BulkReviewModel {
  const words = t(locale)
  const review = markReviewOf(pick('b2', 'b3', 'b4', 'b5', 'b6'), 'URGENT', USE, FACTS, locale, words)
  const outcome = outcomeOf(review, answer({ askBatchId: 'asks-1', results: [result('b3'), result('b4', { done: false, asked: { requestId: 'r', words: w('x') } })] }), locale, words)
  return {
    title: reviewTitleOf(review, words),
    lead: reviewLeadOf(review, USE, words),
    rows: review.rows,
    needBy: { value: '', min: '2026-11-18' },
    phase: done ? 'done' : 'ready',
    results: done ? outcome.results : null,
    doneLine: done ? doneLineOf(outcome, words) : null,
    save: reviewSaveOf(review, words),
    held: null,
    problem: null,
    undo: done ? { busy: false } : null,
  }
}

describe('Brand Beta’s bar and review (PW-11, PW-12): its own orders, by its own names, nothing of Brand Alpha', () => {
  it('the bar on the first pick: Select all, the marks, More', () => {
    const picked = pick('b3', 'b4')
    const text = textOf(draw({ selected: picked.map((item) => item.id), bulk: bulkBarOf(picked, ROWS.length, FACTS, en) }))
    expect(text).toContain('Select all 7')
    expect(text).toContain('Mark urgent')
    expect(text).toContain('Mark regular')
    expect(text).toContain('More')
  })

  it('the review names each order with Now → New and why, then a result per row and Undo; no Alpha marker, no office series', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const done of [false, true]) {
        const html = draw({ selected: ['b2', 'b3'], bulk: null, review: reviewModel(locale, done) }, locale)
        const text = textOf(html)
        expect(text, `${locale} ${done}`).toContain(`${BRAND_BETA.customerRef}-b3`)
        expect(scanText(html, BRAND_ALPHA), `${locale} ${done}`).toEqual([])
        expect(html.match(OFFICE_SERIES)?.[0] ?? null, `${locale} ${done}`).toBeNull()
        expect(html).not.toContain(BRAND_BETA.numbers.order)
      }
    }
    const ready = textOf(draw({ review: reviewModel('en', false) }))
    expect(ready).toContain('Mark 5 orders urgent')
    expect(ready).toContain('Urgent 3')
    expect(ready).toContain('Cutting has started on this order: asked of us, we answer you.')
    expect(ready).toContain('Set to Regular by us: material not in')
    expect(ready).toContain('Needed by (optional)')
    expect(ready).toContain('Mark 1 · ask 2')
    const done = textOf(draw({ review: reviewModel('en', true) }))
    expect(done).toContain('1 done · 1 asked of us · 1 not done')
    expect(done).toContain('Undo')
  })
})

describe('the words', () => {
  it('the bulk words are "voi" in Italian and name no place in our plan', () => {
    const tu = /\b(tu|tuo|tua|tuoi|tue|ti|te|hai|puoi|sei|vuoi|devi|chiedi|segnalo)\b/i
    for (const [key, value] of Object.entries(CATALOGUE.it[NS] ?? {})) if (key.startsWith('bulk.')) expect(value, key).not.toMatch(tu)
  })

  it('bell and mail words of "set back to Regular by us" (and locked / unlocked) are the API’s, topic PRODUCTION, in both languages (B-PR-31)', () => {
    for (const key of ['portal.production.set_regular', 'portal.production.locked', 'portal.production.unlocked'] as const) {
      const template = PARTNER_MESSAGE_TEMPLATES[key]
      expect(template.topic, key).toBe('PRODUCTION')
      expect(template.en, key).toBeTruthy()
      expect(template.it, key).toBeTruthy()
    }
  })
})
