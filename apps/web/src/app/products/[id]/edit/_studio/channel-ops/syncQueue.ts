import type { SyncQueueSource } from '../presence/types'
/**
 * PES.3 — the Errors & Sync console's core: turning a queue into a set of problems.
 *
 * Owner-approved (#127) as a studio tab on a channel scope, **sync-queue-first**: one live pane over
 * `OutboundSyncQueue`, because that is the only source with data. Measured on prod 2026-09-01:
 * 37,846 rows, **2,553 dead** — while `ListingIssue`, `AmazonSuppression` and validation failures
 * are all at ZERO. A four-pane console would have been three empty panes.
 *
 * ── Why grouping is the feature, not the formatting ─────────────────────────────────────────────
 * 2,553 rows sorted by date is a list nobody reads. The same rows grouped by CAUSE are usually a
 * handful of problems — one incident that retried itself two thousand times looks identical to two
 * thousand independent failures until you group them, and the operator's next action is completely
 * different in each case. Ratified in #127: the console's job is to reveal "three failures,
 * repeated", never to imply thousands of separate ones.
 *
 * Pure: no React, no fetch. Tested beside this file.
 */

/**
 * One queued outbound write — mirrors `sync-queue.service.ts`'s `SyncQueueRow` FIELD FOR FIELD.
 *
 * Checked against the service rather than written from the schema: I asked for a `sku` and did not
 * get one, so nothing here pretends to have it. An incomplete mirror has cost this programme five
 * defects, one of them a false "0% ready" on a real screen — the discipline is to match what is
 * actually sent, including the fields I would have preferred were different.
 */
/**
 * Why a write failed — derived by the server from `errorMessage`, NOT `errorCode`.
 *
 * Confirms PES.3-1 from the other side: 2,490 failed rows share the single code
 * `MAX_RETRIES_EXCEEDED`, covering both deliberate gating and genuine marketplace refusals.
 * `unknown` is deliberately NOT a synonym for `rejected` — an unclassified failure deserves a look.
 */
export type SyncFailureReason = 'gated' | 'throttled' | 'rejected' | 'internal' | 'unknown'

export interface SyncQueueRow {
  id: string
  productId: string | null
  channelListingId: string | null
  /** Which product this write is for. An operator cannot act on an opaque cuid. */
  sku: string | null
  /**
   * The alias, when the server could resolve one — COMPONENTS, never a composed row id.
   * `aliasResolved: false` means unknown, and unknown is not "primary".
   */
  aliasId: string | null
  aliasKey: string | null
  aliasResolved: boolean
  reason: SyncFailureReason
  reasonSummary: string
  /**
   * False when nothing is wrong and no operator action exists.
   *
   * 🔴 Consumed, never re-derived here — and it depends on the row's STATE, not its cause alone.
   * The first version of this contract answered from cause only, and every `throttled` row read as
   * "it will retry without you" when all 377 of them were `isDead` with retries exhausted: the
   * writes never reached the channel and never would. My pane rendered 33 of those quiet and told
   * an operator "3 need you" when the answer was 36 (PES.3-17).
   */
  reasonActionable: boolean
  /**
   * Can this row still make progress on its own?
   *
   * The field that makes the distinction legible: `throttled + willRetry` is genuinely fine,
   * `throttled + !willRetry` is a write that was lost while being deferred. Same cause, opposite
   * verdicts — **a cause is not a verdict.**
   */
  reasonWillRetry: boolean
  targetChannel: string
  targetRegion: string | null
  syncType: string
  syncStatus: string
  /** Null until the write actually landed — what separates "old" from "STUCK". */
  syncedAt: string | null
  createdAt: string
  updatedAt: string
  /**
   * 🔴 Deliberately NOT rendered, and read `> now()` if it ever is.
   *
   * Measured 2026-09-01: of 2,553 dead rows, 2,494 carry a `nextRetryAt` and **zero are in the
   * future** (latest 03:52 against a 19:37 clock). So the field says "was scheduled", never "is
   * scheduled" — a reader testing `IS NOT NULL` concludes a dead write is queued to retry; a reader
   * testing `> now()` correctly sees nothing. If this is ever surfaced, the honest label is
   * **"retry window passed"**.
   */
  nextRetryAt: string | null
  holdUntil: string | null
  retryCount: number
  maxRetries: number
  isDead: boolean
  diedAt: string | null
  errorCode: string | null
  errorMessage: string | null
  externalListingId: string | null
}

