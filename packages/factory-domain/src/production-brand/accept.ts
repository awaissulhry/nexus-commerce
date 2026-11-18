import type { Words } from '../portal/tasks/kinds'
import type { WorkOrderStatus } from '../production/work-orders/machine'
import type { OrderRequestKind } from '../sales/change-requests/rules'

/**
 * B-PR-27a (production plan §3 "Brand asks, we decide", "Who answers / sets", "Legacy mixed work order: accept is held ('answer by
 * hand')"; 08-backend §4.2 "Accept does"; lead pick L4; the Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."): what
 * accepting a customer's production ask does to the work of its order, pure. apps/factory-api's
 * production/brand-requests/accept.ts carries it out in the accept's ONE command.
 *
 *   where     HOLD, RESUME (B-PR-27a), RUSH and SAMPLE_ROUND (B-PR-27b) are accepted in production (POST
 *             /production/brand-requests/:id/accept); CHANGE, CANCEL and SPLIT_SHIPMENT in Sales (POST
 *             /sales/change-requests/:id/accept): each route refuses the other's kinds in words
 *   HOLD      a BRAND hold (WorkOrderHold, the customer's pause: its HOLD ask named) on each OPEN work order of the order (DRAFT,
 *             RELEASED, IN_PROGRESS, ON_HOLD; never a repair) — one already paused by the customer is left as it is. Held, in
 *             words, the office answers by hand: an order with no open work order yet (nothing to pause), a work order made
 *             before the one-customer rule (no customer: it makes another customer's pieces too), a work order that also
 *             makes another order (a pause of this order would stop that one)
 *   RESUME    every ACTIVE BRAND hold its HOLD asks placed on the order's work orders, lifted (a work order still held by
 *             another hold stays held under it); none left: the accept says that nothing was paused any more
 * The customer reads "Paused at your request" while a BRAND hold stands (the portal's read); the floor reads the pause's words
 * on the work order (never a customer's name); the office reads every work order and why one is held.
 */

/** The kinds accepted in production (the others are Sales'). */
export const PRODUCTION_ACCEPT_KINDS = ['HOLD', 'RESUME', 'RUSH', 'SAMPLE_ROUND'] as const satisfies readonly OrderRequestKind[]
export type ProductionAcceptKind = (typeof PRODUCTION_ACCEPT_KINDS)[number]
export const isProductionAccept = (kind: string): kind is ProductionAcceptKind => (PRODUCTION_ACCEPT_KINDS as readonly string[]).includes(kind)

/** A Sales kind sent to production's accept (409 `request/SALES_ASK`). */
export const SALES_ACCEPT_WORDS: Words = Object.freeze({
  it: 'Questa richiesta si accetta in Vendite (modifica, annullamento, spedizione di ciò che è pronto).',
  en: 'This request is accepted in Sales (a change, a cancel, ship what is ready).',
})

/**
 * The reason a customer's pause carries (WorkOrderHold.reasonCode of a BRAND hold: the customer's own HOLD ask is why, never a
 * code of the PRODUCTION_HOLD list) and the words the work order shows while held under it (WorkOrder.holdReason, the floor's).
 */
export const CUSTOMER_PAUSE_REASON = Object.freeze({ code: 'CUSTOMER_PAUSE', it: 'In pausa su richiesta del cliente', en: "Paused at the customer's request" })

/** The words a plain hold shows: a customer's pause its own, a production hold its reason's (else its code). */
export const plainHoldWordsOf = (hold: { readonly kind: string; readonly reasonCode: string }, reasonEn: string | undefined): string =>
  hold.kind === 'BRAND' ? CUSTOMER_PAUSE_REASON.en : (reasonEn ?? hold.reasonCode)

/** The work order statuses a hold is placed on (the database's: …_brand_production_guards). */
export const OPEN_WORK_ORDER_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'])
export const isOpenWorkOrder = (status: string): boolean => (OPEN_WORK_ORDER_STATUSES as readonly string[]).includes(status)

/** One work order that makes the order's goods (a cell of one of its goods lines; never a repair), as the accept reads it. */
export interface AcceptWorkOrder {
  readonly id: string
  readonly number: string
  readonly status: WorkOrderStatus
  /** Its customer (null: made before the one-customer rule — a mixed work order). */
  readonly partyId: string | null
  /** It also makes pieces of another order (a cell of another order's line, or of no order). */
  readonly otherOrders: boolean
  /** A BRAND hold (the customer's pause) stands on it already. */
  readonly paused: boolean
}

export type PauseRefusal = 'NO_WORK' | 'MIXED' | 'SHARED'

export type PausePlan =
  | { readonly ok: true; readonly hold: readonly string[]; readonly already: readonly string[] }
  | { readonly ok: false; readonly code: PauseRefusal; readonly numbers: readonly string[]; readonly words: Words }

