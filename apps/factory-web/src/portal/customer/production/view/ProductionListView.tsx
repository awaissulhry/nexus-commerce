'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { Lock, MoreHorizontal, PackageSearch, WifiOff } from 'lucide-react'
import { Banner, EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { HealthPill } from '../../../../lib/production/view/HealthPill'
import { StageStrip } from '../../../../lib/production/view/StageStrip'
import { WaitingOnPill } from '../../../../lib/production/view/WaitingOnPill'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListGroups } from '../../../../list-frame/groups/model'
import type { ListKey } from '../../../../list-frame/model'
import type { BrandUrgencyCode, ProductionChip, ProductionList, ProductionRow } from '../api'
import { groupOf, groupsOf, healthInputOf, markActionOf, plainStageOf, rowHref, rowName, rowRef, stylesText, urgencyCell, urgencyText, waitingInputOf, type Notice } from '../model'
import { useProductionPageWords } from '../words'
import { UrgentOrderDialog, type UrgentOrderDialogActions, type UrgentOrderDialogModel } from './UrgentOrderDialog'
import '../production.css'

/**
 * F-PR-11 — Portal › Production › My production (production plan §5; 06-tree B.1; 09-design (d); 17-web-r2 §1.4): every order
 * of the customer in production, in ITS order — Urgent in its own order, then Regular by the day it sent the order, oldest first
 * (the API's order, kept) — in the shared list frame: a table on a desktop, cards on a phone. Per row: its urgency (Urgent 1, 2 …
 * / Urgent – asked / Regular / Set to Regular by us with our reason and the lock), the order (their PO first, then "Your order 12";
 * never the office's series), the day sent, the styles and pieces, the stage strip with the count and the next milestone of its
 * level, the expected date (the moved mark) with its health and the reason code, who acts next (You / Us) with one next step, and
 * the ⋯ (Open, Mark urgent / Mark regular: at once inside the quota and before Cutting, held with the words otherwise).
 * "2 of 3 urgent used" above the chips (with counts); the search; Urgent / Regular as the frame's groups. Urgency off for this
 * customer: no urgency column, group, chip, words or action is drawn (its marks are kept, not used). No money for any role.
 */

export interface ProductionListModel {
  state: 'loading' | 'error' | 'ready'
  read: ProductionList | null
  /** The chip asked in the address (null: the API's default, All). */
  chip: ProductionChip | null
  q: string
  prefix: string
  /** Live: the list changed since it was read ("N updates · Show"; rows never move under the cursor). */
  updates: number
  /** No connection: what was loaded and when. */
  offlineSince: string | null
  /** The person holds portal.production.urgency (else no mark is drawn: a role that reads sees no button). */
  mayMark: boolean
  /** An office preview of the portal: every mark is held. */
  preview: boolean
  /** The orders whose mark is being saved. */
  busy: readonly string[]
  /** A mark done (with Undo), an Undo done, a refusal in words. */
  notice: Notice | null
  /** Why Undo waits (saving, offline), else null. */
  undoHeld?: string | null
  /** The export file could not be made (said with Try again). */
  exportFailed?: boolean
  /** The groups folded shut. */
  collapsed: readonly string[]
  dialog: UrgentOrderDialogModel | null
  /** The clock the waits count from (the read's), so a list does not jump. */
  now: number
  /** Design cases: the keys panel open. */
  keysOpen?: boolean
}

export interface ProductionListActions {
  onChip?: (chip: ProductionChip) => void
  onSearch?: (q: string) => void
  onClear?: () => void
  onOpen?: (row: ProductionRow) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onMark?: (row: ProductionRow, urgency: BrandUrgencyCode) => void
  onUndo?: (batchId: string) => void
  onDismissNotice?: () => void
  onRetryExport?: () => void
  onToggleGroup?: (key: string) => void
  onHelp?: () => void
  dialog?: UrgentOrderDialogActions
}

