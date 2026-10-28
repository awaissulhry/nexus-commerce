import { isEuMemberState } from './eu'
import { isReverseCharge, type NaturaCode } from './natura'
import { DEFAULT_TAX_RULES_CONFIG, TAX_RULES, TaxRuleError, type TaxRuleId, type TaxRulesConfig } from './rules'
import type { ItalianVatRate } from './vat-rates'

/**
 * The customer's tax position, as the Party record holds it (A1 §2.4: Party.taxMode, viesValid).
 *
 *   IT_B2B   — Italian business (Partita IVA)
 *   IT_B2C   — Italian consumer, or an Italian body with a codice fiscale only
 *   EU_B2B   — business in another EU state
 *   EU_B2C   — consumer in another EU state
 *   EXTRA_EU — customer outside the EU (extraEuBusiness says whether it is a business)
 */
export type CustomerTaxMode = 'IT_B2B' | 'IT_B2C' | 'EU_B2B' | 'EU_B2C' | 'EXTRA_EU'

export interface CustomerTaxProfile {
  readonly taxMode: CustomerTaxMode
  /** EU_B2B: true only after a VIES check found the VAT number valid (DL 331/1993 art. 41; proof kept by B-W1-07). */
  readonly viesValid?: boolean
  /** EXTRA_EU: whether the customer is a business. Needed for services (art. 7-ter); goods do not depend on it. */
  readonly extraEuBusiness?: boolean
}

export type SupplyKind = 'GOODS' | 'SERVICES'

/** I = immediate VAT (the default), D = deferred VAT (art. 6 c.5). Split payment (S) is for public bodies: not built. */
export type VatExigibility = 'I' | 'D'

/** How one invoice line is taxed: an Italian rate, or a Natura code with the law that justifies it. */
export type VatTreatment =
  | { readonly kind: 'TAXABLE'; readonly rate: ItalianVatRate; readonly exigibility?: VatExigibility }
  | { readonly kind: 'NON_TAXABLE'; readonly natura: NaturaCode; readonly legalReference: string }

export function taxable(rate: ItalianVatRate, exigibility?: VatExigibility): VatTreatment {
  return exigibility === undefined ? { kind: 'TAXABLE', rate } : { kind: 'TAXABLE', rate, exigibility }
}

export function nonTaxable(natura: NaturaCode, legalReference: string): VatTreatment {
  return { kind: 'NON_TAXABLE', natura, legalReference }
}

/**
 * The legal wording (RiferimentoNormativo, at most 100 characters) for each treatment this module decides
 * (DPR 633/1972 art. 21 c.6 and c.6-bis: the invoice states why no VAT is charged and under which law).
 */
export const LEGAL_WORDING = {
  INTRA_EU_SUPPLY: 'Operazione non imponibile art. 41 c.1 lett. a) DL 331/1993 - cessione intracomunitaria',
  EXPORT: 'Operazione non imponibile art. 8 c.1 lett. a) DPR 633/1972 - esportazione',
  EU_B2B_SERVICES: 'Operazione non soggetta art. 7-ter DPR 633/1972 - inversione contabile',
  EXTRA_EU_SERVICES: 'Operazione non soggetta art. 7-ter DPR 633/1972',
} as const

/**
 * A domestic reverse charge (inversione contabile, DPR 633/1972 art. 17 c.5-6 and art. 74 c.7-8). None applies to
 * the factory's own goods, so decideVatTreatment never returns one; this is for the rare sale that does (scrap, for
 * instance), chosen by a person with the accountant, with the article that applies.
 */
export function domesticReverseCharge(natura: NaturaCode, legalReference: string): VatTreatment {
  if (!isReverseCharge(natura)) {
    throw new TaxRuleError('NOT_REVERSE_CHARGE', `${natura} is not a reverse-charge (N6.x) code`)
  }
  return nonTaxable(natura, legalReference)
}

export interface VatDecisionInput {
  readonly customer: CustomerTaxProfile
  readonly supply: SupplyKind
  /** The Italian rate of the item when it is taxed in Italy (22 for garments). */
  readonly rate: ItalianVatRate
  /**
   * EXTRA_EU goods: true when the goods are shipped out of the EU by or for the seller (an export); false when they
   * are handed over in Italy. Required for EXTRA_EU goods.
   */
  readonly goodsLeaveEu?: boolean
}