const listed = (numbers: readonly string[]): string => numbers.join(', ')

/** The office's words of a pause it answers by hand (each names only the order's own work orders). */
export function pauseRefusalWords(code: PauseRefusal, numbers: readonly string[]): Words {
  const one = numbers.length === 1
  switch (code) {
    case 'NO_WORK':
      return {
        it: "L'ordine non ha ancora ordini di lavoro aperti: non c'è niente da mettere in pausa. Rispondi a mano: rifiuta con un motivo, o accetta quando i suoi ordini di lavoro ci sono.",
        en: 'The order has no open work order yet: there is nothing to pause. Answer by hand: refuse with words, or accept once its work orders are made.',
      }
    case 'MIXED':
      return {
        it: `${one ? "L'ordine di lavoro" : 'Gli ordini di lavoro'} ${listed(numbers)} ${one ? 'è stato fatto' : 'sono stati fatti'} prima della regola di un solo cliente e ${one ? 'fa' : 'fanno'} anche capi di altri clienti: rispondi a mano (dividi prima, o metti in pausa a mano solo i capi di questo cliente).`,
        en: `Work order${one ? '' : 's'} ${listed(numbers)} ${one ? 'was' : 'were'} made before the one-customer rule and also ${one ? 'makes' : 'make'} other customers' pieces: answer by hand (split first, or pause only this customer's pieces yourself).`,
      }
    case 'SHARED':
      return {
        it: `${one ? "L'ordine di lavoro" : 'Gli ordini di lavoro'} ${listed(numbers)} ${one ? 'fa' : 'fanno'} anche un altro ordine: una pausa di questo fermerebbe anche quello. Rispondi a mano.`,
        en: `Work order${one ? '' : 's'} ${listed(numbers)} also ${one ? 'makes' : 'make'} another order: a pause of this order would stop that one too. Answer by hand.`,
      }
  }
}

/**
 * Which work orders accepting a pause holds: every open one of the order's (one the customer paused already is left as it is), or
 * the reason it is answered by hand — no open work order, a mixed one, one that also makes another order (that order would stop
 * too). The work orders come in id order (the lock order); the plan keeps it.
 */
export function pausePlan(workOrders: readonly AcceptWorkOrder[]): PausePlan {
  const open = workOrders.filter((workOrder) => isOpenWorkOrder(workOrder.status))
  if (open.length === 0) return { ok: false, code: 'NO_WORK', numbers: [], words: pauseRefusalWords('NO_WORK', []) }
  const mixed = open.filter((workOrder) => workOrder.partyId === null).map((workOrder) => workOrder.number)
  if (mixed.length > 0) return { ok: false, code: 'MIXED', numbers: mixed, words: pauseRefusalWords('MIXED', mixed) }
  const shared = open.filter((workOrder) => workOrder.otherOrders).map((workOrder) => workOrder.number)
  if (shared.length > 0) return { ok: false, code: 'SHARED', numbers: shared, words: pauseRefusalWords('SHARED', shared) }
  return { ok: true, hold: open.filter((workOrder) => !workOrder.paused).map((workOrder) => workOrder.id), already: open.filter((workOrder) => workOrder.paused).map((workOrder) => workOrder.id) }
}

/** Why a customer's pause was lifted (WorkOrderHold.liftReason: one line, at most 500). */
export const resumeReasonOf = (orderNumber: string): string => `Resumed at the customer's request (${orderNumber}).`.slice(0, 500)

/** What an accepted pause or resume did, in the office's words. */
export function pauseDoneWords(kind: 'HOLD' | 'RESUME', numbers: readonly string[]): Words {
  if (numbers.length === 0) {
    return kind === 'HOLD'
      ? { it: "Ogni ordine di lavoro dell'ordine era già in pausa su richiesta del cliente.", en: "Every work order of the order was paused at the customer's request already." }
      : { it: "Non c'era più niente in pausa: il lavoro dell'ordine continua.", en: "Nothing was paused any more: the order's work goes on." }
  }
  const one = numbers.length === 1
  return kind === 'HOLD'
    ? { it: `In pausa su richiesta del cliente: ${listed(numbers)}.`, en: `Paused at the customer's request: ${listed(numbers)}.` }
    : { it: `${one ? 'Ripreso' : 'Ripresi'}: ${listed(numbers)}.`, en: `Taken up again: ${listed(numbers)}.` }
}

