'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, Hand, MoreHorizontal, Timer, Truck } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select, Tag } from '@nexus/ui/primitives'
import { Countdown } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { WithMessages } from '../../../../../record-panels/i18n'
import { holdable } from '../../holds/model'
import type { NotPlanned, ProblemRow, QueueRow, SearchRow } from '../api'
import { cardName, RISK_TONE, todayRows, type QueueDepthActions, type QueueDepthModel } from '../model'
import { dayInstant, DEPTH_NAMESPACES } from '../shared/depth'
import { PartRead, useDepthWords } from '../shared/DepthDialog'
import '../../shipments.css'
import '../shared/depth.css'

/**
 * SCR-590 / SCR-591 — the shipments list in depth (design warehouse.shipments sh-cutoff, sh-grid "Rows ▾ views: Ship today
 * (default) · At risk of missing the promise · Open · Shipped · All", "search by order, tracking number, SSCC, customer PO
 * or serial", sh-metrics "Exceptions"): the site's carrier cut-offs today (per carrier: the countdown on the site's clock,
 * where the time comes from, what is packed, still to pack, held, will miss), the site closed today said; the grids of Ship
 * today (worst first: late, held, missed the cut-off, at risk, due today), At risk (every site, and the orders not planned on
 * any shipment yet), Exceptions (the open tracking problems) and the search (any status, what each row matched; an SSCC is
 * not kept yet, said so). Hold N on the selection (the shared list frame: select-all, shift range, x).
 */

type T = (key: string, params?: Record<string, string | number>) => string

/** The carrier cut-off cards of the chosen site (in place of W1's computed cards), the site picker and the closed day. */
export function QueueCutOffs({ model, actions }: { model: QueueDepthModel; actions?: QueueDepthActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <CutOffs model={model} actions={actions} />
    </WithMessages>
  )
}

function CutOffs({ model, actions }: { model: QueueDepthModel; actions?: QueueDepthActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const picker =
    model.sites && model.sites.length > 1 ? (
      <Select size="sm" aria-label={t('today.site')} value={model.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value)}>
        {model.sites.map((site) => (
          <option key={site.siteId} value={site.siteId}>
            {site.code} · {site.name}
          </option>
        ))}
      </Select>
    ) : null
  if (model.today.state !== 'ready') {
    return (
      <section className="fw-shd-today" aria-label={t('today.label')}>
        {picker}
        {model.today.state === 'error' ? <PartRead problem={model.today.problem} onRetry={actions?.onRetry} label={t('today.label')} /> : null}
      </section>
    )
  }
  const today = model.today.value
  const { site } = today
  const closed = site.open
    ? null
    : t(site.nextWorkingDay ? 'today.closedNext' : 'today.closed', { reason: site.closed?.name ?? t(`closedReason.${site.closed?.reason ?? 'DAY_OFF'}`), next: site.nextWorkingDay ? formatDate(dayInstant(site.nextWorkingDay), { locale }) : '' })
  return (
    <section className="fw-shd-today" aria-label={t('today.label')}>
      <div className="fw-shd-today-head">
        {picker ?? (
          <span className="fw-sh-hint">
            {today.site.code} · {today.site.name}
          </span>
        )}
        <span className="fw-sh-hint">{t('today.counts', { due: today.tiles.dueToday, toPack: today.tiles.toPack, willMiss: today.tiles.willMiss })}</span>
      </div>
      {closed && <Banner tone="warning" title={closed} />}
      {today.carriers.length === 0 ? (
        <p className="fw-sh-hint fw-sh-cutoff-none" role="status">
          <Timer size={14} aria-hidden /> {t('today.nothing')}
        </p>
      ) : (
        <div className="fw-sh-cutoffs">
          {today.carriers.map((card) => (
            <Card key={card.key} padded className="fw-sh-cutoff" onClick={() => actions?.onCarrier?.(model.carrier === card.key ? null : card.key)} pressed={model.carrier === card.key}>
              <span className="fw-sh-cutoff-name">
                <Truck size={14} aria-hidden /> {say(cardName(card))}
              </span>
              <span className="fw-sh-cutoff-time">
                {card.cutOff ? (
                  <Countdown to={card.cutOff.at} label={(left) => t('today.left', { left, time: card.cutOff!.time })} doneLabel={t('today.passed', { time: card.cutOff.time })} />
                ) : (
                  <span className="fw-sh-muted">{card.transportBy === 'RECIPIENT' ? t('today.noCutOffCollects') : t('today.noCutOff')}</span>
                )}
              </span>
              <span className="fw-sh-cutoff-counts">
                {t('today.cardCounts', { packed: card.packed, toPack: card.toPack, parcels: card.parcels })}
                {card.cutOff ? ` · ${t(`today.source.${card.cutOff.source}`)}` : ''}
              </span>
              {(card.held > 0 || card.willMiss > 0) && (
                <span className="fw-shd-chips">
                  {card.held > 0 && <Tag tone="danger">{t('today.held', { count: card.held })}</Tag>}
                  {card.willMiss > 0 && <Tag tone="warning">{t('today.willMiss', { count: card.willMiss })}</Tag>}
                </span>
              )}
            </Card>
          ))}
        </div>
      )}
      {today.truncated && <p className="fw-sh-hint">{t('today.truncated')}</p>}
    </section>
  )
}

