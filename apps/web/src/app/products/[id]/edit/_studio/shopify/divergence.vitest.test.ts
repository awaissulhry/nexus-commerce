/**
 * Lane01 — the Shopify pop-up shows a preserved follower pin AND the value Shopify receives on publish (the API's
 * `divergence.publishesAs`), on the compact sheet wire, after a re-read, and when both values are equal. Reading the
 * cell and closing it writes nothing. Rendered with the real DS Banner/KeyValue in node SSR.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { decodeSheetCells, encodeSheetCells } from '@nexus/shared/sheet-cell-wire'
import { informationRegistry } from '@nexus/shared/shopify-information'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { ShopifyDivergenceBanner, shopifyPanelSave, shopifyRawValue } from './ShopifyDraftCell'

const schema = { revision: 'synthetic-1', currency: 'EUR', metaobjectDefinitions: [], types: [], locales: [{ locale: 'en', primary: true }],
  definitions: [
    { id: 'def-label', namespace: 'custom', key: 'label', name: 'Shared label', ownerType: 'PRODUCT', type: 'single_line_text_field', validations: [], description: null, access: { admin: null, storefront: null } },
    { id: 'def-flag', namespace: 'custom', key: 'flag', name: 'Waterproof', ownerType: 'PRODUCT', type: 'boolean', validations: [], description: null, access: { admin: null, storefront: null } },
  ] } as unknown as ShopifyStoreSchema
const fields = informationRegistry(schema)
const label = fields.find(field => field.id === 'metafield:PRODUCT:custom.label')!
const flag = fields.find(field => field.id === 'metafield:PRODUCT:custom.flag')!
const note = 'The saved draft conflicts with the sharing rule. Shopify will use the shared source. Edit or reset this field to resolve it.'
const write = (owner: number) => ({ ownerId: `gid://shopify/Product/${owner}`, fieldId: label.id, token: `token-${owner}`, baseline: 'Original' })
const cell = (value: unknown, extra: Record<string, unknown> = {}) => ({ value, source: 'channelExplicit', inheritedFrom: null, inherited: false, layer: 'channel', pinned: true,
  follows: false, editable: true, linkGroupId: null, mapped: null, writeField: label.id, writeTarget: 'channelListing', writeVerb: 'channel', affectsAllChannels: false, writable: true, ...extra })
/** The read as the API sends it: a follower that keeps a pin, a plain own cell, and a following cell. */
const sheet = () => ({ scope: { kind: 'channel', channel: 'SHOPIFY', marketplace: 'GLOBAL' }, meta: { tookMs: 1, schemaMissing: [], schemaAge: [] },
  columns: [{ key: label.id, label: 'Shared label' }],
  rows: [
    { id: 'family', sku: 'SYN-1', values: { [label.id]: cell('Saved separate label', { shopifyWrite: write(10), follows: true, divergence: { publishesAs: 'Shared source', note } }) } },
    { id: 'blue', sku: 'SYN-2', values: { [label.id]: cell('Own blue', { shopifyWrite: write(20) }) } },
    { id: 'red', sku: 'SYN-3', values: { [label.id]: cell('Shared source', { shopifyWrite: write(30), pinned: false, inherited: true, follows: true }) } },
  ] })
type Cell = ReturnType<typeof cell> & { divergence?: { publishesAs: unknown; note: string } }
const banner = (type: string, value: Cell) => renderToStaticMarkup(createElement(ShopifyDivergenceBanner, { type, kept: shopifyRawValue(value.value), divergence: value.divergence }))
const read = () => decodeSheetCells(JSON.parse(JSON.stringify(encodeSheetCells(sheet())))) as ReturnType<typeof sheet>

