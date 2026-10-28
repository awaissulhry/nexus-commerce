import {
  DEFAULT_TAX_RULES_CONFIG,
  TAX_RULES,
  TaxRuleError,
  type TaxRuleId,
  type TaxRulesConfig,
} from './rules'
import type { CustomerTaxProfile, SupplyKind } from './vat-treatment'

/**
 * When a deposit (acconto) needs its own invoice, a TD02 (PLAN §2.8; stage 06b-deposit).
 *
 * DPR 633/1972 art. 6 c.4: when the price is paid, in whole or in part, before delivery, the supply is deemed made
 * for the amount paid on the day of payment, so an invoice is due for it. That is the rule for Italian customers.
 * For a business in another EU state buying goods, DL 331/1993 art. 39 times the intra-EU supply at the start of
 * transport; on our reading a deposit does not bring it forward, so no TD02 is issued. That reading is UNVERIFIED:
 * it is the setting euBusinessDepositNeedsInvoice, and the accountant confirms it in the sandbox review.
 *
 * Note for Italian consumers: a retailer under art. 22 may give a commercial receipt instead of an invoice; the
 * factory invoices, so a consumer's deposit is a TD02 too (VAT-inclusive, Codice del Consumo art. 51).
 */
export interface DepositDocumentDecision {
  /**
   * TD02 when the deposit needs an invoice. null when it does not: the deposit is then only a payment, and the final
   * invoice carries the whole price with no deposit deducted.
   */
  readonly documentType: 'TD02' | null
  readonly ruleId: TaxRuleId
  readonly law: string
  /** True when the rule is UNVERIFIED (accountant to confirm). */
  readonly unverified: boolean
  readonly reason: string
}

function decide(documentType: 'TD02' | null, ruleId: TaxRuleId, reason: string): DepositDocumentDecision {
  const rule = TAX_RULES[ruleId]
  return { documentType, ruleId, law: rule.law, unverified: rule.status === 'UNVERIFIED', reason }
}

export function depositDocumentFor(
  customer: CustomerTaxProfile,
  supply: SupplyKind = 'GOODS',
  config: TaxRulesConfig = DEFAULT_TAX_RULES_CONFIG,
): DepositDocumentDecision {
  switch (customer.taxMode) {
    case 'IT_B2B':
      return decide('TD02', 'DEPOSIT_INVOICE_IT', 'Italian business: the deposit is invoiced on the day it is paid.')
    case 'IT_B2C':
      return decide('TD02', 'DEPOSIT_INVOICE_IT', 'Italian consumer: the deposit is invoiced on the day it is paid.')
    case 'EU_B2B':
      if (customer.viesValid !== true) {
        // Without a valid VIES number the sale is not an intra-EU supply (art. 41): Italian VAT and art. 6 c.4 apply.
        return decide(
          'TD02',
          'DEPOSIT_INVOICE_IT',
          'EU business without a valid VIES check: the sale carries Italian VAT, so the deposit is invoiced like an Italian one.',
        )
      }
      if (supply === 'SERVICES') {
        return decide('TD02', 'DEPOSIT_EU_B2B_SERVICES', 'EU business, service: invoiced at payment for the amount paid.')
      }
      return config.euBusinessDepositNeedsInvoice
        ? decide('TD02', 'DEPOSIT_EU_B2B_GOODS', 'EU business, goods: configured to invoice the deposit.')
        : decide(null, 'DEPOSIT_EU_B2B_GOODS', 'EU business, goods: the supply happens when transport starts; no TD02.')
    case 'EU_B2C':
      if (supply === 'GOODS' && config.euConsumerGoodsVat === 'OSS') {
        throw new TaxRuleError(
          'OSS_NOT_BUILT',
          'Deposits from EU consumers under OSS are not built; the accountant decides these sales.',
          'EU_B2C_GOODS_ITALIAN_VAT',
        )
      }
      return decide('TD02', 'DEPOSIT_EU_B2C', 'EU consumer with Italian VAT: the deposit is invoiced on the day it is paid.')
    case 'EXTRA_EU':
      return decide('TD02', 'DEPOSIT_EXPORT', 'Customer outside the EU: the deposit is invoiced at payment.')
  }
}
