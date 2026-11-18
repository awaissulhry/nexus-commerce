'use client'

import Link from 'next/link'
import { Card, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { DetailModal } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { useProductionWords } from '../../../../../lib/production/words'
import { FreshnessLine } from '../../../../../lib/production/view/FreshnessLine'
import { HealthPill } from '../../../../../lib/production/view/HealthPill'
import { PiecesGrid } from '../../../../../lib/production/view/PiecesGrid'
import { StageStrip } from '../../../../../lib/production/view/StageStrip'
import { WaitingOnPill } from '../../../../../lib/production/view/WaitingOnPill'
import { RecordPicture } from '../../../../../lib/record-picture/view/RecordPicture'
import type { Order } from '../../api'
import { dayInstant } from '../../model'
import {
  bandHealthOf,
  exFactoryOf,
  headlineOf,
  healthInputOf,
  inWorkOf,
  LINE_COLUMNS,
  lineRowsOf,
  lineSizesOf,
  nothingCutYet,
  preparingNote,
  readOf,
  stageStripOf,
  totalOf,
  waitingInputOf,
  type Figure,
  type LineColumn,
  type LineRow,
} from '../overview/model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { PartState } from './OrderRecordView'

/** The columns' words: the shared pieces catalogue's (production `parts.pieces.stages.*`, Shipped added there). */
const COLUMN_STAGE: Readonly<Record<LineColumn, string>> = Object.freeze({ ordered: 'ORDERED', cut: 'CUT', sewn: 'SEWN', checked: 'INSPECTED', packed: 'PACKED', shipped: 'SHIPPED' })

/**
 * F-SA-232 (sales page plan N2, picks P2, P3, P4, P15, R9; 10-order-page §2.1 O1, O2; review OW-6, OW-7) — Overview, the order page's
 * first tab: "Where it is now" (the plain stage and "1 line ahead" — or before / after production the commercial words —, who acts
 * next, the ex-factory date and how often it moved, the health, the customer's own urgency, the bundles in work as counts, the five
 * plain stages with the blocked mark, "Live · as of 10:42") and "Progress by line" (the order's OWN pieces per colour line, the
 * made-to-measure units of one style × colourway as one row; "Not counted here", never 0) whose row opens the line's sizes in a
 * centred window (‹ › walk the lines). The production lane's parts in place (StageStrip, HealthPill, WaitingOnPill, PiecesGrid,
 * FreshnessLine) and the one picture part. Office face only: no operator, no station, no other customer.
 */
export function OverviewTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <div className="fw-so-overview">
      <WhereItIs order={order} model={model} actions={actions} />
      <ProgressByLine order={order} model={model} actions={actions} />
    </div>
  )
}

function WhereItIs({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const state = model.production ?? null
  const read = readOf(state)
  const headline = read?.headline ?? null
  const loading = !state || state.status === 'loading'
  const words = headlineOf(order, headline)
  const sentence =
    words.kind === 'stage'
      ? [w.t(`parts.stage.${words.stage}`), words.ahead ? t(words.ahead.key, words.ahead.params) : null].filter(Boolean).join(' · ')
      : words.kind === 'unknown'
        ? w.t('parts.stage.unknown')
        : t(words.phrase.key, Object.fromEntries(Object.entries(words.phrase.params ?? {}).map(([key, value]) => [key, typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? formatDate(value, { locale }) : value])))
  const strip = stageStripOf(order, headline, read?.dates ?? null, locale)
  const preparing = preparingNote(order, headline)
  const exFactory = exFactoryOf(order, headline)
  const health = healthInputOf(order, headline, read?.dates ?? null)
  const inWork = inWorkOf(headline)
  const facts = [
    { label: t('overview.fact.who'), value: <WaitingOnPill face="office" loading={loading} {...waitingInputOf(headline, locale)} /> },
    ...(exFactory ? [{ label: t('overview.fact.exFactory'), value: t(exFactory.key, { ...exFactory.params, date: formatDate(dayInstant(String(exFactory.params?.date ?? '')), { locale }) }) }] : []),
    { label: t('overview.fact.health'), value: <HealthPill face="office" loading={loading} {...health} /> },
    ...(headline?.urgency.customer?.code === 'URGENT' ? [{ label: t('overview.fact.customer'), value: <Tag tone="warning">{t('board.customerUrgent')}</Tag> }] : []),
    ...(inWork ? [{ label: t('overview.fact.inWork'), value: t('overview.bundles', { count: inWork.count, stage: w.t(`parts.stage.${inWork.stage}`) }) }] : []),
  ]
  return (
    <Card padded className="fw-so-where">
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('overview.where')}</h2>
        <FreshnessLine mode={model.liveState === 'live' ? 'live' : model.liveState === 'offline' ? 'offline' : 'connecting'} asOf={read?.asOf ?? null} />
      </div>
      {loading ? <Skeleton width={260} height={24} /> : <p className="fw-so-headline">{sentence}</p>}
      <KeyValue dense labelCase="sentence" columns={2} items={facts} />
      <StageStrip
        face="office"
        layout="auto"
        label={t('overview.where')}
        {...strip}
        note={preparing ? t(preparing.key) : (strip.note ?? null)}
        promise={headline?.promise.date ?? order.promiseDate ? { date: (headline?.promise.date ?? order.promiseDate)!, history: order.promiseHistory.map((move) => ({ on: move.at, from: move.from, to: move.to, reason: null })) } : null}
        loading={loading}
        problem={state?.status === 'failed'}
        onRetry={() => actions?.onRetryProduction?.()}
      />
    </Card>
  )
}

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

function ProgressByLine({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
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
            density="roomy"
            stackOnPhone
            rows={[
              ...rows.map((row) => {
                const line = order.lines.find((entry) => row.lineIds.includes(entry.id)) ?? null
                return {
                  id: row.id,
                  cells: [
                    <button key="l" type="button" className="fw-so-lineopen" onClick={() => actions?.onOpenLine?.(row.id)} aria-label={t('overview.lineOpen', { seq: row.seq, name: nameOf(row) })}>
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
                        <span className="fw-so-cell-sub">
                          {stageOf(row)}
                          {row.notInWorkOrders && <Tag tone="neutral">{t('overview.notInWorkOrders')}</Tag>}
                          {row.madeExtra > 0 && <Tag tone="warning">{t('overview.madeExtra', { count: row.madeExtra })}</Tag>}
                        </span>
                      </span>
                    </button>,
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
        <Button size="sm" asChild>
          <Link href={`${model.prefix}/sales/orders/${order.id}?tab=lines`}>{t('overview.sizes.openLines')}</Link>
        </Button>
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

/** The band's health chip from the production read (Late or At risk only), with its why; the order read's lateness until it comes. */
export function BandHealth({ order, model }: { order: Order; model: OrderRecordModel }) {
  const read = readOf(model.production)
  const input = healthInputOf(order, read?.headline ?? null, read?.dates ?? null)
  if (!bandHealthOf(input)) return null
  return <HealthPill face="office" {...input} />
}

/** "Urgent (customer)" in the band when the customer marked it (read only). */
export function BandUrgency({ model }: { model: OrderRecordModel }) {
  const t = useT('orders')
  const read = readOf(model.production)
  return read?.headline?.urgency.customer?.code === 'URGENT' ? <Tag tone="warning">{t('board.customerUrgent')}</Tag> : null
}
