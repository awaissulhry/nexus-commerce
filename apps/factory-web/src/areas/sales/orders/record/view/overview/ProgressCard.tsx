'use client'

import Link from 'next/link'
import { ChevronDown, MoreHorizontal } from 'lucide-react' // F-OO-122, F-OO-126
import { Card, EmptyState, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { DetailModal } from '../../../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { useProductionWords } from '../../../../../../lib/production/words'
import { PiecesGrid } from '../../../../../../lib/production/view/PiecesGrid'
import { RecordPicture } from '../../../../../../lib/record-picture/view/RecordPicture'
import type { Order } from '../../../api'
import { dayInstant, type Phrase } from '../../../model'
import { readOf } from '../../overview/model'
import { LINE_COLUMNS, lineRowsOf, lineSizesOf, totalOf, type LineRow } from '../../overview/progress'
// ---- F-OO-121: the clean line cell — quiet "—", at most two pills, the missing picture ----
import { figureFaceOf, LINE_PILLS_SHOWN, linePillsOf, madeExtraSizesText, pillToneOf, stylePictureHref, type FigureFace, type LinePill } from '../../overview/progress'
import './progress.css'
// ---- end F-OO-121
// ---- F-OO-122: the row ⋯ — the line's moves through the page's own doors (the line doors of F-OO-123/124/125, the conversation) ----
import { lineMovesOf, lineMovesShown, type LineMove } from '../../overview/progress'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import { discussAboutOf } from '../../dock/discuss'
// ---- end F-OO-122
// ---- F-OO-126: the line's window — its work orders (their pages) and their final inspections ----
import { lineFinalsOf, lineWorkOf, type LineFinals, type LineWork } from '../../overview/progress'
import { recordAddress } from '../../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../../shell/nav/office-nav'
// ---- end F-OO-126
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { PartState } from '../OrderRecordView'
import { useSearchParams } from 'next/navigation'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'

/**
 * F-OO-100 (order overview lane: one file per card) — "Progress by line", moved out of OverviewTab.tsx unchanged (F-SA-232: the
 * order's OWN pieces per colour line, the made-to-measure units of one style × colourway as one row; "Not counted here", never 0),
 * whose row opens the line's sizes in a centred window (‹ › walk the lines).
 * F-OO-121 (10-design §2.2): the line cell says its name, "Line 10" and at most two pills — no stage word, no hint, no "Nothing cut
 * yet"; a line with no work order is "—" with no sub; a line with no picture says so, with the style's door for who may add one.
 */

/** F-OP-302 (walk #4): Progress by line's column widths — the line a third, the six counts share the rest. */
const PROGRESS_WIDTHS: readonly (string | undefined)[] = ['34%']
/** F-OO-122: + the row ⋯ last (its heading "Actions" and the DS button: 72 px). */
const PROGRESS_WIDTHS_MOVES: readonly (string | undefined)[] = ['34%', undefined, undefined, undefined, undefined, undefined, undefined, '72px']

/** The columns' words: the shared pieces catalogue's (production `parts.pieces.stages.*`, Shipped added there). */
const COLUMN_STAGE: Readonly<Record<(typeof LINE_COLUMNS)[number], string>> = Object.freeze({ ordered: 'ORDERED', cut: 'CUT', sewn: 'SEWN', checked: 'INSPECTED', packed: 'PACKED', shipped: 'SHIPPED' })

/** One figure cell: the count; F-OO-121: "—" alone on a line with no work order; or "—" with "Not counted here" (never a made-up 0). */
function FigureCell({ face }: { face: FigureFace }) {
  const w = useProductionWords()
  if (face.kind === 'count') return <span>{face.value}</span>
  if (face.kind === 'none') return <span>—</span>
  return (
    <span className="fw-so-cell">
      <span aria-hidden>—</span>
      <span className="fw-so-cell-sub">{w.t('parts.pieces.notCounted')}</span>
    </span>
  )
}

// ---- F-OO-121: a pill's words (the catalogue's own where they exist: closed short, on hold, not in work orders, late) ----
function usePillWords(): (pill: LinePill) => string {
  const t = useT('orders')
  const w = useProductionWords()
  return (pill) => {
    switch (pill.kind) {
      case 'closedShort':
        return t('lines.closedShort', { count: pill.count })
      case 'onHold':
        return t('production.held')
      case 'notInWorkOrders':
        return t('overview.notInWorkOrders')
      case 'inWork':
        return t('progress.inWork', { done: pill.done, total: pill.total })
      case 'madeExtra':
        // B-OO-015: one wording with the API's — "1 48 more than ordered: cut or planned to cut".
        return t('progress.madeExtra', { sizes: madeExtraSizesText(pill.sizes) })
      case 'late':
        return pill.days ? w.t('parts.health.lateBy', { count: pill.days }) : w.t('parts.health.LATE')
    }
  }
}

/** The pills as DS Tags; in the line cell each stays on one line (its full words in its title and in the line's window). */
function Pills({ pills, truncate }: { pills: readonly LinePill[]; truncate?: boolean }) {
  const words = usePillWords()
  if (pills.length === 0) return null
  return (
    <span className="fw-so-inline">
      {pills.map((pill) => (
        <Tag key={pill.kind} tone={pillToneOf(pill)} truncate={truncate} title={truncate ? words(pill) : undefined}>
          {words(pill)}
        </Tag>
      ))}
    </span>
  )
}
// ---- end F-OO-121

// ---- F-OO-122 (10-design §2.3): the line's moves — the menu's items, held with the band's words; what each one opens ----
interface LineMoves {
  /** Read-only sees no ⋯ (the column and the window's menu). */
  readonly shown: boolean
  /** The menu's items; `first` runs before the move (the window closes first: one dialog at a time). */
  readonly itemsOf: (row: LineRow, name: string, first?: () => void) => MenuItemDef[]
}

function useLineMoves(order: Order, model: OrderRecordModel, actions?: OrderRecordActions): LineMoves {
  const t = useT('orders')
  const locale = useLocale()
  const frame = useRecordFrame()
  const lines = readOf(model.production)?.lines ?? []
  const heldWords = (held: Phrase) => t(held.key, held.params?.date ? { ...held.params, date: formatDate(dayInstant(String(held.params.date)), { locale }) } : held.params)
  // F-SA-266: the line's Discuss, as DiscussDoor builds it (one line: its reference; a made-to-measure group: words, an office note).
  const discuss = (row: LineRow, name: string) => {
    const yourOrder = order.customerSeq ? t('discuss.yourOrderSeq', { seq: order.customerSeq }) : t('discuss.yourOrder')
    const about = discussAboutOf(order, { yourOrder, firstLine: (words) => t('discuss.firstLine', { thing: words }) }, { part: t('discuss.line', { seq: row.seq, name }), target: row.lineIds.length === 1 ? { kind: 'SalesOrderLine', id: row.lineIds[0]! } : null })
    frame?.discuss?.({ record: { type: 'SalesOrder', id: order.id }, about })
  }
  const run = (row: LineRow, name: string, move: LineMove) => {
    if (move.id === 'make') actions?.makeWorkOrders?.onOpenLine?.(move.lineId)
    else if (move.id === 'close') actions?.onDialog?.({ kind: 'closeLines', lineIds: move.lineIds })
    else if (move.id === 'reopen') actions?.onDialog?.({ kind: 'reopenLines', lineIds: move.lineIds })
    else if (move.id === 'change') actions?.onLineChange?.(move.styleId)
    else discuss(row, name)
  }
  const movesOf = (row: LineRow) => lineMovesOf(row, order, model.can, { lines, thread: !!frame?.discuss })
  return {
    shown: lineMovesShown(model),
    itemsOf: (row, name, first) =>
      movesOf(row).map((move) => ({
        id: move.id,
        label: t(`progress.move.${move.id}`),
        disabled: !!move.held,
        description: move.held ? heldWords(move.held) : undefined,
        onSelect: move.held
          ? undefined
          : () => {
              first?.()
              run(row, name, move)
            },
      })),
  }
}

/** The row's ⋯ (the DS Menu; its name says the line). */
function LineMovesMenu({ row, name, moves }: { row: LineRow; name: string; moves: LineMoves }) {
  const t = useT('orders')
  return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('progress.moves', { seq: row.seq, name }) }} items={moves.itemsOf(row, name)} />
}
// ---- end F-OO-122

