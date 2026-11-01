'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { CalendarClock, Download, FileText, MoreHorizontal, PackageCheck, PauseCircle, Search, SlidersHorizontal, Upload, X } from 'lucide-react'
import { Banner, EmptyState, Field, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select } from '@nexus/ui/primitives'
import { DateField, Modal } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { recordAddress } from '../../../../lib/records/record-links'
import { money, movesHref, unitCost, unitTotals } from '../../../_shared/stock/model'
import { Dual, NoAccess, QualityPill, Qty, ReadFailed, StockMessages, useUnitWord } from '../../../_shared/stock/parts'
import { AdjustDialog } from '../adjust/AdjustDialog'
import type { AdjustActions } from '../adjust/model'
import type { HoldActions } from '../daily/dialog-model'
import { HoldDialog } from '../daily/HoldDialog'
import { asOfHeldKey, asOfWall, DAILY_NAMESPACE, END_OF_DAY, reasonLabel, wallOf } from '../daily/model'
import {
  adjustHeldKey,
  dailyCan,
  hidesOf,
  holdHeldKey,
  holdSubjectsOf,
  onHandPerUnit,
  overReservedKeys,
  reservedPerUnit,
  scanTarget,
  STOCK_TILES,
  STOCK_VIEWS,
  stockNotices,
  tileCount,
  tileStock,
  valueOf,
  visibleLines,
  type StockLine,
  type StockPageActions,
  type StockPageModel,
  type StockTile,
  type StockViewKey,
} from '../model'
import '../../../_shared/stock/stock.css'
import '../stock-pages.css'

export type { StockPageActions, StockPageModel } from '../model'

/**
 * SCR-060 — Stock (Warehouse › Main; design warehouse.stock): the status (updated · live) and the site, the notices
 * (the most serious first, the rest behind "n more"), tiles that are saved filters (lots in quarantine, waiting for their
 * Cr VI result, blocked or rejected — each with the stock they hold, per unit — and what reservations hold), and the ONE
 * list frame of stock by material, colour, lot and place (views: by material, by lot, by place, leather one row per
 * hide, on hold). Every on-hand figure opens Movements for that stock key, explained. Values only with the cost grain
 * (the columns are absent otherwise). Adjust stock (a) is one row at a time and says so; the selection exports and puts
 * lots on hold. Totals per unit, never across.
 *
 * B-W2a-64: Reserved per row (lot and any-lot reservations placed per lot row; Available = on hand − held − reserved, an
 * over-reserved key said, never shown as free); a held row says the quality hold's reason; Put N lots on hold; stock as
 * of a past date (the pill, the read-only notice, every change held); the valued stock list as of the day (PDF, cost
 * grain) in a new tab; below 720 px the rows are cards.
 */
export function StockView({ model, actions, adjustActions, holdActions }: { model: StockPageModel; actions?: StockPageActions; adjustActions?: AdjustActions; holdActions?: HoldActions }) {
  return (
    <StockMessages extra={['warehouse-stock', DAILY_NAMESPACE]}>
      <Stock model={model} actions={actions} adjustActions={adjustActions} holdActions={holdActions} />
    </StockMessages>
  )
}

const focusedRowId = (): string | null => (typeof document === 'undefined' ? null : ((document.activeElement as HTMLElement | null)?.closest('.ag-row')?.getAttribute('row-id') ?? null))

