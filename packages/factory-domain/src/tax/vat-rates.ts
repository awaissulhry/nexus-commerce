/**
 * Italian VAT rates (aliquote IVA) a line may carry when it is taxable.
 *
 *   22 — ordinary rate, DPR 633/1972 art. 16 c.1
 *   10 — reduced rate, DPR 633/1972 Tabella A parte III
 *    5 — reduced rate, DPR 633/1972 Tabella A parte II-bis
 *    4 — super-reduced rate, DPR 633/1972 Tabella A parte II
 *
 * A line that is not taxable carries no rate: it carries a Natura code instead (see natura.ts), and the FatturaPA
 * AliquotaIVA is then 0.00.
 */
export const ITALIAN_VAT_RATES = [22, 10, 5, 4] as const

export type ItalianVatRate = (typeof ITALIAN_VAT_RATES)[number]

/** The ordinary rate, the one leather garments and accessories carry. */
export const STANDARD_VAT_RATE: ItalianVatRate = 22

export function isItalianVatRate(value: unknown): value is ItalianVatRate {
  return (ITALIAN_VAT_RATES as readonly unknown[]).includes(value)
}
