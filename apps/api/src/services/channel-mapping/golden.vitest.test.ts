/**
 * CHMAP M5 — the golden test (study §8.6): anonymised copies of the Owner's real files (`__fixtures__/golden`, built
 * by `scripts/chmap-golden-build.mts`, scanned for private data) go through the real readers and the export, and must
 * give the pinned result: every filled cell accounted for, the file written back cell for cell, and the same mapping
 * decisions. A change to a reader, a rule, the export or a schema fixture that moves any number fails here, with the
 * cells that moved.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { amazonGolden, ebayGolden, loadSpec, shopifyGolden, type GoldenMarket } from './__tests__/golden-pipeline.js'
import { anonymiseShopifyCsv, scanShopifyCsv } from '../../../scripts/lib/chmap-anonymise-lib.mts'
import { shopifySampleCsv, SHOPIFY_SAMPLE_ROWS } from '../pim/catalog-transfer-test/shopify-csv-fixtures.js'

const DIR = new URL('./__fixtures__/golden/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')) as {
  fixtures: { id: string; kind: 'amazon' | 'ebay' | 'shopify'; why: string; file: string; filename?: string; market?: GoldenMarket; specs: string[]; expected: Awaited<ReturnType<typeof amazonGolden>> }[]
}
const specsOf = (files: string[]) => new Map(files.map(f => {
  const spec = loadSpec(readFileSync(new URL(`specs/${f}`, DIR)))
  return [spec.category, spec] as const
}))

describe('CHMAP golden files (anonymised copies of the Owner’s files)', () => {
  it('has the fixtures the study names', () => {
    expect(manifest.fixtures.map(f => f.id)).toEqual(['amazon-it-coat-pants', 'amazon-de-coat-pants', 'amazon-fr-coat-pants', 'amazon-es-coat-pants', 'amazon-de-suit', 'amazon-de-market-parent', 'amazon-it-flat-file-2024', 'ebay-it-177104', 'ebay-it-legacy', 'shopify-product-csv'])
  })

  for (const fixture of manifest.fixtures) {
    it(`${fixture.id} — ${fixture.why}`, async () => {
      const bytes = readFileSync(new URL(fixture.file, DIR))
      const got = fixture.kind === 'amazon' ? await amazonGolden(bytes, specsOf(fixture.specs), fixture.market!) : fixture.kind === 'shopify' ? shopifyGolden(bytes) : await ebayGolden(bytes, fixture.filename!, specsOf(fixture.specs))
      // check 1 — every filled cell accounted for, exactly once.
      expect(got.read).toMatchObject({ unaccounted: 0, duplicated: 0, dangling: 0 })
      // check 2 — the round trip: the differences are exactly the pinned ones (for most files: none).
      expect(got.differences).toEqual(fixture.expected.differences)
      // check 4 (Amazon templates) — the cells that follow Shared come back the same, and reading the file again keeps
      // every one of them following Shared.
      if (got.roundTripInherited) {
        expect(got.roundTripInherited).toEqual(got.roundTrip)
        expect(got.inheritedCells).toBeGreaterThan(0)
        expect(got.reimport).toEqual({ kept: got.inheritedCells, pinned: 0 })
      }
      // check 3 — the version pin: the form, the decisions and every count.
      expect(got).toEqual(fixture.expected)
    }, 60_000)
  }

  // NCF N8 — the public repository keeps no store data: the committed Shopify copy passes the anonymiser's scan, and the
  // scan itself is shown to work (a store link and a planted original value are both caught).
  it('shopify-product-csv — the committed copy carries no store link or private word (scan with positive control)', () => {
    const text = readFileSync(new URL('shopify-product-csv.csv', DIR), 'utf8')
    expect(scanShopifyCsv(text)).toEqual([])
    expect(scanShopifyCsv(`${text}https://cdn.shopify.com/s/files/1/0000/0001/files/a.jpg,planted-original\n`, ['planted-original'])).toEqual(['an original value remains', 'a store link remains', 'a store host remains'])
    // Shopify's own export shape survives: comma, LF, no BOM, the classic headers.
    expect(text.charCodeAt(0)).not.toBe(0xfeff)
    expect(text.includes('\r')).toBe(false)
    expect(text.split('\n')[0].startsWith('Handle,Title,Body (HTML),Vendor,')).toBe(true)
  })

  it('the Shopify anonymiser replaces the store’s values, keeps Shopify’s vocabulary, and its scan catches a planted original', () => {
    const anon = anonymiseShopifyCsv(shopifySampleCsv())
    expect(anon).toMatchObject({ leaks: [], control: true, rows: SHOPIFY_SAMPLE_ROWS.length })
    const text = anon.bytes.toString('utf8')
    for (const original of ['acme-jacket', 'Acme jacket', 'ACME-JACKET-S', '4006381333931', 'cdn.example.test', 'Jackets', 'Waterproof', '249.00', 'Acme jacket | ACME']) expect(text).not.toContain(original)
    for (const kept of ['Size', 'Default Title', 'active', 'draft', 'deny', 'Apparel & Accessories > Clothing', 'Handle,Title,Body (HTML)']) expect(text).toContain(kept)
    // Consistent: the same original gets the same fake everywhere (the jacket's three rows keep one handle).
    const handles = text.split('\n').slice(1).map(line => line.split(',')[0]).filter(Boolean)
    expect(new Set(handles).size).toBe(3)
  })
})
