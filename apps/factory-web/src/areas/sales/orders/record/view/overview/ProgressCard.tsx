'use client'

import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { DetailModal } from '../../../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { useProductionWords } from '../../../../../../lib/production/words'
import { PiecesGrid } from '../../../../../../lib/production/view/PiecesGrid'
import { RecordPicture } from '../../../../../../lib/record-picture/view/RecordPicture'
import type { Order } from '../../../api'
import { dayInstant } from '../../../model'
import { readOf } from '../../overview/model'
import { LINE_COLUMNS, lineRowsOf, lineSizesOf, nothingCutYet, totalOf, type Figure, type LineColumn, type LineRow } from '../../overview/progress'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { PartState } from '../OrderRecordView'
import { useSearchParams } from 'next/navigation'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { DiscussDoor } from '../Discuss' // F-SA-266: Discuss on a line's row

/**
 * F-OO-100 (order overview lane: one file per card) — "Progress by line", moved out of OverviewTab.tsx unchanged (F-SA-232: the
 * order's OWN pieces per colour line, the made-to-measure units of one style × colourway as one row; "Not counted here", never 0),
 * whose row opens the line's sizes in a centred window (‹ › walk the lines).
 */

/** F-OP-302 (walk #4): Progress by line's column widths — the line a third, the six counts share the rest. */
const PROGRESS_WIDTHS: readonly (string | undefined)[] = ['34%']

/** The columns' words: the shared pieces catalogue's (production `parts.pieces.stages.*`, Shipped added there). */
const COLUMN_STAGE: Readonly<Record<LineColumn, string>> = Object.freeze({ ordered: 'ORDERED', cut: 'CUT', sewn: 'SEWN', checked: 'INSPECTED', packed: 'PACKED', shipped: 'SHIPPED' })

/** One figure cell: the count, or "—" with "Not counted here" (never a made-up 0). */
function FigureCell({ value }: { value: Figure }) {
  const w = useProductionWords()
  if (value !== null) return <span>{value}</span>
  return (
    <span className="fw-so-cell">
      <span aria-hidden>—</span>
      <span className="fw-so-cell-sub">{w.t('parts.pieces.notCounted')}</span>
    </span>
  )
}

export function ProgressCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const state = model.production ?? null
  const read = readOf(state)
  if (!state || state.status === 'loading') {
    return (
      <Card padded aria-busy="true">
        <h2 className="fw-so-h2">{t('overview.progress')}</h2>
        <div className="fw-so-stack" role="status" aria-label={w.t('parts.pieces.loading')}>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} height={22} />
          ))}
        </div>
      </Card>
    )
  }
  if (state.status === 'failed' || !read?.lines) return <PartState problem={state.status === 'failed' ? state.problem : 'problem.read.internal'} label={t('overview.progress')} onRetry={() => actions?.onRetryProduction?.()} />
  const rows = lineRowsOf(read.lines, order)
  const total = totalOf(rows)
  const nameOf = (row: LineRow) => `${row.style?.code ?? '—'} · ${row.colourway?.name ?? row.colourway?.code ?? '—'}`
  const stageOf = (row: LineRow) =>
    row.mtm
      ? t('mtm.units', { count: row.mtm.units })
      : row.stage
        ? t('overview.lineName', { seq: row.seq, stage: w.t(`parts.stage.${row.stage}`) })
        : t('overview.lineNoStage', { seq: row.seq })
  const columns = [t('overview.col.line'), ...LINE_COLUMNS.map((column) => w.t(`parts.pieces.stages.${COLUMN_STAGE[column]}`))]
  const open = model.overviewLine ? (rows.find((row) => row.id === model.overviewLine) ?? null) : null
  return (
    <Card padded>
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('overview.progress')}</h2>
        <span className="fw-so-hint">{t('overview.progressHint')}</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={w.t('parts.pieces.none')} />
      ) : (
        <>
          {nothingCutYet(rows) && <p className="fw-so-hint">{w.t('parts.pieces.nothingCut')}</p>}
          <SummaryTable
            label={t('overview.progress')}
            columns={columns}
            align={columns.map((_, index) => (index === 0 ? 'left' : 'right'))}
            // F-OP-302 (walk #4): the table is fixed-layout — an equal seventh left the line (picture, name, stage, pills) too
            // narrow, so its pill ran over the Ordered number; the line gets a third, the six counts share the rest.
            widths={PROGRESS_WIDTHS}
            density="roomy"
            stackOnPhone
            rows={[
              ...rows.map((row) => {
                const line = order.lines.find((entry) => row.lineIds.includes(entry.id)) ?? null
                return {
                  id: row.id,
                  cells: [
                    // F-SA-266: the line's own Discuss beside the button that opens its sizes (one line: its reference; a made-to-measure
                    // group of units: in words, in an office note).
                    <span key="l" className="fw-so-inline">
                    <button type="button" className="fw-so-lineopen" onClick={() => actions?.onOpenLine?.(row.id)} aria-label={t('overview.lineOpen', { seq: row.seq, name: nameOf(row) })}>
                      <RecordPicture
                        source="order"
                        recordId={order.id}
                        number={nameOf(row)}
                        size="line"
                        picture={line?.style ? { styleId: line.styleId, styleCode: line.style.code, styleName: line.style.name, fileId: line.picture?.fileId ?? null, small: !!line.picture?.small } : null}
                        held={line?.picture?.small ?? null}
                      />
                      <span className="fw-so-cell">
                        <span>{nameOf(row)}</span>
                        <span className="fw-so-cell-sub">{stageOf(row)}</span>
                        {/* F-OP-302 (walk #4, #20): the line's pills on their own wrapping row under its stage — never inside the
                            one-line sub (cut at 375) and never over the Ordered number. */}
                        {(row.notInWorkOrders || row.madeExtra > 0) && (
                          <span className="fw-so-inline">
                            {row.notInWorkOrders && <Tag tone="neutral">{t('overview.notInWorkOrders')}</Tag>}
                            {row.madeExtra > 0 && <Tag tone="warning">{t('overview.madeExtra', { count: row.madeExtra })}</Tag>}
                          </span>
                        )}
                      </span>
                    </button>
                    <DiscussDoor order={order} part={t('discuss.line', { seq: row.seq, name: nameOf(row) })} target={row.lineIds.length === 1 ? { kind: 'SalesOrderLine', id: row.lineIds[0]! } : null} />
                    </span>,
                    ...LINE_COLUMNS.map((column) => <FigureCell key={column} value={row.figures[column]} />),
                  ],
                }
              }),
              { id: 'total', cells: [<strong key="t">{t('overview.total', { count: rows.length })}</strong>, ...LINE_COLUMNS.map((column) => <FigureCell key={column} value={total[column]} />)] },
            ]}
          />
          {/* OW-7: the piece counts are at most a minute old (the server keeps them a minute); said, never hidden. */}
          <p className="fw-so-hint">{t('overview.piecesAsOf', { time: formatTime(read.asOf, { locale }) })}</p>
        </>
      )}
      {open && <LineSizes order={order} row={open} rows={rows} label={nameOf(open)} stage={stageOf(open)} model={model} actions={actions} />}
    </Card>
  )
}

