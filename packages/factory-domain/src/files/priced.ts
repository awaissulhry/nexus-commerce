import { heldGrains } from '../auth/grains/grains'
import { DomainError } from '../core/errors'
import type { Actor } from '../core/permissions'

/**
 * B-CP-014 (customer page plan, the money wall: design 11 D6, leaks L1, L2 and L6; review B1): priced files, pure. A file that
 * shows our prices — an order confirmation, a quote, an invoice copy and its FatturaPA XML, a proforma, a commercial invoice, a
 * CN22 or CN23, a price list, a reminder letter, a statement, a shipment pack with a priced part, the customer's own PO — is
 * StoredFile.priced (factory-db files.prisma; B-CP-005 made the flag and marked the old ones). It is born priced with its
 * document (documents/model pricedDocument, B-CP-015), ticked at upload ("This file shows prices"), or marked later by anyone
 * who reaches its record; only someone who sees prices takes the mark off. Copies and new versions carry it.
 *
 * Who opens one: someone who SEES PRICES — the session's price grain, capped by its audience (auth/grains heldGrains): an office
 * person whose role sees prices (the Owner and the people he names), a portal or link session through its own capped grain (the
 * brand's Buyer, Finance and Admin; a quote link opens its own quote), the system for its own work; never the floor. For
 * everyone else the file is not found by id (404, as a wrong id: the file, its download, preview, versions, history and every
 * change by id), a record's list shows it LOCKED (`locked: PRICED`, counted, no name, no checksum: "Priced document — you
 * cannot open it"), and every attach or link path refuses its id — modelled on the measurement-sheet lock (./measurements.ts)
 * and the shipment pack's priced parts (shipping/shipment-pack/rules mayHave).
 *
 * Making or mailing a priced document is for someone who sees prices too (Owner pick O1, "Sales cannot send priced PDFs"):
 * `pricedDocumentHeld` is the 403 in words, never a hint of the amount.
 */

/** The lock a record's list shows on a priced file the reader may not open. */
export const PRICED_LOCK = 'PRICED' as const
export type PricedLock = typeof PRICED_LOCK

/** The caller sees prices: the price grain of its session, capped by its audience (the floor never; the system always). */
export const seesPrices = (actor: Actor | null | undefined): boolean => heldGrains(actor).has('price')

/** A file the caller may open as far as prices go (the shipment pack's `mayHave`): it sees prices, or the file shows none. */
export const mayOpenPriced = (file: { readonly priced?: boolean | null }, sees: boolean): boolean => sees || file.priced !== true

/** The words, it + en (the web's catalogue words: record-files.json `priced.*`, orders.json `pricedPdf.*`). */
export const PRICED_WORDS = Object.freeze({
  /** A locked file in a list or on a message. */
  locked: { it: 'Documento con prezzi — non puoi aprirlo', en: 'Priced document — you cannot open it' },
  /** The upload's tick, and what it does. */
  tick: { it: 'Questo file mostra dei prezzi', en: 'This file shows prices' },
  tickHint: { it: 'Poi lo aprono solo le persone che vedono i prezzi.', en: 'Then only people who see prices open it.' },
  /** Taking the mark off opens the file to everyone who reaches its record. */
  unmark: { it: 'Solo chi vede i prezzi toglie a un file il segno «mostra dei prezzi».', en: 'Only people who see prices take the "shows prices" mark off a file.' },
  /** A priced file never goes to a floor. */
  floor: { it: 'Un documento con prezzi non si condivide mai con un reparto: il reparto non vede prezzi.', en: 'A priced document is never shared with a floor: the floor sees no prices.' },
  /** A share link of a priced file. */
  byLink: { it: 'Un documento con prezzi va con un link solo da chi vede i prezzi.', en: 'A priced document goes by link only from someone who sees prices.' },
  /** Making, mailing or opening a priced document (orders.json pricedPdf.held is the mailing's). */
  make: { it: 'Mostra dei prezzi: lo prepara chi vede i prezzi.', en: 'It shows prices: it is made by someone who sees prices.' },
  send: { it: 'Mostra dei prezzi: lo invia chi vede i prezzi.', en: 'It shows prices: it is sent by someone who sees prices.' },
  open: { it: 'Mostra dei prezzi: lo apre chi vede i prezzi.', en: 'It shows prices: it is opened by someone who sees prices.' },
})

/** The refusal codes (issue `refusal/<CODE>`). */
export const PRICED_REFUSALS = Object.freeze({ HELD: 'PRICED_DOCUMENT', UNMARK: 'PRICED_UNMARK', LINK: 'PRICED_BY_LINK' })

/** Why a priced file cannot be shared this way, in the office's words (null: it can). Never with a floor. */
export function pricedFileProblem(file: { readonly priced?: boolean | null; readonly visibility: readonly string[] }): string | null {
  return file.priced === true && file.visibility.includes('FLOOR') ? PRICED_WORDS.floor.en : null
}

/** 403 in words: a priced document is made, mailed or opened only by someone who sees prices (nothing is made, mailed or audited). */
export function pricedDocumentHeld(what: 'make' | 'send' | 'open'): DomainError {
  const words = PRICED_WORDS[what].en
  return new DomainError('forbidden', words, [{ path: `refusal/${PRICED_REFUSALS.HELD}`, message: words }])
}

/** 403 in words: only someone who sees prices takes the mark off. */
export function pricedUnmarkHeld(): DomainError {
  const words = PRICED_WORDS.unmark.en
  return new DomainError('forbidden', words, [{ path: `refusal/${PRICED_REFUSALS.UNMARK}`, message: words }])
}
