/**
 * VT.1b — the Variations rule read model, the ONE blast-radius simulation, and the draft the commit hands to review.
 *
 * The pure arms run with no database. The two DB-backed arms read the real catalogue (the blast radius is a question
 * about families, and no fixture I write can tell me how many families a category has) and carry a POSITIVE CONTROL:
 * the category must have families at all, otherwise `follow: 0` proves nothing. An unreachable database is reported,
 * never counted as agreement.
 */

import { afterAll, describe, expect, it } from 'vitest'
import prisma from '../../db.js'
import { draftVariationRule, getVariationRuleView, simulateVariationRule } from './variation-rule-view.service.js'
import { getVariationRule, type MarketplaceSchemaMapping } from './schema-mapping.service.js'
import { VARIATION_RULE_KEY, type StoredVariationRule } from './variation-rule-store.js'

const RULE: StoredVariationRule = {
  theme: 'COLOR/SIZE',
  axes: [
    { axisKey: 'color', target: 'color', order: 0, included: true },
    { axisKey: 'size', target: 'size', order: 1, included: true },
  ],
  collisions: { resolver: 'exclude', foldInto: null, foldSeparator: ' / ' },
  split: { mode: 'one', axisKey: null },
  label: 'Accessory default',
}
const mapping = (): MarketplaceSchemaMapping => ({
  version: 12, fields: { item_name: { source: 'name' } },
  byProductType: { AUTO_ACCESSORY: { item_weight: { source: 'weightValue' } } },
  expressions: {}, lastSyncedAt: null, schemaSnapshotVersion: null,
})

afterAll(async () => { await prisma.$disconnect().catch(() => {}) })

describe('draftVariationRule — what the commit hands to the review path', () => {
  it('validates first and REFUSES by name, changing nothing', () => {
    const before = mapping()
    const bad = draftVariationRule(before, 'AUTO_ACCESSORY', { theme: 42 } as never, 'user-1')
    expect(bad.errors[0]).toContain('mapping.variationsByProductType.AUTO_ACCESSORY')
    expect(bad.mapping).toBe(before) // the SAME object — nothing drafted
  })

  it('stamps provenance and writes the canonical home, touching no field rule', () => {
    const { mapping: next, errors } = draftVariationRule(mapping(), 'AUTO_ACCESSORY', RULE, 'user-1')
    expect(errors).toEqual([])
    const stored = next.variationsByProductType!.AUTO_ACCESSORY
    expect(stored).toMatchObject({ ...RULE, updatedBy: 'user-1' })
    expect(typeof stored.updatedAt).toBe('string')
    expect(next.fields).toEqual(mapping().fields)
    expect(next.byProductType).toEqual(mapping().byProductType)
    expect(getVariationRule(next, 'AUTO_ACCESSORY')).toMatchObject({ scope: 'category', storedAt: 'variationsByProductType.AUTO_ACCESSORY' })
  })

  it('a null rule clears it, and clears VX M2\'s in-bucket copy in the same move', () => {
    const withBoth = mapping() as unknown as Record<string, any>
    withBoth.variationsByProductType = { AUTO_ACCESSORY: RULE }
    withBoth.byProductType.AUTO_ACCESSORY[VARIATION_RULE_KEY] = RULE
    const { mapping: cleared, errors } = draftVariationRule(withBoth as MarketplaceSchemaMapping, 'AUTO_ACCESSORY', null, 'user-1')
    expect(errors).toEqual([])
    expect(getVariationRule(cleared, 'AUTO_ACCESSORY')).toBeNull()
    expect(Object.keys(cleared.byProductType!.AUTO_ACCESSORY)).toEqual(['item_weight'])
  })

  it('a channel-wide rule has no category', () => {
    const { mapping: next } = draftVariationRule(mapping(), null, RULE, null)
    expect(next.variations).toMatchObject({ label: RULE.label, updatedBy: null })
    expect(next.variationsByProductType).toBeUndefined()
  })
})

describe('the ONE blast-radius simulation (live catalogue)', () => {
  it('POSITIVE CONTROL: the rehearsal category has families to count', async () => {
    const families = await prisma.product.count({
      where: { parentId: null, deletedAt: null, productType: 'AUTO_ACCESSORY', children: { some: { deletedAt: null } } },
    }).catch(() => -1)
    if (families < 0) { expect.soft('no database — this suite proves nothing in this run').toBeNull(); return }
    expect(families).toBeGreaterThan(0)
  })

  it('refuses a category-wide rule when a listed family cannot supply its required axes', async () => {
    await expect(simulateVariationRule({ channel: 'AMAZON', market: 'IT', categoryId: 'OUTERWEAR', rule: RULE })).rejects.toThrow(/Cannot evaluate .*bind every included axis/)
  })

  it('a null rule never collides — there is no drop to collide over', async () => {
    const none = await simulateVariationRule({ channel: 'AMAZON', market: 'IT', categoryId: 'OUTERWEAR', rule: null }).catch(() => null)
    if (!none) { expect.soft('no database').toBeNull(); return }
    expect(none.wouldCollide).toBe(0)
    expect(none.follow).toBeGreaterThan(0)
  })
})

describe('the read model (live catalogue)', () => {
  it('answers `derived` with the category’s most common axis set, and every count from the server', async () => {
    const view = await getVariationRuleView({ channel: 'AMAZON', market: 'IT', categoryId: 'AUTO_ACCESSORY' }).catch(() => null)
    if (!view) { expect.soft('no database').toBeNull(); return }
    expect(view.source).toBe('derived')
    expect(view.ruleLabel).toBeNull()
    expect(view.derivation).not.toBeNull()
    expect(view.derivation!.families).toBeGreaterThan(0)
    expect(view.derivation!.familiesTotal).toBeGreaterThanOrEqual(view.derivation!.families)
    expect(view.counts.follow + view.counts.override).toBe(view.counts.total)
    expect(view.expectedToken).toMatch(/^[0-9a-f]{16,}$/)
    expect(view.vocabulary.sectionTitle).toBe('Variation theme')
    expect(view.axisNamesSentence).toContain('Amazon')
    // Amazon serves its own enum; every other channel serves none
    expect(view.theme!.options.length).toBeGreaterThan(0)
    for (const option of view.theme!.options) expect(typeof option.deprecated).toBe('boolean')
  })

  it('the channel-wide read has no category and still answers', async () => {
    const view = await getVariationRuleView({ channel: 'EBAY', market: 'IT', categoryId: null }).catch(() => null)
    if (!view) { expect.soft('no database').toBeNull(); return }
    expect(view.categoryId).toBeNull()
    expect(view.categoryLabel).toBe('Every eBay category')
    expect(view.theme).toBeNull() // not Amazon
    expect(view.split.available).toBe(false)
    expect(view.split.reason).toContain('listing aliases')
    expect(view.counts.total).toBeGreaterThan(0)
  })
})
