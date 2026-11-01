'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Search, Undo2 } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, type Metric, type MetricLinkComponent } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { COST_ENTRY_KINDS, type CostEntryKind, type CostTiles, type LedgerEntry, type MethodView, type StandardCost, type WorkOrderCostRow } from '../api'
import {
  basisPhrase,
  COSTING_NAMESPACE,
  decimalText,
  methodPhrase,
  moneyText,
  pctText,
  printHref,
  quantityText,
  reverseHeld,
  ROW_VIEWS,
  signedMoney,
  statePhrase,
  stylesHref,
  unitCostText,
  varianceTone,
  workOrderHref,
  type CostingAddress,
  type CostingCan,
  type CsvWords,
  type Phrase,
  type RowView,
} from '../model'
import { ReverseDialog, WorkOrderCostDialog, type DetailState, type ReverseState } from './CostDialogs'
import '../costing.css'

export type LiveState = 'connecting' | 'live' | 'offline'

/** One list the page reads (null rows while the first read runs; a problem when it failed: never drawn as empty). */
export interface ListPart<T> {
  readonly rows: readonly T[] | null
  readonly more: boolean
  readonly problem: string | null
  readonly slow: boolean
}

/** SCR-154 — Standard vs actual's view model (the view draws it and fetches nothing). */
export interface CostingModel {
  readonly prefix: string
  readonly can: CostingCan
  readonly today: string
  readonly address: CostingAddress
  /** The period's month and days (the ledger's dates, the standards in force, "closed this month"). */
  readonly period: { readonly month: string; readonly from: string; readonly to: string }
  /** The months the period may be (this one and the eleven before). */
  readonly months: readonly string[]
  /** The company's sites for the scope (none: the choice is not drawn). */
  readonly sites: ReadonlyArray<{ readonly id: string; readonly code: string }>
  /** The company's costing method (null while it reads or when it could not be read). */
  readonly method: MethodView | null
  readonly workOrders: ListPart<WorkOrderCostRow> & { readonly tiles: CostTiles | null }
  readonly standards: ListPart<StandardCost>
  readonly ledger: ListPart<LedgerEntry>
  readonly ledgerKind: CostEntryKind | null
  /** When the shown answer was read (ms; "Read at 09:40": the DS AsOf speaks English only). */
  readonly readAt: number | null
  readonly live: LiveState
  /** Live changes since the read ("N updates · Show"). */
  readonly updates: number
  readonly detail: DetailState | null
  readonly reverse: ReverseState | null
  readonly notice: { readonly tone: 'success' | 'danger' | 'info'; readonly words: Phrase } | null
  /** Design cases: the selected rows, the focused row, the keys panel open, a typed reason. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
  readonly draft?: { readonly reason?: string }
}

export type CostingPart = 'workOrders' | 'standards' | 'ledger' | 'detail'

export interface CostingActions {
  onSite?: (siteId: string | null) => void
  onRows?: (rows: RowView) => void
  onMonth?: (month: string | null) => void
  onSearch?: (text: string) => void
  onRetry?: (part: CostingPart) => void
  onMore?: (part: Exclude<CostingPart, 'detail'>) => void
  onShowUpdates?: () => void
  /** Open (an id) or close (null) a work order's cost. */
  onOpen?: (workOrderId: string | null) => void
  onLedgerKind?: (kind: CostEntryKind | null) => void
  /** Open (an entry) or close (null) Reverse entry. */
  onReverse?: (entry: LedgerEntry | null) => void
  onReverseSubmit?: (reason: string) => void
  /** The CSV of these rows (the view, or the rows chosen), with the words of its headings and cells and its file name. */
  onExport?: (rows: readonly WorkOrderCostRow[], words: CsvWords, fileName: string) => void
  onDismissNotice?: () => void
}

const LinkTile: MetricLinkComponent = ({ href, className, children }) => (
  <Link href={href} className={className}>
    {children}
  </Link>
)

