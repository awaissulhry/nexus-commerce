'use client'

import { useMemo } from 'react'
import { Plus } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { NexusGrid, SHEET_GRID_OPTIONS, type ColDef, type ICellRendererParams, type ValueSetterParams } from '@nexus/ui/grid'
import { Button } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import type { RoundView, ShipmentView } from '../../api'
import { refusalPhrase, shipmentCellHeld } from '../../model'
import { useWords } from '../../parts'
import type { SampleRecordActions, SampleRecordModel } from '../view-model'

type TextField = 'carrierName' | 'trackingNumber' | 'trackingUrl' | 'note'

/**
 * Shipments (design rec tab sample.shipments, SAL-316; autosave per cell): each shipment of the round — to whom (or a
 * return), the address, the courier, tracking number and page, when it was sent and received (each once, received after
 * sent: an outbound one sent moves the round to Sent, received to Under review), a note. A cell saves alone with its
 * version; a shipment not sent yet may be removed. No carrier booking (typed, as the API keeps it).
 */
export function ShipmentsTab({ model, round, actions }: { model: SampleRecordModel; round: RoundView; actions?: SampleRecordActions }) {
  const { t, say, locale } = useWords()
  const offline = model.live === 'offline'
  const addHeld = !model.can.manage ? t('held.noManage') : !round.actions.addShipment.allowed ? say(refusalPhrase(round.actions.addShipment.refusal?.code)) : offline ? t('held.offline') : null
  const readOnly = !model.can.manage ? t('held.noManage') : round.stage === 'CANCELLED' ? t('refusal.SHIPMENT_ROUND_CANCELLED') : offline ? t('held.offline') : null

  const columns = useMemo<ColDef<ShipmentView>[]>(() => {
    const cellState = (shipment: ShipmentView | undefined, field: string) => (shipment ? model.shipmentCells[`${shipment.id}/${field}`] : undefined)
    const text = (field: TextField, header: string, width: number): ColDef<ShipmentView> => ({
      colId: field,
      headerName: header,
      minWidth: width,
      flex: 1,
      sortable: false,
      editable: (params) => !!params.data && !shipmentCellHeld(round, params.data, field, model.can, offline),
      valueGetter: (params) => params.data?.[field] ?? '',
      valueSetter: (params: ValueSetterParams<ShipmentView>) => {
        if (!params.data) return false
        const value = String(params.newValue ?? '').trim()
        if (value === (params.data[field] ?? '')) return false
        actions?.onShipmentCell?.(params.data.id, field, value || null)
        return false
      },
      cellClassRules: {
        'fw-smp-cell-saving': (params) => cellState(params.data, field) === 'saving',
        'fw-smp-cell-failed': (params) => cellState(params.data, field) === 'failed',
      },
      tooltipValueGetter: (params) => {
        const state = cellState(params.data as ShipmentView | undefined, field)
        return state === 'failed' ? t('ship.cellFailed') : state === 'saving' ? t('common.working') : undefined
      },
    })
    const ToCell = ({ data }: ICellRendererParams<ShipmentView>) =>
      data ? (
        <span className="fw-smp-cell">
          <span>{data.direction === 'RETURN' ? t('ship.returnFrom', { name: data.party.name }) : data.party.name}</span>
          <span className="fw-smp-hint">{data.shipToAddress ? `${data.shipToAddress.line1}, ${data.shipToAddress.postalCode} ${data.shipToAddress.city} (${data.shipToAddress.country})` : data.direction === 'RETURN' ? t('ship.toUs') : t('ship.noAddress')}</span>
        </span>
      ) : null
    const mark = (field: 'sentAt' | 'receivedAt') => {
      const Cell = ({ data }: ICellRendererParams<ShipmentView>) => {
        if (!data) return null
        const value = data[field]
        if (value) return <span className="fw-smp-num">{formatDateTime(value, { locale })}</span>
        const held = say(shipmentCellHeld(round, data, field, model.can, offline))
        const state = cellState(data, field)
        return (
          <Button size="sm" variant="quiet" heldReason={state === 'saving' ? t('common.working') : held} onClick={() => actions?.onShipmentMark?.(data.id, field)}>
            {t(field === 'sentAt' ? 'ship.markSent' : 'ship.markReceived')}
          </Button>
        )
      }
      return Cell
    }
    const RemoveCell = ({ data }: ICellRendererParams<ShipmentView>) =>
      data && data.removable ? (
        <Button size="sm" variant="quiet" heldReason={!model.can.manage ? t('held.noManage') : offline ? t('held.offline') : null} onClick={() => actions?.onShipmentRemove?.(data.id)} aria-label={t('ship.removeOne', { name: data.party.name })}>
          {t('ship.remove')}
        </Button>
      ) : null
    return [
      { colId: 'to', headerName: t('ship.col.to'), minWidth: 200, flex: 1.4, sortable: false, valueGetter: (params) => params.data?.party.name ?? '', cellRenderer: ToCell },
      text('carrierName', t('ship.col.carrier'), 130),
      text('trackingNumber', t('ship.col.tracking'), 140),
      text('trackingUrl', t('ship.col.page'), 180),
      { colId: 'sentAt', headerName: t('ship.col.sent'), minWidth: 160, flex: 0.9, sortable: false, cellRenderer: mark('sentAt') },
      { colId: 'receivedAt', headerName: t('ship.col.received'), minWidth: 170, flex: 0.9, sortable: false, cellRenderer: mark('receivedAt') },
      text('note', t('ship.col.note'), 160),
      { colId: 'remove', headerName: t('ship.col.remove'), minWidth: 110, maxWidth: 120, sortable: false, cellRenderer: RemoveCell },
    ]
  }, [model.shipmentCells, model.can, round, offline, actions, t, say, locale])

  return (
    <div className="fw-smp-stack">
      <Card padded>
        <div className="fw-smp-cardhead">
          <h2 className="fw-smp-h2">{t('ship.title')}</h2>
          {round.stage !== 'CANCELLED' && (
            <Button size="sm" variant={round.shipmentsList.length === 0 ? 'primary' : 'secondary'} heldReason={addHeld} onClick={() => actions?.onDialog?.({ kind: 'shipment', direction: 'OUTBOUND', carrierName: '', trackingNumber: '', trackingUrl: '', note: '', busy: false, notice: null, lines: [] })}>
              <Plus size={14} aria-hidden /> {t('ship.add')}
            </Button>
          )}
        </div>
        {readOnly && round.shipmentsList.length > 0 && <Banner tone="info" title={t('ship.readOnly', { reason: readOnly })} />}
        {round.shipmentsList.length === 0 ? (
          <EmptyState title={t('ship.none')} description={round.party ? t('ship.noneBody', { name: round.party.name }) : t('ship.noneInternal')} />
        ) : (
          <div className="fw-smp-grid" role="region" aria-label={t('ship.title')}>
            <NexusGrid<ShipmentView> {...SHEET_GRID_OPTIONS} rowData={[...round.shipmentsList]} columnDefs={columns} getRowId={(params) => params.data.id} domLayout="autoHeight" />
          </div>
        )}
        <p className="fw-smp-hint">{t('ship.hint')}</p>
      </Card>
    </div>
  )
}
