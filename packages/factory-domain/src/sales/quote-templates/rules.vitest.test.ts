import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { createTemplateBody, startQuoteBody } from './contracts'
import { QUOTES_TEMPLATES_MANAGE } from './permissions'
import { planStart, templateHeaderProblems, templateLineProblems, templateServes, type TemplateHeader, type TemplateLineInput } from './rules'

const header: TemplateHeader = {
  name: 'Season order',
  description: null,
  language: 'it',
  currency: 'EUR',
  validityDays: 45,
  firmOffer: false,
  acceptanceMode: 'SIGN_AND_PAY',
  depositPct: '30',
  depositKind: 'ACCONTO',
  termsText: null,
  termsVersion: null,
  incoterm: 'EXW',
  incotermPlace: 'Seedville',
  shipComplete: true,
}

const line = (over: Partial<TemplateLineInput> = {}): TemplateLineInput => ({ seq: 10, section: 'Jackets', kind: 'SIZE_GRID', feeKind: null, styleId: 's1', colourwayId: 'c1', sizes: { '50': 2, '52': 4 }, unitPrice: null, description: null, note: null, ...over })

describe('quote templates (SAL-144, SAL-252)', () => {
  it('takes a header with its validity, deposit, acceptance mode and Incoterm', () => {
    expect(templateHeaderProblems(header)).toEqual([])
    expect(templateHeaderProblems({ ...header, name: ' ' })[0]?.path).toBe('body/name')
    expect(templateHeaderProblems({ ...header, validityDays: 0 })[0]?.path).toBe('body/validityDays')
    expect(templateHeaderProblems({ ...header, depositKind: null })[0]?.path).toBe('body/depositKind')
    expect(templateHeaderProblems({ ...header, depositPct: null, depositKind: null }).map((issue) => issue.message)).toEqual(['Sign and pay the deposit: the quote must ask a deposit first.'])
    expect(templateHeaderProblems({ ...header, incotermPlace: null })[0]?.path).toBe('body/incotermPlace')
    expect(templateHeaderProblems({ ...header, language: 'de' })[0]?.path).toBe('body/language')
  })

  it('takes lines in sections, a fee line with its kind and price, pieces per size or typed at use', () => {
    expect(templateLineProblems([line(), line({ seq: 20, colourwayId: null, sizes: null }), line({ seq: 30, section: 'Fees', kind: 'FEE', feeKind: 'DEVELOPMENT', sizes: null, unitPrice: '500' })])).toEqual([])
    const words = (lines: TemplateLineInput[]) => templateLineProblems(lines).map((issue) => issue.message)
    expect(words([line(), line()])).toContain('Line 10 is named twice.')
    expect(words([line({ kind: 'FEE', feeKind: null, sizes: null, unitPrice: '5' })])[0]).toContain('A fee line says what it charges for')
    expect(words([line({ kind: 'FEE', feeKind: 'SAMPLE', sizes: null })])).toContain('A fee line has its price.')
    expect(words([line({ feeKind: 'SAMPLE' })])).toContain('Only a fee line has a fee kind.')
    expect(words([line({ sizes: { '50': 0 } })])[0]).toContain('whole pieces from 1')
    expect(words([line({ unitPrice: '0' })])[0]).toContain('A unit price above 0')
  })

  it('serves its own company, or every company when it has none', () => {
    expect(templateServes({ companyId: null }, 'a')).toBe(true)
    expect(templateServes({ companyId: 'a' }, 'a')).toBe(true)
    expect(templateServes({ companyId: 'a' }, 'b')).toBe(false)
  })

  it('starts a quote with the lines it can, and says what it leaves out', () => {
    const lines = [{ ...line(), id: 't10' }, { ...line({ seq: 20, colourwayId: null, sizes: null }), id: 't20' }, { ...line({ seq: 30, kind: 'FEE', feeKind: 'DEVELOPMENT', sizes: null, unitPrice: '500' }), id: 't30' }, { ...line({ seq: 40 }), id: 't40' }]
    const plan = planStart(lines, [{ templateLineId: 't40', skip: true }])
    expect(plan.lines.map((entry) => entry.seq)).toEqual([10])
    expect(plan.lines[0]).toMatchObject({ section: 'Jackets', colourwayId: 'c1', sizes: { '50': 2, '52': 4 } })
    expect(plan.leftOut.map((entry) => [entry.seq, entry.reason.split(':')[0]])).toEqual([
      [20, 'Its colourway is chosen when the quote is made'],
      [30, 'A fee line is not added to a quote yet'],
      [40, 'Left out when the quote was made.'],
    ])
    const picked = planStart(lines, [{ templateLineId: 't20', colourwayId: 'c2', sizes: { '54': 3 } }])
    expect(picked.lines.find((entry) => entry.seq === 20)).toMatchObject({ colourwayId: 'c2', sizes: { '54': 3 } })
  })

  it('refuses paying alone in a body, and keeps the permission with sales and finance', () => {
    expect(createTemplateBody.safeParse({ companyId: null, name: 'X', acceptanceMode: 'PAY' }).success).toBe(false)
    expect(startQuoteBody.safeParse({ companyId: '0190f8a6-0000-7000-8000-000000000001', partyId: '0190f8a6-0000-7000-8000-000000000002' }).success).toBe(true)
    expect(FACTORY_PERMISSIONS.isDeclared(QUOTES_TEMPLATES_MANAGE)).toBe(true)
    expect(templateOf('sales')!.permissions).toContain(QUOTES_TEMPLATES_MANAGE)
    expect(templateOf('finance')!.permissions).toContain(QUOTES_TEMPLATES_MANAGE)
    expect(templateOf('planner')!.permissions).not.toContain(QUOTES_TEMPLATES_MANAGE)
  })
})
