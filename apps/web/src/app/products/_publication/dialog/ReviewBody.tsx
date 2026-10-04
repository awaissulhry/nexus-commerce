'use client'

import type { Ref } from 'react'
import { blockingIssues, type StudioPublishReview, type StudioPublishSelection } from '@nexus/shared/studio-publication'
import { Select } from '@/design-system/primitives'
import { Banner, Disclosure, Field, MetricStrip } from '@/design-system/components'
// The DS grid's DataGrid (AG Grid), as the Import dialog lists its rows (audit D4: one way to list rows in both dialogs).
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { channelLabel } from '@nexus/shared/channel-label'
import { PublicationOverwrite } from './PublicationOverwrite'
import { PublicationChanges } from './PublicationChanges'
import { isSparse } from './destinations'
import { publicationProblems, type PublicationProblemRow } from './model'
import styles from './publication.module.css'

/**
 * The review's destination as one line: account (or, when the account has no name, the channel), listing, market.
 * Empty parts are skipped, so the line never starts or ends with a lone " · " (a nameless account printed
 * "· Primary listing · IT").
 */
export function publicationDestinationParts(review: Pick<StudioPublishReview, 'accountLabel' | 'aliasLabel' | 'scope'>, withListing = true): { lead: string; rest: string } {
  const named = (value: string | null | undefined) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
  const lead = named(review.accountLabel) ?? channelLabel(review.scope.channel)
  const rest = [withListing ? named(review.aliasLabel) : null, named(review.scope.marketplace)].filter((part): part is string => part != null).join(' · ')
  return { lead, rest }
}

type ReviewRow = StudioPublishReview['rows'][number]
// Audit D4 — what to fix, by SKU, in one table; the channel's own words under it, muted.
const PROBLEM_COLUMNS: Column<PublicationProblemRow>[] = [
  { key: 'sku', label: 'SKU', width: 180, className: styles.skuCol, render: row => <span className={styles.sku} title={row.sku}>{row.sku}</span> },
  { key: 'fix', label: 'What to fix', width: 560, className: styles.textCol, render: row => <span className={styles.fix}>
    <span>{row.message}</span>{row.detail && <span className={styles.detail} title={row.detail}>{row.detail}</span>}</span> },
]
const PRODUCT_COLUMNS: Column<ReviewRow>[] = [
  { key: 'sku', label: 'SKU', width: 180, className: styles.skuCol, render: row => <span className={styles.sku} title={row.sku}>{row.sku}</span> },
  { key: 'title', label: 'Title', width: 380, className: styles.textCol, render: row => <span className={styles.clamp} title={row.title}>{row.title}</span> },
  { key: 'listing', label: 'Listing', width: 130, render: row => row.existing ? 'Existing listing' : 'New listing' },
]

export interface ReviewBodyProps {
  review: StudioPublishReview
  selectedIds: string[]
  /** The exact request for the ticked fields, once prepared (Amazon and eBay). */
  selection: StudioPublishSelection | null
  locationId: string
  confirmed: boolean
  /** Nothing can change: a publish is under way or done, or the dialog is busy. */
  locked: boolean
  onSelectionChange(ids: string[]): void
  onLocationChange(id: string): void
  onConfirmChange(confirmed: boolean): void
  /** Focus target once the exact request is ready. */
  requestRef?: Ref<HTMLDivElement>
}

