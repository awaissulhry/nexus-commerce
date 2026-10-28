import { describe, expect, it } from 'vitest'
import { NATURA_CODES, NATURA_DESCRIPTIONS } from './natura'
import { DEFAULT_TAX_RULES_CONFIG, TAX_RULES, TaxRuleError, unverifiedTaxRules } from './rules'
import {
  countryFitsTaxMode,
  decideVatTreatment,
  domesticReverseCharge,
  LEGAL_WORDING,
  treatmentKey,
  taxable,
} from './vat-treatment'

describe('VAT per line by customer type (FIN-098)', () => {
  it('an Italian business or consumer pays Italian VAT at the item rate', () => {
    for (const taxMode of ['IT_B2B', 'IT_B2C'] as const) {
      for (const rate of [22, 10, 5, 4] as const) {
        const result = decideVatTreatment({ customer: { taxMode }, supply: 'GOODS', rate })
        expect(result.treatment).toEqual({ kind: 'TAXABLE', rate })
        expect(result.ruleId).toBe('IT_DOMESTIC_SUPPLY')
        expect(result.unverified).toBe(false)
      }
    }
  })

  it('DL 331/1993 art. 41 — goods to an EU business are N3.2 only with a valid VIES check', () => {
    const valid = decideVatTreatment({ customer: { taxMode: 'EU_B2B', viesValid: true }, supply: 'GOODS', rate: 22 })
    expect(valid.treatment).toEqual({ kind: 'NON_TAXABLE', natura: 'N3.2', legalReference: LEGAL_WORDING.INTRA_EU_SUPPLY })
    expect(valid.law).toBe('DL 331/1993 art. 41')
    for (const viesValid of [false, undefined]) {
      const notChecked = decideVatTreatment({ customer: { taxMode: 'EU_B2B', viesValid }, supply: 'GOODS', rate: 22 })
      expect(notChecked.treatment).toEqual({ kind: 'TAXABLE', rate: 22 })
    }
  })

  it('DPR 633/1972 art. 7-ter and art. 21 c.6-bis — services to an EU business are N2.1 with "inversione contabile"', () => {
    const result = decideVatTreatment({ customer: { taxMode: 'EU_B2B', viesValid: true }, supply: 'SERVICES', rate: 22 })
    expect(result.treatment).toMatchObject({ kind: 'NON_TAXABLE', natura: 'N2.1' })
    expect(result.treatment.kind === 'NON_TAXABLE' && result.treatment.legalReference).toContain('inversione contabile')
  })

  it('DPR 633/1972 art. 8 c.1 lett. a) — goods exported outside the EU are N3.1; handed over in Italy they are taxed', () => {
    const exported = decideVatTreatment({ customer: { taxMode: 'EXTRA_EU' }, supply: 'GOODS', rate: 22, goodsLeaveEu: true })
    expect(exported.treatment).toMatchObject({ kind: 'NON_TAXABLE', natura: 'N3.1' })
    const handedOver = decideVatTreatment({ customer: { taxMode: 'EXTRA_EU' }, supply: 'GOODS', rate: 22, goodsLeaveEu: false })
    expect(handedOver.treatment).toEqual({ kind: 'TAXABLE', rate: 22 })
    expect(() => decideVatTreatment({ customer: { taxMode: 'EXTRA_EU' }, supply: 'GOODS', rate: 22 })).toThrow(TaxRuleError)
  })

  it('services outside the EU: N2.1 for a business, Italian VAT for a consumer, refused when unknown', () => {
    expect(
      decideVatTreatment({ customer: { taxMode: 'EXTRA_EU', extraEuBusiness: true }, supply: 'SERVICES', rate: 22 }).treatment,
    ).toMatchObject({ natura: 'N2.1' })
    expect(
      decideVatTreatment({ customer: { taxMode: 'EXTRA_EU', extraEuBusiness: false }, supply: 'SERVICES', rate: 22 }).treatment,
    ).toEqual({ kind: 'TAXABLE', rate: 22 })
    expect(() => decideVatTreatment({ customer: { taxMode: 'EXTRA_EU' }, supply: 'SERVICES', rate: 22 })).toThrow(
      /extraEuBusiness/,
    )
  })

  it('EU consumers: Italian VAT below the distance-sales threshold (UNVERIFIED), refused under OSS', () => {
    const result = decideVatTreatment({ customer: { taxMode: 'EU_B2C' }, supply: 'GOODS', rate: 22 })
    expect(result.treatment).toEqual({ kind: 'TAXABLE', rate: 22 })
    expect(result.unverified).toBe(true)
    expect(() =>
      decideVatTreatment(
        { customer: { taxMode: 'EU_B2C' }, supply: 'GOODS', rate: 22 },
        { ...DEFAULT_TAX_RULES_CONFIG, euConsumerGoodsVat: 'OSS' },
      ),
    ).toThrow(/OSS/)
    expect(decideVatTreatment({ customer: { taxMode: 'EU_B2C' }, supply: 'SERVICES', rate: 22 }).treatment).toEqual({
      kind: 'TAXABLE',
      rate: 22,
    })
  })

  it('a domestic reverse charge is a chosen N6.x code, never decided automatically', () => {
    expect(domesticReverseCharge('N6.1', 'Inversione contabile art. 74 c.7 DPR 633/1972')).toMatchObject({ natura: 'N6.1' })
    expect(() => domesticReverseCharge('N3.2', 'x')).toThrow(/reverse-charge/)
  })
})

