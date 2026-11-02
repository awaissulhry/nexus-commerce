'use client'

import Link from 'next/link'
import { EmptyState, Heatmap, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatTime } from '../../../../lib/i18n/format'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { HeatmapAnswer, TrackedBundle } from '../api'
import { bundleHref, bundlesHref, heatGrid, lastPlace } from '../model'

/** The cell a person opened. */
export interface HeatCellPick {
  readonly siteId: string
  readonly lineId: string | null
  readonly lineLabel: string
  readonly code: string
  readonly operation: string
}

export interface HeatPanelModel {
  readonly prefix: string
  readonly heat: { readonly value: readonly HeatmapAnswer[] | null; readonly problem: string | null }
  readonly lineScope: string | null
  /** The opened cell and its bundles (null while they are read). */
  readonly cell?: { readonly pick: HeatCellPick; readonly bundles: readonly TrackedBundle[] | null; readonly problem: string | null } | null
}

export interface HeatPanelActions {
  onCell?: (pick: HeatCellPick) => void
  onCloseCell?: () => void
  onRetry?: () => void
}

/**
 * Floor now › WIP by operation, the W2b heat map (SCR-073 fn-wip; design "Heatmap across lines (where bundles pile up)";
 * MES-162): lines by operations, each cell the bundles waiting there, a pile above the line's usual size outlined and said
 * in words under the map, never by colour alone. A cell opens the bundles behind it (design pop:fn-cell) in a centred
 * dialog: the DS Heatmap's cell is a button of its own, so it cannot be a DetailPopover's trigger.
 */
export function HeatPanel({ model, actions }: { model: HeatPanelModel; actions?: HeatPanelActions }) {
  const t = useT('production-floor')
  const maps = model.heat.value
  return (
    <section className="fw-fn-section" aria-labelledby="fw-fn-heat">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2" id="fw-fn-heat">
          {t('heat.title')}
        </h2>
        <span className="fw-pr-hint">{t('heat.hint')}</span>
      </div>
      {model.heat.problem ? (
        <EmptyState title={t('heat.failed')} description={t(model.heat.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
      ) : !maps ? (
        <p className="fw-pr-hint" role="status">
          <Spinner size={12} /> {t('loading')}
        </p>
      ) : maps.every((map) => map.max === 0) ? (
        <p className="fw-pr-hint">{t('heat.none')}</p>
      ) : (
        maps.map((map) => <SiteMap key={map.site.id} map={map} model={model} actions={actions} many={maps.length > 1} />)
      )}
      {model.cell && <CellDialog prefix={model.prefix} cell={model.cell} onClose={() => actions?.onCloseCell?.()} />}
    </section>
  )
}

function SiteMap({ map, model, actions, many }: { map: HeatmapAnswer; model: HeatPanelModel; actions?: HeatPanelActions; many: boolean }) {
  const t = useT('production-floor')
  const grid = heatGrid(map, model.lineScope)
  const rowName = (row: number) => grid.rowLabels[row] || t('heat.noLine')
  const rowLabels = grid.rowLabels.map((label) => label || t('heat.noLine'))
  const words = (row: number, col: number) => {
    const cell = grid.rows[row]?.cells[col]
    const name = `${rowName(row)} · ${grid.colTitles[col] ?? ''}`
    if (!cell || cell.bundles === 0) return t('heat.cellEmpty', { place: name })
    const base = t('heat.cell', { place: name, count: cell.bundles, pieces: cell.pieces })
    return [base, cell.stuck > 0 ? t('heat.cellStuck', { count: cell.stuck }) : null, cell.pile ? t('heat.pile') : null].filter(Boolean).join(' · ')
  }
  if (grid.rows.length === 0) return <p className="fw-pr-hint">{t('heat.none')}</p>
  return (
    <div className="fw-fn-heat">
      {many && <h3 className="fw-pr-h3">{map.site.code}</h3>}
      <div className="fw-fn-heat-map">
        <Heatmap
          data={grid.data}
          rowLabels={rowLabels}
          colLabels={grid.colLabels}
          colTitles={grid.colTitles}
          marked={grid.marked}
          cellWords={words}
          labelWidth={96}
          label={t('heat.title')}
          onCellClick={(row, col) => {
            const entry = grid.rows[row]
            const column = map.columns[col]
            if (!entry || !column || (entry.cells[col]?.bundles ?? 0) === 0) return
            actions?.onCell?.({ siteId: map.site.id, lineId: entry.line?.id ?? null, lineLabel: rowName(row), code: column.code, operation: column.name })
          }}
        />
      </div>
      <p className="fw-pr-hint">{grid.piles.length === 0 ? t('heat.noPile') : t('heat.piles', { places: grid.piles.map((pile) => t('heat.pilePlace', { line: pile.line ?? t('heat.noLine'), operation: pile.operation, count: pile.bundles })).join(', ') })}</p>
      {map.capped && <p className="fw-pr-hint">{t('heat.capped')}</p>}
    </div>
  )
}

function CellDialog({ prefix, cell, onClose }: { prefix: string; cell: NonNullable<HeatPanelModel['cell']>; onClose: () => void }) {
  const t = useT('production-floor')
  const locale = useLocale()
  const open = bundlesHref(prefix, '?place=LINE')
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('cell.title', { operation: cell.pick.operation })}
      subtitle={cell.pick.lineLabel}
      footer={
        <>
          {open && (
            <Button asChild>
              <Link href={open}>{t('cell.open')}</Link>
            </Button>
          )}
          <Button onClick={onClose}>{t('close')}</Button>
        </>
      }
    >
      {cell.problem ? (
        <p className="fw-fn-refused" role="alert">
          {t(cell.problem)}
        </p>
      ) : !cell.bundles ? (
        <p className="fw-pr-hint" role="status">
          <Spinner size={12} /> {t('loading')}
        </p>
      ) : (
        <SummaryTable
          label={t('cell.title', { operation: cell.pick.operation })}
          stackOnPhone
          columns={[t('col.bundle'), t('col.size'), t('col.pieces'), t('col.lastScan'), t('col.station')]}
          rows={cell.bundles.map((row) => ({
            id: row.id,
            cells: [
              <Link key="b" className="fw-pr-link" href={bundleHref(prefix, row)}>
                {row.code}
              </Link>,
              row.size,
              String(row.quantity),
              row.lastScan ? formatTime(row.lastScan.at, { locale }) : t('cell.noScan'),
              lastPlace(row).station ?? '—',
            ],
          }))}
        />
      )}
    </Modal>
  )
}
