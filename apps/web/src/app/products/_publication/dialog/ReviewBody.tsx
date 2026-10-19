'use client'

import { blockedChanges, blockingIssues, type StudioPublishReview, type StudioPublishSelection } from '@nexus/shared/studio-publication'
import type { PublishStatusMeta } from '@/design-system/grid/renderers/publishStatus'
import { Select } from '@/design-system/primitives'
import { Banner, Disclosure, Field, MetricStrip } from '@/design-system/components'
// The DS grid's DataGrid (AG Grid), as the Import dialog lists its rows (audit D4: one way to list rows in both dialogs).
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { channelLabel } from '@nexus/shared/channel-label'
import { PublicationOverwrite } from './PublicationOverwrite'
import { PublicationChanges } from './PublicationChanges'
import { ReviewTable } from './ReviewTable'
import { DiffersSummary } from './DiffersSummary'
import { reviewRowListingWord, shopifyVisibilityWords, type ActionPlanRow } from './actionPlan'
import { isSparse } from './destinations'
import { leftOutCount, listingDisplayLabel, problemCount, publicationProblems, type PublicationProblemRow } from './model'
import { problemBanner } from './reviewRows'
import styles from './publication.module.css'

/**
 * The review's destination as one line: account (or, when the account has no name, the channel), listing, market.
 * Empty parts are skipped, so the line never starts or ends with a lone " · " (a nameless account printed
 * "· Primary listing · IT"). `listing`: the window's own name for the listing, with the sheet band's mark ("① Racing
 * edition", "★ Main listing"), used in place of the review's `aliasLabel` when its market has more than one listing.
 */
export function publicationDestinationParts(review: Pick<StudioPublishReview, 'accountLabel' | 'aliasLabel' | 'scope'>, withListing = true, listing?: string | null): { lead: string; rest: string } {
  const named = (value: string | null | undefined) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
  const lead = named(review.accountLabel) ?? channelLabel(review.scope.channel)
  // One word for the main listing in the window (review 2026-10-05, m3): the server's "Primary listing" reads "Main listing".
  const own = named(review.aliasLabel)
  const rest = [withListing ? named(listing) ?? (own === null ? null : listingDisplayLabel(own)) : null, named(review.scope.marketplace)].filter((part): part is string => part != null).join(' · ')
  return { lead, rest }
}

type ReviewRow = StudioPublishReview['rows'][number]
// Audit D4 — what to fix, by SKU, in one table; the channel's own words under it, muted.
// The widths fit the Publish window's body (1040 px window, grid audit D2: 740 px of columns sat in a 622 px grid, and the
// end of every message was cut); the words wrap, the channel's own detail whole under them (D6: it was cut to 3 lines).
const PROBLEM_COLUMNS: Column<PublicationProblemRow>[] = [
  { key: 'sku', label: 'SKU', width: 180, className: styles.skuCol, render: row => <span className={styles.sku}>{row.sku}</span> },
  { key: 'fix', label: 'What to fix', width: 600, className: styles.textCol, render: row => <span className={styles.fix}>
    <span>{row.message}</span>{row.detail && <span className={styles.detail}>{row.detail}</span>}</span> },
]
const PRODUCT_COLUMNS: Column<ReviewRow>[] = [
  { key: 'sku', label: 'SKU', width: 180, className: styles.skuCol, render: row => <span className={styles.sku} title={row.sku}>{row.sku}</span> },
  { key: 'title', label: 'Title', width: 420, className: styles.textCol, render: row => <span className={styles.fix}>{row.title}</span> },
  // New listings: how a created row starts ("New listing · Inactive"), or that Publish leaves it out.
  { key: 'listing', label: 'Listing', width: 150, render: row => reviewRowListingWord(row) },
]

/**
 * Build shape v2 (P10) — the market's part of the Publish plan: its one summary line and its one table (content rows,
 * waiting Status changes and Deletes, held rows, values that no longer apply). With it, the review's own field list and
 * products table give way to that table; without it (the products list's rows) the body is today's.
 */
export interface ReviewBodyPlan {
  /** The destination key: the table's market. */
  key: string
  /** The channel ("AMAZON"), for the words of a line that replaces a channel value. */
  channel: string
  /** "Amazon · IT" — the plan's own label, for a market with no content review. */
  label: string
  /** The one summary line for this market. */
  summary: string
  rows: ActionPlanRow[]
  lifecycleIds: string[]
  /** The content review could not be made (plain English); the status changes can still be sent. */
  contentError: string | null
  now: number
  /** After the send: each row that went, with its real result (`planRowResults`); absent before. */
  results?: ReadonlyMap<string, PublishStatusMeta> | null
  onTicksChange(next: { selectedIds: string[]; lifecycleIds: string[] }): void
}

