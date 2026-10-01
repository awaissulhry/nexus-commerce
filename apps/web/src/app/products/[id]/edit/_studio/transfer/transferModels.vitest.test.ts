import { describe, it, expect } from 'vitest'
import type { ProductTransferOptions, SheetImportStatus } from '@nexus/shared/catalog-transfer'
import { defaultExportChoice, exportBlocker, exportDestinations, exportLanguages, exportProductIds, exportSelection, type ExportContext } from './exportModel'
import { applyLabel, cellValue, changeCells, displayValue, doneView, focusChange, openFamilyActions, summaryLine, whereInFile } from './importModel'
import { exportNotesOf } from './sheetTransferApi'

const listing = (id: string, productId: string, channel: string, marketplace: string, accountId = 'acc-1', aliasKey = '') =>
  ({ id, productId, channel, marketplace, accountId, aliasKey, aliasLabel: aliasKey ? `Alias ${aliasKey}` : 'Primary listing' })
const options: ProductTransferOptions = {
  productId: 'p1', rootId: 'root', familyId: 'fam',
  products: [{ id: 'root', sku: 'GALE', parentId: null }, { id: 'p1', sku: 'GALE-M', parentId: 'root' }, { id: 'p2', sku: 'GALE-L', parentId: 'root' }],
  listings: [listing('l1', 'p1', 'AMAZON', 'IT'), listing('l2', 'p2', 'AMAZON', 'IT'), listing('l3', 'p1', 'AMAZON', 'IT', 'acc-1', 'alias-9'),
    listing('l4', 'p1', 'EBAY', 'DE', 'acc-2'), listing('l5', 'p2', 'AMAZON', 'IT', 'acc-3'), listing('l6', 'p2', 'SHOPIFY', 'GLOBAL', '')],
  locales: ['de', 'en', 'fr', 'it'],
  accounts: [{ id: 'acc-1', channelType: 'AMAZON', marketplace: null, displayName: 'Xavia EU' }, { id: 'acc-3', channelType: 'AMAZON', marketplace: null, displayName: 'Second seller' }],
  markets: [{ channel: 'AMAZON', code: 'IT', name: 'Italy', language: 'it' }, { channel: 'EBAY', code: 'DE', name: 'Germany', language: 'de' }],
}
const context: ExportContext = { productId: 'p1', market: 'IT', channel: 'AMAZON', accountId: 'acc-1', selectedIds: [] }

describe('export choices', () => {
  it('groups listings by channel, account and market, counting aliases instead of listing them; names accounts only when two share a market', () => {
    const destinations = exportDestinations(options, ['root', 'p1', 'p2'])
    expect(destinations.map(d => [d.label, d.listings, d.aliases, d.language])).toEqual([
      ['Amazon IT · Second seller', 1, 0, 'it'], ['Amazon IT · Xavia EU', 3, 1, 'it'], ['eBay DE', 1, 0, 'de'],
    ])
  })
  it('a listing without an account is not offered (the server would leave it out)', () => {
    expect(exportDestinations(options, ['p2']).some(d => d.channel === 'SHOPIFY')).toBe(false)
  })
  it('defaults to the whole family, Shared, and the channel market on screen', () => {
    const choice = defaultExportChoice(options, context)
    expect(choice.products).toBe('family')
    expect(choice.shared).toBe(true)
    expect(choice.columns).toBe('all')
    expect(choice.destinations).toEqual([JSON.stringify(['AMAZON', 'acc-1', 'IT'])])
  })
  it('on the Shared scope, no channel is ticked by default', () => {
    expect(defaultExportChoice(options, { productId: 'p1', market: 'IT', selectedIds: [] }).destinations).toEqual([])
  })
  it('the selection carries every alias of a chosen destination and the languages of the chosen markets', () => {
    const selection = exportSelection(options, context, { products: 'family', shared: true, destinations: [JSON.stringify(['AMAZON', 'acc-1', 'IT']), JSON.stringify(['EBAY', 'acc-2', 'DE'])], columns: 'all' })
    expect(selection.productIds).toEqual(['root', 'p1', 'p2'])
    expect(selection.listingIds.sort()).toEqual(['l1', 'l2', 'l3', 'l4'])
    expect(selection.locales).toEqual(['de', 'it'])
    expect(selection.includeShared).toBe(true)
  })
  it('without Shared there are no shared languages', () => {
    expect(exportSelection(options, context, { products: 'product', shared: false, destinations: [JSON.stringify(['AMAZON', 'acc-1', 'IT'])], columns: 'all' }))
      .toEqual({ productIds: ['p1'], includeShared: false, listingIds: ['l1', 'l3'], locales: [] })
  })
  it('selected rows keep only products of this family', () => {
    expect(exportProductIds(options, { ...context, selectedIds: ['p2', 'someone-else'] }, 'selected')).toEqual(['p2'])
  })
  it('says why Download is off', () => {
    expect(exportBlocker({ productIds: [], includeShared: true, listingIds: [], locales: [] })).toMatch(/Select rows/)
    expect(exportBlocker({ productIds: ['p1'], includeShared: false, listingIds: [], locales: [] })).toMatch(/Shared details or at least one channel/)
    expect(exportBlocker({ productIds: ['p1'], includeShared: true, listingIds: [], locales: [] })).toBeNull()
  })
  it('languages come from the chosen markets and the language on screen; the market stands in only without one', () => {
    expect(exportLanguages(options, { ...context, locale: 'fr' }, [])).toEqual(['fr'])
    expect(exportLanguages(options, { ...context, market: 'DE', locale: 'it' }, [])).toEqual(['it'])
    expect(exportLanguages(options, { ...context, locale: undefined }, [])).toEqual(['it'])
    expect(exportLanguages(options, { ...context, locale: 'it' }, exportDestinations(options, ['p1']).filter(d => d.channel === 'EBAY'))).toEqual(['de', 'it'])
  })
  it('reads the export notes header; a broken header is no notes', () => {
    expect(exportNotesOf(encodeURIComponent(JSON.stringify({ total: 3, notes: ['a', 'b'] })))).toEqual({ total: 3, notes: ['a', 'b'] })
    expect(exportNotesOf('%E0%A4%A')).toEqual({ total: 0, notes: [] })
    expect(exportNotesOf(null)).toEqual({ total: 0, notes: [] })
  })
})

