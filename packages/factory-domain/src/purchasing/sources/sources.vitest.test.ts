import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { PURCHASING_SOURCES_MANAGE } from './permissions'
import {
  approvedSupplierIds,
  buyFromSource,
  duplicateOf,
  factorOf,
  isApproved,
  priceIn,
  primaryOf,
  rankedSources,
  sourceFor,
  sourceProblems,
  sourceRules,
  unitsBoughtIn,
  type SourceFacts,
  type SourceFields,
} from './sources'

/* Approved sources (SCM-005), pure. Every id, code and price is made up. */

// Leather bought by the hide of 52.5 ft², counted in ft², cut in dm².
const LEATHER = { baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'DM2', consumptionFactor: '9.290304' } as const
const PIECES = { baseUom: 'PCS', purchaseUom: 'PCS', purchaseFactor: '1', consumptionUom: 'PCS', consumptionFactor: '1' } as const

const A = 'company-a'
const B = 'company-b'
const ITEM = 'leather'
const BLACK = 'black'
const RED = 'red'

const source = (id: string, over: Partial<SourceFacts> = {}): SourceFacts => ({
  id,
  companyId: A,
  partyId: 'tannery-1',
  itemId: ITEM,
  itemColourId: null,
  preference: 'PRIMARY',
  status: 'ACTIVE',
  purchaseUom: 'FT2',
  unitPrice: '4.20',
  currency: 'EUR',
  minOrderQty: null,
  orderMultiple: null,
  leadTimeDays: null,
  supplierArticleCode: null,
  supplierColourCode: null,
  ...over,
})

const fields = (over: Partial<SourceFields> = {}): SourceFields => ({
  purchaseUom: 'FT2',
  unitPrice: '4.20',
  currency: 'EUR',
  minOrderQty: '100',
  orderMultiple: '50',
  leadTimeDays: 21,
  supplierArticleCode: 'ART-1',
  supplierColourCode: null,
  description: null,
  note: null,
  ...over,
})

describe('what a source may say', () => {
  it('takes a unit the material converts, a price of 0 or more, a minimum and steps above 0, a lead time of 0 to 366 days', () => {
    expect(sourceProblems(fields(), { units: LEATHER })).toEqual([])
    expect(sourceProblems(fields({ purchaseUom: 'M2' }), { units: LEATHER })).toEqual([]) // a fixed ratio of the base unit's dimension
    expect(sourceProblems(fields({ purchaseUom: 'HIDE', unitPrice: '0', minOrderQty: null, orderMultiple: null, leadTimeDays: 0 }), { units: LEATHER })).toEqual([])
    expect(sourceProblems(fields({ purchaseUom: 'KG', unitPrice: '-1', currency: 'euro', minOrderQty: '0', orderMultiple: '1.23456', leadTimeDays: 367 }), { units: LEATHER }).map((issue) => issue.path)).toEqual([
      'body/purchaseUom',
      'body/unitPrice',
      'body/currency',
      'body/minOrderQty',
      'body/orderMultiple',
      'body/leadTimeDays',
    ])
    expect(sourceProblems(fields({ purchaseUom: 'ROLL' }), { units: PIECES })[0]!.message).toBe("The material converts PCS, PAIR: the supplier's unit must be one of them.")
    expect(sourceProblems(fields({ supplierArticleCode: 'x'.repeat(61), note: 'n'.repeat(1001) }), { units: LEATHER }).map((issue) => issue.path)).toEqual(['body/supplierArticleCode', 'body/note'])
  })

  it("stores the material's own factor for the supplier's unit", () => {
    expect(factorOf('HIDE', LEATHER)).toBe('52.50000000')
    expect(factorOf('M2', LEATHER)).toBe('10.76391042')
    expect(factorOf('FT2', LEATHER)).toBe('1.00000000')
    expect(factorOf('KG', LEATHER)).toBeNull()
  })
})

