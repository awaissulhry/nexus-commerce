import type { ComposedDocument } from '../../documents/compose'
import type { DocumentLanguage } from '../../documents/model'
import { developmentWords, type DevelopmentFacts } from './rules'

/**
 * The sample order PDF (B-W2b-347; SCM-043; design purchasing.sourcing tab "Sample order PDF — the document sent to the
 * supplier"), pure: the order composed with the fixed PURCHASE_ORDER layout (its letterhead, the supplier, the delivery, the
 * lines with their prices and the total: still the commercial document the supplier is mailed), then titled a sample order,
 * with what it is for among the facts ("For the development of: GIA-DEMO-01 Giacca Demo · Proto, round 1 (SR-…)") and a
 * notice that these are samples for development, not a production order. The same input gives the same document (the PDF's
 * bytes are fixed by it), as every composed document; the price-free portal copy (portal-orders/copy.ts) is not changed here.
 */

/** The layout id the sample order names in its metadata and its stored file's details. */
export const SAMPLE_ORDER_LAYOUT = 'PURCHASE_ORDER/1-SAMPLE'

export const SAMPLE_ORDER_WORDS: Readonly<Record<DocumentLanguage, { readonly title: string; readonly forLabel: string; readonly notice: string }>> = Object.freeze({
  it: {
    title: 'Ordine di campionatura',
    forLabel: 'Per lo sviluppo di',
    notice: 'Campionatura per lo sviluppo del prodotto: non è un ordine di produzione.',
  },
  en: {
    title: 'Sample order',
    forLabel: 'For the development of',
    notice: 'Samples for product development: this is not a production order.',
  },
})

/** A composed purchase order as the sample order the supplier gets; any other document is returned as it is. */
export function sampleOrderDocument(composed: ComposedDocument, development: DevelopmentFacts | null | undefined): ComposedDocument {
  if (!development) return composed
  if (composed.type !== 'PURCHASE_ORDER') throw new Error(`A sample order is a purchase order, not a ${composed.type}.`)
  const words = SAMPLE_ORDER_WORDS[composed.language]
  const number = composed.identity[0]?.value ?? ''
  const what = developmentWords(development, composed.language)
  return {
    ...composed,
    layout: SAMPLE_ORDER_LAYOUT,
    title: words.title,
    facts: what === '' ? composed.facts : [{ label: words.forLabel, value: what }, ...composed.facts],
    notices: [...composed.notices, words.notice],
    meta: { ...composed.meta, title: `${words.title} ${number}`.trim(), subject: `${SAMPLE_ORDER_LAYOUT} ${composed.language}`, keywords: `SAMPLE ${composed.meta.keywords}` },
  }
}
