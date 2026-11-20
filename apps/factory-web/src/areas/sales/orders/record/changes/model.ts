import type { BrandRequest } from '../../../../home/approvals/requests/api'
import type { WorkOrderChange } from '../../../../home/approvals/work-order-changes/api' // F-OP-116
import { tabHref } from '../../../../_shared/record-frame/address' // F-OP-116
import type { Amendment } from '../../api'
import { moneyChange } from '../../daily-model'
import type { Change, Confirmation } from '../../depth/api'
import { putBackOffered } from '../../depth/model'
import { ageOf, type Phrase as PartsPhrase } from '../../../../../lib/production/model' // F-OO-204: the parts' own age words

/**
 * F-SA-236 (sales page plan N2, N3, P5; 10-order-page §2.4) — Changes as ONE newest-first story, without a screen: what waits on us
 * (the customer's open requests, oldest first), what waits on the customer (the changed order's new yes, our counter-offers, the
 * approvals we asked), and the history — requests asked and answered, amendments (the one `…/changes` read: priced or not, Put back),
 * confirmations made and sent — filtered by its chips. Only this order's records; money only by grain (the reads drop it).
 */

/** The requests that wait on us (open) or on the customer (our counter-offer), oldest first. */
export function waitingOnUsOf(requests: readonly BrandRequest[]): BrandRequest[] {
  return requests.filter((request) => request.status === 'OPEN' || request.status === 'COUNTERED').sort((a, b) => a.askedAt.localeCompare(b.askedAt))
}

// F-OP-301 (walk #1): what waits on the customer is the ONE waiting list's (overview/model `orderWaitingOf`); its own copy here,
// which disagreed with Overview and the badge, is gone.

// ---- the history ----------------------------------------------------------------------------------------------------------------

// F-OP-117: + Work orders (the work-order changes decided: applied, left as is).
export const HISTORY_CHIPS = ['all', 'requests', 'amendments', 'workOrders', 'confirmations'] as const
export type HistoryChip = (typeof HISTORY_CHIPS)[number]

export type HistoryEntry =
  | { readonly kind: 'requestAsked'; readonly id: string; readonly at: string; readonly request: BrandRequest }
  | { readonly kind: 'requestAnswered'; readonly id: string; readonly at: string; readonly request: BrandRequest }
  | {
      readonly kind: 'amendment'
      readonly id: string
      readonly at: string
      readonly revision: number
      readonly by: string | null
      readonly reason: string
      readonly counts: { readonly changed: number; readonly added: number; readonly removed: number; readonly before: number; readonly after: number }
      /** The net's change (price grain; null without it). */
      readonly money: { readonly delta: number } | null
      readonly priced: boolean
      /** The customer must accept again / accepted / refused (codes of the read). */
      readonly customer: string | null
      /** Put back is offered (the depth's rule: turned down, refused or expired, and the API may); the button holds the right. */
      readonly putBack: boolean
      /** The change as the changes read gave it (a priced change: its fee, extra deposit, the yes it waits for, the customer's answer). */
      readonly change: Change | null
    }
  | { readonly kind: 'confirmationMade'; readonly id: string; readonly at: string; readonly version: number; readonly by: string | null }
  | { readonly kind: 'confirmationSent'; readonly id: string; readonly at: string; readonly version: number }
  /** F-OP-117: a work-order change decided — carried out on its work order, left as is, or put back (stale). */
  | { readonly kind: 'workOrderChange'; readonly id: string; readonly at: string; readonly change: WorkOrderChange }

const chipOf = (entry: HistoryEntry): Exclude<HistoryChip, 'all'> => (entry.kind === 'requestAsked' || entry.kind === 'requestAnswered' ? 'requests' : entry.kind === 'amendment' ? 'amendments' : entry.kind === 'workOrderChange' ? 'workOrders' : 'confirmations')

/** The lines an amendment moved, and the pieces before → after (an amendment's diff or a change's: only what it counts). */
function countsOf(diff: { readonly lines: readonly Pick<Amendment['diff']['lines'][number], 'change' | 'piecesBefore' | 'piecesAfter'>[] }) {
  const counts = { changed: 0, added: 0, removed: 0, before: 0, after: 0 }
  for (const line of diff.lines) {
    if (line.change === 'CHANGED') counts.changed++
    else if (line.change === 'ADDED') counts.added++
    else counts.removed++
    counts.before += line.piecesBefore
    counts.after += line.piecesAfter
  }
  return counts
}

