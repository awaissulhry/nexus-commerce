'use client'

/**
 * Reviews › Etsy and Shopify (build spec §3.5, rulings 3 and 7; PR I) — the review list both pages share: the Inbox's own
 * rows for the channel (a row opens the Inbox's review pop-up, where the reply is written), photos in a Lightbox, a
 * search, and ticks with select-all and a bulk bar: Mark as responded (recorded in Nexus only; reviews already marked
 * are skipped and the button counts the rest — held when every ticked review is marked; a closed-window review can be
 * marked, a reply may have gone out before it closed), Assign, Export (the ticked rows as a CSV file). No bulk reply:
 * each reply is written one at a time.
 */
import { memo, useCallback, useMemo, useState, type ComponentProps } from 'react'
import { Download, MessageSquareReply, Search, UserPlus } from 'lucide-react'
import { Banner, Field, Listbox, Modal, useToast } from '@/design-system/components'
import { Lightbox, type LightboxItem } from '@/design-system/patterns'
import {
  GridCard, GridNoRowsOverlay, GridSearchSlot, GridSelectionActions, GridToolbar, NexusGrid, SelectionLabel, gridGeometry,
  type ColDef, type GridApi,
} from '@/design-system/grid'
import { Button, Input, Skeleton } from '@/design-system/primitives'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { useRouter } from '@/lib/workspaces/navigation'
import { reviewsSend } from '../_lib/reviewsFetch'
import { inboxHref } from '../_lib/reviewsLinks'
import { SectionError } from '../_overview/SectionError'
import { bulkActionHeld, bulkApplyHeld, bulkApplyLabel, bulkBody, bulkReach, bulkResultWords, bulkSkipWords, ownerChoices, type BulkRow } from '../inbox/inboxBulk'
import { filterFeedback, plural } from './channelModel'
import { csvFileName, reviewsCsv, type EtsyRow, type ReviewList, type ShopChannel, type ShopifyRow } from './shopChannelModel'
import s from './channel.module.css'

export type ShopRow = EtsyRow | ShopifyRow

/** What a cell can ask of the list: open the review's photos. */
export interface ShopListContext {
  openPhotos: (row: ShopRow, index: number) => void
}

export interface ShopReviewListProps<R extends ShopRow> {
  channel: ShopChannel
  list: ReviewList<R> | null
  error: string | null
  busy: boolean
  onRetry: () => void
  columns: ColDef<R>[]
  canManage: boolean
  me: string | null
  /** The empty list's words. */
  empty: { title: string; message: string }
  /** The photos of a row, for the Lightbox. */
  photosOf: (row: R) => Array<{ url: string }>
  /** More for the cells (the page's permission, the app's state); `openPhotos` is added. */
  cellContext?: Record<string, unknown>
}

type ShopBulk = 'responded' | 'assign'
const BULK_LABEL: Record<ShopBulk, string> = { responded: 'Mark as responded', assign: 'Assign' }

