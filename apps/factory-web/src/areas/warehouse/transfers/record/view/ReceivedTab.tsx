'use client'

import { useMemo, useRef, useState } from 'react'
import { PackageCheck, Scale } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { Qty } from '../../../../_shared/stock/parts'
import { actionHeld, receiveDraftOf, type LineView, type TransferView } from '../../model'
import { LineStatePill, useWords } from '../../parts'
import type { TransferRecordActions, TransferRecordModel } from '../view-model'

/**
 * Transfer › Received (design warehouse.transfers/rec:Transfer/received, tr-recv "Received at destination"): per line what
 * was sent, what arrived, the difference, its reason (the Discrepancy list's words) and how it was resolved (written off at
 * the transit place, claimed from the carrier, sent back), on the shared list frame; "Receive…" (r) opens the Receive
 * dialog, "Settle…" a short line's difference (only the receiving site's people: held with the reason otherwise).
 */
export function ReceivedTab({ transfer, model, actions }: { transfer: TransferView; model: TransferRecordModel; actions?: TransferRecordActions }) {
  const { t, say, locale } = useWords()
  const offline = model.live === 'offline'
  const [selected, setSelected] = useState<readonly string[]>([])
  const latest = useRef(actions)
  latest.current = actions
  const reasonWords = useMemo(() => new Map(transfer.reasons.map((reason) => [reason.code, locale === 'it' ? reason.labelIt : reason.labelEn])), [transfer.reasons, locale])
  const settleHeld = say(actionHeld(transfer.actions.settle, offline))
  const receiveHeld = say(actionHeld(transfer.actions.receive, offline))

  const columns = useMemo<ColDef<LineView>[]>(() => {
    const Line = ({ data }: ICellRendererParams<LineView>) =>
      data ? (
        <span className="fw-trf-cell">
          <span className="fw-trf-code">
            {data.seq} · {data.item.code}
          </span>
          <span className="fw-trf-hint">{[data.colour?.name, data.lot ? t('received.lot', { code: data.lot.code }) : null, data.hide ? t('received.hide', { code: data.hide.code }) : null].filter(Boolean).join(' · ') || data.item.name}</span>
        </span>
      ) : null
    const Sent = ({ data }: ICellRendererParams<LineView>) => (data ? data.shippedQuantity === null ? <span className="fw-trf-hint">—</span> : <Qty value={data.shippedQuantity} uom={data.uom} decimals={4} /> : null)
    const Received = ({ data }: ICellRendererParams<LineView>) => (data ? <Qty value={data.receivedQuantity} uom={data.uom} decimals={4} /> : null)
    const Difference = ({ data }: ICellRendererParams<LineView>) => (data ? data.difference === '0' ? <span className="fw-trf-hint">—</span> : <Tag tone={data.state === 'SETTLED' ? 'neutral' : 'danger'}><Qty value={data.difference} uom={data.uom} decimals={4} /></Tag> : null)
    const Arrived = ({ data }: ICellRendererParams<LineView>) =>
      data ? (
        data.toLot || data.toHide || data.toLocation ? (
          <span className="fw-trf-cell">
            <span>{data.toLocation?.code ?? '—'}</span>
            <span className="fw-trf-hint">{data.toHide ? t('received.hide', { code: data.toHide.code }) : data.toLot ? t('received.lot', { code: data.toLot.code }) : ''}</span>
          </span>
        ) : (
          <span className="fw-trf-hint">—</span>
        )
      ) : null
    const State = ({ data }: ICellRendererParams<LineView>) => (data ? <LineStatePill state={data.state} /> : null)
    const Resolve = ({ data }: ICellRendererParams<LineView>) =>
      data && data.state === 'SHORT' ? (
        <Button size="sm" variant="quiet" heldReason={settleHeld} onClick={() => latest.current?.onDialog?.({ kind: 'settle', draft: { lineId: data.id, resolution: null, note: '' }, busy: false, notice: null })}>
          <Scale size={13} aria-hidden /> {t('received.settle')}
        </Button>
      ) : null
    return [
      { colId: 'line', headerName: t('col.line'), minWidth: 200, flex: 1, valueGetter: (params) => (params.data ? `${params.data.seq} ${params.data.item.code}` : ''), cellRenderer: Line },
      { colId: 'sent', headerName: t('col.sent'), minWidth: 120, flex: 0.5, valueGetter: (params) => params.data?.shippedQuantity ?? '', cellRenderer: Sent },
      { colId: 'received', headerName: t('col.received'), minWidth: 120, flex: 0.5, valueGetter: (params) => params.data?.receivedQuantity ?? '', cellRenderer: Received },
      { colId: 'difference', headerName: t('col.difference'), minWidth: 120, flex: 0.5, valueGetter: (params) => params.data?.difference ?? '', cellRenderer: Difference },
      { colId: 'reason', headerName: t('col.reason'), minWidth: 140, flex: 0.6, valueGetter: (params) => (params.data?.differenceReasonCode ? (reasonWords.get(params.data.differenceReasonCode) ?? params.data.differenceReasonCode) : '—') },
      { colId: 'resolvedBy', headerName: t('col.resolvedBy'), minWidth: 160, flex: 0.6, valueGetter: (params) => (params.data?.differenceResolution ? t(`resolution.${params.data.differenceResolution}`) : '—') },
      { colId: 'arrived', headerName: t('col.arrived'), minWidth: 140, flex: 0.6, valueGetter: (params) => params.data?.toLocation?.code ?? '', cellRenderer: Arrived },
      { colId: 'state', headerName: t('col.state'), minWidth: 120, flex: 0.5, valueGetter: (params) => (params.data ? t(`state.${params.data.state}`) : ''), cellRenderer: State },
      { colId: 'resolve', headerName: t('col.resolve'), minWidth: 120, flex: 0.5, sortable: false, suppressHeaderMenuButton: true, cellRenderer: Resolve },
    ]
  }, [t, reasonWords, settleHeld])

  const shipped = transfer.status !== 'DRAFT' && transfer.status !== 'CANCELLED'
  const keys: ListKey[] = [{ keys: ['r'], does: t('keys.receive') }]
  const receiveButton = (
    <Button size="sm" variant="primary" heldReason={model.busy ? t('common.working') : receiveHeld} onClick={() => actions?.onDialog?.({ kind: 'receive', draft: receiveDraftOf(transfer), scan: '', scanNote: null, busy: false, notice: null, lines: [] })} aria-keyshortcuts="r">
      <PackageCheck size={14} aria-hidden /> {t('received.receive')}
    </Button>
  )
  const state = !shipped ? <EmptyState title={t('received.notShipped')} description={transfer.status === 'CANCELLED' ? t('transit.cancelled') : t('received.notShippedBody')} /> : undefined
  const settleable = selected.filter((id) => transfer.lines.find((line) => line.id === id)?.state === 'SHORT')

  return (
    <section className="fw-trf-section" aria-label={t('tab.received')}>
      {transfer.totals.openDifferences > 0 && <Banner tone="warning" title={t('received.openDifferences', { count: transfer.totals.openDifferences })}>{t('received.openDifferencesBody', { place: transfer.transit.code })}</Banner>}
      <ListFrame<LineView>
        label={t('received.label')}
        rows={state ? [] : transfer.lines}
        rowId={(row) => row.id}
        columns={columns}
        count={t('lines.count', { count: transfer.lines.length })}
        tools={transfer.status === 'SHIPPED' || transfer.status === 'PARTLY_RECEIVED' ? receiveButton : undefined}
        selection={{
          selected,
          onChange: setSelected,
          actions:
            settleable.length === 1 ? (
              <Button size="sm" variant="secondary" heldReason={settleHeld} aria-label={t('received.settle')} onClick={() => actions?.onDialog?.({ kind: 'settle', draft: { lineId: settleable[0]!, resolution: null, note: '' }, busy: false, notice: null })}>
                <Scale size={13} aria-hidden /> <SelectionLabel>{t('received.settle')}</SelectionLabel>
              </Button>
            ) : (
              <span className="fw-trf-hint">{t('lines.selected', { count: selected.length })}</span>
            ),
        }}
        isRowSelectable={(row) => (row.shippedQuantity === null ? t('received.notSent') : null)}
        keys={keys}
        state={state}
        title={t('received.label')}
      />
    </section>
  )
}