export interface VatDecision {
  readonly treatment: VatTreatment
  readonly ruleId: TaxRuleId
  readonly law: string
  /** True when the rule is UNVERIFIED (accountant to confirm). */
  readonly unverified: boolean
}

function decision(treatment: VatTreatment, ruleId: TaxRuleId): VatDecision {
  const rule = TAX_RULES[ruleId]
  return { treatment, ruleId, law: rule.law, unverified: rule.status === 'UNVERIFIED' }
}

/**
 * Decides how a line is taxed from the customer's tax position and what is sold (FIN-098: VAT per line by customer
 * type; FIN-099: Natura code and wording on zero-VAT lines). Pure; throws TaxRuleError when it lacks a fact it needs
 * or the case is not built.
 */
export function decideVatTreatment(
  input: VatDecisionInput,
  config: TaxRulesConfig = DEFAULT_TAX_RULES_CONFIG,
): VatDecision {
  const { customer, supply, rate } = input
  switch (customer.taxMode) {
    case 'IT_B2B':
    case 'IT_B2C':
      return decision(taxable(rate), 'IT_DOMESTIC_SUPPLY')

    case 'EU_B2B':
      if (supply === 'GOODS') {
        // DL 331/1993 art. 41: the zero rate needs the buyer's valid VIES registration; without it, Italian VAT.
        return customer.viesValid === true
          ? decision(nonTaxable('N3.2', LEGAL_WORDING.INTRA_EU_SUPPLY), 'INTRA_EU_SUPPLY_OF_GOODS')
          : decision(taxable(rate), 'INTRA_EU_SUPPLY_OF_GOODS')
      }
      return customer.viesValid === true
        ? decision(nonTaxable('N2.1', LEGAL_WORDING.EU_B2B_SERVICES), 'EU_B2B_SERVICES')
        : decision(taxable(rate), 'EU_B2B_SERVICES')

    case 'EU_B2C':
      if (supply === 'SERVICES') return decision(taxable(rate), 'EU_B2C_SERVICES')
      if (config.euConsumerGoodsVat === 'OSS') {
        throw new TaxRuleError(
          'OSS_NOT_BUILT',
          'Goods to an EU consumer under OSS (destination VAT) are not built; the accountant decides these sales.',
          'EU_B2C_GOODS_ITALIAN_VAT',
        )
      }
      return decision(taxable(rate), 'EU_B2C_GOODS_ITALIAN_VAT')

    case 'EXTRA_EU':
      if (supply === 'GOODS') {
        if (input.goodsLeaveEu === undefined) {
          throw new TaxRuleError(
            'GOODS_LEAVE_EU_REQUIRED',
            'A sale of goods to a customer outside the EU needs goodsLeaveEu: an export is non-taxable, goods handed over in Italy are not.',
            'EXPORT_OF_GOODS',
          )
        }
        return input.goodsLeaveEu
          ? decision(nonTaxable('N3.1', LEGAL_WORDING.EXPORT), 'EXPORT_OF_GOODS')
          : decision(taxable(rate), 'EXPORT_OF_GOODS')
      }
      if (customer.extraEuBusiness === undefined) {
        throw new TaxRuleError(
          'EXTRA_EU_BUSINESS_REQUIRED',
          'A service to a customer outside the EU needs extraEuBusiness: business customers are out of scope, consumers pay Italian VAT.',
          'EXTRA_EU_SERVICES',
        )
      }
      return customer.extraEuBusiness
        ? decision(nonTaxable('N2.1', LEGAL_WORDING.EXTRA_EU_SERVICES), 'EXTRA_EU_SERVICES')
        : decision(taxable(rate), 'EXTRA_EU_SERVICES')
  }
}

/** Whether a country code fits the tax mode (an EU mode needs an EU state other than Italy, and so on). */
export function countryFitsTaxMode(taxMode: CustomerTaxMode, country: string): boolean {
  if (taxMode === 'IT_B2B' || taxMode === 'IT_B2C') return country === 'IT'
  if (taxMode === 'EU_B2B' || taxMode === 'EU_B2C') return country !== 'IT' && isEuMemberState(country)
  return !isEuMemberState(country)
}

/** A stable key for grouping lines by treatment (one VAT summary row per key). */
export function treatmentKey(treatment: VatTreatment): string {
  return treatment.kind === 'TAXABLE'
    ? `T|${String(treatment.rate).padStart(3, '0')}|${treatment.exigibility ?? 'I'}`
    : `N|${treatment.natura}|${treatment.legalReference}`
}