function Stock({ model, actions, adjustActions, holdActions }: { model: StockPageModel; actions?: StockPageActions; adjustActions?: AdjustActions; holdActions?: HoldActions }) {
  const t = useT('warehouse-stock')
  const s = useT('stock')
  const d = useT(DAILY_NAMESPACE)
  const lists = useT('lists')
  const locale = useLocale()
  const unitWord = useUnitWord()
  const place = { locale, timeZone: model.timeZone }
  const { address, can } = model
  const daily = useMemo(() => model.daily ?? dailyCan([]), [model.daily])
  const pastDate = !!address.asOf
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
  const extras = useMemo(() => ({ reservations: pastDate ? [] : (model.reservations ?? []), holds: daily.holdsView && !pastDate ? (model.holds ?? []) : [] }), [model.reservations, model.holds, daily.holdsView, pastDate])
  const lines = useMemo(() => (model.rows ? visibleLines(model.rows, address, can.cost, crViLots, extras) : null), [model.rows, address, can.cost, crViLots, extras])
  const lineIds = lines?.map((line) => line.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => lineIds.includes(id))), [lineIds])
  useEffect(() => setSelected(model.selected ?? []), [model.selected, address.view])
  const lineOf = (id: string | null) => (id ? (lines?.find((line) => line.id === id) ?? null) : null)
  const picked = (lines ?? []).filter((line) => selected.includes(line.id))
  const adjustLine = picked.length === 1 ? picked[0]! : null
  const several = (model.rows ?? []).some((row) => row.siteId !== model.rows?.[0]?.siteId) || model.sites.length > 1
  const holdReasons = useMemo(() => model.holdReasons ?? [], [model.holdReasons])
  const asOfShown = address.asOf ? asOfWall(address.asOf, model.timeZone) : null
  const asOfDay = asOfShown ? formatDate(`${asOfShown.day}T12:00:00Z`, { locale, timeZone: 'UTC' }) : null

  // a: adjust the focused row (else the one selected); the list frame owns the other keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.adjust || model.hold || model.asOfDialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key !== 'a') return
      const line = lineOf(focusedRowId()) ?? adjustLine
      if (!line || adjustHeldKey(line, can, pastDate)) return
      event.preventDefault()
      actions?.onAdjust?.(line)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const currency = (line: StockLine) => model.currencies?.[line.item.id] ?? null
  const holdWords = (line: StockLine) => (line.hold ? t('st.heldBy', { reason: reasonLabel(holdReasons, line.hold.reasonCode, locale), day: formatDate(line.hold.placedAt, place) }) : null)
  const reservationsOf = (line: StockLine) =>
    (model.reservations ?? []).filter((entry) => entry.siteId === line.siteId && entry.itemId === line.item.id && entry.itemColourId === (line.colour?.id ?? null) && (entry.lotId === null || entry.lotId === (line.lot?.id ?? null))).reduce((sum, entry) => sum + entry.reservations, 0)
  const lotHref = (id: string) => `${model.prefix}${recordAddress({ type: 'Lot', id }, OFFICE_PAGES)}`
  const hideHref = (id: string) => `${model.prefix}${recordAddress({ type: 'Hide', id }, OFFICE_PAGES)}`

  const columns = useMemo<ColDef<StockLine>[]>(() => {
    const keyOf = (line: StockLine) => ({ siteId: line.siteId, itemId: line.item.id, itemColourId: line.colour?.id, lotId: line.lot?.id, hideId: line.hide?.id, locationId: line.location.id, why: true })
    const past = t('st.asOf.notKept')
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
      // A quality hold says its reason (B-W2a-64: held stock in words, never as free to use).
      const held = holdWords(data)
      const wait = held ?? (data.lot.qualityStatus === 'RELEASED' ? null : s(crViLots.has(data.lot.id) ? 'wait.crVi' : data.lot.qualityStatus === 'QUARANTINE' ? 'wait.release' : data.lot.qualityStatus === 'BLOCKED' ? 'wait.blocked' : 'wait.rejected'))
      return (
        <span className="fw-st-cell">
          <span className="fw-stk-pills">
            <QualityPill status={data.lot.qualityStatus} />
          </span>
          {/* Two lines, as every row: a quality hold's reason in words on the second (the cards show its pill). */}
          {wait && (
            <span className={data.hold ? 'fw-st-sub fw-stk-held' : 'fw-st-sub'} title={wait}>
              {wait}
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
    const PastCell = () => (
      <span className="fw-st-sub" title={past}>
        —
      </span>
    )
    const ReservedCell = ({ data }: ICellRendererParams<StockLine>) => {
      if (!data) return null
      if (data.reserved === null) return <PastCell />
      const count = reservationsOf(data)
      return (
        <span className="fw-st-cell" title={count > 0 ? t('st.reservations', { count }) : undefined}>
          <Qty value={data.reserved} uom={data.item.baseUom} />
          {count > 0 && <span className="fw-st-sub">{t('st.reservations', { count })}</span>}
        </span>
      )
    }
    const HeldCell = ({ data }: ICellRendererParams<StockLine>) => (data ? data.held === null ? <PastCell /> : <Qty value={data.held} uom={data.item.baseUom} /> : null)
    const AvailableCell = ({ data }: ICellRendererParams<StockLine>) => {
      if (!data) return null
      if (data.available === null) return <PastCell />
      const below = Number(data.available) < 0
      return (
        <span className="fw-st-cell">
          <Qty value={data.available} uom={data.item.baseUom} />
          {below && <span className="fw-st-sub">{t('st.overReserved')}</span>}
        </span>
      )
    }
    const UnitCostCell = ({ data }: ICellRendererParams<StockLine>) => (data ? <span className="fw-st-num">{unitCost(data.unitCost, currency(data), locale)}</span> : null)
    const ValueCell = ({ data }: ICellRendererParams<StockLine>) => (data ? <span className="fw-st-num">{money(data.value, currency(data), locale)}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<StockLine>) => {
      if (!data) return null
      const held = adjustHeldKey(data, can, pastDate)
      const holdHeld = holdHeldKey([data], daily, pastDate)
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
            { id: 'hold', label: t('st.holdRow'), disabled: !!holdHeld, ...(holdHeld ? { description: d(holdHeld) } : {}), onSelect: () => !holdHeld && actions?.onHold?.([data]) },
          ]}
        />
      )
    }
    return [
      { colId: 'material', headerName: t('st.col.material'), minWidth: 190, flex: 1.5, cellRenderer: MaterialCell },
      { colId: 'lot', headerName: t('st.col.lot'), minWidth: 165, flex: 1.1, cellRenderer: LotCell },
      { colId: 'quality', headerName: t('st.col.quality'), minWidth: 160, flex: 0.9, cellRenderer: QualityCell },
      { colId: 'location', headerName: t('st.col.location'), minWidth: 120, flex: 0.9, cellRenderer: LocationCell },
      { colId: 'onHand', headerName: t('st.col.onHand'), minWidth: 155, flex: 0.9, type: 'rightAligned', cellRenderer: OnHandCell },
      { colId: 'reserved', headerName: t('st.col.reserved'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: ReservedCell },
      { colId: 'held', headerName: t('st.col.held'), minWidth: 125, flex: 0.7, type: 'rightAligned', cellRenderer: HeldCell },
      { colId: 'available', headerName: t('st.col.available'), minWidth: 125, flex: 0.7, type: 'rightAligned', cellRenderer: AvailableCell },
      ...(can.cost
        ? ([
            { colId: 'unitCost', headerName: s('money.unitCost'), minWidth: 130, flex: 0.7, type: 'rightAligned', cellRenderer: UnitCostCell },
            { colId: 'value', headerName: s('money.value'), minWidth: 105, flex: 0.7, type: 'rightAligned', cellRenderer: ValueCell },
          ] satisfies ColDef<StockLine>[])
        : []),
      { colId: 'more', headerName: t('st.col.actions'), minWidth: 80, maxWidth: 80, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, s, d, locale, model.prefix, can, crViLots, several, model.currencies, model.reservations, holdReasons, pastDate, daily])

  if (!can.stockView) {
    return (
      <div className="fw-st">
        <NoAccess permission="inventory.stock.view" />
      </div>
    )
  }

  const over = model.rows && !pastDate ? overReservedKeys(model.rows, can.cost, model.reservations ?? []) : 0
  const notices = pastDate ? [] : stockNotices(model.counts, model.truncated, can.cost ? model.unvalued : null, over).filter((notice) => !model.dismissed.includes(notice.id))
  const [firstNotice, ...otherNotices] = notices
  const reservedLinesAll = model.rows ? visibleLines(model.rows, { ...address, view: 'material', q: '', tile: 'reserved' }, false, crViLots, extras) : null
  const tileWords = (tile: StockTile) => {
    if (tile === 'reserved') return reservedLinesAll === null ? '—' : t('st.tileRows', { count: reservedLinesAll.length })
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
  ) : model.rows && model.rows.length === 0 && !filtered ? (
    pastDate ? (
      <EmptyState icon={<PackageCheck size={22} aria-hidden />} title={t('st.asOf.empty', { day: asOfDay ?? '' })} />
    ) : (
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
    )
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
  const adjustHeld = adjustHeldKey(adjustLine, can, pastDate)
  const pickedLots = holdSubjectsOf(picked).subjects.length
  const holdHeld = holdHeldKey(picked, daily, pastDate)
  const today = wallOf(model.now ? Date.parse(model.now) : Date.now(), model.timeZone).day
  const valuedDay = asOfShown?.day ?? today
  const valuedHref = `${model.prefix}/finance/reports/print?${new URLSearchParams({ asOf: valuedDay, ...(address.site ? { site: address.site } : {}) }).toString()}`
  const bulk = (
    <>
      <Button size="sm" aria-label={s('common.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked)}>
        <Download size={13} aria-hidden /> <SelectionLabel>{s('common.export', { count: picked.length })}</SelectionLabel>
      </Button>
      <Button size="sm" variant="warning" aria-label={t('st.holdLots', { count: pickedLots })} heldReason={holdHeld ? d(holdHeld) : null} onClick={() => actions?.onHold?.(picked)}>
        <PauseCircle size={13} aria-hidden /> <SelectionLabel>{t('st.holdLots', { count: pickedLots })}</SelectionLabel>
      </Button>
      <span className="fw-stk-totals">{t('st.selectedTotals', { totals: pickedTotals })}</span>
    </>
  )

  return (
    <div className="fw-st">
      <div className="fw-st-head">
        <span className="fw-st-actions">
          <span className="fw-stk-status" role="status">
            {model.asOf ? s('live.updated', { time: formatTime(model.asOf, place) }) : t('st.notYet')}
            {' · '}
            {pastDate ? t('st.asOf.paused') : s(`live.${model.live}`)}
          </span>
          {asOfDay && (
            <Pill tone="info">
              <CalendarClock size={12} aria-hidden /> {t('st.asOf.pill', { day: asOfDay })}
            </Pill>
          )}
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
              { id: 'asof', icon: <CalendarClock size={14} aria-hidden />, label: t('st.asOf.open'), onSelect: () => actions?.onAsOf?.(asOfShown ? { day: asOfShown.day, time: asOfShown.time } : { day: new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10), time: END_OF_DAY }) },
              ...(can.openingImport && !pastDate ? [{ id: 'import', icon: <Upload size={14} aria-hidden />, label: t('st.importOpening'), href: `${model.prefix}/admin/import?importer=inventory.opening` }] : []),
              { id: 'export', icon: <Download size={14} aria-hidden />, label: t('st.exportView'), disabled: !lines || lines.length === 0, onSelect: () => lines && actions?.onExport?.(lines) },
              can.cost
                ? { id: 'valued', icon: <FileText size={14} aria-hidden />, label: t('st.valued', { day: formatDate(`${valuedDay}T12:00:00Z`, { locale, timeZone: 'UTC' }) }), href: valuedHref, target: '_blank' as const }
                : { id: 'valued', icon: <FileText size={14} aria-hidden />, label: t('st.valued', { day: formatDate(`${valuedDay}T12:00:00Z`, { locale, timeZone: 'UTC' }) }), disabled: true, description: s('common.costHeld') },
              { id: 'keys', label: t('st.shortcuts'), onSelect: () => setHelp(true) },
            ]}
          />
          <Button size="sm" variant="primary" heldReason={adjustHeld ? t(adjustHeld) : null} onClick={() => adjustLine && actions?.onAdjust?.(adjustLine)} aria-keyshortcuts="a">
            <SlidersHorizontal size={14} aria-hidden /> {t('st.adjust')}
          </Button>
        </span>
      </div>

      {asOfShown && asOfDay && (
        <Banner
          tone="info"
          title={t('st.asOf.notice', { day: asOfDay, time: asOfShown.time })}
          action={
            <Button size="sm" onClick={() => actions?.onNow?.()}>
              {t('st.asOf.backToNow')}
            </Button>
          }
        >
          {t('st.asOf.noticeBody')}
        </Banner>
      )}

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

      {/* Tiles count today's lots and reservations: as of a past date there are none to count. */}
      {!pastDate && (
        <MetricStrip
          metrics={STOCK_TILES.map((tile) => ({
            label: t(`st.tile.${tile}`),
            value: tileWords(tile),
            hint: model.rows ? unitTotals(tile === 'reserved' ? reservedPerUnit(reservedLinesAll ?? []) : tileStock(model.rows, tile, crViLots, extras), unitWord, locale) : '—',
            active: address.tile === tile,
            onClick: () => actions?.onAddress?.({ tile: address.tile === tile ? null : tile }),
          }))}
        />
      )}

      <ListFrame<StockLine>
        label={t('st.tableLabel')}
        rows={state ? [] : lines}
        rowId={(line) => line.id}
        columns={columns}
        count={lines ? t('st.count', { count: lines.length }) : '—'}
        search={search}
        tools={tools}
        selection={{ selected, onChange: setSelected, actions: bulk }}
        updates={model.updates > 0 && !pastDate ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(line) => (line.hide ? actions?.onOpenRecord?.('Hide', line.hide.id) : line.lot ? actions?.onOpenRecord?.('Lot', line.lot.id) : undefined)}
        state={state}
        focusRow={model.focusRow}
        // Below 720 px the same rows as cards (B-W2b-18: the list frame's DS GridCardList, replacing the composed StockCards).
        cards={{ hrefOf: (line) => (line.hide ? hideHref(line.hide.id) : line.lot ? lotHref(line.lot.id) : null) }}
      />
      {lines && lines.length > 0 && (
        <p className="fw-stk-totals">
          {t('st.totals', { totals: filterTotals })}
          {hidesOf(lines) > 0 ? ` · ${s('hides', { count: hidesOf(lines) })}` : ''}
          {!pastDate && reservedPerUnit(lines).length > 0 ? ` · ${t('st.reservedTotals', { totals: unitTotals(reservedPerUnit(lines), unitWord, locale) })}` : ''}
          {can.cost && <> · {t('st.totalValue', { value: value ? money(value.amount, value.currency, locale) : '—' })}</>}
        </p>
      )}

      {model.adjust && <AdjustDialog model={model.adjust} actions={adjustActions} />}
      {model.hold && <HoldDialog model={model.hold} actions={holdActions} />}
      {model.asOfDialog && <AsOfDialog model={model} actions={actions} />}

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

/**
 * Stock as of a date (design warehouse.stock pop:st-asof, opened from ⋯ "Stock as of a date…"): the day (a DateField, no
 * later than today) and the time (end of day by default), "Now" back to the stock now, the note that values use that
 * day's valuation rows and that held / reserved / available are not kept for past days; "Show stock as of this date" is
 * held with its reason (no day, a moment still to come).
 */
function AsOfDialog({ model, actions }: { model: StockPageModel; actions?: StockPageActions }) {
  const d = useT(DAILY_NAMESPACE)
  const s = useT('stock')
  const locale = useLocale()
  const draft = model.asOfDialog!
  const now = model.now ? Date.parse(model.now) : Date.now()
  const today = wallOf(now, model.timeZone).day
  const heldKey = asOfHeldKey(draft.day, draft.time, now, model.timeZone)
  const set = (patch: Partial<typeof draft>) => actions?.onAsOf?.({ ...draft, ...patch })
  return (
    <Modal
      open
      onClose={() => actions?.onAsOf?.(null)}
      size="sm"
      title={d('asof.title')}
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={() => actions?.onNow?.()}>
            {d('asof.now')}
          </Button>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onAsOf?.(null)}>
            {s('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldKey ? d(heldKey) : null} onClick={() => actions?.onAsOfShow?.(draft)}>
            <CalendarClock size={13} aria-hidden /> {d('asof.show')}
          </Button>
        </>
      }
    >
      <div className="fw-stk-form">
        <div className="fw-stk-asof">
          <Field label={d('asof.day')} required>
            <DateField value={draft.day} onChange={(day) => set({ day })} locale={INTL_LOCALE[locale]} max={today} ariaLabel={d('asof.day')} clearable={false} />
          </Field>
          <Field label={d('asof.time')} hint={d('asof.timeHint')}>
            <Input type="time" value={draft.time} onChange={(event) => set({ time: event.target.value || END_OF_DAY })} aria-label={d('asof.time')} />
          </Field>
        </div>
        <p className="fw-stk-hint">{d('asof.note')}</p>
      </div>
    </Modal>
  )
}
