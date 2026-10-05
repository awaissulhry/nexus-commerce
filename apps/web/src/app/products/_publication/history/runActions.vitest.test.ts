import { describe, expect, it } from 'vitest'
import type { HistoryProduct, HistoryRun } from '@nexus/shared/publication-history'
import {
  SHEET_LANDING_TTL_MS, failedSkus, filterProducts, historyDeepLinkPatch, listWords, orderProducts, parseHistoryDeepLink, productFilterCounts, requestSheetLanding,
  resultsCsv, productsAsShown, resultsFileName, runActionVisibility, runChangeLabel, runDestination, runHeadline, runListingLabel, runStatusMeta, runUndos,
  sentFieldsText, sheetFieldHints, sheetRowIdOf, takeSheetLanding,
} from './runActions'

const ZERO = { accepted: 0, verified: 0, failed: 0, waiting: 0, notSent: 0, skipped: 0, unknown: 0 }

function run(over: Partial<HistoryRun> = {}): HistoryRun {
  return {
    id: 'pub-1', source: 'studio', batchId: null, startedAt: '2026-10-01T10:00:00.000Z', finishedAt: '2026-10-01T10:05:00.000Z',
    state: 'succeeded', status: 'VERIFIED', kind: 'update', productId: 'fam', familySku: 'GALE', familyTitle: 'Gale',
    channel: 'EBAY', marketplace: 'IT', accountId: 'acc', accountLabel: 'Xavia', aliasKey: '', aliasLabel: null, fieldCount: 3,
    productCount: 23, counts: { ...ZERO, verified: 23 }, userId: 'u', userName: 'Dev Owner', reference: '1234', message: null,
    lastCheckedAt: null, needsCheck: false, checkedAt: null, checkedBy: null, ...over,
  }
}

function product(sku: string, result: HistoryProduct['result'], over: Partial<HistoryProduct> = {}): HistoryProduct {
  return {
    productId: `p-${sku}`, sku, variationLabel: null, result, message: null, code: null, fieldLabel: null, columnKey: null, columnHint: [],
    listingId: `l-${sku}`, externalId: null, sentFields: ['title'], issues: [], ...over,
  }
}

describe('productsAsShown — no promise of an answer that is not coming', () => {
  it('a run that needs a check shows its waiting products as "Result unknown"; others are untouched', () => {
    const items = [product('A', 'WAITING'), product('B', 'FAILED')]
    expect(productsAsShown(run({ state: 'needs_check', status: 'SUBMITTED' }), items).map(p => p.result)).toEqual(['UNKNOWN', 'FAILED'])
    expect(productsAsShown(run({ state: 'in_progress', status: 'SUBMITTED' }), items).map(p => p.result)).toEqual(['WAITING', 'FAILED'])
  })
})

describe('runListingLabel — the listing only when the source recorded it', () => {
  it('names the primary listing, an extra listing, or nothing at all', () => {
    expect(runListingLabel(run())).toBe('Primary listing')
    expect(runListingLabel(run({ aliasKey: 'alias-1', aliasLabel: 'IT-GALE' }))).toBe('IT-GALE')
    // The old flat-file pages never recorded the listing: saying "Primary listing" would be a guess.
    expect(runListingLabel(run({ source: 'ebay-flat-file', aliasKey: null }))).toBeNull()
  })
})

