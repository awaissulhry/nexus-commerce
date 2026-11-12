import { describe, expect, it } from 'vitest'
import { SEND_CHECK_CODES } from '../quotes/send'
import { LINE_RULE_CODES, lifecycleFinding, marketFinding, materialFindings, overdueFinding, overdueOf, privateLabelFinding, scopeFinding } from './rules'

const line = { seq: 20, label: 'SEED-JKT-01 BLK' }

describe('customer and product warnings (SAL-147; QT1:01, QT1:02)', () => {
  it("refuses another customer's private-label style, never its brand nor a rider of the brand's team", () => {
    const style = { id: 'st', code: 'SEED-JKT-09', brandPartyId: 'brand' }
    expect(privateLabelFinding(line, style, { id: 'brand', teamPartyId: null }, null)).toBeNull()
    expect(privateLabelFinding(line, style, { id: 'rider', teamPartyId: 'brand' }, null)).toBeNull()
    expect(privateLabelFinding(line, { ...style, brandPartyId: null }, { id: 'other', teamPartyId: null }, null)).toBeNull()
    expect(privateLabelFinding(line, style, { id: 'other', teamPartyId: null }, null)).toEqual({
      code: 'PRIVATE_LABEL',
      severity: 'BLOCKS',
      message: "Line 20 (SEED-JKT-01 BLK): SEED-JKT-09 is another customer's private-label style; it is made and sold for that brand only.",
      open: { recordType: 'Style', recordId: 'st', tab: 'private-label' },
    })
  })

  it('refuses a colourway or a size the released revision is not released for; a whole scope passes', () => {
    const style = { id: 'st', code: 'SEED-JKT-01', sizes: ['48', '50', '52', '54', '56'] }
    const at = (colourwayId: string, sizes: string[], scope: { colourwayIds: string[]; sizes: string[] } | null) => scopeFinding({ ...line, colourwayId, sizes }, style, { revision: 3 }, scope, 'RED')
    expect(at('blk', ['50', '52'], { colourwayIds: [], sizes: [] })).toBeNull()
    expect(at('blk', ['50', '52'], null)).toBeNull()
    expect(at('red', ['50'], { colourwayIds: ['blk'], sizes: [] })?.message).toBe('Line 20 (SEED-JKT-01 BLK): SEED-JKT-01 revision 3 is not released for colourway RED yet. Release it for them first (the style\'s release), or quote what is released.')
    expect(at('blk', ['50', '54', '56'], { colourwayIds: [], sizes: ['48', '50', '52'] })).toMatchObject({ code: 'OUTSIDE_RELEASED_SCOPE', severity: 'BLOCKS', message: expect.stringContaining('not released for sizes 54, 56 yet') })
  })

  it('warns of a style being phased out or discontinued, with what replaces it', () => {
    expect(lifecycleFinding(line, { id: 'st', code: 'SEED-JKT-01', lifecycle: 'IN_PRODUCTION' }, null)).toBeNull()
    expect(lifecycleFinding(line, { id: 'st', code: 'SEED-JKT-01', lifecycle: 'PHASE_OUT' }, 'SEED-JKT-11')).toMatchObject({ code: 'STYLE_PHASE_OUT', severity: 'WARNING', message: expect.stringContaining('being phased out: made and sold while stock and orders last; SEED-JKT-11 replaces it') })
    expect(lifecycleFinding(line, { id: 'st', code: 'SEED-JKT-01', lifecycle: 'DISCONTINUED' }, null)?.message).toContain('discontinued')
  })

  it('warns when the goods go to a market the style is not sold in; every market when it names none', () => {
    const style = { id: 'st', code: 'SEED-JKT-01', marketCodes: ['IT', 'DE'] }
    expect(marketFinding(line, { ...style, marketCodes: [] }, null, 'FR')).toBeNull()
    expect(marketFinding(line, style, { code: 'DE', name: 'Germany' }, 'DE')).toBeNull()
    expect(marketFinding(line, style, { code: 'FR', name: 'France' }, 'FR')?.message).toBe('Line 20 (SEED-JKT-01 BLK): SEED-JKT-01 is not sold in France (FR), where the goods go (it is sold in IT, DE): its labels, declaration and certificates may not cover that market.')
    expect(marketFinding(line, style, null, 'CH')?.message).toContain('not sold in CH')
    expect(marketFinding(line, style, null, null)).toBeNull()
  })

  it('warns of a blocked material, by its approval or its compliance', () => {
    const material = { id: 'it', code: 'SEED-LEA-1', approval: 'APPROVED', approvalNote: null, complianceState: 'COMPLETE', complianceReason: null }
    expect(materialFindings(line, [material])).toEqual([])
    expect(materialFindings(line, [{ ...material, approval: 'BLOCKED', approvalNote: 'Cr VI found' }])[0]?.message).toBe('Line 20 (SEED-JKT-01 BLK): material SEED-LEA-1 is blocked (Cr VI found): it may not be used until it is approved again or replaced.')
    expect(materialFindings(line, [{ ...material, complianceState: 'BLOCKED', complianceReason: null }])[0]?.message).toContain('its compliance is blocked')
  })

  it('sums an overdue account per currency, without an amount in the words', () => {
    expect(overdueOf([{ invoiceNumber: 'F1', dueDate: '2026-11-12', open: 100, currency: 'EUR' }], '2026-11-12')).toBeNull()
    const summary = overdueOf(
      [
        { invoiceNumber: 'F1', dueDate: '2026-10-31', open: 12_000, currency: 'EUR' },
        { invoiceNumber: 'F1', dueDate: '2026-11-10', open: 3_000, currency: 'EUR' },
        { invoiceNumber: 'F2', dueDate: '2026-11-01', open: 0, currency: 'EUR' },
      ],
      '2026-11-12',
    )
    expect(summary).toEqual({ invoices: 1, amounts: [{ currency: 'EUR', amount: 15_000 }], oldestDueDate: '2026-10-31', daysLate: 12 })
    const finding = overdueFinding({ id: 'p', legalName: 'Seed Rider Shop' }, summary!)
    expect(finding.message).toBe('Seed Rider Shop has an invoice past due with this company, the oldest by 12 days: ask about the payment before the deal grows.')
    expect(finding.message).not.toMatch(/\d{3}/)
  })

  it('is a send check of a quote, each line rule; an overdue account is not', () => {
    for (const code of LINE_RULE_CODES) expect(SEND_CHECK_CODES).toContain(code)
    expect(SEND_CHECK_CODES).not.toContain('ACCOUNT_OVERDUE')
  })
})
