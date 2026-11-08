'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { FileText, Layers, MoreHorizontal, Printer } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, SummaryTable } from '@nexus/ui/components'
import { LabelPreview } from '@nexus/ui/components/LabelPreview/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import type { Part } from '../../../model'
import type { CutOrderRecord, CutTicket, LayView } from '../../api'
import {
  allocateHeld,
  decimalText,
  layLength,
  layRollsText,
  layShade,
  LAY_TONE,
  liveLays,
  ORDERS_NAMESPACE,
  printHeld,
  printManyHeld,
  sheetHref,
  signed,
  TICKET_TONE,
  ticketLayout,
  usedAgainstEstimate,
  voidHeld,
} from '../../model'
import { useSay } from '../../view/parts'
import type { CutOrderRecordActions, CutOrderRecordModel } from './CutOrderRecordView'

/** A part of the record still being read, or failed with Try again. */
function PartState({ label, part, onRetry }: { label: string; part: Part<unknown>; onRetry?: () => void }) {
  const t = useT(ORDERS_NAMESPACE)
  if (part.problem) {
    return (
      <Card padded>
        <EmptyState title={t('part.failed', { part: label })} description={t(part.problem)} action={onRetry ? <Button size="sm" onClick={onRetry}>{t('common.retry')}</Button> : undefined} />
      </Card>
    )
  }
  return (
    <Card padded aria-busy="true">
      <p className="fw-ct-hint" role="status">
        <Spinner size={14} /> {t('part.loading', { part: label })}
      </p>
    </Card>
  )
}

const metres = (value: string | null, locale: string): string => (value === null ? '—' : `${decimalText(value, locale)} m`)

// ---- Lay or hides -------------------------------------------------------------------------------------------------------------

/**
 * rec:Cut/lay/ct-lays — Lays (design: "Fabric: markers with size ratios, plies per lay, number of lays, rolls by shade, width and
 * shrinkage group (MES-034, MES-037)"; columns lay · marker · sizes in the marker · plies · length · rolls; "mixing shade groups
 * in one lay is refused with the reason" — in Allocate rolls). A leather cut order: its work orders' hides (each work order's
 * cut, W2a's hides grid with the same shade lot check).
 */