describe('one source per supplier and scope, one PRIMARY per scope (the module holds both)', () => {
  const others = [source('s1'), source('s2', { partyId: 'tannery-2', preference: 'BACKUP' }), source('s3', { itemColourId: BLACK, partyId: 'tannery-2' }), source('s4', { status: 'ARCHIVED', partyId: 'tannery-3' })]

  it('finds a duplicate: the same supplier, company, material and colour, still ACTIVE', () => {
    expect(duplicateOf({ companyId: A, partyId: 'tannery-1', itemId: ITEM, itemColourId: null }, others)?.id).toBe('s1')
    expect(duplicateOf({ id: 's1', companyId: A, partyId: 'tannery-1', itemId: ITEM, itemColourId: null }, others)).toBeNull() // itself
    expect(duplicateOf({ companyId: A, partyId: 'tannery-1', itemId: ITEM, itemColourId: BLACK }, others)).toBeNull() // another colour
    expect(duplicateOf({ companyId: null, partyId: 'tannery-1', itemId: ITEM, itemColourId: null }, others)).toBeNull() // every company is another scope
    expect(duplicateOf({ companyId: A, partyId: 'tannery-3', itemId: ITEM, itemColourId: null }, others)).toBeNull() // archived: approved again is no duplicate
  })

  it('finds the PRIMARY of the same scope', () => {
    expect(primaryOf({ companyId: A, itemId: ITEM, itemColourId: null }, others)?.id).toBe('s1')
    expect(primaryOf({ id: 's1', companyId: A, itemId: ITEM, itemColourId: null }, others)).toBeNull()
    expect(primaryOf({ companyId: A, itemId: ITEM, itemColourId: BLACK }, others)?.id).toBe('s3')
    expect(primaryOf({ companyId: B, itemId: ITEM, itemColourId: null }, others)).toBeNull()
  })
})

describe('which source a need takes', () => {
  const sources = [
    source('every-company', { companyId: null, partyId: 'tannery-9' }),
    source('a-any-colour', { partyId: 'tannery-1' }),
    source('a-black-backup', { partyId: 'tannery-2', itemColourId: BLACK, preference: 'BACKUP' }),
    source('a-black', { partyId: 'tannery-3', itemColourId: BLACK }),
    source('b-only', { companyId: B, partyId: 'tannery-4' }),
    source('archived', { partyId: 'tannery-5', itemColourId: BLACK, status: 'ARCHIVED' }),
    source('other-item', { itemId: 'lining' }),
  ]

  it('ranks PRIMARY first, then a colour’s own, then a company’s own; archived, other companies and materials never', () => {
    expect(rankedSources(sources, { companyId: A, itemId: ITEM, itemColourId: BLACK }).map((entry) => entry.id)).toEqual(['a-black', 'a-any-colour', 'every-company', 'a-black-backup'])
    expect(rankedSources(sources, { companyId: A, itemId: ITEM, itemColourId: RED }).map((entry) => entry.id)).toEqual(['a-any-colour', 'every-company'])
    expect(rankedSources(sources, { companyId: B, itemId: ITEM, itemColourId: null }).map((entry) => entry.id)).toEqual(['b-only', 'every-company'])
  })

  it("suggests the best source, or the chosen supplier's own", () => {
    expect(sourceFor(sources, { companyId: A, itemId: ITEM, itemColourId: BLACK })?.id).toBe('a-black')
    expect(sourceFor(sources, { companyId: A, itemId: ITEM, itemColourId: BLACK }, 'tannery-2')?.id).toBe('a-black-backup')
    expect(sourceFor(sources, { companyId: A, itemId: ITEM, itemColourId: BLACK }, 'tannery-5')).toBeNull()
    expect(sourceFor(sources, { companyId: A, itemId: 'protector', itemColourId: null })).toBeNull()
  })

  it('approves only the sources’ suppliers once a material has one for the need; any supplier before', () => {
    const black = { companyId: A, itemId: ITEM, itemColourId: BLACK }
    expect(approvedSupplierIds(sources, black)).toEqual(['tannery-3', 'tannery-1', 'tannery-9', 'tannery-2'])
    expect(isApproved(sources, black, 'tannery-2')).toBe(true)
    expect(isApproved(sources, black, 'tannery-5')).toBe(false) // only an archived source
    expect(isApproved(sources, { companyId: A, itemId: 'protector', itemColourId: null }, 'anyone')).toBe(true)
  })
})