/** The page as PES.5 serves it (§13). */
export interface SyncQueuePage {
  /** Missing coverage is unknown, never an empty source inventory. */
  sources?: SyncQueueSource[]
  scope: {
    productId: string
    familyIds: string[]
    channel: string | null
    marketplace: string | null
    filter: 'all' | SyncFilter
    /**
     * 🔴 What this view CANNOT see, in the server's own words — rendered always.
     * Measured by PES.5: 86% of the queue (32,665 rows) is attached to no product at all, so a
     * product-scoped view can never show it. An empty panel is exactly the shape that reads as
     * reassurance, so the pane says what is outside its reach rather than letting silence imply
     * "nothing is wrong".
     */
    coverageNote: string
  }
  counts: { all: number; dead: number; retrying: number; stuck: number }
  /**
   * 🔴 The server's OWN cause rollup — authoritative totals, computed over the whole queue rather
   * than the page (#357). Consume these for any statement about how many causes exist.
   *
   * Measured on `normal-knee-slider-yellow`: 1,239 rows, and the server reports **3** causes —
   * `unknown` 1,167 · `throttled` 52 (37 actionable) · `rejected` 20. The 200-row page this console
   * receives contained **2**, because a whole cause sorted below the boundary. An operator reading
   * the page-derived figure would have concluded "only rejections here" and been wrong — which is
   * the difference between a console that is incomplete and one that is misleading.
   *
   * Grouped by `reason`, a coarser axis than this file's message-level `groupByCause`. Both are
   * useful and they are not interchangeable: the server says how many KINDS of problem exist, the
   * client says which distinct failures are visible in the page.
   */
  causes: ServerCause[]
  /** Total writes behind `causes[]` — the denominator, never `rows.length`. */
  causesTotal: number
  rows: SyncQueueRow[]
  stuckThresholdHours: number
}

/** One entry of the server's rollup (#357). `reason`, not `cause` — it groups by the classifier. */
export interface ServerCause {
  reason: SyncFailureReason
  count: number
  actionableCount: number
  mostRecent: string
  sampleSummary: string
}

export type SyncFilter = 'dead' | 'retrying' | 'stuck'

/** Rows stuck longer than this with no resolution are their own problem, whatever their status. */
export const STUCK_AFTER_MS = 24 * 60 * 60 * 1000

export function matchesFilter(row: SyncQueueRow, filter: SyncFilter, now: number): boolean {
  switch (filter) {
    case 'dead':
      return row.isDead
    case 'retrying':
      return !row.isDead && row.retryCount > 0
    case 'stuck':
      // Not "old" — old and STILL unresolved. A row that succeeded three days ago is not stuck.
      return !row.isDead && !row.syncedAt && now - Date.parse(row.createdAt) > STUCK_AFTER_MS
  }
}

/**
 * Codes that name what the QUEUE did, not what went wrong.
 *
 * 🔴 Measured on prod 2026-09-01, and it inverted this function's first rule. `errorCode` looked
 * like the stable, channel-supplied vocabulary — but the two codes that cover **97% of every coded
 * row** are lifecycle outcomes:
 *
 *   MAX_RETRIES_EXCEEDED  2,490 rows — 308 distinct messages
 *   WRITE_GATE_DENIED     2,198 rows — 300 distinct messages
 *
 * Grouping by code renders this console as two groups named after the queue giving up. Underneath
 * MAX_RETRIES_EXCEEDED alone sit at least four unrelated problems: an eBay `get offers` 404
 * (1,708), our own circuit breaker (377), and **NEXUS_ENABLE_AMAZON_PUBLISH=false (356) plus
 * NEXUS_ENABLE_EBAY_PUBLISH=false (12) — a flag deliberately switched off, not a failure at all**.
 * A console that reports 2,490 broken writes when 368 of them are a switch someone turned on
 * purpose is worse than no console. Same under WRITE_GATE_DENIED: `entity_bounds` (a bid over its
 * ceiling) and `campaign_allowlist` (a campaign not allowed) are different decisions, both intended.
 *
 * So these fall THROUGH to the message. Nothing is lost: those messages carry their own prefix.
 */
