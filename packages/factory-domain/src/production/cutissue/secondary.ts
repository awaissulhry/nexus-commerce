import type { Language } from '../../inventory/rolls/rolls'
import { orderStop, type RecutWorkOrder } from '../rework/recut'

/**
 * Secondary processes after cutting (B-W2b-117; MES-047 "Secondary processes after cutting"; design floor.fabriccut "Send to
 * sewing": "Secondary processes (fusing, perforation, embroidery) as a route step"), pure. A bundle may pass fusing, perforation,
 * print, embroidery (or another process) after it is cut and before it goes to sewing: each is a SecondaryProcess of the bundle
 * (B-W2b-85), done IN_HOUSE at a work centre of the site or OUTSIDE under a subcontract order of the work order.
 *
 *   add      the office or the cutting room gives one or more bundles a process: an ACTIVE bundle of a RELEASED or IN_PROGRESS
 *            work order, on as many of its garments as it carries (default: all); one open process of a kind per bundle; not
 *            once the bundle is on a trolley to a line. In house: the work centre (ACTIVE, of the site) may wait until it starts.
 *   start    WAITING → IN_PROGRESS (in house: at the work centre; outside: sent, naming its subcontract order: an issued order of
 *            the same work order that is not received, closed or cancelled — from the office, the floor does not read orders)
 *   done     IN_PROGRESS → DONE (in house: finished; outside: back from the workshop)
 *   cancel   WAITING or IN_PROGRESS → CANCELLED with the reason
 *
 * Start and done take the work order's gate (never while it is ON_HOLD; the database's factory_work_order_gate too). A bundle
 * goes onto a trolley to sewing only when none of its processes waits or runs (./trolley.ts): the processes are a route step.
 * Nothing here carries money (an outside process's fee stays on its subcontract order) or names a person.
 */

export const SECONDARY_KINDS = ['FUSING', 'PERFORATION', 'PRINT', 'EMBROIDERY', 'OTHER'] as const
export type SecondaryKind = (typeof SECONDARY_KINDS)[number]
export const SECONDARY_PLACES = ['IN_HOUSE', 'OUTSIDE'] as const
export type SecondaryPlace = (typeof SECONDARY_PLACES)[number]
export const SECONDARY_STATUSES = ['WAITING', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const
export type SecondaryStatus = (typeof SECONDARY_STATUSES)[number]
/** A process the bundle still waits for or is in. */
export const OPEN_SECONDARY_STATUSES = ['WAITING', 'IN_PROGRESS'] as const satisfies readonly SecondaryStatus[]
export const SECONDARY_MOVES = ['start', 'done', 'cancel'] as const
export type SecondaryMove = (typeof SECONDARY_MOVES)[number]

export const SECONDARY_LIMITS = Object.freeze({
  /** Bundles given a process in one request. */
  bundles: 100,
  note: 500,
  reason: 300,
  /** Rows of a list. */
  rows: 200,
  /** The gap between two processes' places on a bundle. */
  seqStep: 10,
})

/** The subcontract order statuses an outside process is sent under: issued and not yet fully back, closed or cancelled. */
export const SENDABLE_SUBCONTRACT_STATUSES = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] as const

export const SECONDARY_REFUSALS = [
  'WORK_ORDER_NOT_OPEN',
  'WORK_ORDER_ON_HOLD',
  'BUNDLE_NOT_ACTIVE',
  'MORE_THAN_BUNDLE',
  'KIND_OPEN_ALREADY',
  'ON_A_TROLLEY',
  'NOT_A_WORK_CENTRE',
  'WORK_CENTRE_OUTSIDE',
  'WRONG_STATE',
  'SUBCONTRACT_NEEDED',
  'SUBCONTRACT_NOT_SENDABLE',
  'OUTSIDE_FROM_OFFICE',
] as const
export type SecondaryRefusalCode = (typeof SECONDARY_REFUSALS)[number]