/** The grid of this step's views and of the search, in place of the W1 list (same toolbar: the page's search and Rows ▾). */
export function QueueGrid({ model, actions, search, tools, keys, onHelp }: { model: QueueDepthModel; actions?: QueueDepthActions; search?: ReactNode; tools?: ReactNode; keys?: readonly ListKey[]; onHelp?: () => void }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Grid model={model} actions={actions} search={search} tools={tools} keys={keys} onHelp={onHelp} />
    </WithMessages>
  )
}

function useSelection(ids: string, initial: readonly string[] | undefined) {
  const [selected, setSelected] = useState<readonly string[]>(initial ?? [])
  useEffect(() => setSelected((current) => current.filter((id) => ids.includes(id))), [ids])
  return [selected, setSelected] as const
}

function Grid(props: { model: QueueDepthModel; actions?: QueueDepthActions; search?: ReactNode; tools?: ReactNode; keys?: readonly ListKey[]; onHelp?: () => void }) {
  if (props.model.grid === 'search') return <SearchGrid {...props} />
  if (props.model.grid === 'exceptions') return <ExceptionsGrid {...props} />
  return <RowsGrid {...props} />
}

function stateOf<V>(t: T, read: { state: 'loading' } | { state: 'ready'; value: V } | { state: 'error'; problem: { key: string; params?: Record<string, string | number> } }, empty: () => ReactNode, isEmpty: (value: V) => boolean, onRetry?: () => void): ReactNode | undefined {
  if (read.state === 'error') return <EmptyState title={t('grid.failed')} description={t(read.problem.key, read.problem.params)} action={onRetry ? <Button size="sm" onClick={onRetry}>{t('common.retry')}</Button> : undefined} />
  if (read.state === 'ready' && isEmpty(read.value)) return empty()
  return undefined
}

