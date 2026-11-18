import type { BusinessDate } from '../../core/time'
import { BRAND_STAGES, type BrandStage } from '../../production-brand/stages'
import { STAGE_WORDS } from '../../production-brand/words'
import { CHANGE_WORDS, EXTRA_OUTCOMES, type ExtraOutcome, type WorkOrderChangeKind, type WorkOrderChangeStatus } from '../../order-apply/rules'
import { dayWords, type OrderRequestKind, type RequestStatus, type Words } from './rules'

/**
 * B-SA-045 (sales page plan P5, P6', R1, R8; 13-backend B4a; 14-change-flow §3.2 items 4 and 6, §3.4; review C-4, C-16), pure:
 * the review window's apply plan of ONE customer request — readable before Accept (what accepting would do) and after it (what
 * was done and what is still open) with the SAME rules the commands use (the gap is factory-domain order-apply planChanges, its
 * records WorkOrderChange). apps/factory-api's modules/sales/change-requests/apply-plan reads the facts and answers
 * `GET /sales/change-requests/:requestId/apply-plan`; the order's "Still to do" (B-SA-050) lists the open steps of every request.
 *
 *   On the floor now   per asked cell: ordered · in work orders · cut · sewn · packed of the order's OWN cells; "In work now: 3
 *                      bundles at Sewing" (counts, never a name, never a per-person or per-station figure: Statuto art. 4)
 *   Extra pieces       pieces already cut beyond the new figure, per size, with the three outcomes and what each needs: the
 *                      price grain to charge the customer, the scrap's own approval to scrap them (R1; Round 4: unpicked)
 *   What happens next  numbered steps: AMEND = this Accept · LOWER_TO_ORDER / MAKE_MORE held for who manages the work order ·
 *                      STYLE_CHANGE and ECO for a design change (B-SA-047) · REPROMISE · TELL_WORKSHOP when an outside workshop
 *                      makes the line (R8); each with its state, the team that acts, whether the reader may act now, and why
 *
 * Accept first, the work order follows (review C-4, P6'): a lowering is never a precondition of Accept any more, and a cell cut
 * beyond the new figure is never NOT_POSSIBLE — its pieces are extra pieces with a named outcome (C-16).
 */

export const APPLY_STEP_KINDS = ['AMEND', 'LOWER_TO_ORDER', 'MAKE_MORE', 'STYLE_CHANGE', 'ECO', 'REPROMISE', 'TELL_WORKSHOP'] as const
export type ApplyStepKind = (typeof APPLY_STEP_KINDS)[number]

/** TO_DO: not started (before Accept: what Accept would start) · PROPOSED: held for a person · DONE · NOT_POSSIBLE · LEFT_AS_IS. */
export const APPLY_STEP_STATES = ['TO_DO', 'PROPOSED', 'DONE', 'NOT_POSSIBLE', 'LEFT_AS_IS'] as const
export type ApplyStepState = (typeof APPLY_STEP_STATES)[number]

/** Who acts on a step (the same words as "Still to do" waits on, B-SA-050). */
export const APPLY_TEAMS = ['SALES', 'PLANNER', 'PRODUCT', 'CUSTOMER', 'FINANCE'] as const
export type ApplyTeam = (typeof APPLY_TEAMS)[number]

/** What an outcome of the extra pieces needs beside the accept: the price grain (charge), the scrap's own approval (scrap). */
export const OUTCOME_NEEDS = ['PRICE_GRAIN', 'SCRAP_APPROVAL'] as const
export type OutcomeNeed = (typeof OUTCOME_NEEDS)[number]

/** A step still open: it waits for someone (the order's "Still to do"). */
export const isOpenStep = (state: ApplyStepState): boolean => state === 'TO_DO' || state === 'PROPOSED'

/** One step, as the window draws it (the API adds the named person and the record's door). */
export interface ApplyStep {
  readonly kind: ApplyStepKind
  readonly state: ApplyStepState
  readonly team: ApplyTeam
  readonly words: Words
  readonly why: Words | null
  readonly mayDoNow: boolean
}

// ---- words ------------------------------------------------------------------------------------------------------------------

