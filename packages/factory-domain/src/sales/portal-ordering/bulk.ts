/**
 * Many drafts at once (owb- order workflow, S1 po2.1; design § 5h, § 5b): delete the drafts, send many. One command per item; the
 * answer says, per item, done or refused in words (EN + IT, the portal's "voi"). Pure: the limit and the common words.
 */

export const BULK_MAX = 50

export interface BulkWords {
  readonly en: string
  readonly it: string
}

export const BULK_WORDS = Object.freeze({
  TOO_MANY: { en: `Choose 1 to ${BULK_MAX} orders at once.`, it: `Scegliete da 1 a ${BULK_MAX} ordini alla volta.` },
  TWICE: { en: 'Each order once.', it: 'Ogni ordine una volta sola.' },
  NOT_FOUND: { en: 'Order not found.', it: 'Ordine non trovato.' },
  FORBIDDEN: { en: 'You may not do this with this order.', it: 'Non potete farlo con questo ordine.' },
  STALE: { en: 'This order changed since you read it: read it again.', it: 'Questo ordine è cambiato da quando l’avete letto: rileggetelo.' },
} as const satisfies Record<string, BulkWords>)
