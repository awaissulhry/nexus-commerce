'use client'

/**
 * Sheet publish parity T1 — one reviewed row of the many-product Publish window, opened: the saved review of that
 * product × market with its ticks, the same body a single publish shows (`ReviewBody`). Changing a tick saves it
 * through the selection route (a short pause first, so several clicks save once); the batch then re-reads its counts.
 * Nothing is sent from here — only the window's counted button sends.
 *
 * Build shape v2 (P11) — `ManyStatusDetails`: a Status row opened (one product × market): every listing there with what
 * happens to it or why it cannot (the engine's plan), and once sent, each listing's result.
 *
 * One-click O5 — a row the batch did not review (the family is not listed in that market, or it could not be reviewed)
 * has no saved review: opened, it says why (`manyRowSkipReason`), with the link to the product's sheet.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { StudioPublishSelection, StudioPublishStoredReview } from '@nexus/shared/studio-publication'
import { LISTING_ACTION_LABEL, type ListingActionRowPlan } from '@nexus/shared/listing-actions'
import { createsSentence, type PublishPlanBatchChild } from '@nexus/shared/publish-plan'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { Banner } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { PublishStatusPill } from '@/design-system/grid'
import type { Tone } from '@/design-system/primitives/tone'
import Link from '@/lib/workspaces/Link'
import { publicationRequest as request } from './request'
import { ReviewBody } from './ReviewBody'
import { lifecycleRowMeta } from './actionPlan'
import { manyReviewPaths, manyRowEditable, manyRowSkipReason, manyStudioHref, tickKey, type ManyStatusListing, type ManyStatusResult, type ManyStatusRow } from './many'
import styles from './publication.module.css'

const SAVE_PAUSE_MS = 500
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface ManyRowReviewProps {
  child: PublishPlanBatchChild
  /** The batch is sending (or the window is busy): the ticks cannot change. */
  sending: boolean
  /** Ticks were saved: the batch should re-read its counts. */
  onTicksSaved(): void
}

type Save = { state: 'idle' } | { state: 'saving' } | { state: 'saved' } | { state: 'failed'; error: string }

export function ManyRowReview(props: ManyRowReviewProps) {
  // A row with no saved review (not listed there, or not reviewed): why, and the product's sheet.
  const skipped = manyRowSkipReason(props.child)
  if (skipped) {
    const href = manyStudioHref(props.child)
    return <div className={styles.body}>
      <p>{skipped}</p>
      {href && <div className={styles.actions}><Button asChild size="sm" variant="ghost"><Link href={href} target="_blank" rel="noopener">Open this product’s sheet (new tab)</Link></Button></div>}
    </div>
  }
  return <ReviewedRow {...props} />
}

function ReviewedRow({ child, sending, onTicksSaved }: ManyRowReviewProps) {
  const paths = manyReviewPaths(child)
  const href = manyStudioHref(child)
  const [stored, setStored] = useState<StudioPublishStoredReview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selection, setSelection] = useState<StudioPublishSelection | null>(null)
  const [save, setSave] = useState<Save>({ state: 'idle' })
  const savedKey = useRef<string>('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!paths) return
    setLoadError(null)
    try {
      const data = await request<StudioPublishStoredReview>(paths.review, 'GET', undefined, signal)
      if (signal?.aborted) return
      setStored(data)
      const ticks = data.selectedIds ?? []
      setSelectedIds(ticks)
      savedKey.current = tickKey(ticks)
    } catch (e) { if (!signal?.aborted) setLoadError(message(e)) }
  }, [paths?.review])
  // One read per opening; a closed row (or React's development double run) cancels a read still under way.
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort() }, [load])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const persist = useCallback(async (ids: string[]) => {
    if (!paths) return
    const key = tickKey(ids)
    if (key === savedKey.current) { setSave({ state: 'idle' }); return }
    setSave({ state: 'saving' })
    try {
      const data = await request<StudioPublishSelection>(paths.selection, 'POST', { selectedIds: ids })
      savedKey.current = tickKey(data.selectedIds)
      setSelection(data)
      setSave({ state: 'saved' })
      onTicksSaved()
    } catch (e) { setSave({ state: 'failed', error: message(e) }) }
  }, [paths?.selection, onTicksSaved])

  const choose = (ids: string[]) => {
    setSelectedIds(ids)
    setSelection(null)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void persist(ids), SAVE_PAUSE_MS)
  }

  const editable = manyRowEditable(stored, sending)
  const studioLink = href && <Button asChild size="sm" variant="ghost"><Link href={href} target="_blank" rel="noopener">Open this product’s sheet (new tab)</Link></Button>

  if (!paths) return <div className={styles.body}><p className={styles.muted}>This row has no product to review.</p></div>
  if (loadError) return <div className={styles.body}>
    <Banner tone="danger" title="This review could not be loaded" action={<Button size="sm" onClick={() => void load()}>Try again</Button>}>{loadError}</Banner>
    {!!child.problems?.messages.length && <ul className={styles.issues}>{child.problems.messages.map(m => <li key={m}>{m}</li>)}</ul>}
    {studioLink && <div className={styles.actions}>{studioLink}</div>}
  </div>
  if (!stored) return <div className={styles.body} aria-busy="true"><Skeleton height={64} /><span className="nds-vh" role="status">Loading this review…</span></div>
  // New listings (ND4 B): what this row creates and how each listing starts ("Creates GALE-M (inactive).").
  const creates = createsSentence(child.creates ?? [])

  return <div className={styles.body}>
    {creates && <p>{creates}</p>}
    <ReviewBody review={stored.review} selectedIds={selectedIds} selection={selection} locationId="" confirmed={false}
      locked={!editable || save.state === 'saving'} onSelectionChange={choose} onLocationChange={() => {}} onConfirmChange={() => {}} />
    <p className={styles.muted} role="status" aria-live="polite">
      {save.state === 'saving' ? 'Saving the ticks…'
        : save.state === 'saved' ? 'Ticks saved. The counts above are updated.'
        : !editable && stored.status === 'PREVIEW' && !sending ? 'This review expired. Check again to change its ticks.'
        : ''}
    </p>
    {save.state === 'failed' && <Banner tone="danger" title="The ticks were not saved" action={<Button size="sm" onClick={() => void persist(selectedIds)}>Try again</Button>}>{save.error}</Banner>}
    {studioLink && <div className={styles.actions}>{studioLink}</div>}
  </div>
}


