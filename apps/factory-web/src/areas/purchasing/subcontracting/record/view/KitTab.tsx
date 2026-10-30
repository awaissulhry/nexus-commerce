'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ListPlus, MoreHorizontal, PackageOpen, Plus, Send, Trash2, Undo2 } from 'lucide-react'
import { Card, EmptyState, Menu, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, quantity } from '../../../../_shared/buying/model'
import type { KitLine, SubcontractOrder } from '../../api'
import { actHeld, say } from '../../model'
import type { SubcontractRecordActions, SubcontractRecordModel } from '../record-model'

const LINE_TONE = { PLANNED: 'warning', SENT: 'success', CANCELLED: 'neutral' } as const
/** Kit lines may be planned or added while the order may still send (the API's KIT_OPEN). */
const KIT_OPEN = new Set(['DRAFT', 'ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'])

/**
 * Kit sent (design rec kit "Kit"): our components with their lots (and hides), what went out and when, and the DDT for
 * work on our behalf (conto lavorazione) each line travelled with — a real link that opens its PDF. While the order
 * may still send, a buyer adds lines (typed, or planned from the work order's materials) and removes planned ones
 * (select-all, shift range, x; only planned lines may be selected, the others say why); the warehouse sends the kit
 * (the office dialog: the floor's Subcontract kits screen SCR-181 comes with B-W2a-76) and takes back a line that never
 * left (its DDT annulled first). Under the lines, the order's kit DDTs, live and annulled.
 */
