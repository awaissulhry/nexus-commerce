/**
 * FFS.8 — parseProcessingReport tests. The previous inline parser assumed the
 * legacy {processingReport.rows} shape and produced an EMPTY per-SKU breakdown
 * for JSON_LISTINGS_FEED (the format actually used) — these lock the real shape.
 */
import { describe, it, expect } from 'vitest'
import { parseProcessingReport, backoffMs } from './amazon-flat-file-feed.service.js'

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

  it('unparseable report → submitted SKUs default to success (feed was accepted)', () => {
    const { perSku, summary } = parseProcessingReport('<<not json or tsv>>', ['A', 'B'])
    expect(perSku).toHaveLength(2)
    expect(perSku.every((p) => p.status === 'success')).toBe(true)
    expect(summary.messagesSuccessful).toBe(2)
  })

  it('empty report + no submitted SKUs → empty, zeroed summary', () => {
    const { perSku, summary } = parseProcessingReport('', [])
    expect(perSku).toHaveLength(0)
    expect(summary.messagesProcessed).toBe(0)
  })
})

describe('backoffMs', () => {
  it('increases with poll count and caps at 5 min', () => {
    expect(backoffMs(0)).toBe(25_000)
    expect(backoffMs(1)).toBeGreaterThan(backoffMs(0))
    expect(backoffMs(100)).toBe(300_000) // capped
  })
})
