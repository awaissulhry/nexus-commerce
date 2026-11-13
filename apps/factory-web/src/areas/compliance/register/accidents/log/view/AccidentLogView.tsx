'use client'

import { useMemo, useRef } from 'react'
import Link from 'next/link'
import { Copy, Download, MoreHorizontal, ScrollText, X } from 'lucide-react'
import { ACCIDENT_OUTCOMES, type AccidentOutcome } from '@nexus/factory-domain/sales/safety-reports/rules'
import { Banner, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Skeleton } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import { Freshness, NoAccess, PageHead } from '../../../../../quality/_shared/parts'
import type { LiveState } from '../../../../../quality/_shared/model'
import type { AccidentLog, LogEntry } from '../../api'
import { logFiltered, logRows, reportHref, REPORTS_PATH, type LogAddress, type SafetyCan } from '../../model'
import { AuthorityCell, OutcomeTag, SafetyMessages, useWords } from '../../parts'

/**
 * SCR-422 — the accident log (design compliance.register page.h "Accident log (W2b)", moved here from W2b-4 with SAL-423; Reg.
 * (EU) 2023/988 art. 20): one line per accident a safety report recorded — its newest revision — with the day, the place, the
 * product, what came of it (coarsely, never the injury) and whether the market surveillance authority was told; the ones to
 * tell (a death or serious harm, not told) first. Tiles = saved views; Rows ▾, What came of it ▾, Period ▾ as chips; the ONE
 * list frame (select-all, shift range, Copy N numbers and Export N while rows are selected, keys in the footer icon). A row
 * opens its report; ⋯ Record a revision… / The authority was told… open the report's own dialog. GPSR's reach to PPE is the
 * Owner's open question (Q37): the log is kept either way, and the page says so. Fetches nothing.
 */