interface HistoryInput {
  readonly requests: readonly BrandRequest[]
  /** The order's changes (the ONE read of `…/changes`: amendments with their priced part); null: not read here. */
  readonly changes: readonly Change[] | null
  /** The amendments read (only where the changes read is not there: a design case, an older page). */
  readonly amendments: readonly Amendment[] | null
  readonly confirmation: Confirmation | null
  /** F-OP-117: the order's work-order changes (the decided ones become history); absent or null: not read here. */
  readonly workOrderChanges?: readonly WorkOrderChange[] | null
}

/** Every event of the order's changes, newest first. */
export function historyOf(input: HistoryInput): HistoryEntry[] {
  const out: HistoryEntry[] = []
  for (const request of input.requests) {
    out.push({ kind: 'requestAsked', id: `asked-${request.id}`, at: request.askedAt, request })
    const answeredAt = request.answeredAt ?? request.withdrawnAt
    if (answeredAt && request.status !== 'OPEN') out.push({ kind: 'requestAnswered', id: `answered-${request.id}`, at: answeredAt, request })
  }
  if (input.changes) {
    for (const change of input.changes) {
      const delta = change.changeAmount
      out.push({
        kind: 'amendment',
        id: change.id,
        at: change.createdAt,
        revision: change.revision,
        by: change.createdBy,
        reason: change.reason,
        counts: countsOf(change.diff),
        money: delta === undefined ? null : { delta },
        priced: change.priced,
        customer: change.customer.decision,
        putBack: putBackOffered(change),
        change,
      })
    }
  } else if (input.amendments) {
    for (const amendment of input.amendments) {
      const change = moneyChange(amendment.diff)
      out.push({ kind: 'amendment', id: amendment.id, at: amendment.createdAt, revision: amendment.revision, by: amendment.createdBy, reason: amendment.reason, counts: countsOf(amendment.diff), money: change ? { delta: change.delta } : null, priced: false, customer: amendment.reacceptance, putBack: false, change: null })
    }
  }
  for (const version of input.confirmation?.versions ?? []) out.push({ kind: 'confirmationMade', id: `made-${version.id}`, at: version.createdAt, version: version.version, by: version.createdBy })
  if (input.confirmation?.sentAt && input.confirmation.sentVersion !== null) out.push({ kind: 'confirmationSent', id: `sent-${input.confirmation.sentVersion}`, at: input.confirmation.sentAt, version: input.confirmation.sentVersion })
  // F-OP-117: a decided work-order change, at its decision (a PROPOSED one waits: it is the section's row, not history yet).
  for (const change of input.workOrderChanges ?? []) if (change.status !== 'PROPOSED') out.push({ kind: 'workOrderChange', id: `woc-${change.id}`, at: change.decidedAt ?? change.proposedAt, change })
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
}

/** The entries a chip shows (All: every entry). */
export const historyFor = (entries: readonly HistoryEntry[], chip: HistoryChip): HistoryEntry[] => (chip === 'all' ? [...entries] : entries.filter((entry) => chipOf(entry) === chip))

// ---- F-SA-243 (sales page plan P5, R1; 14-change-flow §3.1, §3.4; review R-5): the order page's doors to the ONE review window ----
/**
 * The order page opens the same review window as Home › Approvals (requests/use-request-review-door.ts), from three places — the band
 * notice "<Customer> asks: … · Answer…" (ONE banner, "N more requests"), Overview's "Waiting on us: N · Answer…" and Changes › Waiting
 * on us — and it keeps "Still to do" after each accepted change (B-SA-050's rows, computed from the records) until every row is done
 * or left as is: Overview's top 3, Changes' rows under each change, and the band notice "Change of hh:mm: 1 step needs a decision ·
 * Open" ONLY while a row is Your turn or Needs a decision for this reader (14's narrow rule, review R-5). Only this order's records.
 */

/** The requests that wait on US (not on the customer), oldest first: the band notice names the first, counts the rest. */
export function askingOf(requests: readonly BrandRequest[]): { readonly first: BrandRequest; readonly more: number } | null {
  const onUs = waitingOnUsOf(requests).filter((request) => request.waitingOn === 'US')
  return onUs.length > 0 ? { first: onUs[0]!, more: onUs.length - 1 } : null
}

type Say = (key: string, params?: Record<string, string | number>) => string

/**
 * What a request asks, in words for the band notice: its kind, then each size asked old → new ("line 2 · M 40 → 36"), at most three,
 * "…" after; a whole-order cancel, a date. Never a price, never another order.
 */
