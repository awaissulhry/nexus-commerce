/**
 * Step 2.6c-1 (A-27, R-23) — every reader takes a variant's values from the ONE store,
 * `categoryAttributes.variations`, and uses the legacy `variantAttributes` only for an axis the store lacks.
 *
 * 24 live readers read the legacy bag first or only (the 2026-09-23 trace): every image screen, the Amazon
 * image feed, FNSKU labels, the list wizard, the Amazon and Shopify wizard submissions, the channel pricing and
 * inventory panels, the organize screen, the Studio row identity and the F6 Matrix page. On production one child
 * disagrees (AIR-MESH-JACKET-MEN-XXL-BLACK: store `XXL`, legacy `XS`); each of those showed or sent `XS`.
 *
 * The gate has two halves:
 * - the helpers, by value;
 * - a SOURCE SCAN: every production line that reads `variantAttributes` directly must be a named exception with a
 *   reason. A reverted reader is a new unnamed line, so it is red; a stale exception is red too.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { variationBag } from './shared-variation-values.js'
import { axisValuesFromCells } from './studio-sheet.service.js'

describe('variationBag — the store first, legacy keys only for an axis the store lacks', () => {
  it('the store wins per canonical axis (AIR-MESH-JACKET-MEN-XXL-BLACK, production)', () => {
    expect(variationBag({ categoryAttributes: { variations: { Size: 'XXL', Color: 'Nero' } }, variantAttributes: { Taglia: 'XS', 'Body Type': 'Uomo' } }))
      .toEqual({ Size: 'XXL', Color: 'Nero', 'Body Type': 'Uomo' })
  })
  it('the legacy bag still answers for a child the store does not cover', () => {
    expect(variationBag({ categoryAttributes: {}, variantAttributes: { Taglia: 'XS' } })).toEqual({ Taglia: 'XS' })
  })
  it('nothing anywhere is an empty bag', () => {
    expect(variationBag({ categoryAttributes: null, variantAttributes: null })).toEqual({})
  })
  it('the Studio row identity takes its base from the store (it read the legacy bag only)', () => {
    const child = { categoryAttributes: { variations: { Size: 'XXL' } }, variantAttributes: { Size: 'XS' } }
    expect(axisValuesFromCells(variationBag(child), ['Taglia'], {})).toEqual({ Size: 'XXL' })
  })
})

// ── the source scan ────────────────────────────────────────────────────────────────────────────────────────
const API_SRC = join(__dirname, '../..')
const DIRECT_READ = /\.variantAttributes\b|\[['"]variantAttributes['"]\]/
/** [file (relative to apps/api/src), a substring of the line, why it may read the legacy bag]. */
const EXCEPTIONS: Array<[string, string, string]> = [
  ['services/pim/shared-variation-values.ts', 'object(product.variantAttributes)', 'the helpers themselves'],
  ['services/pim/stored-variation-projection.ts', 'legacy = bag(product.variantAttributes)', 'storedVariationValues: the store first'],
  ['services/pim/attribute-resolver.ts', 'objectBag(product.variantAttributes)', 'the resolver: raw alias keys, and the store before the legacy bag'],
  ['services/pim/content-resolver.ts', '...(owner.variantAttributes as Bag ?? {})', 'merged; the store wins on a shared key'],
  ['services/pim/family-projection.service.ts', 'readAxisValues(product.variantAttributes)', 'cell > store > legacy'],
  ['services/pim/family-projection.service.ts', 'readAxisValues(member.variantAttributes)', 'the union of stored key spellings'],
  ['services/pim/family-projection.service.ts', "BLANK_AXIS_KEYS = new Set(['variantAttributes'])", 'a junk-key filter, not a read'],
  ['services/pim/resolve-channel-field.ts', 'product.variantAttributes', 'the mapping source path `variantAttributes.X`, answered by the resolver first'],
  ['services/pim/mapping/mapping-sources.service.ts', "walk('variantAttributes', row.variantAttributes)", 'lists `variantAttributes.*` source paths for the mapping editor'],
  ['services/ebay-variation-push.service.ts', 'const variantAttrs = (product.variantAttributes', 'buildFlatRow: merged, the store wins'],
  ['services/ebay-family-axes.service.ts', 'pushKeys(c.variantAttributes)', 'axis candidates, after the store'],
  ['services/ebay-family-axes.service.ts', 'variantAttributes: c.variantAttributes,', 'both stores passed to buildFlatRow'],
  ['services/images/ebay-image-axis.pure.ts', 'collectInto(bySyn, variant.variantAttributes)', 'the union of both stores for axis candidates'],
  ['routes/images/images-workspace.routes.ts', 'variantAttributes: c.variantAttributes as Record<string, unknown> | null,', 'both stores passed to deriveWorkspaceAxes (a union)'],
  ['routes/ebay-cockpit.routes.ts', ': (c.variantAttributes as Record<string, string> | null)) ?? {}', 'the legacy fallback after the store'],
  ['services/images/amazon-media-workspace.service.ts', 'r.product.sku, r.product.variantAttributes]', 'a revision fingerprint, not a value decision'],
  ['routes/pim.routes.ts', 'variationBag({ categoryAttributes: _store, variantAttributes: c.variantAttributes })', 'into the helper'],
  ['services/shopify/content-workspace.service.ts', 'variationBag({ categoryAttributes: p.categoryAttributes, variantAttributes:', 'into the helper'],
  ['services/pim/family-variations-core.ts', 'legacy: bag(v.variantAttributes)', 'VTR step 1: the backfill REPORT lists every store, the legacy one included, and writes nothing'],
  ['services/pim/family-variations.service.ts', 'legacy = bag(child.variantAttributes)', 'VTR step 1: the one writer drops the legacy copy of the axis it writes'],
  ['services/pim/family-variations-backfill.ts', 'legacy = bagOf(child.variantAttributes)', 'VTR step 1b: the backfill sends a value only while a legacy copy of its axis still exists'],
  // The AI prompt builder reads through variationBag; these pass both stores to it.
  ['routes/listing-wizard.routes.ts', 'variantAttributes: product.variantAttributes,', 'AI prompt pass-through (categoryAttributes passed too)'],
  ['routes/products-ai.routes.ts', 'variantAttributes: product.variantAttributes,', 'AI prompt pass-through'],
  ['routes/product-translations.routes.ts', 'variantAttributes: product.variantAttributes,', 'AI prompt pass-through'],
  ['routes/listing-content.routes.ts', 'variantAttributes: product.variantAttributes,', 'AI prompt pass-through'],
  ['jobs/listing-quality-snapshot.job.ts', 'variantAttributes: product.variantAttributes,', 'AI prompt pass-through'],
  ['routes/marketing-automation.routes.ts', 'variantAttributes: (product.variantAttributes ?? undefined)', 'AI prompt pass-through'],
  // Writers — since Step 2.6c-2 they pass the legacy bag INTO the one writer's plan (to drop its keys), never write it.
  ['routes/catalog.routes.ts', 'const variantAttributes = request.body.variantAttributes;', 'the request body, not the column'],
  ['routes/catalog-organize.routes.ts', 'variantAttributes: product.variantAttributes ?? null, variations: store ?? null', 'the organize undo snapshot of both stores (R-25)'],
  ['routes/catalog-organize.routes.ts', 'legacy: snapshot.variantAttributes ?? null', 'reads the undo snapshot object, not the column (R-25)'],
  ['routes/catalog-organize.routes.ts', 'legacyDrop: Object.keys((product.variantAttributes ?? {})', 'organize publish empties the legacy bag'],
  ['services/pim/auto-detect.service.ts', 'legacyDrop: Object.keys((before?.variantAttributes ?? {})', 'auto-detect empties the legacy bag'],
  ['services/bulk-action.service.ts', 'variationValuesPlan({ categoryAttributes: (item as ProductLike).categoryAttributes, variantAttributes: (item as ProductLike).variantAttributes }', 'into the one writer\'s plan'],
  ['services/bulk-action/attribute-helpers.ts', 'variationBag({ categoryAttributes: product.categoryAttributes, variantAttributes: product.variantAttributes })', 'the before-value, through the helper'],
  // Step 2.6d (R-26) — the data run: it reads the legacy bag to compare it with the store, records it, restores it.
  ['services/pim/variation-store-fill.ts', 'const legacy = object(child.variantAttributes)', 'the fill plan compares the legacy bag with the store'],
  ['scripts/fill-variation-store.ts', 'variantAttributes: c.variantAttributes, ebaySpecifics', 'the fill plan\'s input'],
  ['scripts/fill-variation-store.ts', 'variantAttributes: p.variantAttributes ?? null', 'the --apply record of the before-state'],
  ['scripts/fill-variation-store.ts', 'data: { variantAttributes: entry.variantAttributes === null', '--revert restores the recorded before-state'],
  // No-touch zone (flat files).
  ['services/amazon/flat-file.service.ts', 'data.variantAttributes = axes', 'flat-file create — no-touch'],
  ['services/ebay-flat-file-create.logic.ts', 'data.variantAttributes = attrs', 'flat-file create — no-touch'],
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path)
    return /\.ts$/.test(name) && !/\.test\.ts$|test-store\.ts$/.test(name) ? [path] : []
  })
}