export function ProgressCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const state = model.production ?? null
  const read = readOf(state)
  const moves = useLineMoves(order, model, actions) // F-OO-122 (a hook: before the early returns)
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
  const totalQuiet = rows.every((row) => row.quiet) // F-OO-121: no line in work orders yet — the total says "—" too
  const nameOf = (row: LineRow) => `${row.style?.code ?? '—'} · ${row.colourway?.name ?? row.colourway?.code ?? '—'}`
  // F-OO-121: "Line 10" (made to measure: its units) — no stage word per line.
  const subOf = (row: LineRow) => (row.mtm ? t('mtm.units', { count: row.mtm.units }) : t('overview.lineNoStage', { seq: row.seq }))
  const pillInput = { order, read, today: model.today }
  const columns = [t('overview.col.line'), ...LINE_COLUMNS.map((column) => w.t(`parts.pieces.stages.${COLUMN_STAGE[column]}`)), ...(moves.shown ? [t('wo.col.acts')] : [])]
  const open = model.overviewLine ? (rows.find((row) => row.id === model.overviewLine) ?? null) : null
  return (
    <Card padded>
      {/* F-OO-121: the hint went; "Pieces as of 19:36" stands at the head's right (OW-7: said, never hidden). */}
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('overview.progress')}</h2>
        {rows.length > 0 && <span className="fw-so-hint">{t('overview.piecesAsOf', { time: formatTime(read.asOf, { locale }) })}</span>}
      </div>
      {rows.length === 0 ? (
        <EmptyState title={w.t('parts.pieces.none')} />
      ) : (
        <>
          <SummaryTable
            label={t('overview.progress')}
            columns={columns}
            align={columns.map((_, index) => (index === 0 ? 'left' : 'right'))}
            // F-OP-302 (walk #4): the table is fixed-layout — an equal seventh left the line (picture, name, stage, pills) too
            // narrow, so its pill ran over the Ordered number; the line gets a third, the six counts share the rest.
            widths={moves.shown ? PROGRESS_WIDTHS_MOVES : PROGRESS_WIDTHS}
            density="roomy"
            stackOnPhone
            rows={[
              ...rows.map((row) => {
                const line = order.lines.find((entry) => row.lineIds.includes(entry.id)) ?? null
                return {
                  id: row.id,
                  cells: [
                    // F-OO-121: the button holds the picture, the name and "Line 10"; under them its pills and a missing picture (its
                    // door is a link: never inside the button). F-OO-122: the line's Discuss moved into its ⋯ (no speech icon here).
                    <span key="l" className="fw-so-ov-line">
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
                          <span className="fw-so-cell-sub">{subOf(row)}</span>
                        </span>
                      </button>
                      {/* F-OP-302 (walk #4, #20): the line's pills on their own wrapping row under its stage — never inside the
                          one-line sub (cut at 375) and never over the Ordered number. F-OO-121: two at most, in their order. */}
                      <Pills pills={linePillsOf(row, pillInput, LINE_PILLS_SHOWN)} truncate />
                      {!line?.picture && <NoPicture row={row} model={model} name={nameOf(row)} />}
                    </span>,
                    ...LINE_COLUMNS.map((column) => <FigureCell key={column} face={figureFaceOf(row.figures[column], row.quiet, column)} />),
                    // F-OO-122 (review F8): the line's own moves, last; Read-only has no such column.
                    ...(moves.shown ? [<LineMovesMenu key="m" row={row} name={nameOf(row)} moves={moves} />] : []),
                  ],
                }
              }),
              { id: 'total', cells: [<strong key="t">{t('overview.total', { count: rows.length })}</strong>, ...LINE_COLUMNS.map((column) => <FigureCell key={column} face={figureFaceOf(total[column], totalQuiet, column)} />), ...(moves.shown ? [''] : [])] },
            ]}
          />
        </>
      )}
      {open && <LineSizes order={order} row={open} rows={rows} label={nameOf(open)} sub={subOf(open)} pills={linePillsOf(open, pillInput, Number.POSITIVE_INFINITY)} moves={moves} model={model} actions={actions} />}
    </Card>
  )
}

