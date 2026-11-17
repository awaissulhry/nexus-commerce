import type { Words } from '../portal/tasks/kinds'
import { PROMISE_REASON_WORDS } from '../sales/portal-orders/promise'
import type { BrandHealth, HealthReasonCode } from './health'
import type { ProductionRequestKind } from './kinds'
import type { ProductionShareLevel } from './levels'
import type { BrandStage } from './stages'
import type { SupervisorMark, SupervisorRefusal } from './supervisor'
import type { AskReason, BrandUrgency } from './urgency'
import type { BrandSide, WaitingOn } from './waiting'

/**
 * B-PR-13: the words of a customer's production, in Italian and English (production plan §4, §5; 07-control §3.1, §4.2;
 * 17-web-r2 §5 — the Italian is a proposal kept in step with messages/it). Words a customer reads are fixed: none takes a
 * name, so none can name a line, a work order, a worker, a site, a supplier, a workshop or another customer. Office words
 * say "customer" (threads plan PR-09); "brand" is only the label on the garment. B-PR-41 adds the urgency, supervisor,
 * escalation and limits card words.
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

// ---- B-PR-41: customer urgency (17-web-r2 §5; plan §3, §5 Words; review fixes R-41, R-65) ---------------------------------

/** The customer's urgency of an order, as the portal says it. */
export const URGENCY_WORDS: Readonly<Record<BrandUrgency, Words>> = Object.freeze({
  URGENT: { it: 'Urgente', en: 'Urgent' },
  REGULAR: { it: 'Normale', en: 'Regular' },
})

/**
 * "2 of 3 urgent used"; with urgent marks we set by accepting its "Urgent – asked" (they may take it over the quota): "4 of 3 ·
 * 1 agreed with us". Only the customer's own open orders: never a place, never another customer's count.
 */
export function urgentUsedWords(use: { readonly used: number; readonly max: number; readonly agreed: number }): Words {
  if (use.agreed <= 0) return { it: `${use.used} urgenti su ${use.max}`, en: `${use.used} of ${use.max} urgent used` }
  return { it: `${use.used} urgenti su ${use.max} · ${use.agreed} ${use.agreed === 1 ? 'concordato' : 'concordati'} con noi`, en: `${use.used} of ${use.max} · ${use.agreed} agreed with us` }
}

/** Our change of its urgency as the customer reads it (never who: R-41). */
export const CHANGED_BY_US_WORDS: Words = Object.freeze({ it: 'Modificato da noi', en: 'Changed by us' })

/** Our set-back to Regular (and the lock), with the reason we gave it (the customer reads the reason as we wrote it). */
export function setBackWords(reason: string | null): Words {
  const said = reason?.trim() ?? ''
  if (said === '') return { it: 'Riportato a normale da noi', en: 'Set to Regular by us' }
  return { it: `Riportato a normale da noi: ${said}`, en: `Set to Regular by us: ${said}` }
}

/** "Move to top" on a Regular order (R-65). */
export const MARK_URGENT_FIRST_WORDS: Words = Object.freeze({ it: 'Segna prima come urgente', en: 'Mark urgent first' })

/** The way to an urgent mark beyond the quota or from Cutting: "Urgent – asked" (B-PR-46a), until then these words. */
export const ASK_US_WORDS: Words = Object.freeze({ it: 'Chiedilo a noi', en: 'Ask us' })

/** Why a mark becomes an ask: cutting has started (read live), or the quota is used. */
export function askUsWords(reason: AskReason, max: number): Words {
  if (reason === 'CUT') return { it: 'Il taglio di questo ordine è iniziato: chiedilo a noi.', en: 'Cutting has started on this order: ask us to make it urgent.' }
  if (max <= 0) return { it: 'Per i tuoi ordini le urgenze si chiedono a noi.', en: 'Urgent marks on your orders are asked of us: ask us to make it urgent.' }
  return max === 1
    ? { it: 'Hai già usato la tua urgenza: chiedilo a noi.', en: 'You have used your 1 urgent mark: ask us to make it urgent.' }
    : { it: `Hai già usato le tue ${max} urgenze: chiedilo a noi.`, en: `You have used your ${max} urgent marks: ask us to make it urgent.` }
}

/** The customer's urgency switch is off (neutral: never why another customer may). */
export const URGENCY_NOT_OPEN_WORDS: Words = Object.freeze({ it: 'Le urgenze non sono attive per i tuoi ordini.', en: 'Urgent marks are not open for your orders.' })

/** The order left My production (shipped in full, cancelled, closed). */
export const NOT_IN_PRODUCTION_WORDS: Words = Object.freeze({ it: 'Questo ordine non è più in produzione.', en: 'This order is no longer in production.' })