const status = (patch: Partial<SheetImportStatus>): SheetImportStatus => ({
  jobId: 'j1', state: 'READY', format: 'nexus', filename: 'GALE.xlsx', summary: { changes: 0, problems: 0, products: 0, listings: 0, unchanged: 0, created: 0, ended: 0, prices: 0 },
  warnings: [], processed: 0, total: 0, startedAt: '2026-09-26T10:00:00.000Z', completedAt: null, links: [], deletes: [], destinations: [], listingIds: [], canUndo: false, ...patch,
})

describe('import words', () => {
  it('one summary line: what the file is and what it touches', () => {
    expect(summaryLine(status({ summary: { ...status({}).summary, products: 20, listings: 1 }, destinations: ['Shared', 'Amazon · IT'] })))
      .toBe('Nexus file · 20 products · 1 listing · Shared, Amazon · IT')
  })
  it('the primary button says what it saves and what it skips', () => {
    expect(applyLabel(status({ total: 3, summary: { ...status({}).summary, changes: 125 } }))).toBe('Apply 125 changes')
    expect(applyLabel(status({ total: 3, summary: { ...status({}).summary, changes: 1, problems: 3 } }))).toBe('Apply 1 change, skip 3 problems')
    expect(applyLabel(status({ total: 0, summary: { ...status({}).summary, problems: 3 } }))).toBeNull()
  })
  it('the done view always says nothing went to the channels', () => {
    const done = doneView(status({ state: 'DONE', receipt: { saved: 40, failed: 0, skipped: 2 } }))
    expect(done).toMatchObject({ tone: 'success', title: '40 records saved in Nexus' })
    expect(done.body).toContain('Nothing was sent to the channels.')
    expect(doneView(status({ state: 'PARTIAL', receipt: { saved: 39, failed: 1, skipped: 0 } })).tone).toBe('warning')
    expect(doneView(status({ state: 'DONE', format: 'undo', receipt: { saved: 40, failed: 0, skipped: 0 } })).title).toBe('Import undone')
    expect(doneView(status({ state: 'FAILED', error: 'The check was interrupted. Drop the file again.' })).body).toBe('The check was interrupted. Drop the file again.')
  })
  // Phase 2 (2026-10-01) — a file that created another product family: the done screen opens it, and it is published from there.
  it('offers "Open <SKU>" for each family the import created besides the open product, once the import is done', () => {
    const created = status({ state: 'DONE', receipt: { saved: 131, failed: 0, skipped: 0 }, newFamilies: [{ productId: 'cm 1', sku: 'GALE-JACKET' }] })
    expect(openFamilyActions(created)).toEqual([{ label: 'Open GALE-JACKET', href: '/products/cm%201/edit/studio' }])
    expect(doneView(created).body).toBe('Nothing was sent to the channels. New product: GALE-JACKET. Open it to publish.')
    expect(openFamilyActions(status({ state: 'READY', newFamilies: [{ productId: 'p', sku: 'X' }] }))).toEqual([])
    expect(openFamilyActions(status({ state: 'DONE' }))).toEqual([])
    expect(openFamilyActions(null)).toEqual([])
  })
  it('values read like the sheet: empty is a dash, lists are joined, a measure has its unit, inherited says so', () => {
    expect(displayValue(null)).toBe('—')
    expect(displayValue(['Warm', 'Light'])).toBe('Warm · Light')
    expect(displayValue({ value: 1.2, unit: 'kilograms' })).toBe('1.2 kilograms')
    expect(displayValue('x'.repeat(200)).length).toBe(120)
    expect(cellValue({ before: null, after: 'Nylon', beforeState: 'inherited', afterState: 'stored' }, 'before')).toBe('Follows Shared')
    expect(cellValue({ before: 'Nylon', after: null, beforeState: 'stored', afterState: 'inherited' }, 'after')).toBe('Follows Shared')
  })
  it('two long texts that differ near the end both start just before the difference', () => {
    const before = 'XAVIA GALE Giacca Da Moto Da Uomo - Giubbotto Moto Impermeabile | Per Tutte Le Stagioni'
    const [now, next] = focusChange(before, `${before} (2026)`)
    expect(now.startsWith('…')).toBe(true)
    expect(next.endsWith('Stagioni (2026)')).toBe(true)
    expect(next.length).toBeLessThan(before.length)
    expect(focusChange('Nylon', 'Polyester')).toEqual(['Nylon', 'Polyester'])
    expect(focusChange('—', 'Nylon')).toEqual(['—', 'Nylon'])
  })
  it('🔴 finds a difference beyond 120 characters (the table must never show two equal cells for a change)', () => {
    const before = `${'Giubbotto Moto Impermeabile '.repeat(6)}Stagioni`
    const [now, next] = changeCells({ before, after: `${before} (2026)`, beforeState: 'stored', afterState: 'stored' })
    expect(now).not.toBe(next)
    expect(next.endsWith('(2026)')).toBe(true)
  })
  it('names where a problem is in the file', () => {
    expect(whereInFile({ sheet: 'Amazon IT', row: 14, column: 'F' })).toBe('Amazon IT · row 14 · column F')
    expect(whereInFile({})).toBe('')
  })
})