// ---- F-OO-121: a line with no picture — the words, and the style's door for who may add one (product.styles.manage) ----
function NoPicture({ row, model, name }: { row: LineRow; model: OrderRecordModel; name: string }) {
  const t = useT('orders')
  return (
    <span className="fw-so-inline fw-so-hint">
      <span>{t('progress.noPicture')}</span>
      {model.stylesManage && row.styleId && (
        <Link className="fw-so-link" href={stylePictureHref(model.prefix, row.styleId)} aria-label={t('progress.addPictureOf', { name })}>
          {t('progress.addPicture')}
        </Link>
      )}
    </span>
  )
}
// ---- end F-OO-121

/** The line's sizes in a centred DS DetailModal (‹ › and the keys walk the lines): PiecesGrid + shipped + the finish forecast per size. */
// F-OO-121: the subtitle says "Line 10" (no stage word) and the meta every pill of the line.
// F-OO-126 (10-design §2.4): + its work orders and their final inspections, the line's moves in the head (a move closes the window
// first: the page keeps one dialog at a time), and Open in Production lands on the work orders.
function LineSizes({ order, row, rows, label, sub, pills, moves, model, actions }: { order: Order; row: LineRow; rows: readonly LineRow[]; label: string; sub: string; pills: readonly LinePill[]; moves: LineMoves; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? '' // F-OP-210
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const read = readOf(model.production)
  const sizes = lineSizesOf(row, read?.lines ?? [], read?.dates ?? null, label)
  // F-OO-121 (B-OO-015): a size's extra pieces in the API's words ("1 48 more than ordered: cut or planned to cut").
  const extraWords = (size: string, count: number) => (count > 0 ? t('progress.madeExtra', { sizes: madeExtraSizesText([{ size, count }]) }) : '—')
  const work = lineWorkOf(row, read) // F-OO-126
  return (
    <DetailModal
      open
      onClose={() => actions?.onOpenLine?.(null)}
      title={label}
      subtitle={sub}
      meta={pills.length > 0 ? <Pills pills={pills} /> : undefined}
      // F-OO-126: the same moves as the row's ⋯; each closes the window first (one dialog at a time). Read-only: none.
      actions={
        moves.shown ? (
          <Menu
            align="right"
            label={
              <>
                {t('wo.col.acts')} <ChevronDown size={14} aria-hidden />
              </>
            }
            triggerProps={{ 'aria-label': t('progress.moves', { seq: row.seq, name: label }) }}
            items={moves.itemsOf(row, label, () => actions?.onOpenLine?.(null))}
          />
        ) : undefined
      }
      nav={{ ids: rows.map((entry) => entry.id), current: row.id, onGo: (id) => actions?.onOpenLine?.(id), noun: t('overview.sizes.noun') }}
      footer={
        // F-OP-104: beside Open in Lines, Open in Production; both keep the dock's scope. F-OO-126: it lands on the work orders.
        <span className="fw-so-inline">
          <Button size="sm" asChild>
            <TabLink href={tabHref(recordHref, 'lines', search)}>{t('overview.sizes.openLines')}</TabLink>
          </Button>
          <Button size="sm" asChild>
            <TabLink href={`${tabHref(recordHref, 'production', search)}#work-orders`}>{t('doors.openInProduction')}</TabLink>
          </Button>
        </span>
      }
    >
      {/* Walk #15e: the window's three blocks (the sizes, its work orders, its final inspections) one stack apart — no heading touches
          the table above it. */}
      <div className="fw-so-stack">
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
              rows={sizes.sizes.map((size) => ({ id: size.size, cells: [size.size, String(size.shipped), size.finish ? formatDate(dayInstant(size.finish), { locale }) : t('overview.sizes.noForecast'), extraWords(size.size, size.madeExtra)] }))}
            />
          </div>
        )}
        {/* F-OO-126: what makes the line, and its final inspections (read only: signed on Quality). */}
        <LineWorkPart work={work} order={order} model={model} />
        <LineFinalsPart finals={lineFinalsOf(work, read)} />
      </div>
    </DetailModal>
  )
}