export interface AccidentLogModel {
  readonly prefix: string
  readonly can: SafetyCan
  readonly address: LogAddress
  readonly rows: { readonly items: readonly LogEntry[] | null; readonly problem: string | null }
  readonly tiles: AccidentLog['tiles'] | null
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  /** Today (`YYYY-MM-DD`) for the period presets. */
  readonly today: string
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface AccidentLogActions {
  onAddress?: (patch: Partial<LogAddress>) => void
  onClear?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (entry: LogEntry) => void
  onSelect?: (ids: readonly string[]) => void
  onCopy?: (numbers: readonly string[]) => void
  onExport?: (rows: readonly LogEntry[]) => void
}

export function AccidentLogView({ model, actions }: { model: AccidentLogModel; actions?: AccidentLogActions }) {
  return (
    <SafetyMessages>
      <LogBody model={model} actions={actions} />
    </SafetyMessages>
  )
}

type Period = 'all' | 'year' | 'twelve' | 'thirty'
const PERIODS: readonly Period[] = ['all', 'year', 'twelve', 'thirty']

/** A period's first day from today (none for all). */
export function periodFrom(period: Period, today: string): string | null {
  if (period === 'all') return null
  if (period === 'year') return `${today.slice(0, 4)}-01-01`
  const day = new Date(`${today}T12:00:00Z`)
  if (period === 'twelve') day.setUTCFullYear(day.getUTCFullYear() - 1)
  else day.setUTCDate(day.getUTCDate() - 30)
  return day.toISOString().slice(0, 10)
}

function periodOf(address: LogAddress, today: string): Period | null {
  if (!address.from && !address.to) return 'all'
  return PERIODS.find((period) => period !== 'all' && address.to === null && periodFrom(period, today) === address.from) ?? null
}

function LogBody({ model, actions }: { model: AccidentLogModel; actions?: AccidentLogActions }) {
  const { t, day } = useWords()
  const ds = useDsWords()
  const live = useRef({ actions, model })
  live.current = { actions, model }
  const rows = useMemo(() => (model.rows.items ? logRows(model.rows.items, model.address) : null), [model.rows.items, model.address])
  const selected = model.selected ?? []
  const selectedRows = (rows ?? []).filter((row) => selected.includes(row.reportId))

  const columns = useMemo<ColDef<LogEntry>[]>(() => {
    const href = (row: LogEntry, act?: 'revise' | 'told') => reportHref(live.current.model.prefix, row.reportId, act ? 'accident' : undefined, act)
    const ReportCell = ({ data }: ICellRendererParams<LogEntry>) =>
      data ? (
        <span className="fw-acc-cell">
          <Link className="fw-acc-mono" href={href(data)} tabIndex={-1}>
            {data.number}
          </Link>
          <span className="fw-acc-hint">{t(`status.${data.reportStatus}`)}</span>
        </span>
      ) : null
    const ProductCell = ({ data }: ICellRendererParams<LogEntry>) =>
      data ? (
        <span className="fw-acc-cell">
          <span>{data.style ? `${data.style.code} · ${data.style.name}` : t('garment.noStyle')}</span>
          <span className="fw-acc-hint fw-acc-mono">{[data.serial, data.batchNumber].filter(Boolean).join(' · ') || '—'}</span>
        </span>
      ) : null
    const OutcomeCell = ({ data }: ICellRendererParams<LogEntry>) => (data ? <OutcomeTag outcome={data.outcome} /> : null)
    const AuthorityColumn = ({ data }: ICellRendererParams<LogEntry>) => (data ? <AuthorityCell told={data.authority !== null} toldAt={data.authority?.toldAt ?? null} reference={data.authority?.reference ?? null} mustTell={data.mustTell} outcome={data.outcome} /> : null)
    const RevisionCell = ({ data }: ICellRendererParams<LogEntry>) => (data ? <span className="fw-acc-hint">{t('log.revisions', { count: data.revisions })}</span> : null)
    const ActionsCell = ({ data }: ICellRendererParams<LogEntry>) => {
      if (!data) return null
      const logHeld = live.current.model.can.log ? null : t('held.NO_LOG')
      return (
        <Menu
          align="right"
          label={<MoreHorizontal size={16} aria-hidden />}
          triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('row.open'), href: href(data) },
            { id: 'tab', label: t('row.openNewTab'), href: href(data), target: '_blank' },
            { id: 'revise', label: t('row.revise'), ...(logHeld ? { disabled: true, description: logHeld } : { href: href(data, 'revise') }) },
            { id: 'told', label: t('row.told'), ...(logHeld || data.authority ? { disabled: true, description: logHeld ?? t('held.TOLD') } : { href: href(data, 'told') }) },
            { id: 'copy', label: t('row.copy'), onSelect: () => live.current.actions?.onCopy?.([data.number]) },
          ]}
        />
      )
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<LogEntry>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<LogEntry> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('report', t('log.col.report'), ReportCell, { flex: 1, minWidth: 150 }),
      { colId: 'day', headerName: t('log.col.day'), sortable: false, flex: 0.8, minWidth: 110, valueGetter: (params) => (params.data ? day(params.data.occurredOn) : '') },
      { colId: 'place', headerName: t('log.col.place'), sortable: false, flex: 1.4, minWidth: 160, valueGetter: (params) => params.data?.place ?? '' },
      column('product', t('log.col.product'), ProductCell, { flex: 1.6, minWidth: 190 }),
      column('outcome', t('log.col.outcome'), OutcomeCell, { flex: 1, minWidth: 140 }),
      column('authority', t('log.col.authority'), AuthorityColumn, { flex: 1.2, minWidth: 160 }),
      column('revisions', t('log.col.revisions'), RevisionCell, { flex: 0.7, minWidth: 110 }),
      { ...column('actions', t('log.col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true },
    ]
  }, [t, day])

  if (!model.can.view) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />

  const address = model.address
  const set = (patch: Partial<LogAddress>) => actions?.onAddress?.(patch)
  const filtered = logFiltered(address)
  const period = periodOf(address, model.today)
  const tile = (id: 'entries' | 'toTell' | 'told') => {
    const active = id === 'entries' ? !filtered : id === 'toTell' ? address.toTell : address.told === 'yes' && !address.toTell
    const value = model.tiles ? model.tiles[id] : null
    return {
      label: t(`log.tile.${id}`),
      value: model.rows.items === null && !model.rows.problem ? <Skeleton width={36} height={22} /> : value === null ? '—' : String(value),
      hint: t(`log.tile.${id}Hint`),
      active,
      onClick: () => (id === 'entries' ? actions?.onClear?.() : id === 'toTell' ? set({ toTell: !address.toTell, told: null }) : set({ told: address.told === 'yes' ? null : 'yes', toTell: false })),
    }
  }
  const viewItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('log.rowsHeading') } as MenuItemDef,
    { id: 'all', label: t('log.view.all'), checked: !address.toTell && address.told === null, onSelect: () => set({ toTell: false, told: null }) },
    { id: 'toTell', label: t('log.view.toTell'), checked: address.toTell, onSelect: () => set({ toTell: true, told: null }) },
    { id: 'told', label: t('log.view.told'), checked: address.told === 'yes' && !address.toTell, onSelect: () => set({ toTell: false, told: 'yes' }) },
    { id: 'notTold', label: t('log.view.notTold'), checked: address.told === 'no' && !address.toTell, onSelect: () => set({ toTell: false, told: 'no' }) },
  ]
  const outcomeItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('log.col.outcome') } as MenuItemDef,
    ...ACCIDENT_OUTCOMES.map((outcome) => ({ id: outcome, label: t(`outcome.${outcome}`), checked: address.outcome === outcome, onSelect: () => set({ outcome: address.outcome === outcome ? null : (outcome as AccidentOutcome) }) }) as MenuItemDef),
  ]
  const periodItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('log.period') } as MenuItemDef,
    ...PERIODS.map((value) => ({ id: value, label: t(`log.periodValue.${value}`), checked: period === value, onSelect: () => set({ from: periodFrom(value, model.today), to: null }) }) as MenuItemDef),
  ]
  const viewWord = address.toTell ? t('log.view.toTell') : address.told === 'yes' ? t('log.view.told') : address.told === 'no' ? t('log.view.notTold') : t('log.view.all')
  const chip = (key: string, label: string, onRemove: () => void) => (
    <FilterChip key={key} pressed onClick={onRemove} aria-label={t('list.removeFilter', { name: label })}>
      {label} <X size={12} aria-hidden />
    </FilterChip>
  )
  const periodWord = period ? t(`log.periodValue.${period}`) : t('log.periodRange', { from: day(address.from), to: day(address.to) })
  const tools = (
    <>
      <Menu label={t('log.rows', { view: viewWord })} items={viewItems} />
      <Menu label={address.outcome ? t('log.outcomeIs', { outcome: t(`outcome.${address.outcome}`) }) : t('log.col.outcome')} items={outcomeItems} />
      <Menu label={t('log.periodIs', { period: periodWord })} items={periodItems} />
      {filtered && (
        <span className="fw-acc-actions" aria-label={t('list.activeFilters')}>
          {(address.toTell || address.told) && chip('view', viewWord, () => set({ toTell: false, told: null }))}
          {address.outcome && chip('outcome', t(`outcome.${address.outcome}`), () => set({ outcome: null }))}
          {(address.from || address.to) && chip('period', periodWord, () => set({ from: null, to: null }))}
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
      <EmptyState icon={<ScrollText size={24} aria-hidden />} title={t('log.empty.title')} description={t('log.empty.body')} />
    )
  ) : undefined

  return (
    <div className="fw-q">
      <PageHead
        intro={t('log.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <Button size="sm" variant="secondary" asChild>
            <Link href={`${model.prefix}${REPORTS_PATH}`}>{t('log.toReports')}</Link>
          </Button>
        }
      />
      <div className="fw-acc-law">
        <span className="fw-acc-hint">{t('log.lawLine')}</span>
        <LawRef law="Reg. (EU) 2023/988 art. 20" plain={t('log.law')} labels={ds.lawRef} />
      </div>
      <Banner tone="info" title={t('log.q37Title')}>
        {t('log.q37Body')}
      </Banner>
      <MetricStrip metrics={[tile('entries'), tile('toTell'), tile('told')]} />
      <ListFrame<LogEntry>
        label={t('log.table')}
        rows={model.rows.problem ? [] : rows}
        rowId={(row) => row.reportId}
        columns={columns}
        count={t('log.count', { count: rows?.length ?? 0 })}
        tools={tools}
        selection={{ selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
    </div>
  )
}
