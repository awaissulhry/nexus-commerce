import { MAX_MENTIONS } from '../threads/rules'

/**
 * B-PR-43a (production plan §1 "Ask the supervisor / Note to N", §3 "Note to N / Ask the supervisor"; lead pick L23; review fixes
 * R-47, R-48, R-55, R-58; the Owner's point N4: "mention him to address a specific issue … for that order or multiple orders at
 * once"): one internal office note written into each picked record's OWN thread — a sales order's or a work order's — with the same
 * text, pure. apps/factory-api modules/production/notes writes it through threads' seams (ensureThread, writeMessage,
 * mentionProblems, mayOnThread): no second thread, no second mention system.
 *
 *   records      1 to 100 sales orders and work orders, of one or several customers (an internal note only: never a shared
 *                message, threads R-17); each walled on its own (threads.read + threads.post over its own scope), a record the
 *                writer does not see is counted, never named
 *   mentions     at most 20 people typed (threads' MAX_MENTIONS); "Ask the supervisor" adds each record's own supervisor to ITS
 *                note; a person is mentioned only on the records they read (the note is still written there: F-PR-22)
 *   other names  the text checked against each record's customer (email-out mis-send partiesNamedIn): a record whose text names
 *                ANOTHER customer is held until the text changes or the writer ticks "This text names no other customer" — the
 *                write checks it again and refuses without the tick (R-47: a colleague limited to that customer would read the
 *                other customer's name)
 *
 * Words in Italian and English; the API answers the English (the web says them from its own catalogue).
 */

export const NOTE_RECORD_TYPES = ['SalesOrder', 'WorkOrder'] as const
export type NoteRecordType = (typeof NOTE_RECORD_TYPES)[number]

/** The most records one "Note to N" writes on (L23). */
export const NOTE_RECORDS_MAX = 100
/** The most people one note mentions (threads' own limit: the supervisor "Ask the supervisor" adds comes beside them). */
export const NOTE_MENTIONS_MAX = MAX_MENTIONS

/** Why a record the writer sees is not written on. */
export const NOTE_SKIPS = ['CANNOT_POST', 'THREAD_CLOSED'] as const
export type NoteSkip = (typeof NOTE_SKIPS)[number]

export const NOTE_WORDS = Object.freeze({
  CANNOT_POST: { it: 'Il tuo ruolo non scrive note su questo record.', en: 'Your role does not write notes on this record.' },
  THREAD_CLOSED: { it: 'La conversazione di questo record è chiusa: riaprila per scrivere una nota.', en: "This record's thread is closed: reopen it to write a note." },
  NONE_FOUND: { it: 'Nessuno di questi record è stato trovato.', en: 'None of these records was found.' },
  NOT_A_PERSON: { it: 'Non è una persona attiva dell’ufficio.', en: 'Not an active person of the office.' },
  NAMES_OTHER_CUSTOMER: {
    it: 'Il testo nomina un altro cliente: cambialo, oppure spunta «Questo testo non nomina altri clienti».',
    en: 'The text names another customer: change it, or tick "This text names no other customer".',
  },
  NAMES_OTHER_CUSTOMER_ON: { it: 'Qui il testo nomina un altro cliente.', en: 'Here the text names another customer.' },
  NO_SUPERVISOR: { it: 'Questo record non ha un supervisore di produzione.', en: 'This record has no production supervisor.' },
})

/** The writer's tick (R-47). */
export const NAMES_NO_OTHER_CUSTOMER = Object.freeze({ it: 'Questo testo non nomina altri clienti', en: 'This text names no other customer' })

/** A record picked twice is written on once (the first place it was given). */
export function uniqueRecords<T extends { readonly type: string; readonly id: string }>(records: readonly T[]): T[] {
  const seen = new Set<string>()
  return records.filter((record) => {
    const key = `${record.type}:${record.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The records whose text names another customer, held unless the writer ticked "This text names no other customer" (R-47). */
export function heldForOtherCustomer<T extends { readonly namesOther: readonly unknown[] }>(records: readonly T[], ticked: boolean): T[] {
  return ticked ? [] : records.filter((record) => record.namesOther.length > 0)
}

/** The order the notes are written in: by record type and id, so two batches over the same threads never wait on each other. */
export const writeOrder = <T extends { readonly type: string; readonly id: string }>(records: readonly T[]): T[] =>
  [...records].sort((a, b) => (a.type === b.type ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.type < b.type ? -1 : 1))
