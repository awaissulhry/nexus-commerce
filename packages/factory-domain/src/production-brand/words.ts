import type { Words } from '../portal/tasks/kinds'
import { PROMISE_REASON_WORDS } from '../sales/portal-orders/promise'
import type { BrandHealth, HealthReasonCode } from './health'
import type { ProductionRequestKind } from './kinds'
import type { ProductionShareLevel } from './levels'
import type { BrandStage } from './stages'
import type { BrandSide, WaitingOn } from './waiting'

/**
 * B-PR-13: the words of a customer's production, in Italian and English (production plan §4, §5; 07-control §3.1, §4.2;
 * 17-web-r2 §5 — the Italian is a proposal kept in step with messages/it). Words a customer reads are fixed: none takes a
 * name, so none can name a line, a work order, a worker, a site, a supplier, a workshop or another customer. Office words
 * say "customer" (threads plan PR-09); "brand" is only the label on the garment. B-PR-41 adds the urgency words here.
 */

/** The plain stages (the note of the order's "In production" step). */
export const STAGE_WORDS: Readonly<Record<BrandStage, Words>> = Object.freeze({
  PREPARING: { it: 'In preparazione', en: 'Preparing' },
  CUTTING: { it: 'Taglio', en: 'Cutting' },
  SEWING: { it: 'Cucitura', en: 'Sewing' },
  QUALITY: { it: 'Controllo qualità', en: 'Quality check' },
  READY: { it: 'Pronto per la spedizione', en: 'Ready to ship' },
})

/** Beside CUTTING where a site does not scan sewing (stages.ts sewingNotCounted). */
export const SEWING_NOT_COUNTED_WORDS: Words = Object.freeze({ it: 'Cucitura non conteggiata qui', en: 'Sewing not counted here' })

/** How many of the order's own lines are further on than its stage (stages.ts ahead; 0: no words). */
export function aheadWords(count: number): Words | null {
  if (!Number.isInteger(count) || count <= 0) return null
  return count === 1 ? { it: '1 riga più avanti', en: '1 line ahead' } : { it: `${count} righe più avanti`, en: `${count} lines ahead` }
}

/** The health chip. */
export const HEALTH_WORDS: Readonly<Record<BrandHealth, Words>> = Object.freeze({
  LATE: { it: 'In ritardo', en: 'Late' },
  AT_RISK: { it: 'A rischio', en: 'At risk' },
  NO_DATE: { it: 'Data da definire', en: 'No date yet' },
  ON_TRACK: { it: 'In linea', en: 'On track' },
})

/** A raise's reason as the customer reads it: the promise's own curated words (sales/portal-orders/promise). */
export const HEALTH_REASON_WORDS: Readonly<Record<HealthReasonCode, Words>> = Object.freeze({
  MATERIAL_LATE: PROMISE_REASON_WORDS.MATERIAL_LATE,
  CAPACITY: PROMISE_REASON_WORDS.CAPACITY,
  QUALITY: PROMISE_REASON_WORDS.QUALITY,
  YOUR_CHANGE: PROMISE_REASON_WORDS.YOUR_CHANGE,
  TRANSPORT: PROMISE_REASON_WORDS.TRANSPORT,
  PLANNING: PROMISE_REASON_WORDS.PLANNING,
})

/** Who acts next, as the customer reads it: only you or us. */
export const BRAND_WAITING_WORDS: Readonly<Record<BrandSide, Words>> = Object.freeze({
  YOU: { it: 'Tocca a te', en: 'Waiting on you' },
  US: { it: 'Tocca a noi', en: 'Waiting on us' },
})

/** Who an order waits on, as the office reads it. */
export const OFFICE_WAITING_WORDS: Readonly<Record<WaitingOn, Words>> = Object.freeze({
  BRAND: { it: 'In attesa del cliente', en: 'Waiting on the customer' },
  SUPPLIER: { it: 'In attesa di un fornitore', en: 'Waiting on a supplier' },
  WORKSHOP: { it: 'In attesa di un laboratorio', en: 'Waiting on a workshop' },
  US: { it: 'Tocca a noi', en: 'Waiting on us' },
})

/** What a customer sees (the limits card's levels; each adds to the one before). */
export const LEVEL_WORDS: Readonly<Record<ProductionShareLevel, Words>> = Object.freeze({
  STATUS: { it: 'Solo lo stato', en: 'Status only' },
  PROGRESS: { it: '+ Avanzamento', en: '+ Progress' },
  GATES: { it: '+ Tappe e date', en: '+ Gates & dates' },
  QUALITY: { it: '+ Qualità e foto', en: '+ Quality & photos' },
})

/** The production asks (beside "Ask for a change" and "Ask to cancel", sales/change-requests KIND_WORDS). */
export const ASK_KIND_WORDS: Readonly<Record<ProductionRequestKind, Words>> = Object.freeze({
  RUSH: { it: 'Urgente – richiesto', en: 'Urgent – asked' },
  HOLD: { it: 'Chiedi una pausa', en: 'Ask to pause' },
  RESUME: { it: 'Chiedi di riprendere', en: 'Ask to resume' },
  SPLIT_SHIPMENT: { it: 'Chiedi di spedire ciò che è pronto', en: 'Ask to ship what is ready' },
  SAMPLE_ROUND: { it: 'Chiedi un altro campione', en: 'Ask for another sample' },
})

/** A closed ask refused to a customer: neutral, it never says why another customer may and it may not. */
export const ASK_NOT_OPEN_WORDS: Words = Object.freeze({
  it: "Questa richiesta non è disponibile per i tuoi ordini. Scrivici nella conversazione dell'ordine.",
  en: "This ask is not open for your orders. Write to us in the order's thread.",
})