export interface SecondaryRefusal {
  readonly code: SecondaryRefusalCode
  readonly message: string
}

const KIND_WORDS: Readonly<Record<Language, Readonly<Record<SecondaryKind, string>>>> = Object.freeze({
  it: { FUSING: 'termoadesivatura', PERFORATION: 'foratura', PRINT: 'stampa', EMBROIDERY: 'ricamo', OTHER: 'altra lavorazione' },
  en: { FUSING: 'fusing', PERFORATION: 'perforation', PRINT: 'print', EMBROIDERY: 'embroidery', OTHER: 'another process' },
})

/** The process in words ("fusing"), lower case. */
export const kindWords = (kind: SecondaryKind, language: Language): string => KIND_WORDS[language][kind]

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export interface ProcessFacts {
  readonly kind: SecondaryKind
  readonly place: SecondaryPlace
  readonly status: SecondaryStatus
}

export interface AddFacts {
  readonly workOrder: RecutWorkOrder
  readonly bundle: { readonly code: string; readonly status: string; readonly live: number }
  readonly kind: SecondaryKind
  readonly place: SecondaryPlace
  /** Garments it is done on (default: the bundle's). */
  readonly quantity: number
  /** IN_HOUSE: the work centre named (null: not yet given), active and of the site. OUTSIDE: none may be named. */
  readonly workCentre: { readonly code: string; readonly ok: boolean } | null
  /** The bundle's processes as they stand. */
  readonly processes: readonly ProcessFacts[]
  /** The bundle is on a trolley that is loading, on its way or received. */
  readonly onTrolley: string | null
}

/** Why a bundle does not take this process (null: it does). */
export function addRefusal(facts: AddFacts): SecondaryRefusal | null {
  const stop = orderStop(facts.workOrder, { held: 'its bundles take no process until the hold is lifted', closed: 'secondary processes are for bundles of released or running work orders' })
  if (stop) return stop
  if (facts.bundle.status !== 'ACTIVE') return { code: 'BUNDLE_NOT_ACTIVE', message: `Bundle ${facts.bundle.code} is voided: it takes no process.` }
  if (facts.quantity < 1 || facts.quantity > facts.bundle.live) {
    return { code: 'MORE_THAN_BUNDLE', message: `Bundle ${facts.bundle.code} carries ${plural(facts.bundle.live, 'garment')}: a process is done on 1 to ${facts.bundle.live}; ${facts.quantity} asked.` }
  }
  if (facts.onTrolley) return { code: 'ON_A_TROLLEY', message: `Bundle ${facts.bundle.code} is on trolley ${facts.onTrolley} to sewing: it takes no process after cutting now.` }
  if (facts.processes.some((process) => process.kind === facts.kind && (OPEN_SECONDARY_STATUSES as readonly string[]).includes(process.status))) {
    return { code: 'KIND_OPEN_ALREADY', message: `Bundle ${facts.bundle.code} already waits for ${kindWords(facts.kind, 'en')}.` }
  }
  if (facts.place === 'OUTSIDE' && facts.workCentre) return { code: 'WORK_CENTRE_OUTSIDE', message: 'An outside process is done at a workshop, not at a work centre of the site.' }
  if (facts.workCentre && !facts.workCentre.ok) return { code: 'NOT_A_WORK_CENTRE', message: `Work centre ${facts.workCentre.code} is not an active work centre of this site.` }
  return null
}

export interface MoveFacts {
  readonly workOrder: RecutWorkOrder
  readonly process: ProcessFacts & { readonly bundleCode: string }
  /** The caller is a floor tablet. */
  readonly floor: boolean
  /** start, IN_HOUSE: the work centre named or kept (null: none), active and of the site. */
  readonly workCentre: { readonly code: string; readonly ok: boolean } | null
  /** start, OUTSIDE: the subcontract order named (null: none): of the process's work order, and its status. */
  readonly subcontract: { readonly number: string; readonly sameWorkOrder: boolean; readonly status: string } | null
}