/**
 * SCR-154 — Finance › Costing › Standard vs actual (design finance.costing; FIN-024, FIN-026, FIN-027, FIN-033, FIN-038):
 * the band (scope: site and period, read at, live; ⋯ Export this view, the cost ledger, Print; Mass cost update W2b,
 * held), the company's costing method in words (the accountant's choice, "not decided yet" while UNDECIDED: every cost
 * is provisional, the screen never picks one), Cost at a glance (over standard by more than 5 %, the variance this month,
 * the stock value, WIP value later), Work orders: standard vs actual (a row opens its cost: the DetailModal with J / K),
 * Standard cost per item (the frozen standards in force at the period's end) and the Cost ledger (every valuation event;
 * Reverse entry with a reason — a mistake is reversed, never edited). Amounts only with the cost grain: without it the
 * columns and tiles are not drawn (never a '—'). Labour per work order and operation only: never a person.
 */
export function CostingView({ model, actions }: { model: CostingModel; actions?: CostingActions }) {
  return (
    <WithMessages namespaces={[COSTING_NAMESPACE, 'lists']}>
      <Costing model={model} actions={actions} />
    </WithMessages>
  )
}

function Costing({ model, actions }: { model: CostingModel; actions?: CostingActions }) {
  const t = useT(COSTING_NAMESPACE)
  const lists = useT('lists')
  const locale = useLocale()
  const [selectedOwn, setSelected] = useState<string[]>([])
  const [help, setHelp] = useState(false)
  const [typed, setTyped] = useState<string | null>(null)
  const selected = model.selected ? [...model.selected] : selectedOwn
  const rows = model.workOrders.rows
  const can = model.can
  const dayText = (day: string) => formatDate(`${day}T12:00:00Z`, { locale })
  const monthText = (month: string) => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-15T12:00:00Z`))

  const woColumns = useMemo<ColDef<WorkOrderCostRow>[]>(() => {
    const WorkOrderCell = ({ data }: ICellRendererParams<WorkOrderCostRow>) =>
      data ? (
        <span className="fw-fco-cell">
          {can.workOrders ? (
            <Link className="fw-fco-link" href={workOrderHref(model.prefix, data.workOrder.id)} onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
              event.preventDefault()
              actions?.onOpen?.(data.workOrder.id)
            }}>
              {data.workOrder.number}
            </Link>
          ) : (
            <span>{data.workOrder.number}</span>
          )}
          <span className="fw-fco-cell-sub">{`${data.workOrder.style.code} · ${data.workOrder.style.name}`}</span>
        </span>
      ) : null
    const money = (pick: (row: WorkOrderCostRow) => number | null | undefined) =>
      function MoneyCell({ data }: ICellRendererParams<WorkOrderCostRow>) {
        return data ? <span className="fw-fco-num">{moneyText(pick(data) ?? null, data.currency, locale)}</span> : null
      }
    const EstimateCell = ({ data }: ICellRendererParams<WorkOrderCostRow>) =>
      data ? (
        <span className="fw-fco-cell">
          <span className="fw-fco-num">{moneyText(data.estimateTotal ?? null, data.currency, locale)}</span>
          {!data.estimateComplete && data.estimateTotal !== null && <span className="fw-fco-cell-sub">{t('row.estimatePart')}</span>}
        </span>
      ) : null
    const VarianceCell = ({ data }: ICellRendererParams<WorkOrderCostRow>) =>
      data ? (
        <span className="fw-fco-inline">
          <span className="fw-fco-num">{signedMoney(data.variance ?? null, data.currency, locale)}</span>
          {data.variancePct !== null && data.variancePct !== undefined && <Pill tone={varianceTone(data)}>{pctText(data.variancePct, locale, true)}</Pill>}
        </span>
      ) : null
    const BasisCell = ({ data }: ICellRendererParams<WorkOrderCostRow>) => {
      if (!data) return null
      const basis = basisPhrase(data)
      return (
        <span className="fw-fco-cell">
          <span className="fw-fco-ellipsis">{t(basis.key)}</span>
          {data.provisional && <span className="fw-fco-cell-sub">{t('row.provisional')}</span>}
        </span>
      )
    }
    const ReasonCell = ({ data }: ICellRendererParams<WorkOrderCostRow>) => (data ? <span className="fw-fco-ellipsis">{data.biggestReason ? t(`reason.${data.biggestReason}`) : t('reason.none')}</span> : null)
    const StateCell = ({ data }: ICellRendererParams<WorkOrderCostRow>) => {
      if (!data) return null
      const state = statePhrase(data)
      return (
        <span className="fw-fco-inline">
          <Tag tone={data.final ? 'success' : 'info'}>{t(state.key)}</Tag>
          {data.over && <Pill tone="danger">{t('row.over')}</Pill>}
        </span>
      )
    }
    return [
      { colId: 'workOrder', headerName: t('col.workOrder'), minWidth: 190, flex: 1.4, cellRenderer: WorkOrderCell },
      { colId: 'pieces', headerName: t('col.pieces'), minWidth: 100, flex: 0.4, type: 'rightAligned', valueGetter: (params) => params.data?.workOrder.pieces },
      { colId: 'basis', headerName: t('col.basis'), minWidth: 150, flex: 0.9, cellRenderer: BasisCell },
      ...(can.cost
        ? [
            { colId: 'standard', headerName: t('col.standard'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: money((row) => row.standardTotal) } satisfies ColDef<WorkOrderCostRow>,
            { colId: 'estimate', headerName: t('col.estimate'), minWidth: 130, flex: 0.8, type: 'rightAligned', cellRenderer: EstimateCell } satisfies ColDef<WorkOrderCostRow>,
            { colId: 'actual', headerName: t('col.actual'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: money((row) => row.actualTotal) } satisfies ColDef<WorkOrderCostRow>,
            { colId: 'variance', headerName: t('col.variance'), minWidth: 170, flex: 1, cellRenderer: VarianceCell } satisfies ColDef<WorkOrderCostRow>,
          ]
        : []),
      { colId: 'reason', headerName: t('col.reason'), minWidth: 150, flex: 0.9, cellRenderer: ReasonCell },
      { colId: 'state', headerName: t('col.state'), minWidth: 170, flex: 0.9, cellRenderer: StateCell },
    ]
  }, [t, locale, model.prefix, can, actions])

  const standardColumns = useMemo<ColDef<StandardCost>[]>(() => {
    const ItemCell = ({ data }: ICellRendererParams<StandardCost>) =>
      data ? (
        <span className="fw-fco-cell">
          <span className="fw-fco-ellipsis">{`${data.item.code} · ${data.item.name}`}</span>
          <span className="fw-fco-cell-sub">{`${t(`itemKind.${data.item.kind === 'FINISHED' ? 'FINISHED' : 'MATERIAL'}`)} · ${t(`source.${data.source}`)}`}</span>
        </span>
      ) : null
    const PeriodCell = ({ data }: ICellRendererParams<StandardCost>) => (data ? <span>{data.validTo ? t('standards.period', { from: dayText(data.validFrom), to: dayText(data.validTo) }) : t('standards.from', { from: dayText(data.validFrom) })}</span> : null)
    const unit = (pick: (row: StandardCost) => string | undefined) =>
      function UnitCell({ data }: ICellRendererParams<StandardCost>) {
        return data ? <span className="fw-fco-num">{unitCostText(pick(data) ?? null, data.currency, locale)}</span> : null
      }
    const LabourCell = ({ data }: ICellRendererParams<StandardCost>) =>
      data ? (
        <span className="fw-fco-cell">
          <span className="fw-fco-num">{can.cost ? unitCostText(data.labourCost ?? null, data.currency, locale) : data.labourMinutes ? t('labour.minutes', { minutes: decimalText(data.labourMinutes, locale, 1) }) : '—'}</span>
          {can.cost && data.labourMinutes && <span className="fw-fco-cell-sub">{t('standards.minutes', { minutes: decimalText(data.labourMinutes, locale, 1) })}</span>}
        </span>
      ) : null
    return [
      { colId: 'item', headerName: t('standards.col.item'), minWidth: 220, flex: 1.6, cellRenderer: ItemCell },
      { colId: 'period', headerName: t('standards.col.period'), minWidth: 170, flex: 1, cellRenderer: PeriodCell },
      ...(can.cost ? [{ colId: 'material', headerName: t('standards.col.material'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: unit((row) => row.materialCost) } satisfies ColDef<StandardCost>] : []),
      { colId: 'labour', headerName: t('standards.col.labour'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: LabourCell },
      ...(can.cost
        ? [
            { colId: 'subcontract', headerName: t('standards.col.subcontract'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: unit((row) => row.subcontractCost) } satisfies ColDef<StandardCost>,
            { colId: 'overhead', headerName: t('standards.col.overhead'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: unit((row) => row.overheadCost) } satisfies ColDef<StandardCost>,
            { colId: 'total', headerName: t('standards.col.total'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: unit((row) => row.unitCost) } satisfies ColDef<StandardCost>,
          ]
        : []),
    ]
  }, [t, locale, can.cost])

  const ledgerColumns = useMemo<ColDef<LedgerEntry>[]>(() => {
    const DateCell = ({ data }: ICellRendererParams<LedgerEntry>) => (data ? <span className="fw-fco-num">{dayText(data.day)}</span> : null)
    const WorkOrderCell = ({ data }: ICellRendererParams<LedgerEntry>) =>
      data ? (
        can.workOrders ? (
          <Link className="fw-fco-link" href={workOrderHref(model.prefix, data.workOrder.id)}>
            {data.workOrder.number}
          </Link>
        ) : (
          <span>{data.workOrder.number}</span>
        )
      ) : null
    const EventCell = ({ data }: ICellRendererParams<LedgerEntry>) =>
      data ? (
        <span className="fw-fco-cell">
          <span className="fw-fco-ellipsis">{t(`event.${data.event}`)}</span>
          <span className="fw-fco-cell-sub">{data.provisional ? t('ledger.provisional') : t(`kind.${data.kind}`)}</span>
        </span>
      ) : null
    const ItemCell = ({ data }: ICellRendererParams<LedgerEntry>) =>
      data ? (
        <span className="fw-fco-cell">
          <span className="fw-fco-ellipsis">{data.item ? `${data.item.code} · ${data.item.name}` : '—'}</span>
          <span className="fw-fco-cell-sub">{data.document?.label ?? t('ledger.noDocument')}</span>
        </span>
      ) : null
    const QuantityCell = ({ data }: ICellRendererParams<LedgerEntry>) =>
      data ? <span className="fw-fco-num">{data.item ? quantityText(data.quantity, data.item.baseUom, locale) : data.minutes ? t('labour.minutes', { minutes: decimalText(data.minutes, locale, 1) }) : '—'}</span> : null
    const ValueCell = ({ data }: ICellRendererParams<LedgerEntry>) => (data ? <span className="fw-fco-num">{signedMoney(data.amount ?? null, data.currency, locale)}</span> : null)
    const ReversalCell = ({ data }: ICellRendererParams<LedgerEntry>) => {
      if (!data) return null
      if (data.reversalOfId) return <Tag tone="neutral">{t('ledger.isReversal')}</Tag>
      if (data.reversedBy)
        return (
          <span className="fw-fco-cell">
            <Tag tone="warning">{t('ledger.reversedOn', { day: formatDate(data.reversedBy.occurredAt, { locale }) })}</Tag>
            {data.reversedBy.reason && <span className="fw-fco-cell-sub">{data.reversedBy.reason}</span>}
          </span>
        )
      return <span className="fw-fco-muted">—</span>
    }
    const ActionCell = ({ data }: ICellRendererParams<LedgerEntry>) => {
      if (!data) return null
      const held = reverseHeld(data, can)
      return (
        <Button size="sm" variant="quiet" heldReason={held ? t(held.key, held.params) : null} onClick={() => actions?.onReverse?.(data)} aria-label={t('ledger.reverseLabel', { number: data.workOrder.number, event: t(`event.${data.event}`) })}>
          <Undo2 size={13} aria-hidden /> {t('ledger.reverse')}
        </Button>
      )
    }
    return [
      { colId: 'date', headerName: t('ledger.col.date'), minWidth: 110, flex: 0.6, cellRenderer: DateCell },
      { colId: 'workOrder', headerName: t('ledger.col.workOrder'), minWidth: 120, flex: 0.7, cellRenderer: WorkOrderCell },
      { colId: 'event', headerName: t('ledger.col.event'), minWidth: 160, flex: 1, cellRenderer: EventCell },
      { colId: 'item', headerName: t('ledger.col.itemDocument'), minWidth: 200, flex: 1.4, cellRenderer: ItemCell },
      { colId: 'quantity', headerName: t('ledger.col.quantity'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: QuantityCell },
      ...(can.cost ? [{ colId: 'value', headerName: t('ledger.col.value'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: ValueCell } satisfies ColDef<LedgerEntry>] : []),
      { colId: 'reversal', headerName: t('ledger.col.reversal'), minWidth: 150, flex: 1, cellRenderer: ReversalCell },
      { colId: 'action', headerName: t('ledger.col.action'), minWidth: 120, flex: 0.6, cellRenderer: ActionCell, sortable: false },
    ]
  }, [t, locale, model.prefix, can, actions])

  if (!can.view) {
    return (
      <div className="fw-fco">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body', { permission: 'costing.view' })} />
      </div>
    )
  }

  const tiles = model.workOrders.tiles
  const picked = (rows ?? []).filter((row) => selected.includes(row.workOrder.id))
  const filtered = model.address.site !== null || model.address.q !== null || model.address.rows !== 'all'
  const method = model.method ? methodPhrase(model.method) : null
  const methodName = model.method && model.method.method !== 'UNDECIDED' ? t(`method.name.${model.method.method}`) : ''
  const csvWords: CsvWords = {
    header: (column) => t(`csv.${column}`),
    basis: (row) => t(basisPhrase(row).key),
    reason: (reason) => (reason ? t(`reason.${reason}`) : t('reason.none')),
    state: (row) => t(statePhrase(row).key),
  }
  const fileName = `${t('csv.file', { month: model.period.month })}.csv`
  const ownKeys: ListKey[] = [{ keys: ['/'], does: t('keys.search') }, { keys: ['Enter'], does: t('keys.open') }]

  const metrics: Metric[] = [
    {
      label: t('tiles.over'),
      value: tiles ? (tiles.overStandard === null ? '—' : String(tiles.overStandard)) : '—',
      hint: t('tiles.overHint'),
      onClick: () => actions?.onRows?.(model.address.rows === 'over' ? 'all' : 'over'),
      active: model.address.rows === 'over',
    },
    ...(can.cost
      ? ([
          { label: t('tiles.variance', { month: tiles ? monthText(tiles.month) : '' }), value: tiles ? signedMoney(tiles.varianceThisMonth ?? null, tiles.currency, locale) : '—', hint: t('tiles.varianceHint') },
          { label: t('tiles.stock'), value: tiles ? moneyText(tiles.stockValue ?? null, tiles.currency, locale) : '—', hint: tiles && tiles.unvaluedMoves > 0 ? t('tiles.unvalued', { count: tiles.unvaluedMoves }) : t('tiles.stockHint'), href: `${model.prefix}/finance/reports` },
          { label: t('tiles.wip'), value: '—', hint: t('tiles.wipLater') },
        ] satisfies Metric[])
      : []),
  ]

  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('list.search')}
      placeholder={t('list.search')}
      value={typed ?? model.address.q ?? ''}
      onChange={(event) => {
        setTyped(event.target.value)
        actions?.onSearch?.(event.target.value)
      }}
    />
  )
  const rowsTool = (
    <Select size="sm" aria-label={t('rows.label')} value={model.address.rows} onChange={(event) => actions?.onRows?.(event.target.value as RowView)}>
      {ROW_VIEWS.map((view) => (
        <option key={view} value={view}>
          {t(`rows.${view}`, { month: monthText(model.period.month) })}
        </option>
      ))}
    </Select>
  )
  const clear = (
    <Button
      size="sm"
      onClick={() => {
        setTyped(null)
        actions?.onSite?.(null)
        actions?.onRows?.('all')
        actions?.onSearch?.('')
      }}
    >
      {t('list.clearFilters')}
    </Button>
  )
  const woState = model.workOrders.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.workOrders.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('workOrders')}>{t('common.retry')}</Button>} />
  ) : rows && rows.length === 0 ? (
    filtered ? <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={clear} /> : <EmptyState title={t('list.empty.title')} description={t('list.empty.body')} />
  ) : undefined

  const standardsState = model.standards.problem ? (
    <EmptyState title={t('standards.failed')} description={t(model.standards.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('standards')}>{t('common.retry')}</Button>} />
  ) : model.standards.rows && model.standards.rows.length === 0 ? (
    <EmptyState
      title={t('standards.empty.title')}
      description={t('standards.empty.body', { day: dayText(model.period.to) })}
      action={
        can.styles ? (
          <Button size="sm" asChild>
            <Link href={stylesHref(model.prefix)}>{t('standards.empty.action')}</Link>
          </Button>
        ) : undefined
      }
    />
  ) : undefined

  const ledgerState = model.ledger.problem ? (
    <EmptyState title={t('ledger.failed')} description={t(model.ledger.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('ledger')}>{t('common.retry')}</Button>} />
  ) : model.ledger.rows && model.ledger.rows.length === 0 ? (
    <EmptyState title={t('ledger.empty.title')} description={t('ledger.empty.body', { month: monthText(model.period.month) })} />
  ) : undefined

  const detailIds = (rows ?? []).map((row) => row.workOrder.id)

  return (
    <div className="fw-fco">
      <div className="fw-fco-band" role="group" aria-label={t('band.label')}>
        <span className="fw-fco-inline">
          {model.sites.length > 1 && (
            <label className="fw-fco-inline">
              <span className="fw-fco-muted">{t('scope.site')}</span>
              <Select size="sm" value={model.address.site ?? ''} onChange={(event) => actions?.onSite?.(event.target.value || null)}>
                <option value="">{t('scope.allSites')}</option>
                {model.sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.code}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <label className="fw-fco-inline">
            <span className="fw-fco-muted">{t('scope.period')}</span>
            <Select size="sm" value={model.period.month} onChange={(event) => actions?.onMonth?.(event.target.value === model.months[0] ? null : event.target.value)}>
              {model.months.map((month) => (
                <option key={month} value={month}>
                  {monthText(month)}
                </option>
              ))}
            </Select>
          </label>
          {model.readAt !== null ? <span className="fw-fco-muted">{t('band.readAt', { time: formatTime(model.readAt, { locale }) })}</span> : <span className="fw-fco-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </span>
        <span className="fw-fco-inline">
          <Button size="sm" heldReason={t('band.massHeld')}>
            {t('band.mass')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'export', label: t('band.export'), onSelect: () => rows && actions?.onExport?.(rows, csvWords, fileName), ...(rows && rows.length > 0 ? {} : { disabled: true, description: t('band.exportHeld') }) },
              { id: 'ledger', label: t('band.ledger'), href: '#fw-fco-ledger' },
              { id: 'print', label: t('band.print'), href: printHref(model.prefix, model.address), target: '_blank' },
            ]}
          />
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.words.key, model.notice.words.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}

      <Banner tone={!model.method || model.method.method === 'UNDECIDED' ? 'warning' : 'info'} title={method ? t(method.key, { method: methodName }) : t('method.reading')}>
        {t('method.body')}
      </Banner>

      <section className="fw-fco-section" aria-labelledby="fw-fco-tiles">
        <h2 id="fw-fco-tiles" className="fw-fco-h2">
          {t('tiles.title')}
        </h2>
        {model.workOrders.problem && !tiles ? (
          <EmptyState title={t('tiles.failed')} description={t(model.workOrders.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('workOrders')}>{t('common.retry')}</Button>} />
        ) : (
          <MetricStrip metrics={metrics} minTileWidth={190} linkAs={LinkTile} />
        )}
        {!can.cost && <p className="fw-fco-muted">{t('noCost.tiles')}</p>}
      </section>

      <section className="fw-fco-section" aria-labelledby="fw-fco-wos">
        <div className="fw-fco-section-head">
          <h2 id="fw-fco-wos" className="fw-fco-h2">
            {t('list.title')}
          </h2>
          <span className="fw-fco-muted">{t('list.hint')}</span>
        </div>
        {model.workOrders.slow && !rows && !model.workOrders.problem && (
          <p className="fw-fco-muted" role="status">
            {t('list.slow')}
          </p>
        )}
        <ListFrame<WorkOrderCostRow>
          label={t('list.title')}
          title={t('list.fileTitle')}
          rows={woState ? [] : rows}
          rowId={(row) => row.workOrder.id}
          columns={woColumns}
          count={rows ? t('list.count', { count: rows.length }) : '—'}
          search={search}
          tools={rowsTool}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <Button size="sm" variant="primary" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked, csvWords, fileName)}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
            ),
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          more={model.workOrders.more ? { label: t('list.more'), onMore: () => actions?.onMore?.('workOrders') } : null}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          onOpen={(row) => actions?.onOpen?.(row.workOrder.id)}
          state={woState}
          focusRow={model.focusRow}
          keysOpen={model.keysOpen}
        />
      </section>

      <section className="fw-fco-section" aria-labelledby="fw-fco-standards">
        <div className="fw-fco-section-head">
          <h2 id="fw-fco-standards" className="fw-fco-h2">
            {t('standards.title')}
          </h2>
          <span className="fw-fco-inline">
            <span className="fw-fco-muted">{t('standards.hint', { day: dayText(model.period.to) })}</span>
            {can.styles && (
              <Link className="fw-fco-link" href={stylesHref(model.prefix)}>
                {t('standards.costSheets')}
              </Link>
            )}
          </span>
        </div>
        {model.standards.slow && !model.standards.rows && !model.standards.problem && (
          <p className="fw-fco-muted" role="status">
            {t('list.slow')}
          </p>
        )}
        <ListFrame<StandardCost>
          label={t('standards.title')}
          title={t('standards.title')}
          listKey="finance.costing.2"
          rows={standardsState ? [] : model.standards.rows}
          rowId={(row) => row.id}
          columns={standardColumns}
          count={model.standards.rows ? t('standards.count', { count: model.standards.rows.length }) : '—'}
          more={model.standards.more ? { label: t('list.more'), onMore: () => actions?.onMore?.('standards') } : null}
          onHelp={() => setHelp(true)}
          state={standardsState}
        />
      </section>

      <section id="fw-fco-ledger" className="fw-fco-section" aria-labelledby="fw-fco-ledger-title">
        <div className="fw-fco-section-head">
          <h2 id="fw-fco-ledger-title" className="fw-fco-h2">
            {t('ledger.title')}
          </h2>
          <span className="fw-fco-muted">{t('ledger.hint', { from: dayText(model.period.from), to: dayText(model.period.to) })}</span>
        </div>
        {model.ledger.slow && !model.ledger.rows && !model.ledger.problem && (
          <p className="fw-fco-muted" role="status">
            {t('list.slow')}
          </p>
        )}
        <ListFrame<LedgerEntry>
          label={t('ledger.title')}
          title={t('ledger.title')}
          listKey="finance.costing.3"
          rows={ledgerState ? [] : model.ledger.rows}
          rowId={(row) => row.id}
          columns={ledgerColumns}
          count={model.ledger.rows ? t('ledger.count', { count: model.ledger.rows.length }) : '—'}
          tools={
            <Select size="sm" aria-label={t('ledger.kindLabel')} value={model.ledgerKind ?? ''} onChange={(event) => actions?.onLedgerKind?.((event.target.value || null) as CostEntryKind | null)}>
              <option value="">{t('ledger.allKinds')}</option>
              {COST_ENTRY_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
          }
          more={model.ledger.more ? { label: t('list.more'), onMore: () => actions?.onMore?.('ledger') } : null}
          onHelp={() => setHelp(true)}
          state={ledgerState}
        />
        <p className="fw-fco-muted">{t('ledger.never')}</p>
      </section>

      {model.detail && <WorkOrderCostDialog state={model.detail} ids={detailIds} can={can} prefix={model.prefix} onGo={(id) => actions?.onOpen?.(id)} onClose={() => actions?.onOpen?.(null)} onRetry={() => actions?.onRetry?.('detail')} />}
      {model.reverse && <ReverseDialog state={model.reverse} can={can} draft={model.draft?.reason} onSubmit={(reason) => actions?.onReverseSubmit?.(reason)} onClose={() => actions?.onReverse?.(null)} />}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('keys.title')} size="sm">
          <ul className="fw-fco-notes">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={`${entry.keys.join('+')}-${entry.does}`}>
                <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}
