import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import type { ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import type { Locale } from '../../../../lib/i18n/locales'
import { render, textOf } from '../../../../lib/record-thread/parts/testing'
import { scanText } from '../../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../../lib/testing/two-brands'
import type { PartnerMessageRead } from '../../../shell/api'
import { documentsRead } from '../../orders/design-data'
import { orderWordsFor } from '../../orders/words'
import { productionOrderSchema, productionRowSchema, type ProblemState, type ProductionRow } from '../api'
import { NS } from '../model'
import { ProductionListView, type ProductionListModel } from '../view/ProductionListView'
import { fetchPointerSources, problemAnswerSchema, reportProblem, type ProblemAnswer } from './api'
import {
  excerptOf,
  orderFilesOf,
  pointerOptionsOf,
  problemBodyOf,
  problemChipOf,
  problemFailure,
  problemHeld,
  problemOrdersOf,
  problemOutcomeOf,
  PROBLEM_ORDERS_MAX,
  PROBLEM_TEXT_MAX,
  type ProblemFacts,
  type ProblemOrder,
} from './model'
import { ReportProblemDialog, type ReportProblemModel } from './view/ReportProblemDialog'

// The DS Modal draws in a portal once the page runs in the browser; on the server render of a test it is drawn in place.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), createElement('p', null, subtitle as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

/**
 * F-PR-24 — "Report a problem" and its state (production plan §1, §3 "Issues"; lead picks L24, L25; 17-web-r2 §1.6; review fixes
 * R-41, R-42, R-43; walls PW-12, PW-15, PW-17, PW-P02): one or more of the customer's own orders (at most 50), what is wrong
 * (required), for ONE order the file or message it is about (the line the message carries — never a re-typed measurement), Send =
 * one message in each order's thread (B-PR-45) with one key kept while the same report is sent again, not sent + Retry with the
 * text kept, the result per order by its own name (an id not its own only counted), and the chip "Waiting on us since 16 Nov" →
 * "Answered 17 Nov" → "Answered in your order 13" (the customer's own number or PO, never the office's series, never who). Every
 * name and number is made up.
 */

const words = (locale: Locale) => orderWordsFor(createTranslator(locale, CATALOGUE[locale][NS] ?? {}), locale)
const en = words('en')
const it_ = words('it')
const w = (text: string) => ({ it: text, en: text })
const B1: ProblemOrder = { id: 'b1b1b1b1-0000-4000-8000-000000000201', name: `${BRAND_BETA.customerRef} · Your order 4` }
const B2: ProblemOrder = { id: 'b1b1b1b1-0000-4000-8000-000000000202', name: 'Your order 5' }
const FACTS: ProblemFacts = { preview: false, offline: false, mayWrite: true, sending: false }
const OFFICE_SERIES = /\b(?:SO|INQ|QT|RQ|WO)-\d{4}-\d+/

function message(id: string, over: Partial<PartnerMessageRead> = {}): PartnerMessageRead {
  return { id, side: 'COMPANY', channel: 'PORTAL', author: { name: 'Pelletteria Esempio', mine: false }, body: 'We moved the cutting of the jackets to Thursday.', attachments: [], at: '2026-11-14T09:30:00.000Z', ...over }
}

function answer(over: Partial<ProblemAnswer> = {}): ProblemAnswer {
  return {
    batchId: 'batch-1',
    results: [
      { orderId: B1.id, number: BRAND_BETA.numbers.order, customerRef: BRAND_BETA.customerRef, done: true, words: null, problem: { state: 'WAITING_ON_US', since: '2026-11-16', words: w('Waiting on us since 16 Nov') } },
      { orderId: B2.id, number: 'SO-2026-0202', customerRef: null, done: false, words: { it: 'Questo ordine non è in produzione.', en: 'This order is not in production: write in its conversation.' }, problem: null },
    ],
    notFound: 1,
    replayed: false,
    ...over,
  }
}

describe('the orders a report names, and why Send waits', () => {
  it('each order once in the order picked; past 50 the report is held with the words (PW-12: at most 50 at a time)', () => {
    expect(problemOrdersOf([B1, B2, B1])).toEqual({ orders: [B1, B2], over: 0 })
    const many = Array.from({ length: 63 }, (_, index) => ({ id: `o-${index}`, name: `Your order ${index}` }))
    expect(problemOrdersOf(many).over).toBe(13)
    expect(PROBLEM_ORDERS_MAX).toBe(50)
    const held = problemHeld(FACTS, { orders: many, over: 13, text: 'The zips are the wrong colour.', pointer: null })
    expect(held).toEqual({ key: 'problem.held.tooMany', params: { count: 63, max: 50 } })
    expect(en.t(held!.key, held!.params)).toBe('You picked 63. At most 50 at a time.')
  })

  it('held in the order the person fixes it: a preview, no right to write, nothing picked, sending, offline, no words, too long', () => {
    const draft = { orders: [B1], over: 0, text: 'The zips are the wrong colour.', pointer: null }
    expect(problemHeld(FACTS, draft)).toBeNull()
    expect(problemHeld({ ...FACTS, preview: true }, draft)?.key).toBe('problem.held.preview')
    expect(problemHeld({ ...FACTS, mayWrite: false }, draft)?.key).toBe('problem.held.mayWrite')
    expect(problemHeld(FACTS, { ...draft, orders: [] })?.key).toBe('problem.held.none')
    expect(problemHeld({ ...FACTS, sending: true }, draft)?.key).toBe('problem.held.sending')
    expect(problemHeld({ ...FACTS, offline: true }, draft)?.key).toBe('problem.held.offline')
    expect(problemHeld(FACTS, { ...draft, text: '   ' })?.key).toBe('problem.held.empty')
    expect(problemHeld(FACTS, { ...draft, text: 'x'.repeat(PROBLEM_TEXT_MAX + 1) })).toEqual({ key: 'problem.held.long', params: { max: PROBLEM_TEXT_MAX } })
  })

  it('a refusal in our words, the text always kept; only a moment’s failure offers Retry (the same key: never a second message)', () => {
    const refused = (kind: 'conflict' | 'not_found' | 'forbidden' | 'invalid' | 'unavailable' | 'internal', status: number) => problemFailure(new ApiError(kind, status, kind, 'English for the logs', null, []))
    expect(refused('not_found', 404)).toEqual({ key: 'problem.failed.notFound', retry: false })
    expect(refused('forbidden', 403)).toEqual({ key: 'problem.failed.forbidden', retry: false })
    expect(refused('conflict', 409)).toEqual({ key: 'problem.failed.refused', retry: false })
    expect(refused('invalid', 400)).toEqual({ key: 'problem.failed.invalid', retry: false })
    expect(refused('unavailable', 503)).toEqual({ key: 'problem.failed.unavailable', retry: true })
    expect(refused('internal', 500)).toEqual({ key: 'problem.failed.unavailable', retry: true })
    expect(problemFailure(new TypeError('Failed to fetch'))).toEqual({ key: 'problem.failed.unavailable', retry: true })
    // The refusals never say another customer exists.
    for (const key of ['notFound', 'forbidden', 'refused', 'invalid', 'unavailable']) for (const locale of [en, it_]) expect(locale.t(`problem.failed.${key}`)).not.toMatch(/another|other customer|altro cliente|altri clienti/i)
  })
})

describe('what the message is about (ONE order): a file we shared, or a message of its conversation', () => {
  const sources = { files: documentsRead(), messages: [message('m-1'), message('m-2', { side: 'PARTNER', author: { name: 'Berta Becker', mine: true }, body: 'Please check the size chart again.', at: '2026-11-15T11:00:00.000Z' }), message('m-3', { erased: true, body: 'Message removed' })] }

  it('the current files newest first, then the messages newest first; a message removed after a privacy request is not offered', () => {
    const options = pointerOptionsOf(sources, 'en', en.t, en)
    const files = options.filter((option) => option.kind === 'file')
    const messages = options.filter((option) => option.kind === 'message')
    // documentsRead has five documents, one an earlier version: four current ones.
    expect(files).toHaveLength(4)
    expect(files.every((option) => option.id.startsWith('file:'))).toBe(true)
    expect(messages.map((option) => option.id)).toEqual(['message:m-1', 'message:m-2'])
    expect(messages[0]!.label).toMatch(/^Our message of .+: We moved the cutting/)
    expect(messages[1]!.label).toMatch(/^Your message of .+: Please check the size chart again\.$/)
  })

  it('the line each thread gets, in the person’s language, after what is wrong — never a measurement typed again', () => {
    const [file] = pointerOptionsOf(sources, 'it', it_.t, it_)
    expect(file!.line).toMatch(/^Riguarda il file: /)
    expect(problemBodyOf('  Le zip sono del colore sbagliato.  ', file!)).toBe(`Le zip sono del colore sbagliato.\n\n${file!.line}`)
    expect(problemBodyOf('Wrong zips.', null)).toBe('Wrong zips.')
    const [, , , , first] = pointerOptionsOf(sources, 'en', en.t, en)
    expect(first!.line).toMatch(/^About the message of .+: “We moved the cutting of the jackets to Thursday\.”$/)
    expect(excerptOf('a  b\n c', 10)).toBe('a b c')
    expect(excerptOf('x'.repeat(80), 60)).toHaveLength(60)
  })

  it('read for one order only, each source on its own: a source the person may not read is not asked; both failing is said', async () => {
    const asked: string[] = []
    const apiOf = (failing: readonly string[] = []) =>
      ({
        get: async (path: string, options: { schema: { parse: (value: unknown) => unknown } }) => {
          asked.push(path)
          if (failing.some((part) => path.includes(part))) throw new ApiError('unavailable', 503, 'unavailable', 'down', null, [])
          if (path === '/portal/customer-documents') return options.schema.parse(documentsRead())
          if (path === `/portal/threads/SalesOrder/${B1.id}`) return options.schema.parse({ record: { type: 'SalesOrder', id: B1.id, theirRef: BRAND_BETA.customerRef, ourRef: '#4', subtitle: null, status: null }, thread: { id: 't-1', status: 'OPEN' }, messages: [message('m-1')], nextCursor: null, composer: { canPost: true, reason: null, words: null, replyByEmail: false, hint: null } })
          throw new Error(`unexpected GET ${path}`)
        },
      }) as unknown as ApiClient
    const both = await fetchPointerSources(apiOf(), B1.id, { files: true, messages: true })
    expect(both.files?.items.length).toBeGreaterThan(0)
    expect(both.messages.map((entry) => entry.id)).toEqual(['m-1'])
    asked.length = 0
    const filesOnly = await fetchPointerSources(apiOf(), B1.id, { files: true, messages: false })
    expect(asked).toEqual(['/portal/customer-documents'])
    expect(filesOnly.messages).toEqual([])
    // One failing: the other is offered; both failing: said with Try again.
    expect((await fetchPointerSources(apiOf(['/portal/threads']), B1.id, { files: true, messages: true })).files).not.toBeNull()
    await expect(fetchPointerSources(apiOf(['/portal/threads', '/portal/customer-documents']), B1.id, { files: true, messages: true })).rejects.toThrow()
  })
})

describe('Send: one request, one message per order, the result per order by its own name', () => {
  it('POST /portal/production/problems with the orders and the words, and the Idempotency-Key it is given', async () => {
    const calls: { path: string; body: unknown; key: string | undefined }[] = []
    const api = {
      post: async (path: string, options: { body: unknown; idempotencyKey?: string; schema: { parse: (value: unknown) => unknown } }) => {
        calls.push({ path, body: options.body, key: options.idempotencyKey })
        return options.schema.parse(answer())
      },
    } as unknown as ApiClient
    const read = await reportProblem(api, { orderIds: [B1.id, B2.id], body: 'Wrong zips.' }, 'key-1')
    expect(calls).toEqual([{ path: '/portal/production/problems', body: { orderIds: [B1.id, B2.id], body: 'Wrong zips.' }, key: 'key-1' }])
    expect(read.notFound).toBe(1)
    expect(problemAnswerSchema.safeParse({ ...answer(), results: [{ ...answer().results[0]!, problem: { state: 'ANSWERED', since: '2026-11-16', words: w('x') } }] }).success).toBe(false)
  })

  it('PW-17 / PW-15: the result names its own orders by their own names; the office’s number and an id not its own never appear', () => {
    const outcome = problemOutcomeOf(answer(), [B1, B2], 'en', en.t)
    expect(outcome.sent).toEqual([{ id: B1.id, name: B1.name, since: '2026-11-16' }])
    expect(outcome.notSent).toEqual([{ id: B2.id, name: B2.name, words: 'This order is not in production: write in its conversation.' }])
    expect(outcome.notFound).toBe(1)
    for (const locale of ['it', 'en'] as const) {
      const html = render(createElement(ReportProblemDialog, { model: dialogModel({ phase: 'done', outcome: problemOutcomeOf(answer(), [B1, B2], locale, words(locale).t) }) }), locale)
      const text = textOf(html)
      expect(text).toContain(B1.name)
      expect(text).toMatch(locale === 'en' ? /Sent on 1 order/ : /Inviato su 1 ordine/)
      expect(text).toMatch(locale === 'en' ? /1 of the orders you picked could not be found\./ : /1 degli ordini che avete scelto non è stato trovato\./)
      expect(html.match(OFFICE_SERIES)?.[0] ?? null, locale).toBeNull()
      expect(scanText(html, BRAND_ALPHA), locale).toEqual([])
    }
  })
})

// ---- the dialog ----------------------------------------------------------------------------------------------------------------
function dialogModel(over: Partial<ReportProblemModel> = {}): ReportProblemModel {
  return { orders: [B1], over: 0, text: '', pointer: { state: 'ready', options: pointerOptionsOf({ files: documentsRead(), messages: [message('m-1')] }, 'en', en.t, en), chosen: null }, pointerAsked: true, phase: 'edit', failure: null, held: en.t('problem.held.empty'), outcome: null, ...over }
}
const drawDialog = (over: Partial<ReportProblemModel> = {}, locale: Locale = 'en') => render(createElement(ReportProblemDialog, { model: dialogModel(over) }), locale)

describe('the Report a problem dialog (it and en)', () => {
  it('one order: what is wrong (required), what it is about (a file or a message, optional), where we answer — no person named', () => {
    const html = drawDialog()
    const text = textOf(html)
    expect(text).toContain('Report a problem')
    expect(text).toContain(`About ${B1.name}`)
    expect(text).toContain('What is wrong?')
    expect(text).toContain('It is about (optional)')
    expect(html).toContain('label="Files we shared"')
    expect(html).toContain('label="Messages"')
    expect(text).toContain('Our message of')
    expect(text).toContain("We answer in this order's messages.")
    expect(text).not.toMatch(/supervisor|Pelletteria Esempio signs|signed by/i)
    const italian = textOf(drawDialog({}, 'it'))
    expect(italian).toContain('Segnala un problema')
    expect(italian).toContain('Che cosa non va?')
    expect(italian).toContain('Rispondiamo nei messaggi di questo ordine.')
  })

  it('many orders: each named, no pointer ("Pick one order to point to a file or a message")', () => {
    const text = textOf(drawDialog({ orders: [B1, B2], pointer: null }))
    expect(text).toContain('About 2 of your orders')
    expect(text).toContain(B2.name)
    expect(text).toContain('Pick one order to point to a file or a message.')
    expect(text).not.toContain('It is about (optional)')
    expect(text).toContain("We answer in the orders' messages.")
  })

  it('reading the pointers, could not read them + Try again, none to point to', () => {
    expect(textOf(drawDialog({ pointer: { state: 'loading', options: [], chosen: null } }))).toContain('It is about (optional)')
    const failed = textOf(drawDialog({ pointer: { state: 'error', options: [], chosen: null } }))
    expect(failed).toContain("The order's files and messages could not be read.")
    expect(failed).toContain('Try again')
    expect(textOf(drawDialog({ pointer: { state: 'ready', options: [], chosen: null } }))).toContain('No file or message on this order to point to yet.')
  })

  it('sending; not sent + Retry with the text kept; a refusal keeps the text without Retry', () => {
    expect(textOf(drawDialog({ text: 'Wrong zips.', phase: 'sending', held: en.t('problem.held.sending') }))).toContain('Sending…')
    const failed = drawDialog({ text: 'Wrong zips.', phase: 'failed', failure: { key: 'problem.failed.unavailable', retry: true }, held: null })
    expect(textOf(failed)).toContain('The message was not sent: we could not be reached.')
    expect(textOf(failed)).toContain('Your text is kept: nothing was lost.')
    expect(textOf(failed)).toContain('Try again')
    expect(failed).toContain('Wrong zips.')
    const refused = textOf(drawDialog({ text: 'Wrong zips.', phase: 'failed', failure: { key: 'problem.failed.refused', retry: false }, held: null }))
    expect(refused).toContain("write in each order's conversation")
    expect(refused).toContain('Send')
  })

  it('past 50 orders: said above the box, and Send is held with the same words', () => {
    const many = Array.from({ length: 51 }, (_, index) => ({ id: `o-${index}`, name: `Your order ${index}` }))
    expect(textOf(drawDialog({ orders: many, over: 1, pointer: null, held: en.t('problem.held.tooMany', { count: 51, max: 50 }) }))).toContain('You picked 51. At most 50 at a time.')
  })
})

// ---- the chip on the order and on its My production row ------------------------------------------------------------------------
describe('the chip: "Waiting on us since 16 Nov", then "Answered 17 Nov", "Answered in your order 13" — never who, never the office’s series', () => {
  const state = (over: Partial<ProblemState>): ProblemState => ({ state: 'WAITING_ON_US', since: '2026-11-16', on: null, inOrder: null, ...over })
  it('in both languages', () => {
    expect(problemChipOf(state({}), en.t, en.day)).toEqual({ tone: 'warning', text: `Problem reported · Waiting on us since ${en.day('2026-11-16')}` })
    expect(problemChipOf(state({}), it_.t, it_.day)?.text).toBe(`Problema segnalato · Tocca a noi dal ${it_.day('2026-11-16')}`)
    expect(problemChipOf(state({ state: 'ANSWERED', since: null, on: '2026-11-17' }), en.t, en.day)).toEqual({ tone: 'success', text: `Answered ${en.day('2026-11-17')}` })
    expect(problemChipOf(state({ state: 'ANSWERED', since: null, on: null }), it_.t, it_.day)?.text).toBe('Risposto')
    // The others of a batch answered in one order's thread: its own number, else its PO — the office's SO- never.
    const inOrder = { id: 'o-13', number: 'SO-2026-0213', customerRef: 'BETA-PO-0013', yourNumber: customerNumberOf('ORDER', 13) }
    expect(problemChipOf(state({ state: 'ANSWERED_IN', since: null, on: '2026-11-17', inOrder }), en.t, en.day)?.text).toBe('Answered in your order 13')
    expect(problemChipOf(state({ state: 'ANSWERED_IN', since: null, on: '2026-11-17', inOrder }), it_.t, it_.day)?.text).toBe('Risposto nel vostro ordine 13')
    expect(problemChipOf(state({ state: 'ANSWERED_IN', since: null, on: '2026-11-17', inOrder: { ...inOrder, yourNumber: null } }), en.t, en.day)?.text).toBe('Answered in BETA-PO-0013')
    expect(problemChipOf(state({ state: 'ANSWERED_IN', since: null, on: '2026-11-17', inOrder: { ...inOrder, yourNumber: null, customerRef: null } }), en.t, en.day)?.text).toBe(`Answered ${en.day('2026-11-17')}`)
    expect(problemChipOf(null, en.t, en.day)).toBeNull()
    expect(problemChipOf(undefined, en.t, en.day)).toBeNull()
  })

  it('the reads keep the state and the order it was answered in (the API’s own words, naming the office’s series, are dropped)', () => {
    const problem = { state: 'ANSWERED_IN', since: null, on: '2026-11-17', inOrder: { id: 'o-13', number: 'SO-2026-0213', customerRef: null, yourNumber: customerNumberOf('ORDER', 13) }, words: { it: 'Risposto in SO-2026-0213', en: 'Answered in SO-2026-0213' } }
    const parsed = productionRowSchema.shape.problem.parse(problem)
    expect(parsed).not.toHaveProperty('words')
    expect(productionOrderSchema.shape.problem.parse(null)).toBeNull()
    expect(productionOrderSchema.shape.problem.parse(undefined)).toBeUndefined()
  })
})

describe('the order’s files card: the newest three current files, "All in Documents (n)"; none: not drawn', () => {
  it('current versions only, newest first', () => {
    const files = orderFilesOf(documentsRead().items)
    expect(files.count).toBe(4)
    expect(files.shown).toHaveLength(3)
    expect(files.shown.every((item) => item.current)).toBe(true)
    expect([...files.shown].map((item) => item.date)).toEqual([...files.shown].map((item) => item.date).sort().reverse())
    expect(orderFilesOf([])).toEqual({ shown: [], count: 0 })
  })
})

// ---- My production: the row's chip and its ⋯ "Report a problem" ----------------------------------------------------------------
function row(id: string, over: Partial<ProductionRow> = {}): ProductionRow {
  return {
    id,
    customerRef: `${BRAND_BETA.customerRef}-${id}`,
    number: BRAND_BETA.numbers.order,
    yourNumber: customerNumberOf('ORDER', 4),
    orderedOn: '2026-10-05',
    styles: [{ code: BRAND_BETA.numbers.style, name: 'Rider jacket' }],
    pieces: 120,
    promiseDate: '2026-12-02',
    originalPromiseDate: null,
    promiseMoved: false,
    stage: { code: 'SEWING', words: { it: 'Cucitura', en: 'Sewing' }, since: '2026-11-10', next: null },
    health: null,
    waiting: { code: 'US', words: { it: 'Tocca a noi', en: 'Waiting on us' }, since: '2026-11-12' },
    marks: { onHold: false, paused: false, partlyShipped: false, changePending: false, words: [] },
    urgency: null,
    next: null,
    count: null,
    ...over,
  }
}
function listModel(over: Partial<ProductionListModel> = {}): ProductionListModel {
  const items = [row('b2', { problem: { state: 'WAITING_ON_US', since: '2026-11-16', on: null, inOrder: null } }), row('b3', { problem: { state: 'ANSWERED_IN', since: null, on: '2026-11-17', inOrder: { id: 'b2', number: 'SO-2026-0202', customerRef: null, yourNumber: customerNumberOf('ORDER', 4) } } }), row('b4')]
  return {
    state: 'ready',
    read: { asOf: '2026-11-17T09:42:00.000Z', level: 'STATUS', levelWords: w('Status only'), progressShared: false, urgencyOn: false, urgentUse: null, chip: 'ALL', chips: [{ chip: 'ALL', count: 3, words: w('All') }], count: 3, items, live: { events: [] } },
    chip: null,
    q: '',
    prefix: `/p/${BRAND_BETA.code}`,
    updates: 0,
    offlineSince: null,
    mayMark: false,
    preview: false,
    busy: [],
    notice: null,
    collapsed: [],
    dialog: null,
    now: Date.parse('2026-11-17T10:00:00.000Z'),
    report: { held: null },
    ...over,
  }
}

describe('My production: the row says the problem’s state; the dialog opens over the list (PW-P02, PW-15)', () => {
  it('Brand Beta’s rows and dialog hold nothing of Brand Alpha and never the office’s series', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = render(createElement(ProductionListView, { model: listModel({ problem: dialogModel({ orders: [B1, B2], pointer: null }) }) }), locale)
      expect(scanText(html, BRAND_ALPHA), locale).toEqual([])
      expect(html.match(OFFICE_SERIES)?.[0] ?? null, locale).toBeNull()
    }
    // No right to write to us: the dialog is never offered (the row's ⋯ draws no such item).
    expect(listModel({ report: null }).report).toBeNull()
  })

  it('the words exist in both languages with the same placeholders, Italian in "voi"', () => {
    const itWords = CATALOGUE.it[NS]!
    const enWords = CATALOGUE.en[NS]!
    const mine = Object.keys(enWords).filter((key) => key.startsWith('problem.') || key === 'row.report')
    expect(mine.length).toBeGreaterThan(40)
    for (const key of mine) {
      expect(itWords[key], key).toBeTruthy()
      expect((itWords[key]!.match(/\{\w+\}/g) ?? []).sort(), key).toEqual((enWords[key]!.match(/\{\w+\}/g) ?? []).sort())
      expect(itWords[key], key).not.toMatch(/\b(tu|tuo|tua|tuoi|tue|te|ti)\b/i)
      // Never a person of ours, a queue place or a supervisor (R-41).
      for (const value of [itWords[key]!, enWords[key]!]) expect(value, key).not.toMatch(/supervisor|supervisore|position|posizione|queue|coda/i)
    }
  })
})
