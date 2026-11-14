import { describe, expect, it } from 'vitest'
import type { Actor, Permission } from '../core/permissions'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { cell } from '../imports/cells'
import { columnIdOf, columnOf, fieldSeenBy, grainOfColumn } from './access'
import { clauseProblem, meets, parseFilter } from './filters'
import { CUSTOM_VALUE_EXAMPLES, customValuesImporter } from './importer'
import { FIELDS_PERMISSIONS } from './permissions'
import { factsAfter, fieldProblems, optionProblems, orderProblems, picklistProblems, placesOf, nextPlace } from './rules'
import { checkValue, decimalOfMinor, exportCellOf, importInput, minorOfImport, sameStored, storedOf, type OptionFacts } from './values'

/** Custom fields and picklists (B-W2b-421; PLT-111, PLT-115): the pure rules. Made-up codes and words only. */

const office = (permissions: readonly string[]): Actor => ({ audience: 'office', tenantId: 't', grants: [{ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' }] })
const partner = (permissions: readonly string[]): Actor => ({ audience: 'partner', tenantId: 't', partyId: 'p', grants: [{ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: ['p'] }] })
const floor: Actor = { audience: 'floor', tenantId: 't', siteId: 's', grants: [{ permissions: ['floor.work', 'money.wages'] as Permission[], companies: 'all', sites: ['s'], parties: 'all' }] }

const OPTIONS: OptionFacts[] = [
  { code: 'MESH', active: true, labelIt: 'Rete', labelEn: 'Mesh', sortOrder: 10 },
  { code: 'THERMAL', active: true, labelIt: 'Termica', labelEn: 'Thermal', sortOrder: 20 },
  { code: 'QUILTED', active: false, labelIt: 'Trapuntata', labelEn: 'Quilted', sortOrder: 40 },
]

describe('field rules (PLT-111)', () => {
  it('takes a complete new field and says each problem at its field', () => {
    expect(fieldProblems({ code: 'heat_number', type: 'TEXT', labelIt: 'Colata', labelEn: 'Heat number' })).toEqual([])
    const problems = fieldProblems({ code: 'Heat Number', type: 'TEXT', labelIt: ' ', labelEn: 'x'.repeat(81), unit: 'mm', section: 'Bad-Section' })
    expect(problems.map((problem) => problem.path).sort()).toEqual(['code', 'labelEn', 'labelIt', 'section', 'unit'])
  })

  it('keeps money with its grain, the portal to everyone-seen fields or a price, a list on selects, a link on links', () => {
    expect(fieldProblems({ code: 'retail', type: 'MONEY', labelIt: 'a', labelEn: 'b' }).map((problem) => problem.path)).toEqual(['grain'])
    expect(fieldProblems({ code: 'retail', type: 'MONEY', labelIt: 'a', labelEn: 'b', grain: 'price', shownInPortal: true })).toEqual([])
    expect(fieldProblems({ code: 'retail', type: 'MONEY', labelIt: 'a', labelEn: 'b', audience: 'INTERNAL' }).map((problem) => problem.path)).toContain('audience')
    expect(fieldProblems({ code: 'unit_cost', type: 'MONEY', labelIt: 'a', labelEn: 'b', grain: 'cost', shownInPortal: true }).map((problem) => problem.path)).toEqual(['shownInPortal'])
    expect(fieldProblems({ code: 'margin_pct', type: 'NUMBER', labelIt: 'a', labelEn: 'b', audience: 'MONEY', grain: 'margin', unit: '%' })).toEqual([])
    expect(fieldProblems({ code: 'nick', type: 'TEXT', labelIt: 'a', labelEn: 'b', audience: 'PERSONAL', shownInPortal: true }).map((problem) => problem.path)).toEqual(['shownInPortal'])
    expect(fieldProblems({ code: 'nick', type: 'TEXT', labelIt: 'a', labelEn: 'b', grain: 'price' }).map((problem) => problem.path)).toEqual(['grain'])
    expect(fieldProblems({ code: 'lining', type: 'SELECT', labelIt: 'a', labelEn: 'b' }).map((problem) => problem.path)).toEqual(['picklistId'])
    expect(fieldProblems({ code: 'lining', type: 'TEXT', labelIt: 'a', labelEn: 'b', picklistId: 'x' }).map((problem) => problem.path)).toEqual(['picklistId'])
    expect(fieldProblems({ code: 'ref', type: 'LINK', labelIt: 'a', labelEn: 'b' }).map((problem) => problem.path)).toEqual(['linkTo'])
  })

  it('never changes a field\'s code, type, list or link; a change is checked against the field as it is', () => {
    const current = { code: 'retail', type: 'MONEY' as const, audience: 'MONEY' as const, grain: 'price' as const, shownInPortal: false, unit: null }
    expect(fieldProblems({ type: 'TEXT', code: 'other' }, current).map((problem) => problem.path)).toEqual(['code', 'type'])
    expect(fieldProblems({ audience: 'INTERNAL' }, current).map((problem) => problem.path)).toContain('audience')
    expect(fieldProblems({ grain: 'cost', shownInPortal: true }, current).map((problem) => problem.path)).toEqual(['shownInPortal'])
    expect(factsAfter(current, { grain: 'cost' })).toMatchObject({ audience: 'MONEY', grain: 'cost' })
    expect(factsAfter({ ...current, type: 'NUMBER' }, { audience: 'INTERNAL' })).toMatchObject({ audience: 'INTERNAL', grain: null })
  })

  it('keeps lists and values: codes, words, the design system\'s colours and icons, order', () => {
    expect(picklistProblems({ code: 'lining_type', labelIt: 'Fodera', labelEn: 'Lining' }, true)).toEqual([])
    expect(picklistProblems({ code: 'other' }, false).map((problem) => problem.path)).toEqual(['code'])
    expect(optionProblems({ code: 'FULL_GRAIN', labelIt: 'Pieno fiore', labelEn: 'Full grain', colour: '#1F6FDE', icon: 'star' }, true)).toEqual([])
    expect(optionProblems({ code: 'full', labelIt: 'a', labelEn: 'b', colour: '#123456', icon: 'wind', description: 'x'.repeat(501) }, true).map((problem) => problem.path)).toEqual(['code', 'colour', 'icon', 'description'])
    expect(orderProblems(['a', 'b'], ['b', 'a'])).toEqual([])
    expect(orderProblems(['a', 'b'], ['a', 'a']).length).toBeGreaterThan(0)
    expect([...placesOf(['b', 'a']).entries()]).toEqual([['b', 10], ['a', 20]])
    expect(nextPlace([])).toBe(10)
    expect(nextPlace([10, 40])).toBe(50)
  })
})

describe('who sees a field', () => {
  const internal = { audience: 'INTERNAL' as const, grain: null, shownInPortal: false }
  const price = { audience: 'MONEY' as const, grain: 'price' as const, shownInPortal: true }
  const cost = { audience: 'MONEY' as const, grain: 'cost' as const, shownInPortal: false }
  const personal = { audience: 'PERSONAL' as const, grain: null, shownInPortal: false }

  it('office: internal always, money with its grain, personal with fields.personal.view', () => {
    expect(fieldSeenBy(office([]), internal)).toBe(true)
    expect(fieldSeenBy(office([]), price)).toBe(false)
    expect(fieldSeenBy(office(['money.price']), price)).toBe(true)
    expect(fieldSeenBy(office(['money.price']), cost)).toBe(false)
    expect(fieldSeenBy(office([]), personal)).toBe(false)
    expect(fieldSeenBy(office(['fields.personal.view']), personal)).toBe(true)
  })

  it('partner: only what the portal shows, a price only with the price grain; the floor nothing', () => {
    expect(fieldSeenBy(partner([]), internal)).toBe(false)
    expect(fieldSeenBy(partner([]), { ...internal, shownInPortal: true })).toBe(true)
    expect(fieldSeenBy(partner([]), price)).toBe(false)
    expect(fieldSeenBy(partner(['money.price']), price)).toBe(true)
    expect(fieldSeenBy(floor, internal)).toBe(false)
    expect(fieldSeenBy(floor, { audience: 'MONEY', grain: 'wages', shownInPortal: false })).toBe(false)
  })

  it('carries a money field\'s grain in its column id', () => {
    expect(columnIdOf({ code: 'fair_date', audience: 'INTERNAL', grain: null })).toBe('cf:fair_date')
    expect(columnIdOf({ code: 'retail', audience: 'MONEY', grain: 'price' })).toBe('cf:price:retail')
    expect(columnOf('cf:price:retail')).toEqual({ code: 'retail', grain: 'price' })
    expect(columnOf('cf:fair_date')).toEqual({ code: 'fair_date', grain: null })
    expect(columnOf('cf:gold:retail')).toBeNull()
    expect(columnOf('number')).toBeNull()
    expect(grainOfColumn('cf:cost:unit')).toBe('cost')
    expect(grainOfColumn('cf:fair_date')).toBeUndefined()
  })
})

describe('values (PLT-111, PLT-115)', () => {
  it('checks each type and keeps a deactivated value only where the record has it', () => {
    expect(checkValue({ type: 'TEXT' }, '  HN-17 ')).toEqual({ value: 'HN-17' })
    expect(checkValue({ type: 'TEXT' }, ' ')).toHaveProperty('problem')
    expect(checkValue({ type: 'NUMBER' }, 1.2)).toEqual({ value: 1.2 })
    expect(checkValue({ type: 'NUMBER' }, '1.2')).toHaveProperty('problem')
    expect(checkValue({ type: 'MONEY' }, { amount: 89900, currency: 'EUR' })).toEqual({ value: { amount: 89900, currency: 'EUR' } })
    expect(checkValue({ type: 'MONEY' }, { amount: 899.5, currency: 'EUR' })).toHaveProperty('problem')
    expect(checkValue({ type: 'DATE' }, '2027-02-30')).toHaveProperty('problem')
    expect(checkValue({ type: 'DATE' }, '2027-01-21')).toEqual({ value: '2027-01-21' })
    expect(checkValue({ type: 'YES_NO' }, false)).toEqual({ value: false })
    expect(checkValue({ type: 'SELECT', options: OPTIONS }, 'MESH')).toEqual({ value: 'MESH' })
    expect(checkValue({ type: 'SELECT', options: OPTIONS }, 'QUILTED')).toHaveProperty('problem')
    expect(checkValue({ type: 'SELECT', options: OPTIONS }, 'QUILTED', 'QUILTED')).toEqual({ value: 'QUILTED' })
    expect(checkValue({ type: 'SELECT', options: OPTIONS }, 'NOPE')).toHaveProperty('problem')
    expect(checkValue({ type: 'MULTI_SELECT', options: OPTIONS }, ['THERMAL', 'MESH'])).toEqual({ value: ['MESH', 'THERMAL'] })
    expect(checkValue({ type: 'MULTI_SELECT', options: OPTIONS }, ['MESH', 'MESH'])).toHaveProperty('problem')
    expect(checkValue({ type: 'MULTI_SELECT', options: OPTIONS }, ['QUILTED'], ['QUILTED', 'MESH'])).toEqual({ value: ['QUILTED'] })
    expect(checkValue({ type: 'MULTI_SELECT', options: OPTIONS }, [])).toHaveProperty('problem')
    expect(checkValue({ type: 'PERSON' }, '0190A1B2-0000-7000-8000-000000000001')).toEqual({ value: '0190a1b2-0000-7000-8000-000000000001' })
    expect(checkValue({ type: 'LINK' }, 'JKT-01')).toHaveProperty('problem')
  })

  it('compares and reads stored values back', () => {
    expect(sameStored(['A', 'B'], ['B', 'A'])).toBe(true)
    expect(sameStored({ amount: 1, currency: 'EUR' }, { amount: 1, currency: 'USD' })).toBe(false)
    expect(sameStored(null, null)).toBe(true)
    expect(sameStored('x', null)).toBe(false)
    expect(storedOf({ amount: 5, currency: 'EUR' })).toEqual({ amount: 5, currency: 'EUR' })
    expect(storedOf(null)).toBeNull()
    expect(storedOf({ other: 1 })).toBeNull()
  })

  it('reads an import cell: codes or labels of the list, sì/no, days; numbers and amounts in their own columns', () => {
    expect(importInput({ type: 'SELECT', options: OPTIONS }, 'termica')).toEqual({ input: 'THERMAL' })
    expect(importInput({ type: 'MULTI_SELECT', options: OPTIONS }, 'mesh, Termica')).toEqual({ input: ['MESH', 'THERMAL'] })
    expect(importInput({ type: 'MULTI_SELECT', options: OPTIONS }, 'mesh, wool')).toHaveProperty('problem')
    expect(importInput({ type: 'YES_NO' }, 'sì')).toEqual({ input: true })
    expect(importInput({ type: 'DATE' }, '21/01/2027')).toEqual({ input: '2027-01-21' })
    expect(importInput({ type: 'PERSON' }, 'Desk@Example.com')).toEqual({ ref: 'desk@example.com' })
    expect(importInput({ type: 'NUMBER' }, '1,2')).toHaveProperty('problem')
    expect(importInput({ type: 'FILE' }, 'x')).toHaveProperty('problem')
    expect(minorOfImport('899.00', 'EUR')).toEqual({ amount: 89900 })
    expect(minorOfImport('899.005', 'EUR')).toHaveProperty('problem')
    expect(minorOfImport('100', 'JPY')).toEqual({ amount: 100 })
    expect(decimalOfMinor({ amount: 89900, currency: 'EUR' })).toBe('899.00')
  })

  it('writes a value as a file cell in the file\'s language', () => {
    const words = (id: string) => (id === 'u1' ? 'Desk person' : null)
    expect(exportCellOf({ type: 'SELECT', options: OPTIONS }, 'THERMAL', 'it', words)).toBe('Termica')
    expect(exportCellOf({ type: 'MULTI_SELECT', options: OPTIONS }, ['MESH', 'QUILTED'], 'en', words)).toBe('Mesh, Quilted')
    expect(exportCellOf({ type: 'MONEY' }, { amount: 89900, currency: 'EUR' }, 'it', words)).toEqual({ minor: 89900, currency: 'EUR' })
    expect(exportCellOf({ type: 'DATE' }, '2027-01-21', 'it', words)).toEqual({ day: '2027-01-21' })
    expect(exportCellOf({ type: 'YES_NO' }, true, 'it', words)).toBe('Sì')
    expect(exportCellOf({ type: 'PERSON' }, 'u1', 'it', words)).toBe('Desk person')
    expect(exportCellOf({ type: 'LINK' }, 'hidden', 'it', words)).toBeNull()
    expect(exportCellOf({ type: 'NUMBER' }, 1.2, 'en', words)).toBe(1.2)
  })
})

describe('filters', () => {
  it('parses the cf term and refuses what it cannot read', () => {
    expect(parseFilter('finish_grade:A_GRADE,B_GRADE;fair_date>=2027-01-01;rush:-').clauses).toEqual([
      { code: 'finish_grade', op: 'any', values: ['A_GRADE', 'B_GRADE'] },
      { code: 'fair_date', op: 'gte', values: ['2027-01-01'] },
      { code: 'rush', op: 'unset', values: [] },
    ])
    expect(parseFilter('').clauses).toEqual([])
    expect(parseFilter('Bad Code:1').problems.length).toBe(1)
    expect(parseFilter(Array.from({ length: 11 }, (_, index) => `f${index}:*`).join(';')).problems.length).toBe(1)
    expect(clauseProblem('SELECT', { code: 'a', op: 'gte', values: ['1'] })).not.toBeNull()
    expect(clauseProblem('MONEY', { code: 'a', op: 'any', values: ['1'] })).not.toBeNull()
    expect(clauseProblem('MONEY', { code: 'a', op: 'lte', values: ['90000'] })).toBeNull()
    expect(clauseProblem('YES_NO', { code: 'a', op: 'any', values: ['maybe'] })).not.toBeNull()
  })

  it('matches values by type', () => {
    expect(meets('SELECT', 'A_GRADE', { code: 'g', op: 'any', values: ['A_GRADE'] })).toBe(true)
    expect(meets('MULTI_SELECT', ['MESH', 'THERMAL'], { code: 'g', op: 'any', values: ['THERMAL'] })).toBe(true)
    expect(meets('TEXT', 'Seed Promo 2026', { code: 'g', op: 'any', values: ['promo'] })).toBe(true)
    expect(meets('DATE', '2027-01-21', { code: 'g', op: 'gte', values: ['2027-01-01'] })).toBe(true)
    expect(meets('DATE', '2026-12-21', { code: 'g', op: 'gte', values: ['2027-01-01'] })).toBe(false)
    expect(meets('NUMBER', 1.2, { code: 'g', op: 'lte', values: ['1.2'] })).toBe(true)
    expect(meets('NUMBER', 1.2, { code: 'g', op: 'any', values: ['1.20'] })).toBe(true)
    expect(meets('MONEY', { amount: 89900, currency: 'EUR' }, { code: 'g', op: 'gte', values: ['90000'] })).toBe(false)
    expect(meets('YES_NO', false, { code: 'g', op: 'any', values: ['false'] })).toBe(true)
    expect(meets('TEXT', null, { code: 'g', op: 'unset', values: [] })).toBe(true)
    expect(meets('TEXT', 'x', { code: 'g', op: 'set', values: [] })).toBe(true)
  })
})

describe('the import of custom values', () => {
  const importer = customValuesImporter('fields.orders', 'Order custom fields')
  const parse = (row: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(row).map(([name, raw]) => {
        const parsed = (importer.columns as Record<string, { readonly type: ReturnType<typeof cell.text> }>)[name]!.type.safeParse({ raw, context: { numberFormat: 'en' } })
        return [name, parsed.success ? parsed.data : `!${raw}`]
      }),
    )

  it('reads every template row and wants exactly one value per row', () => {
    for (const example of CUSTOM_VALUE_EXAMPLES) {
      const values = parse(example)
      expect(Object.values(values).some((value) => String(value).startsWith('!'))).toBe(false)
      expect(importer.validateRow(values)).toEqual([])
    }
    expect(importer.validateRow({ record: 'SO-1', field: 'x' }).map((issue) => issue.column)).toEqual(['value'])
    expect(importer.validateRow({ record: 'SO-1', field: 'x', value: 'a', number: '1' }).map((issue) => issue.column)).toEqual(['number'])
    expect(importer.validateRow({ record: 'SO-1', field: 'x', priceValue: '1' }).map((issue) => issue.column)).toEqual(['currency'])
    expect(importer.keyColumns).toEqual(['record', 'field'])
    expect(importer.columns.priceValue.grain).toBe('price')
  })
})

describe('the catalogues', () => {
  it('declares the permissions, gives them to their templates, and declares the events', () => {
    for (const name of FIELDS_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    expect(templateOf('admin')!.permissions).toEqual(expect.arrayContaining(['fields.view', 'fields.manage', 'fields.personal.view']))
    expect(templateOf('sales')!.permissions).toContain('fields.personal.view')
    expect(templateOf('sales')!.permissions).not.toContain('fields.manage')
    expect(templateOf('read_only')!.permissions).not.toContain('fields.personal.view')
    for (const type of ['custom_field.changed', 'picklist.changed', 'custom_value.changed']) expect(EVENT_CATALOGUE.find(type, 1)).toBeDefined()
  })
})
