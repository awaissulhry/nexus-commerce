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
// ---- F-SA-233: People (the production lane's SupervisorFact in place), Next dates, Requests & changes, Linked records, Order facts ----
import { SupervisorFact } from '../../../../_shared/production-supervisor/view/SupervisorFact'
import { NOTES_NS, openHeld as noteHeld } from '../../../../production/_shared/notes/model'
import { NAMESPACE as DEPTH } from '../../depth/model'
import { linkedRecordsOf, nextDatesOf, placeWords, requestCountsOf } from '../overview/model'
// F-SA-243: "Waiting on us: N · Answer…" opens the ONE review window here; "Still to do: N" with its top 3 rows.
import { WithMessages } from '../../../../../record-panels/i18n'
import { askingOf, stillRowsOf } from '../changes/model'
import { AnswerDoor, StillRow } from './RequestsSection'
// F-SA-266: Discuss on Overview's rows (a line, a next date, the request that waits on us)
import { DiscussDoor, FollowersDoor } from './Discuss'
// ---- end F-SA-233

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
      {/* F-SA-233: the facts beside each other (a card grid that follows the body's width, never dead space). */}
      <div className="fw-so-overview-cards">
        <PeopleCard order={order} model={model} actions={actions} />
        <NextDatesCard order={order} model={model} />
        <RequestsCard order={order} model={model} />
        <LinkedCard order={order} model={model} />
        <FactsCard order={order} model={model} />
      </div>
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
                        <span className="fw-so-cell-sub">
                          {stageOf(row)}
                          {row.notInWorkOrders && <Tag tone="neutral">{t('overview.notInWorkOrders')}</Tag>}
                          {row.madeExtra > 0 && <Tag tone="warning">{t('overview.madeExtra', { count: row.madeExtra })}</Tag>}
                        </span>
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

// ---- F-SA-233 (10-order-page §2.1 O3–O7) --------------------------------------------------------------------------------------

/**
 * O3 People (P3): the supervisor (SupervisorFact: Change… with production.brand.manage, Ask with threads.post), the customer's backup,
 * who answers the customer (the order thread's owner: there is no other sales owner), who made the order and when, where it is made —
 * places only (site · line · team, or an outside workshop). No operator, no team member, no per-person output (Statuto art. 4). The
 * people part needs workorders.view (its names stay inside this record); without it: held in words, never "Not set".
 */
function PeopleCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const notes = useT(NOTES_NS)
  const locale = useLocale()
  const state = model.production ?? null
  const read = readOf(state)
  const people = read?.people ?? null
  const withheld = !!read && read.withheld.includes('people')
  const madeBy = order.createdById ? (order.people.find((person) => person.id === order.createdById)?.name ?? null) : null
  const askWait = model.people ? noteHeld(model.people.mayNote, 1) : null
  const supervisor = people?.supervisor ?? null
  const items = [
    ...(people
      ? [
          { label: t('overview.people.backup'), value: people.backup?.name ?? '—' },
          { label: t('overview.people.answers'), value: people.answersCustomer?.name ?? '—' },
        ]
      : []),
    { label: t('overview.people.madeBy'), value: madeBy ? t('overview.people.madeByOn', { name: madeBy, date: formatDate(order.createdAt, { locale }) }) : formatDate(order.createdAt, { locale }) },
    ...(people ? [{ label: t('overview.people.where'), value: people.places.length > 0 ? people.places.map(placeWords).join(' · ') : t('overview.people.notPlanned') }] : []),
  ]
  return (
    <Card padded>
      <h2 className="fw-so-h2">{t('overview.people.title')}</h2>
      {!state || state.status === 'loading' ? (
        <Skeleton height={44} />
      ) : (
        <div className="fw-so-stack">
          {people && (
            <SupervisorFact
              fact={supervisor ? { kind: 'person', name: supervisor.name, active: supervisor.active, from: supervisor.from, me: supervisor.me, muted: false } : { kind: 'notSet' }}
              can={!!model.people?.mayAssign}
              onChange={() => actions?.people?.onAssign?.()}
              ask={model.people ? { label: notes('open.askFact'), held: askWait ? notes(askWait.key, askWait.params) : null, onAsk: () => actions?.people?.onAsk?.() } : undefined}
            />
          )}
          {withheld && <p className="fw-so-hint">{t('overview.people.held')}</p>}
          <KeyValue dense labelCase="sentence" items={items} />
          {/* F-SA-265 / F-SA-266: who is told about this order — the thread's followers (the frame's door). */}
          <FollowersDoor />
        </div>
      )}
    </Card>
  )
}

