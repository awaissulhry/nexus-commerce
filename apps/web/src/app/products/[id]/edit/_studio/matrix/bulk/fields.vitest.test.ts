/**
 * The bulk Edit's fields (Owner 2026-10-07; v2 2026-10-12): the eleven fields and their words, every field listed (one
 * the selection cannot take held with its reason), only the markets that serve a field offered, the rows as they are NOW
 * in the grid's own words, the mode a field opens on, and the lines the page works out itself (Base price, Use base
 * price, Sale, Status) honest about what changes and what is skipped.
 */
import { describe, expect, it } from 'vitest'
import type { PublishActionCell } from '@nexus/shared/publish-actions'

import { MATRIX_COPY, type MatrixCells, type MatrixCoordinate, type MatrixRowRead, type SourceCell, type SyncCell } from '../contract'
import {
  BULK_ALREADY_FOLLOWS, BULK_CASE_NOT_AMAZON, BULK_CASE_NOT_READ, BULK_CASE_PERMISSION, BULK_EDIT_PERMISSION, BULK_FOLLOWS_BASE, BULK_FORMULA_PRICE,
  BULK_HOLD_NOTICE, BULK_NO_HANDOFF, BULK_NO_WAREHOUSE, BULK_PARENT_ONLY, BULK_PRICE_ABOVE_0, BULK_PRICE_PERMISSION, BULK_SENT, BULK_STATUS_NEW_ROW,
  basePriceLines, bulkChoices, bulkCurrent, bulkDefaultMarkets, bulkDefaultMode, bulkFieldOfKind, bulkFields, bulkMarkets, bulkMarketsNote, bulkModes,
  caseHandoffHeld, coordinateOfVerbLine, dropsBy30, followBaseLines, isVerbChangeLine, largeChangeWord, saleLines, saleNotices, statusLines, verbLines,
  verbNotices, verbParams, verbTargets, type BulkContext,
} from './fields'
import { verbSentence } from './bulkSource'
import type { BulkFieldId } from './types'

