'use client'

/**
 * Sheet publish parity T1 — one reviewed row of the many-product Publish window, opened: the saved review of that
 * product × market with its ticks, the same body a single publish shows (`ReviewBody`). Changing a tick saves it
 * through the selection route (a short pause first, so several clicks save once); the batch then re-reads its counts.
 * Nothing is sent from here — only the window's counted button sends.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PublicationBatchChild, StudioPublishSelection, StudioPublishStoredReview } from '@nexus/shared/studio-publication'
import { Button, Skeleton } from '@/design-system/primitives'
import { Banner } from '@/design-system/components'
import Link from '@/lib/workspaces/Link'
import { publicationRequest as request } from './request'
import { ReviewBody } from './ReviewBody'
import { manyReviewPaths, manyRowEditable, manyStudioHref, tickKey } from './many'
import styles from './publication.module.css'

const SAVE_PAUSE_MS = 500
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface ManyRowReviewProps {
  child: PublicationBatchChild
  /** The batch is sending (or the window is busy): the ticks cannot change. */
  sending: boolean
  /** Ticks were saved: the batch should re-read its counts. */
  onTicksSaved(): void
}

type Save = { state: 'idle' } | { state: 'saving' } | { state: 'saved' } | { state: 'failed'; error: string }

export function ManyRowReview({ child, sending, onTicksSaved }: ManyRowReviewProps) {
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

  return <div className={styles.body}>
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