describe('Natura codes and wording (FIN-099)', () => {
  it('DPR 633/1972 art. 21 c.6 — every wording fits RiferimentoNormativo (100 Latin-1 characters)', () => {
    for (const wording of Object.values(LEGAL_WORDING)) {
      expect(wording.length).toBeLessThanOrEqual(100)
      expect(/^[\x20-\x7e\xa0-\xff]+$/.test(wording)).toBe(true)
    }
  })

  it('lists only the detailed codes SDI accepts since 2021, each with its official description', () => {
    expect(NATURA_CODES).not.toContain('N2')
    expect(NATURA_CODES).not.toContain('N3')
    expect(NATURA_CODES).not.toContain('N6')
    expect(NATURA_CODES).toHaveLength(21)
    for (const code of NATURA_CODES) expect(NATURA_DESCRIPTIONS[code].length).toBeGreaterThan(0)
  })
})

describe('tax rules registry', () => {
  it('names a law for every rule and what the accountant must confirm for every UNVERIFIED one', () => {
    for (const [id, rule] of Object.entries(TAX_RULES)) {
      expect(rule.id).toBe(id)
      expect(rule.law.length).toBeGreaterThan(0)
      if (rule.status === 'UNVERIFIED') expect(rule.accountantToConfirm).toBeTruthy()
    }
    expect(unverifiedTaxRules().map((rule) => rule.id)).toContain('DEPOSIT_EU_B2B_GOODS')
  })

  it('checks a country against the tax mode', () => {
    expect(countryFitsTaxMode('IT_B2B', 'IT')).toBe(true)
    expect(countryFitsTaxMode('EU_B2B', 'DE')).toBe(true)
    expect(countryFitsTaxMode('EU_B2B', 'IT')).toBe(false)
    expect(countryFitsTaxMode('EU_B2B', 'CH')).toBe(false)
    expect(countryFitsTaxMode('EXTRA_EU', 'CH')).toBe(true)
    expect(countryFitsTaxMode('EXTRA_EU', 'FR')).toBe(false)
  })

  it('groups lines by rate and exigibility, or by Natura and wording', () => {
    expect(treatmentKey(taxable(22))).toBe(treatmentKey(taxable(22, 'I')))
    expect(treatmentKey(taxable(22))).not.toBe(treatmentKey(taxable(22, 'D')))
    expect(treatmentKey(taxable(22))).not.toBe(treatmentKey(taxable(10)))
  })
})