export function ProductionListView({ model, actions }: { model: ProductionListModel; actions?: ProductionListActions }) {
  const words = useProductionPageWords()
  const { t, locale, day, time } = words
  const ds = useDsWords()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const read = model.read
  const urgencyOn = read?.urgencyOn ?? false
  const chip: ProductionChip = model.chip ?? read?.chip ?? 'ALL'
  const rows = model.state === 'loading' && !read ? null : (read?.items ?? [])

  const columns = useMemo((): ColDef<ProductionRow>[] => {
    const now = () => latest.current.model.now
    const facts = (row: ProductionRow) => {
      const current = latest.current.model
      return { urgencyOn: current.read?.urgencyOn ?? false, mayMark: current.mayMark, preview: current.preview, offline: current.offlineSince !== null, busy: current.busy.includes(row.id), use: current.read?.urgentUse ?? null }
    }
    const UrgencyCell = ({ data }: ICellRendererParams<ProductionRow>) => {
      if (!data?.urgency) return <span className="fw-pprod-sub">—</span>
      const cell = urgencyCell(data.urgency, locale)
      return (
        <span className="fw-pprod-stack">
          <Pill tone={cell.tone} icon={cell.locked ? <Lock size={12} aria-hidden /> : undefined} truncate>
            {cell.text}
          </Pill>
          {cell.note ? (
            <span className="fw-pprod-sub fw-pprod-clip" title={cell.note}>
              {cell.note}
            </span>
          ) : null}
        </span>
      )
    }
    const OrderCell = ({ data }: ICellRendererParams<ProductionRow>) => {
      if (!data) return null
      const ref = rowRef(data, locale)
      const pair =
        ref.theirs || ref.ours ? (
          <RefPair theirs={ref.theirs} ours={ref.ours?.value ?? null} theirsLabel={t('ref.yours')} oursLabel={ref.ours?.label ?? ''} layout="stacked" size="sm" copy={false} match={latest.current.model.q || null} labels={ds.refPair} />
        ) : (
          <span>{t('row.noName')}</span>
        )
      return (
        <a
          className="fw-pprod-rowlink"
          href={rowHref(latest.current.model.prefix, data)}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
            event.preventDefault()
            latest.current.actions?.onOpen?.(data)
          }}
        >
          {pair}
        </a>
      )
    }
    const SentCell = ({ data }: ICellRendererParams<ProductionRow>) => (data ? <span>{day(data.orderedOn)}</span> : null)
    const StylesCell = ({ data }: ICellRendererParams<ProductionRow>) =>
      data ? (
        <span className="fw-pprod-stack">
          <span className="fw-pprod-clip" title={stylesText(data, t)}>
            {stylesText(data, t)}
          </span>
          <span className="fw-pprod-sub">{t('cell.pieces', { count: data.pieces })}</span>
        </span>
      ) : null
    const StageCell = ({ data }: ICellRendererParams<ProductionRow>) => {
      if (!data) return null
      const next = data.next ? (data.next.date ? t('cell.nextOn', { what: data.next.words[locale], date: day(data.next.date) }) : t('cell.next', { what: data.next.words[locale] })) : null
      return (
        <span className="fw-pprod-stack">
          <StageStrip face="customer" layout="compact" stage={plainStageOf(data.stage)} label={t('cell.stagesOf', { name: rowName(data, locale, t) })} />
          {data.count ? <span className="fw-pprod-sub fw-pprod-clip">{data.count.words[locale]}</span> : null}
          {next ? <span className="fw-pprod-sub fw-pprod-clip">{next}</span> : null}
          {data.marks.words.length > 0 ? (
            <span className="fw-pprod-marks">
              {data.marks.words.map((mark) => (
                <Tag key={mark.en} tone={data.marks.onHold ? 'warning' : 'neutral'} truncate>
                  {mark[locale]}
                </Tag>
              ))}
            </span>
          ) : null}
        </span>
      )
    }
    const WaitingCell = ({ data }: ICellRendererParams<ProductionRow>) => {
      if (!data) return null
      return (
        <span className="fw-pprod-stack">
          <WaitingOnPill face="customer" now={now()} {...waitingInputOf(data.waiting)} />
          {/* The one next step when it is the customer's turn: the order's Status & progress, where what waits is named. */}
          {data.waiting.code === 'YOU' ? (
            <Button asChild size="sm" variant="quiet">
              <a href={rowHref(latest.current.model.prefix, data)}>{t('cell.seeWhat')}</a>
            </Button>
          ) : null}
        </span>
      )
    }
    const ExpectedCell = ({ data }: ICellRendererParams<ProductionRow>) => {
      if (!data) return null
      return (
        <span className="fw-pprod-stack">
          {data.promiseDate ? <span>{day(data.promiseDate)}</span> : <span className="fw-pprod-sub">{t('cell.noDate')}</span>}
          {data.promiseMoved && data.originalPromiseDate ? <span className="fw-pprod-moved fw-pprod-clip">{t('cell.moved', { date: day(data.originalPromiseDate) })}</span> : null}
          <HealthPill face="customer" {...healthInputOf(data.health)} />
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<ProductionRow>) => {
      if (!data) return null
      const current = latest.current
      const mark = markActionOf(data, facts(data), locale, t)
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), href: rowHref(current.model.prefix, data) },
        ...(mark
          ? [{ id: 'mark', label: t(mark.urgency === 'URGENT' ? 'row.markUrgent' : 'row.markRegular'), disabled: mark.held !== null, description: mark.held ?? undefined, onSelect: () => current.actions?.onMark?.(data, mark.urgency) }]
          : []),
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { name: rowName(data, locale, t) }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<ProductionRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<ProductionRow> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    // Minimum widths fit a 1440 screen without the grid scrolling sideways; the flex shares the rest at 1920.
    return [
      ...(urgencyOn ? [{ ...column('urgency', t('col.urgency'), UrgencyCell, { flex: 0.8, minWidth: 128 }), valueGetter: ({ data }: { data?: ProductionRow }) => (data?.urgency ? urgencyText(urgencyCell(data.urgency, locale)) : '') }] : []),
      // The phone card's title: their PO first, the customer's own number.
      { ...column('order', t('col.order'), OrderCell, { flex: 1.1, minWidth: 156 }), valueGetter: ({ data }) => (data ? rowName(data, locale, t) : '') },
      { ...column('sent', t('col.sent'), SentCell, { flex: 0.6, minWidth: 96 }), valueGetter: ({ data }) => (data ? day(data.orderedOn) : '') },
      { ...column('styles', t('col.styles'), StylesCell, { flex: 1, minWidth: 136 }), valueGetter: ({ data }) => (data ? `${stylesText(data, t)} · ${t('cell.pieces', { count: data.pieces })}` : '') },
      { ...column('stage', t('col.stage'), StageCell, { flex: 1.2, minWidth: 168 }), valueGetter: ({ data }) => (data?.stage ? data.stage.words[locale] : '') },
      { ...column('waiting', t('col.waiting'), WaitingCell, { flex: 0.9, minWidth: 136 }), valueGetter: ({ data }) => (data ? data.waiting.words[locale] : '') },
      { ...column('expected', t('col.expected'), ExpectedCell, { flex: 0.9, minWidth: 140 }), valueGetter: ({ data }) => (data?.promiseDate ? day(data.promiseDate) : '') },
      { ...column('actions', t('col.actions'), MoreCell, { width: 72, minWidth: 72, maxWidth: 72 }), pinned: 'right', suppressHeaderMenuButton: true },
    ]
  }, [t, locale, day, ds.refPair, urgencyOn])

  // Urgent / Regular: the frame's own group headers (a header only for a group with orders in this view); none while urgency is off.
  const groups = useMemo((): ListGroups<ProductionRow> | null => {
    const present = groupsOf(read).filter((key) => (read?.items ?? []).some((row) => groupOf(row) === key))
    if (present.length === 0) return null
    return {
      keyOf: groupOf,
      groups: present.map((key) => ({
        key,
        name: t(`group.${key}`),
        label: <span>{t(`group.${key}`)}</span>,
        summary: key === 'URGENT' ? (read?.urgentUse ? <span className="fw-pprod-sub">{read.urgentUse.words[locale]}</span> : null) : <span className="fw-pprod-sub">{t('group.regularHint')}</span>,
      })),
      collapsed: model.collapsed,
      onToggle: (key) => latest.current.actions?.onToggleGroup?.(key),
    }
  }, [read, model.collapsed, t, locale])

  const searching = model.q.trim() !== ''
  const filtered = searching || (model.chip !== null && model.chip !== 'ALL')
  const state: ReactNode =
    model.state === 'error' ? (
      <EmptyState
        title={t('list.failed')}
        description={t('list.failedBody')}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('state.retry')}
          </Button>
        }
      />
    ) : rows !== null && rows.length === 0 ? (
      filtered ? (
        <EmptyState
          title={t('list.noMatch')}
          description={searching ? t('list.noMatchSearch', { q: model.q.trim() }) : t('list.noMatchChip')}
          action={
            <Button size="sm" onClick={() => actions?.onClear?.()}>
              {t('list.clear')}
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={<PackageSearch size={24} aria-hidden />}
          title={t('list.empty')}
          description={t('list.emptyBody')}
          action={
            <Button size="sm" asChild>
              <a href={`${model.prefix}/orders`}>{t('list.allOrders')}</a>
            </Button>
          }
        />
      )
    ) : undefined

  const notice = model.notice
  const use = urgencyOn ? (read?.urgentUse ?? null) : null
  const ownKeys: ListKey[] = []

  return (
    <div className="fw-pprod">
      {model.offlineSince ? <Banner tone="warning" icon={<WifiOff size={16} aria-hidden />} title={t('offline.title', { time: time(model.offlineSince) })} /> : null}
      {notice ? (
        <Banner
          tone={notice.tone}
          title={notice.words}
          action={
            <span className="fw-pprod-actions">
              {notice.undo ? (
                <Button size="sm" heldReason={model.undoHeld ?? null} onClick={() => actions?.onUndo?.(notice.undo!)}>
                  {t('notice.undo')}
                </Button>
              ) : null}
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('notice.hide')}
              </Button>
            </span>
          }
        />
      ) : null}
      {model.exportFailed ? (
        <Banner
          tone="danger"
          title={t('notice.exportFailed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetryExport?.()}>
              {t('state.retry')}
            </Button>
          }
        />
      ) : null}
      {use ? (
        // "2 of 3 urgent used" ("4 of 3 · 1 agreed with us"): its own open orders only, never a place or another customer's count.
        <p className="fw-pprod-use">
          <Pill tone={use.over || use.left === 0 ? 'warning' : 'neutral'}>{use.words[locale]}</Pill>
          <span className="fw-pprod-sub">{t('use.hint')}</span>
        </p>
      ) : null}
      {read ? (
        <div className="fw-pprod-chiprow">
          <div className="fw-pprod-chips" role="group" aria-label={t('chips.label')}>
            {read.chips.map((entry) => (
              <FilterChip key={entry.chip} pressed={entry.chip === chip} onClick={() => actions?.onChip?.(entry.chip)} aria-label={t('chips.chip', { name: entry.words[locale], count: entry.count })}>
                {entry.words[locale]} <span className="fw-pprod-chip-count">{entry.count}</span>
              </FilterChip>
            ))}
          </div>
          {filtered ? (
            <Button size="sm" variant="quiet" onClick={() => actions?.onClear?.()}>
              {t('chips.clear')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ListFrame<ProductionRow>
        label={t('list.label')}
        title={t('list.title')}
        listKey={null}
        rows={model.state === 'error' ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={read && rows ? t('list.count', { count: read.count }) : ''}
        search={
          <Input
            type="search"
            aria-label={t('list.search')}
            placeholder={t('list.searchHint')}
            defaultValue={model.q}
            onKeyDown={(event) => {
              if (event.key === 'Enter') actions?.onSearch?.((event.target as HTMLInputElement).value)
              if (event.key === 'Escape' && (event.target as HTMLInputElement).value === '') (event.target as HTMLInputElement).blur()
            }}
            onBlur={(event) => {
              if (event.target.value.trim() !== model.q.trim()) actions?.onSearch?.(event.target.value)
            }}
          />
        }
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={actions?.onHelp}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        cards={{ hrefOf: (row) => rowHref(model.prefix, row), fields: { order: { role: 'title' }, ...(urgencyOn ? { urgency: { role: 'subtitle' as const } } : {}), actions: { role: 'actions' } } }}
        groups={groups}
        keysOpen={model.keysOpen}
      />
      {model.dialog ? <UrgentOrderDialog model={model.dialog} rows={read?.items ?? []} actions={actions?.dialog} /> : null}
    </div>
  )
}
