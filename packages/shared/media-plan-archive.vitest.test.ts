import { describe, expect, it } from 'vitest'

import { planAmazonArchive } from './media-plan-archive.js'
import type { AmazonMediaLayout, MediaAsset } from './media-plan-channels.js'

const asset = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({ id, url: `https://cdn.test/${id}.jpg`, mediaType: 'IMAGE', width: 2000, height: 2000,
  mimeType: 'image/jpeg', fileSize: 1, languageTag: 'zxx', versionGroupId: null, label: id, ...extra })
const assets = new Map([asset('main'), asset('n1'), asset('chart-it', { languageTag: 'it', versionGroupId: 'chart' }), asset('chart-de', { languageTag: 'de', versionGroupId: 'chart' }),
  asset('ps1'), asset('ps2'), asset('swatch'), asset('small', { width: 400, height: 300 }), asset('soft', { width: 800, height: 800 })].map(a => [a.id, a]))
const layout: AmazonMediaLayout = {
  parent: { productId: 'root', sku: 'Parent', slots: { MAIN: 'main', PT01: 'chart-it' }, cut: [] },
  items: [
    { productId: 'nm', sku: 'NERO-M', slots: { MAIN: 'n1', PT01: 'chart-it', SWCH: 'swatch' }, cut: [] },
    { productId: 'nl', sku: 'NERO-L', slots: { MAIN: 'n1', PT01: 'chart-it', SWCH: 'swatch' }, cut: [] },
    { productId: 'gm', sku: 'GIALLO-M', slots: { MAIN: 'main' }, cut: [] },
    { productId: 'rm', sku: 'ROSSO-M', slots: { MAIN: 'main' }, cut: [] },
  ],
  safety: ['ps1', 'ps2'], checks: [],
}
// Fake ASINs (B0FX…). GIALLO-M is listed without an ASIN; ROSSO-M is not listed on this market at all.
const listings: Record<string, { asin: string | null }> = { root: { asin: 'B0FXPARNT1' }, nm: { asin: 'B0FXNERO01' }, nl: { asin: 'B0FXNERO01' }, gm: { asin: null } }
const plan = (extra: Partial<Parameters<typeof planAmazonArchive>[0]> = {}) =>
  planAmazonArchive({ kind: 'slots', market: 'IT', layout, assets, listingOf: id => listings[id] ?? null, ...extra })

