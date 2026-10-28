import type { NaturaCode } from './natura'

/**
 * Every tax rule this module applies, by id, with its law and whether it is settled.
 *
 * VERIFIED   — read from the primary law or the official FatturaPA / SDI technical rules.
 * UNVERIFIED — our reading, not yet confirmed: the accountant confirms it in the SDI provider's sandbox review before
 *              go-live (PLAN §2.8, R-22). Each UNVERIFIED rule that changes an outcome is a setting in
 *              TaxRulesConfig, so the accountant's answer is a configuration change, not a code change.
 */
export type TaxRuleStatus = 'VERIFIED' | 'UNVERIFIED'

export interface TaxRule {
  readonly id: string
  readonly law: string
  readonly summary: string
  readonly status: TaxRuleStatus
  /** Present on every UNVERIFIED rule: what the accountant must confirm. */
  readonly accountantToConfirm?: string
}

export const TAX_RULES = {
  IT_DOMESTIC_SUPPLY: {
    id: 'IT_DOMESTIC_SUPPLY',
    law: 'DPR 633/1972 artt. 1, 7-bis, 7-ter, 16',
    summary: 'A supply to an Italian customer, business or consumer, carries Italian VAT at the item rate.',
    status: 'VERIFIED',
  },
  INTRA_EU_SUPPLY_OF_GOODS: {
    id: 'INTRA_EU_SUPPLY_OF_GOODS',
    law: 'DL 331/1993 art. 41',
    summary:
      'Goods sent to a business in another EU state with a valid VIES VAT number are non-taxable (N3.2). Without a valid VIES check the zero rate does not apply and Italian VAT is charged.',
    status: 'VERIFIED',
  },
  EU_B2B_SERVICES: {
    id: 'EU_B2B_SERVICES',
    law: 'DPR 633/1972 art. 7-ter; art. 21 c.6-bis lett. a)',
    summary:
      'Services to a business in another EU state are outside the scope of Italian VAT (N2.1); the invoice says "inversione contabile".',
    status: 'VERIFIED',
  },
  EU_B2C_GOODS_ITALIAN_VAT: {
    id: 'EU_B2C_GOODS_ITALIAN_VAT',
    law: 'DL 331/1993 art. 40 c.4-bis; Dir. 2006/112/CE art. 59-quater',
    summary:
      'Goods sent to a consumer in another EU state carry Italian VAT while the seller stays under the EU-wide 10,000 euro distance-sales threshold; above it, destination VAT through OSS (not built).',
    status: 'UNVERIFIED',
    accountantToConfirm:
      'that each company stays under the 10,000 euro threshold (setting euConsumerGoodsVat), and the article and paragraph cited.',
  },
  EU_B2C_SERVICES: {
    id: 'EU_B2C_SERVICES',
    law: 'DPR 633/1972 art. 7-ter c.1 lett. b)',
    summary: 'Services to a consumer in another EU state carry Italian VAT (general rule).',
    status: 'VERIFIED',
  },
  EXPORT_OF_GOODS: {
    id: 'EXPORT_OF_GOODS',
    law: 'DPR 633/1972 art. 8 c.1 lett. a)',
    summary:
      'Goods shipped out of the EU by or for the seller are non-taxable exports (N3.1). Goods handed over in Italy carry Italian VAT.',
    status: 'VERIFIED',
  },
  EXTRA_EU_SERVICES: {
    id: 'EXTRA_EU_SERVICES',
    law: 'DPR 633/1972 art. 7-ter; art. 21 c.6-bis lett. b)',
    summary:
      'Services to a business outside the EU are outside the scope of Italian VAT (N2.1); services to a consumer outside the EU carry Italian VAT (general rule).',
    status: 'VERIFIED',
  },
  DEPOSIT_INVOICE_IT: {
    id: 'DEPOSIT_INVOICE_IT',
    law: 'DPR 633/1972 art. 6 c.4',
    summary:
      'A deposit (acconto) paid before delivery makes the supply happen for the amount paid on the day it is paid: an invoice (TD02) is due for it.',
    status: 'VERIFIED',
  },
  DEPOSIT_EU_B2B_GOODS: {
    id: 'DEPOSIT_EU_B2B_GOODS',
    law: 'DL 331/1993 art. 39',
    summary:
      'An intra-EU supply of goods happens when transport starts; a deposit paid before that does not, on our reading, bring it forward, so no TD02 is issued for an EU business deposit.',
    status: 'UNVERIFIED',
    accountantToConfirm:
      'that a deposit from an EU business (valid VIES) for goods needs no TD02 (setting euBusinessDepositNeedsInvoice).',
  },
  DEPOSIT_EU_B2B_SERVICES: {
    id: 'DEPOSIT_EU_B2B_SERVICES',
    law: 'DPR 633/1972 art. 6 c.6',
    summary:
      'A B2B service under art. 7-ter happens when it is completed, or earlier when it is paid, for the amount paid: a deposit for a service to an EU business needs a TD02 (N2.1).',
    status: 'UNVERIFIED',
    accountantToConfirm: 'that a deposit for a service to an EU business is invoiced at payment (TD02, N2.1).',
  },
  DEPOSIT_EU_B2C: {
    id: 'DEPOSIT_EU_B2C',
    law: 'DPR 633/1972 art. 6 c.4',
    summary:
      'A deposit from an EU consumer, while Italian VAT applies (below the distance-sales threshold), is invoiced like an Italian one (TD02).',
    status: 'UNVERIFIED',
    accountantToConfirm: 'the distance-sales treatment of EU consumers (see EU_B2C_GOODS_ITALIAN_VAT).',
  },
  DEPOSIT_EXPORT: {
    id: 'DEPOSIT_EXPORT',
    law: 'DPR 633/1972 art. 6 c.4; art. 8 c.1 lett. a)',
    summary:
      'A deposit from a customer outside the EU is invoiced at payment (TD02) with the treatment of the goods it pays for (N3.1 when they will be exported).',
    status: 'UNVERIFIED',
    accountantToConfirm: 'that a deposit on an export is a TD02 non-taxable under art. 8 (N3.1).',
  },
  DEFERRED_INVOICE_FROM_DDT: {
    id: 'DEFERRED_INVOICE_FROM_DDT',
    law: 'DPR 633/1972 art. 21 c.4 terzo periodo lett. a); DPR 472/1996',
    summary:
      'Goods that travel with a DDT may be invoiced later (TD24), by the 15th of the month after delivery, one invoice for the DDTs of one calendar month, naming each DDT by number and date.',
    status: 'VERIFIED',
  },
  CREDIT_NOTE: {
    id: 'CREDIT_NOTE',
    law: 'DPR 633/1972 art. 26',
    summary: 'A correction of an issued invoice is a credit note (TD04) that names the invoice it corrects.',
    status: 'VERIFIED',
  },
  STAMP_DUTY: {
    id: 'STAMP_DUTY',
    law: 'DPR 642/1972 Tariffa parte I art. 13 (exemptions: Tabella, allegato B); DM 17.6.2014 art. 6',
    summary:
      'An invoice whose amounts without VAT exceed 77.47 euro carries 2.00 euro stamp duty, paid virtually; exports and intra-EU supplies are exempt.',
    status: 'UNVERIFIED',
    accountantToConfirm:
      'which Natura codes are exempt from stamp duty (setting stampDuty.exemptNatura; now N3.1, N3.2 and the N6 reverse-charge codes).',
  },
  CONSUMER_VAT_INCLUSIVE_PRICE: {
    id: 'CONSUMER_VAT_INCLUSIVE_PRICE',
    law: 'D.Lgs. 206/2005 (Codice del Consumo) artt. 49, 51',
    summary:
      'A consumer sees the total price including VAT before accepting; the invoice total is that same VAT-inclusive amount.',
    status: 'VERIFIED',
  },
} as const satisfies Record<string, TaxRule>

