/**
 * Lane01 part 4 — Shopify undo restores the value AND the actual own/follow state (equal values included), refuses the
 * legacy "saved pin while the rule still follows" state explicitly, and its private history value never reaches a
 * cell, a sort, a copy, a validation or a save. Driven through the real Shopify column value setter and the sheet's
 * real undo history and replay.
 */
import { describe, expect, it, vi } from 'vitest'
import { informationRegistry } from '@nexus/shared/shopify-information'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { commitChannelRow } from '../sheet/channel/useChannelSheet'
import { SheetUndoHistory, writeHistoryValues, isHistoryOnly } from '../sheet/sheetUndo'
import type { ChannelSheetRow, SheetColumn, StudioCellValue } from '../sheet/channel/types'
import { shopifyDraftColumn } from './ShopifyDraftCell'
import { isShopifyHistoryValue, shopifyDraftState, shopifyHistoryChange, takeShopifyReplayIntent } from './draftHistory'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => '' }))
const schema = { revision: 'synthetic', currency: 'EUR', metaobjectDefinitions: [], types: [], locales: [{ locale: 'en', primary: true }], definitions: [
  { id: 'def-label', namespace: 'custom', key: 'label', name: 'Shared label', ownerType: 'PRODUCT', type: 'single_line_text_field', validations: [], description: null, access: { admin: null, storefront: null } },
] } as unknown as ShopifyStoreSchema
const field = informationRegistry(schema).find(f => f.id === 'metafield:PRODUCT:custom.label')!
const key = field.id
const column = { key, label: 'Shared label', shopifyField: field } as unknown as SheetColumn
const source = 'gid://shopify/Product/20'
const cell = (value: string, sharing: { sourceOwnerId: string; follows: boolean } | null | undefined, pinned: boolean): StudioCellValue => ({
  value, source: pinned ? 'channelExplicit' : 'channelSnapshot', inheritedFrom: null, inherited: !pinned, layer: pinned ? 'channel' : 'linked', pinned, follows: !pinned,
  editable: true, linkGroupId: null, mapped: null, writeField: key, writeTarget: 'channelListing', writeVerb: 'channel', affectsAllChannels: false, writable: true,
  shopifyWrite: { ownerId: 'gid://shopify/Product/10', fieldId: key, token: 'token-1', baseline: 'Provider', ...(sharing === undefined ? {} : { sharing }) },
} as unknown as StudioCellValue)
const row = (value: StudioCellValue) => ({ id: 'nexus-family', rowId: 'primary:nexus-family', sku: 'SYN-1', version: 1, aliasId: null, listing: { id: 'listing-a', version: 1 },
  shopify: { productId: 'nexus-family', listingId: 'listing-a' }, values: { [key]: value } }) as unknown as ChannelSheetRow

/** AG's setValue as the sheet sees it: the value setter, then `cellValueChanged` with the value READ BACK from the row. */
function grid(data: ChannelSheetRow, refused: string[] = []) {
  const def = shopifyDraftColumn(column, () => undefined, undefined, (r, c, earlier) => refused.push(`${r.sku} · ${c.label}: ${earlier}`))
  const writes: Array<{ value: unknown; intent: string }> = [], history = new SheetUndoHistory()
  const changed = (oldValue: unknown, source: string) => {
    const current = data.values[key], newValue = current.value
    if (source !== 'undo' && source !== 'redo') {
      const entry = shopifyHistoryChange(current, oldValue, newValue)
      history.record({ rowId: data.rowId, colId: key, before: entry ? entry.before : oldValue, after: entry ? entry.after : newValue })
    }
    const replay = takeShopifyReplayIntent(current)
    writes.push({ value: replay === 'reset' ? null : newValue, intent: replay ?? 'set' })
  }
  const node = { setDataValue: (_colId: string, value: unknown, source: string) => {
    const oldValue = data.values[key].value
    if (!(def.valueSetter as (p: unknown) => boolean)({ data, newValue: value, oldValue })) return false
    changed(oldValue, source); return true
  } }
  const api = { getRowNode: () => node, getColumn: () => ({ getColDef: () => ({ context: { readsHistoryValue: true } }) }) }
  const apply = (values: Array<{ rowId: string; colId: string; value: unknown }>, direction: 'undo' | 'redo') => writeHistoryValues(api, values, direction)
  return { def, writes, history, edit: (value: string) => node.setDataValue(key, value, 'edit'), undo: () => history.undo(apply), redo: () => history.redo(apply) }
}

describe('a Shopify cell reports its own/follow state from the server facts only', () => {
  it.each([
    ['own (no sharing rule, own value)', cell('A', null, true), 'own'],
    ['follow (no sharing rule, inherited)', cell('A', null, false), 'follow'],
    ['own (the shared source)', cell('A', { sourceOwnerId: 'gid://shopify/Product/10', follows: false }, true), 'own'],
    ['own (an excluded follower)', cell('A', { sourceOwnerId: source, follows: false }, true), 'own'],
    ['follow (a follower)', cell('A', { sourceOwnerId: source, follows: true }, false), 'follow'],
    ['contradictory (a legacy pin under a following rule)', cell('A', { sourceOwnerId: source, follows: true }, true), 'contradictory'],
    ['unknown (facts not reported: never proof)', cell('A', undefined, true), 'unknown'],
  ] as const)('%s', (_name, value, state) => expect(shopifyDraftState(value)).toBe(state))
})

