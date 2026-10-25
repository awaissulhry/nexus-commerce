/**
 * Listings live layer, step 4 — the export (`GET /api/catalog-transfer/readiness/export`) on a real PostgreSQL
 * (PGlite): one row per listing or per family, the same numbers as the page (its chips, its order, its state tile),
 * the live columns only with `listings.view` (and per family only on one destination), the spreadsheet-formula guard,
 * the 50,000-row cap (refused with the count), CSV and Excel. Ids invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, cap: 50_000 }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
// The cap, small enough to cross in a test.
vi.mock('@nexus/shared/listing-readiness', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, get READINESS_EXPORT_MAX_ROWS() { return state.cap } }
})

import ExcelJS from 'exceljs'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readinessFamilies } from './listing-readiness-families.service.js'
import { ExportTooLarge, exportReadiness, pushWords, spreadsheetSafe, statusWords } from './listing-readiness-export.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const key = (c: (string | null)[]) => JSON.stringify(c)
const SHARED = [null, null, null, null], AMAZON_IT = ['AMAZON', 'IT', 'ex-a1', null], EBAY_IT = ['EBAY', 'IT', 'ex-e1', null]
const computedAt = new Date('2026-10-25T08:00:00Z')
const index = (productId: string, c: (string | null)[], s = 'ready', extra: Record<string, unknown> = {}) => ({
  productId, coordinateKey: key(c), channel: c[0], market: c[1], accountId: c[2], aliasId: c[3], language: 'it',
  label: c[0] ? `${c[0]} · ${c[1]}` : 'Shared product', pct: null, state: s, requiredFilled: 0, requiredTotal: 0, missing: [], note: null, computedAt, ...extra,
})
const brand = [{ field: 'brand', label: 'Brand', reason: 'Required and empty', requiredEmpty: true }]
const listing = (id: string, productId: string, [channel, marketplace, account]: (string | null)[], extra: Record<string, unknown> = {}) => ({
  id, productId, channel, marketplace, channelConnectionId: account, aliasKey: '', channelMarket: `${channel}_${marketplace}`, region: marketplace,
  listingStatus: 'ACTIVE', isPublished: true, ...extra,
})

/** A CSV answer as rows of cells (the file's own quoting undone). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' } else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++ } else cell += ch
  }
  return rows
}
const table = (data: string | Buffer) => {
  const text = String(data)
  expect(text.charCodeAt(0)).toBe(0xFEFF)
  const [headers, ...rows] = parseCsv(text.slice(1))
  return { headers, rows, cell: (row: string[], header: string) => row[headers.indexOf(header)] }
}

beforeAll(() => scoped(async () => {
  await prisma.channelConnection.create({ data: { id: 'ex-a1', channelType: 'AMAZON', isActive: true, accountLabel: 'Xavia', externalAccountId: 'seller-ex-a1' } as never })
  await prisma.channelConnection.create({ data: { id: 'ex-e1', channelType: 'EBAY', isActive: true, displayName: 'Moto store', externalAccountId: 'seller-ex-e1' } as never })
  for (const [channel, code, currency] of [['AMAZON', 'IT', 'EUR'], ['EBAY', 'IT', 'EUR']])
    await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, region: 'EU', currency, language: 'it', isActive: true } as never })
  await prisma.product.create({ data: { id: 'ex-root', sku: 'EX', name: 'Export Parka', basePrice: 10, isParent: true, status: 'DRAFT' } })
  for (const [id, sku] of [['ex-v1', 'EX-M'], ['ex-v2', 'EX-L']]) await prisma.product.create({ data: { id, sku, name: `Parka ${sku}`, basePrice: 10, parentId: 'ex-root', status: 'DRAFT' } })
  // Text a spreadsheet would run: each starts with = + - @.
  await prisma.product.create({ data: { id: 'ex-evil', sku: '=1+1', name: '=HYPERLINK("http://evil.test","click")', basePrice: 10, status: 'DRAFT' } })
  await prisma.product.create({ data: { id: 'ex-plus', sku: '+SUM', name: '@cmd', basePrice: 10, status: 'DRAFT' } })
  await prisma.product.create({ data: { id: 'ex-minus', sku: '-2', name: 'Minus gloves', basePrice: 10, status: 'DRAFT' } })
  await prisma.readinessIndex.createMany({ data: [
    ...['ex-root', 'ex-v1', 'ex-v2', 'ex-evil', 'ex-plus', 'ex-minus'].map(id => index(id, SHARED)),
    index('ex-v1', AMAZON_IT, 'blocked', { missing: brand }), index('ex-v2', AMAZON_IT), index('ex-root', AMAZON_IT),
    index('ex-v1', EBAY_IT), index('ex-evil', AMAZON_IT, 'warn'), index('ex-minus', AMAZON_IT),
  ] as never })
  await prisma.channelListing.createMany({ data: [
    listing('ex-l-root', 'ex-root', AMAZON_IT, { externalListingId: 'B0EXPARENT' }),
    listing('ex-l-v1', 'ex-v1', AMAZON_IT, { externalListingId: 'B0EXM', externalParentId: 'B0EXPARENT', price: 49.9, quantity: 15, lastSyncStatus: 'FAILED',
      lastSyncedAt: new Date('2026-10-24T10:00:00Z') }),
    listing('ex-l-v2', 'ex-v2', AMAZON_IT, { externalListingId: 'B0EXL', externalParentId: 'B0EXPARENT', price: 59.9, quantity: 5, lastSyncStatus: 'SUCCESS',
      lastSyncedAt: new Date('2026-10-25T10:00:00Z') }),
    listing('ex-l-v1-ebay', 'ex-v1', EBAY_IT, { externalListingId: '225500009999', price: 47, quantity: 3 }),
    listing('ex-l-evil', 'ex-evil', AMAZON_IT, { externalListingId: '=B0EVIL', price: 10, quantity: 1 }),
  ] as never })
  await prisma.listingIssue.create({ data: { listingId: 'ex-l-v1', code: '90220', severity: 'ERROR', message: 'Not allowed', attributeNames: [], categories: [], fingerprint: 'E::' } })
}), 120_000)
afterAll(async () => { await state.db?.close() })

describe('the cells', () => {
  it('a cell a spreadsheet would run as a formula gets a leading apostrophe; numbers and plain text pass', () => {
    for (const text of ['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx', '\rx']) expect(spreadsheetSafe(text)).toBe(`'${text}`)
    for (const value of ['Parka', '', 'a=b', -2, 49.9, null]) expect(spreadsheetSafe(value)).toBe(value)
  })
  it('the words: the last push (worst, with how many) and the channel state (Mixed with its parts)', () => {
    expect(pushWords(undefined)).toBe('')
    expect(pushWords({ worst: 'failed', failed: 3, waiting: 0, done: 17, other: 0 })).toBe('Failed · 3 of 20')
    expect(pushWords({ worst: 'done', failed: 0, waiting: 0, done: 4, other: 0 })).toBe('Accepted')
    expect(pushWords({ worst: 'waiting', failed: 0, waiting: 1, done: 0, other: 0 })).toBe('Waiting')
    expect(statusWords({ state: 'mixed', byState: { active: 18, draft: 1 }, notListed: 1 } as never)).toBe('Mixed (18 Active · 2 Not listed)')
    expect(statusWords({ state: 'paused', byState: { paused: 1 }, notListed: 0 } as never)).toBe('Inactive')
  })
})

describe('one row per listing', () => {
  it('every listing in view, in the page\'s order, with the chips\' numbers; the live columns with listings.view', async () => {
    const file = await scoped(() => exportReadiness({}, null, { live: true }))
    expect(file).toMatchObject({ contentType: 'text/csv; charset=utf-8' })
    expect(file.filename).toMatch(/^listings-\d{4}-\d{2}-\d{2}\.csv$/)
    const { headers, rows, cell } = table(file.data)
    expect(headers).toEqual(['SKU', 'Name', 'Family', 'Store', 'Market', 'Readiness', 'Problems', 'Next step', 'Status', 'Price', 'Currency', 'Qty', 'Channel ID',
      'Last push', 'Synced', 'Checked'])
    const page = await scoped(() => readinessFamilies({}, null, { live: true }))
    // The toolbar's count: every listing of the result.
    expect(rows.length).toBe(page.stats.all)
    expect(file.rows).toBe(page.stats.all)
    // Families in the page's order: the blocked family first.
    expect([...new Set(rows.map(r => cell(r, 'Family')))]).toEqual(page.rows.map(r => spreadsheetSafe(r.sku)))
    const m = rows.find(r => cell(r, 'SKU') === 'EX-M' && cell(r, 'Store') === 'Amazon · Xavia')!
    expect({ name: cell(m, 'Name'), family: cell(m, 'Family'), market: cell(m, 'Market'), readiness: cell(m, 'Readiness'), problems: cell(m, 'Problems'),
      next: cell(m, 'Next step'), status: cell(m, 'Status'), price: cell(m, 'Price'), currency: cell(m, 'Currency'), qty: cell(m, 'Qty'), id: cell(m, 'Channel ID'),
      push: cell(m, 'Last push'), synced: cell(m, 'Synced'), checked: cell(m, 'Checked') }).toEqual({
      name: 'Parka EX-M', family: 'EX', market: 'IT', readiness: 'Blocked', problems: '1', next: 'Brand: Required and empty', status: 'Active', price: '49.9',
      currency: 'EUR', qty: '15', id: 'B0EXM', push: 'Failed', synced: '2026-10-24T10:00:00.000Z', checked: '2026-10-25T08:00:00.000Z' })
    expect(rows.find(r => cell(r, 'SKU') === 'EX-M' && cell(r, 'Store') === 'eBay · Moto store')).toBeTruthy()
    // Shared has no channel: its live cells are empty.
    const shared = rows.find(r => cell(r, 'SKU') === 'EX-M' && cell(r, 'Store') === 'Shared')!
    expect(['Status', 'Price', 'Qty', 'Channel ID'].map(h => cell(shared, h))).toEqual(['', '', '', ''])
    // A sibling checked nowhere on eBay: the honest "not computed" listing the chips count.
    expect(cell(rows.find(r => cell(r, 'SKU') === 'EX-L' && cell(r, 'Store') === 'eBay · Moto store')!, 'Readiness')).toBe('Not computed')
  })

  it('cells a spreadsheet would run are made safe, in CSV and in Excel (SKUs and channel ids as text)', async () => {
    const csv = table((await scoped(() => exportReadiness({ q: 'HYPERLINK' }, null, { live: true }))).data)
    const evil = csv.rows.find(r => csv.cell(r, 'Store') === 'Amazon · Xavia')!
    expect([csv.cell(evil, 'SKU'), csv.cell(evil, 'Name'), csv.cell(evil, 'Family'), csv.cell(evil, 'Channel ID')])
      .toEqual(["'=1+1", '\'=HYPERLINK("http://evil.test","click")', "'=1+1", "'=B0EVIL"])
    const plus = table((await scoped(() => exportReadiness({ productIds: 'ex-plus,ex-minus' }, null))).data)
    expect(plus.rows.map(r => [plus.cell(r, 'SKU'), plus.cell(r, 'Name')]).sort()).toEqual([["'+SUM", "'@cmd"], ["'-2", 'Minus gloves'], ["'-2", 'Minus gloves']].sort())
    const xlsx = await scoped(() => exportReadiness({ q: 'HYPERLINK', format: 'xlsx' }, null, { live: true }))
    expect(xlsx.filename).toMatch(/\.xlsx$/)
    expect(xlsx.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(xlsx.data as Buffer)
    const sheet = book.worksheets[0]
    const headers = (sheet.getRow(1).values as unknown[]).slice(1)
    expect(headers).toContain('Channel ID')
    const values = sheet.getRow(2).values as unknown[]
    const col = (name: string) => headers.indexOf(name) + 1
    expect(values.slice(1).every(v => typeof v !== 'object' || v === null)).toBe(true) // no formula cell anywhere
    expect(sheet.getColumn(col('Channel ID')).numFmt).toBe('@')
    expect(String(values[col('SKU')])).toBe("'=1+1")
  })

  it('a state tile exports the listings in that state; without listings.view there are no live columns', async () => {
    const page = await scoped(() => readinessFamilies({ state: 'blocked' }, null))
    const { headers, rows, cell } = table((await scoped(() => exportReadiness({ state: 'blocked' }, null))).data)
    expect(headers).toEqual(['SKU', 'Name', 'Family', 'Store', 'Market', 'Readiness', 'Problems', 'Next step', 'Checked'])
    expect(rows.length).toBe(page.stats.blocked)
    expect(rows.every(r => cell(r, 'Readiness') === 'Blocked')).toBe(true)
  })

  it('above the cap the export is refused with the count, before a row is built', async () => {
    state.cap = 5
    try {
      const refused = await scoped(() => exportReadiness({}, null)).catch(error => error)
      expect(refused).toBeInstanceOf(ExportTooLarge)
      const page = await scoped(() => readinessFamilies({}, null))
      expect(refused).toMatchObject({ statusCode: 400, count: page.stats.all })
      expect(refused.message).toContain(`This export has ${page.stats.all} rows; at most 5`)
      // The family level counts families.
      expect((await scoped(() => exportReadiness({ level: 'family' }, null))).rows).toBe(page.total)
    } finally { state.cap = 50_000 }
  })

  it('refuses an unknown format or level, and a live sort without one market', async () => {
    await expect(scoped(() => exportReadiness({ format: 'pdf' }, null))).rejects.toThrow('Export as csv or xlsx')
    await expect(scoped(() => exportReadiness({ level: 'sku' }, null))).rejects.toThrow('Export one row per listing or per family')
    await expect(scoped(() => exportReadiness({ sort: 'price' }, null, { live: true }))).rejects.toThrow('Choose one market')
  })
})

describe('one row per family', () => {
  it('on a market page: the family row\'s words and its chip\'s live numbers (a range, the total, the parent id, the worst push)', async () => {
    const query = { channel: 'AMAZON', marketplace: 'IT', sort: 'price', dir: 'desc' }
    const file = await scoped(() => exportReadiness({ ...query, level: 'family' }, null, { live: true }))
    expect(file.filename).toMatch(/^listings-amazon-it-\d{4}-\d{2}-\d{2}-families\.csv$/)
    const { headers, rows, cell } = table(file.data)
    expect(headers).toEqual(['SKU', 'Name', 'Variations', 'Markets', 'Listings', 'Readiness', 'Problems', 'Next step', 'Status', 'Price', 'Price max', 'Currency', 'Qty',
      'Channel ID', 'Last push', 'Synced', 'Checked'])
    const page = await scoped(() => readinessFamilies(query, null, { live: true }))
    expect(rows.map(r => cell(r, 'SKU'))).toEqual(page.rows.map(r => String(spreadsheetSafe(r.sku))))
    const parka = rows.find(r => cell(r, 'SKU') === 'EX')!
    const chip = page.rows.find(r => r.id === 'ex-root')!.chips.find(c => c.destinationKey === key(AMAZON_IT))!.live!
    expect([cell(parka, 'Price'), cell(parka, 'Price max'), cell(parka, 'Qty'), cell(parka, 'Channel ID')]).toEqual([String(chip.priceMin), String(chip.priceMax), String(chip.quantity), chip.externalId])
    expect({ variations: cell(parka, 'Variations'), readiness: cell(parka, 'Readiness'), status: cell(parka, 'Status'), push: cell(parka, 'Last push'), markets: cell(parka, 'Markets') }).toEqual({
      variations: '2', readiness: 'Blocked', status: 'Active', push: 'Failed · 1 of 2', markets: 'Amazon IT: Blocked · 1' })
  })

  it('across markets: no live columns (currencies differ; Amazon EU shares one quantity)', async () => {
    const { headers, rows, cell } = table((await scoped(() => exportReadiness({ level: 'family' }, null, { live: true }))).data)
    expect(headers).toEqual(['SKU', 'Name', 'Variations', 'Markets', 'Listings', 'Readiness', 'Problems', 'Next step', 'Checked'])
    expect(cell(rows.find(r => cell(r, 'SKU') === 'EX')!, 'Markets')).toBe('Shared: Ready; Amazon IT: Blocked · 1; eBay IT: Not computed')
  })
})