export interface ReviewBodyProps {
  /** The content review. Null only with `plan`: no content goes out on this market (every row is held, or it failed). */
  review: StudioPublishReview | null
  selectedIds: string[]
  /** The exact request for the ticked fields, once prepared (Amazon and eBay). */
  selection: StudioPublishSelection | null
  /** One-click publish: the exact request is being built (it is built by itself when the review arrives or ticks change). */
  selecting?: boolean
  locationId: string
  confirmed: boolean
  /** Nothing can change: a publish is under way or done, or the dialog is busy. */
  locked: boolean
  onSelectionChange(ids: string[]): void
  onLocationChange(id: string): void
  onConfirmChange(confirmed: boolean): void
  /** The Publish window's plan for this market (build shape v2). */
  plan?: ReviewBodyPlan | null
  /**
   * One-click "Nexus wins" (SIMPLIFY item 3): the one line at the top that counts the values on the channel that
   * differ from Nexus, with the "Keep Amazon's values" switch (`DiffersSummary`). Off where the window has its own.
   */
  nexusWins?: boolean
  /**
   * Aliases (Owner 2026-10-05): which listing of its market this review is, with the sheet band's mark ("① Racing
   * edition", "★ Main listing"); null when the market has one listing (the review's own words then).
   */
  listing?: string | null
  /**
   * The sheet behind the window shows this market: a problem that names a product offers "Show in sheet" (the window
   * closes, the sheet lands on its row and field). Absent where the sheet cannot land.
   */
  onShowField?(destinationKey: string, productId: string, field: string | null): void
}

/** The closed fold's words: "Exact request to the channel · 12 changes affecting 3 products", or that it is being prepared. */
export function exactRequestSummary(selection: Pick<StudioPublishSelection, 'fieldCount' | 'products'> | null, selecting = false): string {
  if (!selection) return selecting ? 'Exact request to the channel · preparing…' : 'Exact request to the channel'
  const n = (count: number, one: string, many: string) => `${count.toLocaleString('en')} ${count === 1 ? one : many}`
  return `Exact request to the channel · ${n(selection.fieldCount, 'change', 'changes')} affecting ${n(selection.products.length, 'product', 'products')}`
}

/** One destination's review — the same body the single-destination dialog has always shown, plus the plan's table. */
export function ReviewBody(props: ReviewBodyProps) {
  const { review, plan } = props
  if (!review) {
    if (!plan) return null
    return <div className={styles.body}>
      <p><strong>{plan.label}</strong></p>
      {plan.contentError && <Banner tone="warning" title="The content review could not be made">{plan.contentError} The status changes below can still be sent.</Banner>}
      <PlanPart plan={plan} review={null} selectedIds={props.selectedIds} locked={props.locked} onShowField={props.onShowField} />
    </div>
  }
  return <ContentReviewBody {...props} review={review} />
}

/** The summary line and the one table of a market: one row per change, its problems first (grid audit wave 3). */
function PlanPart({ plan, review, selectedIds, locked, onShowField }: { plan: ReviewBodyPlan; review: StudioPublishReview | null; selectedIds: string[]; locked: boolean
  onShowField?: ReviewBodyProps['onShowField'] }) {
  return <>
    <p className={styles.planSummary} role="status">{plan.summary}</p>
    <ReviewTable locked={locked} now={plan.now} ariaLabel={`Changes in this publish to ${plan.label}`} onShowField={onShowField}
      markets={[{ key: plan.key, label: plan.label, channel: plan.channel, rows: plan.rows, review, selectedIds, lifecycleIds: plan.lifecycleIds, onTicksChange: plan.onTicksChange,
        results: plan.results ?? null, inSheet: !!onShowField }]} />
  </>
}

