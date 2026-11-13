'use client'

import { useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { Copy, Download, MoreHorizontal, Search, ShieldAlert, X } from 'lucide-react'
import { REPORT_VIEWS, SAFETY_SOURCES } from '@nexus/factory-domain/sales/safety-reports/rules'
import { Banner, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Skeleton, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import { Freshness, NoAccess, PageHead } from '../../../../../quality/_shared/parts'
import type { LiveState } from '../../../../../quality/_shared/model'
import type { Person, ReportCounts, ReportRow } from '../../api'
import { LOG_PATH, nameOf, reportHref, type ReportsAddress, type ReportSource, type ReportView, type SafetyCan } from '../../model'
import { GarmentCell, OutcomeTag, SafetyMessages, SourceTag, StatusPill, useWords } from '../../parts'
import { NewReportDialog, newReportHeld, type NewReportActions, type NewReportModel } from './NewReportDialog'

/**
 * SCR-421 — Product-safety reports (B-W2b-357; the office's place for B-W2b-351's reports: RECORD_PAGES.ProductSafetyReport;
 * reached from the PPE register's ⋯ › Accident log, the accident log, a SAFETY service case and the search): one sentence, the
 * doors from outside (closed until the privacy notice is published — the office types a report from a mail meanwhile), New
 * report (`c`), the tiles (Not seen · Being assessed · Accidents to tell the authority → the accident log), Rows ▾ and Source ▾
 * as chips, search, and the ONE list frame (select-all, shift range, Copy N numbers / Export N while rows are selected, keys in
 * the footer icon). A row never carries the reporter, what happened or anything of an injury (the API's list has none).
 * Fetches nothing: ReportsPage.tsx reads and writes.
 */

export interface ReportsListModel {
  readonly prefix: string
  readonly today: string
  readonly can: SafetyCan
  readonly address: ReportsAddress
  readonly rows: { readonly items: readonly ReportRow[] | null; readonly more: boolean; readonly problem: string | null }
  readonly counts: ReportCounts | null
  readonly people: readonly Person[] | null
  /** The doors from outside: open, closed (until the privacy notice), or unknown. */
  readonly outside: 'open' | 'closed' | null
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  readonly loadingMore: boolean
  readonly newReport: NewReportModel | null
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface ReportsListActions {
  onAddress?: (patch: Partial<Omit<ReportsAddress, 'isNew'>>) => void
  onClear?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onMore?: () => void
  onOpen?: (row: ReportRow) => void
  onSelect?: (ids: readonly string[]) => void
  onCopy?: (numbers: readonly string[]) => void
  onExport?: (rows: readonly ReportRow[]) => void
  onNew?: () => void
  newReport?: NewReportActions
}

export function ReportsListView({ model, actions }: { model: ReportsListModel; actions?: ReportsListActions }) {
  return (
    <SafetyMessages>
      <ReportsBody model={model} actions={actions} />
    </SafetyMessages>
  )
}

function ReportsBody({ model, actions }: { model: ReportsListModel; actions?: ReportsListActions }) {
  const { t, when } = useWords()
  const live = useRef({ actions, model })
  live.current = { actions, model }
  const rows = model.rows.items
  const selected = model.selected ?? []
  const selectedRows = (rows ?? []).filter((row) => selected.includes(row.id))
  const newHeld = newReportHeld(model.can, { busy: false })

  // c: New report (outside fields, menus and dialogs).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      event.preventDefault()
      live.current.actions?.onNew?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const columns = useMemo<ColDef<ReportRow>[]>(() => {
    const href = (row: ReportRow) => reportHref(live.current.model.prefix, row.id)
    const ReportCell = ({ data }: ICellRendererParams<ReportRow>) =>
      data ? (
        <span className="fw-acc-cell">
          <Link className="fw-acc-mono" href={href(data)} tabIndex={-1}>
            {data.number}
          </Link>
          <span className="fw-acc-hint">{when(data.receivedAt)}</span>
        </span>
      ) : null
    const SourceCell = ({ data }: ICellRendererParams<ReportRow>) => (data ? <SourceTag source={data.source} /> : null)
    const Garment = ({ data }: ICellRendererParams<ReportRow>) => (data ? <GarmentCell row={data} /> : null)
    const AccidentCell = ({ data }: ICellRendererParams<ReportRow>) =>
      data ? (
        data.accident ? (
          <span className="fw-acc-cell">
            <OutcomeTag outcome={data.accident.outcome} />
            <span className="fw-acc-hint">{data.accident.told ? t('authority.told') : data.accident.mustTell ? t('authority.toTell') : t('authority.notTold')}</span>
          </span>
        ) : (
          <span className="fw-acc-hint">{t('list.noAccident')}</span>
        )
      ) : null
    const CaseCell = ({ data }: ICellRendererParams<ReportRow>) =>
      data?.case ? (
        <Link className="fw-acc-mono" href={`${live.current.model.prefix}/sales/service/${encodeURIComponent(data.case.id)}`} tabIndex={-1}>
          {data.case.number}
        </Link>
      ) : (
        <span className="fw-acc-hint">—</span>
      )
    const StatusCell = ({ data }: ICellRendererParams<ReportRow>) =>
      data ? (
        <span className="fw-acc-cell">
          <StatusPill status={data.status} />
          {!data.seen && data.status !== 'CLOSED' && (
            <Tag tone="warning">
              {t('list.notSeen')}
            </Tag>
          )}
        </span>
      ) : null
    const ActionsCell = ({ data }: ICellRendererParams<ReportRow>) =>
      data ? (
        <Menu
          align="right"
          label={<MoreHorizontal size={16} aria-hidden />}
          triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('row.open'), href: href(data) },
            { id: 'tab', label: t('row.openNewTab'), href: href(data), target: '_blank' },
            { id: 'copy', label: t('row.copy'), onSelect: () => live.current.actions?.onCopy?.([data.number]) },
          ]}
        />
      ) : null
    const column = (colId: string, header: string, cellRenderer: ColDef<ReportRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<ReportRow> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('report', t('list.col.report'), ReportCell, { flex: 1.1, minWidth: 160 }),
      column('source', t('list.col.source'), SourceCell, { flex: 0.9, minWidth: 130 }),
      { colId: 'customer', headerName: t('list.col.customer'), sortable: false, flex: 1.1, minWidth: 140, valueGetter: (params) => (params.data ? (params.data.party?.legalName ?? t('list.noCustomer')) : '') },
      column('garment', t('list.col.garment'), Garment, { flex: 1.4, minWidth: 170 }),
      column('accident', t('list.col.accident'), AccidentCell, { flex: 1.1, minWidth: 150 }),
      column('case', t('list.col.case'), CaseCell, { flex: 0.9, minWidth: 130 }),
      { colId: 'filed', headerName: t('list.col.filed'), sortable: false, flex: 0.7, minWidth: 100, valueGetter: (params) => (params.data ? (params.data.filed ? t('list.filedYes') : t('list.filedNo')) : '') },
      column('status', t('list.col.status'), StatusCell, { flex: 0.9, minWidth: 120 }),
      { colId: 'owner', headerName: t('list.col.owner'), sortable: false, flex: 0.9, minWidth: 120, valueGetter: (params) => (params.data ? (nameOf(live.current.model.people, params.data.ownerId) ?? t('list.nobody')) : '') },
      { ...column('actions', t('list.col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true },
    ]
  }, [t, when])

  if (!model.can.view) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />

  const address = model.address
  const set = (patch: Partial<Omit<ReportsAddress, 'isNew'>>) => actions?.onAddress?.(patch)
  const filtered = address.view !== 'open' || address.source !== null || address.q.trim() !== ''
  const counts = model.counts
  const tile = (id: 'notSeen' | 'assessing' | 'accidentsToTell') => {
    const value = counts ? counts.tiles[id] : null
    const view: ReportView | null = id === 'notSeen' ? 'new' : id === 'assessing' ? 'assessing' : null
    const active = view !== null && address.view === view
    const shown = { label: t(`list.tile.${id}`), value: counts === null ? <Skeleton width={36} height={22} /> : String(value), hint: t(`list.tile.${id}Hint`) }
    // The accidents to tell open the accident log (a link tile); the others are saved rows of this list (filter tiles).
    if (view === null) return { ...shown, href: `${model.prefix}${LOG_PATH}?view=toTell` }
    return { ...shown, active, onClick: () => set({ view: active ? 'open' : view }) }
  }
  const viewItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('list.rowsHeading') } as MenuItemDef,
    ...REPORT_VIEWS.map((view) => ({ id: view, label: counts ? t('list.viewCount', { view: t(`viewName.${view}`), count: counts.rows[view] }) : t(`viewName.${view}`), checked: address.view === view, onSelect: () => set({ view }) }) as MenuItemDef),
  ]
  const sourceItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('list.col.source') } as MenuItemDef,
    ...SAFETY_SOURCES.map((source) => ({ id: source, label: t(`source.${source}`), checked: address.source === source, onSelect: () => set({ source: address.source === source ? null : (source as ReportSource) }) }) as MenuItemDef),
  ]
  const chip = (key: string, label: string, onRemove: () => void) => (
    <FilterChip key={key} pressed onClick={onRemove} aria-label={t('list.removeFilter', { name: label })}>
      {label} <X size={12} aria-hidden />
    </FilterChip>
  )
  const tools = (
    <>
      <Menu label={t('list.rows', { view: t(`viewName.${address.view}`) })} items={viewItems} />
      <Menu label={address.source ? t('list.sourceIs', { source: t(`source.${address.source}`) }) : t('list.col.source')} items={sourceItems} />
      {filtered && (
        <span className="fw-acc-actions" aria-label={t('list.activeFilters')}>
          {address.view !== 'open' && chip('view', t(`viewName.${address.view}`), () => set({ view: 'open' }))}
          {address.source && chip('source', t(`source.${address.source}`), () => set({ source: null }))}
          {address.q.trim() !== '' && chip('q', `“${address.q.trim()}”`, () => set({ q: '' }))}
          <Button size="sm" variant="quiet" onClick={() => actions?.onClear?.()}>
            {t('list.clearAll')}
          </Button>
        </span>
      )}
    </>
  )
  const bulk = (
    <>
      <Button size="sm" onClick={() => actions?.onCopy?.(selectedRows.map((row) => row.number))} aria-label={t('list.bulkCopy', { count: selectedRows.length })}>
        <Copy size={13} aria-hidden /> <SelectionLabel>{t('list.bulkCopy', { count: selectedRows.length })}</SelectionLabel>
      </Button>
      <Button size="sm" onClick={() => actions?.onExport?.(selectedRows)} aria-label={t('list.bulkExport', { count: selectedRows.length })}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulkExport', { count: selectedRows.length })}</SelectionLabel>
      </Button>
    </>
  )
  const state = model.rows.problem ? (
    <EmptyState
      title={t('read.failedTitle')}
      description={t(model.rows.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows !== null && rows.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('list.noMatch')}
        action={
          <Button size="sm" onClick={() => actions?.onClear?.()}>
            {t('list.clearAll')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<ShieldAlert size={24} aria-hidden />}
        title={t('list.empty.title')}
        description={t('list.empty.body')}
        action={
          <Button variant="primary" onClick={() => actions?.onNew?.()} heldReason={newHeld ? t(newHeld) : null}>
            {t('new.action')}
          </Button>
        }
      />
    )
  ) : undefined
  const more = rows !== null && model.rows.more ? { label: t('list.showMore'), onMore: () => actions?.onMore?.(), held: model.loadingMore ? t('common.loading') : null } : null

  return (
    <div className="fw-q">
      <PageHead
        intro={t('list.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            <Button size="sm" variant="secondary" asChild>
              <Link href={`${model.prefix}${LOG_PATH}`}>{t('list.toLog')}</Link>
            </Button>
            <Button size="sm" variant="primary" onClick={() => actions?.onNew?.()} heldReason={newHeld ? t(newHeld) : null} aria-keyshortcuts="c">
              {t('new.action')}
            </Button>
          </>
        }
      />
      {model.outside === 'closed' && (
        <Banner tone="info" title={t('list.outsideClosedTitle')}>
          {t('list.outsideClosedBody')}
        </Banner>
      )}
      <MetricStrip metrics={[tile('notSeen'), tile('assessing'), tile('accidentsToTell')]} />
      <ListFrame<ReportRow>
        label={t('list.table')}
        rows={model.rows.problem ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('list.count', { count: rows?.length ?? 0 })}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={14} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={address.q}
            onChange={(event) => set({ q: event.target.value })}
          />
        }
        tools={tools}
        selection={{ selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={more}
        keys={[{ keys: ['c'], does: t('keys.new') }]}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
      {model.newReport && <NewReportDialog model={model.newReport} can={model.can} actions={actions?.newReport} />}
    </div>
  )
}