export function askWordsOf(request: Pick<BrandRequest, 'kind' | 'cells' | 'wholeOrder' | 'requestedDate'>, words: { readonly kind: string; readonly say: Say; readonly day: (value: string) => string }): string {
  const cells = request.cells.map((cell) => (cell.size === null ? words.say('band.askLine', { line: cell.seq }) : words.say('band.askCell', { line: cell.seq, size: cell.size, from: cell.before, to: cell.askedColourway ? `${cell.asked} ${cell.askedColourway.name}` : cell.asked })))
  const parts = [words.kind, ...cells.slice(0, 3), ...(cells.length > 3 ? ['…'] : [])]
  if (request.wholeOrder) parts.push(words.say('band.askWhole'))
  if (request.requestedDate && cells.length === 0) parts.push(words.day(request.requestedDate))
  return parts.join(' · ')
}

// ---- F-OO-204 (11-design §5.2): how long a waiting row waits ----------------------------------------------------------------------
/**
 * A waiting row's age ("15 d", "4 h", "12 min": the parts' `parts.age.*`), counted to the time of the production read that listed it
 * (its "as of": the rows and their age are one read); no read yet: to now. A start after that time (an open yes the order read named
 * after it) is the shortest age, never a negative one; no start known: null (the row says "—").
 */
export function rowAgeOf(since: string | null | undefined, asOf: string | null | undefined, now: number = Date.now()): PartsPhrase | null {
  const at = since ? Date.parse(since) : NaN
  if (!Number.isFinite(at)) return null
  const read = asOf ? Date.parse(asOf) : NaN
  return ageOf(since, Math.max(Number.isFinite(read) ? read : now, at))
}
// ---- end F-OO-204

/** "Still to do" in the order's production read (none read yet, or no right: none — never claimed). */
export const stillRowsOf = (read: { readonly changes?: { readonly stillToDo?: { readonly rows: readonly StillRowOf[] } | undefined } | undefined } | null | undefined): StillRowOf[] => [...(read?.changes?.stillToDo?.rows ?? [])]

export interface StillRowOf {
  readonly kind: string
  /** F-OP-116 (B-OP-021): + the record's version (a task's Done sends it); null or absent: none. */
  readonly ref: { readonly type: string; readonly id: string; readonly number: string | null; readonly version?: number | null } | null
  readonly words: { readonly en: string; readonly it: string }
  readonly since: string
  readonly waitingOn: string
  readonly mayAct: boolean
  readonly requestId: string | null
}

/** The rows that ask THIS reader now (Your turn / Needs a decision): the only ones the band may name (R-5). */
export const askingMe = (row: Pick<StillRowOf, 'mayAct'>): boolean => row.mayAct

/** The band's "Change of hh:mm: N steps need a decision · Open": the rows asking this reader, from the oldest; null: none. */
export function decisionBandOf(rows: readonly StillRowOf[]): { readonly count: number; readonly since: string; readonly requestId: string | null } | null {
  const mine = rows.filter(askingMe).sort((a, b) => a.since.localeCompare(b.since))
  return mine.length > 0 ? { count: mine.length, since: mine[0]!.since, requestId: mine[0]!.requestId } : null
}

/** One accepted change and its rows (the customer's request it carries out; null: the office's own change). */
export interface StillGroup {
  readonly requestId: string | null
  /** The request when this page read it (its kind and when it was answered); null: an office change, or not read. */
  readonly request: BrandRequest | null
  readonly since: string
  readonly rows: readonly StillRowOf[]
}

/** The rows under each change, the oldest change first; inside, the order the API gave (its own: by kind, then since). */
export function stillGroupsOf(rows: readonly StillRowOf[], requests: readonly BrandRequest[]): StillGroup[] {
  const groups = new Map<string, StillRowOf[]>()
  for (const row of rows) groups.set(row.requestId ?? '', [...(groups.get(row.requestId ?? '') ?? []), row])
  return [...groups.entries()]
    .map(([key, list]) => {
      const request = key ? (requests.find((entry) => entry.id === key) ?? null) : null
      return { requestId: key || null, request, since: request?.answeredAt ?? list.map((row) => row.since).sort()[0]!, rows: list }
    })
    .sort((a, b) => a.since.localeCompare(b.since))
}

/** Where a row opens (a real link): the work-order change in Approvals' window, the amendment on Changes, the record's own page. */
// F-OP-116 (F-OP-210, R-19): the order's own tabs through tabHref — the dock's scope kept (`search`: the page's address terms now).
export function stillDoorOf(row: Pick<StillRowOf, 'kind' | 'ref'>, place: { readonly prefix: string; readonly record: string; readonly address: (ref: { readonly type: string; readonly id: string; readonly number: string | null }) => string; readonly search?: string }): string | null {
  const ref = row.ref
  if (!ref) return null
  if (ref.type === 'WorkOrderChange') return `${place.prefix}/home/approvals?open=${encodeURIComponent(ref.id)}`
  if (ref.type === 'SalesOrderAmendment') return tabHref(place.record, 'changes', place.search ?? '')
  if (ref.type === 'RePromise') return tabHref(place.record, 'overview', place.search ?? '')
  return `${place.prefix}${place.address(ref)}`
}
// ---- end F-SA-243