describe('the Shopify pop-up names a preserved pin and the value Shopify receives', () => {
  it('shows the kept draft value AND the shared publish value with the conflict note', () => {
    const html = banner(label.type, sheet().rows[0].values[label.id] as Cell)
    expect(html).toContain('Publishing uses the shared value')
    expect(html).toContain('<dt>Saved draft, kept here</dt><dd>Saved separate label</dd>')
    expect(html).toContain('<dt>Shopify receives</dt><dd>Shared source</dd>')
    expect(html).toContain(note)
    expect(html).toContain('role="status"')
  })
  it('keeps the warning when the kept value equals the shared one: the rule conflicts, not the text', () => {
    const html = banner(flag.type, cell('false', { follows: true, divergence: { publishesAs: 'false', note } }) as Cell)
    expect(html).toContain('<dt>Saved draft, kept here</dt><dd>false</dd>')
    expect(html).toContain('<dt>Shopify receives</dt><dd>false</dd>')
    expect(html).toContain(note)
  })
  it('shows nothing for a cell without a divergence (own or following)', () => {
    for (const row of sheet().rows.slice(1)) expect(banner(label.type, row.values[label.id] as Cell)).toBe('')
  })
  it('survives the compact column-base wire exactly, and does not leak to other cells of the column', () => {
    const decoded = read()
    expect(decoded).toEqual(JSON.parse(JSON.stringify(sheet())))
    expect(banner(label.type, decoded.rows[0].values[label.id] as Cell)).toBe(banner(label.type, sheet().rows[0].values[label.id] as Cell))
    for (const row of decoded.rows.slice(1)) expect((row.values[label.id] as Cell).divergence).toBeUndefined()
  })
  it('shows the same facts after a re-read: they come from the stored read, not from the pop-up', () => {
    const first = read(), again = read()
    expect(banner(label.type, again.rows[0].values[label.id] as Cell)).toBe(banner(label.type, first.rows[0].values[label.id] as Cell))
  })
})

/* S1 item 5 (f) — a cell following Shared on a product Shopify already holds: Shopify keeps its own value. */
describe('Shopify keeps its own value', () => {
  const keeps = 'Shopify keeps Own value. Shared changes are not sent to a product already on Shopify; enter the value here to send it.'
  const html = () => renderToStaticMarkup(createElement(ShopifyDivergenceBanner, { type: label.type, kept: 'Shared value', follows: true, divergence: { publishesAs: 'Own value', note: keeps } }))
  it('names the Shared value shown, the value Shopify has, and why it stays', () => {
    expect(html()).toContain('Shopify keeps its own value')
    expect(html()).toContain('<dt>Shared value, shown here</dt><dd>Shared value</dd>')
    expect(html()).toContain('<dt>Shopify has</dt><dd>Own value</dd>')
    expect(html()).toContain(keeps)
    expect(html()).not.toContain('Publishing uses the shared value')
  })
})

describe('reading or cancelling the pop-up writes nothing', () => {
  const base = { schema, locked: false, translated: false, contentWrite: false, hasSession: true }
  it.each([['different', 'Saved separate label', label], ['equal', 'false', flag]] as const)('a %s-value conflict closed unchanged is not committed', (_kind, kept, field) => {
    expect(shopifyPanelSave({ ...base, field, value: kept, baseline: kept, current: kept })).toEqual({ kind: 'close' })
  })
  it('a locked cell closes without a commit even if the value changed', () => {
    expect(shopifyPanelSave({ ...base, field: label, value: 'Changed', baseline: 'Saved separate label', current: 'Saved separate label', locked: true })).toEqual({ kind: 'close' })
  })
  it('only an operator change is committed, and only while the cell and session are unchanged', () => {
    expect(shopifyPanelSave({ ...base, field: label, value: 'Own label', baseline: 'Saved separate label', current: 'Saved separate label' })).toEqual({ kind: 'commit', value: 'Own label' })
    expect(shopifyPanelSave({ ...base, field: label, value: 'Own label', baseline: 'Saved separate label', current: 'Another tab' })).toMatchObject({ kind: 'refuse' })
    expect(shopifyPanelSave({ ...base, field: label, value: 'Own label', baseline: 'Saved separate label', current: undefined })).toMatchObject({ kind: 'refuse' })
    expect(shopifyPanelSave({ ...base, field: label, value: 'Own label', baseline: 'Saved separate label', current: 'Saved separate label', hasSession: false })).toMatchObject({ kind: 'refuse' })
  })
})
