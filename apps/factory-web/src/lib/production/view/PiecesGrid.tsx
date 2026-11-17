'use client'

import { EmptyState, SummaryTable } from '@nexus/ui/components'
import { BarList } from '@nexus/ui/charts/bar-list/index'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useDsWords } from '../../i18n/ds-parts'
import { formatNumber } from '../../i18n/format'
import { nothingCut, PIECE_STAGES, pieceCell, piecesTotal, stageFigures, type PiecesColourway, type PieceStage } from '../model'
import { useProductionWords } from '../words'
import '../production-parts.css'

export interface PiecesGridProps {
  /** One block per colourway of the order line(s), each size in the scale's order — the reader's own cells only. */
  colourways: readonly PiecesColourway[]
  loading?: boolean
  /** The pieces could not be read: only this part says so, with Try again. */
  problem?: boolean
  onRetry?: () => void
}

/**
 * F-PR-01 — pieces by stage and size, per colourway (plan §4 "+ Progress": Cut = cut and bundled, Sewn, Checked, Packed).
 * Each stage is one DS BarList row whose bar and words come from ONE figure ("50 of 60", rule R5); under it the size grid
 * as a DS SummaryTable — rows = stages and columns = sizes + Total on a wide box, rows = sizes on a narrow one (the card's
 * own width decides; DS gap G2, plan §8: progress inside the DS size grid, until the Owner's word). A stage the site does
 * not count says "Not counted here" and "—", never 0. Every figure is the reader's own cells: a customer never sees a lot
 * size or another customer's total (the brand wall).
 */
export function PiecesGrid({ colourways, loading, problem, onRetry }: PiecesGridProps) {
  const w = useProductionWords()
  const ds = useDsWords()
  if (loading) {
    return (
      <div className="fw-prp-pieces" role="status" aria-label={w.t('parts.pieces.loading')}>
        <Skeleton height={18} />
        <Skeleton height={18} />
      </div>
    )
  }
  if (problem) return <EmptyState title={w.t('parts.pieces.failed')} action={onRetry ? <Button size="sm" onClick={onRetry}>{w.t('common.retry')}</Button> : undefined} />
  if (colourways.length === 0) return <p className="fw-prp-hint">{w.t('parts.pieces.none')}</p>
  const number = (value: number) => formatNumber(value, w.locale)
  const stageName = (stage: PieceStage | 'ORDERED') => w.t(`parts.pieces.stages.${stage}`)
  return (
    <div className="fw-prp-pieces">
      {nothingCut(colourways) ? <p className="fw-prp-hint">{w.t('parts.pieces.nothingCut')}</p> : null}
      {colourways.map((colourway) => {
        const total = piecesTotal(colourway)
        const rowsByStage: readonly (PieceStage | 'ORDERED')[] = ['ORDERED', ...PIECE_STAGES]
        return (
          <section key={colourway.id} className="fw-prp-colourway" aria-label={colourway.label}>
            <strong className="fw-prp-colourway-name">{colourway.label}</strong>
            <BarList
              label={w.t('parts.pieces.bars', { name: colourway.label })}
              format={number}
              max={total.ordered}
              labels={ds.barList}
              items={stageFigures(total).map((figure) => ({
                id: figure.stage,
                label: stageName(figure.stage),
                value: figure.done,
                valueText: figure.done === null ? undefined : w.t('parts.pieces.of', { done: number(figure.done), total: number(figure.total) }),
                sub: figure.done === null ? w.t('parts.pieces.notCounted') : undefined,
              }))}
            />
            <div className="fw-prp-grid-wide">
              <SummaryTable
                label={w.t('parts.pieces.bySize', { name: colourway.label })}
                columns={[w.t('parts.pieces.stage'), ...colourway.sizes.map((size) => size.size), w.t('parts.pieces.total')]}
                align={[undefined, ...colourway.sizes.map(() => 'right' as const), 'right']}
                rows={rowsByStage.map((stage) => ({ id: stage, cells: [stageName(stage), ...colourway.sizes.map((size) => pieceCell(size, stage)), pieceCell(total, stage)] }))}
              />
            </div>
            <div className="fw-prp-grid-narrow">
              <SummaryTable
                label={w.t('parts.pieces.bySize', { name: colourway.label })}
                columns={[w.t('parts.pieces.size'), ...rowsByStage.map(stageName)]}
                align={[undefined, ...rowsByStage.map(() => 'right' as const)]}
                stackOnPhone
                rows={[...colourway.sizes.map((size) => ({ id: size.size, cells: [size.size, ...rowsByStage.map((stage) => pieceCell(size, stage))] })), { id: 'total', cells: [w.t('parts.pieces.total'), ...rowsByStage.map((stage) => pieceCell(total, stage))] }]}
              />
            </div>
          </section>
        )
      })}
    </div>
  )
}
