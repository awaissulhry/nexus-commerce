'use client'

import { useMemo } from 'react'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { moneyText } from '../../../finance/costing/model'
import type { PartyRow } from '../../../parties/_shared/api'
import { CUSTOMER_MONEY_NAMESPACE, type CustomerMoneyCan, type Overdue } from './model'
import './money.css'

/** The list's Overdue column: who owes late, read once per list (null while it reads), or the read's problem. */
export interface OverdueListModel {
  readonly can: CustomerMoneyCan
  readonly byParty: ReadonlyMap<string, Overdue> | null
  readonly problem: string | null
}

/**
 * The customers list's "Overdue (price, W2a)" column (design sales.customers grid), handed to the shared parties list as
 * a side column (before Language): what each customer owes past its due date per currency, with how late the oldest
 * is. Absent — not drawn, never '—' — without receivables.view or the price grain; '—' while it reads or when the read
 * failed (its reason on hover); "none" when the customer owes nothing late.
 */
export function useOverdueColumns(model: OverdueListModel | null): ColDef<PartyRow>[] | undefined {
  const t = useT(CUSTOMER_MONEY_NAMESPACE)
  const locale = useLocale()
  return useMemo(() => {
    if (!model || !model.can.receivables || !model.can.price) return undefined
    const OverdueCell = ({ data }: ICellRendererParams<PartyRow>) => {
      if (!data) return null
      if (model.problem) return <span title={t(model.problem)}>—</span>
      if (!model.byParty) return <span aria-label={t('cell.reading')}>—</span>
      const entry = model.byParty.get(data.id)
      if (!entry) return <span className="fw-cmo-muted">{t('cell.none')}</span>
      return (
        <span className="fw-cmo-cell">
          <span className="fw-cmo-num fw-cmo-late fw-cmo-ellipsis" title={entry.amounts.map((amount) => moneyText(amount.amount, amount.currency, locale)).join(' · ')}>
            {entry.amounts.map((amount) => moneyText(amount.amount, amount.currency, locale)).join(' · ')}
          </span>
          <span className="fw-cmo-muted">{entry.daysLate ? t('cell.daysLate', { count: entry.daysLate }) : t('cell.invoices', { count: entry.invoices })}</span>
        </span>
      )
    }
    return [{ colId: 'overdue', headerName: t('col.overdue'), sortable: false, flex: 1, minWidth: 140, cellRenderer: OverdueCell }]
  }, [model, t, locale])
}
