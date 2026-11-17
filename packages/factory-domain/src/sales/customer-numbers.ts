/**
 * Each customer's own running number, in words (B-TH-105; Owner decision PR-06, planned as the lead's pick A; factory-db
 * customerSeq on Inquiry, Quote and SalesOrder, B-TH-104), pure: "Your request 7", "Your quote 3", "Your order 12" beside the
 * office number, so a customer reads its own count and never the shared series' (plan §0.5). Fiscal numbers (invoices, DDTs)
 * are never renumbered. Null: the record has no number of its own yet (a row made before the number was given, never shown).
 */

export const CUSTOMER_NUMBER_KINDS = ['REQUEST', 'QUOTE', 'ORDER'] as const
export type CustomerNumberKind = (typeof CUSTOMER_NUMBER_KINDS)[number]

const WORDS: Readonly<Record<CustomerNumberKind, { readonly en: string; readonly it: string }>> = Object.freeze({
  REQUEST: { en: 'Your request', it: 'La vostra richiesta' },
  QUOTE: { en: 'Your quote', it: 'Il vostro preventivo' },
  ORDER: { en: 'Your order', it: 'Il vostro ordine' },
})

export interface CustomerNumber {
  readonly seq: number
  readonly words: { readonly en: string; readonly it: string }
}

/** The customer's own number of a record and its words in both languages, or null. */
export function customerNumberOf(kind: CustomerNumberKind, seq: number | null | undefined): CustomerNumber | null {
  if (seq === null || seq === undefined || !Number.isInteger(seq) || seq < 1) return null
  return { seq, words: { en: `${WORDS[kind].en} ${seq}`, it: `${WORDS[kind].it} ${seq}` } }
}