export const TEAM_WORDS: Readonly<Record<ApplyTeam, Words>> = Object.freeze({
  SALES: { en: 'Sales', it: 'Vendite' },
  PLANNER: { en: 'Planning', it: 'Pianificazione' },
  PRODUCT: { en: 'Product', it: 'Prodotto' },
  CUSTOMER: { en: 'The customer', it: 'Il cliente' },
  FINANCE: { en: 'Finance', it: 'Amministrazione' },
})

export const STEP_STATE_WORDS: Readonly<Record<ApplyStepState, Words>> = Object.freeze({
  TO_DO: { en: 'To do', it: 'Da fare' },
  PROPOSED: { en: 'Waiting for a decision', it: 'Aspetta una decisione' },
  DONE: { en: 'Done', it: 'Fatto' },
  NOT_POSSIBLE: { en: 'Not possible', it: 'Non possibile' },
  LEFT_AS_IS: { en: 'Left as is', it: 'Lasciato così' },
})

const join = (parts: readonly Words[], sep = ' · '): Words => ({ en: parts.map((part) => part.en).join(sep), it: parts.map((part) => part.it).join(sep) })

export const APPLY_WORDS = {
  /** AMEND: what this Accept does, by the request's kind. */
  amend: (kind: OrderRequestKind, facts: { readonly wholeCancel: boolean; readonly revision: number | null }): Words => {
    const done = facts.revision !== null ? { en: ` (revision ${facts.revision})`, it: ` (revisione ${facts.revision})` } : { en: '', it: '' }
    if (kind === 'CANCEL') return facts.wholeCancel ? { en: 'This Accept: the order is cancelled', it: "Questa accettazione: l'ordine viene annullato" } : { en: 'This Accept: the lines asked are closed short', it: 'Questa accettazione: le righe richieste vengono chiuse' }
    if (kind === 'DESIGN') return { en: 'This Accept: the design change is accepted', it: 'Questa accettazione: la modifica del design viene accettata' }
    if (kind === 'SPLIT_SHIPMENT') return { en: 'This Accept: the order ships what is ready first', it: "Questa accettazione: l'ordine spedisce prima ciò che è pronto" }
    return { en: `This Accept: the order is changed as asked${done.en}`, it: `Questa accettazione: l'ordine viene modificato come richiesto${done.it}` }
  },
  /** LOWER_TO_ORDER / MAKE_MORE: "WO-0142: M 40 → 36 · 2 extra pieces already cut". */
  work: (kind: WorkOrderChangeKind, number: string | null, cells: string, extra: number): Words => {
    const who = number ?? null
    const base =
      kind === 'MAKE_MORE'
        ? who === null
          ? { en: `A new work order: ${cells}`, it: `Un nuovo ordine di lavoro: ${cells}` }
          : { en: `${who}: make more, ${cells}`, it: `${who}: produci di più, ${cells}` }
        : { en: `${who ?? 'A work order'}: make ${cells}`, it: `${who ?? 'Un ordine di lavoro'}: produci ${cells}` }
    return extra > 0 ? join([base, { en: `${extra} extra pieces already cut`, it: `${extra} pezzi in più già tagliati` }]) : base
  },
  workBefore: { en: 'After Accept it goes to planning: who manages the work order applies it', it: "Dopo l'accettazione va alla pianificazione: la applica chi gestisce l'ordine di lavoro" } as Words,
  workProposed: (person: string | null): Words => (person ? { en: `Sent to planning: ${person} decides`, it: `Inviato alla pianificazione: decide ${person}` } : { en: 'Sent to planning: who manages the work order decides', it: "Inviato alla pianificazione: decide chi gestisce l'ordine di lavoro" }),
  workRefused: (words: string): Words => ({ en: `The last try was refused: ${words}`, it: `L'ultimo tentativo è stato rifiutato: ${words}` }),
  leftAsIs: (note: string | null): Words => ({ en: `Left as is: ${note ?? ''}`.trim(), it: `Lasciato così: ${note ?? ''}`.trim() }),
  noLongerNeeded: { en: 'No longer needed: the change was put back or replaced by a newer one', it: 'Non serve più: la modifica è stata annullata o sostituita da una più recente' } as Words,
  /** REPROMISE. */
  repromise: (promise: BusinessDate | null, earliest: BusinessDate): Words =>
    promise === null
      ? { en: `Promise: no date yet, earliest ${dayWords(earliest, 'en')}`, it: `Promessa: nessuna data ancora, al più presto il ${dayWords(earliest, 'it')}` }
      : { en: `Promise: promised ${dayWords(promise, 'en')}, earliest now ${dayWords(earliest, 'en')}`, it: `Promessa: promessa il ${dayWords(promise, 'it')}, ora al più presto il ${dayWords(earliest, 'it')}` },
  newDate: { en: 'Promise: a new date for the order', it: "Promessa: una nuova data per l'ordine" } as Words,
  repromiseBefore: { en: 'After Accept: change the promise date, or keep it', it: "Dopo l'accettazione: cambia la data promessa, o tienila" } as Words,
  repromiseWaiting: { en: 'A new date waits for your answer', it: 'Una nuova data aspetta la tua risposta' } as Words,
  repromiseYourTurn: { en: 'Your turn: change the promise date, or keep it', it: 'Tocca a te: cambia la data promessa, o tienila' } as Words,
  /** TELL_WORKSHOP (R8). */
  workshop: (count: number): Words => (count === 1 ? { en: 'Tell the outside workshop that makes it', it: 'Avvisa il terzista che lo produce' } : { en: `Tell the ${count} outside workshops that make it`, it: `Avvisa i ${count} terzisti che lo producono` }),
  workshopWhy: { en: 'The workshop is told on its subcontract order, without the customer’s name', it: 'Il terzista viene avvisato sul suo ordine di lavorazione esterna, senza il nome del cliente' } as Words,
  /** STYLE_CHANGE / ECO (B-SA-047). */
  styleChange: (style: string, number: string | null): Words => (number ? { en: `Style change ${number} for ${style}`, it: `Modifica del modello ${number} per ${style}` } : { en: `A style change for ${style}`, it: `Una modifica del modello per ${style}` }),
  styleBefore: { en: 'Accept raises it for product: the customer’s files stay on the order', it: "L'accettazione la apre per il prodotto: i file del cliente restano sull'ordine" } as Words,
  eco: (style: string): Words => ({ en: `The new design of ${style} released (change order)`, it: `Il nuovo design di ${style} rilasciato (ordine di modifica)` }),
  ecoWaiting: { en: 'Waiting for product: the change order is drafted, approved and released there', it: 'Aspetta il prodotto: lì si prepara, si approva e si rilascia l’ordine di modifica' } as Words,
  ecoRefused: { en: 'Refused by product: the style stays as it is', it: 'Rifiutata dal prodotto: il modello resta com’è' } as Words,
  /** A request that waits no more: refused or withdrawn. */
  closed: (status: RequestStatus): Words =>
    status === 'WITHDRAWN' ? { en: 'Withdrawn by the customer: nothing to do', it: 'Ritirata dal cliente: niente da fare' } : { en: 'Refused: nothing to do', it: 'Rifiutata: niente da fare' },
  /** Somebody else answers this kind (a production ask). */
  production: { en: 'Production answers this ask in Home › Approvals', it: 'A questa richiesta risponde la produzione in Home › Approvazioni' } as Words,
} as const

