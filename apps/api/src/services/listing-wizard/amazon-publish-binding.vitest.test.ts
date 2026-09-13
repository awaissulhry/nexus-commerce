/**
 * VT.1b P0 (found by VT.4) — the variation attribute binding on the LIVE publish path.
 *
 * Two defects in one line. The lookup key: `CategorySchema.marketplace` stores the market CODE (measured on this
 * catalogue: AMAZON rows are `BE 3 · DE 32 · ES 24 · FR 25 · IT 61 · NL 3 · UK 22`, zero SP-API ids) while the publish
 * payload's `marketplaceId` holds the SP-API ID — so the schema never resolved on the publish path, the binding never
 * ran, and the legacy `${axis}_name` fallback shipped. VT.4 measured the result: a live plan carrying the attribute
 * name `"fit type_name"`, a space inside an SP-API attribute name.
 *
 * The properties below are the MEASURED ones, not invented: `apps/api/scripts/_vt1-suit.mts` read SUIT·IT on the local
 * database and reported `color` ("Colore"), `fit_type` ("Tipo di forma") and `style` ("Stile") PRESENT, and `size`,
 * `size_name`, `color_name` ABSENT. That absence is the arm that matters — it is what makes `VX-TEST-3AX` (PT SUIT,
 * axes Taglia × Colore × Fit Type) refusable rather than publishable with a wrong attribute name.
 */

import { afterAll, describe, expect, it } from 'vitest'
import prisma from '../../db.js'
import { AmazonPublishAdapter } from './amazon-publish.adapter.js'
import { clearAmazonMarketCodeCache, resolveAmazonMarketCode } from '../pim/variation-theme-facts.js'

/** SUIT · IT, as measured. `size` is deliberately absent. */
const SUIT_IT_PROPERTIES: Record<string, unknown> = {
  color: { title: 'Colore' },
  fit_type: { title: 'Tipo di forma' },
  style: { title: 'Stile' },
  variation_theme: { items: { properties: { name: { enum: ['FIT_TYPE/SIZE_NAME/COLOR_NAME'] } } } },
}
/** OUTERWEAR · IT, as measured: both axes of GALE bind. */
const OUTERWEAR_IT_PROPERTIES: Record<string, unknown> = {
  color: { title: 'Colore' },
  size: { title: 'Taglia' },
  style: { title: 'Stile' },
  material: { title: 'Materiale' },
}

const build = (args: Record<string, unknown>) =>
  (new AmazonPublishAdapter() as unknown as {
    buildChildAttributes: (a: Record<string, unknown>) => { attributes: Record<string, unknown>; unbound: Array<{ axis: string; segment: string | null }>; uncheckable: string[] }
  }).buildChildAttributes(args)

const base = {
  parentSku: 'VX-TEST-3AX',
  marketplaceId: 'IT',
  price: null,
  quantity: null,
  variationMapping: undefined,
}

afterAll(async () => { await prisma.$disconnect().catch(() => {}) })

describe('the lookup key — one authority, the Marketplace row', () => {
  it('resolves an SP-API id AND a code to the same market code, with the control in the same run', async () => {
    clearAmazonMarketCodeCache()
    const row = await prisma.marketplace.findFirst({
      where: { channel: 'AMAZON', code: 'IT' }, select: { code: true, marketplaceId: true },
    }).catch(() => null)
    if (!row) { expect.soft('no database — this arm proves nothing in this run').toBeNull(); return }
    // POSITIVE CONTROL: the code resolves to itself, so a non-answer cannot masquerade as a fix.
    expect(await resolveAmazonMarketCode('IT')).toBe('IT')
    if (row.marketplaceId) {
      // the arm the defect lived in: the SP-API id the publish payload actually carries
      expect(row.marketplaceId).not.toBe(row.code)
      expect(await resolveAmazonMarketCode(row.marketplaceId)).toBe('IT')
    }
    // an unknown value is returned unchanged rather than guessed at
    expect(await resolveAmazonMarketCode('NOT-A-MARKETPLACE')).toBe('NOT-A-MARKETPLACE')
  })
})

