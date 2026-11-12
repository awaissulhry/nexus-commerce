'use client'

import { useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { ExternalLink, FileText, MoreHorizontal, PackageSearch } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select } from '@nexus/ui/primitives'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { KIND_WORDS } from '@nexus/factory-domain/sales/samples/rules'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { money } from '../../../_shared/buying/model'
import { pdfHref, recordHref, type SampleRow } from '../api'
import { isFiltered, itemsText, STATUS_FILTERS, styleText } from '../model'
import type { SourcingPageActions, SourcingPageModel } from '../view-model'
import { PAGE_KEYS, SectionFailed, SectionHead, SectionLoading, StatusPill, useDay, useWords } from './parts'

/**
 * Sample and development orders (design sec samples; SCM-043): every purchase order of kind SAMPLE the person reaches, as the
 * list frame — Number (opens the PO record of type Sample), Supplier, Project (the style and the sample round it buys for), Items
 * (what it buys, in the supplier's words), Status, and Cost (the cost grain: not drawn without it, said in Columns ▾) — with ⋯
 * Open, Open in a new tab and the Sample order PDF (a new tab; held without the cost grain). Its filters (open or every one, a
 * status, the words typed) are the address's and the API's own. Selecting rows offers the frame's Export N (the orders are sent
 * one by one from their record: no bulk send here). Not counted in production spend: the page says so.
 */