function useRowColumns(model: QueueDepthModel, t: T, locale: ReturnType<typeof useLocale>) {
  return useMemo<ColDef<QueueRow>[]>(() => {
    const href = (row: { id: string }) => `${model.prefix}/warehouse/shipments/${row.id}`
    const NumberCell = ({ data }: ICellRendererParams<QueueRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <Link className="fw-sh-link" href={href(data)}>
            {data.number}
          </Link>
          {data.splitFromId && <span className="fw-sh-cell-sub">{t('grid.split')}</span>}
        </span>
      ) : null
    const RiskCell = ({ data }: ICellRendererParams<QueueRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <Pill tone={RISK_TONE[data.risk]}>{t(`risk.${data.risk}`)}</Pill>
          <span className="fw-sh-cell-sub">{t(`status.${data.status}`)}</span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<QueueRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <span className="fw-sh-ellipsis">{data.partyName}</span>
          <span className="fw-sh-cell-sub">
            {model.viewOrders ? (
              <Link className="fw-sh-link" href={`${model.prefix}/sales/orders/${data.salesOrderId}`}>
                {data.salesOrderNumber}
              </Link>
            ) : (
              data.salesOrderNumber
            )}
            {data.customerRef ? ` · ${t('grid.po', { po: data.customerRef })}` : ''}
          </span>
        </span>
      ) : null
    const PlaceCell = ({ data }: ICellRendererParams<QueueRow>) => (data ? <span className="fw-sh-ellipsis">{[data.shipTo.city, data.shipTo.country].filter(Boolean).join(', ') || '—'}</span> : null)
    const CarrierCell = ({ data }: ICellRendererParams<QueueRow>) => {
      if (!data) return null
      const name = cardName(data)
      return (
        <span className="fw-sh-cell">
          <span className="fw-sh-ellipsis">{t(name.key, name.params)}</span>
          {data.serviceCode && <span className="fw-sh-cell-sub">{data.serviceCode}</span>}
        </span>
      )
    }
    const ParcelsCell = ({ data }: ICellRendererParams<QueueRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <span>{t('grid.parcels', { count: data.parcels })}</span>
          <span className="fw-sh-cell-sub">{t('grid.garments', { count: data.garments })}</span>
        </span>
      ) : null
    const ShipByCell = ({ data }: ICellRendererParams<QueueRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <span>{data.shipBy ? formatDate(dayInstant(data.shipBy), { locale }) : t('grid.noPromise')}</span>
          {data.cutOff ? (
            <span className="fw-sh-cell-sub">
              <Countdown to={data.cutOff.at} label={(left) => t('today.left', { left, time: data.cutOff!.time })} doneLabel={t('today.passed', { time: data.cutOff.time })} />
            </span>
          ) : (
            <span className="fw-sh-cell-sub">{t('grid.noCutOff')}</span>
          )}
        </span>
      ) : null
    const HoldCell = ({ data }: ICellRendererParams<QueueRow>) =>
      data ? data.holdReasons.length > 0 ? <span className="fw-shd-chips">{data.holdReasons.map((reason) => <Tag key={reason} tone="danger">{t(`holdReason.${reason}`)}</Tag>)}</span> : <span className="fw-sh-muted">—</span> : null
    const MoreCell = ({ data }: ICellRendererParams<QueueRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('grid.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('grid.open'), href: href(data) },
            { id: 'tab', label: t('grid.openNewTab'), href: href(data), target: '_blank' },
            { id: 'lines', label: t('grid.cartons'), href: `${href(data)}?tab=lines` },
            { id: 'carrier', label: t('grid.carrier'), href: `${href(data)}?tab=carrier` },
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('col.number'), field: 'number', minWidth: 120, flex: 0.8, cellRenderer: NumberCell },
      { colId: 'risk', headerName: t('col.risk'), field: 'risk', minWidth: 150, flex: 0.9, cellRenderer: RiskCell },
      { colId: 'customer', headerName: t('col.customer'), field: 'partyName', minWidth: 170, flex: 1.3, cellRenderer: CustomerCell },
      { colId: 'shipTo', headerName: t('col.shipTo'), minWidth: 110, flex: 0.8, cellRenderer: PlaceCell },
      { colId: 'carrier', headerName: t('col.carrier'), minWidth: 120, flex: 0.9, cellRenderer: CarrierCell },
      { colId: 'parcels', headerName: t('col.parcels'), field: 'parcels', minWidth: 100, flex: 0.6, cellRenderer: ParcelsCell },
      { colId: 'shipBy', headerName: t('col.shipBy'), field: 'shipBy', minWidth: 160, flex: 1, cellRenderer: ShipByCell },
      { colId: 'holds', headerName: t('col.holds'), minWidth: 120, flex: 0.8, cellRenderer: HoldCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.viewOrders])
}

function holdButton(t: T, model: QueueDepthModel, actions: QueueDepthActions | undefined, picked: readonly { id: string; number: string; status: string }[]) {
  const open = picked.filter((row) => holdable(row.status)).length
  const held = !model.mayHold ? t('holds.held.noManage') : open === 0 ? t('holds.bulk.noneOpen') : null
  return (
    <Button size="sm" aria-label={t('holds.bulk.button', { count: open })} heldReason={held} onClick={() => actions?.onHold?.(picked)}>
      <Hand size={13} aria-hidden /> <SelectionLabel>{t('holds.bulk.button', { count: open })}</SelectionLabel>
    </Button>
  )
}

function RowsGrid({ model, actions, search, tools, keys, onHelp }: { model: QueueDepthModel; actions?: QueueDepthActions; search?: ReactNode; tools?: ReactNode; keys?: readonly ListKey[]; onHelp?: () => void }) {
  const { t } = useDepthWords()
  const locale = useLocale()
  const columns = useRowColumns(model, t, locale)
  const atRisk = model.grid === 'atRisk'
  const read = atRisk ? model.atRisk : model.today
  const rows = read.state !== 'ready' ? null : atRisk && model.atRisk.state === 'ready' ? model.atRisk.value.shipments : model.today.state === 'ready' ? todayRows(model.today.value, model.carrier) : null
  const [selected, setSelected] = useSelection(rows?.map((row) => row.id).join(',') ?? '', model.selected)
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const state =
    read.state === 'error'
      ? stateOf(t, read, () => null, () => false, actions?.onRetry)
      : rows && rows.length === 0
        ? atRisk
          ? <EmptyState icon={<Truck size={24} aria-hidden />} title={t('grid.atRiskNone.title')} description={t('grid.atRiskNone.body')} />
          : model.carrier
            ? <EmptyState title={t('grid.carrierNone.title')} description={t('grid.carrierNone.body')} action={<Button size="sm" onClick={() => actions?.onCarrier?.(null)}>{t('grid.clearCarrier')}</Button>} />
            : <EmptyState icon={<Truck size={24} aria-hidden />} title={t('today.nothing')} description={t('grid.todayNone.body')} />
        : undefined
  return (
    <>
      <ListFrame<QueueRow>
        label={atRisk ? t('grid.atRiskLabel') : t('grid.todayLabel')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('grid.count', { count: rows.length }) : '—'}
        search={search}
        tools={tools}
        listKey={null}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" variant="primary" aria-label={t('grid.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked)}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('grid.export', { count: picked.length })}</SelectionLabel>
              </Button>
              {holdButton(t, model, actions, picked)}
            </>
          ),
        }}
        keys={keys}
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
      />
      {atRisk && model.atRisk.state === 'ready' && <NotPlannedCard rows={model.atRisk.value.notPlanned} model={model} actions={actions} />}
    </>
  )
}

