import { describe, expect, it } from 'vitest'
import {
  IMPORT_FIELDS, IMPORT_SOURCES, IMPORT_STEPS, canOpenStep, checkCounts, doneWords, fileKindOf, importBody, importWarnings, nextHeld,
  nextLabel, rejectsCsv, sampleValues, shownMapping, sizeWords, undoWords, type ImportPreview, type ImportState,
} from './importModel'

const preview = (over: Partial<ImportPreview> = {}): ImportPreview => ({
  headers: ['body', 'rating', 'reviewer_name', 'product_sku'], droppedColumns: ['reviewer_email', 'ip_address'], source: 'shopify_app',
  unknownProductRows: 17, unknownProductExamples: ['OP-XL-BLK2', 'X-2'], rejected: [{ line: 18, reasons: ['No review text'] }, { line: 57, reasons: ['Stars is “4,5”: use a whole number from 1 to 5'] }],
  detectedMapping: { body: 'body', rating: 'rating' }, appliedMapping: { body: 'body', rating: 'rating' }, channel: 'SHOPIFY',
  totalRows: 214, validRows: 209, invalidRows: 5, duplicateExisting: 23, duplicateInBatch: 0, willInsert: 186,
  sample: [
    { body: 'Beautiful stitching', title: null, rating: 5, authorName: 'Buyer A', marketplace: null, postedAt: '2026-10-02T00:00:00.000Z', errors: [], warnings: [] },
    { body: 'Zip broke', title: null, rating: 2, authorName: 'Buyer B', marketplace: null, postedAt: null, errors: [], warnings: [] },
  ],
  ...over,
})

const state = (over: Partial<ImportState> = {}): ImportState => ({
  step: 0, fileName: 'reviews.csv', source: 'shopify_app', market: null, preview: null, busy: false, canManage: true, ...over,
})

describe('Import reviews', () => {
  it('four steps; sources and fields as the board names them; review text is required', () => {
    expect(IMPORT_STEPS).toEqual(['File', 'Match columns', 'Check', 'Done'])
    expect(IMPORT_SOURCES.map((s) => s.title)).toEqual(['Amazon review export', 'Shopify review app', 'Etsy reviews', 'Another file'])
    expect(IMPORT_FIELDS.filter((f) => f.required).map((f) => f.key)).toEqual(['body'])
    expect(fileKindOf('Reviews.TSV')).toBe('tsv')
    expect(fileKindOf('notes.txt')).toBeNull()
    expect(sizeWords(48 * 1024)).toBe('48 KB')
  })

  it('each step says why it cannot go on: permission, file, source, market, review text, nothing new', () => {
    expect(nextHeld(state({ canManage: false }), {})).toBe("You need 'Manage reviews' to import reviews.")
    expect(nextHeld(state({ fileName: null }), {})).toBe('Pick a file first.')
    expect(nextHeld(state({ source: null }), {})).toBe('Say where the file is from first.')
    expect(nextHeld(state({ source: 'amazon' }), {})).toBe('Pick the market these reviews are from first.')
    expect(nextHeld(state({ source: 'amazon', market: 'IT' }), {})).toBeNull()
    expect(nextHeld(state({ busy: true }), {})).toMatch(/reading the file/)
    expect(nextHeld(state({ step: 1, preview: preview({ appliedMapping: {} }) }), {})).toMatch(/^Match the review text first/)
    expect(nextHeld(state({ step: 1, preview: preview({ appliedMapping: {} }) }), { body: 'body' })).toBeNull()
    expect(nextHeld(state({ step: 2, preview: preview({ willInsert: 0 }) }), {})).toMatch(/^Nothing new to import/)
  })

  it('the person’s mapping wins over Nexus’s guess; next labels count the rows', () => {
    expect(shownMapping(preview(), { rating: 'stars' })).toEqual({ body: 'body', rating: 'stars' })
    expect(nextLabel(1, preview())).toBe('Next: check 214 rows')
    expect(nextLabel(2, preview())).toBe('Import 186 reviews')
    expect(canOpenStep(0, 2)).toBe(true)
    expect(canOpenStep(2, 2)).toBe(false)
    expect(canOpenStep(1, 3)).toBe(false)
  })

  it('warnings in words: unknown SKUs import without a link; e-mail and IP are never imported', () => {
    const w = importWarnings(preview())
    expect(w[0].title).toBe('17 rows name a product Nexus does not know.')
    expect(w[0].body).toMatch(/for example OP-XL-BLK2, X-2/)
    expect(w[1].title).toBe('Not imported: reviewer_email, ip_address.')
    expect(importWarnings(preview({ unknownProductRows: 0, droppedColumns: [] }))).toEqual([])
  })

  it('the check counts and the rows that cannot import as a CSV', () => {
    expect(checkCounts(preview(), true).map((c) => `${c.label} ${c.value}`)).toEqual(['Rows in the file 214', 'Ready 186', 'Already in Nexus 23', 'Cannot import 5'])
    expect(rejectsCsv(preview().rejected)).toBe('Row,Why it cannot import\r\n18,No review text\r\n57,"Stars is “4,5”: use a whole number from 1 to 5"\r\n')
    expect(sampleValues(preview(), 'body')).toEqual(['Beautiful stitching', 'Zip broke'])
    expect(sampleValues(preview(), 'postedAt')).toEqual(['2026-10-02', '—'])
    expect(sampleValues(preview(), 'sku')).toEqual(['—', '—'])
  })

  it('the body sends the file as text or bytes, only the matched fields', () => {
    expect(importBody({ text: 'a,b', bytesBase64: null, fileKind: 'csv', source: 'other', market: 'IT', mapping: { body: 'a', title: '' }, includeUnlinked: false }))
      .toEqual({ text: 'a,b', fileKind: 'csv', source: 'other', marketplace: 'IT', columnMapping: { body: 'a' }, includeUnlinked: false })
    expect(importBody({ text: null, bytesBase64: 'QUJD', fileKind: 'xlsx', source: 'amazon', market: 'DE', mapping: {}, includeUnlinked: true }))
      .toMatchObject({ bytesBase64: 'QUJD', fileKind: 'xlsx' })
  })

  it('done and undo in words', () => {
    expect(doneWords({ batchId: 'b', imported: 186, parsed: 214, valid: 209, skippedInvalid: 5, skippedUnlinked: 0, summary: { reviewsInserted: 186, reviewsSkippedExisting: 23 } }))
      .toEqual({ title: '186 reviews imported', body: 'They are in the Inbox now, marked “Imported”. 23 were already there, 5 could not import. A reply to an imported review is posted by hand on the channel.' })
    expect(undoWords({ removed: 184, kept: [{ reason: 'Someone replied to it.' }, { reason: 'x' }] })).toBe('Removed 184 reviews of this import. Kept 2 that someone already worked on: Someone replied to it.')
    expect(undoWords({ removed: 1, kept: [] })).toBe('Removed 1 review of this import.')
  })
})