export function SamplesSection({ model, actions, onHelp }: { model: SourcingPageModel; actions?: SourcingPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const day = useDay()
  const locale = useLocale()
  const { address, can } = model
  const answer = model.orders.status === 'ready' ? model.orders.value : null
  const rows = useMemo(() => (answer ? [...answer.orders, ...model.more] : null), [answer, model.more])
  const selected = model.selected
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.id === id))) actions?.onSelected?.(selected.filter((id) => rows.some((row) => row.id === id)))
  }, [rows, selected, actions])
  const live = useRef({ can, prefix: model.prefix })
  live.current = { can, prefix: model.prefix }

  const columns = useMemo<ColDef<SampleRow>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<SampleRow>) =>
      data ? (
        <span className="fw-src-cell">
          <Link className="fw-src-link" href={recordHref(live.current.prefix, data.id)}>
            {data.number}
          </Link>
          <span className="fw-src-muted">{day(data.orderDate)}</span>
        </span>
      ) : null
    const ProjectCell = ({ data }: ICellRendererParams<SampleRow>) =>
      data ? (
        <span className="fw-src-cell">
          <span>{styleText(data)}</span>
          <span className="fw-src-muted">{data.round ? t('project.round', { number: data.round.number, kind: KIND_WORDS[data.round.kind][locale === 'en' ? 'en' : 'it'], round: data.round.roundNo }) : t('project.styleOnly')}</span>
        </span>
      ) : null
    const ItemsCell = ({ data }: ICellRendererParams<SampleRow>) =>
      data ? (
        <span className="fw-src-cell">
          <span>{data.items.length > 0 ? itemsText(data) : t('items.none')}</span>
          {data.lineCount > data.items.length && <span className="fw-src-muted">{t('items.more', { count: data.lineCount - data.items.length })}</span>}
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<SampleRow>) => (data ? <StatusPill status={data.status} /> : null)
    const MoreCell = ({ data }: ICellRendererParams<SampleRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('row.open'), href: recordHref(live.current.prefix, data.id) },
            { id: 'tab', label: t('row.openNewTab'), icon: <ExternalLink size={14} aria-hidden />, href: recordHref(live.current.prefix, data.id), target: '_blank' },
            live.current.can.cost
              ? { id: 'pdf', label: t('row.pdf'), description: data.sentAt ? t('row.pdfSent') : t('row.pdfDraft'), icon: <FileText size={14} aria-hidden />, href: pdfHref(data.id), target: '_blank' }
              : { id: 'pdf', label: t('row.pdf'), icon: <FileText size={14} aria-hidden />, disabled: true, description: t('held.pdfCost') },
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('col.number'), field: 'number', minWidth: 140, flex: 0.9, cellRenderer: NumberCell },
      { colId: 'supplier', headerName: t('col.supplier'), field: 'supplierName', minWidth: 170, flex: 1.3 },
      { colId: 'project', headerName: t('col.project'), minWidth: 220, flex: 1.6, valueGetter: (params) => (params.data ? styleText(params.data) : ''), cellRenderer: ProjectCell },
      { colId: 'items', headerName: t('col.items'), minWidth: 240, flex: 2, valueGetter: (params) => (params.data ? itemsText(params.data) : ''), cellRenderer: ItemsCell },
      { colId: 'status', headerName: t('col.status'), field: 'status', minWidth: 150, flex: 0.9, cellRenderer: StatusCell },
      ...(can.cost
        ? ([{ colId: 'value', headerName: t('col.value'), field: 'netAmount', minWidth: 120, flex: 0.8, type: 'rightAligned', valueFormatter: (params) => (params.data ? money(params.data.netAmount ?? null, params.data.currency, locale) : '') }] satisfies ColDef<SampleRow>[])
        : []),
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, day, locale, can.cost])

  const search = <Input size="sm" type="search" value={address.q} placeholder={t('list.search')} aria-label={t('list.search')} onChange={(event) => actions?.onAddress?.({ q: event.target.value })} />
  const statusValue = address.status ?? (address.rows === 'ALL' ? 'ALL' : 'OPEN')
  const filters = (
    <Select
      size="sm"
      value={statusValue}
      aria-label={t('list.filterStatus')}
      onChange={(event) => {
        const value = event.target.value
        actions?.onAddress?.(value === 'OPEN' || value === 'ALL' ? { rows: value, status: null } : { rows: 'ALL', status: value as PurchaseOrderStatus })
      }}
    >
      <option value="OPEN">{t('rows.OPEN')}</option>
      <option value="ALL">{t('rows.ALL')}</option>
      {STATUS_FILTERS.map((status) => (
        <option key={status} value={status}>
          {t(`status.${status}`)}
        </option>
      ))}
    </Select>
  )

  const head = <SectionHead id="fw-src-samples" title={t('samples.title')} note={t('samples.note')} />

  if (model.orders.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('samples.failed')} problem={model.orders.problem} onRetry={actions?.onRetry} />
      </>
    )
  }
  if (!answer || !rows) {
    return (
      <>
        {head}
        <SectionLoading />
      </>
    )
  }

  const addHeld = can.manage ? (model.companyId ? null : t('held.company')) : t('held.manage')
  return (
    <>
      {head}
      <ListFrame<SampleRow>
        label={t('samples.title')}
        title={t('samples.title')}
        listKey="purchasing.sourcing"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('list.count', { count: rows.length })}
        search={search}
        tools={filters}
        selection={{
          selected,
          onChange: (ids) => actions?.onSelected?.(ids),
          // The frame's Export N is the bulk action: a sample order is sent from its own record, one by one.
          exportSelected: true,
          actions: null,
        }}
        withheld={can.cost ? [] : [{ label: t('col.value'), reason: t('held.valueCost') }]}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpenRecord?.(row.id)}
        more={answer.nextCursor ? { label: t('list.more'), onMore: () => actions?.onMore?.(), held: model.moreBusy ? t('held.busy') : null } : null}
        state={
          rows.length === 0 ? (
            isFiltered(address) ? (
              <EmptyState
                icon={<PackageSearch size={22} aria-hidden />}
                title={t('list.noneFiltered')}
                description={t('list.noneFilteredHint')}
                action={
                  <Button size="sm" onClick={() => actions?.onAddress?.({ rows: 'OPEN', status: null, q: '' })}>
                    {t('list.clearFilters')}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<PackageSearch size={22} aria-hidden />}
                title={t('list.emptyTitle')}
                description={t('list.empty')}
                action={
                  <Button size="sm" variant="primary" heldReason={addHeld} onClick={() => actions?.onAddress?.({ add: true })}>
                    {t('band.add')}
                  </Button>
                }
              />
            )
          ) : undefined
        }
        cards={{ fields: { number: { role: 'title' }, project: { role: 'subtitle' }, status: { role: 'aside' } } }}
      />
    </>
  )
}