/** What happens to one listing, before the send. */
const PLAN_WORD: Readonly<Record<ListingActionRowPlan, { label: string; tone: Tone }>> = {
  send: { label: 'Changes', tone: 'info' }, skip: { label: 'No change', tone: 'neutral' }, refused: { label: 'Cannot', tone: 'warning' },
}

export interface ManyStatusDetailsProps {
  row: ManyStatusRow
  /** The batch was sent: show each listing's result instead of the plan. */
  sent: boolean
}

/** A Status row opened: its listings with what happens to each (or, once sent, each one's result). Nothing is sent here. */
export function ManyStatusDetails({ row, sent }: ManyStatusDetailsProps) {
  const href = row.productId && row.channel && row.marketplace ? manyStudioHref({ productId: row.productId, channel: row.channel, marketplace: row.marketplace,
    accountId: row.children[0]?.accountId ?? null }) : null
  const studioLink = href && <Button asChild size="sm" variant="ghost"><Link href={href} target="_blank" rel="noopener">Open this product’s sheet (new tab)</Link></Button>
  const label = `Listings of ${row.familySku ?? 'this product'}`

  if (sent && row.results.length) {
    const columns: Array<Column<ManyStatusResult>> = [
      { key: 'sku', label: 'SKU', width: 180, className: styles.skuCol, render: r => <span className={styles.sku}>{r.sku}</span> },
      { key: 'result', label: 'Result', width: 120, render: r => { const meta = lifecycleRowMeta(r.outcome); return <span title={meta.hint}><PublishStatusPill meta={meta} /></span> } },
      { key: 'message', label: 'What happened', width: 270, render: r => <span className={styles.sentCell}>{[r.action ? LISTING_ACTION_LABEL[r.action] : null, r.message || null].filter(Boolean).join(': ')}</span> },
    ]
    return <div className={styles.body}>
      <DataGrid ariaLabel={label} size="sm" columns={columns} rows={row.results} rowKey={r => r.key} />
      {studioLink && <div className={styles.actions}>{studioLink}</div>}
    </div>
  }
  if (!row.listings.length) {
    return <div className={styles.body}>
      <p className={styles.muted}>{row.reason ?? (sent ? 'No listing result yet.' : 'No listing here to change.')}</p>
      {studioLink && <div className={styles.actions}>{studioLink}</div>}
    </div>
  }
  const columns: Array<Column<ManyStatusListing>> = [
    // Widths fit the window at desktop; a phone scrolls the table sideways, SKUs first (as the Publish window's table).
    { key: 'sku', label: 'SKU', width: 180, className: styles.skuCol, render: l => <span className={styles.sku}>{l.sku}</span> },
    { key: 'plan', label: 'Change', width: 120, render: l => <Pill tone={PLAN_WORD[l.plan].tone} dot>{PLAN_WORD[l.plan].label}</Pill> },
    { key: 'sentence', label: 'What happens', width: 270, render: l => <span className={styles.sentCell}>{l.sentence}</span> },
  ]
  return <div className={styles.body}>
    <DataGrid ariaLabel={label} size="sm" columns={columns} rows={row.listings} rowKey={l => l.key} />
    {studioLink && <div className={styles.actions}>{studioLink}</div>}
  </div>
}
