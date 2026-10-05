'use client'

/**
 * Approvals grid — the toolbar (PLAN §2, §5), the products page's pattern (ProductsNextClient.tsx): `GridToolbar` with
 * the search, Show (Open · Done · Everything — the server's `show`), Group (on the client), Views and Customise. When
 * rows are ticked it swaps to "Selected N" + "Approve N · <kind>" + "Reject N" + Clear.
 *
 * Bulk approve is one kind at a time (Decision 1 = A). The button stays on screen when it cannot run and says why —
 * held (focusable, the reason as its tooltip and description), never a silent `disabled` (U13).
 */
import { memo, useMemo, type ReactNode } from 'react'
import { Check, Search, SlidersHorizontal, X } from 'lucide-react'
import type { QueueRow, QueueShow } from '@nexus/shared/approval-queue'

import { Button, Input, Tooltip } from '@/design-system/primitives'
import { Listbox, type ListboxOption } from '@/design-system/components'
import { GridSearchSlot, GridSelectionActions, GridToolbar, GridViewsMenu, type GridStateApi } from '@/design-system/grid'
import { GROUP_LABEL, SHOW_LABEL, bulkApproveVerdict, bulkRejectVerdict, isQueueGroup, isQueueShow, type BulkVerdict, type QueueGroup } from './queueWords'

/** What a saved view of this page holds besides the grid's own state. */
export interface QueuePageState {
  show: QueueShow
  group: QueueGroup
}

export interface QueueToolbarProps {
  phone: boolean
  /** "Showing 100 of 130 open requests". */
  count: string
  search: string
  onSearch(value: string): void
  show: QueueShow
  onShow(value: QueueShow): void
  group: QueueGroup
  onGroup(value: QueueGroup): void
  /** The ticked rows, as last read. */
  selected: readonly QueueRow[]
  onClear(): void
  /** Opens the confirm for a bulk decision (the page owns it). */
  onBulk(decision: 'approve' | 'reject'): void
  views: GridStateApi<QueuePageState>
  onCustomise(): void
}

const SHOW_OPTIONS: ListboxOption[] = (['open', 'done', 'all'] as const).map((value) => ({ value, label: SHOW_LABEL[value] }))
const GROUP_OPTIONS: ListboxOption[] = (['none', 'kind', 'product', 'asker'] as const).map((value) => ({ value, label: GROUP_LABEL[value] }))

/** A bulk verb: enabled, or held with its reason (focusable, explained, does nothing). */
function BulkButton({ verdict, variant, icon, onRun }: { verdict: BulkVerdict; variant: 'primary' | 'danger-outline'; icon: ReactNode; onRun(): void }) {
  if (verdict.enabled) {
    return <Button size="sm" variant={variant} onClick={onRun}>{icon}{verdict.label}</Button>
  }
  return (
    <Tooltip label={verdict.reason} portal>
      <Button size="sm" variant={variant} aria-disabled aria-description={verdict.reason ?? undefined}>{icon}{verdict.label}</Button>
    </Tooltip>
  )
}

export const QueueToolbar = memo(function QueueToolbar(p: QueueToolbarProps) {
  const approve = useMemo(() => bulkApproveVerdict(p.selected), [p.selected])
  const reject = useMemo(() => bulkRejectVerdict(p.selected), [p.selected])
  const ticked = p.selected.length

  if (ticked > 0) {
    return (
      <GridToolbar count={<>Selected <b>{ticked}</b></>}>
        <GridSelectionActions>
          <BulkButton verdict={approve} variant="primary" icon={<Check size={14} aria-hidden />} onRun={() => p.onBulk('approve')} />
          <BulkButton verdict={reject} variant="danger-outline" icon={<X size={14} aria-hidden />} onRun={() => p.onBulk('reject')} />
          <Button size="sm" variant="link" onClick={p.onClear}>Clear</Button>
        </GridSelectionActions>
      </GridToolbar>
    )
  }

  return (
    <GridToolbar
      count={p.count}
      right={
        <span className="aqg-toolright">
          <span className="aqg-ctl">
            <span className="aqg-ctl-lbl" aria-hidden>Show</span>
            <Listbox size="sm" ariaLabel="Show" options={SHOW_OPTIONS} value={p.show} onChange={(v) => isQueueShow(v) && p.onShow(v)} />
          </span>
          <span className="aqg-ctl">
            <span className="aqg-ctl-lbl" aria-hidden>Group</span>
            <Listbox size="sm" ariaLabel="Group" options={GROUP_OPTIONS} value={p.group} onChange={(v) => isQueueGroup(v) && p.onGroup(v)} />
          </span>
          {p.phone ? null : (
            <>
              <GridViewsMenu views={p.views} />
              <Button size="sm" onClick={p.onCustomise}><SlidersHorizontal size={14} aria-hidden /> Customise</Button>
            </>
          )}
        </span>
      }
    >
      <GridSearchSlot>
        <Input
          size="sm"
          type="search"
          aria-label="Search requests"
          placeholder="Search product, SKU, kind…"
          leadingIcon={<Search size={14} aria-hidden />}
          value={p.search}
          onChange={(e) => p.onSearch(e.target.value)}
        />
      </GridSearchSlot>
    </GridToolbar>
  )
})
