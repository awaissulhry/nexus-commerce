'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Undo2 } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { quantity, type Phrase } from '../../../../_shared/stock/model'
import type { Substitution } from '../api'
import { STATUS_TONE, withdrawHeld, type SubCan } from '../model'
import { useSubWords } from './SubstituteDialog'
import '../../../../_shared/stock/stock.css'
import '../substitute.css'

/**
 * B-W2b-320 — the substitutes of the site (design warehouse.picking pk-metrics "Substitutes waiting for approval (W2b)": the
 * tile opens this list; connection "Substitution approvals (home.approvals)"): waiting and approved ones by default, or all,
 * on the shared list frame — the work order and its line, what stands in (material, colour, lot), how much and for how much
 * of the line's own material, its state, asked from the office or the floor (never who), and its request in Home ›
 * Approvals. Withdraw (with the reason) one or the selected ones while they wait or are approved.
 */

export interface SubstitutesModel {
  status: 'OPEN' | 'ALL'
  rows: Substitution[] | null
  problem: string | null
  more: boolean
  /** The row to show first (a link from Home › Approvals: `?substitution=`). */
  focus?: string | null
  withdraw: { ids: string[]; reason: string; busy: boolean; problem: Phrase | null; done: number | null } | null
}

export interface SubstitutesActions {
  onStatus?: (status: 'OPEN' | 'ALL') => void
  onRetry?: () => void
  onWithdraw?: (ids: readonly string[] | null) => void
  onWithdrawReason?: (reason: string) => void
  onConfirmWithdraw?: () => void
}

