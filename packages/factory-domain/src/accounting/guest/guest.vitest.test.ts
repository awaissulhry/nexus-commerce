import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { partnerTemplateOf, ROLE_TEMPLATES, templateOf } from '../../auth/roles/templates'
import { guestOverviewAnswer, guestPeriodAnswer, guestZipBody, inviteAccountantBody } from './contracts'
import { batchStanding, GUEST_ZIP, purchaseKindOf, registerStanding, salesKindOf, zipNameOf, zipPaths, zipProblem, zipSafeName } from './files'
import { dayShared, guestPeriodWords, handedOverMonths, latestHandedOver, parseGuestPeriod, periodChoices, shareOf } from './periods'
import { ACCOUNTANT_ROLE_KEY, ACCOUNTING_ACCOUNTANTS_MANAGE, PORTAL_ACCOUNTING_VIEW } from './permissions'

describe('the accountant’s periods (B-W2b-201)', () => {
  it('reads a month, a calendar quarter and a calendar year; refuses anything else', () => {
    expect(parseGuestPeriod('2026-10')).toMatchObject({ kind: 'MONTH', months: ['2026-10'], start: '2026-10-01', end: '2026-10-31' })
    expect(parseGuestPeriod('2026-Q4')).toMatchObject({ kind: 'QUARTER', months: ['2026-10', '2026-11', '2026-12'], start: '2026-10-01', end: '2026-12-31' })
    expect(parseGuestPeriod('2026-Q1')!.end).toBe('2026-03-31')
    expect(parseGuestPeriod('2026')).toMatchObject({ kind: 'YEAR', start: '2026-01-01', end: '2026-12-31' })
    expect(parseGuestPeriod('2026')!.months).toHaveLength(12)
    for (const bad of ['2026-13', '2026-Q5', '1999', '26-10', '2026-1', '', 'october', null, 2026]) expect(parseGuestPeriod(bad), String(bad)).toBeNull()
  })

  it('says the period in Italian and English', () => {
    expect(guestPeriodWords(parseGuestPeriod('2026-10')!, 'it')).toBe('ottobre 2026')
    expect(guestPeriodWords(parseGuestPeriod('2026-10')!, 'en')).toBe('October 2026')
    expect(guestPeriodWords(parseGuestPeriod('2026-Q4')!, 'it')).toBe('4° trimestre 2026')
    expect(guestPeriodWords(parseGuestPeriod('2026-Q4')!, 'en')).toBe('Q4 2026')
    expect(guestPeriodWords(parseGuestPeriod('2026')!, 'it')).toBe('2026')
  })

  it('hands over the months of the exported batches only; a quarter covers its handed-over months', () => {
    const handedOver = handedOverMonths([
      { periodStart: '2026-09-01', periodEnd: '2026-09-30' },
      { periodStart: '2026-10-01', periodEnd: '2026-10-31' },
      { periodStart: '2026-10-01', periodEnd: '2026-10-31' },
    ])
    expect(handedOver).toEqual(['2026-09', '2026-10'])
    expect(handedOverMonths([{ periodStart: '2026-11-01', periodEnd: '2027-01-31' }])).toEqual(['2026-11', '2026-12', '2027-01'])
    const q4 = shareOf(parseGuestPeriod('2026-Q4')!, handedOver)
    expect(q4.shared).toEqual(['2026-10'])
    expect(q4.months.map((entry) => entry.shared)).toEqual([true, false, false])
    expect(shareOf(parseGuestPeriod('2026-11')!, new Set(handedOver)).shared).toEqual([])
    expect(dayShared('2026-10-28', q4)).toBe(true)
    expect(dayShared('2026-11-13', q4)).toBe(false)
    expect(periodChoices(handedOver)).toEqual({ months: ['2026-10', '2026-09'], quarters: ['2026-Q4', '2026-Q3'], years: ['2026'] })
    expect(latestHandedOver(handedOver)).toBe('2026-10')
    expect(latestHandedOver([])).toBeNull()
  })
})

