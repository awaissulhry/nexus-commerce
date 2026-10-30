'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Printer, Search, X } from 'lucide-react'
import { EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { HideRow, StateCount } from '../../../../_shared/stock/api'
import { convertArea, movesHref, otherAreaUnit, quantity, sumPerUnit, unitTotals } from '../../../../_shared/stock/model'
import { HideStatePill, NoAccess, QualityPill } from '../../../../_shared/stock/parts'
import { KeysModal, LotsMessages, useWords, type Words } from '../../../lots/shared/parts'
import { HIDE_TILES, HIDE_VIEWS, tagHeldKey, type HideFilters, type HidesListActions, type HidesListModel, type HideView } from '../../model'
import { PrintTagsDialog } from '../../print/PrintTagsDialog'

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
 */
export function HidesListView({ model, actions }: { model: HidesListModel; actions?: HidesListActions }) {
  return (
    <LotsMessages>
      <HidesList model={model} actions={actions} />
    </LotsMessages>
  )
}

function HidesList({ model, actions }: { model: HidesListModel; actions?: HidesListActions }) {
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
    const LotCell = ({ data }: ICellRendererParams<HideRow>) =>
      data ? (
        <span className="fw-st-cell">
          <Link className="fw-st-link fw-wl-code" href={`${model.prefix}/warehouse/lots/${encodeURIComponent(data.lot.id)}`}>
            {data.lot.code}
          </Link>
          <span>
            <QualityPill status={data.lot.qualityStatus} />
          </span>
        </span>
      ) : null
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
          ]}
        />
      ) : null
    return [
      { colId: 'tag', headerName: t('hd.col.tag'), minWidth: 150, flex: 1, cellRenderer: TagCell },
      { colId: 'article', headerName: t('hd.col.article'), minWidth: 185, flex: 1.4, cellRenderer: ArticleCell },
      { colId: 'lot', headerName: t('hd.col.lot'), minWidth: 140, flex: 0.9, cellRenderer: LotCell },
      { colId: 'batch', headerName: t('hd.col.batch'), minWidth: 105, flex: 0.7, cellRenderer: BatchCell },
      { colId: 'grade', headerName: t('hd.col.grade'), field: 'grade', minWidth: 90, flex: 0.4, valueFormatter: (params) => params.value ?? '—' },
      { colId: 'area', headerName: t('hd.col.area'), minWidth: 110, flex: 0.8, type: 'rightAligned', cellRenderer: AreaCell },
      { colId: 'left', headerName: t('hd.col.left'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: LeftCell },
      { colId: 'state', headerName: t('hd.col.state'), minWidth: 125, flex: 0.8, cellRenderer: StateCell },
      { colId: 'place', headerName: t('hd.col.place'), minWidth: 150, flex: 1, cellRenderer: PlaceCell },
      { colId: 'thickness', headerName: t('hd.col.thickness'), field: 'thicknessMm', minWidth: 100, flex: 0.5, type: 'rightAligned', valueFormatter: (params) => (params.value ? `${quantity(params.value as string, locale)} mm` : '—') },
      { colId: 'defects', headerName: t('hd.col.defects'), minWidth: 160, flex: 1, cellRenderer: DefectsCell },
      { colId: 'received', headerName: t('hd.col.received'), field: 'receivedAt', minWidth: 110, flex: 0.6, valueFormatter: (params) => (params.value ? formatDate(params.value as string, place) : '—') },
      { colId: 'more', headerName: t('rec.actions'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.can.printLabels, model.timeZone, actions])

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
      {activeFilters.map(([name, value]) => (
        <FilterChip key={name} pressed aria-label={t('hd.filter.remove', { filter: t(`hd.filter.${name}`) })} onClick={() => actions?.onClearFilter?.(name)}>
          {t(`hd.filter.${name}`)}: {name === 'lotId' || name === 'locationId' ? t('hd.filter.one') : value} <X size={11} aria-hidden />
        </FilterChip>
      ))}
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
      </div>

      <MetricStrip
        metrics={HIDE_TILES.map((tile) => ({
          label: t(`hd.tile.${tile.id}`),
          // Two numbers (design hd-metrics): the hides big, their area per unit under them (never adding units).
          value: tile.count(model.counts) ? t('stock:hides', { count: tile.count(model.counts)!.hides }) : '—',
          hint: tile.count(model.counts) ? t(`hd.tileHint.${tile.id}`, { area: unitTotals(tile.count(model.counts)!.area, (uom) => t(`stock:uom.${uom}`), locale) }) : t('hd.tileHint.unknown'),
          onClick: () => actions?.onView?.(model.view === tile.view ? 'inStock' : tile.view),
          active: tileView === tile.view,
        }))}
      />

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

      {model.print && <PrintTagsDialog dialog={model.print} hides={printing} actions={actions?.print} />}
      {help && <KeysModal own={ownKeys} onClose={() => setHelp(false)} />}
    </div>
  )
}