// ── B-PR-27b (production plan §3 "Brand-slot rule": "Putting an order ahead of other brands stays our act: accept its 'Urgent –
// asked' ('Accept as urgent' or 'Accept and rush the floor')"; 08-backend §4.2: RUSH "WorkOrder.rush + a re-promise proposal
// (planning decides the date)", SPLIT_SHIPMENT "shipComplete = false + re-promise of the first part", SAMPLE_ROUND "a SampleRound
// of that kind"; lead picks L18, L19; review fixes R-40, R-64) ───────────────────────────────────────────────────────────────────
//
//   RUSH            "Accept as urgent": the order marked Urgent by us (last in the customer's own Urgent list; it may pass the
//                   quota: the customer reads "agreed with us"; planning's brand-slot pass moves it only among that customer's own
//                   places), and the date it asked (or our counter's) proposed to sales as the re-promise of every open size
//                   promised later. "Accept and rush the floor": the same, and the planner's own rush lever on each open work order
//                   of the order (first on every tablet); a mixed work order is never rushed by the accept (rush it by hand). A jump
//                   ahead of other customers in the plan stays the planner's level or hand rank
//   SPLIT_SHIPMENT  the order ships as ready (SalesOrder.shipComplete false) and the first part's date (asked, or our counter's)
//                   proposed to sales for its sizes promised later
//   SAMPLE_ROUND    a sample round of the kind asked, for the customer, of the line's style in the line's colourway: a size set
//                   one piece of each size the line orders, the others one piece of the line's base size

/** Why an "Urgent – asked" is not accepted as urgent now (the office's words; 409 `request/<code>`). */
export const RUSH_REFUSAL_WORDS: Readonly<Record<'NOT_KEPT' | 'NOT_OPEN' | 'URGENCY_OFF' | 'LOCKED', Words>> = Object.freeze({
  NOT_KEPT: { it: "L'ordine non ha ancora uno stato di produzione: riprova tra un momento.", en: 'The order has no production state yet: try again in a moment.' },
  NOT_OPEN: { it: "L'ordine non è più in produzione: rifiuta la richiesta con un motivo.", en: 'The order is no longer in production: refuse the ask with words.' },
  URGENCY_OFF: {
    it: 'Le urgenze di questo cliente sono spente: accendile nella scheda dei limiti, o rifiuta la richiesta con un motivo.',
    en: "This customer's urgency is switched off: switch it on in the limits card first, or refuse the ask with words.",
  },
  LOCKED: {
    it: "Abbiamo bloccato l'ordine su normale: sbloccalo nella scheda del cliente, o rifiuta la richiesta con un motivo.",
    en: 'We locked this order at Regular: unlock it on the Customer card first, or refuse the ask with words.',
  },
})

/** "Accept and rush the floor" of an order with no open work order yet (409 `request/NOTHING_TO_RUSH`). */
export const NOTHING_TO_RUSH_WORDS: Words = Object.freeze({
  it: "L'ordine non ha ancora ordini di lavoro aperti: non c'è niente da mettere in urgenza in reparto. Accettala come urgente; l'urgenza in reparto si mette quando i suoi ordini di lavoro ci sono.",
  en: 'The order has no open work order yet: there is nothing to rush on the floor. Accept it as urgent; rush its work orders once they are made.',
})

/** "Accept and rush the floor" by a person who may not rush its work orders (403). */
export const RUSH_RIGHT_WORDS: Words = Object.freeze({
  it: "Mettere in urgenza in reparto richiede workorders.manage sugli ordini di lavoro dell'ordine: accettala come urgente.",
  en: "Rushing the floor needs workorders.manage over the order's work orders: accept it as urgent instead.",
})

/** rushFloor names only an "Urgent – asked" (400 `body/rushFloor`). */
export const RUSH_FLOOR_ONLY_WORDS: Words = Object.freeze({ it: 'Solo una richiesta «Urgente – richiesto» mette in urgenza il reparto.', en: 'Only an "Urgent – asked" rushes the floor.' })

/** One work order of the order with its rush flag, as "Accept and rush the floor" reads it. */
export interface RushWorkOrder extends AcceptWorkOrder {
  readonly rush: boolean
}

/** Which open work orders "rush the floor" sets rush on (in id order), which are rushed already, which are mixed (never by the accept). */
export function rushPlan(workOrders: readonly RushWorkOrder[]): { readonly rush: readonly string[]; readonly already: readonly string[]; readonly mixed: readonly string[] } {
  const open = workOrders.filter((workOrder) => isOpenWorkOrder(workOrder.status))
  const own = open.filter((workOrder) => workOrder.partyId !== null)
  return { rush: own.filter((workOrder) => !workOrder.rush).map((workOrder) => workOrder.id), already: own.filter((workOrder) => workOrder.rush).map((workOrder) => workOrder.id), mixed: open.filter((workOrder) => workOrder.partyId === null).map((workOrder) => workOrder.number) }
}