/** Nothing changes: the order is that already. */
export function unchangedWords(urgency: BrandUrgency): Words {
  return urgency === 'URGENT' ? { it: "L'ordine è già urgente.", en: 'The order is already urgent.' } : { it: "L'ordine è già normale.", en: 'The order is already regular.' }
}

/** Undo left a row as it is: it changed after the batch. */
export const CHANGED_SINCE_WORDS: Words = Object.freeze({ it: "Cambiato nel frattempo: lasciato com'è.", en: 'Changed since: left as it is.' })

/** The office's words: the header and the chip ("Urgente" alone is already the planner's rush flag in Italian). */
export const CUSTOMER_URGENCY_WORDS: Readonly<{ header: Words; chip: Words }> = Object.freeze({
  header: { it: 'Urgenza cliente', en: 'Customer urgency' },
  chip: { it: 'Urgente (cliente)', en: 'Urgent (customer)' },
})

// ---- B-PR-41: the production supervisor (office words; the customer is never told who) ------------------------------------

export const SUPERVISOR_WORDS: Readonly<{ title: Words; backup: Words; customerDefault: Words; mine: Words }> = Object.freeze({
  title: { it: 'Supervisore di produzione', en: 'Production supervisor' },
  backup: { it: 'Sostituto', en: 'Backup' },
  customerDefault: { it: 'Predefinito del cliente', en: 'Customer default' },
  mine: { it: 'Miei', en: 'Mine' },
})

/** A list's supervisor column (worker privacy: the name only inside one order). */
export const SUPERVISOR_MARK_WORDS: Readonly<Record<SupervisorMark, Words>> = Object.freeze({
  ME: { it: 'Io', en: 'Me' },
  SOMEONE_ELSE: { it: 'Qualcun altro', en: 'Someone else' },
  NOT_SET: { it: 'Non impostato', en: 'Not set' },
})

/** Why a person may not be the supervisor (or backup) of a customer. */
export const SUPERVISOR_REFUSAL_WORDS: Readonly<Record<SupervisorRefusal, Words>> = Object.freeze({
  NOT_OFFICE: { it: "Solo una persona dell'ufficio può supervisionare la produzione.", en: 'Only a person of the office can supervise production.' },
  NOT_ACTIVE: { it: 'Questa persona non è più attiva.', en: 'This person is no longer active.' },
  NO_REACH: { it: 'Questa persona non può lavorare sulla produzione di questo cliente.', en: "This person may not work on this customer's production." },
  NO_MEASUREMENTS: {
    it: 'Questa persona non può aprire le schede misure: il supervisore deve poterlo fare (il permesso misure si dà a persona).',
    en: 'This person cannot open measurement sheets: a supervisor must (the measurements right is given per person).',
  },
})

/** The escalation clock in words (R-44: the same words everywhere). */
export const ESCALATION_WORDS: Words = Object.freeze({
  it: "Senza risposta entro 1 giorno lavorativo passa al sostituto; entro 2 al titolare e all'amministratore (alle 8:00).",
  en: 'No answer in 1 working day: it goes to the backup; in 2: to the Owner and Admin (at 08:00).',
})

// ---- B-PR-41: the limits card's words (office; B-PR-14's read gives them; R-46) ------------------------------------------

/** The customer's urgency switch is off while some of its orders keep an urgent mark (R-46: dormant, not cleared). */
export function dormantMarksWords(count: number): Words | null {
  if (!Number.isInteger(count) || count <= 0) return null
  return count === 1
    ? { it: '1 ordine urgente è tenuto ma non conta finché questo è spento.', en: '1 urgent mark is kept but not used while this is off.' }
    : { it: `${count} ordini urgenti sono tenuti ma non contano finché questo è spento.`, en: `${count} urgent marks are kept but not used while this is off.` }
}

/** The quota is below today's urgent marks: they stay; only new marks stop until the count is under the quota. */
export function overQuotaWords(count: number, max: number): Words | null {
  if (!Number.isInteger(count) || count <= max) return null
  return { it: `${count} ordini urgenti su ${max}: restano urgenti; nuove urgenze solo sotto la quota.`, en: `${count} urgent orders for a quota of ${max}: they stay urgent; new marks only below the quota.` }
}

/** The customer's allowed roles leave out the Production role (its people cannot be given it). */
export const PRODUCTION_ROLE_NOT_OFFERED_WORDS: Words = Object.freeze({
  it: 'Il ruolo Produzione non è tra i ruoli ammessi di questo cliente: aggiungilo per darlo a qualcuno.',
  en: "The Production role is not among this customer's allowed roles: add it to give it to someone.",
})