describe('buildChildAttributes — nothing is invented', () => {
  it('NO attribute name can contain a space, on any arm', () => {
    const arms = [
      { schemaProperties: SUIT_IT_PROPERTIES, variationTheme: 'FIT_TYPE/SIZE_NAME/COLOR_NAME', variationAttributes: { 'Fit Type': 'Regular', Taglia: '52', Colore: 'Nero' } },
      { schemaProperties: OUTERWEAR_IT_PROPERTIES, variationTheme: 'COLOR/SIZE', variationAttributes: { Colore: 'Nero', Taglia: 'XS' } },
      { schemaProperties: null, variationTheme: 'FIT_TYPE/SIZE_NAME/COLOR_NAME', variationAttributes: { 'Fit Type': 'Regular' } },
    ]
    for (const arm of arms) {
      const { attributes } = build({ ...base, ...arm })
      for (const key of Object.keys(attributes)) expect(key, `arm ${arm.variationTheme}`).not.toMatch(/\s/)
      // and the one that used to be produced is gone for good
      expect(Object.keys(attributes)).not.toContain('fit type_name')
    }
  })

  it('OUTERWEAR·IT: both of GALE’s axes bind to the schema’s own property names', () => {
    const { attributes, unbound, uncheckable } = build({
      ...base, schemaProperties: OUTERWEAR_IT_PROPERTIES, variationTheme: 'COLOR/SIZE',
      variationAttributes: { Colore: 'Nero', Taglia: 'XS' },
    })
    expect(unbound).toEqual([])
    expect(uncheckable).toEqual([])
    expect(Object.keys(attributes).sort()).toEqual(['child_parent_sku_relationship', 'color', 'parentage_level', 'size', 'variation_theme'])
    expect(attributes.color).toEqual([{ marketplace_id: 'IT', value: 'Nero' }])
    expect(attributes.size).toEqual([{ marketplace_id: 'IT', value: 'XS' }])
  })

  it('SUIT·IT (VX-TEST-3AX): fit_type and color bind; the axis with NO property is refused, not renamed', () => {
    const { attributes, unbound, uncheckable } = build({
      ...base, schemaProperties: SUIT_IT_PROPERTIES, variationTheme: 'FIT_TYPE/SIZE_NAME/COLOR_NAME',
      variationAttributes: { 'Fit Type': 'Regular', Taglia: '52', Colore: 'Nero' },
    })
    expect(attributes.fit_type).toEqual([{ marketplace_id: 'IT', value: 'Regular' }])
    expect(attributes.color).toEqual([{ marketplace_id: 'IT', value: 'Nero' }])
    // `size` does not exist on SUIT·IT, so the size axis binds to NOTHING and is reported by name
    expect(unbound).toEqual([{ axis: 'Taglia', segment: 'SIZE_NAME' }])
    expect(uncheckable).toEqual([])
    expect(Object.keys(attributes)).not.toContain('size')
    expect(Object.keys(attributes)).not.toContain('size_name')
    expect(Object.keys(attributes)).not.toContain('taglia_name')
  })

  it('NO cached schema refuses every axis instead of inventing one (the case that fires on the live path)', () => {
    const { attributes, unbound, uncheckable } = build({
      ...base, schemaProperties: null, variationTheme: 'FIT_TYPE/SIZE_NAME/COLOR_NAME',
      variationAttributes: { 'Fit Type': 'Regular', Colore: 'Nero' },
    })
    expect(unbound.map((u) => u.axis).sort()).toEqual(['Colore', 'Fit Type', 'SIZE_NAME'])
    expect(uncheckable.sort()).toEqual(['Colore', 'Fit Type'])
    // nothing but the envelope — no axis attribute at all
    expect(Object.keys(attributes).sort()).toEqual(['child_parent_sku_relationship', 'parentage_level', 'variation_theme'])
  })

  it('an explicit target must bind to a real attribute in the selected theme', () => {
    const { attributes, unbound } = build({
      ...base, schemaProperties: SUIT_IT_PROPERTIES, variationTheme: 'FIT_TYPE/SIZE_NAME/COLOR_NAME',
      variationMapping: { Taglia: 'size_name' },
      variationAttributes: { Taglia: '52' },
    })
    expect(attributes.size_name).toBeUndefined()
    expect(unbound).toContainEqual({ axis: 'Taglia', segment: 'size_name' })
  })
})