// ---- On the floor now --------------------------------------------------------------------------------------------------------

/** The asked cells' figures (the order's OWN cells), summed. */
export interface FloorFigures {
  /** Pieces of the asked cells in work orders past their draft. */
  readonly started: number
  readonly cut: number | null
  readonly sewn: number | null
  readonly checked: number | null
  readonly packed: number | null
}

/**
 * Where most of the asked pieces are now, in the customer's plain stage words: the step between two counts that holds the most
 * pieces (null: nothing is in work). A step a site does not count (null) holds nothing here — never a made-up 0 elsewhere.
 */
export function floorStageOf(figures: FloorFigures): BrandStage | null {
  const less = (from: number, minus: number) => Math.max(0, from - minus)
  const cut = figures.cut ?? 0
  const at: [BrandStage, number][] = [
    ['CUTTING', less(figures.started, cut)],
    ['SEWING', figures.sewn === null ? 0 : less(cut, figures.sewn)],
    ['QUALITY', figures.sewn === null ? 0 : less(figures.sewn, figures.checked ?? 0)],
    ['READY', figures.checked === null ? 0 : less(figures.checked, figures.packed ?? 0)],
  ]
  let best: [BrandStage, number] | null = null
  for (const entry of at) if (entry[1] > 0 && (best === null || entry[1] > best[1])) best = entry
  return best ? best[0] : null
}