describe('Shopify undo restores the value and the own/follow state', () => {
  it('undoes a follower set to the SAME value by restoring following (reset), and redoes it as own', () => {
    const data = row(cell('Shared', { sourceOwnerId: source, follows: true }, false)), g = grid(data)
    g.edit('Shared')
    expect(g.writes).toEqual([{ value: 'Shared', intent: 'set' }])
    expect(shopifyDraftState(data.values[key])).toBe('own')
    expect(g.undo()).toBe(1)
    expect(g.writes.at(-1)).toEqual({ value: null, intent: 'reset' })
    expect(data.values[key]).toMatchObject({ value: 'Shared', pinned: false, inherited: true })
    expect(shopifyDraftState(data.values[key])).toBe('follow')
    expect(g.redo()).toBe(1)
    expect(g.writes.at(-1)).toEqual({ value: 'Shared', intent: 'set' })
    expect(shopifyDraftState(data.values[key])).toBe('own')
  })
  it('undoes an own value change back to the earlier own value (set), and a second edit keeps the FIRST before', () => {
    const data = row(cell('Mine', { sourceOwnerId: source, follows: false }, true)), g = grid(data)
    g.history.begin(); g.edit('Draft 1'); g.edit('Draft 2'); g.history.end()
    expect(g.undo()).toBe(1)
    expect(g.writes.at(-1)).toEqual({ value: 'Mine', intent: 'set' })
    expect(data.values[key]).toMatchObject({ value: 'Mine', pinned: true })
  })
  it('restores following for a cell with no sharing rule (its inherited value) as a reset', () => {
    const data = row(cell('Provider', null, false)), g = grid(data)
    g.edit('Typed')
    g.undo()
    expect(g.writes.at(-1)).toEqual({ value: null, intent: 'reset' })
  })
  it('REFUSES the legacy contradictory state explicitly, writes nothing and names the earlier value', () => {
    const refused: string[] = []
    const data = row(cell('Saved separate label', { sourceOwnerId: source, follows: true }, true)), g = grid(data, refused)
    g.edit('New own label')
    const writes = g.writes.length
    g.undo()
    expect(g.writes).toHaveLength(writes)
    expect(data.values[key]).toMatchObject({ value: 'New own label' })
    expect(refused).toEqual(['SYN-1 · Shared label: Saved separate label'])
  })
  it('without reported sharing facts, undo restores the value only (the plain sheet undo) and claims no state', () => {
    const data = row(cell('Before', undefined, true)), g = grid(data)
    g.edit('After')
    g.undo()
    expect(g.writes.at(-1)).toEqual({ value: 'Before', intent: 'set' })
    expect(shopifyDraftState(data.values[key])).toBe('unknown')
  })
  it('a replay that changes neither value nor state writes nothing', () => {
    const data = row(cell('Same', { sourceOwnerId: source, follows: false }, true)), g = grid(data)
    g.edit('Other'); g.undo()
    const writes = g.writes.length
    // The cell is already own with 'Same': replaying the same undo step again (as a stale redo stack would) is a no-op.
    expect(g.def.valueSetter as (p: unknown) => boolean).toBeTypeOf('function')
    expect((g.def.valueSetter as (p: unknown) => boolean)({ data, newValue: g.history['redoStack'][0][0].before, oldValue: 'Same' })).toBe(false)
    expect(g.writes).toHaveLength(writes)
  })
})

describe('the private history value never leaves the history', () => {
  it('cells, display, copy and sort read raw values; the envelope is only in the history', () => {
    const data = row(cell('Shared', { sourceOwnerId: source, follows: true }, false)), g = grid(data)
    g.edit('Own'); g.undo(); g.redo(); g.undo()
    const stored = data.values[key]
    expect(typeof stored.value).toBe('string')
    expect(isShopifyHistoryValue(stored.value)).toBe(false)
    expect(JSON.stringify(data)).not.toContain('shopify-draft')
    // Display and copy use the column's formatter; sort uses the raw cell value.
    expect((g.def.valueFormatter as (p: unknown) => string)({ value: stored.value })).toBe('Shared')
    for (const write of g.writes) expect(isHistoryOnly(write.value)).toBe(false)
    const step = g.history['redoStack'][0][0]
    expect(isShopifyHistoryValue(step.before) && isShopifyHistoryValue(step.after)).toBe(true)
  })
  it('the write request built from the replayed row carries the raw value and its exact intent', async () => {
    const data = row(cell('Shared', { sourceOwnerId: source, follows: true }, false)), g = grid(data)
    g.edit('Own'); g.undo()
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, cells: { [key]: { ok: true, shopifyWrite: { ...data.values[key].shopifyWrite, token: 'token-2' } } } })))
    vi.stubGlobal('fetch', fetcher)
    await commitChannelRow({ rowId: data.rowId, row: data, cells: [{ colId: key, value: g.writes.at(-1)!.value, intent: g.writes.at(-1)!.intent as 'reset' }] }, { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'store-a' })
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.cells).toEqual([expect.objectContaining({ colId: key, value: null, intent: 'reset', ownerId: 'gid://shopify/Product/10', token: 'token-1' })])
    expect(JSON.stringify(body)).not.toContain('shopify-draft')
    vi.unstubAllGlobals()
  })
  it('a column that does not read history values is skipped on replay instead of receiving the envelope', () => {
    const set = vi.fn()
    const g = grid(row(cell('A', null, true)))
    g.history.begin(); g.edit('B'); g.history.end()
    const envelope = g.history['undoStack'][0][0].before
    expect(isShopifyHistoryValue(envelope)).toBe(true)
    writeHistoryValues({ getRowNode: () => ({ setDataValue: set }), getColumn: () => ({ getColDef: () => ({}) }) }, [{ rowId: 'r', colId: 'brand', value: envelope }, { rowId: 'r', colId: 'brand', value: 'plain' }], 'undo')
    expect(set.mock.calls).toEqual([['brand', 'plain', 'undo']])
  })
})
