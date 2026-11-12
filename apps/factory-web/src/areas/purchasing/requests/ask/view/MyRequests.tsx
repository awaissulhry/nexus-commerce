'use client'

import { useEffect, useState } from 'react'
import { Send, Undo2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayAt, quantity } from '../../../../_shared/buying/model'
import type { AskedRequest } from '../api'
import { ASK_NAMESPACE, mineSelectableWhy, say, standingPhrase, STATUS_TONE, takeBackHeld, type MineActions, type MineModel } from '../model'
import '../../../../_shared/buying/buying.css'

/**
 * My requests to buy (B-W2b-332; design purchasing.requests, the page for a person who asks but does not buy: no
 * purchasing.view). The band's "Ask to buy", then the shared list frame of one's own requests: the material and colour,
 * how much and by when, the work order, where it stands (waits for the buyer, for a yes; in PO-…, refused with the reason,
 * taken back), when it was asked; select-all, shift range, x; bulk "Take back n" (a decided request says why it cannot
 * be picked). No money; nobody else's requests.
 */
export function MyRequests({ model, actions }: { model: MineModel; actions?: MineActions }) {
  return (
    <WithMessages namespaces={[ASK_NAMESPACE, 'lists']}>
      <Mine model={model} actions={actions} />
    </WithMessages>
  )
}

function Mine({ model, actions }: { model: MineModel; actions?: MineActions }) {
  const t = useT(ASK_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const items = model.rows.items
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])

  const MaterialCell = ({ data }: ICellRendererParams<AskedRequest>) =>
    data ? (
      <span className="fw-by-cell">
        <span className="fw-by-ellipsis">
          {data.item?.code ?? '—'} {data.item?.name ?? ''}
        </span>
        <span className="fw-by-cell-sub fw-by-ellipsis">{[data.colour?.name, data.description].filter(Boolean).join(' · ') || data.site.code}</span>
      </span>
    ) : null
  const QuantityCell = ({ data }: ICellRendererParams<AskedRequest>) =>
    data ? (
      <span className="fw-by-cell">
        <span className="fw-by-num">
          {quantity(data.quantity, locale, 4)} {t(`uom.${data.uom}`)}
        </span>
        <span className="fw-by-cell-sub">{t('mine.by', { date: formatDate(dayAt(data.needDate), place) })}</span>
      </span>
    ) : null
  const ForCell = ({ data }: ICellRendererParams<AskedRequest>) =>
    data ? (
      <span className="fw-by-cell">
        <span>{data.workOrder?.number ?? t('mine.noWorkOrder')}</span>
        <span className="fw-by-cell-sub">{t(`source.${data.source}`)}</span>
      </span>
    ) : null
  const StatusCell = ({ data }: ICellRendererParams<AskedRequest>) =>
    data ? (
      <span className="fw-by-cell">
        <span>
          <Pill tone={STATUS_TONE[data.status]}>{say(t, standingPhrase(data))}</Pill>
        </span>
        {data.rejected && <span className="fw-by-cell-sub fw-by-ellipsis">{data.rejected.reason}</span>}
        {data.cancelled && <span className="fw-by-cell-sub fw-by-ellipsis">{data.cancelled.reason}</span>}
      </span>
    ) : null
  const AskedCell = ({ data }: ICellRendererParams<AskedRequest>) => (data ? <span className="fw-by-cell-sub">{`${formatDate(data.requestedAt, place)} ${formatTime(data.requestedAt, place)}`}</span> : null)

  const columns: ColDef<AskedRequest>[] = [
    { colId: 'material', headerName: t('mine.col.material'), minWidth: 220, flex: 1.6, cellRenderer: MaterialCell },
    { colId: 'quantity', headerName: t('mine.col.quantity'), minWidth: 150, flex: 0.9, cellRenderer: QuantityCell },
    { colId: 'for', headerName: t('mine.col.for'), minWidth: 150, flex: 0.9, cellRenderer: ForCell },
    { colId: 'status', headerName: t('mine.col.status'), minWidth: 200, flex: 1.3, cellRenderer: StatusCell },
    { colId: 'asked', headerName: t('mine.col.asked'), minWidth: 140, flex: 0.8, cellRenderer: AskedCell },
  ]

  if (!model.can.ask) {
    return (
      <div className="fw-by">
        <Card padded>
          <EmptyState title={t('mine.noAccess.title')} description={t('mine.noAccess.body')} />
        </Card>
      </div>
    )
  }

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const backWhy = takeBackHeld(picked, model.offline)
  const state = model.rows.problem ? (
    <EmptyState title={t('mine.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    <EmptyState title={t('mine.empty.title')} description={t('mine.empty.body')} action={<Button size="sm" variant="primary" onClick={() => actions?.onAsk?.()}>{t('band.ask')}</Button>} />
  ) : undefined

  return (
    <div className="fw-by">
      <div className="fw-by-head">
        <span className="fw-by-status" role="status">
          {t('mine.lead')}
        </span>
        <span className="fw-by-actions">
          <Button size="sm" heldReason={model.offline ? t('held.offline') : null} onClick={() => actions?.onAsk?.()} aria-keyshortcuts="a">
            <Send size={14} aria-hidden /> {t('band.ask')}
          </Button>
        </span>
      </div>
      <ListFrame<AskedRequest>
        label={t('mine.label')}
        listKey={null}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t('mine.count', { count: items.length }) : '—'}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" heldReason={backWhy ? say(t, backWhy) : null} aria-label={t('mine.takeBack', { count: picked.length })} onClick={() => actions?.onTakeBack?.(picked.filter((row) => row.cancel.allowed).map((row) => row.id))}>
              <Undo2 size={13} aria-hidden /> <SelectionLabel>{t('mine.takeBack', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={(row) => {
          const why = mineSelectableWhy(row)
          return why ? say(t, why) : null
        }}
        more={model.rows.more && items && items.length > 0 ? { label: t('common.more'), onMore: () => actions?.onMore?.() } : null}
        state={state}
      />
      {model.takeBack && <TakeBackDialog model={model} actions={actions} />}
    </div>
  )
}

function TakeBackDialog({ model, actions }: { model: MineModel; actions?: MineActions }) {
  const t = useT(ASK_NAMESPACE)
  const locale = useLocale()
  const back = model.takeBack!
  const rows = (model.rows.items ?? []).filter((row) => back.ids.includes(row.id))
  const held = back.busy ? t('held.busy') : back.reason.trim() === '' ? t('mine.reasonFirst') : model.offline ? t('held.offline') : null
  return (
    <Modal
      open
      onClose={() => actions?.takeBack?.onClose?.()}
      title={t('mine.takeBackTitle', { count: rows.length })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.takeBack?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.takeBack?.onConfirm?.()}>
            {back.busy ? <Spinner size={12} /> : <Undo2 size={13} aria-hidden />} {t('mine.takeBack', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        <p className="fw-by-hint">{t('mine.takeBackBody')}</p>
        <Field label={t('mine.reason')} required>
          <Textarea rows={3} maxLength={2000} value={back.reason} onChange={(event) => actions?.takeBack?.onReason?.(event.target.value)} />
        </Field>
        <ul className="fw-by-list">
          {rows.map((row) => (
            <li key={row.id}>
              {row.item?.code ?? ''} {row.item?.name ?? ''} — {quantity(row.quantity, locale, 4)} {t(`uom.${row.uom}`)}
            </li>
          ))}
        </ul>
        {back.problem && <Banner tone="danger" title={say(t, back.problem)} />}
      </div>
    </Modal>
  )
}