describe('runHeadline — one plain sentence for every state', () => {
  it('succeeded, all verified', () => {
    expect(runHeadline(run())).toBe('All 23 products were verified on eBay IT.')
  })
  it('succeeded, accepted (Amazon does not read back)', () => {
    expect(runHeadline(run({ channel: 'AMAZON', status: 'ACCEPTED', counts: { ...ZERO, accepted: 23 } }))).toBe('All 23 products were accepted on Amazon IT.')
  })
  it('succeeded with skipped products says so', () => {
    expect(runHeadline(run({ source: 'ebay-flat-file', status: 'DONE', productCount: 105, counts: { ...ZERO, accepted: 20, skipped: 85 } })))
      .toBe('20 of 105 products were accepted on eBay IT. 85 were skipped.')
  })
  it('partial: failed first, then accepted', () => {
    expect(runHeadline(run({ state: 'partial', status: 'PARTIAL', counts: { ...ZERO, failed: 2, accepted: 21 } })))
      .toBe('2 of 23 products failed on eBay IT. 21 were accepted.')
  })
  it('failed: nothing sent', () => {
    expect(runHeadline(run({ state: 'failed', status: 'FAILED', productCount: 4, counts: { ...ZERO, notSent: 4 } })))
      .toBe('Nothing was sent to eBay IT. A check failed before sending, so nothing changed on the channel.')
  })
  it('failed: all refused', () => {
    expect(runHeadline(run({ state: 'failed', status: 'FAILED', productCount: 1, counts: { ...ZERO, failed: 1 } }))).toBe('eBay IT refused all 1 product. Nothing was accepted.')
  })
  it('failed with no per-product rows uses the source message', () => {
    expect(runHeadline(run({ source: 'amazon-flat-file', state: 'failed', status: 'FATAL', productCount: 0, counts: ZERO, message: 'Amazon could not read the file.' })))
      .toBe('eBay IT refused this publish. Amazon could not read the file.')
  })
  it('in progress', () => {
    expect(runHeadline(run({ state: 'in_progress', status: 'SUBMITTED', finishedAt: null, counts: { ...ZERO, waiting: 23 } })))
      .toBe('eBay IT is still working on 23 products. This updates by itself.')
  })
  it('needs a check, not marked', () => {
    expect(runHeadline(run({ state: 'needs_check', status: 'SUBMITTED', needsCheck: true })))
      .toBe('eBay IT has not confirmed the result. It may have arrived. Check the listing on eBay before you publish again.')
  })
  it('needs a check, marked: says who and keeps the result unknown', () => {
    const text = runHeadline(run({ state: 'needs_check', status: 'SUBMITTED', checkedAt: '2026-10-01T12:00:00.000Z', checkedBy: 'Dev Owner' }))
    expect(text).toMatch(/^eBay IT never confirmed the result\. Marked as checked by Dev Owner on /)
  })
  it('photo runs talk about photos', () => {
    expect(runHeadline(run({ source: 'photos', kind: 'photos', productCount: 1, counts: { ...ZERO, accepted: 1 }, status: 'DONE' })))
      .toBe('All photos of 1 product were accepted on eBay IT.')
  })
  it('a store without a market is named by its channel only', () => {
    expect(runDestination(run({ channel: 'SHOPIFY', marketplace: 'GLOBAL' }))).toBe('Shopify')
  })
})

describe('runStatusMeta — never a raw source word', () => {
  it('product sheet runs use their publish status', () => {
    expect(runStatusMeta(run()).label).toBe('Verified')
    expect(runStatusMeta(run({ state: 'partial', status: 'PARTIAL' })).label).toBe('Partly failed')
  })
  it('older sources are labelled by state', () => {
    expect(runStatusMeta(run({ source: 'amazon-flat-file', state: 'failed', status: 'FATAL' })).label).toBe('Failed')
    expect(runStatusMeta(run({ source: 'ebay-flat-file', state: 'succeeded', status: 'DONE' })).label).toBe('Accepted')
    expect(runStatusMeta(run({ source: 'photos', state: 'in_progress', status: 'SUBMITTING' })).label).toBe('Waiting for channel')
  })
  it('needs_check is "Result unknown", also after it was marked as checked', () => {
    expect(runStatusMeta(run({ state: 'needs_check', status: 'SUBMITTED' })).label).toBe('Result unknown')
    expect(runStatusMeta(run({ state: 'needs_check', status: 'SUBMITTED', checkedAt: '2026-10-01T12:00:00.000Z' })).label).toBe('Result unknown')
  })
})

