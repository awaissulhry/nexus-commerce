import { businessDate, type BusinessDate } from '../../core/time'
import type { Words } from './status'

/**
 * The promise date as the customer reads it (B-W2b-175, SAL-075 / PLN-178; design portal.customer.orders › Status &
 * progress "Promise date, big; first promised date kept; history 'Moved 10 Oct → 17 Oct · Leather delivery late' in
 * customer words (curated reasons, never internal notes)", the list's 'moved' mark and the "Date moved" chip).
 *
 * The moves are the office's own audit rows of `orders.changePromise` (modules/sales/orders): when, from → to, which lines,
 * and the reason the office person typed. That text is the office's and may say anything, so it NEVER reaches the
 * customer: a move shows one of the curated reasons below, in the customer's words, when the office's reason names it —
 * its code (`MATERIAL_LATE`), its code before a note (`MATERIAL_LATE: tannery batch 12 late`: the note stays the
 * office's), or its words in Italian or English — and "Our planning changed" otherwise. The office's dialog offers the
 * list (design sales.orders orders.promise "Reason (list + note)"; a later screen step) and sends the code.
 */

export const PROMISE_REASON_CODES = ['MATERIAL_LATE', 'CAPACITY', 'QUALITY', 'YOUR_CHANGE', 'TRANSPORT', 'EARLIER', 'PLANNING'] as const
export type PromiseReasonCode = (typeof PROMISE_REASON_CODES)[number]

export const PROMISE_REASON_WORDS: Readonly<Record<PromiseReasonCode, Words>> = Object.freeze({
  MATERIAL_LATE: { it: 'Consegna dei materiali in ritardo', en: 'Material delivery late' },
  CAPACITY: { it: 'Capacità produttiva', en: 'Production capacity' },
  QUALITY: { it: 'Controlli di qualità aggiuntivi', en: 'Extra quality checks' },
  YOUR_CHANGE: { it: 'Modifica richiesta da voi', en: 'Changed at your request' },
  TRANSPORT: { it: 'Trasporto', en: 'Transport' },
  EARLIER: { it: 'Pronto prima del previsto', en: 'Ready earlier than planned' },
  PLANNING: { it: 'La nostra pianificazione è cambiata', en: 'Our planning changed' },
})

const fold = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '')

/** The curated reason the office's reason text names, or PLANNING (the text itself is never shown). */
export function promiseReasonOf(text: string | null | undefined): PromiseReasonCode {
  if (typeof text !== 'string' || text.trim() === '') return 'PLANNING'
  const head = /^\s*\[?([A-Za-z_]+)\]?\s*(?::|$)/.exec(text)?.[1]?.toUpperCase()
  const byCode = PROMISE_REASON_CODES.find((code) => code === head)
  if (byCode) return byCode
  const folded = fold(text)
  return PROMISE_REASON_CODES.find((code) => fold(PROMISE_REASON_WORDS[code].it) === folded || fold(PROMISE_REASON_WORDS[code].en) === folded) ?? 'PLANNING'
}

/** One move of the promise as the audit row holds it. */
export interface PromiseMove {
  readonly at: Date
  readonly from: BusinessDate | null
  readonly to: BusinessDate
  /** The lines it moved; empty: the whole order. */
  readonly lineIds: readonly string[]
  readonly reason: string | null
}

export interface CustomerPromiseMove {
  /** The day it moved (Rome). */
  readonly on: BusinessDate
  readonly from: BusinessDate | null
  readonly to: BusinessDate
  /** The line numbers it moved (10, 20 …); empty: the whole order. */
  readonly lines: readonly number[]
  readonly reason: { readonly code: PromiseReasonCode; readonly words: Words }
}

/** The moves in the customer's words, newest first; `seqOf` names a line by its number (a line gone since: left out). */
export function customerPromiseHistory(moves: readonly PromiseMove[], seqOf: (lineId: string) => number | undefined): CustomerPromiseMove[] {
  return [...moves]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .map((move) => {
      const code = promiseReasonOf(move.reason)
      return {
        on: businessDate(move.at),
        from: move.from,
        to: move.to,
        lines: move.lineIds.flatMap((lineId) => {
          const seq = seqOf(lineId)
          return seq === undefined ? [] : [seq]
        }),
        reason: { code, words: PROMISE_REASON_WORDS[code] },
      }
    })
}
