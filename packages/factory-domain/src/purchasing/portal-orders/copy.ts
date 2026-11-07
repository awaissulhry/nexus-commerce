import type { ComposedDocument } from '../../documents/compose'
import type { ColumnKey } from '../../documents/layouts'
import type { DocumentLanguage } from '../../documents/model'

/**
 * The price-free copy of a purchase order (B-W2b-174; Owner answer C2 "no price on any supplier screen, a price-free PO copy,
 * price talk only in the PO's thread"; design portal.supplier.orders tab "PO PDF (as sent)" and the Documents tab), pure:
 * the order composed with the fixed PURCHASE_ORDER layout (its letterhead, parties, facts, lines in the supplier's terms
 * and dates), then every priced column (unit price, discount, VAT, amount) and the totals taken out, the description
 * widened by what they took, and a notice that says where the prices are. The caller composes it from rows read WITHOUT any
 * price (the partner's own scope, prices set to zero only to satisfy the composer): no price ever reaches this document,
 * and this step strips the zero columns so none is printed either.
 */

const PRICED: readonly ColumnKey[] = ['unitPrice', 'discount', 'vat', 'amount']

/** The layout id the copy names in its metadata (the PURCHASE_ORDER layout without its priced columns). */
export const PRICE_FREE_LAYOUT = 'PURCHASE_ORDER/1-NO-PRICES'

export const PRICE_FREE_WORDS: Readonly<Record<DocumentLanguage, { readonly title: string; readonly notice: string }>> = Object.freeze({
  it: {
    title: 'Ordine di acquisto - copia senza prezzi',
    notice: "Copia senza prezzi per il portale fornitori. L'ordine con i prezzi è quello inviato per e-mail; per i prezzi scriveteci nei messaggi dell'ordine.",
  },
  en: {
    title: 'Purchase order - copy without prices',
    notice: 'Copy without prices for the supplier portal. The order with its prices is the one we sent by e-mail; write to us in the order’s messages about prices.',
  },
})

export function priceFreeCopy(composed: ComposedDocument): ComposedDocument {
  if (composed.type !== 'PURCHASE_ORDER') throw new Error(`A price-free copy is of a purchase order, not of ${composed.type}.`)
  const kept = composed.table.columns.map((column, index) => ({ column, index })).filter(({ column }) => !PRICED.includes(column.key))
  const freed = 1000 - kept.reduce((sum, { column }) => sum + column.width, 0)
  const words = PRICE_FREE_WORDS[composed.language]
  return {
    ...composed,
    layout: PRICE_FREE_LAYOUT,
    title: words.title,
    table: {
      columns: kept.map(({ column }) => (column.key === 'description' ? { ...column, width: column.width + freed } : column)),
      rows: composed.table.rows.map((row) => kept.map(({ index }) => row[index] ?? '')),
    },
    totals: [],
    notices: [...composed.notices, words.notice],
    meta: { ...composed.meta, title: `${words.title} ${composed.identity[0]?.value ?? ''}`.trim(), subject: `${PRICE_FREE_LAYOUT} ${composed.language}` },
  }
}
