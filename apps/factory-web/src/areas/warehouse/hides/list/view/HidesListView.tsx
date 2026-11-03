'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowRightLeft, Bookmark, Download, MoreHorizontal, PackageSearch, Printer, Search, Trash2, X } from 'lucide-react'
import { EmptyState, Menu, MetricStrip, Thumbnail } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { HideRow, StateCount } from '../../../../_shared/stock/api'
import { convertArea, movesHref, otherAreaUnit, quantity, sumPerUnit, unitTotals } from '../../../../_shared/stock/model'
import { HideStatePill, NoAccess, QualityPill } from '../../../../_shared/stock/parts'
import { KeysModal, useWords, type Words } from '../../../lots/shared/parts'
import { holdOfHide, holdReasonWords, reserveSelectionHeld, scrapSelectionHeld } from '../../../lots/shared/daily'
import { demandLabel, demandRecord } from '../../../stock/daily/model'
import { ReserveDialog } from '../../../stock/daily/ReserveDialog'
import { WriteOffDialog } from '../../../stock/daily/WriteOffDialog'
import { HIDE_TILES, HIDE_VIEWS, tagHeldKey, type HideFilters, type HidesListActions, type HidesListModel, type HideView } from '../../model'
import { PrintTagsDialog } from '../../print/PrintTagsDialog'
import { LeatherDashboard } from '../../dashboard/view/LeatherDashboard'
import { areaWords } from '../../dashboard/dashboard-model'
import { FindHidesDialog } from '../../find/view/FindHidesDialog'
import { moveSelectionHeld } from '../../move/move-model'
import { MoveHidesDialog } from '../../move/view/MoveHidesDialog'
import { latestPhoto } from '../../photos/model'
import { PhotoLightbox } from '../../photos/view/PhotoLightbox'
import { RemnantsList } from '../../remnants/view/RemnantsList'
import { HidesMessages, useHideWords } from '../../words'

export type { HidesListActions, HidesListModel } from '../../model'

/** "37 hides · 412,5 m² · 120 ft²": a count with its area per unit (never adding units). */
export function stateWords(count: StateCount | null, t: Words, locale: ReturnType<typeof useLocale>): string {
  if (!count) return '—'
  const area = unitTotals(count.area, (uom) => t(`stock:uom.${uom}`), locale)
  return area === '—' ? t('stock:hides', { count: count.hides }) : t('stock:dual', { count: t('stock:hides', { count: count.hides }), area })
}

/**
 * SCR-200 — Hides (Warehouse › Main; design warehouse.hides, hd-metrics + hd-grid): the leather tiles with two numbers
 * each (full, partly cut, remnants, in quarantine: hides · area, saved views), the two numbers of the filter in the band,
 * and every hide one by one on the shared list frame — its tag, article and colour, lot and the lot's quality, dye
 * batch and shade, grade, its measured area in the unit of entry and the other unit, what is left of it, its state,
 * where it lies, thickness, defects, when it came, the tannery's number. `/` searches or takes a scanned tag (one hit
 * opens the hide). Selected: Print N tags (label printer or PDF), Export N; a consumed or scrapped hide gets no tag.
 * B-W2a-64: the Reserved tile and view, "Reserved for" (the work order or order line, a done one said "release it"), a
 * held hide says why (its own or its lot's quality hold, in the reason's words: never shown as free), and on the
 * selection "Reserve to a work order…" and "Scrap…" (the shared every-day dialogs), each held with its reason.
 * B-W2b-131: "Find hides for a job" (the band's primary) and ⋯ "Leather dashboard on / off"; the leather dashboard (SCR-134)
 * under the tiles; the Remnants tile as pieces beside area (the tagged offcuts) and the Remnants view as those pieces; a
 * Photo column (Thumbnail of the newest photo, files.read) that opens the Lightbox; "Move…" on the selection.
 */
export function HidesListView({ model, actions }: { model: HidesListModel; actions?: HidesListActions }) {
  return (
    <HidesMessages>
      <HidesList model={model} actions={actions} />
    </HidesMessages>
  )
}