describe('runActionVisibility — source × state × permission', () => {
  const failed = [product('A', 'FAILED'), product('B', 'ACCEPTED')]
  const can = { canPublish: true, canOpenReview: true }
  it('check now: studio runs still waiting, with publish rights', () => {
    expect(runActionVisibility(run({ state: 'in_progress', status: 'SUBMITTED' }), can).checkNow).toBe(true)
    expect(runActionVisibility(run({ state: 'needs_check', status: 'SUBMITTED' }), can).checkNow).toBe(true)
    expect(runActionVisibility(run(), can).checkNow).toBe(false)
    expect(runActionVisibility(run({ source: 'amazon-flat-file', state: 'in_progress', status: 'IN_PROGRESS' }), can).checkNow).toBe(false)
    expect(runActionVisibility(run({ state: 'in_progress', status: 'SUBMITTED' }), { ...can, canPublish: false }).checkNow).toBe(false)
    expect(runActionVisibility(run({ state: 'needs_check', status: 'SUBMITTED', checkedAt: '2026-10-01T12:00:00.000Z' }), can).checkNow).toBe(false)
  })
  it('mark as checked: studio needs_check only, once, with publish rights', () => {
    expect(runActionVisibility(run({ state: 'needs_check', status: 'SUBMITTED' }), can).markChecked).toBe(true)
    expect(runActionVisibility(run({ state: 'in_progress', status: 'SUBMITTED' }), can).markChecked).toBe(false)
    expect(runActionVisibility(run({ state: 'needs_check', status: 'SUBMITTED', checkedAt: '2026-10-01T12:00:00.000Z' }), can).markChecked).toBe(false)
    expect(runActionVisibility(run({ source: 'ebay-flat-file', state: 'needs_check', status: 'RUNNING' }), can).markChecked).toBe(false)
    expect(runActionVisibility(run({ state: 'needs_check', status: 'SUBMITTED' }), { ...can, canPublish: false }).markChecked).toBe(false)
  })
  it('publish again: settled studio runs with failed products; a surface that cannot open the review says so', () => {
    const partial = run({ state: 'partial', status: 'PARTIAL', counts: { ...ZERO, failed: 1, accepted: 1 } })
    expect(runActionVisibility(partial, can, failed).publishAgain).toBe(true)
    const noReview = runActionVisibility(partial, { ...can, canOpenReview: false }, failed)
    expect(noReview.publishAgain).toBe(false)
    expect(noReview.publishAgainUnavailable).toBe(true)
    expect(runActionVisibility(run(), can, [product('A', 'VERIFIED')]).publishAgain).toBe(false)
    expect(runActionVisibility(run({ source: 'ebay-flat-file', state: 'partial', status: 'PARTIAL', counts: { ...ZERO, failed: 1 } }), can, failed).publishAgain).toBe(false)
    expect(runActionVisibility(partial, { ...can, canPublish: false }, failed).publishAgainUnavailable).toBe(false)
  })
  it('download and copy follow the products', () => {
    expect(runActionVisibility(run(), can, []).download).toBe(false)
    expect(runActionVisibility(run(), can, failed).download).toBe(true)
    expect(runActionVisibility(run(), can, failed).copyFailed).toBe(true)
    expect(runActionVisibility(run(), can, [product('B', 'ACCEPTED')]).copyFailed).toBe(false)
  })
  it('S10 "Delete the old SKU again": a settled studio run with an old SKU Amazon did not confirm deleting, for someone who may delete', () => {
    const failedMove = { productId: 'p', from: 'OLD', to: 'NEW', state: 'failed' as const, message: 'm', canDeleteAgain: true }
    const deleted = { ...failedMove, state: 'deleted' as const, canDeleteAgain: false }
    const accepted = run({ state: 'succeeded', status: 'ACCEPTED' })
    expect(runActionVisibility(accepted, { ...can, canDelete: true }, [], [failedMove]).deleteOldAgain).toBe(true)
    expect(runActionVisibility(accepted, { ...can, canDelete: false }, [], [failedMove]).deleteOldAgain).toBe(false)
    expect(runActionVisibility(accepted, { ...can, canDelete: true }, [], [deleted]).deleteOldAgain).toBe(false)
    expect(runActionVisibility(accepted, { ...can, canDelete: true }).deleteOldAgain).toBe(false)
    expect(runActionVisibility(run({ state: 'in_progress', status: 'SUBMITTED' }), { ...can, canDelete: true }, [], [failedMove]).deleteOldAgain).toBe(false)
    expect(runActionVisibility(run({ source: 'amazon-flat-file', state: 'succeeded', status: 'DONE' }), { ...can, canDelete: true }, [], [failedMove]).deleteOldAgain).toBe(false)
  })
})

