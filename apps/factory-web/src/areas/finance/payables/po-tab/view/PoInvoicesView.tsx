'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant, money } from '../../../_shared/model'
import type { InvoiceRow } from '../../api'
import { invoiceHref, MATCH_TONE, PAYABLES_NAMESPACE, STATUS_TONE } from '../../model'
import '../../payables.css'

/** The PO studio's Invoices tab — its view model (the view fetches nothing). */
export interface PoInvoicesModel {
  readonly prefix: string
  /** The person may read supplier invoices (payables.view) and their amounts (the cost grain). */
  readonly view: boolean
  readonly cost: boolean
  readonly rows: readonly InvoiceRow[] | null
  readonly problem: string | null
  readonly more: boolean
}

/**
 * The PO studio's Invoices tab (design purchasing.orders "Record: Purchase order" › Invoices, W2a: "Supplier invoices —
 * invoices matched to this PO in Finance"): each supplier invoice with a line on this order — number, date, amount (the
 * cost grain: the column is not drawn without it), the match in words (Matched · Differences · Waiting goods …), its
 * approval — and "Open in Finance" (its record). Read only, on the ONE list frame without selection.
 */
export function PoInvoicesView({ model, onRetry }: { model: PoInvoicesModel; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[PAYABLES_NAMESPACE, 'lists']}>
      <PoInvoices model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function PoInvoices({ model, onRetry }: { model: PoInvoicesModel; onRetry?: () => void }) {
  const t = useT(PAYABLES_NAMESPACE)
  const locale = useLocale()
  const columns = useMemo<ColDef<InvoiceRow>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<InvoiceRow>) =>
      data ? (
        <span className="fw-fpy-cell">
          <Link className="fw-fpy-link" href={invoiceHref(model.prefix, data.id, 'match')}>
            {data.number}
          </Link>
          <span className="fw-fpy-cell-sub">{data.kind === 'CREDIT_NOTE' ? t('kind.CREDIT_NOTE') : t(`source.${data.source}`)}</span>
        </span>
      ) : null
    const AmountCell = ({ data }: ICellRendererParams<InvoiceRow>) => (data ? <span className="fw-fpy-num">{money(data.grossTotal ?? null, data.currency, locale)}</span> : null)
    const MatchCell = ({ data }: ICellRendererParams<InvoiceRow>) =>
      data ? (
        <span className="fw-fpy-cell">
          <Pill tone={MATCH_TONE[data.matchStatus]}>{t(`match.${data.matchStatus}`)}</Pill>
          {data.differencesToCheck > 0 && <span className="fw-fpy-cell-sub">{t('row.toCheck', { count: data.differencesToCheck })}</span>}
        </span>
      ) : null
    const ApprovalCell = ({ data }: ICellRendererParams<InvoiceRow>) => (data ? <Tag tone={STATUS_TONE[data.status] === 'success' ? 'success' : 'neutral'}>{t(`status.${data.status}`)}</Tag> : null)
    const OpenCell = ({ data }: ICellRendererParams<InvoiceRow>) =>
      data ? (
        <Link className="fw-fpy-link" href={invoiceHref(model.prefix, data.id)}>
          {t('po.open')}
        </Link>
      ) : null
    return [
      { colId: 'number', headerName: t('col.number'), minWidth: 160, flex: 1.1, cellRenderer: NumberCell },
      { colId: 'date', headerName: t('col.date'), minWidth: 110, flex: 0.7, valueGetter: (params) => (params.data ? formatDate(dayInstant(params.data.issueDate), { locale }) : '') },
      ...(model.cost ? [{ colId: 'amount', headerName: t('col.amount'), minWidth: 130, flex: 0.8, type: 'rightAligned', cellRenderer: AmountCell } satisfies ColDef<InvoiceRow>] : []),
      { colId: 'match', headerName: t('col.match'), minWidth: 160, flex: 1, cellRenderer: MatchCell },
      { colId: 'approval', headerName: t('col.approval'), minWidth: 120, flex: 0.8, cellRenderer: ApprovalCell },
      { colId: 'open', headerName: t('po.openCol'), minWidth: 130, flex: 0.7, cellRenderer: OpenCell },
    ]
  }, [t, locale, model.prefix, model.cost])

  if (!model.view) return <EmptyState title={t('po.noAccess.title')} description={t('po.noAccess.body')} />
  const state = model.problem ? (
    <EmptyState
      title={t('po.failed')}
      description={t(model.problem)}
      action={
        <Button size="sm" onClick={() => onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : model.rows && model.rows.length === 0 ? (
    <EmptyState title={t('po.empty.title')} description={t('po.empty.body')} />
  ) : undefined
  return (
    <div className="fw-fpy-stack">
      <p className="fw-fpy-muted">{model.cost ? t('po.hint') : t('po.noCost')}</p>
      <ListFrame<InvoiceRow>
        label={t('po.title')}
        rows={state ? [] : model.rows}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows ? t('po.count', { count: model.rows.length }) : '—'}
        listKey={null}
        state={state}
      />
      {model.more && <p className="fw-fpy-muted">{t('po.more')}</p>}
    </div>
  )
}
