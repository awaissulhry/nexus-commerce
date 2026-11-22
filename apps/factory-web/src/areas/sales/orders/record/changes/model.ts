import type { BrandRequest } from '../../../../home/approvals/requests/api'
import { tabHref } from '../../../../_shared/record-frame/address' // F-OP-116
import { ageOf, type Phrase as PartsPhrase } from '../../../../../lib/production/model' // F-OO-204: the parts' own age words

/**
 * F-SA-236 (sales page plan N2, N3, P5; 10-order-page §2.4) — Changes as ONE newest-first story, without a screen: what waits on us
 * (the customer's open requests, oldest first), what waits on the customer (the changed order's new yes, our counter-offers, the
 * approvals we asked) and Still to do. F-OC-304: What changed is its own model (history.ts). Only this order's records.
 */

/** The requests that wait on us (open) or on the customer (our counter-offer), oldest first. */
export function waitingOnUsOf(requests: readonly BrandRequest[]): BrandRequest[] {
  return requests.filter((request) => request.status === 'OPEN' || request.status === 'COUNTERED').sort((a, b) => a.askedAt.localeCompare(b.askedAt))
}

// F-OP-301 (walk #1): what waits on the customer is the ONE waiting list's (overview/model `orderWaitingOf`); its own copy here,
// which disagreed with Overview and the badge, is gone.

// F-OC-304: the history (HISTORY_CHIPS, historyOf, historyFor) moved into ONE row per change: record/changes/history.ts.

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
 * What a request asks, in words (the band notice, Waiting, Overview's card, What changed): its kind, then each line ONCE with its
 * style and colour and its sizes old → new ("Change · line 10 · SEED-JKT-02 · Red · 52: 2 → 3 · 54: 1 → 0"), at most three lines,
 * "…" after; a whole-order cancel; a date alone is the date asked ("Ready by 22/12/2026", fx6: never "Change · 22/12/2026"). Never a
 * price, never another order.
 */
export function askWordsOf(request: Pick<BrandRequest, 'kind' | 'cells' | 'wholeOrder' | 'requestedDate'>, words: { readonly kind: string; readonly say: Say; readonly day: (value: string) => string }): string {
  const lines: { seq: number; parts: string[] }[] = []
  for (const cell of request.cells) {
    let line = lines.find((entry) => entry.seq === cell.seq)
    if (!line) {
      line = { seq: cell.seq, parts: [words.say('band.askLine', { line: cell.seq }), ...(cell.style?.code ? [cell.style.code] : []), ...(cell.colourway?.name ? [cell.colourway.name] : [])] }
      lines.push(line)
    }
    if (cell.size !== null) line.parts.push(words.say('changesTab.request.size', { size: cell.size, from: cell.before, to: cell.askedColourway ? `${cell.asked} ${cell.askedColourway.name}` : cell.asked }))
  }
  if (lines.length === 0 && !request.wholeOrder && request.requestedDate) return words.say('changesTab.request.date', { date: words.day(request.requestedDate) })
  const parts = [words.kind, ...lines.slice(0, 3).flatMap((line) => line.parts), ...(lines.length > 3 ? ['…'] : [])]
  if (request.wholeOrder) parts.push(words.say('band.askWhole'))
  if (request.requestedDate && lines.length === 0 && request.wholeOrder) parts.push(words.day(request.requestedDate))
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
  // ---- F-OC-104 (B-OC-006, B-OC-007; absent in an older answer): the office revision it belongs to, the change a workshop's row waits on
  readonly amendmentId?: string | null
  readonly revision?: number | null
  readonly waitsOn?: string | null
  // ---- end F-OC-104
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
  /** F-OC-104 (B-OC-006): an office change's own revision ("Revision 3 · 19/11/2026 10:40"); null: a request's, or not sent yet. */
  readonly revision: number | null
}

/**
 * The rows under each change, the oldest change first; inside, the order the API gave (its own: by kind, then since). F-OC-104: the
 * office's rows one group per revision once the read names it (B-OC-006); until then, as before, one "Office change" group.
 */
export function stillGroupsOf(rows: readonly StillRowOf[], requests: readonly BrandRequest[]): StillGroup[] {
  const keyOf = (row: StillRowOf): string => row.requestId ?? (row.amendmentId ? `amendment:${row.amendmentId}` : '')
  const groups = new Map<string, StillRowOf[]>()
  for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row])
  return [...groups.entries()]
    .map(([, list]) => {
      const requestId = list[0]!.requestId
      const request = requestId ? (requests.find((entry) => entry.id === requestId) ?? null) : null
      const revision = requestId ? null : (list.find((row) => typeof row.revision === 'number')?.revision ?? null)
      return { requestId, request, since: request?.answeredAt ?? list.map((row) => row.since).sort()[0]!, rows: list, revision }
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

// F-OC-105 (10-design §3, §5): the Changes tab's own "Work-order changes of this order" card went — a waiting one is ONE row of
// Waiting › Still to do (Decide…), a decided one a row of What changed. Its "Told the floor at hh:mm" was a guess from the decision's
// time (C3-B1): "Told" is said only where the told read names it (WhoWasTold, the History row's Told line).