/** "In work now: 3 bundles at Sewing" (counts only); null when nothing of it is in work. */
export function inWorkWords(bundles: number, stage: BrandStage | null): Words | null {
  if (bundles === 0 && stage === null) return null
  const where = stage ? STAGE_WORDS[stage] : null
  const count = { en: bundles === 1 ? '1 bundle' : `${bundles} bundles`, it: bundles === 1 ? '1 fascio' : `${bundles} fasci` }
  return where ? { en: `In work now: ${count.en} at ${where.en}`, it: `In lavorazione ora: ${count.it} a ${where.it}` } : { en: `In work now: ${count.en}`, it: `In lavorazione ora: ${count.it}` }
}

/** The plain stages a floor figure may name (the customer's own words, production-brand/stages). */
export const FLOOR_STAGES = BRAND_STAGES

// ---- Extra pieces ------------------------------------------------------------------------------------------------------------

export interface OutcomeOption {
  readonly outcome: ExtraOutcome
  readonly words: Words
  /** What it needs beside the accept (null: nothing). */
  readonly needs: OutcomeNeed | null
  readonly needsWords: Words | null
  /** The reader may choose it now. */
  readonly mayChoose: boolean
}

export const OUTCOME_NEED_WORDS: Readonly<Record<OutcomeNeed, Words>> = Object.freeze({
  PRICE_GRAIN: { en: 'Charging the customer needs the right to see prices', it: 'Per addebitare al cliente serve il permesso di vedere i prezzi' },
  SCRAP_APPROVAL: { en: 'The scrap is approved on its own, by who approves scrap', it: 'Lo scarto si approva a parte, da chi approva gli scarti' },
})

/** The three outcomes of extra pieces (R1), in the window's order, with what each needs (Round 4: none is picked for the reader). */
export function outcomeOptionsOf(facts: { readonly customer: string; readonly seesPrices: boolean }): OutcomeOption[] {
  return EXTRA_OUTCOMES.map((outcome) => {
    const needs: OutcomeNeed | null = outcome === 'CHARGE' ? 'PRICE_GRAIN' : outcome === 'SCRAP' ? 'SCRAP_APPROVAL' : null
    return { outcome, words: CHANGE_WORDS.extraOutcome(outcome, facts.customer), needs, needsWords: needs ? OUTCOME_NEED_WORDS[needs] : null, mayChoose: outcome !== 'CHARGE' || facts.seesPrices }
  })
}

// ---- What happens next ------------------------------------------------------------------------------------------------------

/** AMEND: this Accept. Before it TO_DO (or NOT_POSSIBLE with why), after it DONE. */
export function amendStepOf(facts: {
  readonly kind: OrderRequestKind
  readonly status: RequestStatus
  readonly wholeCancel: boolean
  readonly revision: number | null
  /** Why accepting cannot be done as it stands (the record's preview problems, in words); empty: it can. */
  readonly problems: readonly Words[]
  /** The reader may answer this request now (orders.manage, a kind Sales answers, a state it may be accepted in). */
  readonly mayAnswer: boolean
}): ApplyStep {
  const words = APPLY_WORDS.amend(facts.kind, facts)
  if (facts.status === 'ACCEPTED') return { kind: 'AMEND', state: 'DONE', team: 'SALES', words, why: null, mayDoNow: false }
  if (facts.problems.length > 0) return { kind: 'AMEND', state: 'NOT_POSSIBLE', team: 'SALES', words, why: facts.problems[0]!, mayDoNow: false }
  return { kind: 'AMEND', state: 'TO_DO', team: 'SALES', words, why: null, mayDoNow: facts.mayAnswer }
}

/** A work-order change of the plan: PLANNED before Accept (the same planChanges the Accept runs), a stored row after. */
export interface WorkFacts {
  readonly kind: WorkOrderChangeKind
  readonly status: 'PLANNED' | WorkOrderChangeStatus
  /** The work order's number as this reader may read it (null: a new one, or one the reader does not reach). */
  readonly number: string | null
  readonly cells: readonly { readonly size: string; readonly from: number; readonly to: number }[]
  /** Extra pieces it leaves (cut beyond the new figure). */
  readonly extra: number
  readonly decisionNote: string | null
  readonly lastError: string | null
  /** The named person who decides (the work order's supervisor), office only. */
  readonly person: string | null
  /** The reader may apply or decline it now (workorders.manage over its work order, PROPOSED). */
  readonly mayApply: boolean
}

