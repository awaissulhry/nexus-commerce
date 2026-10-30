'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Search } from 'lucide-react'
import { EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { LotRow } from '../../../../_shared/stock/api'
import { CR_VI_TONE, daysSince, lotWaitKey, movesHref, quantity } from '../../../../_shared/stock/model'
import { Dual, NoAccess, QualityPill, Qty } from '../../../../_shared/stock/parts'
import { LOT_MENU_VIEWS, LOT_TILES, type LotsListActions, type LotsListModel, type LotView } from '../../model'
import { KeysModal, LotsMessages, useWords } from '../../shared/parts'

export type { LotsListActions, LotsListModel } from '../../model'

/**
 * SCR-201 — Lots & traceability (Warehouse › Main; design warehouse.lots, lt-metrics + lt-grid): the tiles that wait for
 * someone (in quarantine, waiting for Cr VI evidence, Cr VI failed, blocked — each a saved view, so goods on hold are
 * reached here, Owner answer Q3), and every lot on the shared list frame: code, material and colour, supplier and their
 * lot, dye batch and shade, when and with which receipt it came (or opening stock), its quality and why it waits, Cr VI
 * against its limit, the evidence and documents, what is on hand (hides and area for leather), the work orders it went
 * to and its age. `/` searches or takes a scanned lot label (one hit opens the lot). Export N; the decisions stay in
 * Compliance › Tests & substances (row ⋯).
 */
export function LotsListView({ model, actions }: { model: LotsListModel; actions?: LotsListActions }) {
  return (
    <LotsMessages>
      <LotsList model={model} actions={actions} />
    </LotsMessages>
  )
}

function LotsList({ model, actions }: { model: LotsListModel; actions?: LotsListActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [query, setQuery] = useState(model.q)
  useEffect(() => setQuery(model.q), [model.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const rowsKey = model.rows.items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected, model.view])

  const columns = useMemo<ColDef<LotRow>[]>(() => {
    const href = (row: LotRow) => `${model.prefix}/warehouse/lots/${encodeURIComponent(row.id)}`
    const LotCell = ({ data }: ICellRendererParams<LotRow>) =>
      data ? (
        <span className="fw-st-cell">
          <Link className="fw-st-link fw-wl-code" href={href(data)}>
            {data.code}
          </Link>
          <span className="fw-st-sub">{data.siteCode}</span>
        </span>
      ) : null
    const MaterialCell = ({ data }: ICellRendererParams<LotRow>) => {
      if (!data) return null
      const main = `${data.item.code} · ${data.item.name}`
      const sub = [data.colour ? `${data.colour.code} ${data.colour.name}` : t('lt.noColour'), data.dyeBatch, data.shade ? t('lt.shade', { shade: data.shade }) : null].filter(Boolean).join(' · ')
      return (
        <span className="fw-st-cell" title={`${main}\n${sub}`}>
          <span className="fw-st-ellipsis">{main}</span>
          <span className="fw-st-sub">{sub}</span>
        </span>
      )
    }
    const SupplierCell = ({ data }: ICellRendererParams<LotRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis" title={data.supplier?.name ?? undefined}>
            {data.supplier?.name ?? t('lt.noSupplier')}
          </span>
          <span className="fw-st-sub">{data.supplierLotRef ? t('lt.supplierLot', { ref: data.supplierLotRef }) : '—'}</span>
        </span>
      ) : null
    const ReceivedCell = ({ data }: ICellRendererParams<LotRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-num" title={data.receivedAt ? t('lt.age', { count: daysSince(data.receivedAt) ?? 0 }) : undefined}>
            {data.receivedAt ? formatDate(data.receivedAt, place) : '—'}
          </span>
          <span className="fw-st-sub">
            {data.receipt ? (
              <Link className="fw-st-link" href={`${model.prefix}/warehouse/receipts/${encodeURIComponent(data.receipt.id)}`}>
                {data.receipt.number}
              </Link>
            ) : data.opening ? (
              t('lt.opening')
            ) : (
              '—'
            )}
            {data.receivedAt ? ` · ${t('lt.ageShort', { count: daysSince(data.receivedAt) ?? 0 })}` : ''}
          </span>
        </span>
      ) : null
    const QualityCell = ({ data }: ICellRendererParams<LotRow>) => {
      if (!data) return null
      const wait = lotWaitKey(data)
      return (
        <span className="fw-st-cell">
          <span>
            <QualityPill status={data.qualityStatus} />
          </span>
          {wait && <span className="fw-st-sub" title={t(`stock:${wait}`)}>{t(`stock:${wait}`)}</span>}
        </span>
      )
    }
    // In the Cr VI column the pill says only the verdict (the header names the test), the value against its limit below.
    const CrViCell = ({ data }: ICellRendererParams<LotRow>) => {
      if (!data) return null
      if (!data.crVi.required && data.crVi.status === 'NOT_REQUIRED') return <span className="fw-st-sub">{t('stock:crVi.NOT_REQUIRED')}</span>
      const value = data.crVi.valueMgKg && data.crVi.limitMgKg ? t(data.crVi.status === 'FAIL' ? 'stock:crVi.valueFail' : 'stock:crVi.value', { value: quantity(data.crVi.valueMgKg, locale, 3), limit: quantity(data.crVi.limitMgKg, locale, 3) }) : null
      return (
        <span className="fw-st-cell">
          <span>
            <Pill tone={CR_VI_TONE[data.crVi.status]}>{t(`lt.crViShort.${data.crVi.status}`)}</Pill>
          </span>
          {value && <span className="fw-st-sub">{value}</span>}
        </span>
      )
    }
    const EvidenceCell = ({ data }: ICellRendererParams<LotRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className={data.crVi.required && !data.crVi.evidence ? 'fw-st-warning' : undefined}>{data.crVi.evidence ? t(`stock:evidence.${data.crVi.evidence}`) : data.crVi.required ? t('stock:evidence.missing') : '—'}</span>
          <span className="fw-st-sub">{t('lt.documents', { count: data.documents })}</span>
        </span>
      ) : null
    const OnHandCell = ({ data }: ICellRendererParams<LotRow>) =>
      data ? data.item.tracking === 'HIDE' ? <Dual hides={data.hides} area={data.onHand} uom={data.item.baseUom} both /> : <Qty value={data.onHand} uom={data.item.baseUom} /> : null
    const IssuedCell = ({ data }: ICellRendererParams<LotRow>) => (data ? <span className="fw-st-num" title={data.issuedTo === 0 ? undefined : t('lt.issuedTo', { count: data.issuedTo })}>{data.issuedTo === 0 ? '—' : String(data.issuedTo)}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<LotRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('lt.rowMenu', { code: data.code }) }}
          items={[
            { id: 'open', label: t('rec.open'), href: href(data) },
            { id: 'tab', label: t('rec.openNewTab'), href: href(data), target: '_blank' },
            { id: 'trace', label: t('lt.tab.trace'), href: `${href(data)}?tab=trace` },
            ...(model.can.lotsView ? [{ id: 'decide', label: t('lt.decide'), href: `${model.prefix}/compliance/tests/${encodeURIComponent(data.id)}?tab=release` }] : []),
            { id: 'moves', label: t('lt.openMoves'), href: movesHref(model.prefix, { siteId: data.siteId, itemId: data.item.id, lotId: data.id }) },
            ...(data.receipt ? [{ id: 'receipt', label: t('lt.openReceipt', { number: data.receipt.number }), href: `${model.prefix}/warehouse/receipts/${encodeURIComponent(data.receipt.id)}` }] : []),
          ]}
        />
      ) : null
    return [
      { colId: 'lot', headerName: t('lt.col.lot'), minWidth: 120, flex: 0.8, cellRenderer: LotCell },
      { colId: 'material', headerName: t('lt.col.material'), minWidth: 170, flex: 1.5, cellRenderer: MaterialCell },
      { colId: 'supplier', headerName: t('lt.col.supplier'), minWidth: 140, flex: 1.1, cellRenderer: SupplierCell },
      { colId: 'received', headerName: t('lt.col.received'), minWidth: 120, flex: 0.8, cellRenderer: ReceivedCell },
      { colId: 'quality', headerName: t('lt.col.quality'), minWidth: 160, flex: 1.3, cellRenderer: QualityCell },
      { colId: 'crVi', headerName: t('lt.col.crVi'), minWidth: 115, flex: 0.9, cellRenderer: CrViCell },
      { colId: 'evidence', headerName: t('lt.col.evidence'), minWidth: 120, flex: 0.8, cellRenderer: EvidenceCell },
      { colId: 'onHand', headerName: t('lt.col.onHand'), minWidth: 150, flex: 0.9, type: 'rightAligned', cellRenderer: OnHandCell },
      { colId: 'issued', headerName: t('lt.col.issued'), minWidth: 90, flex: 0.6, type: 'rightAligned', cellRenderer: IssuedCell },
      { colId: 'more', headerName: t('rec.actions'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.can.lotsView, model.timeZone])

  if (!model.can.stockView) {
    return (
      <div className="fw-st">
        <NoAccess permission="inventory.stock.view" />
      </div>
    )
  }

  const tileView = LOT_TILES.find((tile) => tile.view === model.view)?.view ?? null
  const picked = (model.rows.items ?? []).filter((row) => selected.includes(row.id))
  const filtered = model.q.trim() !== '' || model.view !== 'all'
  const ownKeys: ListKey[] = []
  const clearFilters = (
    <Button
      size="sm"
      onClick={() => {
        setQuery('')
        actions?.onSearch?.('')
        actions?.onView?.('all')
      }}
    >
      {t('stock:common.clearFilters')}
    </Button>
  )
  const state = model.rows.problem ? (
    <EmptyState title={t('lt.list.failed')} description={t(`stock:${model.rows.problem}`)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('rec.retry')}</Button>} />
  ) : model.rows.items && model.rows.items.length === 0 ? (
    filtered ? (
      <EmptyState title={t('lt.list.noMatch')} description={t('stock:common.noMatch')} action={clearFilters} />
    ) : (
      <EmptyState
        title={t('lt.list.empty')}
        description={t('lt.list.emptyBody')}
        action={
          model.can.receive ? (
            <Button size="sm" variant="primary" asChild>
              <Link href={`${model.prefix}/warehouse/receipts/new`}>{t('lt.list.receive')}</Link>
            </Button>
          ) : undefined
        }
      />
    )
  ) : undefined

  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('lt.list.search')}
      placeholder={t('lt.list.search')}
      value={query}
      onChange={(event) => {
        typed.current = true
        setQuery(event.target.value)
      }}
    />
  )
  const tools = (
    <>
      <Select size="sm" aria-label={t('lt.list.viewLabel')} value={model.view} onChange={(event) => actions?.onView?.(event.target.value as LotView)}>
        {LOT_MENU_VIEWS.map((view) => (
          <option key={view} value={view}>
            {t(`lt.view.${view}`)}
          </option>
        ))}
      </Select>
      {model.sites.length > 1 && (
        <Select size="sm" aria-label={t('stock:common.site')} value={model.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value || null)}>
          <option value="">{t('stock:common.allSites')}</option>
          {model.sites.map((site) => (
            <option key={site.id} value={site.id}>
              {`${site.code} · ${site.name}`}
            </option>
          ))}
        </Select>
      )}
    </>
  )

  return (
    <div className="fw-st">
      <div className="fw-st-head">
        <span className="fw-wl-status" role="status">
          {model.asOf ? t('stock:live.updated', { time: formatTime(model.asOf, place) }) : t('rec.notYet')}
          {' · '}
          {t(`stock:live.${model.live}`)}
        </span>
      </div>

      <MetricStrip
        metrics={LOT_TILES.map((tile) => {
          const count = tile.count(model.counts)
          return {
            label: t(`lt.tile.${tile.id}`),
            value: count === null ? '—' : String(count),
            hint: t(`lt.tileHint.${tile.id}`),
            onClick: () => actions?.onView?.(model.view === tile.view ? 'all' : tile.view),
            active: tileView === tile.view,
          }
        })}
      />

      <ListFrame<LotRow>
        label={t('lt.list.tableLabel')}
        rows={state ? [] : model.rows.items}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows.items ? t(model.rows.more ? 'lt.list.countMore' : 'lt.list.count', { count: model.rows.items.length }) : '—'}
        search={search}
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('stock:common.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('stock:common.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && model.rows.items && model.rows.items.length > 0 ? { label: t('rec.showMore'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
      />
      <p className="fw-wl-hint">{t('lt.list.decideWhere')}</p>

      {help && <KeysModal own={ownKeys} onClose={() => setHelp(false)} />}
    </div>
  )
}