function HidesList({ model, actions }: { model: HidesListModel; actions?: HidesListActions }) {
  const t = useWords()
  const h = useHideWords()
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

  const columns = useMemo<ColDef<HideRow>[]>(() => {
    const href = (row: HideRow) => `${model.prefix}/warehouse/hides/${encodeURIComponent(row.id)}`
    const unit = (uom: HideRow['areaUom']) => t(`stock:uom.${uom}`)
    const TagCell = ({ data }: ICellRendererParams<HideRow>) =>
      data ? (
        <span className="fw-st-cell">
          <Link className="fw-st-link fw-wl-code" href={href(data)}>
            {data.code}
          </Link>
          <span className="fw-st-sub">{data.supplierCode ? t('hd.tannery', { number: data.supplierCode }) : '—'}</span>
        </span>
      ) : null
    const ArticleCell = ({ data }: ICellRendererParams<HideRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis">{`${data.item.code} · ${data.item.name}`}</span>
          <span className="fw-st-sub">{data.colour ? `${data.colour.code} ${data.colour.name}` : '—'}</span>
        </span>
      ) : null
    const LotCell = ({ data }: ICellRendererParams<HideRow>) => {
      if (!data) return null
      const hold = holdOfHide(model.holds, data)
      const why = hold ? t('hd.daily.onHold', { reason: holdReasonWords(hold, model.holdReasons, locale) }) : null
      return (
        // Two lines, as every row: the lot and its pills, then a hold's reason in words (B-W2a-64: held, never free).
        <span className="fw-st-cell">
          <span className="fw-wl-line">
            <Link className="fw-st-link fw-wl-code" href={`${model.prefix}/warehouse/lots/${encodeURIComponent(data.lot.id)}`}>
              {data.lot.code}
            </Link>
            <QualityPill status={data.lot.qualityStatus} />
          </span>
          {why && (
            <span className="fw-st-sub fw-wl-held" title={why}>
              {why}
            </span>
          )}
        </span>
      )
    }
    const ReservedCell = ({ data }: ICellRendererParams<HideRow>) => {
      if (!data) return null
      if (!data.reservedFor) return <span className="fw-st-sub">—</span>
      const target = demandRecord(data.reservedFor.demand)
      return (
        <span className="fw-st-cell">
          <Link className="fw-st-link fw-wl-code" href={`${model.prefix}${recordAddress(target, OFFICE_PAGES)}`}>
            {demandLabel(data.reservedFor.demand)}
          </Link>
          <span className="fw-st-sub">{data.reservedFor.stale ? t('hd.daily.stale') : t(data.reservedFor.demand.type === 'WorkOrder' ? 'hd.daily.forWorkOrder' : 'hd.daily.forOrderLine')}</span>
        </span>
      )
    }
    const BatchCell = ({ data }: ICellRendererParams<HideRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis">{data.lot.dyeBatch ?? '—'}</span>
          <span className="fw-st-sub">{data.shade ?? data.lot.shade ? t('hd.shade', { shade: data.shade ?? data.lot.shade ?? '' }) : ''}</span>
        </span>
      ) : null
    const AreaCell = ({ data }: ICellRendererParams<HideRow>) => {
      if (!data) return null
      const value = Number(data.area)
      const other = otherAreaUnit(data.areaUom)
      const converted = other ? convertArea(value, data.areaUom, other) : null
      return (
        <span className="fw-st-cell">
          <span className="fw-st-num">{`${quantity(data.area, locale)} ${unit(data.areaUom)}`}</span>
          <span className="fw-st-sub">{converted !== null && other ? `${quantity(converted, locale)} ${unit(other)}` : ''}</span>
        </span>
      )
    }
    const LeftCell = ({ data }: ICellRendererParams<HideRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-num strong">{`${quantity(data.left, locale)} ${unit(data.item.baseUom)}`}</span>
          <span className="fw-st-sub">{data.onHand === '0.0000' && data.left !== '0.0000' ? t('hd.atCutting') : ''}</span>
        </span>
      ) : null
    const PhotoCell = ({ data }: ICellRendererParams<HideRow>) => {
      if (!data || !model.photos) return null
      const photos = model.photos.byHide[data.id] ?? []
      const latest = latestPhoto(photos)
      if (!latest) return <span className="fw-st-sub">{model.photos.loading ? '…' : '—'}</span>
      return <Thumbnail src={latest.src} photoCount={photos.length} alt={h('photo.alt', { code: data.code })} title={h('photo.open', { code: data.code, count: photos.length })} onClick={() => actions?.onPhoto?.(data.id, data.code)} />
    }
    const StateCell = ({ data }: ICellRendererParams<HideRow>) => (data ? <HideStatePill state={data.state} /> : null)
    const PlaceCell = ({ data }: ICellRendererParams<HideRow>) =>
      data ? data.location ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis">{data.location.code}</span>
          <span className="fw-st-sub">{data.location.name}</span>
        </span>
      ) : (
        <span className="fw-st-sub">{data.state === 'CONSUMED' || data.state === 'SCRAPPED' ? '—' : t('hd.noPlace')}</span>
      ) : null
    const DefectsCell = ({ data }: ICellRendererParams<HideRow>) => (data ? <span className="fw-st-ellipsis" title={data.defects ?? undefined}>{data.defects ?? '—'}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<HideRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('hd.rowMenu', { code: data.code }) }}
          items={[
            { id: 'open', label: t('rec.open'), href: href(data) },
            { id: 'tab', label: t('rec.openNewTab'), href: href(data), target: '_blank' },
            { id: 'cuts', label: t('hd.tab.cuts'), href: `${href(data)}?tab=cuts` },
            { id: 'lot', label: t('hd.openLot', { code: data.lot.code }), href: `${model.prefix}/warehouse/lots/${encodeURIComponent(data.lot.id)}` },
            { id: 'moves', label: t('hd.openMoves'), href: movesHref(model.prefix, { siteId: data.siteId, itemId: data.item.id, lotId: data.lot.id, hideId: data.id }) },
            ...(model.can.printLabels && !tagHeldKey(data) ? [{ id: 'print', label: t('hd.printTag'), onSelect: () => actions?.print?.onOpen?.([data.id]) }] : []),
            ...(model.daily.reserve && !reserveSelectionHeld([data], model.daily) ? [{ id: 'reserve', label: t('hd.daily.reserveOne'), onSelect: () => actions?.onReserve?.([data.id]) }] : []),
            ...(model.daily.scrap && !scrapSelectionHeld([data], model.daily) ? [{ id: 'scrap', label: t('hd.daily.scrapOne'), onSelect: () => actions?.onScrap?.([data.id]) }] : []),
          ]}
        />
      ) : null
    return [
      { colId: 'tag', headerName: t('hd.col.tag'), minWidth: 150, flex: 1, cellRenderer: TagCell },
      ...(model.photos ? [{ colId: 'photo', headerName: h('photo.col'), minWidth: 76, maxWidth: 90, sortable: false, cellRenderer: PhotoCell } satisfies ColDef<HideRow>] : []),
      { colId: 'article', headerName: t('hd.col.article'), minWidth: 185, flex: 1.4, cellRenderer: ArticleCell },
      { colId: 'lot', headerName: t('hd.col.lot'), minWidth: 200, flex: 1, cellRenderer: LotCell },
      { colId: 'batch', headerName: t('hd.col.batch'), minWidth: 105, flex: 0.7, cellRenderer: BatchCell },
      { colId: 'grade', headerName: t('hd.col.grade'), field: 'grade', minWidth: 90, flex: 0.4, valueFormatter: (params) => params.value ?? '—' },
      { colId: 'area', headerName: t('hd.col.area'), minWidth: 110, flex: 0.8, type: 'rightAligned', cellRenderer: AreaCell },
      { colId: 'left', headerName: t('hd.col.left'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: LeftCell },
      { colId: 'state', headerName: t('hd.col.state'), minWidth: 125, flex: 0.8, cellRenderer: StateCell },
      { colId: 'place', headerName: t('hd.col.place'), minWidth: 150, flex: 1, cellRenderer: PlaceCell },
      { colId: 'thickness', headerName: t('hd.col.thickness'), field: 'thicknessMm', minWidth: 100, flex: 0.5, type: 'rightAligned', valueFormatter: (params) => (params.value ? `${quantity(params.value as string, locale)} mm` : '—') },
      { colId: 'defects', headerName: t('hd.col.defects'), minWidth: 160, flex: 1, cellRenderer: DefectsCell },
      { colId: 'reservedFor', headerName: t('hd.col.reservedFor'), minWidth: 140, flex: 0.8, cellRenderer: ReservedCell },
      { colId: 'received', headerName: t('hd.col.received'), field: 'receivedAt', minWidth: 110, flex: 0.6, valueFormatter: (params) => (params.value ? formatDate(params.value as string, place) : '—') },
      { colId: 'more', headerName: t('rec.actions'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, h, locale, model.prefix, model.can.printLabels, model.timeZone, model.holds, model.holdReasons, model.daily, model.photos, actions])

  if (!model.can.stockView) {
    return (
      <div className="fw-st">
        <NoAccess permission="inventory.stock.view" />
      </div>
    )
  }

  const tileView = HIDE_TILES.find((tile) => tile.view === model.view)?.view ?? null
  const picked = (model.rows.items ?? []).filter((row) => selected.includes(row.id))
  const pickedLeft = unitTotals(
    sumPerUnit(picked, (row) => ({ uom: row.item.baseUom, quantity: row.left })),
    (uom) => t(`stock:uom.${uom}`),
    locale,
  )
  const activeFilters = (Object.entries(model.filters) as [keyof HideFilters, string | null][]).filter(([, value]) => value !== null)
  const filtered = model.q.trim() !== '' || model.view !== 'all' || activeFilters.length > 0
  const ownKeys: ListKey[] = []
  const clearFilters = (
    <Button
      size="sm"
      onClick={() => {
        setQuery('')
        actions?.onSearch?.('')
        for (const [name] of activeFilters) actions?.onClearFilter?.(name)
        actions?.onView?.('all')
      }}
    >
      {t('stock:common.clearFilters')}
    </Button>
  )
  const state = model.rows.problem ? (
    <EmptyState title={t('hd.list.failed')} description={t(`stock:${model.rows.problem}`)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('rec.retry')}</Button>} />
  ) : model.rows.items && model.rows.items.length === 0 ? (
    filtered ? (
      <EmptyState title={t('hd.list.noMatch')} description={t('stock:common.noMatch')} action={clearFilters} />
    ) : (
      <EmptyState
        title={t('hd.list.empty')}
        description={t('hd.list.emptyBody')}
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
  const printHeld = !model.can.printLabels ? t('hd.print.noRight') : picked.some((row) => tagHeldKey(row)) ? t('hd.print.someHeld') : null
  const reserveHeld = reserveSelectionHeld(picked, model.daily)
  const scrapHeld = scrapSelectionHeld(picked, model.daily)
  const moveHeld = moveSelectionHeld(picked, !!model.canTransfer)

  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('hd.list.search')}
      placeholder={t('hd.list.search')}
      value={query}
      onChange={(event) => {
        typed.current = true
        setQuery(event.target.value)
      }}
    />
  )
  const tools = (
    <>
      <Select size="sm" aria-label={t('hd.list.viewLabel')} value={model.view} onChange={(event) => actions?.onView?.(event.target.value as HideView)}>
        {HIDE_VIEWS.map((view) => (
          <option key={view} value={view}>
            {t(`hd.view.${view}`)}
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
      {activeFilters
        .filter(([name]) => name !== 'itemColourId')
        .map(([name, value]) => {
          const label = name === 'itemId' ? h(model.filters.itemColourId ? 'filter.articleColour' : 'filter.article') : t(`hd.filter.${name}`)
          return (
            <FilterChip key={name} pressed aria-label={t('hd.filter.remove', { filter: label })} onClick={() => actions?.onClearFilter?.(name)}>
              {label}: {name === 'lotId' || name === 'locationId' || name === 'itemId' ? t('hd.filter.one') : value} <X size={11} aria-hidden />
            </FilterChip>
          )
        })}
    </>
  )
  const printing = model.print ? (model.rows.items ?? []).filter((row) => model.print!.hideIds.includes(row.id)) : []

  return (
    <div className="fw-st">
      <div className="fw-st-head">
        <span className="fw-wl-status" role="status">
          <b>{stateWords(model.matching, t, locale)}</b>
          {' · '}
          {model.asOf ? t('stock:live.updated', { time: formatTime(model.asOf, place) }) : t('rec.notYet')}
          {' · '}
          {t(`stock:live.${model.live}`)}
        </span>
        <span className="fw-st-actions">
          <Button size="sm" variant="primary" onClick={() => actions?.onFind?.()}>
            <PackageSearch size={14} aria-hidden /> {h('find.open')}
          </Button>
          {model.dashboard && (
            <Menu
              label={<MoreHorizontal size={16} aria-hidden />}
              align="right"
              triggerProps={{ 'aria-label': h('band.more') }}
              items={[{ id: 'dashboard', label: h(model.dashboard.open ? 'band.dashboardOff' : 'band.dashboardOn'), onSelect: () => actions?.dashboard?.onToggle?.(!model.dashboard!.open) }]}
            />
          )}
        </span>
      </div>

      <MetricStrip
        metrics={HIDE_TILES.map((tile) => {
          // B-W2b-131 (design hd-metrics "Remnants (pieces · m², W2b)"): the tagged offcuts in stock, pieces beside area.
          if (tile.id === 'remnant' && model.remnantTotals !== undefined) {
            const totals = model.remnantTotals?.filter((total) => total.pieces > 0) ?? null
            const pieces = totals?.reduce((sum, total) => sum + total.pieces, 0) ?? null
            return {
              label: t(`hd.tile.${tile.id}`),
              value: pieces === null ? '—' : h('dash.pieces', { count: pieces }),
              hint: totals === null ? t('hd.tileHint.unknown') : totals.length === 0 ? h('tile.noRemnants') : totals.map((total) => areaWords(total.area, total.uom, (uom) => t(`stock:uom.${uom}`), locale)).join(' · '),
              onClick: () => actions?.onView?.(model.view === tile.view ? 'inStock' : tile.view),
              active: tileView === tile.view,
            }
          }
          return {
            label: t(`hd.tile.${tile.id}`),
            // Two numbers (design hd-metrics): the hides big, their area per unit under them (never adding units).
            value: tile.count(model.counts) ? t('stock:hides', { count: tile.count(model.counts)!.hides }) : '—',
            hint: tile.count(model.counts) ? t(`hd.tileHint.${tile.id}`, { area: unitTotals(tile.count(model.counts)!.area, (uom) => t(`stock:uom.${uom}`), locale) }) : t('hd.tileHint.unknown'),
            onClick: () => actions?.onView?.(model.view === tile.view ? 'inStock' : tile.view),
            active: tileView === tile.view,
          }
        })}
      />

      {model.dashboard && <LeatherDashboard model={model.dashboard} actions={actions?.dashboard} />}

      {model.view === 'remnants' && model.remnants ? (
        <>
          <div className="fw-st-head">{tools}</div>
          <RemnantsList model={model.remnants} actions={actions?.remnants} />
        </>
      ) : (
      <ListFrame<HideRow>
        label={t('hd.list.tableLabel')}
        rows={state ? [] : model.rows.items}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows.items ? t(model.rows.more ? 'hd.list.countMore' : 'hd.list.count', { count: model.rows.items.length }) : '—'}
        search={search}
        tools={tools}
        isRowSelectable={(row) => {
          const held = tagHeldKey(row)
          return held ? t(held) : null
        }}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <span className="fw-st-sub">{t('hd.list.selectedLeft', { area: pickedLeft })}</span>
              <Button size="sm" variant="primary" aria-label={t('hd.bulk.print', { count: picked.length })} heldReason={printHeld} onClick={() => actions?.print?.onOpen?.(picked.map((row) => row.id))}>
                <Printer size={13} aria-hidden /> <SelectionLabel>{t('hd.bulk.print', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={h('move.bulk', { count: picked.length })} heldReason={moveHeld ? h(moveHeld) : null} onClick={() => actions?.onMove?.(picked.map((row) => row.id))}>
                <ArrowRightLeft size={13} aria-hidden /> <SelectionLabel>{h('move.bulk', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('hd.daily.reserve', { count: picked.length })} heldReason={reserveHeld ? t(reserveHeld) : null} onClick={() => actions?.onReserve?.(picked.map((row) => row.id))}>
                <Bookmark size={13} aria-hidden /> <SelectionLabel>{t('hd.daily.reserve', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" variant="danger-outline" aria-label={t('hd.daily.scrap', { count: picked.length })} heldReason={scrapHeld ? t(scrapHeld) : null} onClick={() => actions?.onScrap?.(picked.map((row) => row.id))}>
                <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('hd.daily.scrap', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('stock:common.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('stock:common.export', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && model.rows.items && model.rows.items.length > 0 ? { label: t('rec.showMore'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
      />
      )}

      {model.print && <PrintTagsDialog dialog={model.print} hides={printing} actions={actions?.print} />}
      {model.reserve && <ReserveDialog model={model.reserve} actions={actions?.reserve} />}
      {model.writeOff && <WriteOffDialog model={model.writeOff} actions={actions?.writeOff} />}
      {help && <KeysModal own={ownKeys} onClose={() => setHelp(false)} />}
      {model.find && <FindHidesDialog model={model.find} actions={actions?.find} />}
      {model.move && <MoveHidesDialog model={model.move} actions={actions?.move} />}
      {model.lightbox && <PhotoLightbox model={model.lightbox} timeZone={model.timeZone} actions={actions?.lightbox} />}
    </div>
  )
}