export function SubstitutesSection({ model, can, prefix, timeZone, actions }: { model: SubstitutesModel; can: SubCan; prefix: string; timeZone: string; actions?: SubstitutesActions }) {
  const { t, say, unit } = useSubWords()
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.focus ? [model.focus] : [])
  const rows = model.rows
  const columns = useMemo<ColDef<Substitution>[]>(() => {
    const OrderCell = ({ data }: ICellRendererParams<Substitution>) =>
      data ? (
        <span className="fw-st-cell">
          <Link className="fw-st-link" href={`${prefix}${recordAddress({ type: 'WorkOrder', id: data.workOrder.id }, OFFICE_PAGES)}?tab=materials`}>
            {data.workOrder.number}
          </Link>
          <span className="fw-st-sub">{t('sb.list.line', { seq: data.line.seq, code: data.line.material.code })}</span>
        </span>
      ) : null
    const WhatCell = ({ data }: ICellRendererParams<Substitution>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis">{[data.substitute.item.code, data.substitute.colour?.code].filter(Boolean).join(' ')}</span>
          <span className="fw-st-sub">{data.substitute.lot ? t('sb.lotCode', { code: data.substitute.lot.code }) : data.kind === 'ALTERNATE' ? t('sb.list.alternate', { priority: data.substitute.alternate?.priority ?? 0 }) : t('sb.list.own')}</span>
        </span>
      ) : null
    const QtyCell = ({ data }: ICellRendererParams<Substitution>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-num">{`${quantity(data.quantity, locale)} ${unit(data.uom)}`}</span>
          {data.replaces && <span className="fw-st-sub">{t('sb.list.replaces', { quantity: quantity(data.replaces.quantity, locale), uom: unit(data.replaces.uom) })}</span>}
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<Substitution>) =>
      data ? (
        <span className="fw-st-cell">
          <span>
            <Pill tone={STATUS_TONE[data.status]}>{t(`sb.status.${data.status}`)}</Pill>
          </span>
          <span className="fw-st-sub">{t('sb.askedOn', { date: formatDateTime(data.createdAt, { locale, timeZone }), by: t(`sb.asked.${data.asked}`) })}</span>
        </span>
      ) : null
    const RequestCell = ({ data }: ICellRendererParams<Substitution>) =>
      data ? (
        data.approval ? (
          <Link className="fw-st-link" href={`${prefix}${recordAddress({ type: 'ApprovalTask', id: data.approval.taskId }, OFFICE_PAGES)}`}>
            {t('sb.list.request')}
          </Link>
        ) : (
          <span className="fw-st-sub">{t('sb.list.noRequest')}</span>
        )
      ) : null
    return [
      { colId: 'order', headerName: t('sb.list.col.order'), minWidth: 150, flex: 1, cellRenderer: OrderCell },
      { colId: 'what', headerName: t('sb.list.col.what'), minWidth: 170, flex: 1.2, cellRenderer: WhatCell },
      { colId: 'quantity', headerName: t('sb.list.col.quantity'), minWidth: 130, flex: 0.8, type: 'rightAligned', cellRenderer: QtyCell },
      { colId: 'status', headerName: t('sb.list.col.status'), minWidth: 170, flex: 1, cellRenderer: StatusCell },
      { colId: 'request', headerName: t('sb.list.col.request'), minWidth: 130, flex: 0.7, cellRenderer: RequestCell },
    ]
  }, [t, unit, locale, prefix, timeZone])

  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const withdrawWait = !can.ask ? t('sb.held.noRight') : picked.some((row) => withdrawHeld(row, can)) ? t('sb.held.final') : null
  const state = model.problem ? (
    <EmptyState title={t('sb.list.failed')} description={t('sb.tryAgain')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('sb.retry')}</Button>} />
  ) : rows && rows.length === 0 ? (
    <EmptyState title={t(model.status === 'OPEN' ? 'sb.list.emptyOpen' : 'sb.list.empty')} description={t('sb.list.emptyBody')} />
  ) : undefined
  return (
    <section className="fw-sub" aria-label={t('sb.list.title')}>
      <div className="fw-sub-head">
        <h2 className="fw-sub-h3">{t('sb.list.title')}</h2>
        <SegmentedControl
          ariaLabel={t('sb.list.which')}
          size="sm"
          value={model.status}
          onChange={(value) => actions?.onStatus?.(value as 'OPEN' | 'ALL')}
          options={[
            { value: 'OPEN', label: t('sb.list.open') },
            { value: 'ALL', label: t('sb.list.all') },
          ]}
        />
      </div>
      <ListFrame<Substitution>
        label={t('sb.list.title')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t(model.more ? 'sb.list.countMore' : 'sb.list.count', { count: rows.length }) : '—'}
        listKey={null}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="danger-outline" aria-label={t('sb.list.withdrawN', { count: picked.length })} heldReason={withdrawWait} onClick={() => actions?.onWithdraw?.(picked.map((row) => row.id))}>
              <Undo2 size={13} aria-hidden /> <SelectionLabel>{t('sb.list.withdrawN', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={(row) => say(withdrawHeld(row, can))}
        state={state}
      />
      {model.withdraw && (
        <Modal
          open
          onClose={() => actions?.onWithdraw?.(null)}
          title={t('sb.list.withdrawTitle', { count: model.withdraw.ids.length })}
          size="sm"
          footer={
            <>
              <span className="grow" />
              <Button size="sm" onClick={() => actions?.onWithdraw?.(null)}>
                {model.withdraw.done !== null ? t('sb.close') : t('sb.cancel')}
              </Button>
              {model.withdraw.done === null && (
                <Button size="sm" variant="danger" heldReason={model.withdraw.reason.trim() ? (model.withdraw.busy ? t('sb.busy') : null) : t('sb.withdrawWhy')} onClick={() => actions?.onConfirmWithdraw?.()}>
                  {model.withdraw.busy ? <Spinner size={12} /> : <Undo2 size={13} aria-hidden />} {t('sb.list.withdrawN', { count: model.withdraw.ids.length })}
                </Button>
              )}
            </>
          }
        >
          <div className="fw-sub">
            {model.withdraw.problem && <Banner tone="danger" title={say(model.withdraw.problem) ?? ''} />}
            {model.withdraw.done !== null ? (
              <Banner tone="success" title={t('sb.list.withdrawn', { count: model.withdraw.done })} />
            ) : (
              <Field label={t('sb.withdrawReason')} required hint={t('sb.list.withdrawHint')}>
                <Textarea value={model.withdraw.reason} maxLength={500} rows={3} onChange={(event) => actions?.onWithdrawReason?.(event.target.value)} />
              </Field>
            )}
          </div>
        </Modal>
      )}
    </section>
  )
}