describe('products', () => {
  const list = [product('Z', 'ACCEPTED'), product('B', 'WAITING'), product('C', 'NOT_SENT'), product('A', 'FAILED'), product('D', 'SKIPPED'), product('E', 'UNKNOWN'), product('F', 'VERIFIED')]
  it('failed first, then not sent, unknown, waiting, then the rest', () => {
    expect(orderProducts(list).map(p => p.sku)).toEqual(['A', 'C', 'E', 'B', 'F', 'Z', 'D'])
  })
  it('filters and their counts', () => {
    expect(filterProducts(list, 'failed').map(p => p.sku).sort()).toEqual(['A', 'C'])
    expect(filterProducts(list, 'accepted').map(p => p.sku).sort()).toEqual(['F', 'Z'])
    expect(filterProducts(list, 'waiting').map(p => p.sku).sort()).toEqual(['B', 'E'])
    expect(productFilterCounts(list)).toEqual({ all: 7, failed: 2, accepted: 2, waiting: 2 })
  })
  it('failed SKUs in order', () => {
    expect(failedSkus(list)).toEqual(['A', 'C'])
  })
  it('sent fields in words', () => {
    expect(sentFieldsText({ sentFields: ['$create'] })).toBe('Complete new listing')
    expect(sentFieldsText({ sentFields: [] })).toBe('Not recorded')
    expect(sentFieldsText({ sentFields: ['title', 'colour'] })).toBe('title, colour')
  })
  it('a sheet row id only for the primary listing', () => {
    expect(sheetRowIdOf(run(), product('A', 'FAILED'))).toBe('primary:p-A')
    expect(sheetRowIdOf(run({ aliasKey: 'alias-1', aliasLabel: 'IT-GALE' }), product('A', 'FAILED'))).toBe('alias-1:p-A')
    // An old page never recorded its listing: no guessed row.
    expect(sheetRowIdOf(run({ source: 'ebay-flat-file', aliasKey: null }), product('A', 'FAILED'))).toBeNull()
    expect(sheetRowIdOf(run(), product('A', 'FAILED', { productId: null }))).toBeNull()
  })
})

describe('results CSV', () => {
  it('one row per product, failed first, words not codes', () => {
    const csv = resultsCsv(run({ state: 'partial', status: 'PARTIAL' }), [
      product('OK-1', 'VERIFIED', { variationLabel: 'Nero · M', externalId: '999' }),
      product('BAD-1', 'FAILED', { message: 'The value for Colour, is not allowed.', fieldLabel: 'Colour' }),
    ])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('SKU,Variation,Result,Channel message,Field,Fields sent,Listing on channel,Destination,Started')
    expect(lines[1]).toBe('BAD-1,,Failed,"The value for Colour, is not allowed.",Colour,title,,eBay IT,2026-10-01T10:00:00.000Z')
    expect(lines[2]).toBe('OK-1,Nero · M,Verified,,,title,999,eBay IT,2026-10-01T10:00:00.000Z')
    expect(lines).toHaveLength(3)
  })
  it('a file name per destination and day', () => {
    expect(resultsFileName(run())).toBe('publish-ebay-it-2026-10-01.csv')
  })
})

