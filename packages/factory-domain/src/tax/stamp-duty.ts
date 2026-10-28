import { Dec, sum, ZERO, type Decimal } from './decimal'
import { DEFAULT_TAX_RULES_CONFIG, type TaxRulesConfig } from './rules'
import type { VatTreatment } from './vat-treatment'

export interface StampDutyDecision {
  readonly due: boolean
  /** 2.00 when due, else null. */
  readonly amount: Decimal | null
  /** The amount without VAT that counts towards the threshold. */
  readonly base: Decimal
}

/**
 * Stamp duty (imposta di bollo) on an invoice: 2.00 euro, paid virtually, when its amounts without VAT exceed 77.47
 * euro (rule STAMP_DUTY; which Natura codes are exempt is UNVERIFIED and a setting). Taxable lines never count.
 */
export function stampDutyFor(
  summary: readonly { readonly treatment: VatTreatment; readonly taxable: Decimal }[],
  config: TaxRulesConfig = DEFAULT_TAX_RULES_CONFIG,
): StampDutyDecision {
  const rule = config.stampDuty
  const base = sum(
    summary
      .filter((row) => row.treatment.kind === 'NON_TAXABLE' && !rule.exemptNatura.includes(row.treatment.natura))
      .map((row) => row.taxable),
  )
  const due = base.gt(new Dec(rule.threshold))
  return { due, amount: due ? new Dec(rule.amount) : null, base: base.lt(ZERO) ? ZERO : base }
}