describe('Amazon ZIPs for Seller Central (P4d)', () => {
  it('names every file ASIN.SLOT.jpg; two SKUs on one ASIN with the same photos are one file', () => {
    const slots = plan()
    expect(slots.files.map(f => `${f.name}=${f.assetId}`)).toEqual(['B0FXPARNT1.MAIN.jpg=main', 'B0FXPARNT1.PT01.jpg=chart-it', 'B0FXNERO01.MAIN.jpg=n1',
      'B0FXNERO01.PT01.jpg=chart-it', 'B0FXNERO01.SWCH.jpg=swatch'])
    expect(slots.files.find(f => f.name === 'B0FXNERO01.MAIN.jpg')?.skus).toEqual(['NERO-M', 'NERO-L'])
    expect(slots.issues).toEqual([])
    expect(slots.warnings).toEqual([])
  })
  it('says exactly why a SKU is left out: not listed, no ASIN yet, or a value that is not an ASIN', () => {
    expect(plan().skipped).toEqual(['GIALLO-M: its Amazon IT listing has no ASIN yet — left out.', 'ROSSO-M: not listed on Amazon IT — left out.'])
    expect(plan({ market: 'DE', listingOf: id => id === 'gm' ? { asin: 'GIALLO-M-IT' } : listings[id] ?? null }).skipped)
      .toEqual(['GIALLO-M: its Amazon DE listing holds "GIALLO-M-IT", which is not an ASIN — left out.', 'ROSSO-M: not listed on Amazon DE — left out.'])
  })
  it('safety images go PS01… on every ASIN; a country ZIP holds only the versions in that market\'s language', () => {
    expect(plan({ kind: 'safety' }).files.map(f => f.name)).toEqual(['B0FXPARNT1.PS01.jpg', 'B0FXPARNT1.PS02.jpg', 'B0FXNERO01.PS01.jpg', 'B0FXNERO01.PS02.jpg'])
    const de = plan({ kind: 'country', market: 'DE', language: 'de' })
    expect(de.files.map(f => `${f.name}=${f.assetId}`)).toEqual(['B0FXPARNT1.PT01.jpg=chart-de', 'B0FXNERO01.PT01.jpg=chart-de'])
    // The version the API already sends everywhere (Italian) is not a country photo for Italy.
    expect(plan({ kind: 'country', language: 'it' }).files).toEqual([])
  })
  it('refuses two SKUs on one ASIN that would get different photos', () => {
    const clash = { ...layout, items: [layout.items[0], { ...layout.items[1], slots: { MAIN: 'main' } }] }
    expect(plan({ layout: clash }).issues)
      .toEqual(['B0FXNERO01 MAIN: NERO-M and NERO-L share this ASIN but get different photos. Give them the same photos first.'])
  })
  it('shows the plan\'s checks for what this ZIP holds on this market: errors stop the download, warnings do not', () => {
    const checked: AmazonMediaLayout = { ...layout,
      items: [{ productId: 'nm', sku: 'NERO-M', slots: { MAIN: 'small', PT01: 'soft' }, cut: ['n1', 'swatch'] }, { productId: 'rm', sku: 'ROSSO-M', slots: { PT01: 'n1' }, cut: [] }],
      safety: ['ps1', 'ps2', 'ps1', 'ps2', 'ps1', 'ps2', 'ps1'],
      checks: [
        { severity: 'error', code: 'missing-photo', set: 'safety', message: 'A photo in this set was deleted from the library. Remove it or add it again.' },
        { severity: 'warning', code: 'language-fallback', set: 'common', message: 'chart has no FR version — shows IT.' },
        // Checks the ZIP recomputes per market (ROSSO-M is not listed on IT, so its missing MAIN does not stop the IT ZIP).
        { severity: 'error', code: 'no-main', set: 'sku:rm', message: 'ROSSO-M has no MAIN photo.' },
      ] }
    const slots = plan({ layout: checked })
    expect(slots.issues).toEqual(['small is 400 px — Amazon needs 500 px.'])
    expect(slots.warnings).toEqual(['NERO-M: Amazon shows 9 photos — 2 do not fit: n1, swatch.', 'soft is 800 px — buyers cannot zoom below 1000 px.', 'chart has no FR version — shows IT.'])
    expect(plan({ layout: checked, listingOf: id => id === 'rm' ? { asin: 'B0FXROSSO1' } : listings[id] ?? null }).issues).toContain('ROSSO-M has no MAIN photo.')
    const safety = plan({ kind: 'safety', layout: checked })
    expect(safety.issues).toEqual(['Safety has 7 photos; Amazon allows 6 (PS01–PS06).', 'A photo in Safety was deleted from the library. Remove it on the Media page, or add it again.'])
    expect(safety.warnings).toEqual([])
    expect(safety.files.filter(f => f.asin === 'B0FXPARNT1').map(f => f.slot)).toEqual(['PS01', 'PS02', 'PS03', 'PS04', 'PS05', 'PS06'])
  })
  it('refuses more than 1,000 files in one ZIP', () => {
    const many = { ...layout, parent: null, items: Array.from({ length: 101 }, (_, i) => ({ productId: `p${i}`, sku: `SKU-${i}`, slots: { MAIN: 'main', PT01: 'n1', PT02: 'chart-it', PT03: 'ps1', PT04: 'ps2', PT05: 'swatch', PT06: 'soft', PT07: 'chart-de', PT08: 'main', SWCH: 'swatch' }, cut: [] })) }
    const big = plan({ layout: many, listingOf: id => ({ asin: `B0FX${id.padStart(6, '0').toUpperCase()}` }) })
    expect(big.files).toHaveLength(1010)
    expect(big.issues).toContain('This ZIP would hold 1,010 files; Nexus makes at most 1,000 in one ZIP.')
    expect(plan({ layout: { ...many, items: many.items.slice(0, 100) }, listingOf: id => ({ asin: `B0FX${id.padStart(6, '0').toUpperCase()}` }) }).issues).toEqual([])
  })
})