describe('the change label', () => {
  it('counts fields of an update only', () => {
    expect(runChangeLabel({ kind: 'update', fieldCount: 3 })).toBe('Update · 3 fields')
    expect(runChangeLabel({ kind: 'update', fieldCount: 1 })).toBe('Update · 1 field')
    expect(runChangeLabel({ kind: 'update', fieldCount: null })).toBe('Update')
    expect(runChangeLabel({ kind: 'create', fieldCount: 9 })).toBe('New listing')
  })
})

describe('deep link ?tab=activity&view=publishes&run=<id>[&sku=<sku>]', () => {
  it('parses a run and a SKU', () => {
    expect(parseHistoryDeepLink('?tab=activity&view=publishes&run=pub-1&sku=GALE-M')).toEqual({ view: 'publishes', run: 'pub-1', sku: 'GALE-M' })
  })
  it('a run implies the publishes view', () => {
    expect(parseHistoryDeepLink('tab=activity&run=pub-1')).toEqual({ view: 'publishes', run: 'pub-1', sku: null })
  })
  it('a SKU without a run is ignored; an unknown view is no view', () => {
    expect(parseHistoryDeepLink('tab=activity&view=weird&sku=X')).toEqual({ view: null, run: null, sku: null })
    expect(parseHistoryDeepLink('tab=activity&view=all')).toEqual({ view: 'all', run: null, sku: null })
  })
  it('writing the link removes what is not set', () => {
    expect(historyDeepLinkPatch({ view: 'publishes', run: null, sku: 'X' })).toEqual({ view: 'publishes', run: undefined, sku: undefined })
    expect(historyDeepLinkPatch({ view: 'publishes', run: 'pub-1', sku: 'X' })).toEqual({ view: 'publishes', run: 'pub-1', sku: 'X' })
  })
})

describe('build shape v2 (P12) — one Publish of several parts is one run', () => {
  it('names every part of a Publish, in send order, once each', () => {
    expect(listWords(['A'])).toBe('A')
    expect(listWords(['A', 'B'])).toBe('A and B')
    expect(listWords(['A', 'B', 'C'])).toBe('A, B and C')
    expect(runChangeLabel(run({ kind: 'resume', kinds: ['resume', 'update', 'update', 'end'] }))).toBe('Resume offer, Update and End listing')
    // One kind (or no kinds) reads as before.
    expect(runChangeLabel(run({ kind: 'update', kinds: ['update'], fieldCount: 2 }))).toBe('Update · 2 fields')
    expect(runChangeLabel(run({ kind: 'pause', fieldCount: null }))).toBe('Pause offer')
  })
})