describe('its terms', () => {
  it("uses the source's minimum and steps, and its lead time else the supplier's", () => {
    expect(sourceRules({ minOrderQty: '100', orderMultiple: '50', leadTimeDays: 21 }, 14)).toEqual({ leadTimeDays: 21, minOrderQuantity: '100', orderMultiple: '50' })
    expect(sourceRules({ minOrderQty: null, orderMultiple: null, leadTimeDays: null }, 14)).toEqual({ leadTimeDays: 14, minOrderQuantity: null, orderMultiple: null })
    expect(sourceRules({ minOrderQty: null, orderMultiple: null, leadTimeDays: null }, null)).toEqual({ leadTimeDays: null, minOrderQuantity: null, orderMultiple: null })
  })

  it("buys in the source's unit: 186.48 ft² short from a tannery selling ft² (at least 100, in steps of 50) is 200 ft²; by the hide 4 hides", () => {
    const byArea = buyFromSource('186.48', LEATHER, { purchaseUom: 'FT2', minOrderQty: '100', orderMultiple: '50', leadTimeDays: 21 }, null)!
    expect(byArea).toMatchObject({ quantity: '200.0000', uom: 'FT2', baseQuantity: '200.0000', steps: [{ rule: 'MULTIPLE', quantity: '200.0000' }] })
    const small = buyFromSource('12.3', LEATHER, { purchaseUom: 'FT2', minOrderQty: '100', orderMultiple: '50', leadTimeDays: 21 }, null)!
    expect(small.steps.map((step) => step.rule)).toEqual(['MINIMUM'])
    expect(small.quantity).toBe('100.0000')
    const byHide = buyFromSource('186.48', LEATHER, { purchaseUom: 'HIDE', minOrderQty: null, orderMultiple: null, leadTimeDays: null }, null)!
    expect(byHide).toMatchObject({ quantity: '4.0000', uom: 'HIDE', baseQuantity: '210.0000', steps: [{ rule: 'WHOLE_UNITS', quantity: '4.0000' }] })
    const inSquareMetres = buyFromSource('107.6391', LEATHER, { purchaseUom: 'M2', minOrderQty: null, orderMultiple: null, leadTimeDays: null }, null)!
    expect(inSquareMetres).toMatchObject({ quantity: '10.0000', uom: 'M2' })
    expect(buyFromSource('10', LEATHER, { purchaseUom: 'KG', minOrderQty: null, orderMultiple: null, leadTimeDays: null }, null)).toBeNull()
    expect(unitsBoughtIn(LEATHER, 'M2')).toMatchObject({ purchaseUom: 'M2', baseUom: 'FT2' })
  })

  it("moves the source's price to the line's unit through the base unit, only in the order's currency", () => {
    expect(priceIn({ unitPrice: '4.20', currency: 'EUR', purchaseUom: 'FT2' }, 'FT2', LEATHER, 'EUR')).toBe('4.200000')
    expect(priceIn({ unitPrice: '4.20', currency: 'EUR', purchaseUom: 'FT2' }, 'HIDE', LEATHER, 'EUR')).toBe('220.500000')
    expect(priceIn({ unitPrice: '220.5', currency: 'EUR', purchaseUom: 'HIDE' }, 'FT2', LEATHER, 'EUR')).toBe('4.200000')
    expect(priceIn({ unitPrice: '4.20', currency: 'USD', purchaseUom: 'FT2' }, 'FT2', LEATHER, 'EUR')).toBeNull()
    expect(priceIn({ unitPrice: null, currency: 'EUR', purchaseUom: 'FT2' }, 'FT2', LEATHER, 'EUR')).toBeNull()
  })
})

describe('the catalogue', () => {
  it('declares purchasing.sources.manage once and gives it to the buyer (and the owner), never to a role without purchasing', () => {
    expect(FACTORY_PERMISSIONS.get(PURCHASING_SOURCES_MANAGE)).toMatchObject({ area: 'purchasing', risk: 'write' })
    const holders = ROLE_TEMPLATES.filter((role) => role.permissions.includes(PURCHASING_SOURCES_MANAGE)).map((role) => role.key)
    expect(holders).toEqual(['owner', 'buyer'])
  })

  it('declares the source and request events without a money field on a live screen', () => {
    for (const type of ['supplier_item.created', 'supplier_item.updated', 'supplier_item.archived', 'purchase_requests.converted']) {
      const definition = EVENT_CATALOGUE.get(type, 1)
      expect(definition.context).toBe('purchasing')
      expect(definition.live?.permission).toBe('purchasing.view')
    }
  })
})
