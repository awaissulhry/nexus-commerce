/**
 * Browser check 2026-10-05 (F1) — the Item ID / Listing ID / Product ID / ASIN control was mounted only in
 * `channel/ChannelSheet.tsx`, which nothing renders: the studio's sheet tab is `ProductSheetTab`, and it renders
 * `<ProductSheet scope="channel">` directly. Every id cell found no control, so it showed Copy and Open only, and Enter,
 * a double-click and Delete did nothing.
 *
 * This renders the REAL studio path (`ProductSheetTab` → `ProductSheet` → its channel adapter) with only the data
 * adapters, the grid surface and the plan host stubbed: the stub surface draws the REAL `ItemIdCell` and `AsinCell`, as
 * the grid does. The main row's cell must carry its door ("Change Item ID"), and the control it reaches must open on that
 * row. The Shared scope has no channel id cell and gets no control. Node has no DOM: the effect that binds Enter and the
 * double-click to the door does not run here — `itemIdKeyIntent` / `asinKeyIntent` (ListingIdCell.vitest.test.ts) are its
 * rules, and the door below is what they reach.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChannelSheetRow } from './channel/types'

const state = vi.hoisted(() => ({
  scope: 'EBAY' as string,
  market: 'IT',
  controls: [] as unknown[],
}))

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'p' }) }))
vi.mock('@/lib/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1' } }), usePermission: () => true }))
vi.mock('../shopify/useLiveShopifySchema', () => ({ useLiveShopifySchema: () => ({ schema: null, error: null, refresh: async () => undefined }) }))
vi.mock('../contracts', () => ({
  useStudioProduct: () => ({ id: 'p' }),
  useStudioScope: () => ({
    accountId: 'acc-1', listingId: null, locale: 'it', market: state.market, scope: state.scope,
    coordinate: state.scope === 'master' ? null : { channel: state.scope, marketplace: state.market },
    registerShopifyLocales: () => undefined, setTab: () => undefined,
  }),
}))
vi.mock('./channel/useChannelSheetAdapter', () => ({ useChannelSheetAdapter: (p: { channel: string; marketplace: string }) => ({ channel: p.channel, market: p.marketplace }) }))
vi.mock('./master/useMasterSheetAdapter', () => ({ useMasterSheetAdapter: (p: { market: string }) => ({ channel: 'MASTER', market: p.market }) }))
vi.mock('../variants/channel/ThemeChangePlanHost', () => ({ ThemeChangePlanHost: () => null }))
/** The grid surface, stubbed: it draws the real id cells for a family's main row and one variation, as the grid does. */
vi.mock('./ProductSheetSurface', async () => {
  const { createElement: h } = await import('react')
  const { AsinCell, ItemIdCell } = await import('./channel/ListingIdCell')
  const { useChannelIdControl } = await import('./channel/channelIdControl')
  const listing = { id: 'L-IT', version: 7, externalListingId: '100000000001', listingStatus: 'ACTIVE', isPublished: true }
  const main = { rowId: 'primary:p', id: 'p', sku: 'DEMO-JACKET', isParent: true, parentId: null, listing,
    values: { listing_item_id: { value: '100000000001', editable: true, writable: true, writeBlockedReason: null }, listing_asin: { value: 'B0DEMO0001' } } }
  const variation = { ...main, rowId: 'primary:v', id: 'v', sku: 'DEMO-JACKET-S', isParent: false, parentId: 'p',
    values: { listing_item_id: { value: '100000000001', editable: false, writable: false, writeBlockedReason: 'Set on the main row: one eBay Item ID carries the whole variation family.' } } }
  const cellProps = (data: unknown, channel: string, market: string) => ({
    data, market, channel, node: { rowIndex: 0 }, api: { setFocusedCell: () => undefined }, column: { getColId: () => 'listing_item_id' }, eGridCell: null,
  })
  return {
    ProductSheetSurface: (p: { channel: string; market: string }) => {
      state.controls.push(useChannelIdControl())
      const Cell = (p.channel === 'AMAZON' ? AsinCell : ItemIdCell) as never
      return h('div', null,
        h('div', { 'data-row': 'main' }, h(Cell, cellProps(main, p.channel, p.market) as never)),
        h('div', { 'data-row': 'variation' }, h(Cell, cellProps(variation, p.channel, p.market) as never)))
    },
  }
})

