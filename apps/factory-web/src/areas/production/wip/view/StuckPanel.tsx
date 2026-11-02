'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Download } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button } from '@nexus/ui/primitives'
import { formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { TrackedBundle } from '../api'
import { bundleHref, lastPlace } from '../model'

export interface StuckPanelModel {
  readonly prefix: string
  readonly stuck: { readonly value: readonly TrackedBundle[] | null; readonly problem: string | null }
  readonly capped: boolean
}

export interface StuckPanelActions {
  onOpen?: (row: TrackedBundle) => void
  onExport?: (rows: readonly TrackedBundle[], head: readonly string[]) => void
  onRetry?: () => void
}

/**
 * Floor now › Stuck bundles (SCR-073 fn-stuck; design production.floor; MES-168): bundles with no scan for longer than the
 * site's limit, on the shared list frame: bundle, work order, size, last place (operation, station), hours since the last
 * scan (working hours, the site's calendar). A row opens the bundle's record; Export N takes the picked rows. Never who.
 */
export function StuckPanel({ model, actions }: { model: StuckPanelModel; actions?: StuckPanelActions }) {
  const t = useT('production-floor')
  const locale = useLocale()
  const [selected, setSelected] = useState<string[]>([])
  const rows = model.stuck.problem ? [] : model.stuck.value
  const picked = rows?.filter((row) => selected.includes(row.id)) ?? []
  const columns = useMemo<ColDef<TrackedBundle>[]>(() => {
    const BundleCell = ({ data }: ICellRendererParams<TrackedBundle>) =>
      data ? (
        <Link className="fw-pr-link" href={bundleHref(model.prefix, data)}>
          {data.code}
        </Link>
      ) : null
    const WorkOrderCell = ({ data }: ICellRendererParams<TrackedBundle>) =>
      data ? (
        <Link className="fw-pr-link" href={`${model.prefix}/production/work-orders/${data.workOrder.id}?tab=bundles`}>
          {data.workOrder.number}
        </Link>
      ) : null
    return [
      { colId: 'bundle', headerName: t('col.bundle'), minWidth: 140, flex: 1, cellRenderer: BundleCell, valueGetter: (params) => params.data?.code ?? '' },
      { colId: 'workOrder', headerName: t('col.workOrder'), minWidth: 140, flex: 1, cellRenderer: WorkOrderCell, valueGetter: (params) => params.data?.workOrder.number ?? '' },
      { colId: 'size', headerName: t('col.size'), minWidth: 80, flex: 0.5, valueGetter: (params) => params.data?.size ?? '' },
      {
        colId: 'place',
        headerName: t('col.lastPlace'),
        minWidth: 200,
        flex: 1.6,
        valueGetter: (params) => {
          if (!params.data) return ''
          const where = lastPlace(params.data)
          return [where.operation, where.station].filter(Boolean).join(' · ') || t('stuck.neverScanned')
        },
      },
      {
        colId: 'hours',
        headerName: t('col.hours'),
        minWidth: 120,
        flex: 0.7,
        type: 'rightAligned',
        valueGetter: (params) => params.data?.stuck.workingHours ?? 0,
        valueFormatter: (params) => t('stuck.hours', { hours: formatNumber(Number(params.value ?? 0), locale, { maximumFractionDigits: 1 }) }),
      },
    ]
  }, [model.prefix, locale, t])

  return (
    <section className="fw-fn-section" id="fn-stuck" aria-labelledby="fw-fn-stuck">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2" id="fw-fn-stuck">
          {t('stuck.title')}
        </h2>
        <span className="fw-pr-hint">{model.capped ? t('stuck.capped') : t('stuck.hint')}</span>
      </div>
      <ListFrame<TrackedBundle>
        label={t('stuck.title')}
        title={t('stuck.title')}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('stuck.count', { count: rows.length }) : '—'}
        onOpen={(row) => actions?.onOpen?.(row)}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('stuck.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked, [t('col.bundle'), t('col.workOrder'), t('col.size'), t('col.pieces'), t('col.lastPlace'), t('col.station'), t('col.hours')])}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('stuck.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        state={
          model.stuck.problem ? (
            <EmptyState title={t('stuck.failed')} description={t(model.stuck.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
          ) : rows?.length === 0 ? (
            <p className="fw-pr-hint">{t('stuck.none')}</p>
          ) : undefined
        }
      />
    </section>
  )
}