export function workStepOf(facts: WorkFacts): ApplyStep {
  const words = APPLY_WORDS.work(facts.kind, facts.number, CHANGE_WORDS.cells(facts.cells), facts.extra)
  const step = (state: ApplyStepState, why: Words | null, mayDoNow = false): ApplyStep => ({ kind: facts.kind, state, team: 'PLANNER', words, why, mayDoNow })
  switch (facts.status) {
    case 'PLANNED':
      return step('TO_DO', APPLY_WORDS.workBefore)
    case 'PROPOSED':
      return step('PROPOSED', facts.lastError ? APPLY_WORDS.workRefused(facts.lastError) : APPLY_WORDS.workProposed(facts.person), facts.mayApply)
    case 'APPLIED':
      return step('DONE', null)
    case 'DECLINED':
      return step('LEFT_AS_IS', APPLY_WORDS.leftAsIs(facts.decisionNote))
    case 'STALE':
      return step('NOT_POSSIBLE', APPLY_WORDS.noLongerNeeded)
  }
}

/**
 * REPROMISE: the earliest date the change leaves (the impact kept at Send) is later than the promise. Before Accept: TO_DO. After
 * it: a waiting re-promise proposal → PROPOSED; the promise moved to the earliest date or later, or a proposal decided → DONE;
 * else sales' turn (TO_DO). Null: nothing to re-promise.
 */
export function repromiseStepOf(facts: {
  readonly accepted: boolean
  readonly promise: BusinessDate | null
  readonly earliest: BusinessDate | null
  readonly waitingProposals: number
  readonly decidedProposals: number
  /** The reader may change the promise date or answer a re-promise (orders.manage over the order). */
  readonly mayChange: boolean
}): ApplyStep | null {
  const later = facts.earliest !== null && (facts.promise === null || facts.earliest > facts.promise)
  if (!later && facts.waitingProposals === 0 && !(facts.accepted && facts.decidedProposals > 0)) return null
  const words = facts.earliest !== null ? APPLY_WORDS.repromise(facts.promise, facts.earliest) : APPLY_WORDS.newDate
  const step = (state: ApplyStepState, why: Words | null, mayDoNow = false): ApplyStep => ({ kind: 'REPROMISE', state, team: 'SALES', words, why, mayDoNow })
  if (!facts.accepted) return step('TO_DO', APPLY_WORDS.repromiseBefore)
  if (facts.waitingProposals > 0) return step('PROPOSED', APPLY_WORDS.repromiseWaiting, facts.mayChange)
  if (!later || facts.decidedProposals > 0) return step('DONE', null)
  return step('TO_DO', APPLY_WORDS.repromiseYourTurn, facts.mayChange)
}

/** TELL_WORKSHOP (R8): outside workshops make the lines; DONE once each one's notice is written. Null: no workshop makes them. */
export function workshopStepOf(facts: { readonly workshops: number; readonly told: number }): ApplyStep | null {
  if (facts.workshops === 0) return null
  const done = facts.told >= facts.workshops
  return { kind: 'TELL_WORKSHOP', state: done ? 'DONE' : 'TO_DO', team: 'PLANNER', words: APPLY_WORDS.workshop(facts.workshops), why: done ? null : APPLY_WORDS.workshopWhy, mayDoNow: false }
}

// ── B-SA-047 (sales page plan R3, P7; 13-backend B5; review BW-2, BW-3, BW-9): a design change accepted only for the customer's own
// private label — one product change request (CR) per style, then product's change order (ECO) ──

/** Why a style takes no design change from a customer's ask (the office reads it; the customer reads our words only). */
export const DESIGN_HELD = ['OWN_COLLECTION', 'OTHER_LABEL'] as const
export type DesignHeld = (typeof DESIGN_HELD)[number]