/** Why the move is refused (null: it is made). */
export function moveRefusal(move: SecondaryMove, facts: MoveFacts): SecondaryRefusal | null {
  const { process } = facts
  const what = `${kindWords(process.kind, 'en')} of bundle ${process.bundleCode}`
  const allowed = move === 'start' ? process.status === 'WAITING' : move === 'done' ? process.status === 'IN_PROGRESS' : process.status === 'WAITING' || process.status === 'IN_PROGRESS'
  if (!allowed) {
    const why = process.status === 'WAITING' ? 'waits: start it first' : process.status === 'IN_PROGRESS' ? 'is in progress already' : `is ${process.status.toLowerCase()}`
    return { code: 'WRONG_STATE', message: `The ${what} ${why}.` }
  }
  if (move === 'cancel') return null
  const stop = orderStop(facts.workOrder, { held: 'its processes move on once the hold is lifted', closed: 'its processes move on while it is released or running' })
  if (stop) return stop
  if (move === 'start' && process.place === 'IN_HOUSE' && facts.workCentre && !facts.workCentre.ok) {
    return { code: 'NOT_A_WORK_CENTRE', message: `Work centre ${facts.workCentre.code} is not an active work centre of this site.` }
  }
  if (move === 'start' && process.place === 'OUTSIDE') {
    if (facts.floor) return { code: 'OUTSIDE_FROM_OFFICE', message: `The ${what} is sent to the workshop from the office, with its subcontract order.` }
    if (!facts.subcontract) return { code: 'SUBCONTRACT_NEEDED', message: `Name the subcontract order the ${what} is sent under.` }
    if (!facts.subcontract.sameWorkOrder || !(SENDABLE_SUBCONTRACT_STATUSES as readonly string[]).includes(facts.subcontract.status)) {
      return { code: 'SUBCONTRACT_NOT_SENDABLE', message: `Subcontract order ${facts.subcontract.number} ${facts.subcontract.sameWorkOrder ? `is ${facts.subcontract.status.toLowerCase().replace('_', ' ')}` : 'is of another work order'}: send it under an issued order of its work order.` }
    }
  }
  return null
}

export interface BundleProcess extends ProcessFacts {
  readonly id: string
  readonly seq: number
  readonly workCentreId: string | null
}

/** The bundle's processes still to pass, in their order. */
export function pendingOf<T extends BundleProcess>(processes: readonly T[]): T[] {
  return processes.filter((process) => (OPEN_SECONDARY_STATUSES as readonly string[]).includes(process.status)).sort((a, b) => a.seq - b.seq)
}

/**
 * What a scan of the bundle does next at this tablet: the open process of the tablet's work centre first (else the first open
 * one), DONE when it runs, START when it waits; null when none is open. An outside process waits for the office.
 */
export function nextProcessOf<T extends BundleProcess>(processes: readonly T[], workCentreId: string | null): { readonly process: T; readonly move: 'start' | 'done' } | null {
  const pending = pendingOf(processes)
  const here = workCentreId ? pending.find((process) => process.workCentreId === workCentreId) : undefined
  const process = here ?? pending.find((row) => row.status === 'IN_PROGRESS') ?? pending[0]
  if (!process) return null
  return { process, move: process.status === 'IN_PROGRESS' ? 'done' : 'start' }
}

/** "Bundle BN-… waits for fusing, embroidery: it goes to sewing after them." (null: nothing pending). */
export function pendingWords(bundleCode: string, pending: readonly Pick<ProcessFacts, 'kind'>[], language: Language): string | null {
  if (pending.length === 0) return null
  const kinds = [...new Set(pending.map((process) => kindWords(process.kind, language)))].join(', ')
  return language === 'it' ? `Il fascio ${bundleCode} attende: ${kinds}. Va al cucito dopo.` : `Bundle ${bundleCode} waits for ${kinds}: it goes to sewing after ${pending.length === 1 ? 'it' : 'them'}.`
}