export const OUTCOME_CODES = new Set(['MAX_RETRIES_EXCEEDED', 'WRITE_GATE_DENIED'])

/**
 * The cause a row is grouped under.
 *
 * A channel's own rejection code (`EBAY_VALIDATION`, `EBAY_LISTING_ENDED`) IS the cause and is used
 * as-is. A lifecycle code is not (see `OUTCOME_CODES`), so those fall back to the MESSAGE — which
 * requires normalising it: the same failure arrives with an item id, a timestamp or a retry ordinal
 * embedded, and ungrouped those read as thousands of distinct causes, which is precisely the
 * illusion this console exists to dispel.
 */
export function causeOf(row: SyncQueueRow): string {
  const code = row.errorCode?.trim()
  if (code && !OUTCOME_CODES.has(code)) return code
  const raw = row.errorMessage?.trim()
  if (!raw) return code || 'No error recorded'
  return normaliseMessage(raw)
}

/**
 * Strip the parts of a message that differ per occurrence but not per cause.
 *
 * Deliberately conservative: it removes ids, numbers and timestamps, and nothing else. An
 * over-eager normaliser collapses two genuinely different failures into one group, which hides a
 * problem instead of revealing one — the opposite failure to the one we are fixing, and harder to
 * notice because the console still looks tidy.
 */
export function normaliseMessage(message: string): string {
  return message
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '…') // timestamps, BEFORE the digit rule eats them
    // cuid/uuid-shaped ids: a 20+ character alphanumeric run is never a word. Measured need: four
    // `campaign_allowlist` groups differing only by a cuid, which the hex rule below cannot see
    // because a cuid contains letters past f.
    .replace(/\b[a-z0-9]{20,}\b/gi, '…')
    .replace(/\b[0-9a-f]{8,}\b/gi, '…') // hex ids, hashes, ItemIDs
    // 🔴 NO trailing \b. Written as `\b\d+\b` this rule silently skipped every number glued to a
    // unit — `Retry in 427s.` kept its 427, because 7→s is not a word boundary — and the real GALE
    // queue then grouped into **33 causes for 36 rows**, one per retry timer: the exact illusion of
    // "thousands of separate failures" this console exists to dispel, produced by the code meant to
    // prevent it. With this fixed the same rows group into 2.
    .replace(/\d+/g, '…') // counts, ordinals, retry timers, status codes
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

export interface SyncCause {
  cause: string
  rows: SyncQueueRow[]
  /**
   * Distinct PRODUCTS affected — the number that says whether this is broad or deep.
   * Named `products`, not `skus`: the server's row carries no SKU, and calling a product count a
   * SKU count would be a small lie that reads as a precise one.
   */
  products: number
  /** Oldest row in the group, so an operator can see how long it has been failing. */
  since: string
  /**
   * The lifecycle codes present in the group, e.g. `MAX_RETRIES_EXCEEDED`. Kept out of the group
   * NAME (they are outcomes, not causes) but not thrown away: "gave up" and "still deferring" are
   * different situations for the same underlying problem.
   */
  codes: string[]
}

/**
 * Group rows by cause, largest first.
 *
 * Returns a PRODUCT count alongside the row count on purpose: 2,000 rows across 3 products is one
 * product retrying itself into the ground; 2,000 rows across 2,000 products is a channel-wide
 * outage. The row count alone cannot tell those apart, and they need opposite responses.
 */
