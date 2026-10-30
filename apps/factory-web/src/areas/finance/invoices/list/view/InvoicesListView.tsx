'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Download, FilePlus2, MoreHorizontal } from 'lucide-react'
import { Banner, EmptyState, KeyValue, Menu, MetricStrip, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Pill, RadioCard, Select, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { hasRecordPage, recordAddress } from '../../../../../lib/records/record-links'
import { WithMessages } from '../../../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { InvoiceRow, QueueCustomer, QueueDdt } from '../../../_shared/api'
import {
  countText,
  dayInstant,
  DEADLINE_TONE,
  deadlineWords,
  ddtHeld,
  ddtLeft,
  money,
  PAY_TONE,
  payStateOf,
  ROW_VIEWS,
  SDI_TONE,
  sdiCodeOf,
  selectionHeld,
  suggestedType,
  TILES,
  type RowView,
} from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import type { InvoicesListActions, InvoicesListModel } from '../list-model'
import '../../../_shared/finance.css'

export type { InvoicesListActions, InvoicesListModel } from '../list-model'

/** One DDT row of "Shipped, not invoiced", with its customer (the rows are grouped by customer: sorted, named). */
interface ShippedRow extends QueueDdt {
  customer: QueueCustomer
  monthDeadline: QueueCustomer['months'][number]['deadline']
}

/**
 * SCR-080 — Invoices (Finance; design finance.invoices): where invoices stand (tiles = saved views; Rejected and
 * Shipped, not invoiced first), the rejected notice with SDI's deadline (Fix now opens the record's SDI tab), "Shipped,
 * not invoiced" — every DDT not yet invoiced, by customer, with its value, the deposit paid on its orders, the type the
 * rule suggests and the legal deadline (TD01: the DDT's date + 12 days; TD24: the 15th of the next month); choosing DDTs
 * of one customer and month makes one draft — and every invoice, deposit invoice and credit note with its SDI and
 * payment state. Both lists are the shared list frame (select-all, shift range, x; bulk actions while rows are
 * selected; keys only in the footer's info icon). Money only with the price grain: the columns are absent, never zero.
 */
export function InvoicesListView({ model, actions }: { model: InvoicesListModel; actions?: InvoicesListActions }) {
  return (
    <WithMessages namespaces={['finance', 'lists']}>
      <InvoicesList model={model} actions={actions} />
    </WithMessages>
  )
}

const shippedRowsOf = (model: InvoicesListModel): ShippedRow[] | null =>
  model.queue.value
    ? model.queue.value.customers.flatMap((customer) =>
        customer.ddts.map((ddt) => ({ ...ddt, customer, monthDeadline: customer.months.find((month) => month.ddtIds.includes(ddt.ddtId))?.deadline ?? null })),
      )
    : null

function InvoicesList({ model, actions }: { model: InvoicesListModel; actions?: InvoicesListActions }) {
  const t = useT('finance')
  const lists = useT('lists')
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [shippedSelected, setShippedSelected] = useState<readonly string[]>(model.shippedSelected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const items = model.list.items
  const shipped = useMemo(() => shippedRowsOf(model), [model])
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  const shippedKey = shipped?.map((row) => row.ddtId).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setShippedSelected((current) => current.filter((id) => shippedKey.includes(id))), [shippedKey])
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const invoiceHref = (id: string) => `${model.prefix}/finance/invoices/${id}`

  // c: Invoice shipped goods (the design's key) — never while typing or inside a dialog. The frames keep / j k x Enter ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manageInvoices) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'fromDdts', ddtIds: [], partyId: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('list.keyInvoiceShipped') }]

  // ---- Shipped, not invoiced --------------------------------------------------------------------------------------------
  const shippedColumns = useMemo<ColDef<ShippedRow>[]>(() => {
    const CustomerCell = ({ data }: ICellRendererParams<ShippedRow>) =>
      data ? (
        <span className="fw-fin-cell">
          <span className="fw-fin-ellipsis">{data.customer.legalName}</span>
          <span className="fw-fin-cell-sub">{data.customer.code}</span>
        </span>
      ) : null
    const DdtCell = ({ data }: ICellRendererParams<ShippedRow>) =>
      data ? (
        <span className="fw-fin-cell">
          {hasRecordPage('Shipment', OFFICE_PAGES) ? (
            <Link className="fw-fin-link" href={`${model.prefix}${recordAddress({ type: 'Shipment', id: data.shipmentId }, OFFICE_PAGES)}`}>
              {t('shipped.ddt', { number: data.number })}
            </Link>
          ) : (
            <span>{t('shipped.ddt', { number: data.number })}</span>
          )}
          <span className="fw-fin-cell-sub">{day(data.date)}</span>
        </span>
      ) : null
    const OrdersCell = ({ data }: ICellRendererParams<ShippedRow>) =>
      data ? (
        <span className="fw-fin-chips">
          {data.orders.map((order) =>
            hasRecordPage('SalesOrder', OFFICE_PAGES) && model.can.viewOrders ? (
              <Link key={order.id} className="fw-fin-link" href={`${model.prefix}${recordAddress({ type: 'SalesOrder', id: order.id }, OFFICE_PAGES)}`}>
                {order.number}
              </Link>
            ) : (
              <span key={order.id}>{order.number}</span>
            ),
          )}
        </span>
      ) : null
    const PiecesCell = ({ data }: ICellRendererParams<ShippedRow>) => {
      if (!data) return null
      const left = ddtLeft(data)
      return (
        <span className="fw-fin-cell">
          <span>{t('shipped.pieces', { count: left.toInvoice })}</span>
          <span className="fw-fin-cell-sub">{left.inDraft > 0 ? t('shipped.inDraft', { count: left.inDraft }) : t('shipped.lines', { count: data.lines.length })}</span>
        </span>
      )
    }
    const ValueCell = ({ data }: ICellRendererParams<ShippedRow>) => (data ? <span className="fw-fin-num">{money(data.valueAmount, 'EUR', locale)}</span> : null)
    const DepositCell = ({ data }: ICellRendererParams<ShippedRow>) => (data ? <span className="fw-fin-num">{data.depositPaidAmount ? money(data.depositPaidAmount, 'EUR', locale) : '—'}</span> : null)
    const TypeCell = ({ data }: ICellRendererParams<ShippedRow>) => {
      if (!data) return null
      const type = data.immediate.state === 'LATE' && data.monthDeadline?.state !== 'LATE' ? 'TD24' : data.customer.months.find((month) => month.ddtIds.includes(data.ddtId))?.suggested ?? 'TD01'
      return (
        <span className="fw-fin-cell">
          <span>{t(`shipType.${type}`)}</span>
          <span className="fw-fin-cell-sub">{type}</span>
        </span>
      )
    }
    const DeadlineCell = ({ data }: ICellRendererParams<ShippedRow>) => {
      if (!data) return null
      const deadline = data.immediate.state !== 'LATE' || !data.monthDeadline ? data.immediate : data.monthDeadline
      const words = deadlineWords(deadline)
      return (
        <span className="fw-fin-cell">
          <Pill tone={DEADLINE_TONE[deadline.state]}>{t(words.key, words.params)}</Pill>
          <span className="fw-fin-cell-sub">{t('shipped.dueBy', { date: day(deadline.dueBy) })}</span>
        </span>
      )
    }
    const DraftCell = ({ data }: ICellRendererParams<ShippedRow>) =>
      data ? (
        data.drafts.length > 0 ? (
          <span className="fw-fin-chips">
            {data.drafts.map((id) => (
              <Link key={id} className="fw-fin-link" href={invoiceHref(id)}>
                {t('shipped.openDraft')}
              </Link>
            ))}
          </span>
        ) : (
          <span>—</span>
        )
      ) : null
    return [
      { colId: 'customer', headerName: t('col.customer'), minWidth: 170, flex: 1.4, cellRenderer: CustomerCell },
      { colId: 'ddt', headerName: t('col.ddt'), minWidth: 120, flex: 0.9, cellRenderer: DdtCell },
      { colId: 'orders', headerName: t('col.orders'), minWidth: 120, flex: 0.9, cellRenderer: OrdersCell },
      { colId: 'pieces', headerName: t('col.toInvoice'), minWidth: 120, flex: 0.8, cellRenderer: PiecesCell },
      ...(model.can.price
        ? [
            { colId: 'value', headerName: t('col.value'), minWidth: 110, flex: 0.8, type: 'rightAligned', cellRenderer: ValueCell },
            { colId: 'deposit', headerName: t('col.depositPaid'), minWidth: 136, flex: 0.9, type: 'rightAligned', cellRenderer: DepositCell },
          ]
        : []),
      { colId: 'type', headerName: t('col.suggested'), minWidth: 150, flex: 1, cellRenderer: TypeCell },
      { colId: 'deadline', headerName: t('col.deadline'), minWidth: 160, flex: 1, cellRenderer: DeadlineCell },
      { colId: 'draft', headerName: t('col.draft'), minWidth: 110, flex: 0.7, cellRenderer: DraftCell },
    ]
  }, [t, locale, model.prefix, model.can.price, model.can.viewOrders])

  const pickedShipped = (shipped ?? []).filter((row) => shippedSelected.includes(row.ddtId))
  const shippedWait = selectionHeld(pickedShipped)
  const createHeld = !model.can.manageInvoices ? t('held.noManage') : shippedWait ? t(shippedWait.key) : null
  const shippedState = model.queue.problem ? (
    <EmptyState title={t('shipped.failed')} description={t(model.queue.problem)} action={<Button size="sm" onClick={() => actions?.onRetryQueue?.()}>{t('common.retry')}</Button>} />
  ) : shipped && shipped.length === 0 ? (
    <EmptyState title={t('shipped.empty.title')} description={t('shipped.empty.body')} />
  ) : undefined

  // ---- All invoices -----------------------------------------------------------------------------------------------------------
  const columns = useMemo<ColDef<InvoiceRow>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<InvoiceRow>) =>
      data ? (
        <span className="fw-fin-cell">
          <Link className="fw-fin-link" href={invoiceHref(data.id)}>
            {data.number ?? t('list.draft')}
          </Link>
          <span className="fw-fin-cell-sub">{data.filesPending ? t('list.filesPending') : data.issueDate ? day(data.issueDate) : t('list.createdOn', { date: formatDate(data.createdAt, { locale }) })}</span>
        </span>
      ) : null
    const TypeCell = ({ data }: ICellRendererParams<InvoiceRow>) =>
      data ? (
        <span className="fw-fin-cell">
          <span>{t(`docType.${data.docType}`)}</span>
          <span className="fw-fin-cell-sub">{data.docType}</span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<InvoiceRow>) => (data ? <span className="fw-fin-ellipsis">{data.partyName || '—'}</span> : null)
    const SdiCell = ({ data }: ICellRendererParams<InvoiceRow>) => {
      if (!data) return null
      const code = sdiCodeOf(data.status)
      return <Pill tone={SDI_TONE[code]}>{t(`sdi.state.${code}`)}</Pill>
    }
    const PayCell = ({ data }: ICellRendererParams<InvoiceRow>) => {
      if (!data) return null
      const pay = payStateOf(data, model.today)
      if (!pay || pay.state === 'NONE') return <span>—</span>
      return (
        <span className="fw-fin-cell">
          <Pill tone={PAY_TONE[pay.state]}>{t(`pay.${pay.state}`, { count: pay.days })}</Pill>
          {(pay.state === 'PART_PAID' || pay.state === 'OVERDUE') && <span className="fw-fin-cell-sub">{t('list.openAmount', { amount: money(data.openAmount, data.currency, locale) })}</span>}
        </span>
      )
    }
    const Amount = (field: 'netTotal' | 'vatTotal' | 'grossTotal') =>
      function AmountCell({ data }: ICellRendererParams<InvoiceRow>) {
        return data ? <span className="fw-fin-num">{money(data[field], data.currency, locale)}</span> : null
      }
    const DueCell = ({ data }: ICellRendererParams<InvoiceRow>) => (data ? <span>{data.dueDate && (data.docType === 'TD01' || data.docType === 'TD24') ? day(data.dueDate) : '—'}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<InvoiceRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number ?? t('list.draft') }) }}
          items={[
            { id: 'open', label: t('list.open'), href: invoiceHref(data.id) },
            { id: 'tab', label: t('list.openNewTab'), href: invoiceHref(data.id), target: '_blank' },
            ...(data.status === 'DRAFT' ? [{ id: 'issue', label: t('step.issue'), href: `${invoiceHref(data.id)}?tab=lines` }] : [{ id: 'sdi', label: t('tab.sdi'), href: `${invoiceHref(data.id)}?tab=sdi` }]),
            ...(model.can.recordPayments && (data.openAmount ?? 0) > 0 ? [{ id: 'pay', label: t('step.recordPayment'), href: `${model.prefix}/finance/payments?new=1&invoice=${data.id}` }] : []),
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('col.number'), field: 'number', minWidth: 140, flex: 1, cellRenderer: NumberCell },
      { colId: 'type', headerName: t('col.type'), field: 'docType', minWidth: 140, flex: 0.9, cellRenderer: TypeCell },
      { colId: 'customer', headerName: t('col.customer'), field: 'partyName', minWidth: 160, flex: 1.4, cellRenderer: CustomerCell },
      ...(model.can.price
        ? [
            { colId: 'net', headerName: t('col.net'), minWidth: 100, flex: 0.7, type: 'rightAligned', cellRenderer: Amount('netTotal') },
            { colId: 'vat', headerName: t('col.vat'), minWidth: 90, flex: 0.6, type: 'rightAligned', cellRenderer: Amount('vatTotal') },
            { colId: 'gross', headerName: t('col.gross'), minWidth: 110, flex: 0.8, type: 'rightAligned', cellRenderer: Amount('grossTotal') },
          ]
        : []),
      { colId: 'sdi', headerName: t('col.sdi'), field: 'status', minWidth: 150, flex: 1, cellRenderer: SdiCell },
      ...(model.can.price ? [{ colId: 'pay', headerName: t('col.payment'), minWidth: 150, flex: 1, cellRenderer: PayCell }] : []),
      { colId: 'due', headerName: t('col.due'), field: 'dueDate', minWidth: 100, flex: 0.7, cellRenderer: DueCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.today, model.can.price, model.can.recordPayments])

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const narrowed = model.rows !== 'all'
  const state = model.list.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    narrowed ? (
      <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={<Button size="sm" onClick={() => actions?.onRows?.('all')}>{t('list.clearFilters')}</Button>} />
    ) : (
      <EmptyState title={t('list.empty.title')} description={t('list.empty.body')} />
    )
  ) : undefined

  const rowsSelect = (
    <Select size="sm" aria-label={t('list.rowsLabel')} value={model.rows === 'custom' ? 'custom' : model.rows} onChange={(event) => actions?.onRows?.(event.target.value as RowView)}>
      {model.rows === 'custom' && <option value="custom">{t('rows.custom')}</option>}
      {ROW_VIEWS.map((view) => (
        <option key={view} value={view}>
          {t(`rows.${view}`)}
        </option>
      ))}
    </Select>
  )

  const oldest = shipped && shipped.length > 0 ? shipped.map((row) => row.date).sort()[0]! : null
  const tileValue = (key: (typeof TILES)[number]['key']): string => {
    if (key === 'shipped') return shipped ? String(shipped.length) : '—'
    return model.tiles ? countText(model.tiles[key]) : '—'
  }
  const pressed = TILES.find((tile) => tile.rows !== null && tile.rows === model.rows)?.key ?? null

  return (
    <div className="fw-fin">
      <div className="fw-fin-head">
        <span className="fw-fin-status" role="status">
          {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-fin-actions">
          <Button size="sm" variant="primary" heldReason={!model.can.manageInvoices ? t('held.noManage') : shipped && shipped.length === 0 ? t('held.nothingShipped') : null} onClick={() => actions?.onDialog?.({ kind: 'fromDdts', ddtIds: [], partyId: null })} aria-keyshortcuts="c">
            <FilePlus2 size={14} aria-hidden /> {t('step.invoiceShipped')}
          </Button>
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.words.key, model.notice.words.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      {model.rejected.map((entry) => (
        <Banner
          key={entry.id}
          tone="danger"
          title={entry.deadline ? t(entry.overdue ? 'rejected.bannerOverdue' : 'rejected.banner', { number: entry.number ?? '—', customer: entry.partyName, date: day(entry.deadline) }) : t('rejected.bannerNoDate', { number: entry.number ?? '—', customer: entry.partyName })}
          action={
            <Button size="sm" asChild>
              <Link href={`${invoiceHref(entry.id)}?tab=sdi`}>{t('rejected.fixNow')}</Link>
            </Button>
          }
        />
      ))}

      <MetricStrip
        metrics={TILES.map((tile) => ({
          label: t(`tile.${tile.key}`),
          value: tileValue(tile.key),
          hint: tile.key === 'shipped' && oldest ? t('tile.oldest', { count: Math.max(0, Math.round((Date.parse(`${model.today}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / 86_400_000)) }) : tile.key === 'rejected' && (model.tiles?.rejected ?? 0) > 0 ? t('tile.fixIn5') : undefined,
          onClick:
            tile.rows === null
              ? () => document.getElementById('fw-fin-shipped')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
              : () => actions?.onRows?.(model.rows === tile.rows ? 'all' : tile.rows),
          active: pressed === tile.key,
        }))}
      />

      <section className="fw-fin-section" id="fw-fin-shipped" aria-labelledby="fw-fin-shipped-title">
        <div className="fw-fin-section-head">
          <h2 className="fw-fin-h2" id="fw-fin-shipped-title">
            {t('shipped.title')}
          </h2>
          <p className="fw-fin-hint">{t('shipped.explain')}</p>
        </div>
        <ListFrame<ShippedRow>
          label={t('shipped.title')}
          rows={shippedState ? [] : shipped}
          rowId={(row) => row.ddtId}
          columns={shippedColumns}
          count={shipped ? t('shipped.count', { count: shipped.length }) : '—'}
          selection={{
            selected: shippedSelected,
            onChange: setShippedSelected,
            actions: (
              <Button size="sm" variant="primary" heldReason={createHeld} aria-label={t('bulk.invoiceDdts', { count: pickedShipped.length })} onClick={() => actions?.onDialog?.({ kind: 'fromDdts', ddtIds: pickedShipped.map((row) => row.ddtId), partyId: pickedShipped[0]?.partyId ?? null })}>
                <FilePlus2 size={13} aria-hidden /> <SelectionLabel>{t('bulk.invoiceDdts', { count: pickedShipped.length })}</SelectionLabel>
              </Button>
            ),
          }}
          isRowSelectable={(row) => {
            const held = ddtHeld(row)
            return held ? t(held.key) : null
          }}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          onOpen={(row) => (row.drafts[0] ? actions?.onOpen?.(row.drafts[0]) : actions?.onDialog?.({ kind: 'fromDdts', ddtIds: [row.ddtId], partyId: row.partyId }))}
          state={shippedState}
        />
      </section>

      <section className="fw-fin-section" aria-labelledby="fw-fin-all-title">
        <div className="fw-fin-section-head">
          <h2 className="fw-fin-h2" id="fw-fin-all-title">
            {t('list.title')}
          </h2>
        </div>
        <ListFrame<InvoiceRow>
          label={t('list.title')}
          rows={state ? [] : items}
          rowId={(row) => row.id}
          columns={columns}
          count={items ? t(model.list.more ? 'list.countMore' : 'list.count', { count: items.length }) : '—'}
          tools={rowsSelect}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <Button size="sm" variant="primary" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
            ),
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          more={model.list.more && items && items.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          onOpen={(row) => actions?.onOpen?.(row.id)}
          state={state}
          focusRow={model.focusRow}
        />
      </section>

      {model.dialog?.kind === 'fromDdts' && <FromDdtsDialog model={model} actions={actions} shipped={shipped ?? []} />}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('list.keysTitle')} size="sm">
          <ul className="fw-fin-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}

/** The types these DDTs may take together, the rule's first (one DDT in its 12 days: TD01; else one month's TD24). */
function allowedTypes(ddts: readonly ShippedRow[]): Array<'TD01' | 'TD24'> {
  if (ddts.length === 0) return []
  const monthLate = ddts[0]!.monthDeadline?.state === 'LATE'
  const allowed: Array<'TD01' | 'TD24'> = []
  if (ddts.length === 1 && (ddts[0]!.immediate.state !== 'LATE' || monthLate)) allowed.push('TD01')
  if (!monthLate) allowed.push('TD24')
  return suggestedType(ddts) === 'TD24' ? allowed.sort((a) => (a === 'TD24' ? -1 : 1)) : allowed
}

/**
 * "Invoice shipped goods" (design popup from-shipments): the customer, the DDTs chosen (one month), the type (preset by
 * the rule; the other while it is in time), what it bills and the deposit paid on its orders (the draft deducts every
 * issued deposit invoice of them). Create draft opens the record.
 */
function FromDdtsDialog({ model, actions, shipped }: { model: InvoicesListModel; actions?: InvoicesListActions; shipped: readonly ShippedRow[] }) {
  const t = useT('finance')
  const locale = useLocale()
  const start = model.dialog?.kind === 'fromDdts' ? model.dialog : null
  const customers = model.queue.value?.customers ?? []
  const [partyId, setPartyId] = useState<string>(start?.partyId ?? (customers.length === 1 ? customers[0]!.partyId : ''))
  const ofCustomer = shipped.filter((row) => row.partyId === partyId && ddtHeld(row) === null)
  const [picked, setPicked] = useState<string[]>(start?.ddtIds.length ? start.ddtIds : ofCustomer.length === 1 ? [ofCustomer[0]!.ddtId] : [])
  const chosen = ofCustomer.filter((row) => picked.includes(row.ddtId))
  const allowed = allowedTypes(chosen)
  const [docType, setDocType] = useState<'TD01' | 'TD24' | null>(model.draftType ?? null)
  const type = docType && allowed.includes(docType) ? docType : (allowed[0] ?? null)
  const wait = selectionHeld(chosen)
  const held = model.busy ? t('held.busy') : !partyId ? t('held.pickCustomer') : wait ? t(wait.key) : type === null ? t('held.lateEach') : null
  const value = chosen.reduce((sum, row) => sum + (row.valueAmount ?? 0), 0)
  const orders = [...new Map(chosen.flatMap((row) => row.orders.map((order) => [order.id, order] as const))).values()]
  const deposit = chosen.reduce((max, row) => Math.max(max, row.depositPaidAmount ?? 0), 0)
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const go = () => {
    if (type) actions?.onCreateFromDdts?.({ ddtIds: chosen.map((row) => row.ddtId), docType: type })
  }
  return (
    <DialogFrame title={t('fromDdts.title')} held={held} go={go} goLabel={model.busy ? t('common.working') : t('fromDdts.go')} onClose={() => actions?.onDialog?.(null)} problem={model.dialogProblem} size="lg">
      <p className="fw-fin-hint">{t('fromDdts.body')}</p>
      <Select
        size="sm"
        aria-label={t('fromDdts.customer')}
        value={partyId}
        onChange={(event) => {
          setPartyId(event.target.value)
          setPicked([])
        }}
      >
        <option value="">{t('fromDdts.pickCustomer')}</option>
        {customers.map((customer) => (
          <option key={`${customer.partyId}|${customer.companyId}`} value={customer.partyId}>
            {customer.legalName} · {t('fromDdts.ddtCount', { count: customer.ddts.length })}
          </option>
        ))}
      </Select>
      {partyId && (
        <fieldset className="fw-fin-choices">
          <legend className="fw-fin-legend">{t('fromDdts.ddts')}</legend>
          {ofCustomer.length === 0 ? (
            <p className="fw-fin-hint">{t('fromDdts.noneLeft')}</p>
          ) : (
            ofCustomer.map((row) => {
              const deadline = row.immediate.state !== 'LATE' || !row.monthDeadline ? row.immediate : row.monthDeadline
              const words = deadlineWords(deadline)
              return (
                <Checkbox
                  key={row.ddtId}
                  checked={picked.includes(row.ddtId)}
                  onChange={(event) => setPicked((current) => (event.target.checked ? [...current, row.ddtId] : current.filter((id) => id !== row.ddtId)))}
                  label={`${t('shipped.ddt', { number: row.number })} · ${day(row.date)} · ${t('shipped.pieces', { count: ddtLeft(row).toInvoice })} · ${t(words.key, words.params)}`}
                />
              )
            })
          )}
        </fieldset>
      )}
      {chosen.length > 0 && (
        <fieldset className="fw-fin-choices">
          <legend className="fw-fin-legend">{t('fromDdts.type')}</legend>
          {(['TD01', 'TD24'] as const).map((option) => (
            <RadioCard
              key={option}
              name="fw-fin-type"
              value={option}
              checked={type === option}
              selected={type === option}
              disabled={!allowed.includes(option)}
              onChange={() => setDocType(option)}
              title={`${t(`shipType.${option}`)} · ${option}`}
              description={allowed.includes(option) ? t(`fromDdts.typeWhy.${option}`) : t(option === 'TD01' ? 'fromDdts.td01Not' : 'fromDdts.td24Not')}
            />
          ))}
        </fieldset>
      )}
      {chosen.length > 0 && (
        <KeyValue
          dense
          labelCase="sentence"
          columns={2}
          items={[
            { label: t('fromDdts.orders'), value: orders.map((order) => order.number).join(', ') || '—' },
            ...(model.can.price ? [{ label: t('fromDdts.value'), value: money(value, 'EUR', locale), hint: t('fromDdts.valueHint') }] : []),
            ...(model.can.price ? [{ label: t('fromDdts.deposit'), value: deposit > 0 ? money(deposit, 'EUR', locale) : t('shipped.noDeposit'), hint: deposit > 0 ? t('fromDdts.depositHint') : undefined }] : []),
          ]}
        />
      )}
      {chosen.length > 1 && <Tag tone="info">{t('fromDdts.deferredNote')}</Tag>}
    </DialogFrame>
  )
}