function NotPlannedCard({ rows, model, actions }: { rows: readonly NotPlanned[]; model: QueueDepthModel; actions?: QueueDepthActions }) {
  const { t } = useDepthWords()
  const locale = useLocale()
  return (
    <Card padded>
      <div className="fw-sh-card-head">
        <h2 className="fw-sh-h2">{t('notPlanned.title')}</h2>
        <span className="fw-sh-hint">{t('notPlanned.count', { count: rows.length })}</span>
      </div>
      {rows.length === 0 ? (
        <p className="fw-sh-hint">{t('notPlanned.none')}</p>
      ) : (
        <SummaryTable
          label={t('notPlanned.title')}
          columns={[t('col.order'), t('col.customer'), t('col.shipBy'), t('col.risk'), t('col.garments'), t('col.plan')]}
          rows={rows.map((row) => ({
            id: row.salesOrderId,
            cells: [
              model.viewOrders ? (
                <Link key="o" className="fw-sh-link" href={`${model.prefix}/sales/orders/${row.salesOrderId}?tab=shipments`}>
                  {row.number}
                </Link>
              ) : (
                <span key="o">{row.number}</span>
              ),
              <span key="c" className="fw-sh-cell">
                <span>{row.partyName}</span>
                {row.customerRef && <span className="fw-sh-cell-sub">{t('grid.po', { po: row.customerRef })}</span>}
              </span>,
              <span key="d">{row.shipBy ? formatDate(dayInstant(row.shipBy), { locale }) : t('grid.noPromise')}</span>,
              <Pill key="r" tone={RISK_TONE[row.risk]}>
                {t(`risk.${row.risk}`)}
              </Pill>,
              <span key="g">{row.garments}</span>,
              <Button key="p" size="sm" heldReason={model.mayManage ? null : t('notPlanned.noManage')} onClick={() => actions?.onPlan?.(row.salesOrderId)}>
                {t('notPlanned.plan')}
              </Button>,
            ],
          }))}
          density="compact"
          stackOnPhone
          align={['left', 'left', 'left', 'left', 'right', 'right']}
        />
      )}
    </Card>
  )
}

