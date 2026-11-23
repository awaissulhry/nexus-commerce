import { describe, expect, it } from 'vitest'
import { CATALOGUE } from './messages'
import { LOCALES } from './locales'

/**
 * B-TH-215 (threads plan TH-1b, PR-22; design kit §5 "one word per thing"): a note only the office reads is an "Office note" —
 * "Nota d'ufficio" — in every factory catalogue (pictures 2 and 3). The old words "Internal note" / "Nota interna" (and their
 * plurals) are gone everywhere. B-TH-280: the old record panels went; the record thread's box and card carry the word.
 */

const OLD: Readonly<Record<(typeof LOCALES)[number], RegExp>> = {
  en: /\binternal notes?\b/i,
  it: /\bnot[ae] intern[ae]\b/i,
}

const NEW: Readonly<Record<(typeof LOCALES)[number], string>> = { en: 'Office note', it: "Nota d'ufficio" }
const PLURAL: Readonly<Record<(typeof LOCALES)[number], string>> = { en: 'office notes', it: "note d'ufficio" }

describe('one word for a note only the office reads (B-TH-215)', () => {
  for (const locale of LOCALES) {
    it(`${locale}: no catalogue line says the old word`, () => {
      const found = Object.entries(CATALOGUE[locale]).flatMap(([namespace, dictionary]) =>
        Object.entries(dictionary)
          .filter(([, text]) => OLD[locale].test(text))
          .map(([key, text]) => `${namespace}:${key} = ${text}`),
      )
      expect(found).toEqual([])
    })

    it(`${locale}: the record thread, the permission and the new order say "${NEW[locale]}"`, () => {
      expect(CATALOGUE[locale]['record-thread-composer']['mode.note']).toBe(NEW[locale])
      expect(CATALOGUE[locale]['record-thread-card']['mark.note']).toContain(NEW[locale])
      expect(CATALOGUE[locale].orders['newOrder.note']).toBe(NEW[locale])
      expect(CATALOGUE[locale].admin['perm.threads_post']).toContain(PLURAL[locale])
    })
  }
})

// ---- cq T (customer page › Quotes & incoming; the lead's decision on W2): ONE word for a quote in Italian — "preventivo". A line whose
// English says "quote" never calls it "offerta" in Italian. Kept on purpose: a supplier's offer (a tannery's, a supplier quote on a
// shipment) and the sizes "no longer offered" inside a quote's lines. The firm offer ("Offerta ferma / irrevocabile") and the offer a
// quote stands as ("The offer", "Offer ended") are the English "offer", not the record's name.
describe('one word for a quote in Italian: preventivo (cq T)', () => {
  const KEPT = new Set(['library:materials.cost.reasonHint', 'shipments:ref.SUPPLIER_QUOTE', 'sales-inquiries:catalogue.acceptQuoteHint'])
  it('no Italian line says "offerta" where its English says quote', () => {
    const found = Object.entries(CATALOGUE.it).flatMap(([namespace, dictionary]) =>
      Object.entries(dictionary)
        .filter(([key, text]) => /offert[ae]\b/i.test(text) && /\bquot/i.test(CATALOGUE.en[namespace]?.[key] ?? '') && !KEPT.has(`${namespace}:${key}`))
        .map(([key, text]) => `${namespace}:${key} = ${text}`),
    )
    expect(found).toEqual([])
  })
  it('the portal order accepted as a quote says it in the same word as its button', () => {
    const words = CATALOGUE.it['sales-inquiries']!
    expect(words['catalogue.acceptQuote']).toBe('Accetta come preventivo')
    expect(words['catalogue.outcome.quote']).toBe('Accettato come preventivo {made}')
    expect(words['catalogue.done.quote']).toBe('{number} è diventato il preventivo {made}')
  })
})
// ---- end cq T
