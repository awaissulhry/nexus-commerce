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

// ---- B-TH-105 follow-up (threads plan §0.5, "counts do not leak"; th2-backend step 7) ------------------------------------------

/**
 * The customer's own reference of a record where one short, language-free text is needed — a notice's record chip, the portal
 * search's "ours", a portal thread's header: "#7". Never the office's series (INQ-…, QT-…, SO-…): a customer reads only its own
 * count. Null when the record has no number of its own yet.
 */
export function customerRefOf(kind: CustomerNumberKind, seq: number | null | undefined): string | null {
  const own = customerNumberOf(kind, seq)
  return own ? `#${own.seq}` : null
}
