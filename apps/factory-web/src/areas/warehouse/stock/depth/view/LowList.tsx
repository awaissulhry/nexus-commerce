'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, PackageSearch } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { Qty, ReadFailed } from '../../../../_shared/stock/parts'
import type { StockPageActions, StockPageModel } from '../../model'
import type { LowRow } from '../api'
import { DEPTH_NAMESPACE, lowRowId, searchLow } from '../model'

/**
 * Below minimum (design warehouse.stock st-metrics "Below minimum (W2b, SCM-281)"): the tile pressed shows the materials
 * (and colours) of the sites shown whose stock position — on hand + on order − reserved — is below their minimum, on the
 * shared list frame: the minimum and what it comes from, on hand, on order, reserved, the position and what is short. A
 * material with no stock at all is a row here too (a stock row could not show it). Rows open the material; ⋯ shows its
 * stock. Read from `GET /inventory/low-stock` per site; fetches nothing itself.
 */
export function LowList({ model, actions, search, tools }: { model: StockPageModel; actions?: StockPageActions; search?: ReactNode; tools?: ReactNode }) {
  const t = useT(DEPTH_NAMESPACE)
  const s = useT('stock')
  const ws = useT('warehouse-stock')
  const low = model.low ?? null
  const all = useMemo(() => (low?.status === 'ready' ? low.value.rows : null), [low])
  const rows = useMemo(() => (all ? searchLow(all, model.address.q) : null), [all, model.address.q])
  const [selected, setSelected] = useState<readonly string[]>([])
  const ids = rows?.map(lowRowId).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => ids.includes(id))), [ids])
  const several = new Set((all ?? []).map((row) => row.site.id)).size > 1
  const itemHref = (row: LowRow) => `${model.prefix}${recordAddress({ type: 'Item', id: row.item.id }, OFFICE_PAGES)}`

  const columns = useMemo<ColDef<LowRow>[]>(() => {
    const MaterialCell = ({ data }: ICellRendererParams<LowRow>) =>
      data ? (
        <span className="fw-st-cell">
          <Link className="fw-st-link fw-st-ellipsis" href={itemHref(data)} title={`${data.item.code} · ${data.item.name}`}>
            {data.item.code} · {data.item.name}
          </Link>
          <span className="fw-st-sub">{[data.colour ? `${data.colour.code} ${data.colour.name}` : t('wd.low.allColours'), several ? data.site.code : null].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const qty = (pick: (row: LowRow) => string) => ({ data }: ICellRendererParams<LowRow>) => (data ? <Qty value={pick(data)} uom={data.item.baseUom} /> : null)
    const MinimumCell = ({ data }: ICellRendererParams<LowRow>) =>
      data ? (
        <span className="fw-st-cell">
          <Qty value={data.minimum} uom={data.item.baseUom} />
          <span className="fw-st-sub">{t(`wd.low.basis.${data.basis === 'MIN_MAX' || data.basis === 'REORDER_POINT' ? data.basis : 'SAFETY_STOCK'}`)}</span>
        </span>
      ) : null
    const ShortCell = ({ data }: ICellRendererParams<LowRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-wd-short">
            <Qty value={data.short} uom={data.item.baseUom} strong />
          </span>
          <span className="fw-st-sub">{t('wd.low.shortSub')}</span>
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<LowRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('wd.low.rowMenu', { code: data.item.code }) }}
          items={[
            { id: 'item', label: t('wd.low.openItem'), href: itemHref(data) },
            { id: 'stock', label: t('wd.low.showStock'), onSelect: () => actions?.onAddress?.({ tile: null, q: data.item.code }) },
          ]}
        />
      ) : null
    return [
      { colId: 'material', headerName: t('wd.low.col.material'), minWidth: 220, flex: 1.8, cellRenderer: MaterialCell },
      { colId: 'minimum', headerName: t('wd.low.col.minimum'), minWidth: 140, flex: 0.9, type: 'rightAligned', cellRenderer: MinimumCell },
      { colId: 'onHand', headerName: t('wd.low.col.onHand'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: qty((row) => row.onHand) },
      { colId: 'onOrder', headerName: t('wd.low.col.onOrder'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: qty((row) => row.onOrder) },
      { colId: 'reserved', headerName: t('wd.low.col.reserved'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: qty((row) => row.reserved) },
      { colId: 'position', headerName: t('wd.low.col.position'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: qty((row) => row.position) },
      { colId: 'short', headerName: t('wd.low.col.short'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: ShortCell },
      { colId: 'more', headerName: ws('st.col.actions'), minWidth: 80, maxWidth: 80, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, s, ws, model.prefix, several])

  if (low?.status === 'error') return <ReadFailed problem={low.problem} onRetry={() => actions?.onRetryLow?.()} />
  const picked = (rows ?? []).filter((row) => selected.includes(lowRowId(row)))
  const state =
    rows && rows.length === 0 ? (
      all && all.length > 0 ? (
        <EmptyState title={s('common.noMatch')} />
      ) : (
        <EmptyState icon={<PackageSearch size={22} aria-hidden />} title={t('wd.low.none')} description={low?.status === 'ready' && low.value.alertsOff ? t('wd.low.alertsOff') : t('wd.low.noneBody')} />
      )
    ) : undefined
  return (
    <ListFrame<LowRow>
      label={t('wd.low.tableLabel')}
      rows={rows}
      rowId={lowRowId}
      columns={columns}
      count={rows ? t('wd.low.count', { count: rows.length }) : '—'}
      search={search}
      tools={tools}
      selection={{
        selected,
        onChange: setSelected,
        actions: (
          <Button size="sm" aria-label={s('common.export', { count: picked.length })} onClick={() => actions?.onExportLow?.(picked)}>
            <Download size={13} aria-hidden /> <SelectionLabel>{s('common.export', { count: picked.length })}</SelectionLabel>
          </Button>
        ),
      }}
      onOpen={(row) => actions?.onOpenItem?.(row.item.id)}
      state={state}
      listKey={null}
      cards={{ hrefOf: itemHref }}
    />
  )
}
