/**
 * Amazon seller feedback (Reviews PR H) — reading Amazon's `GET_SELLER_FEEDBACK_DATA` report (columns, dates, stars),
 * keying and upserting its rows (a second read of the same report changes nothing), the fetch with Amazon mocked
 * (nothing reaches Amazon: `fetchSpApiReport` is replaced), the per-market state in words, and "Fetch now" held while
 * the deployment has seller feedback off. The database is an in-memory stand-in; nothing is written anywhere.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── In-memory stand-ins ─────────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, any>
const db = vi.hoisted(() => ({ reviews: [] as Row[], orders: [] as Row[], markets: [] as Row[], runs: [] as Row[], connections: [] as Row[], nextId: 1 }))

const inList = (value: unknown, cond: any) => (cond && typeof cond === 'object' && 'in' in cond ? cond.in.includes(value) : value === cond)

vi.mock('../../db.js', () => ({
  default: {
    review: {
      findMany: vi.fn(async ({ where }: any) => db.reviews.filter((r) => r.channel === where.channel && inList(r.externalReviewId, where.externalReviewId))),
      update: vi.fn(async ({ where, data }: any) => {
        const row = db.reviews.find((r) => r.id === where.id)!
        Object.assign(row, data)
        return row
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = db.reviews.filter((r) => r.channel === where.channel && inList(r.externalReviewId, where.externalReviewId) && (where.triageStatus === undefined || r.triageStatus === where.triageStatus))
        for (const r of rows) Object.assign(r, data)
        return { count: rows.length }
      }),
    },
    order: {
      findMany: vi.fn(async ({ where }: any) => db.orders.filter((o) => o.channel === where.channel && inList(o.channelOrderId, where.channelOrderId))),
    },
    marketplace: { findMany: vi.fn(async () => db.markets) },
    amazonReportRun: { findMany: vi.fn(async () => db.runs) },
    channelConnection: { findMany: vi.fn(async () => db.connections) },
  },
}))

// The ingest pipeline stores new rows (its own tests cover sentiment, events and alerts).
vi.mock('./review-ingest.service.js', () => ({
  ingestRawReviews: vi.fn(async (raws: Row[], opts: { ingestSource: string }) => {
    for (const raw of raws) {
      if (db.reviews.some((r) => r.channel === raw.channel && r.externalReviewId === raw.externalReviewId)) continue
      db.reviews.push({
        id: `rev-${db.nextId++}`, channel: raw.channel, marketplace: raw.marketplace, externalReviewId: raw.externalReviewId, rating: raw.rating,
        body: raw.body, postedAt: new Date(raw.postedAt), rawPayload: raw.rawPayload, orderId: raw.orderId ?? null, kind: raw.kind ?? null,
        ingestSource: opts.ingestSource, triageStatus: null,
      })
    }
    return { mode: 'sandbox', marketplaces: [], reviewsSeen: raws.length, reviewsInserted: raws.length, reviewsSkippedExisting: 0, sentimentExtracted: 0, sentimentSkipped: 0, errors: [], notes: [] }
  }),
}))

// Amazon: never called. Each test says what the report call answers.
const amazon = vi.hoisted(() => ({ answer: null as null | (() => Promise<unknown>), calls: [] as Row[] }))
vi.mock('../sp-api-reports.service.js', () => {
  class SpApiReportError extends Error {
    constructor(message: string, readonly reportId: string, readonly abandoned: boolean) { super(message); this.name = 'SpApiReportError' }
  }
  return {
    SpApiReportError,
    fetchSpApiReport: vi.fn(async (args: Row) => {
      amazon.calls.push(args)
      if (!amazon.answer) throw new Error('Amazon must not be called in this test')
      return amazon.answer()
    }),
  }
})
vi.mock('../../utils/cron-observability.js', () => ({ recordCronRun: vi.fn(async (_name: string, handler: () => Promise<unknown>) => handler()) }))

import {
  feedbackExternalId, FeedbackReportShapeError, headerKey, marketFetchStates, parseFeedbackDate, parseFeedbackRating, parseSellerFeedbackReport,
  planFeedbackUpserts, SELLER_FEEDBACK_SOURCE, type FeedbackRunFact,
} from './amazon-seller-feedback-report.js'
import { logger } from '../../utils/logger.js'
import {
  fetchSellerFeedbackForMarket, readSellerFeedbackState, requestSellerFeedbackFetch, sellerFeedbackMarkets, upsertSellerFeedback,
} from './amazon-seller-feedback.service.js'
import { SpApiReportError } from '../sp-api-reports.service.js'

const SETTING_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/
const NOW = new Date('2026-10-27T10:00:00Z')

const HEADER = ['Date', 'Rating', 'Comments', 'Your Response', 'Order ID', 'Rater Email'].join('\t')
const line = (...cells: string[]) => cells.join('\t')
const REPORT = [
  `﻿${HEADER}`,
  line('25/10/2026', '2', 'The gloves arrived with an open seam on the thumb.', '', '028-1111111-1111111', 'no-reply@amazon.com'),
  line('19/10/2026', '1', '"Delivery a ""week"" late."', 'We are sorry, the courier lost a day.', '028-2222222-2222222', 'no-reply@amazon.com'),
  line('12/07/2026', '3', 'Ok but slow answers', '', '028-3333333-3333333', 'no-reply@amazon.com'),
  '',
].join('\r\n')

beforeEach(() => {
  db.reviews = []
  db.orders = []
  db.markets = []
  db.runs = []
  db.connections = []
  db.nextId = 1
  amazon.answer = null
  amazon.calls = []
  delete process.env.NEXUS_ENABLE_AMAZON_SELLER_FEEDBACK
})

// ── Reading the report ──────────────────────────────────────────────────────────────────────────────────────────

describe('report dates', () => {
  it('reads ISO dates, and day/month/year the way the market writes it', () => {
    expect(parseFeedbackDate('2026-10-25')?.toISOString()).toBe('2026-10-25T00:00:00.000Z')
    expect(parseFeedbackDate('2026-10-25T09:12:00Z')?.toISOString()).toBe('2026-10-25T09:12:00.000Z')
    expect(parseFeedbackDate('25/10/2026', 'IT')?.toISOString()).toBe('2026-10-25T00:00:00.000Z')
    expect(parseFeedbackDate('25.10.26', 'DE')?.toISOString()).toBe('2026-10-25T00:00:00.000Z')
    expect(parseFeedbackDate('05/10/26', 'FR')?.toISOString()).toBe('2026-10-05T00:00:00.000Z')
    expect(parseFeedbackDate('05/10/26', 'US')?.toISOString()).toBe('2026-05-10T00:00:00.000Z')
    // A part over 12 can be read only one way, whatever the market.
    expect(parseFeedbackDate('10/25/2026', 'IT')?.toISOString()).toBe('2026-10-25T00:00:00.000Z')
  })

  it('refuses what is not a real date', () => {
    for (const bad of ['31/02/2026', '2026-13-01', 'yesterday', '', '25/10', '1/2/345']) expect(parseFeedbackDate(bad, 'IT')).toBeNull()
  })
})

describe('report stars', () => {
  it('takes whole stars from 1 to 5 only', () => {
    expect(parseFeedbackRating('1')).toBe(1)
    expect(parseFeedbackRating(' 3.0 ')).toBe(3)
    expect(parseFeedbackRating('2,0')).toBe(2)
    for (const bad of ['0', '6', '2.5', 'two', '', null]) expect(parseFeedbackRating(bad)).toBeNull()
  })
})

describe('reading the report', () => {
  it('reads the columns Amazon documents, keys each row by its order, and never keeps the rater e-mail', () => {
    const { rows, skipped } = parseSellerFeedbackReport(REPORT, 'IT')
    expect(skipped).toEqual([])
    expect(rows.map((r) => r.externalReviewId)).toEqual([
      'amazon-feedback:028-1111111-1111111', 'amazon-feedback:028-2222222-2222222', 'amazon-feedback:028-3333333-3333333',
    ])
    expect(rows[1]).toMatchObject({ rating: 1, comment: 'Delivery a "week" late.', response: 'We are sorry, the courier lost a day.', amazonOrderId: '028-2222222-2222222' })
    expect(rows[0].response).toBeNull()
    expect(rows[2].postedAt.toISOString()).toBe('2026-07-12T00:00:00.000Z')
    expect(JSON.stringify(rows)).not.toMatch(/no-reply@amazon\.com/)
  })

  it('skips a line it cannot read, with the reason, and keeps the newest line of an order', () => {
    const text = [
      HEADER,
      line('not a date', '2', 'x', '', '028-4444444-4444444', ''),
      line('20/10/2026', '9', 'x', '', '028-5555555-5555555', ''),
      line('20/10/2026', '2', 'x', '', '', ''),
      line('20/10/2026', '2', 'first', '', '028-6666666-6666666', ''),
      line('22/10/2026', '3', 'second', '', '028-6666666-6666666', ''),
    ].join('\n')
    const { rows, skipped } = parseSellerFeedbackReport(text, 'IT')
    expect(skipped).toEqual([
      { line: 2, reason: 'The date “not a date” could not be read' },
      { line: 3, reason: 'No rating from 1 to 5' },
      { line: 4, reason: 'No order ID' },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ comment: 'second', rating: 3 })
  })

  it('refuses a file that is not this report, and reads an empty report as no feedback', () => {
    expect(() => parseSellerFeedbackReport('sku\tprice\nA\t1', 'IT')).toThrow(FeedbackReportShapeError)
    // "price" holds a 1, which could be stars; nothing holds a date or an order id.
    expect(() => parseSellerFeedbackReport('sku\tprice\nA\t1', 'IT')).toThrow(/no Date, Order ID column .* Columns seen: “sku”, “price”\.$/)
    expect(parseSellerFeedbackReport('', 'IT')).toEqual({ rows: [], skipped: [] })
    expect(parseSellerFeedbackReport(HEADER, 'IT')).toEqual({ rows: [], skipped: [] })
  })
})

// Amazon publishes the English header only (COLUMN_KEYS in amazon-seller-feedback-report.ts). These headers are
// stand-ins in each market's language — not Amazon's texts — with the date form Airbyte's connector reads for that
// market: the columns are found by what they hold, never by a guessed translation. Order ids and comments are made up.
const STAND_INS: Array<{ market: string; header: string[]; date: string; day: string; comment: string }> = [
  { market: 'IT', header: ['Data', 'Valutazione', 'Commenti', 'La tua risposta', 'Numero ordine', 'Email del valutatore'], date: '25/10/26', day: '2026-10-25', comment: 'Arrivato in ritardo, però la qualità è buona.' },
  { market: 'DE', header: ['Datum', 'Bewertung', 'Kommentare', 'Ihre Antwort', 'Bestellnummer', 'E-Mail des Bewerters'], date: '25.10.26', day: '2026-10-25', comment: 'Größe fällt klein aus.' },
  { market: 'FR', header: ['Date', 'Évaluation', 'Commentaires', 'Votre réponse', 'Numéro de commande', 'E-mail de l’évaluateur'], date: '05/10/26', day: '2026-10-05', comment: 'Colis abîmé à l’arrivée.' },
  { market: 'ES', header: ['Fecha', 'Calificación', 'Comentarios', 'Tu respuesta', 'Número de pedido', 'Correo del evaluador'], date: '05/10/26', day: '2026-10-05', comment: 'Llegó sin la etiqueta de tallas.' },
  { market: 'SE', header: ['Datum', 'Betyg', 'Kommentarer', 'Ditt svar', 'Ordernummer', 'Bedömarens e-post'], date: '2026-10-25', day: '2026-10-25', comment: 'Långsam leverans.' },
]

describe('reading the report in the market’s language', () => {
  it('folds accents and case in a header name', () => {
    expect(headerKey('Évaluation')).toBe('evaluation')
    expect(headerKey('Número de pedido')).toBe('numerodepedido')
    expect(headerKey(`${String.fromCharCode(0xfeff)}Order ID`)).toBe('orderid')
    expect(headerKey('Your Response')).toBe('yourresponse')
  })

  for (const s of STAND_INS) {
    it(`reads a ${s.market} report by what its columns hold`, () => {
      const text = [
        line(...s.header),
        line(s.date, '2', s.comment, 'Ci dispiace / Sorry.', '000-0000000-0000001', 'no-reply@amazon.com'),
        line(s.date, '1', '', '', '000-0000000-0000002', 'no-reply@amazon.com'),
        '',
      ].join('\r\n')
      const parsed = parseSellerFeedbackReport(text, s.market)
      expect(parsed.columnsFrom).toBe('contents')
      expect(parsed.skipped).toEqual([])
      expect(parsed.rows.map((r) => [r.amazonOrderId, r.rating, r.comment, r.response, r.postedAt.toISOString().slice(0, 10)])).toEqual([
        ['000-0000000-0000001', 2, s.comment, 'Ci dispiace / Sorry.', s.day],
        ['000-0000000-0000002', 1, '', null, s.day],
      ])
      expect(JSON.stringify(parsed.rows)).not.toMatch(/no-reply@amazon\.com/)
    })
  }

  it('reads columns in another order by their contents; the comment beside the stars, the response before the order id', () => {
    const text = [
      line('Sterne', 'Text', 'Antwort', 'Bestellung', 'Tag'),
      line('1', 'Kaputt angekommen.', 'Ersatz ist unterwegs.', '000-0000000-0000021', '20.10.26'),
      line('2', '', '', '000-0000000-0000022', '21.10.26'),
    ].join('\n')
    const { rows, columnsFrom } = parseSellerFeedbackReport(text, 'DE')
    expect(columnsFrom).toBe('contents')
    expect(rows.map((r) => [r.amazonOrderId, r.rating, r.comment, r.response, r.postedAt.toISOString().slice(0, 10)])).toEqual([
      ['000-0000000-0000022', 2, '', null, '2026-10-21'],
      ['000-0000000-0000021', 1, 'Kaputt angekommen.', 'Ersatz ist unterwegs.', '2026-10-20'],
    ])
  })

  it('a comment that is just a digit does not become the stars: Amazon’s documented order decides, when the column count fits', () => {
    const header = line('Kolumna 1', 'Kolumna 2', 'Kolumna 3', 'Kolumna 4', 'Kolumna 5', 'Kolumna 6')
    const row = line('24/10/26', '2', '3', '', '000-0000000-0000011', 'no-reply@amazon.com')
    const { rows } = parseSellerFeedbackReport(`${header}\n${row}`, 'PL')
    expect(rows[0]).toMatchObject({ rating: 2, comment: '3', amazonOrderId: '000-0000000-0000011' })
    // Four columns is not Amazon's layout: two columns could be the stars, so Nexus refuses rather than guess.
    expect(() => parseSellerFeedbackReport(`${line('A', 'B', 'C', 'D')}\n${line('24/10/26', '2', '3', '000-0000000-0000011')}`, 'PL')).toThrow(/no Rating column/)
  })

  it('a header line and no feedback line is no feedback, whatever the header says', () => {
    expect(parseSellerFeedbackReport(`${line(...STAND_INS[0].header)}\r\n`, 'IT')).toEqual({ rows: [], skipped: [] })
    expect(parseSellerFeedbackReport(`${line('Kolumna 1', 'Kolumna 2')}\n\n`, 'PL')).toEqual({ rows: [], skipped: [] })
  })

  it('a report it still cannot read names the column titles it saw, never a row’s values', () => {
    const text = [line('Spalte A', 'Spalte B', 'Spalte C'), line('gestern', 'sehr schlecht', 'irgendwas')].join('\n')
    let err: unknown
    try { parseSellerFeedbackReport(text, 'DE') } catch (e) { err = e }
    expect(err).toBeInstanceOf(FeedbackReportShapeError)
    expect((err as FeedbackReportShapeError).headers).toEqual(['Spalte A', 'Spalte B', 'Spalte C'])
    expect((err as Error).message).toBe('Amazon\'s feedback report has no Date, Rating, Order ID column Nexus could find by name or by its contents, so Nexus could not read it. Columns seen: “Spalte A”, “Spalte B”, “Spalte C”.')
    expect((err as Error).message).not.toMatch(/gestern|sehr schlecht|irgendwas/)
    // A first line that looks like values (a feedback line, not titles) is hidden in the message.
    const noTitles = [line('24/10/26', 'Bewertung', 'buyer@example.invalid'), line('kein Datum', 'viel', 'nichts')].join('\n')
    expect(() => parseSellerFeedbackReport(noTitles, 'DE')).toThrow(/Columns seen: “\(hidden\)”, “Bewertung”, “\(hidden\)”\.$/)
  })
})

// ── Upserts ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the upsert plan', () => {
  const { rows } = parseSellerFeedbackReport(REPORT, 'IT')
  const stored = (over: Row = {}) => rows.map((r, i) => ({
    id: `rev-${i}`, externalReviewId: r.externalReviewId, rating: r.rating, body: r.comment, orderId: null, triageStatus: null,
    rawPayload: { yourResponse: r.response }, ...over,
  }))

  it('creates what is new and plans nothing for a report it already holds', () => {
    const first = planFeedbackUpserts({ rows, stored: [], orderIds: new Map(), market: 'IT', reportId: 'r1' })
    expect(first.create).toHaveLength(3)
    const again = planFeedbackUpserts({ rows, stored: stored({ triageStatus: 'RESPONDED' }), orderIds: new Map(), market: 'IT', reportId: 'r2' })
    expect(again).toEqual({ create: [], update: [], unchanged: 3 })
  })

  it('updates a row when the report says something new: stars, a reply, the order', () => {
    const before = stored().map((s) => (s.externalReviewId === feedbackExternalId('028-2222222-2222222') ? { ...s, rawPayload: {} } : s))
    before[0] = { ...before[0], rating: 3 }
    const plan = planFeedbackUpserts({ rows, stored: before, orderIds: new Map([['028-3333333-3333333', 'order-3']]), market: 'IT', reportId: 'r2' })
    const by = (id: string) => plan.update.find((u) => u.id === id)!
    expect(by('rev-0').data).toMatchObject({ rating: 2 })
    expect(by('rev-1').data).toMatchObject({ triageStatus: 'RESPONDED', rawPayload: { yourResponse: 'We are sorry, the courier lost a day.' } })
    expect(by('rev-2').data).toEqual({ orderId: 'order-3' })
  })

  it('never reopens or overrides a row a person already closed', () => {
    const plan = planFeedbackUpserts({ rows, stored: stored({ triageStatus: 'RESOLVED', rawPayload: {} }), orderIds: new Map(), market: 'IT', reportId: 'r2' })
    for (const u of plan.update) expect(u.data.triageStatus).toBeUndefined()
  })
})

describe('storing a report', () => {
  it('stores seller feedback rows once: channel, kind, market, order link, stars, comment, date; a reply marks it responded', async () => {
    db.orders = [{ id: 'order-1', channel: 'AMAZON', channelOrderId: '028-1111111-1111111' }]
    const { rows } = parseSellerFeedbackReport(REPORT, 'IT')
    expect(await upsertSellerFeedback(rows, 'IT', 'r1', NOW)).toEqual({ created: 3, updated: 0, unchanged: 0 })
    expect(db.reviews).toHaveLength(3)
    const first = db.reviews.find((r) => r.externalReviewId === 'amazon-feedback:028-1111111-1111111')!
    expect(first).toMatchObject({ channel: 'AMAZON', kind: 'SELLER', marketplace: 'IT', ingestSource: SELLER_FEEDBACK_SOURCE, orderId: 'order-1', rating: 2, triageStatus: null })
    expect(first.postedAt.toISOString()).toBe('2026-10-25T00:00:00.000Z')
    expect(first.rawPayload).toMatchObject({ report: 'GET_SELLER_FEEDBACK_DATA', amazonOrderId: '028-1111111-1111111', yourResponse: null })
    expect(db.reviews.find((r) => r.externalReviewId === 'amazon-feedback:028-2222222-2222222')).toMatchObject({ triageStatus: 'RESPONDED' })

    // The same report again: nothing new, nothing changed.
    expect(await upsertSellerFeedback(rows, 'IT', 'r2', NOW)).toEqual({ created: 0, updated: 0, unchanged: 3 })
    expect(db.reviews).toHaveLength(3)
  })
})

// ── Fetching (Amazon mocked) ────────────────────────────────────────────────────────────────────────────────────

describe('fetching one market', () => {
  const IT = { code: 'IT', marketplaceId: 'APJ6JRA9NG5V4' }

  it('asks for the report for the market and the last 90 days, and stores what it holds', async () => {
    amazon.answer = async () => ({ reportId: 'rep-1', reportDocumentId: 'doc-1', payload: REPORT, region: 'eu', durationMs: 1 })
    const result = await fetchSellerFeedbackForMarket(IT, NOW)
    expect(result).toMatchObject({ market: 'IT', ok: true, reportRows: 3, created: 3, error: null })
    expect(amazon.calls[0]).toMatchObject({ reportType: 'GET_SELLER_FEEDBACK_DATA', marketplaceId: 'APJ6JRA9NG5V4' })
    expect((NOW.getTime() - amazon.calls[0].dataStartTime.getTime()) / 86_400_000).toBe(90)
  })

  it('reads a report Amazon cancelled for having no data as "no feedback", and a refusal as a failure', async () => {
    amazon.answer = async () => { throw new SpApiReportError('sp-api-reports: report rep-2 ended with terminal status CANCELLED', 'rep-2', false) }
    expect(await fetchSellerFeedbackForMarket(IT, NOW)).toMatchObject({ ok: true, created: 0, error: null })
    amazon.answer = async () => { throw new Error('createReport 403 Unauthorized: Access to requested resource is denied.') }
    const refused = await fetchSellerFeedbackForMarket(IT, NOW)
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/403/)
    expect(db.reviews).toHaveLength(0)
  })

  it('reads a report in the market’s language, and a header with no feedback line as no feedback', async () => {
    const s = STAND_INS[0]
    const report = (payload: string) => async () => ({ reportId: 'rep-3', reportDocumentId: 'doc-3', payload, region: 'eu', durationMs: 1 })
    amazon.answer = report([line(...s.header), line(s.date, '2', s.comment, '', '000-0000000-0000001', 'no-reply@amazon.com')].join('\n'))
    expect(await fetchSellerFeedbackForMarket(IT, NOW)).toMatchObject({ ok: true, reportRows: 1, created: 1, error: null })
    expect(db.reviews[0]).toMatchObject({ marketplace: 'IT', rating: 2, body: s.comment, externalReviewId: 'amazon-feedback:000-0000000-0000001' })
    amazon.answer = report(`${line(...s.header)}\r\n`)
    expect(await fetchSellerFeedbackForMarket(IT, NOW)).toMatchObject({ ok: true, reportRows: 0, created: 0, error: null })
  })

  it('a report it cannot read fails, and the log names its column titles, never a row', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      amazon.answer = async () => ({ reportId: 'rep-5', reportDocumentId: 'doc-5', payload: [line('Spalte A', 'Spalte B'), line('gestern', 'irgendwas')].join('\n'), region: 'eu', durationMs: 1 })
      const result = await fetchSellerFeedbackForMarket(IT, NOW)
      expect(result).toMatchObject({ ok: false, created: 0 })
      expect(result.error).toMatch(/Columns seen: “Spalte A”, “Spalte B”\.$/)
      expect(warn).toHaveBeenCalledWith('[amazon-seller-feedback] reading the report failed', expect.objectContaining({ market: 'IT', columns: ['Spalte A', 'Spalte B'] }))
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/gestern|irgendwas/)
    } finally {
      warn.mockRestore()
    }
  })

  it('reads only the active Amazon markets in Europe, with Amazon’s marketplace id', async () => {
    db.markets = [
      { code: 'IT', marketplaceId: 'APJ6JRA9NG5V4' }, { code: 'GB', marketplaceId: null }, { code: 'US', marketplaceId: 'ATVPDKIKX0DER' },
    ]
    expect(await sellerFeedbackMarkets()).toEqual([{ code: 'IT', marketplaceId: 'APJ6JRA9NG5V4' }, { code: 'UK', marketplaceId: 'A1F83G8C2ARO7P' }])
  })
})

// ── State and "Fetch now" ───────────────────────────────────────────────────────────────────────────────────────

describe('fetch state per market, in words', () => {
  const run = (marketplace: string, status: string, minutesAgo: number, over: Partial<FeedbackRunFact> = {}): FeedbackRunFact => ({
    marketplace, status, rowCount: null, errorMessage: null, requestedAt: new Date(NOW.getTime() - minutesAgo * 60_000), completedAt: null, ...over,
  })

  it('never, fetching, fetched, no feedback, refused, stopped', () => {
    const states = marketFetchStates(['IT', 'DE', 'FR', 'ES', 'UK', 'NL'], [
      run('APJ6JRA9NG5V4', 'DONE', 60, { rowCount: 7, completedAt: new Date(NOW.getTime() - 58 * 60_000) }),
      run('A1PA6795UKMFR9', 'IN_PROGRESS', 2),
      run('A13V1IB3VIYZZH', 'FATAL', 30, { errorMessage: 'sp-api-reports: report r ended with terminal status CANCELLED' }),
      run('A1RKKUPIHCS9HS', 'DONE', 3000, { rowCount: 2 }),
      run('A1RKKUPIHCS9HS', 'FATAL', 30, { errorMessage: 'HTTP 403 Unauthorized NEXUS_ENABLE_AMAZON_SELLER_FEEDBACK' }),
      run('A1F83G8C2ARO7P', 'IN_PROGRESS', 90),
    ], NOW)
    const by = (m: string) => states.find((s) => s.market === m)!
    expect(by('IT')).toMatchObject({ state: 'ok', rows: 7, words: 'Fetched 27 Oct, 09:02 UTC: 7 feedback of 1–3 stars in the last 90 days.' })
    expect(by('DE')).toMatchObject({ state: 'fetching' })
    expect(by('FR')).toMatchObject({ state: 'ok', rows: 0, words: 'Fetched 27 Oct, 09:30 UTC: no 1–3 star feedback in the last 90 days.' })
    expect(by('ES').state).toBe('failed')
    expect(by('ES').words).toMatch(/^Amazon refused: the Amazon connection needs the Selling Partner Insights or Amazon Fulfillment role\./)
    expect(by('ES').words).toMatch(/The last good fetch was 25 Oct/)
    expect(by('UK')).toMatchObject({ state: 'failed', words: 'The last fetch stopped without finishing. Nexus asks again at the next fetch.' })
    expect(by('NL')).toMatchObject({ state: 'never', lastFetchAt: null })
    for (const s of states) expect(s.words).not.toMatch(SETTING_NAME)
  })
})

describe('"Fetch now"', () => {
  it('is held, with its reason in words, while this setup does not fetch seller feedback — Amazon is never asked', async () => {
    db.markets = [{ code: 'IT', marketplaceId: 'APJ6JRA9NG5V4' }]
    db.connections = [{ isActive: true, authStatus: 'connected', isPrimary: true }]
    const answer = await requestSellerFeedbackFetch(NOW)
    expect(answer).toMatchObject({ ok: false, held: 'Nexus does not fetch Amazon seller feedback in this setup yet.' })
    expect(answer.state).toMatchObject({ on: false, canFetch: false, every: 'Daily 06:00 UTC' })
    expect(amazon.calls).toHaveLength(0)
  })

  it('is held when Amazon is not connected, and names where to fix it', async () => {
    process.env.NEXUS_ENABLE_AMAZON_SELLER_FEEDBACK = '1'
    db.markets = [{ code: 'IT', marketplaceId: 'APJ6JRA9NG5V4' }]
    db.connections = [{ isActive: true, authStatus: 'needs_reauth', isPrimary: true }]
    const state = await readSellerFeedbackState(NOW)
    expect(state).toMatchObject({ on: true, canFetch: false, fixHref: '/settings/channels/amazon' })
    expect(state.held).toMatch(/^Sign-in expired\./)
  })

  it('starts in the background when on, connected and a market exists', async () => {
    process.env.NEXUS_ENABLE_AMAZON_SELLER_FEEDBACK = '1'
    db.markets = [{ code: 'IT', marketplaceId: 'APJ6JRA9NG5V4' }]
    db.connections = [{ isActive: true, authStatus: 'connected', isPrimary: true }]
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    amazon.answer = async () => { await gate; return { reportId: 'rep-9', reportDocumentId: 'd', payload: REPORT, region: 'eu', durationMs: 1 } }
    const answer = await requestSellerFeedbackFetch(NOW)
    expect(answer).toMatchObject({ ok: true })
    if (answer.ok) expect(answer.words).toMatch(/^Nexus asked Amazon for the seller feedback report \(Italy\)/)
    // A second press while the first runs is held, not sent twice.
    const second = await requestSellerFeedbackFetch(NOW)
    expect(second.ok).toBe(false)
    release()
    await vi.waitFor(() => expect(db.reviews).toHaveLength(3))
    expect(amazon.calls).toHaveLength(1)
  })
})