// ---- F-OP-116 (10-order-page §5.2, §5.3; review R-12): decide in place ------------------------------------------------------------
/** The changes waiting on one work order (PROPOSED), the oldest first: its row says "Change waits: 40 → 28 · Apply… / Leave as is…". */
export function waitingChangesOf(list: readonly WorkOrderChange[] | null | undefined, workOrderId: string): WorkOrderChange[] {
  return (list ?? []).filter((change) => change.status === 'PROPOSED' && change.workOrder?.id === workOrderId).sort((a, b) => a.proposedAt.localeCompare(b.proposedAt) || a.id.localeCompare(b.id))
}

/** A change's pieces before → after (its cells summed: what the work order makes now for them, what it would make). */
export function changeFiguresOf(change: Pick<WorkOrderChange, 'cells'>): { readonly before: number; readonly after: number } {
  return change.cells.reduce((sum, cell) => ({ before: sum.before + cell.from, after: sum.after + cell.to }), { before: 0, after: 0 })
}

/** Why a change cannot be decided by this reader: a planner decides it (told when it was proposed); null: this reader may. */
export function changeHeldOf(change: Pick<WorkOrderChange, 'mayDecide' | 'proposedAt'>): { readonly key: string; readonly params: { readonly at: string } } | null {
  return change.mayDecide ? null : { key: 'wo.waitsPlanner', params: { at: change.proposedAt } }
}

/** One Still to do row's door, in place where it can be: a work-order change decided here, a re-promise answered here, a task done
 * here (its own right, R-12), else a real link to where it is done (Scrap, Products, Subcontracting, Changes). */
export type StillDoor =
  | { readonly kind: 'change'; readonly changeId: string; readonly held: boolean }
  | { readonly kind: 'repromise'; readonly proposalId: string; readonly held: boolean }
  | { readonly kind: 'task'; readonly taskId: string; readonly version: number | null; readonly held: boolean }
  | { readonly kind: 'link'; readonly href: string; readonly label: 'scrap' | 'products' | 'subcontracting' | 'open' }
  | { readonly kind: 'none' }

export function stillDoorsOf(row: Pick<StillRowOf, 'kind' | 'ref' | 'mayAct'>, place: Parameters<typeof stillDoorOf>[1]): StillDoor {
  const ref = row.ref
  if (!ref) return { kind: 'none' }
  if (row.kind === 'WORK_ORDER_CHANGE' && ref.type === 'WorkOrderChange') return { kind: 'change', changeId: ref.id, held: !row.mayAct }
  if (row.kind === 'REPROMISE' && ref.type === 'RePromise') return { kind: 'repromise', proposalId: ref.id, held: !row.mayAct }
  if (row.kind === 'WORK_IN_PROGRESS_TASK' && ref.type === 'Task') return { kind: 'task', taskId: ref.id, version: ref.version ?? null, held: !row.mayAct }
  const href = stillDoorOf(row, place)
  if (!href) return { kind: 'none' }
  const label = row.kind === 'EXTRA_PIECES' && ref.type === 'WorkOrder' ? 'scrap' : row.kind === 'STYLE_CHANGE' ? 'products' : row.kind === 'TELL_WORKSHOP' ? 'subcontracting' : 'open'
  return { kind: 'link', href, label }
}
// ---- end F-OP-116

// ---- F-OP-117 (10-order-page §6): the Changes tab's "Work-order changes of this order" ---------------------------------------------
/** The section's rows: the PROPOSED first (oldest first: they wait), then the decided ones newest first; nothing of another order. */
export function workOrderChangeRowsOf(list: readonly WorkOrderChange[] | null | undefined, orderId: string): WorkOrderChange[] {
  const own = (list ?? []).filter((change) => change.salesOrder.id === orderId)
  const waiting = own.filter((change) => change.status === 'PROPOSED').sort((a, b) => a.proposedAt.localeCompare(b.proposedAt) || a.id.localeCompare(b.id))
  const decided = own.filter((change) => change.status !== 'PROPOSED').sort((a, b) => (b.decidedAt ?? b.proposedAt).localeCompare(a.decidedAt ?? a.proposedAt) || a.id.localeCompare(b.id))
  return [...waiting, ...decided]
}

/** When the floor was told of an applied change (the floor note goes with it: change-notes); null for one not carried out. */
export const floorToldOfChange = (change: Pick<WorkOrderChange, 'status' | 'decidedAt' | 'workOrder'>): string | null => (change.status === 'APPLIED' && change.workOrder && change.decidedAt ? change.decidedAt : null)
// ---- end F-OP-117