export function KitTab({ order, model, actions }: { order: SubcontractOrder; model: SubcontractRecordModel; actions?: SubcontractRecordActions }) {
  const t = useT('subcontract-order')
  const sc = useT('subcontracting')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const editable = model.can.manage && KIT_OPEN.has(order.status)
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rowsKey = order.kitLines.map((line) => line.id).join(',')
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const sendHeld = model.busy ? t('held.busy') : (() => {
    const words = actHeld(order, 'send', model.can)
    return words ? say(sc, words) : null
  })()
  const lots = model.can.stock

  const columns = useMemo<ColDef<KitLine>[]>(() => {
    const ComponentCell = ({ data }: ICellRendererParams<KitLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-ellipsis">
            <span className="fw-by-code">{data.item.code}</span> {data.item.name}
          </span>
          <span className="fw-by-cell-sub">{data.colour ? `${data.colour.code} · ${data.colour.name}` : t('kit.noColour')}</span>
        </span>
      ) : null
    const QuantityCell = ({ data }: ICellRendererParams<KitLine>) => (data ? <span className="fw-by-num">{`${quantity(data.quantity, locale, 4)} ${t(`uom.${data.uom}`)}`}</span> : null)
    const LotCell = ({ data }: ICellRendererParams<KitLine>) => {
      if (!data) return null
      if (!data.lot) return <span className="fw-by-hint">{data.item.tracking === 'NONE' ? t('kit.untracked') : t('kit.lotAtSend')}</span>
      return (
        <span className="fw-by-cell">
          {lots ? (
            <Link className="fw-by-link" href={`${model.prefix}/warehouse/lots/${data.lot.id}`}>
              {data.lot.code}
            </Link>
          ) : (
            <span>{data.lot.code}</span>
          )}
          <span className="fw-by-cell-sub">{data.hide ? t('kit.hide', { code: data.hide.code }) : t(`lot.${data.lot.qualityStatus}`)}</span>
        </span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<KitLine>) => (data ? <Pill tone={LINE_TONE[data.status]}>{t(`kitLine.status.${data.status}`)}</Pill> : null)
    const SentCell = ({ data }: ICellRendererParams<KitLine>) => (data ? <span>{data.sentAt ? formatDateTime(data.sentAt, place) : '—'}</span> : null)
    const DdtCell = ({ data }: ICellRendererParams<KitLine>) => {
      if (!data?.ddt) return data ? <span className="fw-by-hint">{data.status === 'SENT' ? t('kit.noDdt') : '—'}</span> : null
      const ddt = data.ddt
      return (
        <span className="fw-by-inline">
          {model.can.files ? (
            <Button size="sm" variant="link" onClick={() => actions?.onOpenDdt?.(ddt.id)}>
              {t('kit.ddt', { number: ddt.number })}
            </Button>
          ) : (
            <span>{t('kit.ddt', { number: ddt.number })}</span>
          )}
          {ddt.cancelled && <Tag tone="neutral">{t('docs.annulled')}</Tag>}
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<KitLine>) => {
      if (!data) return null
      const items =
        data.status === 'PLANNED' && editable
          ? [{ id: 'remove', label: t('kit.remove'), icon: <Trash2 size={14} aria-hidden />, tone: 'danger' as const, onSelect: () => actions?.onDialog?.({ kind: 'removeKit', lineIds: [data.id] }) }]
          : data.status === 'SENT'
            ? [
                model.can.kit
                  ? { id: 'return', label: t('kit.takeBack'), icon: <Undo2 size={14} aria-hidden />, onSelect: () => actions?.onDialog?.({ kind: 'returnLine', lineId: data.id, reason: '' }) }
                  : { id: 'return', label: t('kit.takeBack'), disabled: true, description: sc('held.permission', { permission: 'purchasing.subcontract.kit' }) },
              ]
            : []
      return items.length > 0 ? <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('kit.rowMenu', { seq: data.seq }) }} items={items} /> : null
    }
    return [
      { colId: 'seq', headerName: t('kit.col.seq'), field: 'seq', minWidth: 58, maxWidth: 70, type: 'rightAligned' },
      { colId: 'component', headerName: t('kit.col.component'), minWidth: 220, flex: 1.8, cellRenderer: ComponentCell },
      { colId: 'quantity', headerName: t('kit.col.quantity'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: QuantityCell },
      { colId: 'lot', headerName: t('kit.col.lot'), minWidth: 150, flex: 1, cellRenderer: LotCell },
      { colId: 'status', headerName: t('kit.col.status'), minWidth: 110, flex: 0.7, cellRenderer: StatusCell },
      { colId: 'sent', headerName: t('kit.col.sent'), minWidth: 150, flex: 0.9, cellRenderer: SentCell },
      { colId: 'ddt', headerName: t('kit.col.ddt'), minWidth: 140, flex: 0.9, cellRenderer: DdtCell },
      { colId: 'more', headerName: t('kit.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells call the page's actions, whose handlers keep their own state: not a reason to rebuild the columns.
  }, [t, sc, locale, model.prefix, model.can.files, model.can.kit, lots, editable, place.timeZone])

  const live = order.kitLines.filter((line) => line.status !== 'CANCELLED')
  const right = (
    <span className="fw-by-actions">
      {editable && (
        <>
          <Button size="sm" variant="quiet" onClick={() => actions?.onPlanKit?.()} heldReason={model.busy ? t('held.busy') : null}>
            <ListPlus size={14} aria-hidden /> {t('kit.plan')}
          </Button>
          <Button size="sm" variant="quiet" onClick={() => actions?.onOpenKitLine?.()} heldReason={model.busy ? t('held.busy') : null}>
            <Plus size={14} aria-hidden /> {t('kit.add')}
          </Button>
        </>
      )}
      {order.status !== 'CLOSED' && order.status !== 'CANCELLED' && order.status !== 'RECEIVED' && (
        <Button size="sm" variant="primary" heldReason={sendHeld} onClick={() => actions?.onOpenSend?.()}>
          <Send size={14} aria-hidden /> {t('band.act.send')}
        </Button>
      )}
    </span>
  )

  return (
    <div className="fw-by-stack">
      <ListFrame<KitLine>
        label={t('kit.tableLabel')}
        listKey={null}
        rows={order.kitLines}
        rowId={(line) => line.id}
        columns={columns}
        count={t('kit.count', { count: live.length })}
        right={right}
        selection={
          editable
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <Button size="sm" tone="danger" aria-label={t('kit.removeN', { count: selected.length })} onClick={() => actions?.onDialog?.({ kind: 'removeKit', lineIds: [...selected] })}>
                    <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('kit.removeN', { count: selected.length })}</SelectionLabel>
                  </Button>
                ),
              }
            : undefined
        }
        isRowSelectable={(line) => (line.status === 'PLANNED' ? null : t(line.status === 'SENT' ? 'kit.notSelectableSent' : 'kit.notSelectableCancelled'))}
        state={
          order.kitLines.length === 0 ? (
            <EmptyState
              icon={<PackageOpen size={22} aria-hidden />}
              title={t('kit.empty.title')}
              description={editable ? t('kit.empty.bodyEdit') : t('kit.empty.body')}
              action={
                order.status !== 'DRAFT' && order.status !== 'CLOSED' && order.status !== 'CANCELLED' && order.status !== 'RECEIVED' ? (
                  <Button size="sm" variant="primary" heldReason={sendHeld} onClick={() => actions?.onOpenSend?.()}>
                    {t('band.act.send')}
                  </Button>
                ) : undefined
              }
            />
          ) : undefined
        }
      />
      <p className="fw-by-hint">{t('kit.floorLater')}</p>
      <Card padded>
        <div className="fw-by-stack">
          <h3 className="fw-by-h3">{t('kit.ddts.title')}</h3>
          {order.ddts.length === 0 ? (
            <p className="fw-by-hint">{t('kit.ddts.none')}</p>
          ) : (
            <SummaryTable
              label={t('kit.ddts.title')}
              columns={[t('kit.ddts.col.number'), t('kit.ddts.col.date'), t('kit.ddts.col.lines'), t('kit.ddts.col.state'), t('kit.ddts.col.open')]}
              align={['left', 'left', 'right', 'left', 'right']}
              density="roomy"
              stackOnPhone
              rows={order.ddts.map((ddt) => ({
                id: ddt.id,
                cells: [
                  <span key="n" className="fw-by-code">
                    {ddt.number}
                  </span>,
                  formatDate(dayAt(ddt.documentDate), place),
                  String(ddt.kitLineIds.length),
                  <Pill key="s" tone={ddt.cancelled ? 'neutral' : 'success'}>
                    {t(ddt.cancelled ? 'docs.annulled' : 'docs.live')}
                  </Pill>,
                  <Button key="o" size="sm" variant="quiet" heldReason={model.can.files ? null : t('docs.noFiles')} onClick={() => actions?.onOpenDdt?.(ddt.id)}>
                    {t('docs.openPdf')}
                  </Button>,
                ],
              }))}
            />
          )}
        </div>
      </Card>
    </div>
  )
}
