/**
 * Approvals grid (docs/approvals-grid/PLAN.md §2–§5) — the page's words and rules, pure, so each one is a test.
 *
 * The grid, the health strip and the toolbar read their labels, tones, filters and the bulk-button rules from here.
 * Nothing in this file fetches or renders. Times are passed in (`now`), never read from a clock, so a test is exact.
 */
import type { QueueChange, QueueCounts, QueuePage, QueueRow, QueueShow, QueueState } from '@nexus/shared/approval-queue'
import type { Tone } from '@/design-system/primitives/tone'
import { countdownText } from '@/design-system/components/countdownTicker'
import { changeLineArrowText } from '@/design-system/grid/renderers/changeValue'

/* ── statuses (PLAN §3) ───────────────────────────────────────────────────────────────────── */

/** The label and Pill tone of each state. A state the API adds later falls back to its own name, neutral. */
export const STATE_META: Record<QueueState, { label: string; tone: Tone }> = {
  waiting: { label: 'Waiting', tone: 'info' },
  starting: { label: 'Starting', tone: 'warning' },
  on_hold: { label: 'On hold', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  back_to_you: { label: 'Back to you', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
  replaced: { label: 'Replaced by an edit', tone: 'neutral' },
  recorded: { label: 'Recorded', tone: 'neutral' },
}

export function stateMeta(state: QueueState): { label: string; tone: Tone } {
  return STATE_META[state] ?? { label: String(state), tone: 'neutral' }
}

/** The Status column's sort: what needs a person first, then what is moving, then what is finished. */
export const QUEUE_STATE_ORDER: readonly QueueState[] = [
  'failed', 'back_to_you', 'waiting', 'starting', 'on_hold', 'running', 'done', 'recorded', 'rejected', 'expired', 'replaced',
]

/** Pending on the server: a person may approve, reject or retry these, and only these can be ticked. */
export const PENDING_STATES: readonly QueueState[] = ['waiting', 'back_to_you', 'failed']
export const isPending = (state: QueueState): boolean => PENDING_STATES.includes(state)

/** States that change on their own within seconds: the list is read every 3 s while one is on screen. */
export const LIVE_STATES: readonly QueueState[] = ['starting', 'running', 'on_hold']
export const isLiveState = (state: QueueState): boolean => LIVE_STATES.includes(state)

/** The approve was taken and the row counts down to its run: Undo and Hold apply, and the countdown commits at zero. */
export const isCountingDown = (row: Pick<QueueRow, 'state' | 'executeAfter'>): boolean =>
  (row.state === 'starting' || row.state === 'on_hold') && !!row.executeAfter

/** "14:20" in the viewer's zone (a test passes `UTC`). */
export function clockText(iso: string, timeZone?: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone })
}

/** A plan's progress: "34 of 120 done", or null for a single request. */
export function planProgress(plan: QueueRow['plan']): string | null {
  if (!plan) return null
  const done = plan.byStatus.done ?? 0
  const failed = plan.byStatus.failed ?? 0
  return `${done} of ${plan.steps} done${failed ? `, ${failed} failed` : ''}`
}

/**
 * The status in words — the value the column sorts, searches and exports. The cell itself draws a live countdown
 * for a row that is about to run; this is the same fact at the time of the read.
 */
export function statusText(row: QueueRow, now: number, timeZone?: string): string {
  const meta = stateMeta(row.state)
  if (row.state === 'starting' && row.executeAfter) return `Runs in ${countdownText(Date.parse(row.executeAfter) - now)}`
  if (row.state === 'on_hold' && row.executeAfter) return `On hold until ${clockText(row.executeAfter, timeZone)}`
  if (row.state === 'running' && row.plan) return `Running · ${row.plan.byStatus.done ?? 0} of ${row.plan.steps}`
  return meta.label
}

/* ── the row's words ──────────────────────────────────────────────────────────────────────── */

/** A plan's second line: its size, or while it runs its progress. Null for a single request. */
export function planSubline(row: Pick<QueueRow, 'plan' | 'state'>): string | null {
  if (!row.plan) return null
  if (row.state === 'running') return planProgress(row.plan)
  return `Plan · ${row.plan.steps} ${row.plan.steps === 1 ? 'step' : 'steps'}`
}