/** A mixed work order the accept left alone (the office's words). */
export function rushMixedWords(numbers: readonly string[]): Words {
  const one = numbers.length === 1
  return {
    it: `${one ? "L'ordine di lavoro" : 'Gli ordini di lavoro'} ${listed(numbers)} ${one ? 'fa' : 'fanno'} anche capi di altri clienti: ${one ? 'mettilo' : 'mettili'} in urgenza a mano, se serve.`,
    en: `Work order${one ? '' : 's'} ${listed(numbers)} also ${one ? 'makes' : 'make'} other customers' pieces: rush ${one ? 'it' : 'them'} by hand if needed.`,
  }
}

/** The re-promise asked by an accept: every open size promised later than the date (a size promised by then already keeps its date). */
export function repromiseAsksOf(sizes: readonly { readonly size: string | null; readonly open: number; readonly promised: string | null }[], date: string): { readonly size: string | null; readonly date: string }[] {
  return sizes.filter((entry) => entry.open > 0 && entry.promised !== null && entry.promised > date).map((entry) => ({ size: entry.size, date }))
}

/** Why no re-promise was proposed for a line (the office's words). */
export const REPROMISE_SKIP_WORDS = Object.freeze({
  NO_DATE: { it: 'Il cliente non ha chiesto una data: la promessa resta finché la pianificazione non ne propone una nuova.', en: 'The customer asked no date: the promise stands until planning proposes a new one.' },
  KEPT: { it: 'Ogni taglia aperta è già promessa entro la data chiesta.', en: 'Every open size is promised by the date asked already.' },
  NO_SITE: { it: 'La riga non ha ancora un reparto che la produce: scegli il reparto, poi proponi la data.', en: 'The line has no making site yet: choose it, then propose the date.' },
  NO_RIGHT: { it: 'Non proponi date in questo reparto: la nuova data la propone la pianificazione.', en: 'You do not propose dates at this site: planning proposes the new date.' },
} satisfies Record<string, Words>)

/** The cells of the round an accepted sample round ask makes (the line's colourway): a size set one per size ordered, else the base size. */
export function sampleCellsOf(kind: string, line: { readonly colourwayId: string; readonly baseSize: string | null; readonly sizes: readonly { readonly size: string; readonly quantity: number }[] }, style: { readonly baseSize: string | null; readonly sizes: readonly string[] }): { readonly colourwayId: string; readonly size: string; readonly quantity: number }[] {
  const ordered = line.sizes.filter((entry) => entry.quantity > 0).map((entry) => entry.size)
  const inRange = [...ordered].sort((a, b) => style.sizes.indexOf(a) - style.sizes.indexOf(b))
  if (kind === 'SIZE_SET') return inRange.map((size) => ({ colourwayId: line.colourwayId, size, quantity: 1 }))
  const base = [line.baseSize, style.baseSize].find((size): size is string => size !== null && (style.sizes.includes(size) || ordered.includes(size))) ?? inRange[0] ?? style.sizes[0]
  return base ? [{ colourwayId: line.colourwayId, size: base, quantity: 1 }] : []
}

/** The round's instructions: the customer asked it from its portal, of which order and line, and their words. */
export const sampleInstructionsOf = (orderNumber: string, seq: number, note: string | null): string =>
  `Asked by the customer from its portal (${orderNumber}, line ${seq})${note ? `: ${note}` : '.'}`.slice(0, 4000)

/** What an accept did, in the office's words, one part each (joined by the caller). */
export const ACCEPT_DONE_WORDS = Object.freeze({
  urgent: (rank: number | null, already: boolean): Words =>
    already ? { it: "L'ordine era già urgente: resta al suo posto.", en: 'The order was Urgent already: it keeps its place.' } : { it: `Segnato urgente da noi: ${rank ?? '—'}° nella lista urgente del cliente.`, en: `Marked Urgent by us: number ${rank ?? '—'} in the customer's own Urgent list.` },
  rushed: (numbers: readonly string[]): Words => (numbers.length === 0 ? { it: 'Già in urgenza in reparto.', en: 'Rushed on the floor already.' } : { it: `In urgenza in reparto: ${listed(numbers)}.`, en: `Rushed on the floor: ${listed(numbers)}.` }),
  repromised: (count: number): Words => (count === 0 ? { it: 'Nessuna nuova data proposta.', en: 'No new date proposed.' } : { it: `Nuova data proposta alle vendite per ${count} ${count === 1 ? 'riga' : 'righe'}.`, en: `New date proposed to sales for ${count} line${count === 1 ? '' : 's'}.` }),
  shipsAsReady: { it: "L'ordine si spedisce a parti, man mano che sono pronte.", en: 'The order ships in parts as they are ready.' } as Words,
  sampleRound: (number: string): Words => ({ it: `Giro di campionatura ${number} richiesto.`, en: `Sample round ${number} asked.` }),
})

/** The parts of what was done, joined in one sentence pair. */
export const joinedWords = (parts: readonly Words[]): Words => ({ it: parts.map((part) => part.it).join(' '), en: parts.map((part) => part.en).join(' ') })
// ── end B-PR-27b ──
