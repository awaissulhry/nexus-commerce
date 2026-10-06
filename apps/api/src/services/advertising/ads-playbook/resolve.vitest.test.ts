/**
 * ADS PLAYBOOK PB-2 — the playbook resolver (resolve.ts), pure. Values are made up.
 *
 *   order       product (variation) → its parent → the root's primary category, deepest first → market → template;
 *               the template comes from the first row naming one; each section WHOLE from the first row that sets it
 *   product     the product's own fields from its row, else its parent's; enrolled only from those rows
 *   skipSlots   optional slots leave the doc with every reference to them; a slot that is not optional stays
 *   categories  several categories and no primary: no category row applies, and a warning says so
 *   problems    no template / a missing section / an inconsistent override: no doc, and why
 *   rows        an override section that does not read is ignored, named; an orphan is set apart; a scope must match
 */
import { describe, expect, it } from 'vitest'
import { templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import type { Catalog } from '../ads-strategy/resolve.js'
import { indexPlaybook, isEnrolled, resolveCategory, resolveMarket, resolveProduct, type PlaybookRow, type TemplateRow } from './resolve.js'

const at = new Date('2026-10-01T00:00:00Z')
const template = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  id: 'tpl-1', channel: 'AMAZON', adProduct: 'SP', name: 'Test funnel', version: 3, status: 'ACTIVE', doc: templateDoc(), capturedFrom: null,
  updatedAt: at, updatedBy: 'user:test', ...over,
})
const row = (level: string, scopeId: string, over: Partial<PlaybookRow> = {}): PlaybookRow => ({
  id: `pb-${level}-${scopeId}`, channel: 'AMAZON', market: 'IT', level, scopeId, label: `Test ${level} ${scopeId}`, version: 1,
  templateId: null, overrides: null, enrolled: null, state: null, nameToken: null, portfolioName: null, dailyBudgetCents: null,
  baseBidCents: null, terms: null, phaseRecipes: null, compiledVersion: null, compiledTemplateVersion: null, updatedAt: at, updatedBy: 'user:test',
  ...over,
})
const catalog = (primary: string[] = ['leaf'], all: string[] = ['leaf']): Catalog => ({
  products: new Map([
    ['parent', { id: 'parent', sku: 'TEST-PARENT', parentId: null }],
    ['v1', { id: 'v1', sku: 'TEST-V1', parentId: 'parent' }],
  ]),
  memberships: new Map([['parent', { primary, all }]]),
  ancestry: new Map([['leaf', ['leaf', 'top']], ['top', ['top']], ['other', ['other']]]),
})
const v1 = { id: 'v1', sku: 'TEST-V1', parentId: 'parent' }
const doc = templateDoc()
const budget = { weights: { auto: 50, 'broad-category': 50, 'exact-category': 0, 'exact-brand': 0, pat: 0 }, minPerSlotCents: 200 }

describe('the order: product → parent → category (deepest first) → market → template', () => {
  const rows = [
    row('MARKET', '*', { templateId: 'tpl-1' }),
    row('CATEGORY', 'top', { overrides: { isolation: { exactIntoResearch: false, brandPhraseIntoCategoryAndCompetitor: false, phraseIntoBroadAndAuto: false } } }),
    row('CATEGORY', 'leaf', { overrides: { budget } }),
    row('PRODUCT', 'parent', { enrolled: true, nameToken: 'TESTTOKEN', dailyBudgetCents: 5000, overrides: { placements: {} } }),
    row('PRODUCT', 'v1', { baseBidCents: 31 }),
  ]
  const { index } = indexPlaybook('IT', rows, [template()])
  const out = resolveProduct(index, v1, catalog())

  it('the template from the first row naming one; each section from the most specific row that sets it, whole', () => {
    expect(out.template).toMatchObject({ value: { id: 'tpl-1', name: 'Test funnel', version: 3 }, source: { level: 'market' } })
    expect(out.sections.placements).toEqual({ value: {}, source: { level: 'product', id: 'pb-PRODUCT-parent', label: 'Test PRODUCT parent', version: 1, via: 'parent' } })
    expect(out.sections.budget).toMatchObject({ value: budget, source: { level: 'category', id: 'pb-CATEGORY-leaf' } })
    expect(out.sections.isolation).toMatchObject({ value: { exactIntoResearch: false }, source: { level: 'category', id: 'pb-CATEGORY-top' } })
    expect(out.sections.structure).toMatchObject({ source: { level: 'template', id: 'tpl-1', label: 'Test funnel', version: 3 } })
    expect(out.problems).toEqual([])
    expect(out.doc!.budget).toEqual(budget)
    expect(out.doc!.placements).toEqual({})
  })

  it("the product's own fields: its row first, else its parent's; enrolled comes only from those rows", () => {
    expect(out.product!.baseBidCents).toMatchObject({ value: 31, source: { level: 'product', id: 'pb-PRODUCT-v1' } })
    expect(out.product!.nameToken).toMatchObject({ value: 'TESTTOKEN', source: { via: 'parent' } })
    expect(out.product!.enrolled).toMatchObject({ value: true, source: { via: 'parent' } })
    expect(isEnrolled(out)).toBe(true)
    // A category or market playbook never enrolls a product.
    const { index: bare } = indexPlaybook('IT', rows.filter((r) => r.level !== 'PRODUCT'), [template()])
    expect(isEnrolled(resolveProduct(bare, v1, catalog()))).toBe(false)
  })

  it('a category and the market resolve through their own chains; neither has product fields', () => {
    const category = resolveCategory(index, 'leaf', catalog())
    expect(category.sections.budget.source).toMatchObject({ level: 'category', id: 'pb-CATEGORY-leaf' })
    expect(category.product).toBeNull()
    const market = resolveMarket(index)
    expect(market.sections.budget.source).toMatchObject({ level: 'template' })
    expect(market.doc).not.toBeNull()
  })
})