/**
 * The "What" cell's second line: WHERE in plain words ("eBay IT", "Nexus"), so the separate Where column can stay hidden
 * at desktop width; a plan says its size or its progress instead. Null when neither is known.
 */
export function whatSubline(row: Pick<QueueRow, 'plan' | 'state' | 'channel' | 'market' | 'reachesOutside' | 'nexusRecord'>): string | null {
  return row.plan ? planSubline(row) : whereText(row)
}

const TARGET_NOUN: Record<NonNullable<QueueRow['target']>['kind'], [string, string]> = {
  product: ['product', 'products'],
  listing: ['listing', 'listings'],
  campaign: ['campaign', 'campaigns'],
  'ad-target': ['ad target', 'ad targets'],
  order: ['order', 'orders'],
  shipment: ['shipment', 'shipments'],
  'purchase-order': ['purchase order', 'purchase orders'],
  customer: ['customer', 'customers'],
  supplier: ['supplier', 'suppliers'],
  rule: ['rule', 'rules'],
  other: ['item', 'items'],
}

/** "12 products" for a bulk request or a plan; null for one thing (the cell shows its SKU and name instead). */
export function targetCountText(target: QueueRow['target']): string | null {
  if (!target || target.count <= 1) return null
  const [one, many] = TARGET_NOUN[target.kind] ?? TARGET_NOUN.other
  return `${target.count} ${target.count === 1 ? one : many}`
}

/** The product in one line — what search, sort and the CSV read: "XR-GLOVE-M Gale glove M", "12 products". */
export function productText(target: QueueRow['target']): string {
  if (!target) return ''
  const count = targetCountText(target)
  if (count) return target.sku ? `${count} (first: ${target.sku})` : count
  return [target.sku, target.name].filter(Boolean).join(' ')
}

const CHANNEL_WORD: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy' }

/** "Amazon", "eBay"; an unknown channel in title case. */
export function channelWord(channel: string): string {
  return CHANNEL_WORD[channel.toUpperCase()] ?? channel.charAt(0).toUpperCase() + channel.slice(1).toLowerCase()
}

/**
 * The "Where" column: "eBay IT", "Amazon", "Nexus" — a change that never leaves Nexus, or one made to Nexus's own record
 * (a master price, warehouse stock: `nexusRecord`) that its listings then follow. Null when the request may reach a
 * channel but does not name one — the cell shows the dash rather than guessing.
 */
export function whereText(row: Pick<QueueRow, 'channel' | 'market' | 'reachesOutside' | 'nexusRecord'>): string | null {
  if (row.channel) return row.market ? `${channelWord(row.channel)} ${row.market.toUpperCase()}` : channelWord(row.channel)
  if (!row.reachesOutside || row.nexusRecord) return 'Nexus'
  return null
}

/** Finished requests whose "Why / result" also says who decided (an expiry or Nexus itself is no one). */
const DECIDED_STATES: readonly QueueState[] = ['done', 'recorded', 'rejected', 'replaced']

/** "approved by Ana", "by your rule"; null when nobody decided or the row is not finished. */
function decidedBy(row: Pick<QueueRow, 'state' | 'decider'>): { words: string; marker: string } | null {
  const d = row.decider
  if (!d || !DECIDED_STATES.includes(row.state)) return null
  if (d.kind === 'rule') return { words: 'by your rule', marker: 'rule' }
  if (d.kind !== 'person' && d.kind !== 'claude-code') return null
  const approved = row.state === 'done' || row.state === 'recorded'
  return { words: `${approved ? 'approved ' : ''}by ${d.label}`, marker: d.label.replace(/, code in Claude$/, '') }
}

/**
 * "Why / result": the API's own sentence, else why it waits under today's rule. A finished request also says who
 * decided ("Rejected: too low · by Ana"), unless the sentence already names them.
 */
export function whyText(row: Pick<QueueRow, 'note' | 'automation' | 'state' | 'decider' | 'needsCode'>): string | null {
  const said = withCode(row, row.note ?? row.automation.whyWaits ?? null)
  const by = decidedBy(row)
  if (!by || (said && said.toLowerCase().includes(by.marker.toLowerCase()))) return said
  return said ? `${said} · ${by.words}` : by.words.charAt(0).toUpperCase() + by.words.slice(1)
}

