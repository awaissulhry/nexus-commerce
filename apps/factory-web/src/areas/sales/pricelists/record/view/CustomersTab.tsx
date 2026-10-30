'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { UserMinus, UserPlus } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListCustomer, PriceListDetail } from '../../api'
import { customersHeld } from '../../model'
import { useWords } from '../../parts'
import type { PriceListRecordActions, PriceListRecordModel } from '../record-model'

/**
 * Customers (design pricelist.customers: who gets this list as their default): each customer priced from it, a real
 * link to its record (Tax & terms › Commercial terms is where one customer's list is changed too); Add customers and,
 * over the rows picked, Remove N — both need pricelists.manage and parties.manage (the API checks each customer). The
 * design's "From" column has no source yet (gap: the customer's list carries no dated history; its audit row has the time).
 */
export function CustomersTab({ list, model, actions }: { list: PriceListDetail; model: PriceListRecordModel; actions?: PriceListRecordActions }) {
  const t = useWords()
  const held = customersHeld(list, model.can)
  const heldText = held ? t(held) : model.busy ? t('held.busy') : null
  const picked = list.customers.filter((customer) => model.selectedCustomers.includes(customer.id))

  const columns = useMemo<ColDef<ListCustomer>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<ListCustomer>) =>
      data ? (
        <span className="fw-pl-cell">
          <Link className="fw-pl-link" href={`${model.prefix}/sales/customers/${encodeURIComponent(data.id)}?tab=tax`} tabIndex={-1}>
            {data.legalName}
          </Link>
          <span className="fw-pl-sub">{data.code}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<ListCustomer>) => (data ? <Pill tone={data.status === 'ACTIVE' ? 'success' : data.status === 'BLOCKED' ? 'danger' : 'neutral'}>{t(`partyStatus.${data.status}`)}</Pill> : null)
    return [
      { colId: 'name', headerName: t('customers.col.customer'), minWidth: 220, flex: 2, cellRenderer: NameCell, valueGetter: (params) => params.data?.legalName ?? '' },
      { colId: 'code', headerName: t('customers.col.code'), field: 'code', minWidth: 120, flex: 1 },
      { colId: 'status', headerName: t('customers.col.status'), minWidth: 120, flex: 1, cellRenderer: StatusCell, valueGetter: (params) => params.data?.status ?? '' },
    ]
  }, [t, model.prefix])

  return (
    <div className="fw-pl-stack">
      <p className="fw-pl-hint">{t(list.kind === 'GROUP' ? 'customers.introGroup' : 'customers.intro')}</p>
      <ListFrame<ListCustomer>
        label={t('customers.table')}
        listKey={null}
        rows={list.customers}
        rowId={(customer) => customer.id}
        columns={columns}
        count={t('customers.count', { count: list.customers.length })}
        right={
          <Button size="sm" heldReason={heldText} onClick={() => actions?.onDialog?.({ kind: 'addCustomers' })}>
            <UserPlus size={13} aria-hidden /> {t('customers.add')}
          </Button>
        }
        selection={{
          selected: model.selectedCustomers,
          onChange: (ids) => actions?.onSelectCustomers?.(ids),
          actions: (
            <Button size="sm" variant="danger-outline" aria-label={t('customers.bulk.remove', { count: picked.length })} heldReason={heldText} onClick={() => actions?.onDialog?.({ kind: 'removeCustomers' })}>
              <UserMinus size={13} aria-hidden /> <SelectionLabel>{t('customers.bulk.remove', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        onHelp={() => actions?.onDialog?.({ kind: 'help' })}
        state={
          list.customers.length === 0 ? (
            <EmptyState
              title={t('customers.empty.title')}
              description={t(list.kind === 'BASE' ? 'customers.empty.base' : 'customers.empty.body')}
              action={
                <Button size="sm" variant="primary" heldReason={heldText} onClick={() => actions?.onDialog?.({ kind: 'addCustomers' })}>
                  {t('customers.add')}
                </Button>
              }
            />
          ) : undefined
        }
        focusRow={model.focusRow}
      />
      {list.fallbackOf.length > 0 && <p className="fw-pl-hint">{t('customers.fallbackOf', { lists: list.fallbackOf.map((other) => other.code).join(', ') })}</p>}
    </div>
  )
}