/** One destination's review — the same body the single-destination dialog has always shown. */
export function ReviewBody({ review, selectedIds, selection, locationId, confirmed, locked, onSelectionChange, onLocationChange, onConfirmChange, requestRef }: ReviewBodyProps) {
  const sparse = isSparse(review)
  const blockers = blockingIssues(review.issues, review.photosOnly ? selectedIds : undefined)
  const line = publicationDestinationParts(review)
  const { problems, notes } = publicationProblems(review.issues)
  return <div className={styles.body}>
    <p><strong>{line.lead}</strong>{line.rest && ` · ${line.rest}`}</p>
    <MetricStrip metrics={[
      { label: 'Products', value: review.rows.length.toLocaleString('en'), hint: review.excluded || review.skipped?.length
        ? [review.excluded ? `${review.excluded} excluded` : '', review.skipped?.length ? `${review.skipped.length} skipped` : ''].filter(Boolean).join(' · ') : undefined },
      { label: 'Problems', value: problems.length.toLocaleString('en') },
      { label: 'Notes', value: notes.length.toLocaleString('en') },
    ]} />
    {review.visibility && <Banner tone="info" title={`Shopify visibility: ${review.visibility}`}>The saved status and sales-channel selections will be applied.</Banner>}
    {review.locations && <Field label="Inventory location"><Select size="sm" disabled={locked} value={locationId} onChange={e => onLocationChange(e.target.value)}><option value="">Choose a location</option>{review.locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>}
    {/* Audit D4 — one short banner says what the table is; the table names each problem (SKU · what to fix). The count is
        the Problems tile's: the banner does not say it again. */}
    {problems.length > 0 && <Banner tone="warning" title={review.photosOnly ? 'Other fields have problems — only photos can be sent now' : 'Fix these before publishing'}>
      {review.photosOnly ? 'Choose only photos to send now, or fix the problems below first.' : 'Each row says what to fix. Fix them, then check again.'}
    </Banner>}
    {problems.length > 0 && <DataGrid ariaLabel="Problems to fix before publishing" size="sm" keyboardScroll columns={PROBLEM_COLUMNS} rows={problems} rowKey={row => row.id} />}
    {/* Notes inform and block nothing: one closed section, as in the Import dialog. */}
    {notes.length > 0 && <Disclosure summary={`${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`}>
      <ul className={styles.issues}>{notes.map(note => <li key={note}>{note}</li>)}</ul>
    </Disclosure>}
    {sparse && review.changes && <PublicationChanges changes={review.changes} selectedIds={selectedIds} onSelectionChange={onSelectionChange} disabled={!review.id || locked} photosOnly={review.photosOnly} />}
    {/* An error above already says why no fields are listed: this banner is only for a review that names no error. */}
    {sparse && !review.changes && !blockers.length && <Banner tone="warning" title="Field review unavailable">The review did not list the fields to send. Check again.</Banner>}
    {/* The request itself sits below the banner, never inside it (audit D4: a banner holds a sentence, not a payload). */}
    {selection && <div ref={requestRef} tabIndex={-1} role="region" aria-label={`Selected publication request for ${channelLabel(review.scope.channel)} ${review.scope.marketplace}`} className={styles.body}>
      <Banner tone="info" title="Selected request ready">
        {selection.fieldCount} {selection.fieldCount === 1 ? 'change' : 'changes'} affecting {selection.products.length} {selection.products.length === 1 ? 'product' : 'products'} on {(() => { const l = publicationDestinationParts(review, false); return [l.lead, l.rest].filter(Boolean).join(' · ') })()}.
        Only the selected changes will be applied. Where a channel requires a complete collection, its other values are preserved in the request below.
      </Banner>
      <Disclosure summary="Exact request to the channel"><pre tabIndex={0} aria-label="Exact channel request" className={styles.payload}>{selection.payload.content}</pre></Disclosure>
    </div>}
    {!sparse && review.overwrite && <PublicationOverwrite overwrite={review.overwrite} confirmed={confirmed && !!review.id}
      onConfirm={onConfirmChange} disabled={!review.id || locked} />}
    {!sparse && !review.overwrite && !blockers.length && review.rows.some(row => row.existing) && <Banner tone="warning" title="Overwrite review unavailable">The review did not check what this overwrites on the existing listings. Check again.</Banner>}
    <DataGrid ariaLabel="Products in this publication" size="sm" keyboardScroll columns={PRODUCT_COLUMNS} rows={review.rows} rowKey={row => row.productId} />
  </div>
}