export type TaxRuleId = keyof typeof TAX_RULES

/** The rules still waiting for the accountant, for a review list or a "test mode" banner. */
export function unverifiedTaxRules(): readonly TaxRule[] {
  return Object.values(TAX_RULES).filter((rule) => rule.status === 'UNVERIFIED')
}

/** Settings for the rules the accountant has to confirm. DEFAULT_TAX_RULES_CONFIG holds our current reading. */
export interface TaxRulesConfig {
  /**
   * DEPOSIT_EU_B2B_GOODS (DL 331/1993 art. 39, UNVERIFIED). false: a deposit from an EU business with a valid VIES
   * number, for goods, needs no TD02; true: it does, like an Italian one.
   */
  readonly euBusinessDepositNeedsInvoice: boolean
  /**
   * EU_B2C_GOODS_ITALIAN_VAT (UNVERIFIED). ITALIAN_VAT: below the EU distance-sales threshold. OSS: destination VAT
   * through the One-Stop Shop, which is not built; a decision under OSS is refused.
   */
  readonly euConsumerGoodsVat: 'ITALIAN_VAT' | 'OSS'
  /** STAMP_DUTY (UNVERIFIED for exemptNatura). Amounts are decimal strings. */
  readonly stampDuty: {
    /** Stamp duty is due when the amount without VAT is strictly above this. */
    readonly threshold: string
    readonly amount: string
    /** Natura codes whose amounts do not count towards the threshold. */
    readonly exemptNatura: readonly NaturaCode[]
  }
}

export const DEFAULT_TAX_RULES_CONFIG: TaxRulesConfig = {
  euBusinessDepositNeedsInvoice: false,
  euConsumerGoodsVat: 'ITALIAN_VAT',
  stampDuty: {
    threshold: '77.47',
    amount: '2.00',
    exemptNatura: ['N3.1', 'N3.2', 'N6.1', 'N6.2', 'N6.3', 'N6.4', 'N6.5', 'N6.6', 'N6.7', 'N6.8', 'N6.9'],
  },
}

/** A decision this module refuses to make, with the rule that refused it. */
export class TaxRuleError extends Error {
  readonly code: string
  readonly ruleId: TaxRuleId | null

  constructor(code: string, message: string, ruleId: TaxRuleId | null = null) {
    super(message)
    this.name = 'TaxRuleError'
    this.code = code
    this.ruleId = ruleId
  }
}
