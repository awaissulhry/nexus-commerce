'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, PackageCheck, Search, SlidersHorizontal, Upload, X } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { recordAddress } from '../../../../lib/records/record-links'
import { money, movesHref, unitCost, unitTotals } from '../../../_shared/stock/model'
import { Dual, NoAccess, QualityPill, Qty, ReadFailed, StockMessages, useUnitWord } from '../../../_shared/stock/parts'
import { AdjustDialog } from '../adjust/AdjustDialog'
import type { AdjustActions } from '../adjust/model'
import { adjustHeldKey, hidesOf, onHandPerUnit, scanTarget, STOCK_TILES, STOCK_VIEWS, stockNotices, tileCount, tileStock, valueOf, visibleLines, type StockLine, type StockPageActions, type StockPageModel, type StockTile, type StockViewKey } from '../model'
import '../../../_shared/stock/stock.css'
import '../stock-pages.css'

export type { StockPageActions, StockPageModel } from '../model'

/**
 * SCR-060 — Stock (Warehouse › Main; design warehouse.stock): the status (updated · live) and the site, the notices
 * (the most serious first, the rest behind "n more"), three tiles that are saved filters (lots in quarantine, waiting
 * for their Cr VI result, blocked or rejected — each with the stock they hold, per unit), and the ONE list frame of stock
 * by material, colour, lot and place (views: by material, by lot, by place, leather one row per hide, on hold). Every
 * on-hand figure opens Movements for that stock key, explained. Values only with the cost grain (the columns are absent
 * otherwise). Adjust stock (a) is one row at a time and says so; the selection exports. Totals per unit, never across.
 */
export function StockView({ model, actions, adjustActions }: { model: StockPageModel; actions?: StockPageActions; adjustActions?: AdjustActions }) {
  return (
    <StockMessages extra={['warehouse-stock']}>
      <Stock model={model} actions={actions} adjustActions={adjustActions} />
    </StockMessages>
  )
}

const focusedRowId = (): string | null => (typeof document === 'undefined' ? null : ((document.activeElement as HTMLElement | null)?.closest('.ag-row')?.getAttribute('row-id') ?? null))