export function groupByCause(rows: SyncQueueRow[]): SyncCause[] {
  const byCause = new Map<string, SyncQueueRow[]>()
  for (const r of rows) {
    const c = causeOf(r)
    const list = byCause.get(c)
    if (list) list.push(r)
    else byCause.set(c, [r])
  }
  return [...byCause.entries()]
    .map(([cause, group]) => ({
      cause,
      rows: group,
      products: new Set(group.map((r) => r.productId ?? r.channelListingId ?? r.id)).size,
      since: group.reduce((oldest, r) => (r.createdAt < oldest ? r.createdAt : oldest), group[0].createdAt),
      codes: [...new Set(group.map((r) => r.errorCode).filter((c): c is string => !!c))].sort(),
    }))
    .sort((a, b) => b.rows.length - a.rows.length || a.cause.localeCompare(b.cause))
}

/**
 * The one-line verdict above the groups.
 *
 * Says the shape, not just the size — "2,553 failures across 3 causes" is actionable where "2,553
 * failures" is only alarming.
 */
export function summarise(serverCauses: ServerCause[], total: number, filterLabel: string): string {
  if (total === 0) return 'Nothing queued or failing on this coordinate.'
  const n = (v: number) => v.toLocaleString('en-GB')
  const causeWord = serverCauses.length === 1 ? 'cause' : 'causes'

  /**
   * Both numbers come from the SERVER's rollup, so neither is a page reporting itself as a total.
   * The previous version derived them from the rows in hand — 50 of 269 printed beside a chip
   * reading `Dead (269)` — and the "N causes" it printed could be short by a whole cause.
   */
  const need = serverCauses.reduce((a, c) => a + c.actionableCount, 0)
  const needPart =
    need === total ? '' : ` · ${need === 0 ? 'none need you' : `${n(need)} ${need === 1 ? 'needs' : 'need'} you`}`
  return `${n(total)} ${filterLabel} across ${serverCauses.length} ${causeWord}${needPart}`
}

/** Sources this console would show if they ever held data — named so silence is not read as "none". */
export const DORMANT_SOURCES = [
  { key: 'rejections', label: 'Channel rejections', table: 'ListingIssue' },
  { key: 'suppressions', label: 'Suppressions', table: 'AmazonSuppression' },
  { key: 'validation', label: 'Validation failures', table: 'ChannelListing.validationStatus' },
] as const

/* ── the publish gate, which decides whether retrying anything here could work ─────────────── */

/** The server's own vocabulary (`ebay-publish-gate.service.ts`), mirrored, not re-derived. */
/**
 * The server's publish-mode vocabulary — **re-exported, not re-declared** (#334).
 *
 * P4-3 produced two copies of this union, and closing it by agreeing the members produced two
 * IDENTICAL copies, which is the same fault one step later: the next divergence would type-check on
 * both sides. `_studio/types.ts` is the canonical home — frame-level and channel-neutral — and this
 * line exists so `gateNote` and `modeForChannel` read from it rather than from a twin.
 */
import type { PublishMode } from '../types'
export type { PublishMode }

/** `GET /api/listings/publish-readiness` — one read, all three channels. */
export interface PublishReadiness {
  amazon: { enabled: boolean; mode: PublishMode; sellerIdPresent?: boolean; lwaCredsPresent?: boolean; liveReady?: boolean }
  ebay: { enabled: boolean; mode: PublishMode }
  shopify: { enabled: boolean; mode: PublishMode; configured?: boolean }
}

export function modeForChannel(readiness: PublishReadiness | null, channel: string): PublishMode | null {
  if (!readiness) return null
  const key = channel.toLowerCase()
  if (key === 'amazon') return readiness.amazon?.mode ?? null
  if (key === 'ebay') return readiness.ebay?.mode ?? null
  if (key === 'shopify') return readiness.shopify?.mode ?? null
  // 🔴 null, not a guess. WooCommerce and Etsy have no gate in this response, and answering
  // 'live' for a channel the server did not describe would be the most dangerous possible default.
  return null
}

