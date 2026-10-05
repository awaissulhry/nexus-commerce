/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04), phase P10 — the Publish window shows and sends the WHOLE plan.
 *
 * Pure rules (no React) for the studio's Publish window once it reads the plan (`POST …/studio-publication/plan`, one
 * destination per request) instead of a bare content review:
 *  - the ONE table of a market tab (`actionPlanRows`): tick · SKU · what · what is sent · set by — danger rows first;
 *  - what a row's tick does (`toggleRowTicks`, `withProductTicks`);
 *  - what one click sends over every chosen market (`actionPlanSend`): the counts behind the one summary line, the
 *    typed confirmation Ended and Delete need, the rows a role without products.delete leaves waiting, and whether the
 *    send takes the batch (`POST /api/publication-batches { plan }`) or today's direct submit;
 *  - the counted button, the batch's words for each lifecycle child and row, and Undo after Done.
 *
 * The contract is `@nexus/shared/publish-plan` (P6); the Action and Status words are the design system's (P5).
 *
 * Delete and relist (Owner 2026-10-04, simplified the same day): a row Nexus deleted whose Status is Not listed (its
 * default) is in the table as Not listed — unticked, locked, quiet — with the server's sentence ("Deleted on Amazon · IT
 * on 4 Oct. To list it again, set Status to Active."). A row its Status lists again reads Full update (sent whole) and
 * says how ("Lists GALE-M on ASIN B0NEW (was B0OLD).") with its warning (FBA units on the old ASIN). A Delete row
 * carries Amazon's FBA unit count and the Pan-European FBA warning (`row.warning`). Done: a deleted row says how to list
 * it again.
 *
 * New listings (Owner 2026-10-04): a row the content review CREATES (`rows[].startsAs`) reads Full update (a new listing
 * is always sent whole) and says what it creates — "Creates GALE-M · Active." / "Creates GALE-M · Inactive — buyers
 * cannot buy it yet." (`createsLine`); the
 * summary line counts them ("2 new listings (1 inactive)"). A row whose Status is Not listed (its own, or its family's
 * main row's: `rows[].notListed`, `contentHeld[].notListed`) is held — unticked, locked, quiet, at the bottom — with the
 * server's reason, and never counted as sent. A Shopify product Shopify does not hold yet says Active or Draft in plain
 * words (`shopifyVisibilityWords`).
 */
import { channelLabel } from '@nexus/shared/channel-label'
import { deleteDoneSentence, LISTING_ACTION_LABEL, type ListingAction, type SellingState, type StatusTarget } from '@nexus/shared/listing-actions'
import { publishPlanSummary, type SendMode } from '@nexus/shared/publish-actions'
import {
  LIFECYCLE_UNKNOWN, ROLE_CANNOT_END_OR_DELETE, START_AS_WORD, confirmRowsTicked, publishPlanCounts, publishPlanUsesBatch,
  type PublishPlanBatchChild, type PublishPlanBatchView, type PublishPlanCounts, type PublishPlanDestination, type PublishPlanLifecycleRow,
  type PublishPlanSubmit, type StartAsTarget,
} from '@nexus/shared/publish-plan'
import { isPhotoChangeId, type StudioPublishReview, type StudioPublishScope } from '@nexus/shared/studio-publication'
import { publicationStatusMeta, publishResultMeta, type PublishStatusMeta } from '@/design-system/grid/renderers/publishStatus'
import type { Tone } from '@/design-system/primitives/tone'
import { batchChildMeta, isSparse, publishPlan, tickedChanges, type DestinationEntry, type DestinationState, type PublishPlan as ContentPlan } from './destinations'
import { reviewTabWords } from './pickers'

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

// ── Words ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const EVERYTHING_SENT = 'Everything is sent.'
export const FULL_UNTICKED = 'Unticked: nothing of it is sent.'
export const NOT_SENT_PROBLEMS = 'Not sent until the problems above are fixed.'
export const NOT_SENT_EARLIER = 'Not sent: an earlier publish here has no answer yet.'
export const NOTHING_TO_SEND = 'Nothing to send: the channel already has these values.'
export const NOTHING_SENDABLE = 'Nothing can be sent: open the fields to see why.'
export const FIELDS_NOT_LISTED = 'The fields to send were not listed. Check again.'
export const WHOLE_NEW = 'The whole product is sent (a new listing).'
export const WHOLE_AGAIN = 'The whole product is sent again.'
export const NO_LONGER_APPLIES = 'No longer applies'
/** S10 — a move whose create is unticked: nothing is created, and the old SKU is not deleted. */
export const MOVE_UNTICKED = 'Unticked: nothing is created, and the old SKU stays.'
export const CLEARED_ON_SEND = 'It is cleared when you publish.'
export const STARTS_UNTICKED = 'Starts unticked.'
export const PLAN_CHANGED = 'A waiting value changed while you looked. The review is updated.'
/** A 409 that is not `changed` (the content review expired or changed while it was made): read again, nothing was sent. */
export const PLAN_OUT_OF_DATE = 'The review was out of date. It is updated.'
export const CHECK_ON_CHANNEL = 'Check on the channel'
export const DELETE_CANNOT_UNDO = 'Cannot be undone'
export const NOTHING_HERE = 'Nothing to send here.'
/** After a relist sentence, when its row is unticked. */
export const RELIST_UNTICKED = 'Unticked: it stays deleted for now.'
/** How a deleted listing comes back (Undo cannot: the channel removed it). */
export const RELIST_HOW = 'To list it again, set its Status to Active and Publish.'

// ── New listings (Owner 2026-10-04) ───────────────────────────────────────────────────────────────────────────────

/** After "Creates GALE-M · Inactive": what Inactive means for a listing that is created now. */
export const CREATES_INACTIVE_NOTE = 'buyers cannot buy it yet'
/** After a create sentence, when its row is unticked. */
export const CREATE_UNTICKED = 'Unticked: it is not created now.'
/** Beside the "Not listed" pill of a row Publish leaves out. */
export const NOT_LISTED_ASIDE = 'Left out'

/**
 * "Creates GALE-M · Active." / "Creates GALE-M · Inactive — buyers cannot buy it yet." — what a row this Publish creates
 * starts as. Shopify's Inactive is a Draft product: "Creates GALE · Inactive (a Draft product) — …".
 */
export function createsLine(sku: string, startsAs: StartAsTarget, channel?: string | null): string {
  if (startsAs === 'active') return `Creates ${sku} · ${START_AS_WORD.active}.`
  const draft = String(channel ?? '').toUpperCase() === 'SHOPIFY' ? ' (a Draft product)' : ''
  return `Creates ${sku} · ${START_AS_WORD.inactive}${draft} — ${CREATES_INACTIVE_NOTE}.`
}

/** The new listings a market's Publish creates now (ticked field by field), and how many of them start Inactive. */
export interface CreatedCounts { total: number; inactive: number }

/**
 * Counts the rows that create a listing and go out (a ticked or partly ticked row). A Shopify product sent whole is not
 * counted here: the summary names it as "1 new product" and the window says Active or Draft (`shopifyVisibilityWords`).
 */
export function createdCounts(rows: ReadonlyArray<Pick<ActionPlanRow, 'creates' | 'tick' | 'notSent'>>): CreatedCounts {
  const going = rows.filter(row => row.creates && !row.notSent && (row.tick === 'on' || row.tick === 'some'))
  return { total: going.length, inactive: going.filter(row => row.creates!.startsAs === 'inactive').length }
}

/** "2 new listings (1 inactive)", "1 new listing (inactive)", "3 new listings (all inactive)" — null when none. */
export function createdWords(created: CreatedCounts | null | undefined): string | null {
  if (!created?.total) return null
  const inactive = !created.inactive ? '' : created.inactive === created.total ? (created.total === 1 ? ' (inactive)' : ' (all inactive)') : ` (${created.inactive.toLocaleString('en')} inactive)`
  return `${plural(created.total, 'new listing', 'new listings')}${inactive}`
}

/** A content review's row in the products table (no plan): existing, new (and how it starts), or left out. */
export function reviewRowListingWord(row: Pick<StudioPublishReview['rows'][number], 'existing' | 'startsAs' | 'notListed'>): string {
  if (row.notListed) return `Not listed: ${NOT_LISTED_ASIDE.toLowerCase()}`
  if (row.existing) return 'Existing listing'
  return row.startsAs ? `New listing · ${START_AS_WORD[row.startsAs]}` : 'New listing'
}

/**
 * The Shopify status line of a review, in plain words. A product Shopify does not hold yet is created Active ("it sells
 * at once") or as a Draft ("buyers cannot buy it until …"); otherwise the status the saved product applies. Null when the
 * review names none (every other channel).
 */
export function shopifyVisibilityWords(review: Pick<StudioPublishReview, 'visibility' | 'action' | 'rows'>): { title: string; body: string } | null {
  const visibility = review.visibility?.trim()
  if (!visibility) return null
  const status = visibility.toUpperCase()
  const fresh = review.action === 'create' || !review.rows.some(row => row.existing)
  const channels = 'The saved sales-channel selections are applied.'
  if (fresh && status === 'ACTIVE') return { title: 'Shopify creates this product Active', body: `It sells at once. ${channels}` }
  if (fresh && status === 'DRAFT') return { title: 'Shopify creates this product as a Draft', body: `Buyers cannot buy it until you set it Active and Publish. ${channels}` }
  const word = status === 'ACTIVE' ? 'Active' : status === 'DRAFT' ? 'Draft' : status === 'ARCHIVED' ? 'Archived' : visibility
  return { title: `Shopify status: ${word}`, body: 'The saved status and sales-channel selections will be applied.' }
}

// ── One-click "Nexus wins" (Owner 2026-10-04) ─────────────────────────────────────────────────────────────────────

/**
 * After a Partial row's field count: how many of its ticked fields replace a value on the channel (lines with
 * `replaces`) — "1 replaces an Amazon value", "3 replace eBay values" — in the channel's own name.
 */
export function replacesCountWords(count: number, channel: string): string {
  const name = channelLabel(channel)
  return count === 1 ? `1 replaces ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} value` : `${count.toLocaleString('en')} replace ${name} values`
}

// ── The one table of a market tab ─────────────────────────────────────────────────────────────────────────────────

export type PlanRowKind = 'content' | 'lifecycle' | 'outgrown' | 'held'

/**
 * What a row does, in the design system's Action or Status words. `newRow` (Action only): the row is not on the channel
 * (new, or listed again after a delete) — it reads Full update, sent whole.
 */
export type PlanRowWhat =
  | { column: 'send'; mode: SendMode; setAt: string | null; setByName: string | null; newRow?: boolean }
  /** S10 — a live Amazon listing moved to its own SKU: the create of NEW, then the delete of OLD ("Move to NEW"). */
  | { column: 'move'; from: string; to: string }
  | { column: 'status'; target: StatusTarget; state: SellingState; setAt: string | null; setByName: string | null }

/**
 * The row's tick: `on` / `off`, `some` (a Partial row with some of its fields ticked), `whole` (sent whole, no choice:
 * a new Shopify product), `none` (nothing of it can be sent; the row says why).
 */
export type PlanTick = 'on' | 'off' | 'some' | 'whole' | 'none'

export interface ActionPlanRow {
  /** `content:<productId>`, the lifecycle row's own id, `outgrown:<id>` or `held:<productId>`. */
  key: string
  kind: PlanRowKind
  productId: string
  sku: string
  what: PlanRowWhat
  /** A lifecycle row's action (Pause, Resume, End, Relist, Delete); null for the others. */
  action: ListingAction | null
  /** What is sent, in plain English (for a row that sends nothing: why). */
  sent: string
  /** Offered, but the person should read this first (an FBA pause), or null. */
  warning: string | null
  /** A check the channel answers only when sending, or null. */
  checkedAtSend: string | null
  /** Why nothing of this row is sent now (refused and kept waiting, held, blocked, outgrown), or null. */
  notSent: string | null
  /** "Set by Awais · 5 minutes ago", or null. */
  setBy: string | null
  /** Set by someone else or more than a day ago: it starts unticked. */
  stale: boolean
  tick: PlanTick
  /** The person can change the tick (before the window is locked). */
  tickable: boolean
  /** Ended or Delete: the typed confirmation. */
  danger: boolean
  /** Content rows: every change id of this product (the field ticks inside the row). */
  changeIds: string[]
  /** Content rows: the ids the row tick turns on (its default fields; all of them on a Full update row). */
  defaultFieldIds: string[]
  /** Content rows: ticked of the fields that can be ticked. */
  fields: { ticked: number; total: number }
  /** Full update rows: what the channel holds that Nexus does not — removed when sent. */
  removals: Array<{ label: string; value: string }>
  /** The row opens: a Partial row to its field ticks, a Full row to what it sends and removes. */
  expandable: boolean
  /** New listings: this Publish creates the row, and how it starts ("Creates GALE-M · Inactive — …"); null otherwise. */
  creates: { startsAs: StartAsTarget; sentence: string } | null
  /** New listings: its Status (or its family's main row's) is Not listed, so Publish leaves it out (held, never sent). */
  notListed: boolean
}

/** Danger first (Delete, then End), then Pause, Full update, Resume and Relist, Partial; rows that send nothing last. */
const RANK: Readonly<Record<string, number>> = { delete: 0, move: 0, end: 1, pause: 2, full: 3, resume: 4, relist: 4, partial: 5, idle: 6, held: 7, outgrown: 8 }

/** A removed value as one short line. */
export function removalText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(empty)'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". Empty for a missing or unreadable time. */
export function agoText(at: string | null | undefined, now: number = Date.now()): string {
  const t = at ? Date.parse(at) : Number.NaN
  if (!Number.isFinite(t)) return ''
  const minutes = Math.floor(Math.max(0, now - t) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${plural(minutes, 'minute', 'minutes')} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${plural(hours, 'hour', 'hours')} ago`
  return `${plural(Math.floor(hours / 24), 'day', 'days')} ago`
}

/** "Set by Maria · 2 days ago" — who set a waiting value and when, as far as both are known. */
export function setByText(by: { setAt: string | null; setByName: string | null }, now: number = Date.now()): string {
  const who = by.setByName?.trim() || 'someone'
  const when = agoText(by.setAt, now)
  return `Set by ${who}${when ? ` · ${when}` : ''}`
}

const isDanger = (action: ListingAction) => action === 'end' || action === 'delete'

/** What a Not listed row shows: its Status, Not listed (nothing waits: Publish leaves it out). */
const NOT_LISTED_WHAT: PlanRowWhat = { column: 'status', target: 'not_listed', state: 'not_listed', setAt: null, setByName: null }

/** Why the content of a destination is not sent at all (problems, an earlier publish waiting), or null. */
function contentHeldBy(state: DestinationState): string | null {
  if (state.kind === 'blocked') return state.problems ? NOT_SENT_PROBLEMS : state.reason ?? NOT_SENT_PROBLEMS
  if (state.kind === 'earlier') return NOT_SENT_EARLIER
  return null
}

function lifecycleRow(row: PublishPlanLifecycleRow, ticked: ReadonlySet<string>, now: number): ActionPlanRow {
  const what: PlanRowWhat = row.value === 'delete'
    ? { column: 'send', mode: 'delete', setAt: row.setAt, setByName: row.setByName }
    : { column: 'status', target: row.value, state: row.state, setAt: row.setAt, setByName: row.setByName }
  return {
    key: row.id, kind: 'lifecycle', productId: row.productId, sku: row.sku, what, action: row.action, sent: row.refused ?? row.sentence,
    warning: row.refused ? null : row.warning, checkedAtSend: row.refused ? null : row.checkedAtSend, notSent: row.refused,
    setBy: setByText(row, now), stale: row.stale, tick: row.refused ? 'none' : ticked.has(row.id) ? 'on' : 'off', tickable: !row.refused,
    danger: isDanger(row.action), changeIds: [], defaultFieldIds: [], fields: { ticked: 0, total: 0 }, removals: [], expandable: false,
    creates: null, notListed: false,
  }
}

const rankOf = (row: ActionPlanRow): number => {
  if (row.kind === 'outgrown') return RANK.outgrown
  if (row.kind === 'held' || row.notListed) return RANK.held
  if (row.kind === 'lifecycle') return RANK[row.action ?? 'partial'] ?? RANK.partial
  if (row.notSent || row.tick === 'none') return RANK.idle
  // S10 — a move deletes the old SKU: with the deletes, first.
  if (row.what.column === 'move') return RANK.move
  return row.what.column === 'send' && row.what.mode === 'full' ? RANK.full : RANK.partial
}

/**
 * The ONE table of one market tab: every product of the content review (Partial or Full update), every waiting Status
 * change or Delete, every product whose content is held back, and every value the listing outgrew. Danger rows first,
 * then by SKU.
 */
export function actionPlanRows(entry: Pick<DestinationEntry, 'plan' | 'review' | 'selectedIds' | 'lifecycleIds'>, state: DestinationState, now: number = Date.now()): ActionPlanRow[] {
  const plan = entry.plan
  if (!plan) return []
  const review = entry.review
  const sparse = isSparse(review)
  const held = new Map(plan.contentHeld.map(row => [row.productId, row.reason]))
  // New listings: a held row whose Status (or its family's main row's) is Not listed — a deleted row left off too.
  const heldNotListed = new Set(plan.contentHeld.filter(row => row.notListed || row.deleted).map(row => row.productId))
  const channel = plan.scope.channel
  const ticked = new Set(tickedChanges(entry))
  const lifecycleTicked = new Set(entry.lifecycleIds)
  const blockedBy = contentHeldBy(state)
  const rows: ActionPlanRow[] = []
  const listed = new Set<string>()

  for (const row of review?.rows ?? []) {
    listed.add(row.productId)
    const mode: SendMode = row.mode === 'full' ? 'full' : 'partial'
    const changes = (review?.changes ?? []).filter(c => c.productId === row.productId)
    const usable = changes.filter(c => c.selectable && (!review?.photosOnly || isPhotoChangeId(c.id)))
    const on = usable.filter(c => ticked.has(c.id)).length
    // One-click "Nexus wins": the ticked fields that replace a value on the channel.
    const replacing = usable.filter(c => ticked.has(c.id) && !!c.replaces).length
    const defaults = usable.filter(c => c.selectedByDefault)
    const removals = mode === 'full' ? (review?.removals ?? []).filter(r => r.productId === row.productId).map(r => ({ label: r.label, value: removalText(r.value) })) : []
    const notSent = row.blocked ?? held.get(row.productId) ?? blockedBy
    let sent: string, tick: PlanTick
    if (notSent) { sent = notSent; tick = 'none' }
    else if (!sparse) { sent = row.existing ? WHOLE_AGAIN : WHOLE_NEW; tick = 'whole' }
    else if (!review?.changes) { sent = FIELDS_NOT_LISTED; tick = 'none' }
    else if (!usable.length) { sent = changes.some(c => c.status !== 'SAME') ? NOTHING_SENDABLE : NOTHING_TO_SEND; tick = 'none' }
    else if (mode === 'full') { sent = on ? EVERYTHING_SENT : FULL_UNTICKED; tick = on ? 'on' : 'off' }
    else {
      sent = [`${on.toLocaleString('en')} of ${plural(usable.length, 'field', 'fields')}`, replacing ? replacesCountWords(replacing, channel) : null].filter(Boolean).join(' · ')
      tick = on === 0 ? 'off' : on === usable.length ? 'on' : 'some'
    }
    // Delete and relist: a row its Status lists again says how ("Lists GALE-M on ASIN B0NEW (was B0OLD).") and, when it
    // comes back Inactive, that buyers cannot buy it yet. A deleted row left Not listed is held (below).
    const relist = row.deleted ? null : row.relist ?? null
    const relistWords = relist ? (row.startsAs === 'inactive' ? `${relist.sentence} ${START_AS_WORD.inactive} — ${CREATES_INACTIVE_NOTE}.` : relist.sentence) : null
    // Held back (problems, an earlier publish) it still names the relist, then why it waits.
    if (relistWords) sent = notSent ? `${relistWords} ${notSent}` : tick === 'off' ? `${relistWords} ${RELIST_UNTICKED}` : relistWords
    // S10 — a row the channel holds under another SKU says what this Publish does about it ("Creates GALE-M-IT on Amazon ·
    // IT as a new offer, then deletes GALE-M there."; "eBay renames GALE-M to GALE-M-IT."); a held row says only why it waits.
    // A moved Amazon row (`mode: 'move'`) is the create of NEW and the delete of OLD: its sentence is what is sent.
    const move = row.skuMove ?? null
    const moving = row.mode === 'move' && move?.kind === 'create-delete'
    if (move && !notSent) sent = move.kind === 'none' ? `${sent} · ${move.sentence}` : tick === 'off' ? `${move.sentence} ${MOVE_UNTICKED}`
      : moving ? move.sentence : `${move.sentence} ${sent}`
    // New listings: Not listed leaves the row out (held, with the server's reason); a row this review creates says how.
    const notListed = !!row.notListed || !!row.deleted || heldNotListed.has(row.productId)
    const startsAs = !notListed && !relist && row.startsAs ? row.startsAs : null
    // S10 — the create line names the SKU it sends (the listing's own, when it has one).
    const sentSku = row.sendsSku ?? row.sku
    const creates = startsAs ? { startsAs, sentence: tick === 'off' && !notSent ? `${createsLine(sentSku, startsAs, channel)} ${CREATE_UNTICKED}` : createsLine(sentSku, startsAs, channel) } : null
    // A row not on the channel (created, or listed again) reads Full update: it is always sent whole.
    const newRow = !!creates || !!relist
    const what: PlanRowWhat = notListed ? NOT_LISTED_WHAT
      : moving ? { column: 'move', from: move!.from, to: move!.to }
      : { column: 'send', mode: newRow ? 'full' : mode, setAt: null, setByName: null, ...(newRow ? { newRow } : {}) }
    rows.push({
      key: `content:${row.productId}`, kind: 'content', productId: row.productId, sku: row.sku,
      what, action: null, sent, warning: relist?.warning ?? (move && !notSent ? move.warning : null) ?? null,
      checkedAtSend: null, notSent, setBy: null, stale: false,
      // S10 — a move deletes the old SKU: a danger row, like Delete.
      tick, tickable: tick !== 'none' && tick !== 'whole' && !!review?.id, danger: moving && !notSent,
      changeIds: changes.map(c => c.id), defaultFieldIds: (defaults.length ? defaults : usable).map(c => c.id),
      fields: { ticked: on, total: usable.length }, removals,
      expandable: sparse && !notSent && !moving && (changes.length > 0 || removals.length > 0),
      creates, notListed,
    })
  }
  // Held products the content review does not list (every row is held: there is no review at all).
  for (const row of plan.contentHeld) {
    if (listed.has(row.productId)) continue
    listed.add(row.productId)
    rows.push({
      key: `held:${row.productId}`, kind: 'held', productId: row.productId, sku: row.sku,
      what: row.notListed || row.deleted ? NOT_LISTED_WHAT : { column: 'send', mode: 'partial', setAt: null, setByName: null },
      action: null, sent: row.reason, warning: null, checkedAtSend: null, notSent: row.reason, setBy: null, stale: false, tick: 'none', tickable: false, danger: false,
      changeIds: [], defaultFieldIds: [], fields: { ticked: 0, total: 0 }, removals: [], expandable: false,
      creates: null, notListed: !!row.notListed || !!row.deleted,
    })
  }
  for (const row of plan.lifecycle) rows.push(lifecycleRow(row, lifecycleTicked, now))
  for (const row of plan.outgrown) {
    const what: PlanRowWhat = row.column === 'send'
      ? { column: 'send', mode: row.value as SendMode, setAt: null, setByName: null }
      : { column: 'status', target: row.value as StatusTarget, state: 'unknown', setAt: null, setByName: null }
    const reason = /[.!?]$/.test(row.reason.trim()) ? row.reason.trim() : `${row.reason.trim()}.`
    rows.push({
      key: `outgrown:${row.id}`, kind: 'outgrown', productId: row.productId, sku: row.sku, what, action: null, sent: `${reason} ${CLEARED_ON_SEND}`,
      warning: null, checkedAtSend: null, notSent: NO_LONGER_APPLIES, setBy: null, stale: false, tick: 'none', tickable: false, danger: false,
      changeIds: [], defaultFieldIds: [], fields: { ticked: 0, total: 0 }, removals: [], expandable: false,
      creates: null, notListed: false,
    })
  }
  return rows.map(row => ({ row, rank: rankOf(row) }))
    .sort((a, b) => a.rank - b.rank || (a.row.sku < b.row.sku ? -1 : a.row.sku > b.row.sku ? 1 : 0))
    .map(({ row }) => row)
}

/** The ticks after a row's tick changed: a lifecycle row's own id; a content row's fields (on = its default fields). */
export function toggleRowTicks(row: Pick<ActionPlanRow, 'kind' | 'key' | 'changeIds' | 'defaultFieldIds'>, on: boolean,
  ticks: { selectedIds: readonly string[]; lifecycleIds: readonly string[] }): { selectedIds: string[]; lifecycleIds: string[] } {
  if (row.kind === 'lifecycle') {
    const rest = ticks.lifecycleIds.filter(id => id !== row.key)
    return { selectedIds: [...ticks.selectedIds], lifecycleIds: on ? [...rest, row.key] : rest }
  }
  if (row.kind !== 'content') return { selectedIds: [...ticks.selectedIds], lifecycleIds: [...ticks.lifecycleIds] }
  return { selectedIds: withProductTicks(ticks.selectedIds, row.changeIds, on ? row.defaultFieldIds : []), lifecycleIds: [...ticks.lifecycleIds] }
}

/** One product's field ticks changed inside its row: keep every other product's ticks. */
export function withProductTicks(selectedIds: readonly string[], productChangeIds: readonly string[], chosen: readonly string[]): string[] {
  const mine = new Set(productChangeIds)
  return [...new Set([...selectedIds.filter(id => !mine.has(id)), ...chosen])]
}

// ── What one click sends, over every chosen market ────────────────────────────────────────────────────────────────

export interface PlanConfirm {
  /** What the person types: the family SKU. */
  expected: string
  ended: number
  deleted: number
  /** S10 — live Amazon listings this Publish moves to a new SKU (their old SKU is deleted once Amazon accepts the new one). */
  moved?: number
  /** The destinations with a ticked Ended or Delete row ("eBay · IT"). */
  places: string[]
}

export interface ActionPlanSend {
  /** The chosen markets that send something: content that is ready and/or ticked lifecycle rows. */
  send: string[]
  /** The markets whose content goes (the content plan's `send`). */
  content: string[]
  /** The ticked lifecycle row ids over `send`, as the plan gave them. */
  lifecycle: string[]
  /** The "No longer applies" ids over the chosen markets: cleared when the batch is queued. */
  outgrown: string[]
  counts: PublishPlanCounts
  /** Markets that send a whole new product (Shopify). */
  wholeProducts: number
  /** Ticked Ended and Delete rows need the typed family SKU; null when none is ticked. */
  confirm: PlanConfirm | null
  /** Ended and Delete rows this role cannot send: they stay waiting. */
  roleLocked: { ended: number; deleted: number }
  /** The batch (`{ plan }`), else today's direct submit. */
  batch: boolean
}

/**
 * S10 — the rows of a destination's content review that move a live Amazon listing to a new SKU (create NEW, then delete
 * OLD) and whose create is ticked. Each one needs the typed confirmation.
 */
export function movedRowsTicked(entry: Pick<DestinationEntry, 'review' | 'selectedIds'>): number {
  const review = entry.review
  if (!review?.confirm) return 0
  const ticked = new Set(tickedChanges(entry))
  return review.rows.filter(row => row.skuMove?.kind === 'create-delete'
    && (review.changes ?? []).some(change => change.productId === row.productId && ticked.has(change.id))).length
}

/** A destination's content counts only while it can go (ready, or waiting for an input or a fresh check). */
const contentCounts = (state: DestinationState) => state.kind === 'ready' || state.kind === 'input' || state.kind === 'expired'

/** The lifecycle rows of one destination that are ticked and may be sent. */
export function tickedLifecycleRows(entry: Pick<DestinationEntry, 'plan' | 'lifecycleIds'>): PublishPlanLifecycleRow[] {
  if (!entry.plan) return []
  const ticked = new Set(entry.lifecycleIds)
  return entry.plan.lifecycle.filter(row => !row.refused && ticked.has(row.id))
}

export function actionPlanSend(keys: readonly string[], stateOf: (key: string) => DestinationState, entryOf: (key: string) => DestinationEntry,
  base: ContentPlan = publishPlan(keys, stateOf)): ActionPlanSend {
  const content = [...base.send]
  const send = keys.filter(key => content.includes(key) || tickedLifecycleRows(entryOf(key)).length > 0)
  const lifecycleRows = send.flatMap(key => tickedLifecycleRows(entryOf(key)))
  const lifecycle = lifecycleRows.map(row => row.id)
  const plans = keys.map(key => entryOf(key).plan).filter((plan): plan is PublishPlanDestination => !!plan)
  const fields: Record<string, string[]> = {}
  for (const key of keys) {
    const entry = entryOf(key)
    if (entry.review?.id) fields[entry.review.id] = contentCounts(stateOf(key)) ? tickedChanges(entry) : []
  }
  const counts = publishPlanCounts({ destinations: plans }, { fields, lifecycle })
  const outgrown = plans.flatMap(plan => plan.outgrown.map(row => row.id))

  let confirm: PlanConfirm | null = null
  // S10 — content that moves a live Amazon listing to a new SKU deletes the old SKU: typed like Delete, and sent through
  // the batch, which carries the typed confirmation (`confirmDelete`).
  const moving = content.filter(key => contentCounts(stateOf(key)) && movedRowsTicked(entryOf(key)) > 0)
  if (confirmRowsTicked({ destinations: plans }, lifecycle) > 0 || moving.length) {
    const rows = lifecycleRows.filter(row => row.needsTypedConfirm)
    const places = [...new Set([...send.filter(key => tickedLifecycleRows(entryOf(key)).some(row => row.needsTypedConfirm)), ...moving])].map(key => entryOf(key).plan?.label ?? key)
    const expected = keys.map(key => entryOf(key).familySku).find((sku): sku is string => !!sku)
      ?? moving.map(key => entryOf(key).review?.confirm?.expected).find((sku): sku is string => !!sku) ?? ''
    const moved = moving.reduce((n, key) => n + movedRowsTicked(entryOf(key)), 0)
    confirm = { expected, ended: rows.filter(row => row.action === 'end').length, deleted: rows.filter(row => row.action === 'delete').length, places, ...(moved ? { moved } : {}) }
  }
  const locked = plans.flatMap(plan => plan.lifecycle).filter(row => row.refused === ROLE_CANNOT_END_OR_DELETE)
  const roleLocked = { ended: locked.filter(row => row.action === 'end').length, deleted: locked.filter(row => row.action === 'delete').length }
  const batch = send.length > 0 && (moving.length > 0 || publishPlanUsesBatch({ destinations: plans }, { destinations: send.length, lifecycle }))
  return { send, content, lifecycle, outgrown, counts, wholeProducts: base.wholeProducts, confirm, roleLocked, batch }
}

/**
 * The one summary line: "18 partial updates (41 fields) · 2 full updates · 3 inactive · 1 ended · 1 delete", and the
 * listings it creates ("2 new listings (1 inactive)", counted inside the partial updates).
 */
export function planSummaryLine(counts: PublishPlanCounts, wholeProducts = 0, created?: CreatedCounts | null): string {
  return [publishPlanSummary(counts) || null, wholeProducts ? plural(wholeProducts, 'new product', 'new products') : null, createdWords(created)].filter(Boolean).join(' · ') || NOTHING_HERE
}

/**
 * The chosen markets that send nothing at all: their content is skipped (problems, an earlier publish waiting, a review
 * that failed) and no status change goes there either. A skipped market whose status changes still go is published —
 * its content is blocked, the market is not skipped. The button's "skip N with problems" and the line above the tabs
 * count these, for every caller.
 */
export const marketsSendingNothing = (skipped: readonly string[], sending: readonly string[]): string[] => skipped.filter(key => !sending.includes(key))

/**
 * The line above the tabs when two or more markets are chosen: "3 markets · 18 partial updates (41 fields) · 1 delete ·
 * 1 with problems". A market whose content is blocked but whose status changes still go reads "1 with content blocked".
 */
export function planFamilySummary(markets: number, base: Pick<ContentPlan, 'skipped' | 'nothing' | 'pending'>, counts: PublishPlanCounts, wholeProducts = 0, sending: readonly string[] = [],
  created?: CreatedCounts | null): string {
  const nothing = base.nothing.filter(key => !sending.includes(key)).length
  const problems = marketsSendingNothing(base.skipped, sending).length
  const contentBlocked = base.skipped.length - problems
  return [
    plural(markets, 'market', 'markets'),
    publishPlanSummary(counts) || null,
    wholeProducts ? plural(wholeProducts, 'new product', 'new products') : null,
    createdWords(created),
    problems ? `${problems.toLocaleString('en')} with problems` : null,
    contentBlocked ? `${contentBlocked.toLocaleString('en')} with content blocked` : null,
    nothing ? `${nothing.toLocaleString('en')} with nothing to send` : null,
    base.pending.length ? `${base.pending.length.toLocaleString('en')} not ready yet` : null,
  ].filter(Boolean).join(' · ')
}

/** The few words after a market's code on its tab: "12 changes · 1 delete", "3 problems · 2 inactive", "2 inactive". */
export function planTabWords(state: DestinationState, entry: Pick<DestinationEntry, 'plan' | 'lifecycleIds'>): string {
  const rows = tickedLifecycleRows(entry)
  const lifecycle = publishPlanSummary({
    partial: 0, fields: 0, full: 0, delete: rows.filter(r => r.action === 'delete').length, active: rows.filter(r => r.action === 'resume' || r.action === 'relist').length,
    inactive: rows.filter(r => r.action === 'pause').length, ended: rows.filter(r => r.action === 'end').length,
  })
  const content = state.kind === 'nothing' && lifecycle ? null : reviewTabWords(state)
  return [content, lifecycle || null].filter(Boolean).join(' · ')
}

export const STATUS_CHANGES_STILL_GO = 'The status changes below can still be sent.'

/**
 * The status line of a market's review. A market that sends only status changes is ready, not "Nothing to send"; a
 * market whose content is skipped (problems, an earlier publish waiting, a review that failed) still sends its ticked
 * status changes, so its hint says so instead of "This destination is skipped".
 */
export function planStateLabel(state: DestinationState, entry: Pick<DestinationEntry, 'plan' | 'lifecycleIds'>, label: { label: string; tone: Tone; hint: string }): { label: string; tone: Tone; hint: string } {
  if (!tickedLifecycleRows(entry).length) return label
  if (state.kind === 'nothing') return { label: 'Ready', tone: 'info', hint: 'Only the status changes below are sent here.' }
  if (state.kind === 'blocked') return { ...label, hint: `The content is not sent until the problems are fixed. ${STATUS_CHANGES_STILL_GO}` }
  if (state.kind === 'earlier') return { ...label, hint: `The content waits for the earlier publish. ${STATUS_CHANGES_STILL_GO}` }
  if (state.kind === 'error') return { ...label, hint: `${state.message} ${STATUS_CHANGES_STILL_GO}` }
  return label
}

/** "to end 1 listing and delete 1 on eBay · IT" — the words after "Type GALE-JACKET". */
export function confirmWhat(confirm: Pick<PlanConfirm, 'ended' | 'deleted' | 'places' | 'moved'>): string {
  const parts = [
    confirm.ended ? `end ${plural(confirm.ended, 'listing', 'listings')}` : null,
    confirm.deleted ? (confirm.ended ? `delete ${confirm.deleted.toLocaleString('en')}` : `delete ${plural(confirm.deleted, 'listing', 'listings')}`) : null,
    // S10 — "move 1 listing to its new SKU (its old SKU is deleted)".
    confirm.moved ? `move ${plural(confirm.moved, 'listing', 'listings')} to ${confirm.moved === 1 ? 'its new SKU (its old SKU is deleted)' : 'their new SKUs (their old SKUs are deleted)'}` : null,
  ].filter(Boolean).join(' and ')
  const places = confirm.places.length === 0 ? '' : confirm.places.length <= 2 ? ` on ${confirm.places.join(' and ')}` : ` on ${confirm.places.length} markets`
  return `to ${parts}${places}`
}

/** "Type GALE-JACKET to end 1 listing and delete 1 on eBay · IT". */
export const confirmSentence = (confirm: PlanConfirm) => `Type ${confirm.expected} ${confirmWhat(confirm)}`

/** The disabled button's visible reason: "Type GALE-JACKET below to end 1 listing and delete 1." */
export function confirmReason(confirm: PlanConfirm): string {
  return `Type ${confirm.expected} below ${confirmWhat({ ...confirm, places: [] })}.`
}

/** "1 end stays waiting: your role cannot end or delete listings." — null when the role can. */
export function roleLockSentence(locked: { ended: number; deleted: number }): string | null {
  const total = locked.ended + locked.deleted
  if (!total) return null
  const what = [locked.ended ? plural(locked.ended, 'end', 'ends') : null, locked.deleted ? plural(locked.deleted, 'delete', 'deletes') : null].filter(Boolean).join(' and ')
  return `${what} ${total === 1 ? 'stays' : 'stay'} waiting: your role cannot end or delete listings.`
}

/**
 * The counted button when status changes go out: "Publish 24 listings · end 1 · delete 1". Listings = Partial and Full
 * updates, new products, Active and Inactive; End and Delete are named after them. With only End or Delete: "End 1
 * listing · delete 1", "Delete 1 listing". `sending` = the markets that send something (`ActionPlanSend.send`);
 * "skip N with problems" counts the skipped markets that send nothing at all (`marketsSendingNothing`).
 */
export function planButtonText(counts: PublishPlanCounts, sending: readonly string[], word: { one: string; many: string }, skippedMarkets: readonly string[] = [],
  wholeProducts = 0): string {
  const listings = counts.partial + counts.full + (counts.moved ?? 0) + counts.active + counts.inactive + wholeProducts
  const places = sending.length
  const skipped = marketsSendingNothing(skippedMarkets, sending).length
  const where = places > 1 ? plural(places, word.one, word.many) : ''
  const skip = skipped ? ` · skip ${skipped.toLocaleString('en')} with problems` : ''
  if (listings) {
    const tail = [counts.ended ? `end ${counts.ended.toLocaleString('en')}` : null, counts.delete ? `delete ${counts.delete.toLocaleString('en')}` : null].filter(Boolean)
    return `Publish ${plural(listings, 'listing', 'listings')}${where ? ` to ${where}` : ''}${tail.map(t => ` · ${t}`).join('')}${skip}`
  }
  if (counts.ended) return `End ${plural(counts.ended, 'listing', 'listings')}${where ? ` on ${where}` : ''}${counts.delete ? ` · delete ${counts.delete.toLocaleString('en')}` : ''}${skip}`
  if (counts.delete) return `Delete ${plural(counts.delete, 'listing', 'listings')}${where ? ` on ${where}` : ''}${skip}`
  return skipped ? `Nothing to publish · ${skipped.toLocaleString('en')} with problems` : 'Nothing to publish'
}

/** The send request of one Publish: each sending market with its content (when it goes), the ticked rows, the confirmation. */
export function planSubmit(productId: string, send: ActionPlanSend, entryOf: (key: string) => DestinationEntry, scopeOf: (key: string) => StudioPublishScope | undefined,
  confirmText: string | null): PublishPlanSubmit {
  return {
    productId,
    destinations: send.send.flatMap(key => {
      const entry = entryOf(key), review = entry.review
      const scope = entry.plan?.scope ?? scopeOf(key)
      if (!scope) return []
      if (!send.content.includes(key) || !review?.id) return [{ scope }]
      return [{
        scope, reviewId: review.id,
        ...(isSparse(review) && entry.selection?.token ? { selectionToken: entry.selection.token } : {}),
        ...(!isSparse(review) && entry.confirmedReviewId === review.id ? { confirmOverwrite: true } : {}),
        ...(review.locations ? { locationId: entry.locationId } : {}),
        // S10 — this content deletes an old Amazon SKU (a move): the typed family SKU below confirms it.
        ...(movedRowsTicked(entry) > 0 && send.confirm && confirmText ? { confirmDelete: true } : {}),
      }]
    }),
    lifecycle: [...send.lifecycle],
    ...(send.outgrown.length ? { outgrown: [...send.outgrown] } : {}),
    ...(send.confirm && confirmText ? { confirmText } : {}),
  }
}

// ── The batch, after the click ────────────────────────────────────────────────────────────────────────────────────

const UNKNOWN_META: PublishStatusMeta = { label: CHECK_ON_CHANNEL, tone: 'warning', terminal: true, hint: LIFECYCLE_UNKNOWN }

/**
 * A lifecycle child's words: waiting its turn (PREVIEW) is QUEUED, RUNNING is "Sending", DONE is "Accepted" (only a
 * read-back is Verified), NOT_SENT says why, UNKNOWN reads "Check on the channel".
 */
export function lifecycleChildMeta(child: Pick<PublishPlanBatchChild, 'status' | 'message'>): PublishStatusMeta {
  const status = child.status.toUpperCase()
  if (status === 'PREVIEW') return publicationStatusMeta('QUEUED')
  if (status === 'RUNNING') return publicationStatusMeta('PUBLISHING')
  if (status === 'DONE') return publicationStatusMeta('ACCEPTED')
  if (status === 'UNKNOWN') return UNKNOWN_META
  const meta = publicationStatusMeta(status)
  return status === 'NOT_SENT' && child.message ? { ...meta, hint: child.message } : meta
}

/** One listing's result inside a lifecycle child (`ListingActionRowResult.outcome`). */
export function lifecycleRowMeta(outcome: string): PublishStatusMeta {
  const key = outcome.toUpperCase()
  if (key === 'DONE') return publishResultMeta('ACCEPTED')
  if (key === 'UNKNOWN') return UNKNOWN_META
  return publishResultMeta(key)
}

/** Any child's words: content children keep the batch's own vocabulary. */
export const planChildMeta = (child: Pick<PublishPlanBatchChild, 'status' | 'checked' | 'message'> & { kind?: string }) =>
  child.kind === 'lifecycle' ? lifecycleChildMeta(child) : batchChildMeta(child)

/** The children of one market: its content review (by id) and its lifecycle changes (by destination). */
export function destinationChildren(children: readonly PublishPlanBatchChild[], reviewId: string | null | undefined,
  destination: { channel: string; marketplace: string; accountId: string; aliasKey: string } | null | undefined): PublishPlanBatchChild[] {
  return children.filter(child => (reviewId && child.publicationId === reviewId) || (child.kind === 'lifecycle' && !!destination
    && child.channel === destination.channel && child.marketplace === destination.marketplace && child.accountId === destination.accountId
    && (child.aliasKey ?? '') === destination.aliasKey))
}

/** One line of a market's results: the content, or one listing of a lifecycle change. */
export interface PlanResultRow { key: string; sku: string; what: string; meta: PublishStatusMeta; message: string | null }

/**
 * A market's results: the content child, and each listing of each status change. A status change that has no rows yet
 * (waiting its turn, sending, or refused before sending) lists the rows that were sent for it (`sent`, the market's
 * ticked lifecycle rows of that action), so every row still names its SKU.
 */
export function planResultRows(children: readonly PublishPlanBatchChild[], contentSku: string,
  sent: ReadonlyArray<Pick<PublishPlanLifecycleRow, 'id' | 'sku' | 'action'>> = []): PlanResultRow[] {
  return children.flatMap((child): PlanResultRow[] => {
    if (child.kind !== 'lifecycle') {
      return [{ key: child.publicationId, sku: child.familySku ?? contentSku, what: 'Content (Partial and Full update)', meta: batchChildMeta(child), message: child.message }]
    }
    const what = child.action ? LISTING_ACTION_LABEL[child.action] : 'Status change'
    if (child.rows?.length) {
      return child.rows.map((row, at) => {
        const deletedDone = child.action === 'delete' && row.outcome === 'DONE'
        // The server's row says where it was deleted and how to list it again; an older answer without words gets them here.
        const words = row.message || (deletedDone ? deleteDoneSentence(destinationWords(child)) : null)
        const final = deletedDone ? `${DELETE_CANNOT_UNDO}.` : null
        return { key: `${child.publicationId}:${row.listingId ?? at}`, sku: row.sku, what, meta: lifecycleRowMeta(row.outcome),
          message: [words, final].filter(Boolean).join(' ') || null }
      })
    }
    const meta = lifecycleChildMeta(child)
    const mine = child.action ? sent.filter(row => row.action === child.action) : []
    if (mine.length) return mine.map(row => ({ key: `${child.publicationId}:${row.id}`, sku: row.sku, what, meta, message: child.message }))
    return [{ key: child.publicationId, sku: '—', what, meta, message: child.message }]
  })
}

/** "Amazon · IT", "eBay · DE", "Shopify" — as the listing-action engine names a destination. */
function destinationWords(child: Pick<PublishPlanBatchChild, 'channel' | 'marketplace'>): string {
  const channel = child.channel ? channelLabel(child.channel) : 'the channel'
  return child.channel === 'SHOPIFY' || !child.marketplace || child.marketplace === 'GLOBAL' ? channel : `${channel} · ${child.marketplace}`
}

const SUCCEEDED = new Set(['ACCEPTED', 'VERIFIED', 'DONE'])

/** A market's tab word once sent: one child keeps its own word; several say "2 of 3 done", then "done" or "1 not done". */
export function planResultWord(children: readonly PublishPlanBatchChild[]): string | null {
  if (!children.length) return null
  if (children.length === 1) return planChildMeta(children[0]).label
  const finished = children.filter(child => child.terminal).length
  if (finished < children.length) return `${finished} of ${children.length} done`
  const bad = children.filter(child => !SUCCEEDED.has(child.status.toUpperCase())).length
  return bad ? `${bad} not done` : 'done'
}

/** One sentence for the whole batch: its steps (a content review or one status change each) and how they ended. */
export function planBatchSentence(view: Pick<PublishPlanBatchView, 'children' | 'counts' | 'done' | 'outcome'>): string {
  const total = view.children.length
  const done = view.children.filter(child => child.terminal).length
  const c = view.counts
  const steps = (n: number) => plural(n, 'step', 'steps')
  if (view.outcome === 'CANCELLED') return `Cancelled. ${c.cancelled} of ${steps(total)} ${c.cancelled === 1 ? 'was' : 'were'} not sent.`
  if (!view.done) return `${done} of ${steps(total)} have a result.`
  const parts = [
    c.succeeded ? `${c.succeeded} accepted` : null,
    c.partial ? `${c.partial} partly failed` : null,
    c.failed ? `${c.failed} failed` : null,
    c.notSent + c.blocked ? `${c.notSent + c.blocked} not sent` : null,
    c.unknown ? `${c.unknown} to check on the channel` : null,
    c.cancelled ? `${c.cancelled} cancelled` : null,
    c.checked ? `${c.checked} checked by a person` : null,
  ].filter(Boolean)
  return `All ${steps(total)} have a result: ${parts.join(', ')}.`
}

// ── Done, with Undo ───────────────────────────────────────────────────────────────────────────────────────────────

/** What Undo can put back after Done: paused rows resume, ended rows relist (both: Status Active again); a delete cannot. */
export interface PlanUndo {
  listingIds: string[]
  resumed: number
  relisted: number
  /** Of `relisted`, the eBay ones: eBay gives a relisted listing a new item number. */
  ebayRelisted: number
  deleted: number
}

export function planUndo(children: readonly PublishPlanBatchChild[]): PlanUndo {
  const undo: PlanUndo = { listingIds: [], resumed: 0, relisted: 0, ebayRelisted: 0, deleted: 0 }
  for (const child of children) {
    if (child.kind !== 'lifecycle' || !child.rows) continue
    for (const row of child.rows) {
      if (row.outcome !== 'DONE') continue
      if (child.action === 'delete') { undo.deleted += 1; continue }
      if ((child.action !== 'pause' && child.action !== 'end') || !row.listingId || undo.listingIds.includes(row.listingId)) continue
      undo.listingIds.push(row.listingId)
      if (child.action === 'pause') undo.resumed += 1
      else { undo.relisted += 1; if (child.channel === 'EBAY') undo.ebayRelisted += 1 }
    }
  }
  return undo
}

/** "Undo: set 3 listings Active again" — null when nothing can be undone. */
export function undoButtonText(undo: PlanUndo): string | null {
  return undo.listingIds.length ? `Undo: set ${plural(undo.listingIds.length, 'listing', 'listings')} Active again` : null
}

/** What Undo does, and what it cannot do. Null when there is nothing to say. */
export function undoSentence(undo: PlanUndo): string | null {
  const lines: string[] = []
  if (undo.listingIds.length) {
    const how = [undo.resumed ? `${undo.resumed.toLocaleString('en')} resume` : null, undo.relisted ? `${undo.relisted.toLocaleString('en')} relist` : null].filter(Boolean).join(', ')
    lines.push(`Undo sets Status to Active on ${plural(undo.listingIds.length, 'listing', 'listings')} (${how}) and opens the review again. Nothing is sent until you press Publish.`)
    if (undo.ebayRelisted) lines.push('eBay gives a relisted listing a new item number.')
  }
  if (undo.deleted) lines.push(`${plural(undo.deleted, 'deleted listing', 'deleted listings')}: ${DELETE_CANNOT_UNDO.toLowerCase()}. ${undo.deleted === 1 ? 'It reads' : 'They read'} Not listed in the sheet; Publish skips ${undo.deleted === 1 ? 'it' : 'them'}. ${undo.deleted === 1 ? RELIST_HOW : 'To list them again, set their Status to Active and Publish.'}`)
  return lines.length ? lines.join(' ') : null
}
