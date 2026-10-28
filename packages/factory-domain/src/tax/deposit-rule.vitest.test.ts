import { describe, expect, it } from 'vitest'
import { depositDocumentFor } from './deposit-rule'
import { DEFAULT_TAX_RULES_CONFIG, TAX_RULES } from './rules'

describe('when a deposit needs a TD02, per customer type', () => {
  it('DPR 633/1972 art. 6 c.4 — a deposit from an Italian business is invoiced with a TD02 on the day it is paid', () => {
    const result = depositDocumentFor({ taxMode: 'IT_B2B' })
    expect(result.documentType).toBe('TD02')
    expect(result.law).toBe('DPR 633/1972 art. 6 c.4')
    expect(result.unverified).toBe(false)
  })

  it('DPR 633/1972 art. 6 c.4 — a deposit from an Italian consumer is invoiced with a TD02 too', () => {
    const result = depositDocumentFor({ taxMode: 'IT_B2C' })
    expect(result.documentType).toBe('TD02')
    expect(result.ruleId).toBe('DEPOSIT_INVOICE_IT')
  })

  it('DL 331/1993 art. 39 (UNVERIFIED, accountant to confirm) — a deposit from an EU business for goods needs no TD02 by default', () => {
    const result = depositDocumentFor({ taxMode: 'EU_B2B', viesValid: true })
    expect(result.documentType).toBeNull()
    expect(result.ruleId).toBe('DEPOSIT_EU_B2B_GOODS')
    expect(result.law).toBe('DL 331/1993 art. 39')
    expect(result.unverified).toBe(true)
    expect(TAX_RULES.DEPOSIT_EU_B2B_GOODS.accountantToConfirm).toMatch(/euBusinessDepositNeedsInvoice/)
  })

  it('DL 331/1993 art. 39 (UNVERIFIED) — the EU-business rule is a setting: switched on, the deposit gets a TD02', () => {
    const result = depositDocumentFor(
      { taxMode: 'EU_B2B', viesValid: true },
      'GOODS',
      { ...DEFAULT_TAX_RULES_CONFIG, euBusinessDepositNeedsInvoice: true },
    )
    expect(result.documentType).toBe('TD02')
    expect(result.ruleId).toBe('DEPOSIT_EU_B2B_GOODS')
    expect(result.unverified).toBe(true)
  })

  it('an EU business without a valid VIES check is taxed in Italy, so its deposit gets a TD02 whatever the setting', () => {
    for (const viesValid of [false, undefined]) {
      expect(depositDocumentFor({ taxMode: 'EU_B2B', viesValid }).documentType).toBe('TD02')
      expect(depositDocumentFor({ taxMode: 'EU_B2B', viesValid }).ruleId).toBe('DEPOSIT_INVOICE_IT')
    }
  })

  it('a deposit for a service to an EU business is invoiced at payment (UNVERIFIED)', () => {
    const result = depositDocumentFor({ taxMode: 'EU_B2B', viesValid: true }, 'SERVICES')
    expect(result.documentType).toBe('TD02')
    expect(result.unverified).toBe(true)
  })

  it('a deposit from an EU consumer or from outside the EU gets a TD02 (UNVERIFIED), and OSS is refused', () => {
    expect(depositDocumentFor({ taxMode: 'EU_B2C' })).toMatchObject({ documentType: 'TD02', unverified: true })
    expect(depositDocumentFor({ taxMode: 'EXTRA_EU' })).toMatchObject({ documentType: 'TD02', ruleId: 'DEPOSIT_EXPORT' })
    expect(() =>
      depositDocumentFor({ taxMode: 'EU_B2C' }, 'GOODS', { ...DEFAULT_TAX_RULES_CONFIG, euConsumerGoodsVat: 'OSS' }),
    ).toThrow(/OSS/)
  })

  it('gives a reason in words for every customer type', () => {
    for (const taxMode of ['IT_B2B', 'IT_B2C', 'EU_B2B', 'EU_B2C', 'EXTRA_EU'] as const) {
      expect(depositDocumentFor({ taxMode, viesValid: true }).reason.length).toBeGreaterThan(10)
    }
  })
})