describe('skipSlots, categories and problems', () => {
  it('an optional slot left out takes every reference with it; a slot that is not optional stays', () => {
    const rows = [row('MARKET', '*', { templateId: 'tpl-1' }), row('PRODUCT', 'v1', { overrides: { skipSlots: ['exact-brand', 'exact-category'] } })]
    const out = resolveProduct(indexPlaybook('IT', rows, [template()]).index, v1, catalog())
    expect(out.doc!.structure.slots.map((s) => s.key)).toEqual(['auto', 'broad-category', 'exact-category', 'pat'])
    expect(out.doc!.budget.weights).not.toHaveProperty('exact-brand')
    expect(out.doc!.bids.ladder).not.toHaveProperty('exact-brand')
    // The router's brand slot hands its terms to the category slot.
    expect(out.doc!.harvest.edges.find((e) => typeof e.to !== 'string')!.to).toMatchObject({ brand: 'exact-category' })
    expect(out.doc!.phases.PROFIT!.slots).not.toHaveProperty('exact-brand')
    expect(out.warnings).toContain('skipSlots names "exact-category", which is not an optional slot; it stays')
  })

  it('several categories and no primary: no category row applies, and a warning says so', () => {
    const rows = [row('MARKET', '*', { templateId: 'tpl-1' }), row('CATEGORY', 'leaf', { overrides: { budget } })]
    const out = resolveProduct(indexPlaybook('IT', rows, [template()]).index, v1, catalog([], ['leaf', 'other']))
    expect(out.sections.budget.source).toMatchObject({ level: 'template' })
    expect(out.warnings.join('\n')).toMatch(/no category playbook applies/)
  })

  it('no template: nothing applies; a template without a section: incomplete; an inconsistent override: no doc, and why', () => {
    expect(resolveProduct(indexPlaybook('IT', [], [template()]).index, v1, catalog()).problems).toEqual(['No playbook applies here: no row names a template'])
    const partial = template({ doc: { ...doc, phases: undefined } })
    const incomplete = resolveMarket(indexPlaybook('IT', [row('MARKET', '*', { templateId: 'tpl-1' })], [partial]).index)
    expect(incomplete.doc).toBeNull()
    expect(incomplete.problems).toEqual(['Incomplete: no phases section (no row sets it and the template "Test funnel" has none)'])
    const ghost = resolveMarket(indexPlaybook('IT', [row('MARKET', '*', { templateId: 'tpl-1', overrides: { bids: { ladder: { ghost: 1 }, launch: 'floor' } } })], [template()]).index)
    expect(ghost.doc).toBeNull()
    expect(ghost.problems).toEqual(expect.arrayContaining(['Inconsistent: bids.ladder: no slot "ghost"']))
  })
})

describe('reading the rows', () => {
  it('an override section that does not read is ignored and named; skipSlots belongs on a product row', () => {
    const rows = [row('MARKET', '*', { templateId: 'tpl-1', overrides: { budget: { weights: 'lots' }, skipSlots: ['auto'], colours: {} } })]
    const { index } = indexPlaybook('IT', rows, [template()])
    expect(index.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/its budget section does not read/),
      'Test MARKET * (market, v1): skipSlots belongs on a product row; ignored',
      'Test MARKET * (market, v1): overrides names an unknown section "colours"; ignored',
    ]))
    expect(resolveMarket(index).sections.budget.source).toMatchObject({ level: 'template' })
  })

  it('an orphan is set apart; a row whose scope does not fit its level, or of another market, is ignored', () => {
    const rows = [row('PRODUCT', 'gone'), row('CATEGORY', '*'), row('MARKET', '*', { market: 'DE' }), row('PRODUCT', 'v1', { terms: { brand: 'not a list' } })]
    const { index, orphans } = indexPlaybook('IT', rows, [], { categories: new Set(), products: new Set(['v1']) })
    expect(orphans).toEqual([{ playbookId: 'pb-PRODUCT-gone', level: 'PRODUCT', scopeId: 'gone', label: 'Test PRODUCT gone', why: 'the product no longer exists or was deleted' }])
    expect(index.rows.map((r) => r.id)).toEqual(['pb-PRODUCT-v1'])
    expect(index.warnings.join('\n')).toMatch(/category row must name its category/)
    // Terms that do not read are ignored, with a warning, never guessed.
    const out = resolveProduct(index, v1, catalog())
    expect(out.product!.terms.value).toBeNull()
    expect(out.warnings.join('\n')).toMatch(/its terms do not read/)
  })
})