function ContentReviewBody({ review, selectedIds, selection, selecting = false, locationId, confirmed, locked, onSelectionChange, onLocationChange, onConfirmChange, plan, nexusWins = false, listing = null,
  onShowField }: ReviewBodyProps & { review: StudioPublishReview }) {
  const sparse = isSparse(review)
  // Every error: the reason a review lists no fields, or no overwrite check, when it names one.
  const blockers = blockingIssues(review.issues)
  // Option A (Owner 2026-10-19) — on a kept change-only review, the changes problems leave out; the others can go.
  const leftOut = sparse && review.id ? blockedChanges(review) : new Map()
  const keptWithProblems = sparse && !!review.id
  const line = publicationDestinationParts(review, true, listing)
  const { problems, notes } = publicationProblems(review.issues)
  // The window's one count: distinct problems (the same words on 20 SKUs are one), and the SKUs they are on.
  const problemTotal = problemCount(review.issues)
  // A row Publish leaves out (Not listed, deleted, a mode the channel cannot send) is not one it sends.
  const held = review.rows.filter(row => row.blocked || row.notListed || row.deleted).length
  const banner = problemBanner({ kept: keptWithProblems, namesNothing: review.issues.some(i => i.severity === 'error' && !i.field && !i.productId),
    leftOut: keptWithProblems ? leftOutCount(review) : { changes: 0, problems: 0 }, inTable: !!plan,
    statusChangesGo: !!plan?.rows.some(row => row.kind === 'lifecycle' && row.tick === 'on') })
  const visibility = shopifyVisibilityWords(review)
  return <div className={styles.body}>
    <p><strong>{line.lead}</strong>{line.rest && ` · ${line.rest}`}</p>
    {nexusWins && sparse && <DiffersSummary review={review} selectedIds={selectedIds} locked={locked} onSelectionChange={onSelectionChange} />}
    <MetricStrip metrics={[
      { label: 'Products', value: (review.rows.length - held).toLocaleString('en'), hint: held || review.excluded || review.skipped?.length
        ? [held ? `${held} not sent` : '', review.excluded ? `${review.excluded} excluded` : '', review.skipped?.length ? `${review.skipped.length} skipped` : ''].filter(Boolean).join(' · ') : undefined },
      { label: 'Problems', value: problemTotal.problems.toLocaleString('en'), hint: problemTotal.skus ? `on ${problemTotal.skus.toLocaleString('en')} ${problemTotal.skus === 1 ? 'SKU' : 'SKUs'}` : undefined },
      { label: 'Notes', value: notes.length.toLocaleString('en') },
    ]} />
    {visibility && <Banner tone="info" title={visibility.title}>{visibility.body}</Banner>}
    {review.locations && <Field label="Inventory location"><Select size="sm" disabled={locked} value={locationId} onChange={e => onLocationChange(e.target.value)}><option value="">Choose a location</option>{review.locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>}
    {/* Audit D4 — one short banner says what the problems hold back and what still goes (`problemBanner`); the table names
        each problem. The count is the Problems tile's: the banner does not say it again. */}
    {problems.length > 0 && <Banner tone="warning" title={banner.title}>{banner.body}</Banner>}
    {/* With the plan, the problems are rows of the one table; without it (the products list's rows) they keep their own. */}
    {problems.length > 0 && !plan && <DataGrid ariaLabel="Problems to fix before publishing" size="md" headerMenus={false} columns={PROBLEM_COLUMNS} rows={problems} rowKey={row => row.id} />}
    {/* Notes block nothing, but one may say the same product is live in another business: the section opens by itself
        (Owner audit 2026-10-19), and closes on a click. */}
    {notes.length > 0 && <Disclosure open summary={`${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`}>
      <ul className={styles.issues}>{notes.map(note => <li key={note}>{note}</li>)}</ul>
    </Disclosure>}
    {plan && <PlanPart plan={plan} review={review} selectedIds={selectedIds} locked={locked} onShowField={onShowField} />}
    {!plan && sparse && review.changes && <PublicationChanges changes={review.changes} selectedIds={selectedIds} onSelectionChange={onSelectionChange} disabled={!review.id || locked} leftOut={leftOut}
      channel={review.scope.channel} />}
    {/* An error above already says why no fields are listed: this banner is only for a review that names no error. */}
    {sparse && !review.changes && !blockers.length && <Banner tone="warning" title="Field review unavailable">The review did not list the fields to send. Check again.</Banner>}
    {/* One-click publish: the exact request is built by itself and sits in a closed fold (audit D4: never a payload in a banner). */}
    {sparse && (selection || selecting) && <Disclosure summary={exactRequestSummary(selection, selecting)}>
      {selection ? <div className={styles.body}>
        <p className={styles.muted}>Only the ticked changes are applied on {(() => { const l = publicationDestinationParts(review, !!listing, listing); return [l.lead, l.rest].filter(Boolean).join(' · ') })()}. Where a channel requires a complete collection, its other values are preserved in the request below.</p>
        <pre tabIndex={0} aria-label={`Exact request to ${channelLabel(review.scope.channel)} ${review.scope.marketplace}`} className={styles.payload}>{selection.payload.content}</pre>
      </div> : <p className={styles.muted}>Preparing the exact request…</p>}
    </Disclosure>}
    {!sparse && review.overwrite && <PublicationOverwrite overwrite={review.overwrite} confirmed={confirmed && !!review.id}
      onConfirm={onConfirmChange} disabled={!review.id || locked} />}
    {!sparse && !review.overwrite && !blockers.length && review.rows.some(row => row.existing) && <Banner tone="warning" title="Overwrite review unavailable">The review did not check what this overwrites on the existing listings. Check again.</Banner>}
    {!plan && <DataGrid ariaLabel="Products in this publication" size="md" headerMenus={false} columns={PRODUCT_COLUMNS} rows={review.rows} rowKey={row => row.productId} />}
  </div>
}
