/**
 * FFS.8 — parseProcessingReport tests. The previous inline parser assumed the
 * legacy {processingReport.rows} shape and produced an EMPTY per-SKU breakdown
 * for JSON_LISTINGS_FEED (the format actually used) — these lock the real shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the DB + SP client so we can exercise reconcileFeedJob's control flow.
// The pure parser tests below touch neither; hoisted spies let us assert that
// the terminal fast path (FFS.9) returns persisted results WITHOUT calling SP-API.
const { findUnique, updateJob, getSpClient } = vi.hoisted(() => ({
  findUnique: vi.fn(), updateJob: vi.fn(), getSpClient: vi.fn(),
}))
vi.mock('../db.js', () => ({ default: { amazonFlatFileFeedJob: { findUnique, update: updateJob } } }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSpClient: getSpClient }))

import { gzipSync } from 'node:zlib'
import { parseProcessingReport, backoffMs, reconcileFeedJob, decodeReportBytes } from './amazon-flat-file-feed.service.js'

describe('parseProcessingReport — JSON_LISTINGS_FEED (issues[]/summary)', () => {
  const report = JSON.stringify({
    header: { sellerId: 'X', version: '2.0', feedId: '123' },
    issues: [
      { messageId: 1, sku: 'SKU-A', code: '90220', severity: 'ERROR', message: 'Missing attribute X' },
      { messageId: 2, sku: 'SKU-B', code: '5000', severity: 'WARNING', message: 'Image too small' },
      { code: '8541', severity: 'ERROR', message: 'Feed-level problem' }, // no sku
    ],
    summary: { errors: 1, warnings: 1, messagesProcessed: 3, messagesAccepted: 2, messagesInvalid: 1 },
  })

  it('tri-states per SKU + marks issue-free submitted SKUs as success', () => {
    const { perSku } = parseProcessingReport(report, ['SKU-A', 'SKU-B', 'SKU-C'])
    const by = Object.fromEntries(perSku.map((p) => [p.sku, p]))
    expect(by['SKU-A'].status).toBe('error')
    expect(by['SKU-A'].code).toBe('90220')
    expect(by['SKU-B'].status).toBe('warning')
    expect(by['SKU-C'].status).toBe('success') // issue-free → success
    expect(perSku).toHaveLength(3)
  })

  it('summary counts come from Amazon summary', () => {
    const { summary } = parseProcessingReport(report, ['SKU-A', 'SKU-B', 'SKU-C'])
    expect(summary.messagesProcessed).toBe(3)
    expect(summary.messagesSuccessful).toBe(2)
    expect(summary.messagesWithWarning).toBe(1)
    expect(summary.messagesWithError).toBe(1)
  })

  it('surfaces a feed-level (sku-less) error', () => {
    const { feedError } = parseProcessingReport(report, [])
    expect(feedError).toBe('Feed-level problem')
  })

  it('multiple issues on one SKU → worst severity wins + messages join', () => {
    const r = JSON.stringify({
      issues: [
        { sku: 'S', severity: 'WARNING', message: 'w1' },
        { sku: 'S', severity: 'ERROR', code: 'E1', message: 'e1' },
      ],
      summary: { messagesProcessed: 1, messagesInvalid: 1 },
    })
    const { perSku } = parseProcessingReport(r, ['S'])
    expect(perSku[0].status).toBe('error')
    expect(perSku[0].message).toContain('w1')
    expect(perSku[0].message).toContain('e1')
  })
})

describe('parseProcessingReport — fallbacks', () => {
  it('legacy {processingReport.rows} shape', () => {
    const r = JSON.stringify({ processingReport: { rows: [
      { sku: 'A', processingStatus: 'DONE', issues: [] },
      { sku: 'B', processingStatus: 'ERROR', issues: [{ code: 'X', severity: 'ERROR', message: 'bad' }] },
    ] } })
    const { perSku, summary } = parseProcessingReport(r)
    expect(perSku.find((p) => p.sku === 'A')!.status).toBe('success')
    expect(perSku.find((p) => p.sku === 'B')!.status).toBe('error')
    expect(summary.messagesWithError).toBe(1)
  })

  it('tab-delimited legacy report (best-effort)', () => {
    const tsv = ['sku\terror-code\terror-message', 'A\t\t', 'B\t8541\tMissing'].join('\n')
    const { perSku } = parseProcessingReport(tsv)
    expect(perSku.find((p) => p.sku === 'A')!.status).toBe('success')
    expect(perSku.find((p) => p.sku === 'B')!.status).toBe('error')
  })

  it('unparseable report → PENDING, not a false success (must re-poll)', () => {
    const { perSku, pending } = parseProcessingReport('<<not json or tsv>>', ['A', 'B'])
    expect(pending).toBe(true)
    expect(perSku).toHaveLength(0)
  })

  it('empty report → PENDING (Amazon returned DONE before writing the report)', () => {
    const { pending, perSku } = parseProcessingReport('', ['A', 'B'])
    expect(pending).toBe(true)
    expect(perSku).toHaveLength(0)
  })
})

// The DE-feed false-positive: Amazon returned DONE before the report was written,
// the old parser read that as "all accepted." An empty/early report must be
// PENDING; only a report that actually confirms acceptance counts as success.
describe('parseProcessingReport — pending vs confirmed (false-positive guard)', () => {
  it('issues:[] with NO summary → PENDING (report not finalized yet)', () => {
    const { pending } = parseProcessingReport(JSON.stringify({ issues: [] }), ['A', 'B'])
    expect(pending).toBe(true)
  })
  it('issues:[] WITH a confirming summary → genuine all-accepted (not pending)', () => {
    const r = JSON.stringify({ issues: [], summary: { messagesProcessed: 2, messagesAccepted: 2, messagesInvalid: 0 } })
    const { pending, summary, perSku } = parseProcessingReport(r, ['A', 'B'])
    expect(pending).toBeFalsy()
    expect(summary.messagesSuccessful).toBe(2)
    expect(perSku.every((p) => p.status === 'success')).toBe(true)
  })
  it('a real rejection report parses as errors (not pending)', () => {
    const r = JSON.stringify({
      issues: [{ sku: 'A', code: '90220', severity: 'ERROR', message: 'outer required' }],
      summary: { errors: 1, warnings: 0, messagesProcessed: 1, messagesAccepted: 0, messagesInvalid: 1 },
    })
    const { pending, summary } = parseProcessingReport(r, ['A'])
    expect(pending).toBeFalsy()
    expect(summary.messagesWithError).toBe(1)
    expect(summary.messagesSuccessful).toBe(0)
  })
})

// THE root cause: Amazon serves the processing report GZIP-compressed and we read
// it as plain text → garbled → unparseable → every feed looked "accepted".
describe('decodeReportBytes — gzip report decompression', () => {
  const reject = JSON.stringify({
    issues: [{ sku: 'A', code: '90220', severity: 'ERROR', message: 'outer required' }],
    summary: { errors: 1, warnings: 0, messagesProcessed: 1, messagesAccepted: 0, messagesInvalid: 1 },
  })

  it('gunzips a GZIP-declared body', () => {
    expect(decodeReportBytes(gzipSync(Buffer.from(reject)), 'GZIP')).toBe(reject)
  })
  it('gunzips by magic bytes (1f 8b) even when algorithm is absent', () => {
    expect(decodeReportBytes(gzipSync(Buffer.from(reject)), undefined)).toBe(reject)
  })
  it('returns plain (uncompressed) text unchanged', () => {
    expect(decodeReportBytes(Buffer.from(reject), undefined)).toBe(reject)
  })
  it('end-to-end: gzip bytes → decode → parse → REAL rejection (no false success)', () => {
    const text = decodeReportBytes(gzipSync(Buffer.from(reject)), 'GZIP')
    const { pending, summary } = parseProcessingReport(text, ['A'])
    expect(pending).toBeFalsy()
    expect(summary.messagesWithError).toBe(1)
    expect(summary.messagesSuccessful).toBe(0)
  })
})

describe('backoffMs', () => {
  it('increases with poll count and caps at 5 min', () => {
    expect(backoffMs(0)).toBe(25_000)
    expect(backoffMs(1)).toBeGreaterThan(backoffMs(0))
    expect(backoffMs(100)).toBe(300_000) // capped
  })
})

describe('reconcileFeedJob — terminal fast-path (FFS.9)', () => {
  beforeEach(() => {
    findUnique.mockReset()
    getSpClient.mockReset()
    updateJob.mockReset().mockResolvedValue({})
  })

  it('returns persisted results for a finished feed WITHOUT calling SP-API', async () => {
    findUnique.mockResolvedValue({
      id: 'j1', feedId: 'F-DONE', status: 'DONE',
      completedAt: new Date('2026-06-07T20:00:00Z'),
      perSkuResults: [{ sku: 'A', status: 'success' }, { sku: 'B', status: 'error', code: '90220' }],
      resultSummary: { messagesProcessed: 2, messagesSuccessful: 1, messagesWithWarning: 0, messagesWithError: 1 },
      errorMessage: null, skus: ['A', 'B'], pollCount: 4,
    })
    // If the fast path ever regressed and hit SP-API, this would surface it.
    getSpClient.mockImplementation(() => { throw new Error('SP-API must NOT be called for a finished feed') })

    const r = await reconcileFeedJob('F-DONE')
    expect(getSpClient).not.toHaveBeenCalled()
    expect(updateJob).not.toHaveBeenCalled()
    expect(r.processingStatus).toBe('DONE')
    expect(r.terminal).toBe(true)
    expect(r.changed).toBe(false)
    expect(r.results).toHaveLength(2)
    expect(r.summary?.messagesWithError).toBe(1)
  })

  it('still polls SP-API when the job has not yet reached a terminal state', async () => {
    findUnique.mockResolvedValue({
      id: 'j2', feedId: 'F-LIVE', status: 'IN_PROGRESS', completedAt: null,
      perSkuResults: null, resultSummary: null, errorMessage: null, skus: ['A'], pollCount: 0,
    })
    const callAPI = vi.fn().mockResolvedValue({ processingStatus: 'IN_PROGRESS', resultFeedDocumentId: null })
    getSpClient.mockResolvedValue({ callAPI })

    const r = await reconcileFeedJob('F-LIVE')
    expect(getSpClient).toHaveBeenCalledTimes(1)
    expect(callAPI).toHaveBeenCalledTimes(1) // getFeed only; no report download
    expect(r.processingStatus).toBe('IN_PROGRESS')
    expect(r.terminal).toBe(false)
  })
})
