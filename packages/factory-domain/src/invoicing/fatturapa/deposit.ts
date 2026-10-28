import type { DepositDeduction, FatturaPaDocument } from './types'

/**
 * The deduction of a deposit invoice on the final invoice (stage 15-invoice: TD24 from the DDT with the deposit
 * deducted). Takes the built TD02 and deducts all of it: per VAT treatment, its taxable amount and its VAT.
 */
export function depositDeductionFrom(deposit: FatturaPaDocument, description?: string): DepositDeduction {
  if (deposit.documentType !== 'TD02') {
    throw new Error(`a deposit deducted comes from a TD02, not a ${deposit.documentType}`)
  }
  return {
    invoiceNumber: deposit.number,
    invoiceDate: deposit.date,
    amounts: deposit.summary.map((row) => ({ vat: row.treatment, taxable: row.taxable, vatAmount: row.vat })),
    ...(description === undefined ? {} : { description }),
  }
}
