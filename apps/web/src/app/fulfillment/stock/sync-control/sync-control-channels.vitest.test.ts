/**
 * 2026-10-01 — Etsy joins the stock cascade, so Sync Control offers it where it offers Amazon, eBay and Shopify: the
 * channel filter and the new-policy editor. Etsy sells in one market (GLOBAL), so an Etsy policy is for All markets
 * only. The list must follow the API's (sync-control-core.ts), less WooCommerce, which has no stock writer.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { QUANTITY_CHANNELS, marketFilterOptions, marketLabel, policyMarketFor, policyMarketOptions } from './sync-control-shared'

const DIR = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(DIR, '../../../../../../..')
const read = (rel: string) => readFileSync(join(DIR, rel), 'utf8')

describe('the channels Sync Control offers for quantity control', () => {
  it('are Amazon, eBay, Shopify and Etsy, in that order, with their display names', () => {
    expect(QUANTITY_CHANNELS).toEqual([
      { value: 'AMAZON', label: 'Amazon' }, { value: 'EBAY', label: 'eBay' }, { value: 'SHOPIFY', label: 'Shopify' }, { value: 'ETSY', label: 'Etsy' },
    ])
  })

  it('follow the API: its Sync Control channels, less WooCommerce (no stock writer)', () => {
    const core = readFileSync(join(REPO, 'apps/api/src/services/sync-control-core.ts'), 'utf8')
    const known = core.match(/export const KNOWN_CHANNELS = \[([^\]]*)\] as const/)
    expect(known, 'KNOWN_CHANNELS not found in sync-control-core.ts').toBeTruthy()
    const api = [...known![1].matchAll(/'([A-Z]+)'/g)].map((m) => m[1]).filter((c) => c !== 'WOOCOMMERCE')
    expect(QUANTITY_CHANNELS.map((c) => c.value).sort()).toEqual(api.sort())
  })

  it('the channel filter and the policy editor both use that one list (no list of their own)', () => {
    const src = read('SyncControlClient.tsx')
    expect(src.match(/\[\.\.\.QUANTITY_CHANNELS\]/g)?.length).toBe(2)
    expect(src).not.toMatch(/\{ value: 'SHOPIFY', label: 'Shopify' \}/)
    expect(src).toMatch(/options=\{policyMarketOptions\(polChannel\)\}/)
  })
})

describe('the market of a new channel policy', () => {
  it('Etsy: All markets only — an Etsy policy for one country would never match an Etsy listing', () => {
    expect(policyMarketOptions('ETSY')).toEqual([{ value: '*', label: 'All markets' }])
  })

  it('Amazon, eBay and Shopify keep All markets plus IT, DE, FR and ES, as before', () => {
    for (const channel of ['AMAZON', 'EBAY', 'SHOPIFY']) {
      expect(policyMarketOptions(channel).map((o) => o.value), channel).toEqual(['*', 'IT', 'DE', 'FR', 'ES'])
    }
  })

  it('switching the channel to Etsy moves a chosen country back to All markets; a market the channel offers is kept', () => {
    expect(policyMarketFor('ETSY', 'IT')).toBe('*')
    expect(policyMarketFor('ETSY', '*')).toBe('*')
    expect(policyMarketFor('AMAZON', 'IT')).toBe('IT')
    expect(policyMarketFor('EBAY', 'DE')).toBe('DE')
  })
})

describe('the Market filter offers every market the rows are on', () => {
  it('GLOBAL (Shopify, Etsy) is offered, named plainly, and DEFAULT when rows still use it', () => {
    expect(marketFilterOptions(['GLOBAL', 'IT', 'DEFAULT', 'DE'])).toEqual([
      { value: 'IT', label: 'IT' }, { value: 'DE', label: 'DE' }, { value: 'GLOBAL', label: 'Global (Shopify, Etsy)' }, { value: 'DEFAULT', label: 'DEFAULT' },
    ])
    expect(marketLabel('GLOBAL')).toBe('Global (Shopify, Etsy)')
  })

  it('countries first in the usual order, any other market A–Z, then GLOBAL and DEFAULT; no duplicates', () => {
    expect(marketFilterOptions(['DEFAULT', 'UK', 'ES', 'GLOBAL', 'FR', 'SE', 'IT', 'DE', 'it']).map((o) => o.value))
      .toEqual(['IT', 'DE', 'FR', 'ES', 'SE', 'UK', 'GLOBAL', 'DEFAULT'])
  })

  it('a market still selected stays offered, even before the overview has answered', () => {
    expect(marketFilterOptions([], ['GLOBAL']).map((o) => o.value)).toEqual(['GLOBAL'])
    expect(marketFilterOptions(['IT'], ['GLOBAL']).map((o) => o.value)).toEqual(['IT', 'GLOBAL'])
  })

  it('the page takes the options from the overview\'s markets, not from a list of its own', () => {
    const src = read('SyncControlClient.tsx')
    expect(src).toMatch(/options: marketFilterOptions\(overview\?\.markets \?\? \[\], markets\)/)
    expect(src).not.toMatch(/\['IT', 'DE', 'FR', 'ES', 'DEFAULT'\]/)
  })

  it('the API sends those markets with the overview', () => {
    const route = readFileSync(join(REPO, 'apps/api/src/routes/sync-control.routes.ts'), 'utf8')
    expect(route).toMatch(/markets: rowMarkets\(rows\)/)
  })
})
