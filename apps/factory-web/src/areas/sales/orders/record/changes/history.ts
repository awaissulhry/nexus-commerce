import type { BrandRequest } from '../../../../home/approvals/requests/api'
import type { WorkOrderChange } from '../../../../home/approvals/work-order-changes/api'
import type { Amendment } from '../../api'
import type { Change, Confirmation } from '../../depth/api'
import { changeCounts, putBackOffered } from '../../depth/model'
import { toldOfHistory, type ToldChange } from '../told'

/**
 * F-OC-301 / 302 (order CHANGES tab, 10-design §5; 13-backend B-OC-009 … 012, 014; 18-lead-settles L12) — section 3, What changed,
 * without a screen: ONE row per change, newest first — the customer's request together with the revision it became (only by the
 * changes read's `changeRequestId`, never by time), a revision with its work-order changes (only by their `amendmentId`), a decided
 * work-order change no revision carried, every confirmation made and sent, and the kinds the told read's speaker names (the order
 * cancelled, lines closed or reopened, a work order paused or its pause lifted, a style change released). Each row its Told line by
 * the speaker's own ids (an older line without a speaker: the old match). Chips are FILTERS with counts; a row may be in two
 * ("Revisions" = every row that made a revision, the customer's requests done as one too — L12).
 */

export const HISTORY_CHIPS = ['all', 'requests', 'revisions', 'workOrders', 'confirmations'] as const
export type HistoryChip = (typeof HISTORY_CHIPS)[number]
export type RowChip = Exclude<HistoryChip, 'all'>

/** The chip an address asks for (`?history=revisions`); anything else: All. */
export const historyChipOf = (value: string | null | undefined): HistoryChip => ((HISTORY_CHIPS as readonly string[]).includes(value ?? '') ? (value as HistoryChip) : 'all')

/** The newest rows open; the earlier ones behind "Show N earlier changes". */
export const HISTORY_OPEN = 5

/** A revision as a row tells it: the ONE changes read's (its priced part, our yes, the customer's answer, Restore) or, on a design case
 * or an older page, the amendments read's. */
export interface RevisionFacts {
  readonly id: string
  readonly revision: number
  readonly at: string
  readonly by: string | null
  readonly reason: string
  readonly reasonCode: 'AUTOMATIC' | 'REQUEST' | 'PUT_BACK' | null
  readonly counts: { readonly changed: number; readonly added: number; readonly removed: number; readonly before: number; readonly after: number }
  readonly lines: number
  /** The changes read's change (null: drawn from the amendments read — no yes, no answer, no Restore). */
  readonly change: Change | null
}

type Base = { readonly id: string; readonly at: string; readonly chips: readonly RowChip[] }
export type ChangeRow =
  | (Base & { readonly kind: 'request'; readonly request: BrandRequest; readonly revision: RevisionFacts | null; readonly workOrderChanges: readonly WorkOrderChange[]; readonly told: ToldChange | null })
  | (Base & { readonly kind: 'revision'; readonly revision: RevisionFacts; readonly latest: boolean; readonly workOrderChanges: readonly WorkOrderChange[]; readonly told: ToldChange | null })
  | (Base & { readonly kind: 'workOrderChange'; readonly change: WorkOrderChange; readonly told: ToldChange | null })
  | (Base & { readonly kind: 'confirmationMade'; readonly version: number; readonly by: string | null })
  | (Base & { readonly kind: 'confirmationSent'; readonly version: number; readonly to: readonly string[]; readonly by: string | null })
  | (Base & { readonly kind: 'cancelled' | 'linesClosed' | 'linesReopened' | 'paused' | 'pauseLifted' | 'styleReleased'; readonly told: ToldChange })

export interface HistoryInput {
  readonly requests: readonly BrandRequest[]
  /** The ONE changes read's changes; null: not read here (a design case, an older page) — the amendments read draws the revisions. */
  readonly changes: readonly Change[] | null
  readonly amendments: readonly Amendment[] | null
  readonly confirmation: Confirmation | null
  readonly workOrderChanges: readonly WorkOrderChange[] | null
  readonly told: readonly ToldChange[]
}

function factsOfChange(change: Change): RevisionFacts {
  return { id: change.id, revision: change.revision, at: change.createdAt, by: change.createdBy, reason: change.reason, reasonCode: change.reasonCode ?? null, counts: changeCounts(change), lines: change.diff.lines.length, change }
}

function factsOfAmendment(amendment: Amendment): RevisionFacts {
  return { id: amendment.id, revision: amendment.revision, at: amendment.createdAt, by: amendment.createdBy, reason: amendment.reason, reasonCode: null, counts: changeCounts(amendment), lines: amendment.diff.lines.length, change: null }
}

/** The told line of a change by the speaker's own ids; a line written before the speaker was kept: the old match (null: none). */
function toldBy(told: readonly ToldChange[], match: (speaker: NonNullable<ToldChange['speaker']>) => boolean, legacy: { readonly kind: string; readonly at: string; readonly requestId?: string | null } | null): ToldChange | null {
  const spoken = told.find((change) => !!change.speaker && match(change.speaker))
  if (spoken) return spoken
  return legacy ? toldOfHistory(legacy, told.filter((change) => !change.speaker)) : null
}

const SPEAKER_KINDS: Readonly<Record<string, (speaker: NonNullable<ToldChange['speaker']>) => Extract<ChangeRow, { told: ToldChange }>['kind'] | null>> = Object.freeze({
  CANCELLED: () => 'cancelled',
  LINES: (speaker) => (speaker.change === 'REOPENED' ? 'linesReopened' : 'linesClosed'),
  HOLD: (speaker) => (speaker.hold?.placed === false ? 'pauseLifted' : 'paused'),
  ECO: () => 'styleReleased',
})

