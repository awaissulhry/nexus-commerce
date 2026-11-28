import { describe, expect, it } from 'vitest'
import { demoStyle, STYLE_ID } from '../demo/fixtures'
import { abilitiesOf, bandPrimaryOf, grainsOf, mayEditDraftParts, mayEditFacts, startRevisionHeld, STYLE_TABS, tabsFor } from '../model'
import { productSheetOf } from '../sheet/sheet-model'
import { isSheet, sheetHref } from './product-model'

/**
 * owb-pd4 — the product page's rules, written per step (not run: Owner rule, checks at the end).
 * Step 4.2: the tabs per person (design § 5q "Who", prodTabs), the band's ONE main button by right (prodBand), the designer's draft
 * rule (S4 settle 6) and the Product sheet (never a price).
 */

// The rights of the factory-domain templates that touch a product (auth/roles/templates.ts; owb-b6: Sales reads certificates).
const OWNER = ['product.styles.view', 'product.styles.manage', 'product.bom.view', 'product.bom.manage', 'product.bom.release', 'product.routing.view', 'product.routing.manage', 'costing.view', 'compliance.certificates.view', 'product.drafts.edit', 'money.cost', 'money.price', 'money.margin']
const DESIGNER = ['product.styles.view', 'product.bom.view', 'product.drafts.edit', 'files.read', 'files.upload', 'threads.read']
const SALES = ['product.styles.view', 'costing.view', 'compliance.certificates.view', 'pricelists.view', 'money.price', 'money.margin']
const PRODUCTION_MANAGER = ['product.styles.view', 'product.styles.manage', 'product.bom.view', 'product.bom.manage', 'product.bom.release', 'product.routing.view', 'product.routing.manage', 'compliance.certificates.view']
const tabsOf = (permissions: string[]) => tabsFor(abilitiesOf(permissions), grainsOf(permissions))

describe('step 4.2 — the tabs per person', () => {
  it('the Owner: all nine, the tab `routing` among them (named "Route")', () => {
    expect(tabsOf(OWNER)).toEqual([...STYLE_TABS])
  })
  it('the designer: Overview, Sizes, Materials, Tech pack, Compliance, Patterns, Versions — no Route, no Cost', () => {
    expect(tabsOf(DESIGNER)).toEqual(['overview', 'sizes', 'bom', 'techpack', 'compliance', 'patterns', 'versions'])
  })
  it('sales: Overview, Sizes, Compliance (it opens since owb-b6), Versions — no Cost although it reads the costing (no cost grain)', () => {
    expect(tabsOf(SALES)).toEqual(['overview', 'sizes', 'compliance', 'versions'])
    expect(abilitiesOf(SALES).complianceView).toBe(true)
  })
  it('the production manager: everything but Cost (no money)', () => {
    expect(tabsOf(PRODUCTION_MANAGER)).toEqual(['overview', 'sizes', 'bom', 'routing', 'techpack', 'compliance', 'patterns', 'versions'])
  })
  it('no product read: only the Overview frame (its page says no access)', () => {
    expect(tabsOf([])).toEqual(['overview'])
  })
})

describe('step 4.2 — the band\'s ONE main button by right', () => {
  const style = demoStyle()
  const draft = style.revisions.find((revision) => revision.status === 'DRAFT')!
  const released = style.revisions.find((revision) => revision.status === 'RELEASED')!
  const noDraft = { ...style, revisions: style.revisions.filter((revision) => revision.status !== 'DRAFT') }
  it('Release revision n for product.bom.release on the draft; nothing for the designer there', () => {
    expect(bandPrimaryOf(style, draft, abilitiesOf(OWNER))).toBe('release')
    expect(bandPrimaryOf(style, draft, abilitiesOf(DESIGNER))).toBeNull()
    expect(bandPrimaryOf(style, draft, abilitiesOf(SALES))).toBeNull()
  })
  it('Start revision n without a draft: product.styles.manage, product.bom.manage or the designer\'s product.drafts.edit; never sales', () => {
    expect(bandPrimaryOf(noDraft, released, abilitiesOf(OWNER))).toBe('start')
    expect(bandPrimaryOf(noDraft, released, abilitiesOf(DESIGNER))).toBe('start')
    expect(bandPrimaryOf(noDraft, released, abilitiesOf(SALES))).toBeNull()
    expect(startRevisionHeld(noDraft, abilitiesOf(DESIGNER))).toBeNull()
  })
  it('viewing the released revision while a draft is open: no main button (the draft is where the work happens)', () => {
    expect(bandPrimaryOf(style, released, abilitiesOf(OWNER))).toBeNull()
  })
  it('Take it back on an archived product, for product.styles.manage only', () => {
    const archived = { ...style, status: 'ARCHIVED' as const }
    expect(bandPrimaryOf(archived, released, abilitiesOf(OWNER))).toBe('takeBack')
    expect(bandPrimaryOf(archived, released, abilitiesOf(DESIGNER))).toBeNull()
  })
})

describe('step 4.2 — the designer edits only while the revision is a DRAFT (S4 settle 6)', () => {
  const style = demoStyle()
  const noDraft = { ...style, revisions: style.revisions.filter((revision) => revision.status !== 'DRAFT') }
  it('style facts: while the newest revision is a draft; never on an archived product', () => {
    expect(mayEditFacts(style, abilitiesOf(DESIGNER))).toBe(true)
    expect(mayEditFacts(noDraft, abilitiesOf(DESIGNER))).toBe(false)
    expect(mayEditFacts({ ...style, status: 'ARCHIVED' }, abilitiesOf(OWNER))).toBe(false)
    expect(mayEditFacts(noDraft, abilitiesOf(OWNER))).toBe(true)
    expect(mayEditFacts(style, abilitiesOf(SALES))).toBe(false)
  })
  it('the draft parts (size table, how to measure, protectors): the BOM right or the designer\'s', () => {
    expect(mayEditDraftParts(abilitiesOf(DESIGNER))).toBe(true)
    expect(mayEditDraftParts(abilitiesOf(SALES))).toBe(false)
    expect(abilitiesOf(DESIGNER).draftsEdit).toBe(true)
    expect(abilitiesOf(DESIGNER).release).toBe(false)
    expect(abilitiesOf(DESIGNER).manage).toBe(false)
  })
})

describe('step 4.2 — the Product sheet', () => {
  it('opens the product page for paper in the Office\'s print view, in a new tab', () => {
    expect(sheetHref('/w/DEMO', STYLE_ID, 'r3')).toBe(`/w/DEMO/products/styles/${STYLE_ID}?sheet=1&print=1&rev=r3`)
    expect(isSheet(new URLSearchParams('sheet=1&print=1'))).toBe(true)
    expect(isSheet(new URLSearchParams('tab=overview'))).toBe(false)
  })
  it('the sheet model has no price, cost or margin key, whoever opens it', () => {
    const sheet = productSheetOf({ style: demoStyle(), revisionId: null, gallery: null, spec: null, protectors: null, locale: 'en' })
    const keys: string[] = []
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object')
        for (const [key, inner] of Object.entries(value)) {
          keys.push(key)
          walk(inner)
        }
    }
    walk(sheet)
    expect(keys.filter((key) => /price|cost|margin|amount|total/i.test(key))).toEqual([])
    expect(JSON.stringify(sheet)).not.toMatch(/€|EUR/)
    expect(sheet.code).toBe('DEMO-JKT-01')
    expect(sheet.facts.map((fact) => fact.label)).toEqual(expect.arrayContaining(['sheet.type', 'sheet.family', 'sheet.sizes', 'sheet.protection']))
  })
})