/**
 * ADS AUTONOMY AA-W2-5 (CR rebuild 3) — a request Claude asked for at Watch: what the business's rule said when it was
 * asked, as a short label for the row. Null on every other request. A person still decides it either way.
 */
export function watchVerdictWords(row: Pick<QueueRow, 'ruleVerdict'>): { label: string; tone: 'success' | 'warning'; why: string | null } | null {
  const v = row.ruleVerdict
  if (!v) return null
  return v.wouldRun
    ? { label: 'Would have run alone', tone: 'success', why: null }
    : { label: 'Outside your limits', tone: 'warning', why: v.why }
}

/**
 * ADS AUTONOMY W1-4 — what a request that raises asks of its approver, in plain words: the API's sentence without the
 * units its labels carry ("Highest bid (cents)" → "Highest bid"). Null when approving it needs no code.
 */
export function codeSentence(row: Pick<QueueRow, 'needsCode'>): string | null {
  const said = row.needsCode?.trim()
  return said ? said.replace(/\s\((cents|%|actions|days)\)/g, '') : null
}

/** A waiting request that raises says so in its Why: the approve asks for the code. */
function withCode(row: Pick<QueueRow, 'state' | 'needsCode'>, said: string | null): string | null {
  if (!row.needsCode || !isPending(row.state)) return said
  return said ? `${said} · Approving asks for your authenticator code` : 'Approving asks for your authenticator code'
}

/**
 * The Change cell of a row with exactly ONE change line hides that line's label: the What column already names it, so
 * "€159.00 → €151.05" fits. A screen reader still hears the label (DS `ChangeValue hideLabels`), and the tooltip, the
 * CSV and the search keep it.
 */
export function changeHidesLabel(row: Pick<QueueRow, 'changes' | 'changeCount'>): boolean {
  return row.changes.length === 1 && row.changeCount <= 1
}

/** The row's change lines in one line of words ("Base price: €159.00 → €151.05"), for the search. */
export function changeWords(changes: readonly QueueChange[]): string {
  return changes.map(changeLineArrowText).join('; ')
}

/** Everything the search reads of a row: its kind, where, product, change, who asked, why and status. */
export function searchText(row: QueueRow): string {
  return [
    row.title, row.toolName, whatSubline(row), productText(row.target), row.target?.name, changeWords(row.changes),
    row.asker.label, whyText(row), stateMeta(row.state).label,
  ].filter(Boolean).join(' ').toLowerCase()
}

/** The search box: every word typed must appear somewhere in the row (any case, any order). Empty matches all. */
export function rowMatchesSearch(row: QueueRow, search: string): boolean {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = searchText(row)
  return words.every((word) => text.includes(word))
}

/* ── the verbs a row offers ───────────────────────────────────────────────────────────────── */

export type RowVerbId = 'approve' | 'reject' | 'retry' | 'undo'

/** The visible verbs (at most two): waiting / back to you → Approve + Reject; failed → Retry + Reject; about to run → Undo. */
export function rowVerbIds(state: QueueState): readonly RowVerbId[] {
  if (state === 'waiting' || state === 'back_to_you') return ['approve', 'reject']
  if (state === 'failed') return ['retry', 'reject']
  if (state === 'starting' || state === 'on_hold') return ['undo']
  return []
}

/** Why this row cannot be approved by this viewer now, or null. */
export function approveHeldWhy(row: Pick<QueueRow, 'canApprove' | 'cannotApproveWhy'>): string | null {
  if (row.canApprove) return null
  return row.cannotApproveWhy ?? 'You cannot approve this request.'
}

/**
 * "Automate this kind…" — offered on Claude's single requests only: a rule applies to Claude's requests of one kind,
 * never to a change plan or to what a fleet agent, the assistant or a rule asked. Held, with the reason, when the kind
 * always needs a person.
 */
export function automateOffer(row: Pick<QueueRow, 'asker' | 'automation' | 'plan' | 'toolName'>): { offered: boolean; heldWhy: string | null } {
  if (row.asker.kind !== 'claude' || row.plan || row.toolName === PLAN_TOOL_NAME) return { offered: false, heldWhy: null }
  const max = row.automation.max
  if (max === 'ask' || max === 'off') return { offered: true, heldWhy: 'This kind always needs you' }
  return { offered: true, heldWhy: null }
}