export function changeRowsOf(input: HistoryInput): ChangeRow[] {
  const revisions: RevisionFacts[] = input.changes ? input.changes.map(factsOfChange) : (input.amendments ?? []).map(factsOfAmendment)
  const latestRevision = revisions.reduce((top, entry) => Math.max(top, entry.revision), 0)
  const decided = (input.workOrderChanges ?? []).filter((change) => change.status !== 'PROPOSED')
  const requestIds = new Set(input.requests.map((request) => request.id))
  const carried = new Set<string>()
  const rows: ChangeRow[] = []
  // The customer's requests, each with the revision it became (B-OC-010 `changeRequestId`) and the work-order changes it proposed.
  for (const request of input.requests) {
    const revision = revisions.find((entry) => entry.change?.changeRequestId === request.id) ?? null
    const workOrderChanges = decided.filter((change) => change.requestId === request.id || (revision !== null && change.amendmentId === revision.id))
    for (const change of workOrderChanges) carried.add(change.id)
    rows.push({
      kind: 'request',
      id: request.id,
      at: request.answeredAt ?? request.withdrawnAt ?? request.askedAt,
      chips: revision ? ['requests', 'revisions', ...(workOrderChanges.length > 0 ? (['workOrders'] as const) : [])] : ['requests', ...(workOrderChanges.length > 0 ? (['workOrders'] as const) : [])],
      request,
      revision,
      workOrderChanges,
      told: toldBy(input.told, (speaker) => speaker.kind === 'REQUEST' && speaker.requestId === request.id, request.status === 'OPEN' ? null : { kind: 'requestAnswered', at: request.answeredAt ?? request.askedAt, requestId: request.id }),
    })
  }
  // The office's own revisions (and a request's revision whose request this page did not read).
  for (const revision of revisions) {
    const requestId = revision.change?.changeRequestId ?? null
    if (requestId && requestIds.has(requestId)) continue
    const workOrderChanges = decided.filter((change) => change.amendmentId === revision.id)
    for (const change of workOrderChanges) carried.add(change.id)
    rows.push({
      kind: 'revision',
      id: revision.id,
      at: revision.at,
      chips: ['revisions', ...(workOrderChanges.length > 0 ? (['workOrders'] as const) : [])],
      revision,
      latest: revision.revision === latestRevision,
      workOrderChanges,
      told: toldBy(input.told, (speaker) => speaker.kind === 'AMENDED' && speaker.amendmentId === revision.id, { kind: 'amendment', at: revision.at }),
    })
  }
  // A decided work-order change no revision or request on this page carried: its own row (a waiting one is Waiting's).
  for (const change of decided) {
    if (carried.has(change.id)) continue
    rows.push({ kind: 'workOrderChange', id: `woc-${change.id}`, at: change.decidedAt ?? change.proposedAt, chips: ['workOrders'], change, told: toldBy(input.told, (speaker) => speaker.kind === 'WORK_ORDER_CHANGE' && speaker.workOrderChangeId === change.id, null) })
  }
  // Every confirmation made, and every send (B-OC-014; before it, the last send the order knows).
  const confirmation = input.confirmation
  for (const version of confirmation?.versions ?? []) rows.push({ kind: 'confirmationMade', id: `made-${version.version}`, at: version.createdAt, chips: ['confirmations'], version: version.version, by: version.createdBy })
  const sends = confirmation?.sends ?? (confirmation?.sentAt && confirmation.sentVersion !== null ? [{ version: confirmation.sentVersion, at: confirmation.sentAt, to: [] as string[], by: null }] : [])
  for (const send of sends) rows.push({ kind: 'confirmationSent', id: `sent-${send.version}-${send.at}`, at: send.at, chips: ['confirmations'], version: send.version, to: send.to, by: send.by })
  // The kinds only the told read's speaker names (B-OC-009).
  for (const told of input.told) {
    const kindOf = told.speaker ? SPEAKER_KINDS[told.speaker.kind] : undefined
    const kind = kindOf && told.speaker ? kindOf(told.speaker) : null
    if (!kind) continue
    rows.push({ kind, id: `${kind}-${told.batchId}`, at: told.occurredAt, chips: kind === 'paused' || kind === 'pauseLifted' ? ['workOrders'] : [], told })
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
}

/** The rows a chip shows (All: every row); a row may be in two chips. */
export const rowsForChip = (rows: readonly ChangeRow[], chip: HistoryChip): ChangeRow[] => (chip === 'all' ? [...rows] : rows.filter((row) => row.chips.includes(chip)))

/** Each chip's count (the head says them; never 0 for Revisions while a row says "Done as revision 2" — L12). */
export function chipCountsOf(rows: readonly ChangeRow[]): Readonly<Record<HistoryChip, number>> {
  return Object.fromEntries(HISTORY_CHIPS.map((chip) => [chip, rowsForChip(rows, chip).length])) as Record<HistoryChip, number>
}

/**
 * Restore as before… (D5, B-OC-013): offered by the server on the order's latest change once our yes was refused, the customer said
 * no, or its yes expired — to a reader with orders.manage; before the server said it, the web's own rule. Held with the server's words
 * when it may not (goods have left, …).
 */
export function restoreOf(change: Change | null, locale: string): { readonly may: boolean; readonly why: string | null } | null {
  if (!change) return null
  const offered = change.putBack.offered ?? putBackOffered(change)
  if (!offered) return null
  const why = change.putBack.why ?? null
  return { may: change.putBack.may, why: change.putBack.may || !why ? null : locale === 'en' ? why.en : why.it }
}