/** The line's sizes in a centred DS DetailModal (‹ › and the keys walk the lines): PiecesGrid + shipped + the finish forecast per size. */
function LineSizes({ order, row, rows, label, stage, model, actions }: { order: Order; row: LineRow; rows: readonly LineRow[]; label: string; stage: string; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? '' // F-OP-210
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const read = readOf(model.production)
  const sizes = lineSizesOf(row, read?.lines ?? [], read?.dates ?? null, label)
  const extraWords = (count: number) => (count > 0 ? t('overview.madeExtra', { count }) : '—')
  return (
    <DetailModal
      open
      onClose={() => actions?.onOpenLine?.(null)}
      title={label}
      subtitle={stage}
      nav={{ ids: rows.map((entry) => entry.id), current: row.id, onGo: (id) => actions?.onOpenLine?.(id), noun: t('overview.sizes.noun') }}
      footer={
        // F-OP-104: beside Open in Lines, Open in Production (the line's place there); both keep the dock's scope.
        <span className="fw-so-inline">
          <Button size="sm" asChild>
            <TabLink href={tabHref(recordHref, 'lines', search)}>{t('overview.sizes.openLines')}</TabLink>
          </Button>
          <Button size="sm" asChild>
            <TabLink href={`${tabHref(recordHref, 'production', search)}#line-${row.lineIds[0] ?? row.id}`}>{t('doors.openInProduction')}</TabLink>
          </Button>
        </span>
      }
    >
      {sizes.units !== null ? (
        <p className="fw-so-hint">{t('overview.sizes.units')}</p>
      ) : (
        <div className="fw-so-stack">
          <PiecesGrid colourways={[sizes.colourway]} />
          <SummaryTable
            label={t('overview.sizes.label')}
            columns={[t('overview.sizes.size'), w.t('parts.pieces.stages.SHIPPED'), t('overview.sizes.finish'), t('overview.sizes.extra')]}
            align={['left', 'right', 'right', 'right']}
            stackOnPhone
            rows={sizes.sizes.map((size) => ({ id: size.size, cells: [size.size, String(size.shipped), size.finish ? formatDate(dayInstant(size.finish), { locale }) : t('overview.sizes.noForecast'), extraWords(size.madeExtra)] }))}
          />
        </div>
      )}
    </DetailModal>
  )
}