/** The change-plan tool (the API's PLAN_TOOL): one request of many steps. */
export const PLAN_TOOL_NAME = 'submit-change-plan'

/* ── bulk (Decision 1 = A: one kind at a time) ────────────────────────────────────────────── */

/** The most rows one bulk call may decide (the API's `BULK_MAX_IDS`). */
export const BULK_MAX = 200

export interface BulkVerdict {
  enabled: boolean
  label: string
  /** The plain reason the button is held, shown with it. Null when it can run. */
  reason: string | null
  /** W1-4 — an approve that runs, but leaves some ticked rows out (a raise is approved on its own, with the code). */
  note?: string
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** The toolbar's "Approve N …" button: one kind, one asker, each row approvable in bulk and by this viewer. */
export function bulkApproveVerdict(rows: readonly QueueRow[]): BulkVerdict {
  const n = rows.length
  const kinds = new Set(rows.map((r) => r.toolName))
  // W1-4 — a request that raises is approved on its own, with the approver's code: the bulk approve leaves it out and
  // says so (the API does the same, apps/api approval-inbox.service.ts bulkDecide).
  const coded = rows.filter((r) => !!r.needsCode)
  const acting = coded.length ? rows.filter((r) => !r.needsCode) : rows
  const label = `Approve ${coded.length && acting.length ? `${acting.length} of ${n}` : n}${kinds.size === 1 && n > 0 ? ` · ${rows[0].title}` : ''}`
  const held = (reason: string): BulkVerdict => ({ enabled: false, label, reason })
  if (n === 0) return held('Tick the requests you want to approve.')
  if (n > BULK_MAX) return held(`At most ${BULK_MAX} requests can be approved at once. You ticked ${n}.`)
  const notPending = rows.filter((r) => !isPending(r.state)).length
  if (notPending) return held(`${notPending} of these ${plural(notPending, 'is', 'are')} not waiting for you.`)
  if (kinds.size > 1) return held(`Only one kind of request can be approved at once. You ticked ${kinds.size} kinds.`)
  if (new Set(rows.map((r) => r.asker.kind)).size > 1) return held('Only requests from one asker can be approved at once.')
  if (!acting.length) {
    return held(n === 1
      ? 'It raises, so it is approved on its own: open it and approve it with your authenticator code.'
      : 'Each of these raises, so each is approved on its own: open one and approve it with your authenticator code.')
  }
  const blocked = acting.find((r) => !r.bulkApprovable)
  if (blocked) return held(blocked.bulkBlockedWhy ?? 'This kind is never approved in bulk.')
  const refused = acting.find((r) => !r.canApprove)
  if (refused) return held(refused.cannotApproveWhy ?? 'You cannot approve some of these requests.')
  if (!coded.length) return { enabled: true, label, reason: null }
  return {
    enabled: true, label, reason: null,
    note: `${coded.length} that ${plural(coded.length, 'raises is', 'raise are')} left out: ${plural(coded.length, 'it is', 'each is')} approved on its own, with your authenticator code.`,
  }
}

/** "Reject N": works across kinds; only rows that still wait for a person. */
export function bulkRejectVerdict(rows: readonly QueueRow[]): BulkVerdict {
  const n = rows.length
  const label = `Reject ${n}`
  if (n === 0) return { enabled: false, label, reason: 'Tick the requests you want to reject.' }
  if (n > BULK_MAX) return { enabled: false, label, reason: `At most ${BULK_MAX} requests can be rejected at once. You ticked ${n}.` }
  const notPending = rows.filter((r) => !isPending(r.state)).length
  if (notPending) return { enabled: false, label, reason: `${notPending} of these ${plural(notPending, 'is', 'are')} not waiting for you.` }
  return { enabled: true, label, reason: null }
}

/** What a bulk decision did, in one toast: "Approved 10 of 12. Not done: XR-1 — it changed since it was asked." */
export function bulkOutcomeText(
  decision: 'approve' | 'reject',
  result: { done: number; of: number; skipped?: Array<{ id: string; why: string }>; error?: string },
  nameOf: (id: string) => string,
): string {
  const verb = decision === 'approve' ? 'Approved' : 'Rejected'
  const skipped = result.skipped ?? []
  const head = result.done === result.of ? `${verb} ${result.done}.` : `${verb} ${result.done} of ${result.of}.`
  if (skipped.length === 0) return result.error && result.done === 0 ? `Nothing was ${verb.toLowerCase()}: ${result.error}` : head
  const shown = skipped.slice(0, 3).map((s) => `${nameOf(s.id)} — ${s.why}`).join('; ')
  const more = skipped.length > 3 ? `; and ${skipped.length - 3} more` : ''
  return `${head} Not done: ${shown}${more}.`
}

/** "Approved — runs in 20 s", from the server's run time. Without one: "Approved." */
export function approvedText(executeAfter: string | null | undefined, now: number, again = false): string {
  const verb = again ? 'Approved again' : 'Approved'
  if (!executeAfter) return `${verb}.`
  const left = Date.parse(executeAfter) - now
  return Number.isFinite(left) ? `${verb} — runs in ${countdownText(left)}` : `${verb}.`
}

/* ── the health strip (each tile is a filter) ─────────────────────────────────────────────── */

export type QueueTile = 'needsYou' | 'running' | 'failed' | 'ranByRule' | 'oldest'

export const TILE_ORDER: readonly QueueTile[] = ['needsYou', 'running', 'failed', 'ranByRule', 'oldest']

export const TILE_LABEL: Record<QueueTile, string> = {
  needsYou: 'Needs you',
  running: 'Running',
  failed: 'Failed',
  ranByRule: 'Ran by rule today',
  oldest: 'Oldest waiting',
}

/** The list a tile needs from the server: today's rule runs are finished requests, everything else is open. */
export const TILE_SHOW: Record<QueueTile, QueueShow> = {
  needsYou: 'open',
  running: 'open',
  failed: 'open',
  ranByRule: 'done',
  oldest: 'open',
}

/** "3 h" since a moment; null without one. */
export function ageText(iso: string | null, now: number): string | null {
  if (!iso) return null
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return ms < 60_000 ? 'under a minute' : countdownText(ms)
}

/** A tile's number, as shown. "—" until the counts were read. */
export function tileValue(tile: QueueTile, counts: QueueCounts | null, now: number): string {
  if (!counts) return '—'
  switch (tile) {
    case 'needsYou': return String(counts.needsYou)
    case 'running': return String(counts.starting + counts.running)
    case 'failed': return String(counts.failed)
    case 'ranByRule': return String(counts.ranByRuleToday)
    case 'oldest': return ageText(counts.oldestNeedsYouAt, now) ?? 'none'
  }
}

/** Midnight UTC of `now` — the API counts "today" from 00:00 UTC (no business time zone is stored). */
export function utcDayStart(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** Does a row belong under a tile? `oldest` keeps the request(s) that have waited longest. */
export function rowMatchesTile(row: QueueRow, tile: QueueTile, ctx: { oldestNeedsYouAt: string | null; now: number }): boolean {
  switch (tile) {
    case 'needsYou': return row.state === 'waiting' || row.state === 'back_to_you'
    case 'running': return row.state === 'starting' || row.state === 'running'
    case 'failed': return row.state === 'failed'
    case 'ranByRule':
      return row.state === 'done' && row.decider?.kind === 'rule' && !!row.decidedAt && Date.parse(row.decidedAt) >= utcDayStart(ctx.now)
    case 'oldest':
      return (row.state === 'waiting' || row.state === 'back_to_you') && !!ctx.oldestNeedsYouAt && Date.parse(row.requestedAt) <= Date.parse(ctx.oldestNeedsYouAt)
  }
}

/* ── show, group, phone ───────────────────────────────────────────────────────────────────── */

export const SHOW_LABEL: Record<QueueShow, string> = { open: 'Open', done: 'Done', all: 'Everything' }

/** "Showing 100 of 130 open requests" — the toolbar count. */
export function countText(shown: number, total: number | null, show: QueueShow): string {
  const noun = show === 'open' ? 'open requests' : show === 'done' ? 'finished requests' : 'requests'
  if (total === null || total <= shown) return `${shown} ${shown === 1 ? noun.replace(/s$/, '') : noun}`
  return `Showing ${shown} of ${total} ${noun}`
}

/**
 * Group options. The plan's "Claude plan" needs a run or plan id on `QueueRow`, which the wire contract does not carry
 * yet (see docs/approvals-grid/reports/D1-grid-page.md); "Asked by" groups by the asker instead.
 */
export type QueueGroup = 'none' | 'kind' | 'product' | 'asker'
export const GROUP_LABEL: Record<QueueGroup, string> = { none: 'None', kind: 'Kind', product: 'Product', asker: 'Asked by' }
export const isQueueGroup = (v: unknown): v is QueueGroup => v === 'none' || v === 'kind' || v === 'product' || v === 'asker'
export const isQueueShow = (v: unknown): v is QueueShow => v === 'open' || v === 'done' || v === 'all'

/** The group a row falls under. */
export function groupKey(row: QueueRow, group: QueueGroup): string {
  if (group === 'kind') return row.title
  if (group === 'asker') return row.asker.label
  if (group === 'product') {
    const t = row.target
    if (!t) return 'No product named'
    return targetCountText(t) ?? ([t.sku, t.name].filter(Boolean).join(' · ') || 'No product named')
  }
  return ''
}

/**
 * Below this width the grid shows two columns — Request (the status and the kind, the product under them) and ONE verb
 * — so it fits a 390 px phone without sideways scrolling; a tap on the row opens the drawer, which has every verb.
 */
export const PHONE_MAX_PX = 639
export const PHONE_COLUMNS: readonly string[] = ['request', 'actions']

/** The phone Request cell's second line: a plan's size or progress, else the product's SKU (or name, or count). */
export function requestSubline(row: Pick<QueueRow, 'plan' | 'state' | 'target' | 'channel' | 'market' | 'reachesOutside' | 'nexusRecord'>): string | null {
  if (row.plan) return planSubline(row)
  const t = row.target
  if (!t) return whereText(row)
  return targetCountText(t) ?? t.sku ?? t.name ?? null
}
export const isPhoneWidth = (px: number): boolean => px <= PHONE_MAX_PX

/* ── polling (PLAN §5–§6) ─────────────────────────────────────────────────────────────────── */

export const POLL_FAST_MS = 3_000
export const POLL_IDLE_MS = 15_000
export const PAGE_SIZE = 100

/** Every 3 s while something on screen is starting, running or on hold; every 15 s otherwise. */
export function pollInterval(rows: readonly Pick<QueueRow, 'state'>[], counts: QueueCounts | null): number {
  const live = rows.some((r) => isLiveState(r.state)) || (counts ? counts.starting + counts.running > 0 : false)
  return live ? POLL_FAST_MS : POLL_IDLE_MS
}

/** How many rows a poll re-reads from the top: what is on screen, between one page and the API's cap of 200. */
export function pollLimit(loaded: number): number {
  return Math.min(BULK_MAX, Math.max(PAGE_SIZE, loaded))
}

/**
 * A poll's answer merged with what is on screen. The poll re-reads the first `limit` rows; when more were loaded with
 * "Show more" (past 200), those keep their last read and the "more" cursor stays where it was.
 */
export function mergePolledPage(
  prev: { rows: readonly QueueRow[]; nextCursor: string | null },
  page: QueuePage,
  limit: number,
): { rows: QueueRow[]; nextCursor: string | null } {
  if (prev.rows.length <= limit) return { rows: page.rows, nextCursor: page.nextCursor }
  const fresh = new Set(page.rows.map((r) => r.id))
  const tail = prev.rows.slice(limit).filter((r) => !fresh.has(r.id))
  return { rows: [...page.rows, ...tail], nextCursor: prev.nextCursor }
}

/** "Show more": the next page appended, without a row twice. */
export function appendPage(prev: readonly QueueRow[], page: QueuePage): QueueRow[] {
  const have = new Set(prev.map((r) => r.id))
  return [...prev, ...page.rows.filter((r) => !have.has(r.id))]
}

/** The empty-grid words for a list with nothing in it. */
export function emptyWords(show: QueueShow, filtered: boolean): { title: string; message: string } {
  if (filtered) return { title: 'No requests match.', message: 'Clear the search and the tile filter to see every request.' }
  if (show === 'open') return { title: 'Nothing needs you right now.', message: "Claude's requests show up here." }
  if (show === 'done') return { title: 'Nothing finished yet.', message: 'Requests you or a rule decided show up here.' }
  return { title: 'No requests yet.', message: "Claude's requests show up here." }
}