describe('runUndos — Resume these 3…, Relist…, Cannot be undone', () => {
  const sell = (kind: HistoryRun['kind'], over: Partial<HistoryRun> = {}) => run({ id: `listing-action:${kind}`, source: 'listing-action', kind, fieldCount: null, ...over })
  it('a pause offers to resume the listings the channel accepted, and only those', () => {
    const items = [product('A', 'ACCEPTED'), product('B', 'ACCEPTED'), product('C', 'ACCEPTED'), product('D', 'FAILED'), product('E', 'ACCEPTED', { listingId: null })]
    const [undo, ...rest] = runUndos({ run: sell('pause') }, items)
    expect(rest).toEqual([])
    expect(undo).toMatchObject({ kind: 'resume', label: 'Resume these 3…', listingIds: ['l-A', 'l-B', 'l-C'] })
    expect(undo.hint).toBe('Sets Status to Active on 3 listings on eBay IT and opens Publish. Nothing is sent until you publish.')
    expect(runUndos({ run: sell('pause') }, [product('A', 'VERIFIED')])[0].label).toBe('Resume this listing…')
    // Nothing accepted: nothing was paused, nothing to put back.
    expect(runUndos({ run: sell('pause') }, [product('A', 'FAILED')])).toEqual([])
  })
  it('an end offers Relist… (eBay: a new item number); a delete says it cannot be undone; content offers nothing', () => {
    const relist = runUndos({ run: sell('end') }, [product('A', 'ACCEPTED')])[0]
    expect(relist).toMatchObject({ kind: 'relist', label: 'Relist…', listingIds: ['l-A'] })
    expect(relist.hint).toContain('eBay gives a relisted item a new item number.')
    const gone = runUndos({ run: sell('delete') }, [product('A', 'ACCEPTED'), product('B', 'ACCEPTED')])[0]
    expect(gone).toMatchObject({ kind: 'none', label: 'Cannot be undone', listingIds: [] })
    expect(gone.hint).toBe('2 listings were deleted on eBay IT and read Not listed. To list them again, set their Status to Active and Publish.')
    expect(runUndos({ run: run() }, [product('A', 'ACCEPTED')])).toEqual([])
    expect(runUndos({ run: sell('resume') }, [product('A', 'ACCEPTED')])).toEqual([])
  })
  it('a Publish of several parts: one Undo per selling part, each with ITS products', () => {
    const pause = sell('pause', { id: 'part-pause' })
    const end = sell('end', { id: 'part-end', marketplace: 'DE' })
    const content = run({ id: 'part-content' })
    const items = [
      product('A', 'ACCEPTED', { runId: 'part-pause', kind: 'pause' }), product('B', 'ACCEPTED', { runId: 'part-pause', kind: 'pause' }),
      product('C', 'ACCEPTED', { runId: 'part-end', kind: 'end' }), product('D', 'ACCEPTED', { runId: 'part-content', kind: 'update' }),
    ]
    const undos = runUndos({ run: run({ id: 'listing-action:batch:b1', kind: 'update', kinds: ['update', 'pause', 'end'] }), children: [content, pause, end] }, items)
    expect(undos.map(u => [u.run.id, u.label, u.listingIds])).toEqual([['part-pause', 'Resume these 2…', ['l-A', 'l-B']], ['part-end', 'Relist…', ['l-C']]])
    expect(undos[1].hint).toContain('on eBay DE')
  })
})

describe('"Show in sheet" lands on the field the channel named', () => {
  it('the field names in order: the server column, every named attribute, then the field label; no blanks, no repeats', () => {
    expect(sheetFieldHints(product('A', 'FAILED', { columnKey: null, columnHint: ['color', 'item_name'], fieldLabel: 'color' }))).toEqual(['color', 'item_name'])
    expect(sheetFieldHints(product('A', 'FAILED', { columnKey: 'title', columnHint: [' '], fieldLabel: 'Item name' }))).toEqual(['title', 'Item name'])
    expect(sheetFieldHints(product('A', 'ACCEPTED'))).toEqual([])
  })
  it('one request, taken once by the sheet of the same destination, dropped when stale', () => {
    const now = Date.parse('2026-10-04T10:00:00Z')
    requestSheetLanding({ rowId: 'primary:p-A', fieldNames: ['color'], channel: 'EBAY', marketplace: 'IT' }, now)
    // Another destination's sheet leaves it for the right one.
    expect(takeSheetLanding({ channel: 'AMAZON', marketplace: 'IT' }, now)).toBeNull()
    expect(takeSheetLanding({ channel: 'EBAY', marketplace: 'IT' }, now + 1000)).toMatchObject({ rowId: 'primary:p-A', fieldNames: ['color'] })
    expect(takeSheetLanding({ channel: 'EBAY', marketplace: 'IT' }, now + 2000)).toBeNull()
    requestSheetLanding({ rowId: 'primary:p-B', fieldNames: [], channel: 'EBAY', marketplace: 'IT' }, now)
    expect(takeSheetLanding({ channel: 'EBAY', marketplace: 'IT' }, now + SHEET_LANDING_TTL_MS + 1)).toBeNull()
    expect(takeSheetLanding({ channel: 'EBAY', marketplace: 'IT' }, now)).toBeNull()
  })
})