// ---- F-OO-126: "Its work orders" — each a link to its page, its state, its pieces of this line, "On hold" when held ----
function LineWorkPart({ work, order, model }: { work: LineWork; order: Order; model: OrderRecordModel }) {
  const t = useT('orders')
  if (work.kind === 'unread') return null
  const href = (entry: { id: string; number: string }) => `${model.prefix}${recordAddress({ type: 'WorkOrder', id: entry.id, label: entry.number, companyId: order.companyId }, OFFICE_PAGES)}`
  return (
    <section className="fw-so-stack-tight" aria-labelledby="fw-so-line-work">
      <h3 className="fw-so-h3" id="fw-so-line-work">
        {t('progress.work.title')}
      </h3>
      {work.kind === 'withheld' ? (
        <p className="fw-so-hint">{t('progress.work.held')}</p>
      ) : work.kind === 'mtm' ? (
        work.group ? (
          <p className="fw-so-cell">
            <span>{t('production.mtmRow', { style: work.group.style?.code ?? '—', colour: work.group.colourway?.name ?? work.group.colourway?.code ?? '—', units: work.group.units, workOrders: work.group.workOrders })}</span>
            <span className="fw-so-cell-sub">{work.group.byStatus.map((entry) => `${t(`woStatus.${entry.status}`)} ${entry.count}`).join(' · ')}</span>
          </p>
        ) : (
          <p className="fw-so-hint">{t('progress.work.none')}</p>
        )
      ) : (
        <>
          {work.rows.length > 0 ? (
            <ul className="fw-so-datelist">
              {work.rows.map((entry) => (
                <li key={entry.id}>
                  <span className="fw-so-inline">
                    <Link className="fw-so-link" href={href(entry)}>
                      {entry.number}
                    </Link>
                    <span>{t('progress.work.of', { status: t(`woStatus.${entry.status}`), count: entry.pieces })}</span>
                    {entry.held && <Tag tone="warning">{t('production.held')}</Tag>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            work.leftOut === 0 && <p className="fw-so-hint">{t('progress.work.none')}</p>
          )}
          {work.leftOut > 0 && <p className="fw-so-hint">{t('overview.linked.leftOut', { count: work.leftOut })}</p>}
        </>
      )}
    </section>
  )
}

// ---- F-OO-126: "Final inspections" of the line's work orders — the Production tab's own words; withheld without the right ----
function LineFinalsPart({ finals }: { finals: LineFinals }) {
  const t = useT('orders')
  const locale = useLocale()
  if (finals.kind === 'unread') return null
  return (
    <section className="fw-so-stack-tight" aria-labelledby="fw-so-line-finals">
      <h3 className="fw-so-h3" id="fw-so-line-finals">
        {t('production.quality.final')}
      </h3>
      {finals.kind === 'withheld' ? (
        <p className="fw-so-hint">{t('production.quality.finalHeld')}</p>
      ) : finals.rows.length === 0 ? (
        <p className="fw-so-hint">{t('progress.final.none')}</p>
      ) : (
        <ul className="fw-so-datelist">
          {finals.rows.map((entry) => (
            <li key={entry.workOrderId}>
              <span>{t('production.quality.finalRow', { number: entry.number ?? '—', checked: entry.sampleSize })}</span>
              <span className="fw-so-cell-sub">{t(`production.quality.finalState.${entry.status === 'PASSED' || entry.status === 'FAILED' ? entry.status : 'WAITING'}`, { date: entry.on ? formatDate(dayInstant(entry.on), { locale }) : '—' })}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
// ---- end F-OO-126