export function ShopReviewList<R extends ShopRow>({ channel, list, error, busy, onRetry, columns, canManage, me, empty, photosOf, cellContext }: ShopReviewListProps<R>) {
  const router = useRouter()
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const rows = useMemo(() => list?.rows ?? [], [list])
  const rowData = useMemo(() => filterFeedback(rows, 'all', search) as R[], [rows, search])
  const columnDefs = useMemo(() => columns, [columns])
  const [api, setApi] = useState<GridApi<R> | null>(null)
  const [ticked, setTicked] = useState<R[]>([])
  const [bulk, setBulk] = useState<ShopBulk | null>(null)
  const [photos, setPhotos] = useState<{ row: R; index: number } | null>(null)
  const name = channel === 'ETSY' ? 'Etsy' : 'Shopify'

  const context = useMemo<ShopListContext>(() => ({ ...cellContext, openPhotos: (row, index) => setPhotos({ row: row as R, index }) }), [cellContext])
  const rowSelection = useMemo<NonNullable<ComponentProps<typeof NexusGrid<R>>['rowSelection']>>(() => ({
    mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false,
  }), [])
  const selectionColumnDef = useMemo(() => ({ width: gridGeometry.selectColW, maxWidth: gridGeometry.selectColW, resizable: false }), [])
  const getRowId = useCallback((p: { data: R }) => p.data.id, [])
  const onGridReady = useCallback((e: { api: GridApi<R> }) => setApi(e.api), [])
  const onSelectionChanged = useCallback((e: { api: GridApi<R> }) => setTicked(e.api.getSelectedRows()), [])
  const clear = useCallback(() => { if (api && !api.isDestroyed()) api.deselectAll() }, [api])
  const onRowClicked = useCallback((e: { data?: R; event?: Event | null }) => {
    const target = e.event?.target
    if (target instanceof Element && target.closest('a, button, .ag-selection-checkbox, .ag-checkbox, [col-id="ag-Grid-SelectionColumn"]')) return
    if (e.data) router.push(inboxHref({ channel, review: e.data.id }))
  }, [router, channel])
  const noRowsParams = useMemo(() => (search.trim()
    ? { title: 'No review matches', message: 'Clear the search to see every review.', action: { label: 'Clear the search', onClick: () => setSearch('') } }
    : empty), [search, empty])

  const exportTicked = () => {
    const blob = new Blob(['﻿', reviewsCsv(channel, ticked)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = csvFileName(channel)
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast(`${plural(ticked.length, 'review', 'reviews')} exported as a CSV file.`, 'success')
  }

  const lightboxItems = useMemo<LightboxItem[]>(() => {
    if (!photos) return []
    const list = photosOf(photos.row)
    return list.map((p, i) => ({ url: p.url, alt: `Photo ${i + 1} of ${list.length}${photos.row.buyer ? ` from ${photos.row.buyer}` : ''}` }))
  }, [photos, photosOf])

  const truncated = list && list.total > rows.length

  return (
    <>
      {error ? (
        <SectionError error={error} onRetry={onRetry} busy={busy} />
      ) : (
        <GridCard
          toolbar={(
            <GridToolbar
              count={ticked.length > 0 ? <><b>{ticked.length.toLocaleString('en')}</b> selected</> : list ? <><b>{rowData.length.toLocaleString('en')}</b> {rowData.length === 1 ? 'review' : 'reviews'}</> : '—'}
              right={<Button asChild size="sm"><Link href={inboxHref({ channel })}>Open in the Inbox</Link></Button>}
            >
              {ticked.length > 0 ? (
                <GridSelectionActions>
                  <Button size="sm" aria-label={BULK_LABEL.responded} onClick={() => setBulk('responded')} heldReason={bulkApplyHeld('status', 'RESPONDED', { canManage, rows: ticked })}>
                    <MessageSquareReply size={13} aria-hidden /> <SelectionLabel>{BULK_LABEL.responded}</SelectionLabel>
                  </Button>
                  <Button size="sm" aria-label={BULK_LABEL.assign} onClick={() => setBulk('assign')} heldReason={bulkActionHeld('assign', { canManage, rows: ticked })}>
                    <UserPlus size={13} aria-hidden /> <SelectionLabel>{BULK_LABEL.assign}</SelectionLabel>
                  </Button>
                  <Button size="sm" aria-label="Export" onClick={exportTicked}>
                    <Download size={13} aria-hidden /> <SelectionLabel>Export</SelectionLabel>
                  </Button>
                  <Button size="sm" variant="link" onClick={clear}>Clear</Button>
                </GridSelectionActions>
              ) : (
                <GridSearchSlot>
                  <Input
                    leadingIcon={<Search size={13} aria-hidden />}
                    placeholder="Search review, buyer, item…"
                    aria-label={`Search ${name} reviews`}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </GridSearchSlot>
              )}
            </GridToolbar>
          )}
          footer={truncated ? (
            <p className={s.gridNote}>
              Showing the newest {plural(rows.length, 'review', 'reviews')} of {list!.total.toLocaleString('en')}. <Link href={inboxHref({ channel })} className={s.cellLink}>Open them all in the Inbox</Link>
            </p>
          ) : undefined}
        >
          {!list ? (
            <div className={s.pad}><Skeleton height={200} /></div>
          ) : (
            <NexusGrid<R>
              domLayout="autoHeight"
              rows="media"
              rowData={rowData}
              columnDefs={columnDefs}
              getRowId={getRowId}
              context={context}
              rowSelection={rowSelection}
              selectionColumnDef={selectionColumnDef}
              onGridReady={onGridReady}
              onSelectionChanged={onSelectionChanged}
              onRowClicked={onRowClicked}
              rowClass={s.clickRow}
              noRowsOverlayComponent={GridNoRowsOverlay}
              noRowsOverlayComponentParams={noRowsParams}
            />
          )}
        </GridCard>
      )}

      {bulk && (
        <BulkDialog
          action={bulk}
          rows={ticked}
          canManage={canManage}
          owners={list?.owners ?? []}
          me={me}
          name={name}
          onClose={() => setBulk(null)}
          onDone={(words, tone) => { setBulk(null); clear(); toast(words, tone) }}
        />
      )}

      {photos && lightboxItems.length > 0 && (
        <Lightbox
          open
          onClose={() => setPhotos(null)}
          items={lightboxItems}
          index={photos.index}
          onIndex={(index) => setPhotos((p) => (p ? { ...p, index } : p))}
          meta={[photos.row.rating != null ? `${photos.row.rating} of 5 stars` : null, photos.row.buyer].filter(Boolean).join(' · ')}
          caption={photos.row.snippet || undefined}
        />
      )}
    </>
  )
}

interface BulkDialogProps {
  action: ShopBulk
  rows: readonly BulkRow[]
  canManage: boolean
  owners: readonly string[]
  me: string | null
  name: string
  onClose: () => void
  onDone: (words: string, tone: 'success' | 'warning') => void
}

/** Mark as responded (no value) or Assign (an owner): how many it changes, then apply through the Inbox's bulk call. */
const BulkDialog = memo(function BulkDialog({ action, rows, canManage, owners, me, name, onClose, onDone }: BulkDialogProps) {
  const inboxAction = action === 'assign' ? 'assign' : 'status'
  const [value, setValue] = useState(action === 'assign' ? me ?? '' : 'RESPONDED')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reach = bulkReach(inboxAction, action === 'assign' ? value || null : value, rows)
  const held = busy ? 'Applying… this takes a few seconds.' : bulkApplyHeld(inboxAction, value, { canManage, rows })
  const skipped = bulkSkipWords(reach.skipped)

  const apply = async () => {
    setBusy(true)
    setError(null)
    const res = await reviewsSend<{ changed: number; skipped: { id: string; reason: string }[] }>(
      'POST', '/reviews/inbox/bulk', bulkBody(rows.map((r) => r.id), inboxAction, value), { idempotent: true, what: 'bulk change' },
    )
    setBusy(false)
    if (!res.data) {
      setError(res.error)
      return
    }
    emitInvalidation({ type: action === 'responded' ? 'review.replied' : 'review.updated', meta: { bulk: inboxAction, changed: res.data.changed } })
    onDone(bulkResultWords(inboxAction, value || null, res.data), res.data.changed > 0 ? 'success' : 'warning')
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`${BULK_LABEL[action]} · ${rows.length.toLocaleString('en')} ticked`}
      footer={(
        <div className={s.dialogFoot}>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={() => void apply()} heldReason={held}>
            {action === 'responded' ? `Mark ${plural(reach.apply.length, 'review', 'reviews')} as responded` : bulkApplyLabel('assign', value || null, reach.apply.length)}
          </Button>
        </div>
      )}
    >
      <div className={s.stackGap}>
        {action === 'assign' && (
          <Field label="Owner" hint="The person who answers these reviews. Nobody takes them off their owner.">
            <Listbox size="sm" ariaLabel="Owner" options={ownerChoices(owners, me)} value={value} onChange={setValue} searchable width="100%" />
          </Field>
        )}
        {action === 'responded' && (
          <p className={s.note}>
            Records in Nexus that these reviews were answered on {name === 'Etsy' ? 'Etsy.com' : 'the review app'}. Nothing is sent: {name} does not
            tell Nexus about replies, so Nexus knows only what you mark.
          </p>
        )}
        {skipped && <p className={s.note}>{skipped}</p>}
        {error && <Banner tone="danger" title={error} />}
      </div>
    </Modal>
  )
})