/** O4 Next dates (P16): the next three to come, late first in amber; "All dates ›" opens Production › Dates & milestones. */
function NextDatesCard({ order, model }: { order: Order; model: OrderRecordModel }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const state = model.production ?? null
  const read = readOf(state)
  const rows = nextDatesOf(read?.dates ?? null, order.promiseDate)
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  return (
    <Card padded>
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('overview.dates.title')}</h2>
        <Link className="fw-so-link fw-so-hint" href={`${model.prefix}/sales/orders/${order.id}?tab=production#dates`}>
          {t('overview.dates.all')}
        </Link>
      </div>
      {!state || state.status === 'loading' ? (
        <Skeleton height={44} />
      ) : rows.length === 0 ? (
        <p className="fw-so-hint">{t('overview.dates.none')}</p>
      ) : (
        <ul className="fw-so-datelist">
          {rows.map((row) => {
            // F-SA-266: a gate is discussed by its reference (the customer reads its own words); a date of the working plan or the
            // ex-factory date in an office note, in words.
            const what = row.what.kind === 'gate' ? (row.what.label ?? d(`gate.${row.what.gateKind ?? 'OTHER'}`)) : row.what.kind === 'milestone' ? d(`milestone.kind.${row.what.milestone}`) : t('overview.fact.exFactory')
            const gateId = row.what.kind === 'gate' ? ((read?.dates?.milestones ?? []).find((milestone) => milestone.id === row.id)?.gateId ?? null) : null
            return (
            <li key={row.id}>
              <span className="fw-so-inline">
                {what}
                <DiscussDoor order={order} part={row.target ? `${what} · ${day(row.target)}` : what} target={gateId ? { kind: 'OrderGate', id: gateId } : null} />
              </span>
              <span className="fw-so-cell-sub">
                {row.target ? d('milestone.target', { date: day(row.target) }) : '—'}
                {row.late !== null && row.late > 0 && (
                  <>
                    {' '}
                    <Tag tone="warning">{d('milestone.lateBy', { count: row.late })}</Tag>
                  </>
                )}
              </span>
            </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/**
 * O5 Requests & changes: what waits on us (F-SA-243: "Waiting on us: N · Answer…" — the ONE review window on this page), on the
 * customer, "Still to do: N" with its top 3 rows (each a door), the latest change.
 */
function RequestsCard({ order, model }: { order: Order; model: OrderRecordModel }) {
  const t = useT('orders')
  const w = useProductionWords() // F-SA-266: the request's kind in the catalogue's words
  const locale = useLocale()
  const read = readOf(model.production)
  const counts = requestCountsOf(read, order)
  // F-SA-243: the first request waiting on us opens the window (when this page read the requests); the rows still to do.
  const asking = askingOf(model.requests?.value ?? [])
  const still = stillRowsOf(read)
  const nothing = counts.onUs === 0 && counts.onCustomer === 0 && still.length === 0
  return (
    <Card padded>
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('overview.requests.title')}</h2>
        <Link className="fw-so-link fw-so-hint" href={`${model.prefix}/sales/orders/${order.id}?tab=changes`}>
          {t('overview.requests.changes')}
        </Link>
      </div>
      <ul className="fw-so-datelist">
        {counts.onUs > 0 && (
          <li className="fw-so-still">
            <span>{t('overview.requests.onUs', { count: counts.onUs })}</span>
            {asking && <AnswerDoor request={asking.first} model={model} />}
            {/* F-SA-266: discuss the request that waits on us (its reference; the customer reads its own words). */}
            {asking && <DiscussDoor order={order} part={t('discuss.request', { kind: w.t(`parts.request.kind.${asking.first.kind}`) })} target={{ kind: 'OrderChangeRequest', id: asking.first.id }} />}
          </li>
        )}
        {counts.onCustomer > 0 && <li>{t('overview.requests.onCustomer', { count: counts.onCustomer })}</li>}
        {still.length > 0 && (
          <li>
            <Link className="fw-so-link" href={`${model.prefix}/sales/orders/${order.id}?tab=changes#still-to-do`}>
              {t('overview.requests.still', { count: still.length })}
            </Link>
            <WithMessages namespaces={['approvals']}>
              <ul className="fw-so-datelist">
                {still.slice(0, 3).map((row, index) => (
                  <StillRow key={`${row.kind}:${row.ref?.id ?? index}`} row={row} order={order} model={model} />
                ))}
              </ul>
            </WithMessages>
          </li>
        )}
        {nothing && <li className="fw-so-hint">{t('overview.requests.nothing')}</li>}
        {counts.latest && <li className="fw-so-hint">{t('overview.requests.latest', { revision: counts.latest.revision, date: counts.latest.at ? formatDate(counts.latest.at, { locale }) : '—' })}</li>}
      </ul>
    </Card>
  )
}

/** O6 Linked records: count buttons, each a real link; a list without its right is held in words with no number; left-out work orders counted. */
function LinkedCard({ order, model }: { order: Order; model: OrderRecordModel }) {
  const t = useT('orders')
  const read = readOf(model.production)
  const links = model.links && model.links.state === 'ready' ? model.links.links : null
  const { records, workOrdersLeftOut } = linkedRecordsOf({
    order,
    prefix: model.prefix,
    can: model.can,
    work: read?.work,
    complaints: links?.complaints ? links.complaints.length : null,
    returns: links?.returns ? links.returns.length : null,
    sameQuote: model.depth?.depth.value?.sameQuote ?? [],
    madeFrom: model.madeFromReading ? undefined : (model.madeFrom ?? null),
  })
  return (
    <Card padded>
      <h2 className="fw-so-h2">{t('overview.linked.title')}</h2>
      <ul className="fw-so-linked" aria-label={t('overview.linked.title')}>
        {records.map((entry, index) => {
          const label = t(`overview.linked.${entry.key}`)
          const value = entry.held ? t(entry.held.key) : entry.words ? t(entry.words.key, entry.words.params) : String(entry.count ?? '—')
          return (
            <li key={`${entry.key}-${index}`}>
              {entry.href ? (
                <Link className="fw-so-countbtn" href={entry.href}>
                  <span>{label}</span> <strong>{value}</strong>
                </Link>
              ) : (
                <span className="fw-so-countbtn is-plain">
                  <span>{label}</span> <strong>{value}</strong>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {workOrdersLeftOut > 0 && <p className="fw-so-hint">{t('overview.linked.leftOut', { count: workOrdersLeftOut })}</p>}
    </Card>
  )
}

/** O7 Order facts (loaded, never shown before): ordered on, requested, the customer PO, the season, the language, the tax mode, made · changed. */
function FactsCard({ order, model }: { order: Order; model: OrderRecordModel }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const season = model.depth?.depth.value?.season ?? null
  const language = t(`overview.facts.lang.${order.language === 'en' ? 'en' : 'it'}`)
  return (
    <Card padded>
      <h2 className="fw-so-h2">{t('overview.facts.title')}</h2>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('dates.ordered'), value: day(order.orderDate) },
          { label: t('dates.requested'), value: day(order.requestedDate) },
          { label: t('overview.facts.customerRef'), value: order.customerRef ?? '—' },
          ...(season ? [{ label: d('season.label'), value: season.code }] : []),
          { label: t('overview.facts.language'), value: language },
          { label: t('newOrder.taxMode'), value: t(`newOrder.taxModes.${order.taxMode}`) },
          { label: t('overview.facts.made'), value: t('overview.facts.madeValue', { made: formatDate(order.createdAt, { locale }), changed: formatDate(order.updatedAt, { locale }) }) },
        ]}
      />
    </Card>
  )
}
// ---- end F-SA-233
