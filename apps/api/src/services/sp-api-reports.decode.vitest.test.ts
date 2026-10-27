/**
 * Report documents as text (2026-10-27): the Content-Type charset when it names one, else UTF-8 when the bytes are
 * valid UTF-8, else Windows-1252 — and a gzipped Windows-1252 seller feedback report, downloaded through the SDK client
 * (a stand-in: nothing reaches Amazon), read end to end. Order ids and comments are made up.
 */
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ answers: [] as Array<() => unknown>, document: null as null | { bytes: Buffer; contentType: string } }))

vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./outbound-api-call-log.service.js', () => ({ recordGatewayCall: vi.fn(async () => {}) }))
vi.mock('./amazon-report-registry.service.js', () => ({
  startReportRun: vi.fn(async () => null), completeReportRun: vi.fn(async () => {}), failReportRun: vi.fn(async () => {}),
}))
vi.mock('../lib/amazon-sp-client.js', async () => {
  const { Readable } = await import('node:stream')
  return {
    getAmazonRegion: async () => 'eu',
    amazonSpClient: () => ({
      callAPI: vi.fn(async (req: any) => {
        const answer = h.answers.shift()
        if (!answer) throw new Error(`test: no answer queued for ${req.operation}`)
        return answer()
      }),
      downloadStream: vi.fn(async () => {
        if (!h.document) throw new Error('test: no document queued')
        return Object.assign(Readable.from([h.document.bytes]), { headers: { 'content-type': h.document.contentType } })
      }),
    }),
  }
})

import { decodeReportDocument, fetchSpApiReport } from './sp-api-reports.service.js'
import { parseSellerFeedbackReport } from './reviews/amazon-seller-feedback-report.js'

/** Text as Windows-1252 bytes: Latin-1 letters are the same byte; "€" is 0x80. */
const cp1252 = (text: string) => Buffer.concat(text.split('€').flatMap((part, i) => (i ? [Buffer.from([0x80]), Buffer.from(part, 'latin1')] : [Buffer.from(part, 'latin1')])))

beforeEach(() => { vi.useFakeTimers({ now: Date.UTC(2026, 9, 27, 6, 0, 0) }); h.answers = []; h.document = null })
afterEach(() => { vi.useRealTimers() })

describe('decodeReportDocument', () => {
  const text = 'Évaluation\tCommentaire: très lent, 20 € de port'

  it('reads UTF-8 bytes as UTF-8, and drops the byte-order mark', () => {
    expect(decodeReportDocument(Buffer.from(text, 'utf8'))).toBe(text)
    expect(decodeReportDocument(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]), 'text/plain')).toBe(text)
  })

  it('reads bytes that are not valid UTF-8 as Windows-1252 when the answer names no charset', () => {
    const bytes = cp1252(text)
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow()
    expect(decodeReportDocument(bytes)).toBe(text)
    expect(decodeReportDocument(bytes, 'text/plain')).toBe(text)
  })

  it('honours the charset the Content-Type names', () => {
    const bytes = cp1252(text)
    expect(decodeReportDocument(bytes, 'text/plain;charset=Cp1252')).toBe(text)
    expect(decodeReportDocument(bytes, 'text/plain; charset="windows-1252"')).toBe(text)
    expect(decodeReportDocument(cp1252('Bewertung für Lieferung'), 'text/plain; charset=ISO-8859-1')).toBe('Bewertung für Lieferung')
    // A UTF-8 label on bytes that are not UTF-8 would turn every letter into "�": read as Windows-1252 instead.
    expect(decodeReportDocument(bytes, 'text/plain; charset=UTF-8')).toBe(text)
    // A charset the decoder does not know: read the bytes as without one.
    expect(decodeReportDocument(bytes, 'text/plain; charset=x-no-such-charset')).toBe(text)
  })
})

describe('downloading a report document', () => {
  it('a gzipped Windows-1252 seller feedback report with an unknown header is read with its accents', async () => {
    // A stand-in header (Amazon publishes no Spanish header texts; Nexus reads unknown ones by what the columns hold).
    const report = [
      'Fecha\tCalificación\tComentarios\tTu respuesta\tNúmero de pedido\tCorreo electrónico del evaluador',
      '24/10/26\t1\tLlegó tarde y pagué 20 € de envío.\tLo sentimos mucho.\t000-0000000-0000001\tno-reply@amazon.com',
      '20/10/26\t3\t\t\t000-0000000-0000002\tno-reply@amazon.com',
      '',
    ].join('\r\n')
    h.document = { bytes: gzipSync(cp1252(report)), contentType: 'text/plain' }
    h.answers.push(
      () => ({ reportId: 'r-1' }),
      () => ({ processingStatus: 'DONE', reportDocumentId: 'doc-1' }),
      () => ({ reportDocumentId: 'doc-1', url: 'https://example.invalid/doc', compressionAlgorithm: 'GZIP' }),
    )
    const run = fetchSpApiReport<string>({ reportType: 'GET_SELLER_FEEDBACK_DATA', marketplaceId: 'A1RKKUPIHCS9HS', dataStartTime: new Date(0), dataEndTime: new Date() })
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await run
    expect(result.payload).toBe(report)

    const parsed = parseSellerFeedbackReport(result.payload, 'ES')
    expect(parsed.columnsFrom).toBe('contents')
    expect(parsed.skipped).toEqual([])
    expect(parsed.rows.map((r) => [r.amazonOrderId, r.rating, r.comment, r.response, r.postedAt.toISOString().slice(0, 10)])).toEqual([
      ['000-0000000-0000001', 1, 'Llegó tarde y pagué 20 € de envío.', 'Lo sentimos mucho.', '2026-10-24'],
      ['000-0000000-0000002', 3, '', null, '2026-10-20'],
    ])
  })
})
