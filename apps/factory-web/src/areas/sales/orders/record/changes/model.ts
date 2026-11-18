import type { BrandRequest } from '../../../../home/approvals/requests/api'
import type { OfficeRequest } from '../../../../../record-panels/approvals/api'
import type { Amendment, Order } from '../../api'
import { moneyChange } from '../../daily-model'
import type { Change, Confirmation } from '../../depth/api'
import { putBackOffered } from '../../depth/model'

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

export interface CustomerWait {
  readonly id: string
  readonly kind: 'reaccept' | 'counter' | 'approval'
  /** An approval's question as we asked it (our words). */
  readonly question: string | null
  readonly since: string | null
  readonly dueAt: string | null
  /** An approval's state code (record-approvals status.*); null for the others. */
  readonly status: string | null
}

/** What we asked the customer and they have not answered: the new yes of a changed order, a counter-offer, an approval still open. */
export function waitingOnCustomerOf(requests: readonly BrandRequest[], approvals: readonly OfficeRequest[], order: Pick<Order, 'id' | 'reapprovalNeededAt'>): CustomerWait[] {
  const out: CustomerWait[] = []
  if (order.reapprovalNeededAt) out.push({ id: `reaccept-${order.id}`, kind: 'reaccept', question: null, since: order.reapprovalNeededAt, dueAt: null, status: null })
  for (const request of requests) if (request.status === 'COUNTERED' && request.counter) out.push({ id: `counter-${request.id}`, kind: 'counter', question: null, since: request.counter.at, dueAt: null, status: null })
  for (const approval of approvals) if (approval.status === 'OPEN' && approval.kind !== 'COUNTER_OFFER') out.push({ id: approval.id, kind: 'approval', question: approval.question, since: approval.createdAt, dueAt: approval.dueAt, status: approval.status })
  return out
}

// ---- the history ----------------------------------------------------------------------------------------------------------------

export const HISTORY_CHIPS = ['all', 'requests', 'amendments', 'confirmations'] as const
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

const chipOf = (entry: HistoryEntry): Exclude<HistoryChip, 'all'> => (entry.kind === 'requestAsked' || entry.kind === 'requestAnswered' ? 'requests' : entry.kind === 'amendment' ? 'amendments' : 'confirmations')

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

/** "Still to do" in the order's production read (none read yet, or no right: none — never claimed). */
export const stillRowsOf = (read: { readonly changes?: { readonly stillToDo?: { readonly rows: readonly StillRowOf[] } | undefined } | undefined } | null | undefined): StillRowOf[] => [...(read?.changes?.stillToDo?.rows ?? [])]

export interface StillRowOf {
  readonly kind: string
  readonly ref: { readonly type: string; readonly id: string; readonly number: string | null } | null
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
export function stillDoorOf(row: Pick<StillRowOf, 'kind' | 'ref'>, place: { readonly prefix: string; readonly record: string; readonly address: (ref: { readonly type: string; readonly id: string; readonly number: string | null }) => string }): string | null {
  const ref = row.ref
  if (!ref) return null
  if (ref.type === 'WorkOrderChange') return `${place.prefix}/home/approvals?open=${encodeURIComponent(ref.id)}`
  if (ref.type === 'SalesOrderAmendment') return `${place.record}?tab=changes`
  if (ref.type === 'RePromise') return `${place.record}?tab=overview`
  return `${place.prefix}${place.address(ref)}`
}
// ---- end F-SA-243