describe('the accountant’s files (B-W2b-201)', () => {
  it('names each invoice’s kind from its document type', () => {
    expect(['TD01', 'TD24', 'TD02', 'TD04'].map(salesKindOf)).toEqual(['INVOICE', 'INVOICE', 'DEPOSIT', 'CREDIT_NOTE'])
    expect(purchaseKindOf('INVOICE', 'TD01')).toBe('INVOICE')
    expect(purchaseKindOf('CREDIT_NOTE', null)).toBe('CREDIT_NOTE')
    expect(purchaseKindOf('INVOICE', 'TD04')).toBe('CREDIT_NOTE')
  })

  it('says which batch a batch amends and which amended it', () => {
    const standing = batchStanding([
      { id: 'a', number: 'EXP-2026-0002', supersedesId: null, exportedAt: '2026-11-03T10:00:00.000Z', packages: ['SALES_JOURNAL'] },
      { id: 'b', number: 'EXP-2026-0003', supersedesId: 'a', exportedAt: '2026-11-05T10:00:00.000Z', packages: ['PAYMENTS'] },
      { id: 'c', number: 'EXP-2026-0004', supersedesId: 'b', exportedAt: '2026-11-06T10:00:00.000Z', packages: ['PAYMENTS'] },
    ])
    expect(standing.get('a')).toEqual({ amends: null, amendedBy: 'EXP-2026-0003' })
    expect(standing.get('b')).toEqual({ amends: 'EXP-2026-0002', amendedBy: 'EXP-2026-0004' })
    expect(standing.get('c')).toEqual({ amends: 'EXP-2026-0003', amendedBy: null })
  })

  it('keeps the newest whole register file of a month current; an older one is replaced by its batch', () => {
    const rows = registerStanding([
      { month: '2026-10', package: 'INTRASTAT' as const, exportNumber: 'EXP-2026-0002', exportedAt: '2026-11-03T10:00:00.000Z' },
      { month: '2026-10', package: 'INTRASTAT' as const, exportNumber: 'EXP-2026-0003', exportedAt: '2026-11-05T10:00:00.000Z' },
      { month: '2026-12', package: 'YEAR_END_STOCK' as const, exportNumber: 'EXP-2027-0001', exportedAt: '2027-01-10T10:00:00.000Z' },
    ])
    expect(rows.map((row) => [row.exportNumber, row.current, row.replacedBy])).toEqual([
      ['EXP-2026-0002', false, 'EXP-2026-0003'],
      ['EXP-2026-0003', true, null],
      ['EXP-2027-0001', true, null],
    ])
  })

  it('makes safe, unique paths in the zip, and refuses a zip too big or empty', () => {
    expect(zipSafeName('../a/b:c.xml')).toBe('__a_b_c.xml')
    expect(zipPaths([
      { folder: 'SALES', name: 'IT0_001.xml' },
      { folder: 'SALES', name: 'it0_001.XML' },
      { folder: 'PURCHASE', name: 'IT0_001.xml' },
      { folder: 'EXPORTS', name: 'SCA_2026-10_sales-journal.csv' },
    ])).toEqual(['e-invoices/sales/IT0_001.xml', 'e-invoices/sales/it0_001 (2).XML', 'e-invoices/purchases/IT0_001.xml', 'exports/SCA_2026-10_sales-journal.csv'])
    expect(zipNameOf('SCA', '2026-Q4', 'XML')).toBe('SCA_2026-Q4_xml.zip')
    expect(zipProblem([])).toBe('NOTHING_TO_ZIP')
    expect(zipProblem(Array.from({ length: GUEST_ZIP.maxFiles + 1 }, () => ({ sizeBytes: 10 })))).toBe('TOO_MANY_FILES')
    expect(zipProblem([{ sizeBytes: GUEST_ZIP.fileBytes + 1 }])).toBe('TOO_LARGE')
    expect(zipProblem([{ sizeBytes: 9_000 }])).toBeNull()
  })
})

describe('who holds accountant access (B-W2b-201)', () => {
  it('the accountant holds the room, flagged partner; no office or floor role does', () => {
    expect(FACTORY_PERMISSIONS.get(PORTAL_ACCOUNTING_VIEW)).toMatchObject({ partner: true, risk: 'read' })
    expect(partnerTemplateOf(ACCOUNTANT_ROLE_KEY)!.permissions).toContain(PORTAL_ACCOUNTING_VIEW)
    expect(partnerTemplateOf(ACCOUNTANT_ROLE_KEY)!.grains).toEqual(['price'])
    expect(ROLE_TEMPLATES.filter((template) => template.permissions.includes(PORTAL_ACCOUNTING_VIEW))).toEqual([])
    expect(partnerTemplateOf('customer-buyer')!.permissions).not.toContain(PORTAL_ACCOUNTING_VIEW)
    expect(partnerTemplateOf('supplier-admin')!.permissions).not.toContain(PORTAL_ACCOUNTING_VIEW)
  })

  it('finance gives it (step-up); finance holds no partners.* for it', () => {
    expect(FACTORY_PERMISSIONS.get(ACCOUNTING_ACCOUNTANTS_MANAGE)).toMatchObject({ risk: 'stepUp' })
    expect(templateOf('finance')!.permissions).toContain(ACCOUNTING_ACCOUNTANTS_MANAGE)
    expect(templateOf('finance')!.permissions.filter((name) => name.startsWith('partners.'))).toEqual([])
    expect(templateOf('sales')!.permissions).not.toContain(ACCOUNTING_ACCOUNTANTS_MANAGE)
    expect(templateOf('read_only')!.permissions).not.toContain(ACCOUNTING_ACCOUNTANTS_MANAGE)
  })
})

describe('the contracts (B-W2b-201)', () => {
  it('carry no amount, and the bodies refuse unknown keys', () => {
    const MONEY = /cost|margin|price|amount|total|wage|net|vat/i
    const keysOf = (shape: unknown): string[] => {
      const def = (shape as { def?: { shape?: Record<string, unknown>; element?: unknown; innerType?: unknown } }).def
      if (!def) return []
      if (def.shape) return Object.entries(def.shape).flatMap(([name, value]) => [name, ...keysOf(value)])
      if (def.element) return keysOf(def.element)
      if (def.innerType) return keysOf(def.innerType)
      return []
    }
    expect(keysOf(guestPeriodAnswer)).toEqual(expect.arrayContaining(['invoices', 'xml', 'sha256', 'replacedBy']))
    expect(keysOf(guestOverviewAnswer).filter((name) => MONEY.test(name))).toEqual([])
    expect(keysOf(guestPeriodAnswer).filter((name) => MONEY.test(name))).toEqual([])
    expect(guestZipBody.safeParse({ period: '2026-10', what: 'XML', extra: 1 }).success).toBe(false)
    expect(guestZipBody.safeParse({ period: '2026-13', what: 'XML' }).success).toBe(false)
    expect(inviteAccountantBody.safeParse({ companyId: '0190f0e2-1950-7000-8000-000000000001', partyId: '0190f0e2-1950-7000-8000-000000000002', email: 'a@b.example', displayName: 'A', accessUntil: '2027-01-31T22:59:59.999Z' }).success).toBe(true)
    expect(inviteAccountantBody.safeParse({ companyId: '0190f0e2-1950-7000-8000-000000000001', partyId: '0190f0e2-1950-7000-8000-000000000002', email: 'a@b.example', displayName: 'A' }).success).toBe(false)
  })
})