import { ProductSheetTab } from './ProductSheetTab'
import { ASIN_CONTROL_COPY, CHANNEL_ITEM_ID_COPY } from './channel/ListingIdCell'
import { channelIdTarget } from './channel/channelIdControl'

const studio = (scope: string, market: string) => {
  state.scope = scope
  state.market = market
  return renderToStaticMarkup(createElement(ProductSheetTab))
}
const part = (html: string, row: 'main' | 'variation') => new RegExp(`data-row="${row}">([\\s\\S]*?)</div>`).exec(html)?.[1] ?? ''

describe('the studio sheet tab mounts the channel id control around what it renders', () => {
  beforeEach(() => { state.controls = [] })

  it.each([['EBAY', 'IT'], ['ETSY', 'GLOBAL'], ['SHOPIFY', 'GLOBAL']] as const)('%s: the main row\'s id cell is the control\'s door; a variation row is not', (channel, market) => {
    const html = studio(channel, market)
    const words = CHANNEL_ITEM_ID_COPY[channel]
    expect(part(html, 'main')).toContain(`aria-label="${words.change}"`)
    expect(part(html, 'main')).toContain(`aria-label="${words.copy('100000000001')}"`)
    expect(part(html, 'variation')).not.toContain(words.change)
  })

  it('Amazon: every row with a listing is the ASIN control\'s door', () => {
    const html = studio('AMAZON', 'IT')
    expect(part(html, 'main')).toContain(`aria-label="${ASIN_CONTROL_COPY.change}"`)
    expect(part(html, 'variation')).toContain(`aria-label="${ASIN_CONTROL_COPY.change}"`)
  })

  it('the control the cell reaches is this coordinate\'s, may edit, and opens on the main row (Enter and the double-click call `open`)', () => {
    studio('EBAY', 'IT')
    const control = state.controls[0] as { channel: string; marketplace: string; canEdit: boolean; open: unknown } | null
    expect(control).toMatchObject({ channel: 'EBAY', marketplace: 'IT', canEdit: true })
    expect(typeof control?.open).toBe('function')
    const main = { id: 'p', sku: 'DEMO-JACKET', parentId: null, listing: { id: 'L-IT', version: 7, externalListingId: '100000000001' } } as unknown as ChannelSheetRow
    expect(channelIdTarget(main, control!.channel)).toMatchObject({ listingId: 'L-IT', currentId: '100000000001', version: 7 })
  })

  it('the Shared scope gets no control: its sheet has no channel id cell', () => {
    const html = studio('master', 'IT')
    expect(state.controls).toEqual([null])
    expect(html).not.toContain(CHANNEL_ITEM_ID_COPY.EBAY.change)
  })

  it('the control is mounted by the channel adapter, never by `ChannelSheet.tsx` (a wrapper nothing renders)', () => {
    const sheet = readFileSync(join(__dirname, 'ProductSheet.tsx'), 'utf8')
    expect(sheet).toMatch(/function ListingAdapter[\s\S]*?<ChannelIdControlProvider channel=\{props\.channel\} marketplace=\{props\.marketplace\}>\s*<ProductSheetSurface \{\.\.\.useChannelSheetAdapter\(props\)\} \/>[\s\S]*?<\/ChannelIdControlProvider>/)
    expect(/function SharedProductAdapter[\s\S]*?\n}/.exec(sheet)?.[0]).not.toContain('ChannelIdControlProvider')
    expect(readFileSync(join(__dirname, 'channel', 'ChannelSheet.tsx'), 'utf8')).not.toContain('ChannelIdControlProvider')
  })
})
