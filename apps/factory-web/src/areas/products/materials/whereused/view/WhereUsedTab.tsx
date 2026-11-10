'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Download } from 'lucide-react'
import { Banner, EmptyState, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { useT } from '../../../../../lib/i18n/provider'
import { useDepthWords } from '../../approval/words'
import type { MaterialDepthActions, MaterialDepthModel, MaterialWhereUsedView } from '../../approval/depth-model'
import { REVISION_TONE, rowKey, whereUsedKeys, type WhereUsedRow } from '../whereused-model'

const NS = 'products-materials-depth'

/**
 * SCR-048 Where used (B-W2b-238; PRD-036; design material.whereused): every style, revision and open work order that uses
 * the material — each BOM line that names it and each line it is an alternate on, of draft, released and obsolete
 * revisions — with the placement, the colour it takes (one for all, or per colourway) and the revision's open work orders.
 * Above: what it reaches now (styles, draft and released revisions, open work orders; "—" where the role does not read
 * them) and a filter by one of its colours. The shared list frame (select-all, shift range, x; Export N; keys in the
 * footer's information icon); each style a real link to its BOM, each work order to its record. Read only (Replace in N
 * styles is Later, PRD-086). It fetches nothing.
 */
export function WhereUsedTab({ model, actions, prefix }: { model: MaterialDepthModel; actions?: MaterialDepthActions; prefix: string }) {
  const t = useT(NS)
  const words = useDepthWords()
  const read = model.whereUsed
  const view = read.status === 'ready' ? read.value : null
  const rows = view?.rows ?? null
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const keysOfRows = rows?.map(rowKey).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((key) => keysOfRows.split(',').includes(key))), [keysOfRows])
  const picked = (rows ?? []).filter((row) => selected.includes(rowKey(row)))

  const columns = useMemo<ColDef<WhereUsedRow>[]>(() => {
    const StyleCell = ({ data }: ICellRendererParams<WhereUsedRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <Link className="fw-lib-rowlink" href={`${prefix}/products/styles/${data.style.id}?tab=bom&rev=${data.revision.id}`}>
            {data.style.code}
          </Link>
          <span className="fw-lib-sub">{data.style.name}</span>
        </span>
      ) : null
    const RevisionCell = ({ data }: ICellRendererParams<WhereUsedRow>) =>
      data ? (
        <span className="fw-lib-inline">
          {t('whereUsed.revision', { revision: data.revision.revision })}
          <Pill tone={REVISION_TONE[data.revision.status] ?? 'neutral'}>{t(`revisionStatus.${data.revision.status}`)}</Pill>
        </span>
      ) : null
    const LineCell = ({ data }: ICellRendererParams<WhereUsedRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <span>{t('whereUsed.line', { seq: data.seq })}</span>
          <span className="fw-lib-sub">{data.role === 'LINE' ? t('role.LINE') : t('role.ALTERNATE', { priority: data.priority ?? 0 })}</span>
        </span>
      ) : null
    const PlacementCell = ({ data }: ICellRendererParams<WhereUsedRow>) => (data ? <span>{data.placement ?? '—'}</span> : null)
    const ColoursCell = ({ data }: ICellRendererParams<WhereUsedRow>) => {
      if (!data) return null
      if (data.colour) return <span className="fw-lib-cell"><span>{data.colour.code}</span><span className="fw-lib-sub">{t('whereUsed.everyColourway', { name: data.colour.name })}</span></span>
      if (data.colourways.length === 0) return <span className="fw-lib-hint">{t('whereUsed.noColour')}</span>
      return <span className="fw-lib-sub">{data.colourways.map((entry) => `${entry.colourwayCode}: ${entry.colour.code}`).join(' · ')}</span>
    }
    const OrdersCell = ({ data }: ICellRendererParams<WhereUsedRow>) => {
      if (!data) return null
      if (data.openWorkOrders === null) return <span className="fw-lib-hint">{t('notInRole')}</span>
      if (data.openWorkOrders.length === 0) return <span className="fw-lib-hint">{t('whereUsed.noOrders')}</span>
      return (
        <span className="fw-lib-tags">
          {data.openWorkOrders.slice(0, 3).map((order) => (
            <Link key={order.id} className="fw-lib-link" href={`${prefix}/production/work-orders/${order.id}`}>
              {order.number}
            </Link>
          ))}
          {data.openWorkOrders.length > 3 && <span className="fw-lib-sub">{t('whereUsed.moreOrders', { count: data.openWorkOrders.length - 3 })}</span>}
        </span>
      )
    }
    return [
      { colId: 'style', headerName: t('whereUsed.col.style'), field: 'seq', cellDataType: false, minWidth: 190, flex: 1.6, cellRenderer: StyleCell },
      { colId: 'revision', headerName: t('whereUsed.col.revision'), field: 'seq', cellDataType: false, minWidth: 160, flex: 1, cellRenderer: RevisionCell },
      { colId: 'line', headerName: t('whereUsed.col.line'), field: 'seq', cellDataType: false, minWidth: 130, flex: 0.8, cellRenderer: LineCell },
      { colId: 'placement', headerName: t('whereUsed.col.placement'), field: 'placement', cellDataType: false, minWidth: 140, flex: 1, cellRenderer: PlacementCell },
      { colId: 'colours', headerName: t('whereUsed.col.colours'), field: 'seq', cellDataType: false, minWidth: 170, flex: 1.2, cellRenderer: ColoursCell },
      { colId: 'orders', headerName: t('whereUsed.col.orders'), field: 'seq', cellDataType: false, minWidth: 170, flex: 1.2, cellRenderer: OrdersCell },
    ]
  }, [t, prefix])

  if (read.status === 'error')
    return (
      <Banner tone="danger" title={t('whereUsed.failed')} action={<Button size="sm" onClick={() => actions?.onRetryWhereUsed?.()}>{t('retry')}</Button>}>
        {words(read.problem)}
      </Banner>
    )
  if (view && !view.stylesAllowed) return <EmptyState title={t('whereUsed.noStyles.title')} description={t('whereUsed.noStyles.body')} />

  const state = view && view.rows.length === 0 ? <EmptyState title={t(model.colourId ? 'whereUsed.emptyColour' : 'whereUsed.empty')} description={t(model.colourId ? 'whereUsed.emptyColourBody' : 'whereUsed.emptyBody')} /> : undefined

  return (
    <div className="fw-lib-stack">
      <Summary view={view} />
      {view?.more && <Banner tone="info" title={t('whereUsed.more', { count: view.rows.length })} />}
      <ListFrame<WhereUsedRow>
        label={t('whereUsed.tableLabel')}
        listKey="products.materials.where-used"
        title={t('whereUsed.title')}
        rows={state ? [] : rows}
        rowId={rowKey}
        columns={columns}
        count={rows ? t('whereUsed.count', { count: rows.length }) : '—'}
        tools={
          view && view.colours.length > 0 ? (
            <Select size="sm" aria-label={t('whereUsed.colourFilter')} value={model.colourId ?? ''} onChange={(event) => actions?.onColour?.(event.target.value || null)}>
              <option value="">{t('whereUsed.allColours')}</option>
              {view.colours.map((entry) => (
                <option key={entry.colour.id} value={entry.colour.id}>
                  {t('whereUsed.colourOption', { code: entry.colour.code, name: entry.colour.name, count: entry.lines })}
                </option>
              ))}
            </Select>
          ) : undefined
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('whereUsed.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map(rowKey))}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('whereUsed.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        keys={whereUsedKeys}
        state={state}
      />
    </div>
  )
}

/** What the material reaches now; "—" for what the role does not read, never 0. */
function Summary({ view }: { view: MaterialWhereUsedView | null }) {
  const t = useT(NS)
  const value = (count: number | null | undefined) => (count === null || count === undefined ? '—' : String(count))
  const summary = view?.summary
  return (
    <MetricStrip
      metrics={[
        { label: t('whereUsed.tile.styles'), value: value(summary?.styles), hint: t('whereUsed.tileHint.styles') },
        { label: t('whereUsed.tile.drafts'), value: value(summary?.draftRevisions), hint: t('whereUsed.tileHint.drafts') },
        { label: t('whereUsed.tile.released'), value: value(summary?.releasedRevisions), hint: t('whereUsed.tileHint.released') },
        { label: t('whereUsed.tile.orders'), value: value(summary?.openWorkOrders), hint: summary && summary.openWorkOrders === null ? t('notInRole') : t('whereUsed.tileHint.orders') },
      ]}
    />
  )
}