function ExceptionsGrid({ model, actions, search, tools, keys, onHelp }: { model: QueueDepthModel; actions?: QueueDepthActions; search?: ReactNode; tools?: ReactNode; keys?: readonly ListKey[]; onHelp?: () => void }) {
  const { t } = useDepthWords()
  const locale = useLocale()
  const rows = model.exceptions.state === 'ready' ? model.exceptions.value.problems : null
  const columns = useMemo<ColDef<ProblemRow>[]>(() => {
    const href = (row: ProblemRow) => `${model.prefix}/warehouse/shipments/${row.shipment.id}?tab=tracking`
    const NumberCell = ({ data }: ICellRendererParams<ProblemRow>) =>
      data ? (
        <Link className="fw-sh-link" href={href(data)}>
          {data.shipment.number}
        </Link>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<ProblemRow>) => (data ? <Pill tone={data.kind === 'ADDRESS_PROBLEM' || data.kind === 'FAILED_DELIVERY' ? 'danger' : 'warning'}>{t(`problemKind.${data.kind}`, { days: 3 })}</Pill> : null)
    const RaisedCell = ({ data }: ICellRendererParams<ProblemRow>) => (data ? <span>{formatDateTime(data.raisedAt, { locale })}</span> : null)
    const CarrierCell = ({ data }: ICellRendererParams<ProblemRow>) => (data ? <span className="fw-sh-ellipsis">{data.shipment.carrierName ?? '—'}</span> : null)
    const ExpectedCell = ({ data }: ICellRendererParams<ProblemRow>) => (data ? <span>{data.shipment.expectedDeliveryAt ? formatDate(data.shipment.expectedDeliveryAt, { locale }) : '—'}</span> : null)
    const StatusCell = ({ data }: ICellRendererParams<ProblemRow>) => (data ? <span>{t(`status.${data.shipment.status}`)}</span> : null)
    return [
      { colId: 'number', headerName: t('col.number'), minWidth: 120, flex: 0.8, cellRenderer: NumberCell },
      { colId: 'kind', headerName: t('col.problem'), minWidth: 170, flex: 1.1, cellRenderer: KindCell },
      { colId: 'raised', headerName: t('col.raised'), minWidth: 150, flex: 0.9, cellRenderer: RaisedCell },
      { colId: 'carrier', headerName: t('col.carrier'), minWidth: 120, flex: 0.8, cellRenderer: CarrierCell },
      { colId: 'expected', headerName: t('col.expected'), minWidth: 120, flex: 0.7, cellRenderer: ExpectedCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 110, flex: 0.6, cellRenderer: StatusCell },
    ]
  }, [t, locale, model.prefix])
  const state = stateOf(t, model.exceptions, () => <EmptyState title={t('grid.exceptionsNone.title')} description={t('grid.exceptionsNone.body')} />, (value) => value.problems.length === 0, actions?.onRetry)
  return (
    <ListFrame<ProblemRow>
      label={t('grid.exceptionsLabel')}
      rows={state ? [] : rows}
      rowId={(row) => row.id}
      columns={columns}
      count={rows ? t(model.exceptions.state === 'ready' && model.exceptions.value.truncated ? 'grid.countMore' : 'grid.count', { count: rows.length }) : '—'}
      search={search}
      tools={tools}
      listKey={null}
      keys={keys}
      onHelp={onHelp}
      onOpen={(row) => actions?.onOpen?.(row.shipment.id)}
      state={state}
    />
  )
}