/**
 * What the current mode means for the writes in this console.
 *
 * 🔴 This is a claim about the queue, so it was measured before it was written, not inferred from
 * the flag's name: `outbound-sync.service.ts:1209` calls the SAME `getEbayPublishMode()` that the
 * sheet's preflight reports, and on `'gated'` fails the write with the message that appears
 * verbatim on 368 queue rows (`NEXUS_ENABLE_*_PUBLISH=false — set true to enable … outbound sync.`).
 * One helper, both paths. Without that check this banner would be a plausible guess presented in
 * the same voice as a fact.
 *
 * Returns null when there is nothing worth saying — `live`, or a channel whose gate this response
 * does not describe.
 */
export { gateNote } from '@nexus/shared/publish-gate'


/* ── jumping to the row, now that the alias is knowable ────────────────────────────────────── */

/**
 * The sheet row id for a queue row, or **null** when it cannot be known.
 *
 * The composition lives HERE, on the sheet side, which is the whole reason PES.5 returns components
 * (hub #143): the format `${aliasKey || 'primary'}:${productId}` is this lane's and has already
 * changed once. A server that composed it would emit ids resolving to nothing the next time it
 * changes, and the symptom — a jump that silently does nothing — reads as a UI bug forever.
 *
 * 🔴 `aliasResolved: false` returns null rather than guessing `primary`. Measured by PES.5: 396 of
 * 441 rows on this family resolve, 45 do not. Guessing is right today and silently wrong the moment
 * a second alias exists — and a jump to the wrong row is worse than no jump, because the operator
 * believes it.
 */
export function jumpTargetOf(row: SyncQueueRow): string | null {
  if (!row.aliasResolved || !row.productId) return null
  // An empty `aliasKey` with `aliasResolved: true` is the server saying "known PRIMARY".
  const key = row.aliasId ?? (row.aliasKey ? row.aliasKey : 'primary')
  return `${key}:${row.productId}`
}

/**
 * How many of these actually need a person.
 *
 * 🔴 The number that stops this console repeating, one level up, the illusion it was built to
 * dispel. Measured on the real GALE eBay·IT coordinate: 36 dead writes, of which **33 are our own
 * circuit breaker deferring** (`throttled` — "it will retry without you") and only **3 are genuine
 * rejections**. Rendering 36 with equal weight tells an operator they have 36 problems.
 */
export function actionableCount(rows: SyncQueueRow[]): number {
  return rows.filter((r) => r.reasonActionable).length
}

/**
 * Is this group safe to render quietly?
 *
 * 🔴 NOT `reason === 'throttled' || reason === 'gated'`. That was the bug: it toned a group by its
 * CAUSE, and a throttled row that died mid-defer is a lost write wearing a reassuring label. Tone
 * follows the verdict the server computed from cause AND state, so the quiet styling can only ever
 * be applied to rows that genuinely need nobody.
 */
export function groupIsQuiet(cause: SyncCause): boolean {
  return cause.rows.every((r) => !r.reasonActionable)
}

/**
 * The server's own one-sentence verdict for a group, or null when its rows disagree.
 *
 * Rendered rather than paraphrased: "Gave up while throttled — this write never reached the channel
 * and will not retry" is the sentence an operator needs, and any shorter label I write for it
 * (`throttled`) is the very compression that hid the problem in the first place.
 */
export function groupVerdict(cause: SyncCause): string | null {
  const first = cause.rows[0]?.reasonSummary ?? null
  return first && cause.rows.every((r) => r.reasonSummary === first) ? first : null
}

/** The dominant reason in a group, for tone. A group is one cause, so its rows agree in practice. */
export function groupReason(cause: SyncCause): SyncFailureReason {
  const counts = new Map<SyncFailureReason, number>()
  for (const r of cause.rows) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1)
  let best: SyncFailureReason = 'unknown'
  let n = -1
  for (const [reason, count] of counts) if (count > n) { best = reason; n = count }
  return best
}
