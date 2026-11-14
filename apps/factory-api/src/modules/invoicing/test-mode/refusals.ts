import { DomainError } from '@nexus/factory-domain/core/errors'
import { taxRefusal } from '../tax-codes/store'

/**
 * B-W2b-401's refusals in words (409 `refusal/<CODE>`, never a 500): its own codes, the partial uniques of its tables
 * (SelfInvoice_one_live, the copy's key, the settings row made twice at once) and, through B-W2b-392's `taxRefusal`, every
 * database `tax: …` / `invoicing: …` check of the …_tax_currency_w2b_guards.
 */

export const DEPTH_REFUSALS = [
  'DATABASE',
  'SWITCH_OFF',
  'GO_LIVE',
  'NOT_SELF_INVOICE',
  'SELF_INVOICE',
  'SELF_INVOICE_ISSUED',
  'NO_RATE',
  'DEBIT_NOTE',
  'COPY_FILES',
] as const
export type DepthRefusal = (typeof DEPTH_REFUSALS)[number]

/** A 409 with its code and words. */
export const refusedDepth = (code: DepthRefusal | string, message: string): DomainError => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

const causeOf = (error: unknown) => (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause

/** The database's refusal of a write of this step, in words; null for anything else. */
export function depthRefusal(error: unknown): DomainError | null {
  const cause = causeOf(error)
  const message = typeof cause?.originalMessage === 'string' ? cause.originalMessage : ''
  const target = String((error as { meta?: { target?: unknown } } | null)?.meta?.target ?? '')
  const code = (error as { code?: unknown } | null)?.code
  if (cause?.originalCode === '23505' || code === 'P2002') {
    if (/SelfInvoice_one_live/.test(message) || /SelfInvoice_one_live|supplierInvoiceId/.test(target)) return refusedDepth('SELF_INVOICE', 'This supplier invoice has its self-invoice already: open it, or cancel it first.')
    if (/SdiArchiveCopy/.test(message) || /SdiArchiveCopy|key/.test(target)) return refusedDepth('DATABASE', 'Our copy of this send was made at the same moment by another request: read it again.')
    if (/CompanyEInvoiceSettings/.test(message) || /CompanyEInvoiceSettings/.test(target)) return refusedDepth('DATABASE', "The company's e-invoicing settings were set at the same moment by another request: read them again.")
  }
  return taxRefusal(error)
}

/** Runs a write and turns the database's refusals of this step into 409s in words. */
export async function refusingDepth<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw depthRefusal(error) ?? error
  }
}