function SearchGrid({ model, actions, search, tools, keys, onHelp }: { model: QueueDepthModel; actions?: QueueDepthActions; search?: ReactNode; tools?: ReactNode; keys?: readonly ListKey[]; onHelp?: () => void }) {
  const { t } = useDepthWords()
  const locale = useLocale()
  const read = model.search
  const rows = read?.state === 'ready' ? read.value.shipments : null
  const [selected, setSelected] = useSelection(rows?.map((row) => row.id).join(',') ?? '', model.selected)
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const columns = useMemo<ColDef<SearchRow>[]>(() => {
    const href = (row: SearchRow) => `${model.prefix}/warehouse/shipments/${row.id}`
    const NumberCell = ({ data }: ICellRendererParams<SearchRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <Link className="fw-sh-link" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-sh-cell-sub">{data.siteCode}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<SearchRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <span>{t(`status.${data.status}`)}</span>
          {data.holdReasons.length > 0 && <span className="fw-sh-cell-sub">{t('grid.heldFor', { reasons: data.holdReasons.map((reason) => t(`holdReason.${reason}`)).join(', ') })}</span>}
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<SearchRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <span className="fw-sh-ellipsis">{data.partyName}</span>
          <span className="fw-sh-cell-sub">
            {data.salesOrderNumber}
            {data.customerRef ? ` · ${t('grid.po', { po: data.customerRef })}` : ''}
          </span>
        </span>
      ) : null
    const CarrierCell = ({ data }: ICellRendererParams<SearchRow>) => {
      if (!data) return null
      const name = cardName(data)
      return (
        <span className="fw-sh-cell">
          <span className="fw-sh-ellipsis">{t(name.key, name.params)}</span>
          <span className="fw-sh-cell-sub fw-sh-mono">{data.trackingNumbers[0] ?? '—'}</span>
        </span>
      )
    }
    const MatchCell = ({ data }: ICellRendererParams<SearchRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <span className="fw-shd-chips">
            {data.matchedBy.map((match) => (
              <Tag key={match} tone="info">
                {t(`match.${match}`)}
              </Tag>
            ))}
          </span>
          {data.matchedSerials.length > 0 && <span className="fw-sh-cell-sub fw-sh-mono">{data.matchedSerials.join(', ')}</span>}
        </span>
      ) : null
    const WhenCell = ({ data }: ICellRendererParams<SearchRow>) =>
      data ? (
        <span className="fw-sh-cell-sub">
          {data.deliveredAt
            ? t('grid.deliveredAt', { date: formatDate(data.deliveredAt, { locale }) })
            : data.shippedAt
              ? t('grid.shippedAt', { date: formatDate(data.shippedAt, { locale }) })
              : data.cancelledAt
                ? t('grid.cancelledAt', { date: formatDate(data.cancelledAt, { locale }) })
                : t('grid.createdAt', { date: formatDate(data.createdAt, { locale }) })}
        </span>
      ) : null
    return [
      { colId: 'number', headerName: t('col.number'), field: 'number', minWidth: 120, flex: 0.8, cellRenderer: NumberCell },
      { colId: 'status', headerName: t('col.status'), field: 'status', minWidth: 130, flex: 0.8, cellRenderer: StatusCell },
      { colId: 'customer', headerName: t('col.customer'), field: 'partyName', minWidth: 170, flex: 1.3, cellRenderer: CustomerCell },
      { colId: 'carrier', headerName: t('col.carrierTracking'), minWidth: 150, flex: 1, cellRenderer: CarrierCell },
      { colId: 'matched', headerName: t('col.matched'), minWidth: 160, flex: 1, cellRenderer: MatchCell },
      { colId: 'when', headerName: t('col.when'), minWidth: 130, flex: 0.8, cellRenderer: WhenCell },
    ]
  }, [t, locale, model.prefix])
  const state = read ? stateOf(t, read, () => <EmptyState title={t('grid.searchNone.title')} description={t('grid.searchNone.body')} />, (value) => value.shipments.length === 0, actions?.onRetry) : undefined
  return (
    <>
      {read?.state === 'ready' && read.value.notKept.includes('SSCC') && <Banner tone="info" title={t('search.ssccNotKept')} />}
      <ListFrame<SearchRow>
        label={t('grid.searchLabel')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t(model.searchMore ? 'grid.countMore' : 'grid.count', { count: rows.length }) : '—'}
        search={search}
        tools={tools}
        listKey="warehouse.shipments.2"
        title={t('grid.searchLabel')}
        selection={{ selected, onChange: setSelected, actions: holdButton(t, model, actions, picked), exportSelected: true }}
        more={model.searchMore && rows && rows.length > 0 ? { label: t('grid.more'), onMore: () => actions?.onSearchMore?.() } : null}
        keys={keys}
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
      />
      <p className="fw-sh-hint">{t('search.note')}</p>
    </>
  )
}