const coord = (key: string, label: string, cells: MatrixCoordinate['cells'], extra: Partial<MatrixCoordinate> = {}): MatrixCoordinate => ({
  key, kind: 'market', channel: key.split(':')[0]!, market: key.split(':')[1]!, label, region: null, alias: null, accountId: null, currency: 'EUR',
  connected: true, listed: 1, draft: 0, cells, absent: [], sharedInventoryWith: null, inventoryOn: null, vocabulary: { fulfilment: null }, ...extra,
})
const EU = coord('AMAZON:EU', 'Amazon EU · IT DE FR ES', ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState'], { kind: 'region-inventory', vocabulary: { fulfilment: ['FBA', 'FBM'] } })
const IT = coord('AMAZON:IT', 'Amazon · IT', ['listing', 'price', 'salePrice'], { inventoryOn: 'AMAZON:EU' })
const EBAY = coord('EBAY:IT', 'eBay · IT', ['listing', 'fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price'], { vocabulary: { fulfilment: ['FBM', 'MCF'] } })
const SHOP = coord('SHOPIFY:GLOBAL', 'Shopify', ['listing', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price', 'salePrice'])

const cells = (over: Partial<MatrixCells> = {}): MatrixCells => ({
  listingId: 'L', version: 1, listing: null, fulfilment: null, sync: null, queue: null, price: null, sale: null, writable: {}, writeBlockedReason: {}, ...over,
})
const priced = (value: number, sale: MatrixCells['sale'] = null, source: 'override' | 'master' | 'formula' = 'override') =>
  cells({ price: { value, currency: 'EUR', source, formula: source === 'formula' ? '=base*1.1' : null, clamped: null }, sale, writable: { salePrice: true, price: true } })
const SRC: SourceCell = { own: [], marketDefault: ['IT-MAIN'], defaultOrigin: 'routes', effective: [{ code: 'IT-MAIN', available: 6 }], writable: true, blockedReason: null }
const LOCATIONS = [{ code: 'IT-MAIN', name: 'Main', active: true, isDefault: true }, { code: 'MI-3PL', name: 'Milan', active: true }, { code: 'OLD', name: 'Old', active: false }]
const sync = (over: Partial<SyncCell> = {}): SyncCell => ({ kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 6, held: 6, buffer: 2, poolAvailable: 8, routedLocations: [], fbaAtAmazon: 0, oversold: false, ...over })
const synced = (over: Partial<SyncCell> = {}, more: Partial<MatrixCells> = {}) => cells({ source: SRC, fulfilment: { method: 'FBA', source: 'set', guard: null, reported: null }, sync: sync(over), ...more })

const statusCell = (over: Partial<PublishActionCell> = {}): PublishActionCell => ({
  listingId: 'L1', productId: 'p', sku: 'S', channel: 'AMAZON', marketplace: 'IT', accountId: 'a', aliasKey: '', state: 'active', stateReason: null,
  send: { mode: 'partial', setAt: null, setById: null, setByName: null, noLongerApplies: null },
  status: { target: null, setAt: null, setById: null, setByName: null, noLongerApplies: null },
  sendOptions: [],
  statusOptions: [
    { target: 'active', offered: true, action: null, reason: null, warning: null, checkedAtSend: null },
    { target: 'inactive', offered: true, action: null, reason: null, warning: null, checkedAtSend: null },
    { target: 'ended', offered: false, action: null, reason: 'Amazon has no Ended', warning: null, checkedAtSend: null },
  ],
  ...over,
} as PublishActionCell)

const ROWS = [{ id: 'a', sku: 'A', name: 'Nero · S', isParent: false, basePrice: 105 }, { id: 'b', sku: 'B', name: 'Nero · M', isParent: false, basePrice: 99.75 }]
function ctx(over: Partial<BulkContext> = {}, table: Record<string, MatrixCells> = {}): BulkContext {
  const all: Record<string, MatrixCells> = {
    'a|AMAZON:EU': synced(), 'b|AMAZON:EU': synced({ kind: 'PINNED', mode: 'PINNED', intended: 5 }),
    'a|AMAZON:IT': priced(105), 'b|AMAZON:IT': priced(99.75, { value: 80, start: '2026-10-01', end: '2026-10-31' }),
    ...table,
  }
  return {
    rows: ROWS,
    coordinates: [EU, IT, EBAY],
    cellsOf: (rowId, key) => all[`${rowId}|${key}`] ?? null,
    statusCellOf: (rowId, c) => (c.key === 'AMAZON:IT' ? statusCell({ listingId: `L-${rowId}`, sku: rowId.toUpperCase() }) : null),
    canEdit: true, canPrice: true, statusHeld: null, canDelete: false, focusedKey: null, locations: LOCATIONS,
    handoffHeld: { casePack: null, stockPool: null },
    ...over,
  }
}

describe('the catalogue', () => {
  it('lists the eleven fields in their groups, each with its plain line', () => {
    expect(bulkFields(ctx()).map((f) => [f.group, f.label, f.description])).toEqual([
      ['Prices', 'Base price', 'The price every market uses by default'],
      ['Prices', 'Market price', 'Its own price on chosen markets'],
      ['Prices', 'Sale', 'A lower price between two dates'],
      ['Listing', 'Status', 'For sale (Active), paused or ended'],
      ['Listing', 'Fulfilment', 'Who ships: Amazon (FBA) or you (FBM)'],
      ['Stock', 'Quantity', 'How many units a market shows'],
      ['Stock', 'Buffer', 'Units held back to avoid overselling'],
      ['Stock', 'Stock sync', 'Hold, release or resend stock updates'],
      ['Stock', 'Sells from', 'The warehouses a market sells from'],
      ['Stock', 'Case size', 'Units per case, for Amazon shipments'],
      ['Stock', 'Stock source', 'Your own stock, or a partner\'s'],
    ])
  })
  it('names each mode as the design says, Raise and Lower in % or money, the hand-offs as their own editor', () => {
    const modes = (f: BulkFieldId) => bulkModes(f).map((m) => `${m.label}:${m.input}`)
    expect(modes('basePrice')).toEqual(['Set to:money', 'Raise:adjust', 'Lower:adjust'])
    expect(modes('price')).toEqual(['Set to:money', 'Raise:adjust', 'Lower:adjust', 'Copy from:choice', 'Use base price:none'])
    expect(modes('salePrice')).toEqual(['Set a sale:sale', 'Remove the sale:none'])
    expect(modes('quantity')).toEqual(['Follow stock:none', 'Fixed number:integer'])
    expect(modes('stockSync')).toEqual(['Hold:none', 'Release:none', 'Push now:none', 'Retry:none'])
    expect(modes('stockSource')).toEqual(['Set to:locations', 'Use the default:none'])
    expect(bulkModes('basePrice')[1]!.units).toEqual(['percent', 'money'])
    expect(bulkModes('casePack')).toEqual([expect.objectContaining({ id: 'open', input: 'handoff', inputLabel: 'Open case sizes…' })])
    expect(bulkModes('stockPool')).toEqual([expect.objectContaining({ id: 'open', input: 'handoff', inputLabel: 'Open stock source…' })])
    expect(bulkModes('listingStatus')[0]!.hint).toBe('Saved in Nexus now. Publish sends it to each market.')
  })
  it('maps the column the operator was in to its field', () => {
    expect((['price', 'salePrice', 'fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'listing'] as const).map(bulkFieldOfKind))
      .toEqual(['price', 'salePrice', 'fulfilment', 'quantity', 'quantity', 'buffer', 'stockSync', null])
  })
})

describe('bulkFields', () => {
  it('offers every field for these rows', () => {
    expect(bulkFields(ctx()).every((f) => f.held === null)).toBe(true)
  })
  it('holds every field but Status for a role without products.edit — never a 403 later', () => {
    const held = bulkFields(ctx({ canEdit: false, canPrice: false })).filter((f) => f.held === BULK_EDIT_PERMISSION).map((f) => f.id)
    expect(held).toEqual(['basePrice', 'price', 'salePrice', 'fulfilment', 'quantity', 'buffer', 'stockSync', 'stockSource'])
  })
  it('holds the three price fields, with the reason, for a role that cannot change prices', () => {
    const held = bulkFields(ctx({ canPrice: false })).filter((f) => f.held)
    expect(held.map((f) => f.id)).toEqual(['basePrice', 'price', 'salePrice'])
    expect(held[0]!.held).toBe(BULK_PRICE_PERMISSION)
  })
  it('holds the per-market fields for a parent-only selection, and keeps Base price, the parent\'s own Status and the hand-offs', () => {
    const fields = bulkFields(ctx({ rows: [{ id: 'p', sku: 'P', name: null, isParent: true, basePrice: 105 }] }))
    expect(fields.filter((f) => f.held === null).map((f) => f.id)).toEqual(['basePrice', 'listingStatus', 'casePack', 'stockPool'])
    expect(fields.find((f) => f.id === 'fulfilment')!.held).toBe(BULK_PARENT_ONLY)
  })
  it('Sells from: held without the right to adjust stock, or with no active warehouse (an older server sends none)', () => {
    const of = (c: BulkContext) => bulkFields(c).find((f) => f.id === 'stockSource')!.held
    expect(of(ctx({ canStock: false }))).toBe(MATRIX_COPY.sourcePermission)
    expect(of(ctx({ locations: undefined }))).toBe(BULK_NO_WAREHOUSE)
    expect(of(ctx({ locations: [{ code: 'OLD', name: 'Old', active: false }] }))).toBe(BULK_NO_WAREHOUSE)
    expect(of(ctx())).toBeNull()
  })
  it('holds Status with the read\'s own reason', () => {
    expect(bulkFields(ctx({ statusHeld: 'Your role cannot publish' })).find((f) => f.id === 'listingStatus')!.held).toBe('Your role cannot publish')
  })
  it('holds a hand-off with the page\'s reason, or when the page offers none', () => {
    const of = (c: BulkContext, id: BulkFieldId) => bulkFields(c).find((f) => f.id === id)!.held
    expect(of(ctx({ handoffHeld: { casePack: BULK_CASE_NOT_AMAZON, stockPool: null } }), 'casePack')).toBe(BULK_CASE_NOT_AMAZON)
    expect(of(ctx({ handoffHeld: undefined }), 'stockPool')).toBe(BULK_NO_HANDOFF)
  })
  it('Case size: held without inventory.adjust, off Amazon, with no variant, or with case sizes not read', () => {
    const ok = { canStock: true, onAmazon: true, members: 3, packsRead: true }
    expect(caseHandoffHeld(ok)).toBeNull()
    expect(caseHandoffHeld({ ...ok, canStock: false })).toBe(BULK_CASE_PERMISSION)
    expect(caseHandoffHeld({ ...ok, onAmazon: false })).toBe(BULK_CASE_NOT_AMAZON)
    expect(caseHandoffHeld({ ...ok, packsRead: false })).toBe(BULK_CASE_NOT_READ)
  })
})

describe('markets', () => {
  it('offers only the markets that serve the field; one the rows are not on is held, not hidden', () => {
    expect(bulkMarkets(ctx(), 'fulfilment').map((m) => [m.key, m.held])).toEqual([['AMAZON:EU', null], ['EBAY:IT', 'None of these rows is on this market']])
    expect(bulkMarkets(ctx(), 'price').map((m) => m.key)).toEqual(['AMAZON:IT', 'EBAY:IT'])
    expect(bulkMarkets(ctx(), 'basePrice')).toEqual([])
    expect(bulkMarkets(ctx(), 'casePack')).toEqual([])
    // Sells from: once per group that carries the quantity — Amazon EU's region group, never its markets.
    expect(bulkMarkets(ctx(), 'stockSource').map((m) => [m.key, m.held])).toEqual([['AMAZON:EU', null], ['EBAY:IT', 'None of these rows is on this market']])
  })
  it('says once which markets on screen do not take the field at all', () => {
    const c = ctx({ coordinates: [EU, IT, EBAY, SHOP] })
    expect(bulkMarketsNote(c, 'salePrice')).toBe('Not on eBay IT: no sale price there')
    expect(bulkMarketsNote(c, 'fulfilment')).toBe('Not on Shopify: no fulfilment method there')
    // Amazon IT's stock is Amazon EU's (its inventory group), and a region group has no listing columns: neither is named.
    expect(bulkMarketsNote(c, 'quantity')).toBeNull()
    expect(bulkMarketsNote(c, 'price')).toBeNull()
    expect(bulkMarketsNote(c, 'basePrice')).toBeNull()
  })
  it('ticks the focused market when it serves the field, else every market the rows are on', () => {
    expect(bulkDefaultMarkets(ctx({ focusedKey: 'AMAZON:EU' }), 'fulfilment')).toEqual(['AMAZON:EU'])
    expect(bulkDefaultMarkets(ctx({ focusedKey: 'AMAZON:EU' }), 'price')).toEqual(['AMAZON:IT'])
  })
  it('ticks only the Amazon markets for Fulfilment when nothing is focused: FBA / FBM is Amazon\'s choice', () => {
    const both: BulkContext = ctx({ cellsOf: (_rowId, key) => (key === 'EBAY:IT' || key === 'AMAZON:EU' ? synced() : null) })
    expect(bulkDefaultMarkets(both, 'fulfilment')).toEqual(['AMAZON:EU'])
    expect(bulkDefaultMarkets(both, 'quantity')).toEqual(['AMAZON:EU', 'EBAY:IT'])
  })
  it('offers the methods the chosen markets have, and the Status targets their cells offer', () => {
    expect(bulkChoices(ctx(), 'fulfilment', 'method', ['AMAZON:EU']).map((c) => c.value)).toEqual(['FBA', 'FBM'])
    expect(bulkChoices(ctx(), 'fulfilment', 'method', ['AMAZON:EU', 'EBAY:IT']).map((c) => c.value)).toEqual(['FBA', 'FBM', 'MCF'])
    expect(bulkChoices(ctx(), 'listingStatus', 'status', ['AMAZON:IT']).map((c) => c.label)).toEqual(['Active', 'Inactive'])
  })
  it('Copy from: every market with a price is a choice, the ticked ones too; the one chosen is never a target', () => {
    const c = ctx({}, { 'a|EBAY:IT': priced(110), 'b|EBAY:IT': priced(101) })
    expect(bulkChoices(c, 'price', 'copy', ['AMAZON:IT', 'EBAY:IT']).map((o) => o.value)).toEqual(['AMAZON:IT', 'EBAY:IT'])
    expect(verbTargets(c, 'price', ['AMAZON:IT', 'EBAY:IT'], 'EBAY:IT')).toEqual([{ rowId: 'a', coordinateKey: 'AMAZON:IT' }, { rowId: 'b', coordinateKey: 'AMAZON:IT' }])
    // A market where none of these rows has a price is no choice ("Nothing to choose" never shows while markets are ticked).
    expect(bulkChoices(ctx(), 'price', 'copy', ['AMAZON:IT']).map((o) => o.value)).toEqual(['AMAZON:IT'])
  })
})

describe('the rows as they are now', () => {
  const row = (role: 'parent' | 'variant', lender?: string): Pick<MatrixRowRead, 'role' | 'stock'> =>
    ({ role, stock: { available: 6, uncounted: false, locations: [], source: lender ? { kind: 'pool', grantId: 'g', lenderName: lender } : null } })
  const words = (c: BulkContext, field: BulkFieldId, keys: string[]) => bulkCurrent(c, field, keys).map((l) => [l.sku, l.name, l.where, l.now, l.note])

  it('Base price: one line per row in the Shared group, with the variant\'s name', () => {
    expect(words(ctx(), 'basePrice', [])).toEqual([['A', 'Nero · S', 'Shared', '€105.00', null], ['B', 'Nero · M', 'Shared', '€99.75', null]])
  })
  it('Market price and Sale: the cell\'s words and the price\'s own mark; no sale is the grid\'s dash', () => {
    const c = ctx({}, { 'a|AMAZON:IT': priced(105, null, 'master'), 'b|AMAZON:IT': priced(99.75, { value: 80, start: '2026-10-01', end: '2026-10-31' }) })
    expect(words(c, 'price', ['AMAZON:IT'])).toEqual([['A', 'Nero · S', 'Amazon · IT', '€105.00', BULK_FOLLOWS_BASE], ['B', 'Nero · M', 'Amazon · IT', '€99.75', 'Set here']])
    expect(words(c, 'salePrice', ['AMAZON:IT']).map((w) => w[3])).toEqual(['—', '€80.00 · 1 Oct → 31 Oct'])
  })
  it('Status: the grid\'s word — a waiting change shows its target and waits for Publish; a draft reads Not listed', () => {
    const c = ctx({ statusCellOf: (rowId, k) => (k.key !== 'AMAZON:IT' ? null : rowId === 'a'
      ? statusCell({ status: { target: 'inactive', setAt: null, setById: null, setByName: null, noLongerApplies: null } })
      : statusCell({ state: 'draft' })) })
    expect(words(c, 'listingStatus', ['AMAZON:IT']).map((w) => [w[3], w[4]])).toEqual([['Inactive', 'Waits for Publish'], ['Not listed', null]])
  })
  it('Fulfilment, Quantity, Buffer and Stock sync in the grid\'s words: a pinned row has no buffer', () => {
    const c = ctx({}, { 'a|AMAZON:EU': synced({}, { queue: { state: 'failed', at: null, reason: 'x', syncType: 'QUANTITY_UPDATE', via: null } }) })
    expect(words(c, 'fulfilment', ['AMAZON:EU']).map((w) => w[3])).toEqual(['FBA', 'FBA'])
    expect(words(c, 'quantity', ['AMAZON:EU']).map((w) => w[3])).toEqual(['Follow · 6', 'Pinned · 5'])
    expect(words(c, 'buffer', ['AMAZON:EU']).map((w) => w[3])).toEqual(['2', '—'])
    expect(words(c, 'stockSync', ['AMAZON:EU']).map((w) => w[3])).toEqual(['Failed', '—'])
  })
  it('Sells from: the From cell\'s words', () => {
    expect(words(ctx({ rowOf: () => row('variant') }), 'stockSource', ['AMAZON:EU']).map((w) => w[3])).toEqual(['IT-MAIN', 'IT-MAIN'])
    expect(words(ctx({ rowOf: () => row('variant', 'Xavia') }), 'stockSource', ['AMAZON:EU']).map((w) => w[3])).toEqual(['Shared', 'Shared'])
  })
  it('Case size and Stock source: what the Shared cells show, one line per row', () => {
    expect(words(ctx({ caseTextOf: (id) => (id === 'a' ? '12 / case' : '') }), 'casePack', []).map((w) => [w[2], w[3]])).toEqual([['Shared', '12 / case'], ['Shared', '—']])
    expect(words(ctx({ rowOf: (id) => row('variant', id === 'a' ? 'Xavia' : undefined) }), 'stockPool', []).map((w) => w[3])).toEqual(['Shared · Xavia', 'Own stock'])
    expect(bulkCurrent(ctx(), 'casePack', [])).toEqual([])
  })
  it('sorts by the rows, then the markets; a row not on a chosen market has no line; ids are unique', () => {
    const c = ctx({}, { 'b|EBAY:IT': priced(101) })
    const lines = bulkCurrent(c, 'price', ['EBAY:IT', 'AMAZON:IT'])
    expect(lines.map((l) => [l.sku, l.where])).toEqual([['A', 'Amazon · IT'], ['B', 'Amazon · IT'], ['B', 'eBay · IT']])
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length)
    expect(lines.every((l) => l.next === null && l.skipped === null)).toBe(true)
  })
})

describe('the mode a field opens on', () => {
  it('Quantity: Fixed number when every listing already follows its stock, else Follow stock', () => {
    expect(bulkDefaultMode(ctx(), 'quantity', ['AMAZON:EU'])).toBe('follow')
    expect(bulkDefaultMode(ctx({}, { 'b|AMAZON:EU': synced() }), 'quantity', ['AMAZON:EU'])).toBe('pin')
  })
  it('Stock sync: Retry when a push failed, Release when a sync is held, else Hold', () => {
    const failed = cells({ sync: sync(), queue: { state: 'failed', at: null, reason: 'x', syncType: 'QUANTITY_UPDATE', via: null } })
    const held = cells({ sync: sync({ kind: 'PAUSED', via: 'LISTING' }), queue: { state: 'paused', at: null, reason: null, syncType: null, via: 'LISTING' } })
    expect(bulkDefaultMode(ctx({}, { 'a|AMAZON:EU': failed, 'b|AMAZON:EU': held }), 'stockSync', ['AMAZON:EU'])).toBe('retry')
    expect(bulkDefaultMode(ctx({}, { 'b|AMAZON:EU': held }), 'stockSync', ['AMAZON:EU'])).toBe('release')
    expect(bulkDefaultMode(ctx(), 'stockSync', ['AMAZON:EU'])).toBe('hold')
    expect(bulkDefaultMode(ctx(), 'price', ['AMAZON:IT'])).toBeNull()
  })
})

describe('verbs', () => {
  it('maps each field and mode to its Matrix verb; Raise and Lower carry the sign, an amount its currency', () => {
    expect(verbParams('fulfilment', 'method', { choice: 'FBM' })).toEqual({ verb: 'set-fulfilment', method: 'FBM' })
    expect(verbParams('quantity', 'follow', {})).toEqual({ verb: 'set-follow' })
    expect(verbParams('quantity', 'pin', { amount: 4 })).toEqual({ verb: 'pin-quantity', value: 4 })
    expect(verbParams('price', 'lower', { percent: -5 })).toEqual({ verb: 'adjust-prices', percent: -5 })
    expect(verbParams('price', 'lower', { percent: 5 })).toEqual({ verb: 'adjust-prices', percent: -5 })
    expect(verbParams('price', 'raise', { delta: 2 }, 'GBP')).toEqual({ verb: 'adjust-prices', amount: 2, currency: 'GBP' })
    expect(verbParams('price', 'lower', { delta: -2.5 }, 'EUR')).toEqual({ verb: 'adjust-prices', amount: -2.5, currency: 'EUR' })
    expect(verbParams('price', 'follow-base', {})).toBeNull()
    expect(verbParams('stockSync', 'hold', {})).toEqual({ verb: 'pause-sync' })
    expect(verbParams('price', 'set', {})).toBeNull()
    // Sells from: the codes in sale order; "Use the default" sends [] (the market default again); nothing ticked = no verb.
    expect(verbParams('stockSource', 'sources', { codes: ['MI-3PL', 'IT-MAIN'] })).toEqual({ verb: 'set-source', codes: ['MI-3PL', 'IT-MAIN'] })
    expect(verbParams('stockSource', 'default', {})).toEqual({ verb: 'set-source', codes: [] })
    expect(verbParams('stockSource', 'sources', { codes: [] })).toBeNull()
    expect(verbTargets(ctx(), 'stockSource', ['AMAZON:EU', 'EBAY:IT'])).toEqual([{ rowId: 'a', coordinateKey: 'AMAZON:EU' }, { rowId: 'b', coordinateKey: 'AMAZON:EU' }])
  })
  it('targets every ticked variant on every chosen market where it has the field', () => {
    expect(verbTargets(ctx(), 'fulfilment', ['AMAZON:EU', 'EBAY:IT'])).toEqual([{ rowId: 'a', coordinateKey: 'AMAZON:EU' }, { rowId: 'b', coordinateKey: 'AMAZON:EU' }])
  })
  it('turns the server preview into lines in row order: a refusal\'s Now is the row as it is, never empty', () => {
    const lines = verbLines({
      changes: [{ rowId: 'b', sku: 'B', coordinateKey: 'AMAZON:EU', cell: 'fulfilment', from: 'FBA', to: 'FBM', fromLabel: 'FBA', toLabel: 'FBM', note: 'Follow → 6' }],
      refusals: [{ rowId: 'a', sku: 'A', coordinateKey: 'AMAZON:EU', kind: 'guard', reason: 'Refused — 3 units of FBA stock on hand keep the guard closed' }],
    }, ctx(), { field: 'fulfilment', mode: 'method' }, (rowId) => (rowId === 'a' ? 'FBA' : null))
    expect(lines.map((l) => [l.sku, l.name, l.where, l.now, l.next, l.note, l.skipped])).toEqual([
      ['A', 'Nero · S', 'Amazon EU · IT DE FR ES', 'FBA', null, null, 'Refused — 3 units of FBA stock on hand keep the guard closed'],
      ['B', 'Nero · M', 'Amazon EU · IT DE FR ES', 'FBA', 'FBM', 'Follow → 6', null],
    ])
    expect(lines.map((l) => [coordinateOfVerbLine(l), isVerbChangeLine(l)])).toEqual([['AMAZON:EU', false], ['AMAZON:EU', true]])
    expect(lines.every((l) => l.id.startsWith('fulfilment|method|'))).toBe(true)
  })
  it('notices carry a tone: the server\'s facts are info, a fulfilment change and a hold are warnings', () => {
    expect(verbNotices({ verb: 'set-fulfilment', notices: ['Sent to Amazon on IT'] })).toEqual([{ text: 'Sent to Amazon on IT', tone: 'warning' }])
    // Amazon EU's one quantity is a fact on a fulfilment change too.
    expect(verbNotices({ verb: 'set-fulfilment', notices: ['Amazon EU: this covers IT DE'] })).toEqual([{ text: 'Amazon EU: this covers IT DE', tone: 'info' }])
    expect(verbNotices({ verb: 'pause-sync', notices: [] })).toEqual([{ text: BULK_HOLD_NOTICE, tone: 'warning' }])
    expect(verbNotices({ verb: 'set-buffer', notices: ['Amazon EU: this covers IT DE'] })).toEqual([{ text: 'Amazon EU: this covers IT DE', tone: 'info' }])
    expect(verbNotices({ verb: 'set-price', notices: [] })).toEqual([{ text: BULK_SENT.prices, tone: 'info' }])
  })
  it('says the result in words, counting what the server applied', () => {
    expect(verbSentence({ verb: 'set-fulfilment', changes: [{ toLabel: 'FBM', coordinateKey: 'AMAZON:EU' } as never] }, 10, 2)).toBe('10 listings sent to Amazon as FBM · 2 skipped. The Fulfilment cell says Confirmed when Amazon\'s report shows it (read every 15 min, up to 24 h).')
    expect(verbSentence({ verb: 'set-fulfilment', changes: [{ toLabel: 'MCF', coordinateKey: 'EBAY:IT' } as never] }, 1, 0)).toBe('1 listing set to MCF in Nexus.')
    expect(verbSentence({ verb: 'set-price', changes: [] }, 1, 0)).toBe('1 price changed. Nexus sends it in about 30 seconds.')
    expect(verbSentence({ verb: 'set-price', changes: [] }, 0, 3)).toBe('0 prices changed · 3 skipped.')
    expect(verbSentence({ verb: 'set-source', changes: [{ to: ['MI-3PL', 'IT-MAIN'] } as never] }, 3, 1)).toBe('3 listings sell from MI-3PL + IT-MAIN · 1 skipped.')
    expect(verbSentence({ verb: 'set-source', changes: [{ to: [] } as never] }, 1, 0)).toBe('1 listing uses its market default again.')
    expect(verbSentence({ verb: 'set-source', changes: [{ to: [] } as never] }, 2, 0)).toBe('2 listings use their market default again.')
  })
})

describe('lines the page works out', () => {
  it('Base price: set to a value; a row already at it is skipped, said plainly', () => {
    const lines = basePriceLines(ctx(), 'set', { amount: 105 }, 'EUR')
    expect(lines.map((l) => [l.sku, l.name, l.where, l.now, l.next, l.skipped])).toEqual([['A', 'Nero · S', 'Shared', '€105.00', null, 'Already €105.00'], ['B', 'Nero · M', 'Shared', '€99.75', '€105.00', null]])
  })
  it('Base price: Raise or Lower by a percentage or an amount, rounded to the cent; 0 or less is skipped', () => {
    expect(basePriceLines(ctx(), 'raise', { percent: 10 }, 'EUR').map((l) => l.next)).toEqual(['€115.50', '€109.73'])
    expect(basePriceLines(ctx(), 'lower', { percent: -10 }, 'EUR').map((l) => l.next)).toEqual(['€94.50', '€89.78'])
    expect(basePriceLines(ctx(), 'lower', { delta: -2 }, 'EUR').map((l) => l.next)).toEqual(['€103.00', '€97.75'])
    expect(basePriceLines(ctx(), 'lower', { delta: -100 }, 'EUR').map((l) => [l.next, l.skipped])).toEqual([['€5.00', null], [null, BULK_PRICE_ABOVE_0]])
    expect(basePriceLines(ctx({ rows: [{ id: 'n', sku: 'N', name: null, isParent: false, basePrice: null }] }), 'raise', { percent: 5 }, 'EUR')[0]!.skipped).toMatch(/no base price/)
  })
  it('Base price: a drop of 30 % or more asks for the typed word, whatever the mode', () => {
    expect(dropsBy30(basePriceLines(ctx(), 'lower', { percent: -30 }, 'EUR'))).toBe(true)
    expect(dropsBy30(basePriceLines(ctx(), 'set', { amount: 70 }, 'EUR'))).toBe(true)
    expect(dropsBy30(basePriceLines(ctx(), 'lower', { delta: -5 }, 'EUR'))).toBe(false)
    expect(largeChangeWord(100)).toBe('APPLY')
    expect(largeChangeWord(3, -30)).toBe('APPLY')
    expect(largeChangeWord(3, -5)).toBeNull()
  })
  it('Use base price: a price that follows it or that a formula sets is skipped; a locked cell says its own reason', () => {
    const c = ctx({}, {
      'a|AMAZON:IT': priced(105, null, 'master'),
      'b|AMAZON:IT': priced(99.75),
      'a|EBAY:IT': priced(110, null, 'formula'),
      'b|EBAY:IT': cells({ price: { value: 101, currency: 'EUR', source: 'override', formula: null, clamped: null }, writable: { price: false }, writeBlockedReason: { price: 'Amazon-managed' } }),
    })
    const lines = followBaseLines(c, ['AMAZON:IT', 'EBAY:IT'])
    expect(lines.map((l) => [l.sku, l.where, l.now, l.next, l.skipped])).toEqual([
      ['A', 'Amazon · IT', '€105.00', null, BULK_ALREADY_FOLLOWS],
      ['A', 'eBay · IT', '€110.00', null, BULK_FORMULA_PRICE],
      ['B', 'Amazon · IT', '€99.75', BULK_FOLLOWS_BASE, null],
      ['B', 'eBay · IT', '€101.00', null, 'Amazon-managed'],
    ])
  })
  it('Sale: set on the chosen market in the grid\'s words; a sale at or above the price is skipped with the price named', () => {
    const lines = saleLines(ctx(), 'sale-set', { sale: { value: 99.75, start: '2026-11-01', end: '2026-11-30' } }, ['AMAZON:IT'])
    expect(lines.map((l) => [l.sku, l.now, l.next, l.skipped])).toEqual([
      ['A', '—', '€99.75 · 1 Nov → 30 Nov', null],
      ['B', '€80.00 · 1 Oct → 31 Oct', null, 'The sale price must be below the price (€99.75)'],
    ])
  })
  it('Sale: remove; a row with no sale is skipped', () => {
    expect(saleLines(ctx(), 'sale-remove', {}, ['AMAZON:IT']).map((l) => [l.sku, l.next, l.skipped])).toEqual([['A', null, 'No sale to remove'], ['B', '—', null]])
  })
  it('Sale notices name only the channels chosen: Amazon gets it, Shopify never does', () => {
    const c = ctx({ coordinates: [EU, IT, EBAY, SHOP] })
    expect(saleNotices(c, 'sale-set', ['AMAZON:IT'])).toEqual([{ text: BULK_SENT.amazonSale, tone: 'info' }])
    const shop = saleNotices(c, 'sale-set', ['SHOPIFY:GLOBAL'])
    expect(shop).toEqual([{ text: 'Nexus does not send a sale price to Shopify: there the sale stays in Nexus only.', tone: 'warning' }])
    expect(shop.some((n) => n.text.includes('Amazon'))).toBe(false)
  })
  it('Status: waits for Publish; a target the cell does not offer is skipped with the cell\'s own reason', () => {
    expect(statusLines(ctx(), 'inactive', ['AMAZON:IT']).map((l) => [l.sku, l.now, l.next, l.note])).toEqual([['A', 'Active', 'Inactive', 'Waits for Publish'], ['B', 'Active', 'Inactive', 'Waits for Publish']])
    expect(statusLines(ctx(), 'ended', ['AMAZON:IT']).map((l) => l.skipped)).toEqual(['Amazon has no Ended', 'Amazon has no Ended'])
    expect(statusLines(ctx(), 'active', ['AMAZON:IT']).map((l) => l.skipped)).toEqual(['Already Active', 'Already Active'])
  })
  it('Status never creates a listing: a row not on the market yet is skipped, and a market with only such rows is held', () => {
    const fresh = ctx({ statusCellOf: (rowId, c) => (c.key === 'AMAZON:IT' ? statusCell({ listingId: `new:${rowId}`, create: { target: 'not_listed', source: 'default', sentence: null } as never }) : null) })
    expect(statusLines(fresh, 'inactive', ['AMAZON:IT']).map((l) => l.skipped)).toEqual([BULK_STATUS_NEW_ROW, BULK_STATUS_NEW_ROW])
    expect(bulkMarkets(fresh, 'listingStatus').map((m) => [m.key, m.held])).toEqual([['AMAZON:IT', 'None of these rows is on this market'], ['EBAY:IT', 'None of these rows is on this market']])
    expect(bulkFields(fresh).find((f) => f.id === 'listingStatus')!.held).toMatch(/None of these rows has a Status/)
  })
  it('every line id says its field and mode, so two previews never share one (the stale-reason bug)', () => {
    const c = ctx()
    const ids = [
      ...basePriceLines(c, 'set', { amount: 1 }, 'EUR'), ...basePriceLines(c, 'raise', { percent: 1 }, 'EUR'),
      ...saleLines(c, 'sale-remove', {}, ['AMAZON:IT']), ...statusLines(c, 'inactive', ['AMAZON:IT']), ...followBaseLines(c, ['AMAZON:IT']),
      ...bulkCurrent(c, 'price', ['AMAZON:IT']), ...bulkCurrent(c, 'salePrice', ['AMAZON:IT']),
    ].map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