export const DESIGN_HELD_WORDS = {
  /** A style of our own collection (Style.brandPartyId null): changing it would change other customers' orders. */
  OWN_COLLECTION: { en: 'This style is in our own collection: a style change would change other customers’ orders. Suggest something else or refuse.', it: 'Questo modello è della nostra collezione: modificarlo cambierebbe gli ordini di altri clienti. Proponi altro o rifiuta.' } as Words,
  /** A style that is not this customer's own label: never named, never whose. */
  OTHER_LABEL: { en: 'This style is not this customer’s own label: a style change would change other orders. Suggest something else or refuse.', it: 'Questo modello non è del marchio di questo cliente: modificarlo cambierebbe altri ordini. Proponi altro o rifiuta.' } as Words,
  /** While no work order makes the line, its options may still change (the line's configurator). */
  options: { en: 'While no work order makes the line, its options can still be changed on the order.', it: "Finché nessun ordine di lavoro produce la riga, le sue opzioni si possono ancora cambiare sull'ordine." } as Words,
} as const

/** Whether a style takes a design change from this customer's ask: only its own private label (R3). */
export const designHeldOf = (style: { readonly brandPartyId: string | null }, partyId: string): DesignHeld | null =>
  style.brandPartyId === partyId ? null : style.brandPartyId === null ? 'OWN_COLLECTION' : 'OTHER_LABEL'

/** The held words of a style, with the options' hint while no work order makes its lines. */
export function designHeldWords(held: DesignHeld, inWork: boolean): Words {
  const base = DESIGN_HELD_WORDS[held]
  return inWork ? base : { en: `${base.en} ${DESIGN_HELD_WORDS.options.en}`, it: `${base.it} ${DESIGN_HELD_WORDS.options.it}` }
}

/** The product change request's title: "Customer design change · <their first words>" (at most 200 characters, the database's). */
export function designTitleOf(words: string): string {
  const head = 'Customer design change · '
  const first = words.trim().replace(/\s+/g, ' ')
  const room = 200 - head.length
  return head + (first.length <= room ? first : `${first.slice(0, room - 1).trimEnd()}…`)
}

/** STYLE_CHANGE: before Accept TO_DO (or NOT_POSSIBLE with why: not this customer's own label); after it DONE, the CR raised. */
export function styleStepOf(facts: { readonly accepted: boolean; readonly style: string; readonly number: string | null; readonly held: Words | null; readonly mayAnswer: boolean }): ApplyStep {
  const words = APPLY_WORDS.styleChange(facts.style, facts.number)
  if (facts.accepted) return { kind: 'STYLE_CHANGE', state: 'DONE', team: 'SALES', words, why: null, mayDoNow: false }
  if (facts.held) return { kind: 'STYLE_CHANGE', state: 'NOT_POSSIBLE', team: 'SALES', words, why: facts.held, mayDoNow: false }
  return { kind: 'STYLE_CHANGE', state: 'TO_DO', team: 'SALES', words, why: APPLY_WORDS.styleBefore, mayDoNow: facts.mayAnswer }
}

/** ECO: the raised CR goes to product — waiting while it is open, DONE once its change order is released (the CR DONE), refused. */
export function ecoStepOf(facts: { readonly style: string; readonly status: string; readonly mayManage: boolean }): ApplyStep {
  const words = APPLY_WORDS.eco(facts.style)
  if (facts.status === 'DONE') return { kind: 'ECO', state: 'DONE', team: 'PRODUCT', words, why: null, mayDoNow: false }
  if (facts.status === 'REJECTED') return { kind: 'ECO', state: 'NOT_POSSIBLE', team: 'PRODUCT', words, why: APPLY_WORDS.ecoRefused, mayDoNow: false }
  return { kind: 'ECO', state: 'PROPOSED', team: 'PRODUCT', words, why: APPLY_WORDS.ecoWaiting, mayDoNow: facts.mayManage }
}
// ── end B-SA-047 ──

// ── B-SA-050 (R1, P6; review C-8): the order's "Still to do" rows, each named by the record that closes it ──
export const STILL_KINDS = ['WORK_ORDER_CHANGE', 'EXTRA_PIECES', 'STYLE_CHANGE', 'WORK_IN_PROGRESS_TASK', 'REPROMISE', 'TELL_WORKSHOP'] as const
export type StillKind = (typeof STILL_KINDS)[number]
// ── end B-SA-050 ──

/** The plan's steps in order, numbered from 1 by the caller's list order (AMEND first). */
export function numbered<T extends ApplyStep>(steps: readonly (T | null)[]): (T & { readonly seq: number })[] {
  return steps.filter((step): step is T => step !== null).map((step, index) => ({ ...step, seq: index + 1 }))
}