describe('the source scan — no reader takes the legacy bag first', () => {
  const reads = sourceFiles(API_SRC).flatMap((path) => readFileSync(path, 'utf8').split('\n').map((line, i) => ({
    file: relative(API_SRC, path), line: i + 1, text: line,
  }))).filter(({ text }) => DIRECT_READ.test(text) && !/^\s*(\/\/|\*|\/\*)/.test(text))

  it('positive control: the scan sees the helpers themselves', () => {
    expect(reads.some((r) => r.file === 'services/pim/shared-variation-values.ts')).toBe(true)
  })
  it('every direct read of `variantAttributes` is a named exception', () => {
    const unnamed = reads.filter((r) => !EXCEPTIONS.some(([file, snippet]) => r.file === file && r.text.includes(snippet)))
    expect(unnamed.map((r) => `${r.file}:${r.line}: ${r.text.trim()}`)).toEqual([])
  })
  it('no exception is stale (each still names a real line)', () => {
    const stale = EXCEPTIONS.filter(([file, snippet]) => !reads.some((r) => r.file === file && r.text.includes(snippet)))
    expect(stale).toEqual([])
  })
  it('the F6 Matrix page reads the store before the legacy bag (web)', () => {
    const web = readFileSync(join(API_SRC, '../../web/src/app/products/[id]/matrix/MatrixWorkspace.tsx'), 'utf8')
    const getAttr = web.slice(web.indexOf('function getAttr('), web.indexOf('function readNumber('))
    expect(getAttr.indexOf('child.variations')).toBeGreaterThan(-1)
    expect(getAttr.indexOf('child.variations')).toBeLessThan(getAttr.indexOf('child.variantAttributes'))
    const axes = web.slice(web.indexOf('const axes: string[] = useMemo('))
    expect(axes.indexOf('(c.variations')).toBeLessThan(axes.indexOf('(c.variantAttributes'))
  })
})