export function LaysTab({ record, model, actions }: { record: CutOrderRecord; model: CutOrderRecordModel; actions?: CutOrderRecordActions }) {
  const t = useT(ORDERS_NAMESPACE)
  const say = useSay()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const order = record.cutOrder
  const lays = liveLays(record)
  const cancelled = record.lays.length - lays.length
  const marker = order.marker
  const columns = useMemo<ColDef<LayView>[]>(() => {
    const LayCell = ({ data }: ICellRendererParams<LayView>) =>
      data ? (
        <span className="fw-ct-cell">
          <span className="fw-ct-inline">
            <span>{t('lays.layOf', { seq: data.seq, of: lays.length })}</span>
            <Pill tone={LAY_TONE[data.status]}>{t(`layStatus.${data.status}`)}</Pill>
          </span>
          <span className="fw-ct-sub">{data.ticket ? t('lays.ticket', { number: data.ticket.number, status: t(`ticketStatus.${data.ticket.status}`) }) : t('lays.noTicket')}</span>
        </span>
      ) : null
    const MarkerCell = ({ data }: ICellRendererParams<LayView>) =>
      data ? (
        <span className="fw-ct-cell">
          <span className="fw-ct-ellipsis">{marker?.name ?? '—'}</span>
          <span className="fw-ct-sub">{marker?.widthCm ? t('lays.width', { width: decimalText(marker.widthCm, locale) }) : t('lays.widthUnknown')}</span>
        </span>
      ) : null
    const PliesCell = ({ data }: ICellRendererParams<LayView>) =>
      data ? (
        <span className="fw-ct-cell">
          <span className="fw-ct-num">{t('lays.plies', { count: data.plies })}</span>
          <span className="fw-ct-sub">{data.counted !== null ? t('lays.counted', { count: data.counted }) : t('lays.allocated', { allocated: data.allocated, plies: data.plies })}</span>
        </span>
      ) : null
    const RollsCell = ({ data }: ICellRendererParams<LayView>) =>
      data ? (
        data.rolls.length === 0 ? (
          <span className="fw-ct-hint">{t('lays.noRolls')}</span>
        ) : (
          <span className="fw-ct-cell" title={layRollsText(data)}>
            <span className="fw-ct-ellipsis">{layRollsText(data)}</span>
            <span className="fw-ct-sub">{t('lays.groups', { shade: layShade(data) ?? '—', shrinkage: data.shrinkageGroup ?? '—' })}</span>
          </span>
        )
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<LayView>) => {
      if (!data) return null
      const held = say(allocateHeld(record, data, model.can))
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('lays.rowMenu', { seq: data.seq }) }}
          items={[
            { id: 'rolls', label: t('lays.allocate'), disabled: !!held && data.rolls.length === 0, description: held ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'rolls', layId: data.id }) },
            { id: 'sheet', label: t('lays.sheet'), href: sheetHref(model.prefix, order.id, data.id), target: '_blank' as const },
          ]}
        />
      )
    }
    return [
      { colId: 'lay', headerName: t('lays.col.lay'), minWidth: 170, flex: 1.1, cellRenderer: LayCell, valueGetter: (params) => params.data?.seq ?? 0 },
      { colId: 'marker', headerName: t('lays.col.marker'), minWidth: 140, flex: 1, cellRenderer: MarkerCell },
      { colId: 'sizes', headerName: t('lays.col.sizes'), minWidth: 130, flex: 1, valueGetter: () => marker?.ratio || '—' },
      { colId: 'plies', headerName: t('lays.col.plies'), minWidth: 120, flex: 0.8, cellRenderer: PliesCell },
      { colId: 'length', headerName: t('lays.col.length'), minWidth: 90, flex: 0.6, type: 'rightAligned', valueGetter: (params) => (params.data ? metres(layLength(params.data, marker), locale) : '') },
      { colId: 'rolls', headerName: t('lays.col.rolls'), minWidth: 180, flex: 1.4, cellRenderer: RollsCell },
      { colId: 'more', headerName: t('lays.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, say, locale, marker, lays.length, record, model.can, model.prefix, order.id, actions])

  if (order.kind === 'LEATHER') {
    const workOrders = [...new Map(record.lines.map((line) => [line.workOrder.id, line.workOrder])).values()]
    return (
      <Card padded className="fw-ct-card">
        <h2 className="fw-ct-h2">{t('hides.title')}</h2>
        <p className="fw-ct-hint">{t('hides.body')}</p>
        <ul className="fw-ct-list">
          {workOrders.map((workOrder) => (
            <li key={workOrder.id}>
              {model.can.workOrders ? (
                <Link className="fw-ct-link" href={`${model.prefix}/production/cutting/${workOrder.id}`}>
                  {t('hides.ofWorkOrder', { number: workOrder.number })}
                </Link>
              ) : (
                <span>{t('hides.ofWorkOrder', { number: workOrder.number })}</span>
              )}
              <span className="fw-ct-hint">{t('hides.garments', { count: record.lines.filter((line) => line.workOrder.id === workOrder.id).reduce((sum, line) => sum + line.quantity, 0) })}</span>
            </li>
          ))}
        </ul>
        {!model.can.workOrders && <p className="fw-ct-hint">{t('noAccess.body', { permission: 'workorders.view' })}</p>}
      </Card>
    )
  }

  return (
    <>
      <Card padded className="fw-ct-card">
        <h2 className="fw-ct-h2">{t('marker.title')}</h2>
        {marker ? (
          <KeyValue
            columns={3}
            items={[
              { label: t('marker.name'), value: marker.name },
              { label: t('marker.length'), value: marker.length ? `${decimalText(marker.length, locale, 4)} ${(marker.uom ?? 'M').toLowerCase()}` : '—' },
              { label: t('marker.width'), value: marker.widthCm ? `${decimalText(marker.widthCm, locale)} cm` : '—' },
              { label: t('marker.sizes'), value: marker.ratio || '—' },
              { label: t('marker.perPly'), value: t('marker.garments', { count: marker.garmentsPerPly }) },
              { label: t('marker.plies'), value: t('lays.plies', { count: order.plies ?? 0 }) },
            ]}
          />
        ) : (
          <p className="fw-ct-hint">{t('marker.none')}</p>
        )}
        <p className="fw-ct-hint">{t('marker.cad')}</p>
      </Card>
      <section className="fw-ct-card" aria-label={t('lays.title')}>
        <div className="fw-ct-card-head">
          <h2 className="fw-ct-h2">{t('lays.title')}</h2>
          <Button size="sm" asChild>
            <a href={sheetHref(model.prefix, order.id)} target="_blank" rel="noopener noreferrer">
              <FileText size={13} aria-hidden /> {t('record.sheet')}
            </a>
          </Button>
        </div>
        <ListFrame<LayView>
          label={t('lays.title')}
          rows={lays}
          rowId={(lay) => lay.id}
          columns={columns}
          count={t('lays.count', { count: lays.length })}
          listKey={null}
          onOpen={(lay) => actions?.onDialog?.({ kind: 'rolls', layId: lay.id })}
          state={lays.length === 0 ? <EmptyState title={t('lays.empty.title')} description={t('lays.empty.body')} /> : undefined}
        />
        <p className="fw-ct-hint">{t('lays.hint')}</p>
        {cancelled > 0 && <p className="fw-ct-hint">{t('lays.cancelled', { count: cancelled })}</p>}
        {lays.some((lay) => lay.status === 'PLANNED') && (order.status === 'RELEASED' || order.status === 'IN_PROGRESS') && (
          <p className="fw-ct-hint">
            <Layers size={12} aria-hidden /> {t('lays.allocateHint')}
          </p>
        )}
      </section>
      <section className="fw-ct-card" aria-label={t('lines.title')}>
        <h2 className="fw-ct-h2">{t('lines.title')}</h2>
        <SummaryTable
          label={t('lines.title')}
          stackOnPhone
          columns={[t('lines.col.workOrder'), t('lines.col.style'), t('lines.col.cell'), t('lines.col.ratio'), t('lines.col.garments')]}
          align={['left', 'left', 'left', 'right', 'right']}
          rows={record.lines.map((line) => ({
            id: line.id,
            cells: [
              line.workOrder.number,
              line.style.code,
              `${line.colourway.code} ${line.size}`,
              line.ratio === null ? '—' : String(line.ratio),
              t('lines.garmentsOf', { garments: line.quantity, cell: line.cellQuantity }),
            ],
          }))}
        />
        <p className="fw-ct-hint">{t('lines.hint', { when: order.releasedAt ? formatDateTime(order.releasedAt, place) : t('lines.notReleased') })}</p>
      </section>
    </>
  )
}

// ---- Pieces ----------------------------------------------------------------------------------------------------------------------

/** Ordered, cut and recut per line and per size (the cut against the order, MES-045). */
export function PiecesTab({ record, model, actions }: { record: CutOrderRecord; model: CutOrderRecordModel; actions?: CutOrderRecordActions }) {
  const t = useT(ORDERS_NAMESPACE)
  const recon = model.recon.value
  if (!recon) return <PartState label={t('tab.pieces')} part={model.recon} onRetry={() => actions?.onRetryPart?.('recon')} />
  return (
    <>
      <Card padded className="fw-ct-card">
        <div className="fw-ct-card-head">
          <h2 className="fw-ct-h2">{t('pieces.bySize')}</h2>
          <span className="fw-ct-hint">{t('pieces.sum', { ordered: recon.garments.ordered, cut: recon.garments.cut, difference: signed(recon.garments.cut - recon.garments.ordered) })}</span>
        </div>
        <SummaryTable
          label={t('pieces.bySize')}
          stackOnPhone
          columns={[t('pieces.col.size'), t('pieces.col.ordered'), t('pieces.col.cut'), t('pieces.col.recut'), t('pieces.col.difference')]}
          align={['left', 'right', 'right', 'right', 'right']}
          rows={recon.sizes.map((size) => ({ id: size.size, cells: [size.size, String(size.ordered), String(size.cut), String(size.recut), signed(size.difference)] }))}
        />
      </Card>
      <Card padded className="fw-ct-card">
        <h2 className="fw-ct-h2">{t('pieces.byLine')}</h2>
        <SummaryTable
          label={t('pieces.byLine')}
          stackOnPhone
          columns={[t('lines.col.workOrder'), t('lines.col.cell'), t('pieces.col.ordered'), t('pieces.col.cut'), t('pieces.col.recut'), t('pieces.col.difference'), t('pieces.col.reason')]}
          align={['left', 'left', 'right', 'right', 'right', 'right', 'left']}
          rows={recon.lines.map((line) => ({
            id: line.id,
            cells: [
              line.workOrder.number,
              `${line.colourway.code} ${line.size}`,
              String(line.ordered),
              String(line.cut),
              String(line.recut),
              signed(line.difference),
              line.reconciled ? (line.reconciled.varianceReasonCode ? t(`reason.${line.reconciled.varianceReasonCode}`) : t('pieces.asOrdered')) : line.needsReason ? t('pieces.toExplain') : '—',
            ],
          }))}
        />
        <p className="fw-ct-hint">{record.cutOrder.kind === 'FABRIC' ? t('pieces.hintFabric') : t('pieces.hintLeather')}</p>
      </Card>
    </>
  )
}

// ---- Yield ------------------------------------------------------------------------------------------------------------------------

/**
 * rec:Cut/yield/ct-yield#1 — the W2b reconciliation of issued vs used vs returned (MES-045): a fabric cut order's metres per CUT
 * lay and summed (the estimate, the lay report, used as confirmed, issued to the work orders, end loss, ends returned to the
 * roll). Leather: each work order's yield per hide and per supplier lot is on its cut. Never by cutter.
 */
export function YieldTab({ record, model, actions }: { record: CutOrderRecord; model: CutOrderRecordModel; actions?: CutOrderRecordActions }) {
  const t = useT(ORDERS_NAMESPACE)
  const say = useSay()
  const locale = useLocale()
  const order = record.cutOrder
  if (order.kind === 'LEATHER') {
    const workOrders = [...new Map(record.lines.map((line) => [line.workOrder.id, line.workOrder])).values()]
    return (
      <Card padded className="fw-ct-card">
        <h2 className="fw-ct-h2">{t('yield.title')}</h2>
        <p className="fw-ct-hint">{t('yield.leather')}</p>
        <ul className="fw-ct-list">
          {workOrders.map((workOrder) => (
            <li key={workOrder.id}>{model.can.workOrders ? <Link className="fw-ct-link" href={`${model.prefix}/production/cutting/${workOrder.id}?tab=yield`}>{t('yield.ofWorkOrder', { number: workOrder.number })}</Link> : <span>{t('yield.ofWorkOrder', { number: workOrder.number })}</span>}</li>
          ))}
        </ul>
      </Card>
    )
  }
  const recon = model.recon.value
  if (!recon) return <PartState label={t('tab.yield')} part={model.recon} onRetry={() => actions?.onRetryPart?.('recon')} />
  const material = recon.material
  if (!material || material.lays.length === 0) {
    return (
      <Card padded className="fw-ct-card">
        <h2 className="fw-ct-h2">{t('yield.title')}</h2>
        <EmptyState title={t('yield.none.title')} description={t('yield.none.body')} />
      </Card>
    )
  }
  const sum = material.sum
  const against = usedAgainstEstimate(sum, locale)
  const unconfirmed = material.lays.filter((lay) => !lay.confirmed).map((lay) => lay.seq)
  return (
    <>
      <Card padded className="fw-ct-card">
        <div className="fw-ct-card-head">
          <h2 className="fw-ct-h2">{t('yield.balance')}</h2>
          {against && <Tag tone={Number(sum.used) > Number(sum.estimated) ? 'warning' : 'success'}>{say(against)}</Tag>}
        </div>
        <KeyValue
          columns={3}
          items={[
            { label: t('material.issued'), value: metres(sum.issued, locale) },
            { label: t('material.used'), value: metres(sum.used, locale) },
            { label: t('material.returned'), value: metres(sum.endsReturned, locale) },
            { label: t('material.estimated'), value: metres(sum.estimated, locale) },
            { label: t('material.recorded'), value: metres(sum.recorded, locale) },
            { label: t('material.endLoss'), value: metres(sum.endLoss, locale) },
          ]}
        />
        {unconfirmed.length > 0 && <Banner tone="info" title={t('material.unconfirmed', { lays: unconfirmed.join(', '), count: unconfirmed.length })} />}
        <p className="fw-ct-hint">{t('material.hint')}</p>
      </Card>
      <Card padded className="fw-ct-card">
        <h2 className="fw-ct-h2">{t('yield.perLay')}</h2>
        <SummaryTable
          label={t('yield.perLay')}
          stackOnPhone
          columns={[t('material.col.lay'), t('material.col.plies'), t('material.estimated'), t('material.recorded'), t('material.used'), t('material.issued'), t('material.endLoss'), t('material.returned')]}
          align={['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right']}
          rows={[
            ...material.lays.map((lay) => ({
              id: lay.layId,
              cells: [t('material.lay', { seq: lay.seq }), String(lay.plies), metres(lay.estimated, locale), metres(lay.recorded, locale), lay.used === null ? t('material.notConfirmed') : metres(lay.used, locale), metres(lay.issued, locale), metres(lay.endLoss, locale), metres(lay.endsReturned, locale)],
            })),
            { id: 'sum', cells: [t('material.sum'), String(material.lays.reduce((total, lay) => total + lay.plies, 0)), metres(sum.estimated, locale), metres(sum.recorded, locale), metres(sum.used, locale), metres(sum.issued, locale), metres(sum.endLoss, locale), metres(sum.endsReturned, locale)] },
          ]}
        />
        <p className="fw-ct-hint">{t('yield.never')}</p>
      </Card>
    </>
  )
}

// ---- Tickets -----------------------------------------------------------------------------------------------------------------------

/** The cut tickets (one per lay; leather: one): their state, printed, started and done; Print (or show the label) and Void. */
export function TicketsTab({ record, model, actions }: { record: CutOrderRecord; model: CutOrderRecordModel; actions?: CutOrderRecordActions }) {
  const t = useT(ORDERS_NAMESPACE)
  const say = useSay()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [selected, setSelected] = useState<readonly string[]>(model.ticketsSelected ?? [])
  const tickets = record.tickets
  const picked = tickets.filter((ticket) => selected.includes(ticket.id))
  const columns = useMemo<ColDef<CutTicket>[]>(() => {
    const at = (value: string | null) => (value ? formatDateTime(value, place) : '—')
    const NumberCell = ({ data }: ICellRendererParams<CutTicket>) =>
      data ? (
        <span className="fw-ct-cell">
          <span className="fw-ct-code">{data.number}</span>
          <span className="fw-ct-sub">{data.laySeq !== null ? t('tickets.lay', { seq: data.laySeq }) : t('tickets.leather')}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<CutTicket>) =>
      data ? (
        <span className="fw-ct-cell">
          <span>
            <Pill tone={TICKET_TONE[data.status]}>{t(`ticketStatus.${data.status}`)}</Pill>
          </span>
          {data.status === 'VOID' && data.voidReason ? <span className="fw-ct-sub" title={data.voidReason}>{data.voidReason}</span> : <span className="fw-ct-sub">{data.printedAt ? t('tickets.printedAt', { at: at(data.printedAt) }) : t('tickets.notPrinted')}</span>}
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<CutTicket>) => {
      if (!data) return null
      const print = say(printHeld(data, model.can, model.busy))
      const voided = say(voidHeld(data, model.can, model.busy))
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('tickets.rowMenu', { number: data.number }) }}
          items={[
            { id: 'print', label: t('tickets.print'), disabled: !!print, description: print ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'print', ticketIds: [data.id] }) },
            { id: 'sheet', label: t('lays.sheet'), href: sheetHref(model.prefix, record.cutOrder.id, data.layId), target: '_blank' as const },
            { id: 'void', label: t('tickets.void'), tone: 'danger' as const, disabled: !!voided, description: voided ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'void', ticketId: data.id }) },
          ]}
        />
      )
    }
    return [
      { colId: 'number', headerName: t('tickets.col.number'), minWidth: 160, flex: 1.1, cellRenderer: NumberCell, valueGetter: (params) => params.data?.number ?? '' },
      { colId: 'status', headerName: t('tickets.col.status'), minWidth: 170, flex: 1.2, cellRenderer: StatusCell },
      { colId: 'started', headerName: t('tickets.col.started'), minWidth: 130, flex: 0.9, valueGetter: (params) => (params.data ? at(params.data.startedAt) : '') },
      { colId: 'done', headerName: t('tickets.col.done'), minWidth: 130, flex: 0.9, valueGetter: (params) => (params.data ? at(params.data.doneAt) : '') },
      { colId: 'more', headerName: t('lays.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, say, place.locale, place.timeZone, model.can, model.busy, model.prefix, record.cutOrder.id, actions])
  const shown = model.shown
  return (
    <>
      <section className="fw-ct-card" aria-label={t('tickets.title')}>
        <div className="fw-ct-card-head">
          <h2 className="fw-ct-h2">{t('tickets.title')}</h2>
          <Button size="sm" asChild>
            <a href={sheetHref(model.prefix, record.cutOrder.id)} target="_blank" rel="noopener noreferrer">
              <FileText size={13} aria-hidden /> {t('record.sheet')}
            </a>
          </Button>
        </div>
        <ListFrame<CutTicket>
          label={t('tickets.title')}
          rows={tickets}
          rowId={(ticket) => ticket.id}
          columns={columns}
          count={t('tickets.count', { count: tickets.length })}
          listKey={null}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <Button size="sm" heldReason={say(printManyHeld(picked, model.can, model.busy))} onClick={() => actions?.onDialog?.({ kind: 'print', ticketIds: picked.map((ticket) => ticket.id) })}>
                <Printer size={13} aria-hidden /> <SelectionLabel>{t('tickets.printMany', { count: picked.length })}</SelectionLabel>
              </Button>
            ),
          }}
          state={tickets.length === 0 ? <EmptyState title={t('tickets.empty.title')} description={record.cutOrder.status === 'PLANNED' ? t('tickets.empty.planned') : t('tickets.empty.body')} /> : undefined}
        />
        <p className="fw-ct-hint">{t('tickets.hint')}</p>
      </section>
      {shown && (
        <Card padded className="fw-ct-card">
          <div className="fw-ct-card-head">
            <h2 className="fw-ct-h2">{t('tickets.shown', { number: shown.ticket.number })}</h2>
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissShown?.()}>
              {t('common.dismiss')}
            </Button>
          </div>
          <LabelPreview
            layout={ticketLayout(shown.label, shown.ticket.code)}
            codeLabel={(value) => t('tickets.code', { code: value })}
          />
        </Card>
      )}
    </>
  )
}
