/**
 * B-TH-044 (threads plan TH-3, G15; wall W08): a reply the record's customer or supplier reads in its portal, with no mail — an
 * OUTBOUND message on the PORTAL channel of the record's own thread (apps/factory-api platform/threads/replies.ts); the portal's
 * news tells them, and their own mail setting decides when they hear of it. Why a reply is refused, in words for the office (it
 * and en), at `refusal/<CODE>`: none of them names another party. A record that is never shared (a work order, a quality hold, a
 * nonconformance) keeps its own refusal, NOT_SHAREABLE (platform/threads/records.ts).
 */

// B-SA-073 (sales page plan R7; review BW-6): + Reply to N on the server — a batch of one customer (BATCH_TWO_CUSTOMERS), at most
// REPLY_BATCH_MAX records (BATCH_FULL) — and the mis-send text check on every reply (NAMES_OTHER_CUSTOMER, until the writer ticks
// "This text names no other customer").
export const REPLY_REFUSALS = ['NO_PARTY', 'NO_PORTAL', 'CLOSED', 'BATCH_TWO_CUSTOMERS', 'BATCH_FULL', 'NAMES_OTHER_CUSTOMER'] as const
export type ReplyRefusalCode = (typeof REPLY_REFUSALS)[number]

export const REPLY_REFUSAL_WORDS: Readonly<Record<ReplyRefusalCode, { readonly it: string; readonly en: string }>> = Object.freeze({
  NO_PARTY: {
    it: 'Questo record non ha ancora un cliente o un fornitore a cui rispondere: crea prima il cliente (un potenziale cliente non ha il portale). Intanto scrivi una nota interna.',
    en: 'This record has no customer or supplier to reply to yet: make the customer first (a prospect has no portal). Write an internal note meanwhile.',
  },
  NO_PORTAL: {
    it: 'Nessuno di questo cliente o fornitore legge questo record nel portale: rispondi via e-mail.',
    en: 'Nobody of this customer or supplier reads this record in the portal: reply by e-mail instead.',
  },
  CLOSED: {
    it: 'Questa conversazione è chiusa: riaprila per rispondere.',
    en: 'This conversation is closed: reopen it to reply.',
  },
  // ---- B-SA-073
  BATCH_TWO_CUSTOMERS: {
    it: 'Rispondere a più ordini funziona per un cliente alla volta.',
    en: 'Reply to many works for one customer at a time.',
  },
  BATCH_FULL: {
    it: 'Al massimo 50 ordini in una risposta.',
    en: 'At most 50 orders in one reply.',
  },
  // The production notes' own words (R-47, factory-domain production-brand/notes NOTE_WORDS): one check, one sentence.
  NAMES_OTHER_CUSTOMER: {
    it: 'Il testo nomina un altro cliente: cambialo, oppure spunta «Questo testo non nomina altri clienti».',
    en: 'The text names another customer: change it, or tick "This text names no other customer".',
  },
  // ---- end B-SA-073
})

// ---- B-SA-073: the most records one Reply to N writes on (the same batchId on each reply).
export const REPLY_BATCH_MAX = 50