function Stock({ model, actions, adjustActions }: { model: StockPageModel; actions?: StockPageActions; adjustActions?: AdjustActions }) {
  const t = useT('warehouse-stock')
  const s = useT('stock')
  const lists = useT('lists')
  const locale = useLocale()
  const unitWord = useUnitWord()
  const place = { locale, timeZone: model.timeZone }
  const { address, can } = model
  const [query, setQuery] = useState(address.q)
  useEffect(() => setQuery(address.q), [address.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onAddress?.({ q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const [moreNotices, setMoreNotices] = useState(false)
  const crViLots = useMemo(() => new Set(model.crViLots), [model.crViLots])
  const lines = useMemo(() => (model.rows ? visibleLines(model.rows, address, can.cost, crViLots) : null), [model.rows, address, can.cost, crViLots])
  const lineIds = lines?.map((line) => line.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => lineIds.includes(id))), [lineIds])
  useEffect(() => setSelected(model.selected ?? []), [model.selected, address.view])
  const lineOf = (id: string | null) => (id ? (lines?.find((line) => line.id === id) ?? null) : null)
  const picked = (lines ?? []).filter((line) => selected.includes(line.id))
  const adjustLine = picked.length === 1 ? picked[0]! : null
  const several = (model.rows ?? []).some((row) => row.siteId !== model.rows?.[0]?.siteId) || model.sites.length > 1

  // a: adjust the focused row (else the one selected); the list frame owns the other keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.adjust) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key !== 'a') return
      const line = lineOf(focusedRowId()) ?? adjustLine
      if (!line || adjustHeldKey(line, can)) return
      event.preventDefault()
      actions?.onAdjust?.(line)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const currency = (line: StockLine) => model.currencies?.[line.item.id] ?? null
  const columns = useMemo<ColDef<StockLine>[]>(() => {
    const lotHref = (id: string) => `${model.prefix}${recordAddress({ type: 'Lot', id }, OFFICE_PAGES)}`
    const hideHref = (id: string) => `${model.prefix}${recordAddress({ type: 'Hide', id }, OFFICE_PAGES)}`
    const keyOf = (line: StockLine) => ({ siteId: line.siteId, itemId: line.item.id, itemColourId: line.colour?.id, lotId: line.lot?.id, hideId: line.hide?.id, locationId: line.location.id, why: true })
    const MaterialCell = ({ data }: ICellRendererParams<StockLine>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis" title={`${data.item.code} · ${data.item.name}`}>
            {data.item.code} · {data.item.name}
          </span>
          <span className="fw-st-sub">{data.colour ? `${data.colour.code} ${data.colour.name}` : t(`st.tracking.${data.item.tracking}`)}</span>
        </span>
      ) : null
    const LotCell = ({ data }: ICellRendererParams<StockLine>) =>
      data ? (
        data.lot ? (
          <span className="fw-st-cell">
            <Link className="fw-st-link" href={lotHref(data.lot.id)}>
              {data.lot.code}
            </Link>
            {data.hide ? (
              <Link className="fw-st-link fw-st-sub" href={hideHref(data.hide.id)}>
                {data.hide.code}
              </Link>
            ) : (
              <span className="fw-st-sub">{data.hides > 0 ? s('hides', { count: data.hides }) : ''}</span>
            )}
          </span>
        ) : (
          <span className="fw-st-sub">{t('st.noLot')}</span>
        )
      ) : null
    const QualityCell = ({ data }: ICellRendererParams<StockLine>) => {
      if (!data) return null
      if (!data.lot) return <span className="fw-st-sub">{t('st.noQuality')}</span>
      const wait = data.lot.qualityStatus === 'RELEASED' ? null : crViLots.has(data.lot.id) ? 'wait.crVi' : data.lot.qualityStatus === 'QUARANTINE' ? 'wait.release' : data.lot.qualityStatus === 'BLOCKED' ? 'wait.blocked' : 'wait.rejected'
      return (
        <span className="fw-st-cell">
          <span>
            <QualityPill status={data.lot.qualityStatus} />
          </span>
          {wait && (
            <span className="fw-st-sub" title={s(wait)}>
              {s(wait)}
            </span>
          )}
        </span>
      )
    }
    const LocationCell = ({ data }: ICellRendererParams<StockLine>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis">{data.location.code}</span>
          <span className="fw-st-sub">{several ? `${data.siteCode} · ${data.location.name}` : data.location.name}</span>
        </span>
      ) : null
    const OnHandCell = ({ data }: ICellRendererParams<StockLine>) =>
      data ? (
        <Link className="fw-st-link" href={movesHref(model.prefix, keyOf(data))} title={t('st.onHandLink')}>
          {data.item.tracking === 'HIDE' && !data.hide ? <Dual hides={data.hides} area={data.onHand} uom={data.item.baseUom} /> : <Qty value={data.onHand} uom={data.item.baseUom} strong />}
        </Link>
      ) : null
    const qty = (pick: (line: StockLine) => string) => ({ data }: ICellRendererParams<StockLine>) => (data ? <Qty value={pick(data)} uom={data.item.baseUom} /> : null)
    const UnitCostCell = ({ data }: ICellRendererParams<StockLine>) => (data ? <span className="fw-st-num">{unitCost(data.unitCost, currency(data), locale)}</span> : null)
    const ValueCell = ({ data }: ICellRendererParams<StockLine>) => (data ? <span className="fw-st-num">{money(data.value, currency(data), locale)}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<StockLine>) => {
      if (!data) return null
      const held = adjustHeldKey(data, can)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('st.rowMenu', { material: data.item.code, place: data.location.code }) }}
          items={[
            ...(data.lot ? [{ id: 'lot', label: t('st.openLot', { code: data.lot.code }), href: lotHref(data.lot.id) }] : []),
            ...(data.hide ? [{ id: 'hide', label: t('st.openHide', { code: data.hide.code }), href: hideHref(data.hide.id) }] : []),
            { id: 'moves', label: t('st.showMoves'), href: movesHref(model.prefix, keyOf(data)) },
            { id: 'adjust', label: t('st.adjustRow'), disabled: !!held, ...(held ? { description: t(held) } : {}), onSelect: () => !held && actions?.onAdjust?.(data) },
          ]}
        />
      )
    }
    return [
      { colId: 'material', headerName: t('st.col.material'), minWidth: 190, flex: 1.5, cellRenderer: MaterialCell },
      { colId: 'lot', headerName: t('st.col.lot'), minWidth: 165, flex: 1.1, cellRenderer: LotCell },
      { colId: 'quality', headerName: t('st.col.quality'), minWidth: 110, flex: 0.7, cellRenderer: QualityCell },
      { colId: 'location', headerName: t('st.col.location'), minWidth: 120, flex: 0.9, cellRenderer: LocationCell },
      { colId: 'onHand', headerName: t('st.col.onHand'), minWidth: 125, flex: 0.9, type: 'rightAligned', cellRenderer: OnHandCell },
      { colId: 'held', headerName: t('st.col.held'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: qty((line) => line.held) },
      { colId: 'available', headerName: t('st.col.available'), minWidth: 125, flex: 0.7, type: 'rightAligned', cellRenderer: qty((line) => line.available) },
      ...(can.cost
        ? ([
            { colId: 'unitCost', headerName: s('money.unitCost'), minWidth: 130, flex: 0.7, type: 'rightAligned', cellRenderer: UnitCostCell },
            { colId: 'value', headerName: s('money.value'), minWidth: 105, flex: 0.7, type: 'rightAligned', cellRenderer: ValueCell },
          ] satisfies ColDef<StockLine>[])
        : []),
      { colId: 'more', headerName: t('st.col.actions'), minWidth: 80, maxWidth: 80, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, s, locale, model.prefix, can, crViLots, several, model.currencies])

  if (!can.stockView) {
    return (
      <div className="fw-st">
        <NoAccess permission="inventory.stock.view" />
      </div>
    )
  }

  const notices = stockNotices(model.counts, model.truncated, can.cost ? model.unvalued : null).filter((notice) => !model.dismissed.includes(notice.id))
  const [firstNotice, ...otherNotices] = notices
  const tileWords = (tile: StockTile) => {
    const count = tileCount(tile, model.counts)
    return count === null ? '—' : s('lots', { count })
  }

  const filtered = address.q.trim() !== '' || address.tile !== null || address.view === 'quarantine' || address.view === 'lot' || address.view === 'leather'
  const clearFilters = (
    <Button
      size="sm"
      onClick={() => {
        setQuery('')
        actions?.onAddress?.({ q: '', tile: null, view: 'material' })
      }}
    >
      {s('common.clearFilters')}
    </Button>
  )
  const state = model.problem ? (
    <ReadFailed problem={model.problem} onRetry={() => actions?.onRetry?.()} />
  ) : model.rows && model.rows.length === 0 ? (
    <EmptyState
      icon={<PackageCheck size={22} aria-hidden />}
      title={t('st.empty.title')}
      description={t('st.empty.body')}
      action={
        <span className="fw-st-actions">
          {can.receive && (
            <Button size="sm" variant="primary" asChild>
              <Link href={`${model.prefix}/warehouse/receipts`}>{t('st.empty.receive')}</Link>
            </Button>
          )}
          {can.openingImport && (
            <Button size="sm" asChild>
              <Link href={`${model.prefix}/admin/import?importer=inventory.opening`}>{t('st.importOpening')}</Link>
            </Button>
          )}
        </span>
      }
    />
  ) : lines && lines.length === 0 ? (
    <EmptyState title={s('common.noMatch')} action={filtered ? clearFilters : undefined} />
  ) : undefined

  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('st.search')}
      placeholder={t('st.search')}
      value={query}
      onChange={(event) => {
        typed.current = true
        setQuery(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          typed.current = false
          // A scanned (or typed) hide tag or lot code that names one record opens it; anything else filters.
          const hit = model.rows ? scanTarget(model.rows, query) : null
          if (hit) latest.current?.onOpenRecord?.(hit.type, hit.id)
          else latest.current?.onAddress?.({ q: query })
        }
      }}
    />
  )
  const tools = (
    <span className="fw-st-actions">
      <Select size="sm" aria-label={t('st.viewLabel')} value={address.view} onChange={(event) => actions?.onAddress?.({ view: event.target.value as StockViewKey })}>
        {STOCK_VIEWS.map((view) => (
          <option key={view} value={view}>
            {t(`st.view.${view}`)}
          </option>
        ))}
      </Select>
      {address.tile && (
        <Button size="sm" variant="tonal" onClick={() => actions?.onAddress?.({ tile: null })} aria-label={t('st.removeChip', { chip: t(`st.tile.${address.tile}`) })}>
          {t(`st.tile.${address.tile}`)} <X size={12} aria-hidden />
        </Button>
      )}
    </span>
  )
  const filterTotals = lines ? unitTotals(onHandPerUnit(lines), unitWord, locale) : '—'
  const pickedTotals = unitTotals(onHandPerUnit(picked), unitWord, locale)
  const value = can.cost && lines ? valueOf(lines, currency) : null
  const ownKeys: ListKey[] = [{ keys: ['a'], does: t('st.keyAdjust') }]
  const adjustHeld = adjustHeldKey(adjustLine, can)

  return (
    <div className="fw-st">
      <div className="fw-st-head">
        <span className="fw-st-actions">
          <span className="fw-stk-status" role="status">
            {model.asOf ? s('live.updated', { time: formatTime(model.asOf, place) }) : t('st.notYet')}
            {' · '}
            {s(`live.${model.live}`)}
          </span>
          {model.sites.length > 1 && (
            <Select size="sm" aria-label={s('common.site')} value={address.site ?? ''} onChange={(event) => actions?.onAddress?.({ site: event.target.value || null })}>
              <option value="">{s('common.allSites')}</option>
              {model.sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.code} · {site.name}
                </option>
              ))}
            </Select>
          )}
        </span>
        <span className="fw-st-actions">
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': s('common.more') }}
            items={[
              ...(can.openingImport ? [{ id: 'import', icon: <Upload size={14} aria-hidden />, label: t('st.importOpening'), href: `${model.prefix}/admin/import?importer=inventory.opening` }] : []),
              { id: 'export', icon: <Download size={14} aria-hidden />, label: t('st.exportView'), disabled: !lines || lines.length === 0, onSelect: () => lines && actions?.onExport?.(lines) },
              { id: 'keys', label: t('st.shortcuts'), onSelect: () => setHelp(true) },
            ]}
          />
          <Button size="sm" variant="primary" heldReason={adjustHeld ? t(adjustHeld) : null} onClick={() => adjustLine && actions?.onAdjust?.(adjustLine)} aria-keyshortcuts="a">
            <SlidersHorizontal size={14} aria-hidden /> {t('st.adjust')}
          </Button>
        </span>
      </div>

      {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} onDismiss={() => actions?.onNotice?.()} />}

      {firstNotice && (
        <div className="fw-stk-notices">
          {[firstNotice, ...(moreNotices ? otherNotices : [])].map((notice) => (
            <Banner
              key={notice.id}
              tone={notice.tone}
              title={t(notice.key, notice.params)}
              onDismiss={() => actions?.onDismiss?.(notice.id)}
              action={
                notice.tile && address.tile !== notice.tile ? (
                  <Button size="sm" onClick={() => actions?.onAddress?.({ tile: notice.tile ?? null })}>
                    {t('st.notice.show')}
                  </Button>
                ) : undefined
              }
            />
          ))}
          {otherNotices.length > 0 && (
            <span>
              <Button size="sm" variant="link" onClick={() => setMoreNotices((open) => !open)}>
                {moreNotices ? t('st.notice.fewer') : t('st.notice.more', { count: otherNotices.length })}
              </Button>
            </span>
          )}
        </div>
      )}

      <MetricStrip
        metrics={STOCK_TILES.map((tile) => ({
          label: t(`st.tile.${tile}`),
          value: tileWords(tile),
          hint: model.rows ? unitTotals(tileStock(model.rows, tile, crViLots), unitWord, locale) : '—',
          active: address.tile === tile,
          onClick: () => actions?.onAddress?.({ tile: address.tile === tile ? null : tile }),
        }))}
      />

      <ListFrame<StockLine>
        label={t('st.tableLabel')}
        rows={state ? [] : lines}
        rowId={(line) => line.id}
        columns={columns}
        count={lines ? t('st.count', { count: lines.length }) : '—'}
        search={search}
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" aria-label={s('common.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked)}>
                <Download size={13} aria-hidden /> <SelectionLabel>{s('common.export', { count: picked.length })}</SelectionLabel>
              </Button>
              <span className="fw-stk-totals">{t('st.selectedTotals', { totals: pickedTotals })}</span>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(line) => line.hide ? actions?.onOpenRecord?.('Hide', line.hide.id) : line.lot ? actions?.onOpenRecord?.('Lot', line.lot.id) : undefined}
        state={state}
        focusRow={model.focusRow}
      />
      {lines && lines.length > 0 && (
        <p className="fw-stk-totals">
          {t('st.totals', { totals: filterTotals })}
          {hidesOf(lines) > 0 ? ` · ${s('hides', { count: hidesOf(lines) })}` : ''}
          {can.cost && <> · {t('st.totalValue', { value: value ? money(value.amount, value.currency, locale) : '—' })}</>}
        </p>
      )}

      {model.adjust && <AdjustDialog model={model.adjust} actions={adjustActions} />}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('st.shortcuts')} size="sm">
          <ul className="fw-stk-keys">
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
