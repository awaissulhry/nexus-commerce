'use client'

import { useEffect, useState } from 'react'
import { ArrowUpRight, CheckCircle2, Clock, History, Hourglass } from 'lucide-react'
import { Banner, Card, ChangeReview, DetailPopover, Disclosure, KeyValue, ProgressBar, SummaryTable, type KeyValueItem } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { Button, Pill } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import type { ApprovalPage, ChangeRequest, DepositRead, OrderRecord, ProgressRead } from '../api'
import { milestoneSteps, movesOf, netMoved, openDeposits, promiseMoves, promiseOf, requestTone, shipToLines, sizeMoves } from '../model'
// B-TH-275: the state line (confirmed only when confirmed), "Made from your request", the customer's own reference.
import { orderRefOf, stateLineKey } from '../model'
import { useOrderWords, type OrderWords } from '../words'
import { Loading, ReadFailed, SizeRunTable } from './parts'
import type { OrderRecordActions, OrderRecordViewModel } from './OrderRecordView'
// ---- F-PR-12a: the order's production (B-PR-18), drawn with the shared production parts (F-PR-01)
import { HealthPill } from '../../../../lib/production/view/HealthPill'
import { ProductionHoldBanner } from '../../../../lib/production/view/ProductionHoldBanner'
import { WaitingOnPill } from '../../../../lib/production/view/WaitingOnPill'
import type { ProductionOrder } from '../../production/api'
import { healthInputOf, holdsOf, stageNoteOf, waitingInputOf } from '../../production/model'
// ---- end F-PR-12a
// ---- F-PR-12b: + Progress (per line and size, the shared PiecesGrid) and + Gates & dates, by the customer's level
import { FreshnessLine } from '../../../../lib/production/view/FreshnessLine'
import { PiecesGrid } from '../../../../lib/production/view/PiecesGrid'
import type { ProductionGates } from '../../production/api'
import { APPROVAL_STATE_TONE, GATE_STATE_TONE, gatesEmpty, gatesWaitOnYou, piecesOf, productionOwnsProgress } from '../../production/model'
// ---- end F-PR-12b
import { ProductionQualityCard } from './QualityCard' // F-PR-12c: + Quality & photos
// ---- F-PR-24: the problems it reported on this order (chip + Report a problem) and the order's files (the newest three we shared)
import { Download, Eye } from 'lucide-react'
import { FileRow } from '../../../../lib/i18n/ds-parts'
import { recordHref } from '../model'
import { orderFilesOf } from '../../production/problem/model'
import '../../production/problem/problem.css'
// ---- end F-PR-24

/**
 * Order › Status & progress (design rec "Order" tab status): "Please re-confirm" when a revised version waits (SAL-222), where
 * the order is (the six steps with their dates, the promise date big with its history in customer words), the customer's
 * change and cancel requests with our answer, production progress per line and size when the account shares it (C1), the
 * deposit and the order's facts. Money only with the price grain.
 *
 * F-PR-12a (production plan §4, §5; 06-tree B.2 P-ORD-wait, P-ORD-hold, P-ORD-tracker, P-ORD-requests), part 1, on today's tab
 * frame: while the order is in production and the person sees production, "We are waiting for you on this order" (to what waits
 * for it), the hold banner in our curated words (every level; "Ask a question" opens the order's conversation), and where it is —
 * the plain stage as the note of the "In production" step (+ the count from + Progress), the promise and its moves (as before),
 * the health chip with its reason code and who acts next (You / Us). Its requests keep their true states. A section the
 * customer's level does not share, or an order not in production, is not drawn.
 *
 * F-PR-12b, part 2, by level: + Gates & dates — its real gates (PP sample, size set, sample, leather, trims, lab) with their planned
 * and done days, its swatch answers (colour, leather, fabric, trims) as approvals, not gates, and the cut, sewing and finish days of
 * its own work from our PUBLISHED plan only; + Progress — the pieces per line and size of its own cells (the shared PiecesGrid:
 * "Cut and bundled", "—" where a stage is not counted, never 0), read again every `refreshSeconds` and said as such. While the
 * order's production read draws them, today's progress card (C1) is not drawn a second time.
 *
 * F-PR-12c, part 3, at the level Quality & photos only: the quality of its own goods (QualityCard.tsx) — pieces released by quality
 * and taken back per line and size, first-piece / cutting / end-of-line checks and final inspections with their sampling, defects
 * and the factory's report PDF (only of work orders made for it alone), what held its goods, and the photos shared on its order.
 */
export function StatusTab({ model, record, actions }: { model: OrderRecordViewModel; record: OrderRecord; actions?: OrderRecordActions }) {
  const production = model.production?.state === 'ready' ? model.production.read : null // F-PR-12a
  return (
    <div className="fw-pord-tab">
      {record.order.reconfirmNeeded ? <ReconfirmPanel model={model} actions={actions} /> : null}
      {/* F-PR-12a: what waits for the customer (a revised order to re-confirm says it above), then what holds its work. */}
      {production && !record.order.reconfirmNeeded ? <ProductionWaiting read={production} href={model.waitingHref ?? null} /> : null}
      {production ? <ProductionHold read={production} actions={actions} /> : null}
      {/* B-TH-275 */}
      <StateLine model={model} record={record} />
      <Tracker model={model} record={record} actions={actions} />
      {/* F-PR-24: "Problem reported · Waiting on us since 16 Nov" (then "Answered 17 Nov") and Report a problem, while production is drawn. */}
      {production ? <ProductionProblem model={model} actions={actions} /> : null}
      <Requests model={model} actions={actions} />
      {/* F-PR-24: Order files (3) — the newest files we shared on this order and its lines; none: not drawn. */}
      {production ? <OrderFiles model={model} record={record} actions={actions} /> : null}
      {/* F-PR-12b: gates & dates, then the pieces, each only at the level that shares it (null: not drawn). */}
      {production?.gates ? <ProductionGatesCard gates={production.gates} href={model.waitingHref ?? null} /> : null}
      {production?.progress ? <ProductionProgress progress={production.progress} offline={model.offlineSince !== null} /> : null}
      {/* F-PR-12c: + Quality & photos, only at the level that shares it (hidden or absent: not drawn). */}
      {production && model.quality && model.quality.state !== 'hidden' ? (
        <ProductionQualityCard quality={{ state: model.quality.state, read: model.quality.read }} refreshSeconds={production.progress?.refreshSeconds ?? null} offline={model.offlineSince !== null} fileHeld={model.fileHeld} actions={actions} />
      ) : null}
      {!productionOwnsProgress(model.production) && record.progressShared && model.progress.state !== 'hidden' ? <Progress model={model} actions={actions} /> : null}
      {record.deposits.length > 0 && record.seesPrices ? <Deposits model={model} deposits={record.deposits} depositRequired={record.order.depositRequired} actions={actions} /> : null}
      <Facts record={record} />
    </div>
  )
}

// ---- B-TH-275 (P-CUS-ORD.body; L2-G06, B-TH-006): ONE line above the tracker — "Your order is confirmed" only for a confirmed order,
// "We received your order: it waits for our approval" while it waits for the office's yes, nothing for a later state — and, when the
// order came from one, "Made from your request #7" (its page) or "Made from your quote #3" (its conversation page). Both are the
// customer's own numbers (the summary's label), never the office's series.
function StateLine({ model, record }: { model: OrderRecordViewModel; record: OrderRecord }) {
  const { t } = useOrderWords()
  const key = stateLineKey(record.order.status)
  const made = model.madeFrom ?? null
  if (!key && !made) return null
  return (
    <div className="fw-pord-stateline">
      {key ? (
        <p className={key === 'status.confirmed' ? 'fw-pord-state is-confirmed' : 'fw-pord-state'} role="status">
          {key === 'status.confirmed' ? <CheckCircle2 size={16} aria-hidden /> : <Clock size={16} aria-hidden />} <span>{t(key)}</span>
        </p>
      ) : null}
      {made ? (
        <a className="fw-pord-made" href={made.href}>
          {t(made.kind === 'request' ? (made.label ? 'status.madeFromRequest' : 'status.madeFromRequestNone') : made.label ? 'status.madeFromQuote' : 'status.madeFromQuoteNone', made.label ? { label: made.label } : undefined)}
          <ArrowUpRight size={14} aria-hidden />
        </a>
      ) : null}
    </div>
  )
}
// ---- end B-TH-275

/** The revised order's changes line by line, old → new (ChangeReview without ticks: they all go together). */
export function RevisionReview({ page, words }: { page: ApprovalPage; words: OrderWords }) {
  const { t } = words
  const order = page.content.revisedOrder
  if (!order) return null
  const items = order.lines.map((line) => {
    const prices = order.prices?.find((row) => row.lineId === line.lineId) ?? null
    const values: KeyValueItem[] = [
      { label: t('revision.pieces'), value: t('revision.oldNew', { old: line.piecesBefore, new: line.piecesAfter }) },
      ...(sizeMoves(line).length > 0 ? [{ label: t('revision.sizes'), value: sizeMoves(line).map((size) => t('revision.size', { size: size.size, old: size.before, new: size.after })).join(' · ') }] : []),
      ...(prices ? [{ label: t('revision.amount'), value: t('revision.oldNew', { old: words.money(prices.netBefore, order.currency), new: words.money(prices.netAfter, order.currency) }) }] : []),
    ]
    return {
      id: line.lineId,
      label: t('revision.line', { seq: line.seq, style: line.style.code, colour: line.colour.name }),
      status: t(`revision.change.${line.change}`),
      note: line.style.name,
      selectable: false,
      values,
    }
  })
  const header = order.header.map((change) => ({
    id: `h-${change.field}`,
    label: t(`revision.field.${change.field}`),
    status: t('revision.change.CHANGED'),
    note: '',
    selectable: false,
    values: [{ label: t('revision.was'), value: change.before ? (change.field === 'requestedDate' ? words.day(change.before) : change.before) : '—' }, { label: t('revision.now'), value: change.after ? (change.field === 'requestedDate' ? words.day(change.after) : change.after) : '—' }],
  }))
  return (
    <div className="fw-pord-stack">
      <ChangeReview label={t('revision.label', { version: order.revision })} items={[...header, ...items]} selectedIds={[]} onSelectionChange={() => undefined} tick={false} />
      {order.netAmountBefore !== undefined && order.netAmountAfter !== undefined ? (
        <p className="fw-pord-total-move">{t('revision.net', { old: words.money(order.netAmountBefore, order.currency), new: words.money(order.netAmountAfter, order.currency) })}</p>
      ) : null}
      {netMoved(order) ? <p className="fw-pord-hint">{t('revision.voids')}</p> : null}
    </div>
  )
}

function ReconfirmPanel({ model, actions }: { model: OrderRecordViewModel; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, day } = words
  const revision = model.revision
  if (revision.state === 'loading') return <Loading rows={1} height={88} />
  if (revision.state === 'error') return <ReadFailed title={t('reconfirm.failed')} onRetry={actions?.onRetryRevision} />
  if (revision.state === 'noAccess') return <Banner tone="warning" title={t('reconfirm.bannerNoAccess')}>{t('reconfirm.askColleague')}</Banner>
  const page = revision.page
  if (!page || !page.content.revisedOrder) return <Banner tone="info" title={t('reconfirm.bannerSoon')} />
  const order = page.content.revisedOrder
  return (
    <Banner
      tone="warning"
      title={t('reconfirm.banner', { version: order.revision, date: day(page.request.dueAt) })}
      action={
        <Button variant="primary" size="sm" heldReason={model.reconfirmHeld} onClick={() => actions?.onReconfirm?.()}>
          {t('reconfirm.review')}
        </Button>
      }
    >
      <div className="fw-pord-stack">
        {netMoved(order) ? <p className="fw-pord-hint">{t('revision.voids')}</p> : null}
        <Disclosure summary={t('reconfirm.whatChanged', { count: order.lines.length + order.header.length })}>
          <RevisionReview page={page} words={words} />
        </Disclosure>
      </div>
    </Banner>
  )
}

function Tracker({ model, record, actions }: { model: OrderRecordViewModel; record: OrderRecord; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, locale, day } = words
  const ds = useDsWords()
  const order = record.order
  const promise = promiseOf(order)
  const moves = movesOf(record.promiseHistory)
  const history = promiseMoves(record.promiseHistory, locale, day).reverse()
  // F-PR-12a: the plain stage is the note of the "In production" step (06-tree §0.2), only true states.
  const production = model.production
  const read = production?.state === 'ready' ? production.read : null
  const note = read ? stageNoteOf(read, locale) : null
  const steps = milestoneSteps(record.milestones, locale, day).map((step) => (note && step.id === 'IN_PRODUCTION' ? { ...step, note } : step))
  // The popover opens only once the page runs in the browser (a server render never draws it: no hydration mismatch).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return (
    <Card header={t('tracker.title')} headingLevel={2}>
      <div className="fw-pord-tracker">
        <MilestoneTracker steps={steps /* F-PR-12a */} label={t('tracker.label', { number: orderRefOf(order, t) /* B-TH-275 */ })} labels={ds.milestoneTracker} />
        <div className="fw-pord-promise">
          {order.status === 'CANCELLED' ? (
            <p className="fw-pord-promise-date">{order.cancelledOn ? t('tracker.cancelledOn', { date: day(order.cancelledOn) }) : t('tracker.cancelled')}</p>
          ) : promise.date ? (
            <>
              <span className="fw-pord-promise-label">{t('tracker.promise')}</span>
              <p className="fw-pord-promise-date">{day(promise.date)}</p>
              {promise.first ? <span className="fw-pord-sub">{t('tracker.firstPromised', { date: day(promise.first) })}</span> : null}
            </>
          ) : (
            <p className="fw-pord-hint">{t('tracker.noPromise')}</p>
          )}
          {moves > 0 ? (
            <DetailPopover
              trigger={
                <span className="fw-pord-moved-mark">
                  <History size={14} aria-hidden /> {t('tracker.moved', { count: moves })}
                </span>
              }
              triggerLabel={t('history.open', { count: moves })}
              triggerClassName="fw-pord-moved-trigger"
              label={t('history.title')}
              hoverDelay={0}
              open={mounted && (model.historyOpen ?? false)}
              onOpenChange={(open) => actions?.onHistory?.(open)}
            >
              <div className="fw-pord-history">
                <strong>{t('history.title')}</strong>
                <ol className="fw-pord-history-list">
                  {history.map((move, index) => (
                    <li key={index}>
                      <span>{move.from ? t('history.move', { on: move.on, from: move.from, to: move.to }) : t('history.set', { on: move.on, to: move.to })}</span>
                      {move.reason ? <span className="fw-pord-sub">{move.reason}</span> : null}
                    </li>
                  ))}
                </ol>
              </div>
            </DetailPopover>
          ) : null}
        </div>
      </div>
      {/* F-PR-12a: the health chip with its reason code and who acts next; a failed read says so here, with Try again. */}
      {read ? (
        <ProductionFacts read={read} />
      ) : production?.state === 'error' ? (
        <ReadFailed title={t('production.failed')} onRetry={actions?.onRetryProduction} />
      ) : production?.state === 'loading' ? (
        <Loading rows={1} height={24} />
      ) : null}
    </Card>
  )
}

// ---- F-PR-12a ------------------------------------------------------------------------------------------------------------------
/** "We are waiting for you on this order · Since 12 Nov" with the way to what waits (Waiting for you, until it exists Home). */
function ProductionWaiting({ read, href }: { read: ProductionOrder; href: string | null }) {
  const { t, day } = useOrderWords()
  if (read.waiting.code !== 'YOU') return null
  return (
    <Banner
      tone="warning"
      icon={<Hourglass size={16} aria-hidden />}
      title={t('production.waitingTitle')}
      action={
        href ? (
          <Button asChild size="sm" variant="primary">
            <a href={href}>{t('production.waitingLink')}</a>
          </Button>
        ) : undefined
      }
    >
      {read.waiting.since ? t('production.waitingSince', { date: day(read.waiting.since) }) : null}
    </Banner>
  )
}

/** The most serious hold in our curated words (a quality check, our hold's reason, its own pause); the rest counted. */
function ProductionHold({ read, actions }: { read: ProductionOrder; actions?: OrderRecordActions }) {
  const { t, locale } = useOrderWords()
  if (read.holds.length === 0) return null
  return (
    <ProductionHoldBanner
      face="customer"
      holds={holdsOf(read.holds, locale)}
      action={
        actions?.onAsk ? (
          <Button size="sm" onClick={() => actions.onAsk?.()}>
            {t('production.ask')}
          </Button>
        ) : undefined
      }
    />
  )
}

/** Health (the chip and a person's reason code, never a note) and who acts next (You / Us; never a supplier or a workshop). */
function ProductionFacts({ read }: { read: ProductionOrder }) {
  const { t } = useOrderWords()
  const items: KeyValueItem[] = [
    { label: t('production.health'), value: <HealthPill face="customer" {...healthInputOf(read.health)} /> },
    { label: t('production.waitingOn'), value: <WaitingOnPill face="customer" now={Date.parse(read.asOf)} {...waitingInputOf(read.waiting)} /> },
  ]
  return (
    <section className="fw-pord-production" aria-label={t('production.label')}>
      <KeyValue columns={2} labelCase="sentence" items={items} />
    </section>
  )
}
// ---- end F-PR-12a

// ---- F-PR-12b ------------------------------------------------------------------------------------------------------------------
/**
 * + Gates & dates (06-tree B.2 P-ORD-gates): its real gates with their state in our words ("Waiting on you", "Waiting on us",
 * "Passed", "Started before approval"), the day planned and the day done; its swatch answers as approvals; its own work's days
 * from our published plan. "See what waits for you" while one of them waits on it. Nothing at all: said in one line.
 */
function ProductionGatesCard({ gates, href }: { gates: ProductionGates; href: string | null }) {
  const { t, locale, day } = useOrderWords()
  const dayOr = (value: string | null) => (value ? day(value) : '—')
  const review = href && gatesWaitOnYou(gates) ? href : null
  const planned = gates.planned
  const anyPlanned = Boolean(planned.cutStart || planned.sewStart || planned.finish)
  return (
    <Card
      header={t('production.gates.title')}
      headingLevel={2}
      headerAction={
        review ? (
          <Button asChild size="sm">
            <a href={review}>{t('production.gates.review')}</a>
          </Button>
        ) : null
      }
    >
      {gatesEmpty(gates) ? (
        <p className="fw-pord-hint">{t('production.gates.none')}</p>
      ) : (
        <div className="fw-pord-stack">
          {gates.gates.length > 0 ? (
            <SummaryTable
              label={t('production.gates.label')}
              columns={[t('production.gates.step'), t('production.gates.state'), t('production.gates.planned'), t('production.gates.done')]}
              widths={['34%', '30%', undefined, undefined]}
              stackOnPhone
              rows={gates.gates.map((gate, index) => ({
                id: `${gate.kind}-${index}`,
                cells: [gate.words[locale], <Pill key="state" tone={GATE_STATE_TONE[gate.state]}>{t(`production.gates.states.${gate.state}`)}</Pill>, dayOr(gate.targetDate), dayOr(gate.doneOn)],
              }))}
            />
          ) : null}
          {gates.approvals.length > 0 ? (
            <SummaryTable
              label={t('production.approvals.label')}
              columns={[t('production.approvals.material'), t('production.gates.state'), t('production.approvals.sent'), t('production.approvals.answered')]}
              widths={['34%', '30%', undefined, undefined]}
              stackOnPhone
              rows={gates.approvals.map((answer, index) => ({
                id: `${answer.kind}-${index}`,
                cells: [answer.words[locale], <Pill key="state" tone={APPROVAL_STATE_TONE[answer.state]}>{t(`production.approvals.states.${answer.state}`)}</Pill>, dayOr(answer.sentOn), dayOr(answer.answeredOn)],
              }))}
            />
          ) : null}
          <section className="fw-pord-stack" aria-label={t('production.planned.label')}>
            {anyPlanned ? (
              <>
                <KeyValue
                  columns={3}
                  phoneColumns={1}
                  labelCase="sentence"
                  items={[
                    { label: t('production.planned.cutStart'), value: dayOr(planned.cutStart) },
                    { label: t('production.planned.sewStart'), value: dayOr(planned.sewStart) },
                    { label: t('production.planned.finish'), value: dayOr(planned.finish) },
                  ]}
                />
                <p className="fw-pord-hint">{t('production.planned.hint')}</p>
              </>
            ) : (
              <p className="fw-pord-hint">{t('production.planned.none')}</p>
            )}
          </section>
        </div>
      )}
    </Card>
  )
}

/**
 * + Progress (06-tree B.2 P-ORD-progress): per line, Cut and bundled · Sewn · Checked · Packed as bars from one figure each, the
 * sizes under them (the shared PiecesGrid; "—" where the site does not count a stage). The read comes again every
 * `refreshSeconds` (OrderPage), so the line says "Updated 10:42 · refreshes every minute" — not "live": no scan is pushed (R7).
 */
function ProductionProgress({ progress, offline }: { progress: NonNullable<ProductionOrder['progress']>; offline: boolean }) {
  const { t } = useOrderWords()
  return (
    <Card header={t('progress.title')} headingLevel={2} headerAction={<FreshnessLine mode={offline ? 'offline' : 'polling'} asOf={progress.asOf} everySeconds={progress.refreshSeconds} />}>
      <PiecesGrid colourways={piecesOf(progress, t)} />
    </Card>
  )
}
// ---- end F-PR-12b

// ---- F-PR-24 ------------------------------------------------------------------------------------------------------------------
/** The problems it reported on this order in one line (never who answers: whoever does signs in the thread) and Report a problem. */
function ProductionProblem({ model, actions }: { model: OrderRecordViewModel; actions?: OrderRecordActions }) {
  const { t } = useOrderWords()
  const problem = model.problem
  if (!problem || (!problem.chip && !problem.report)) return null
  return (
    <section className="fw-pprob-row" aria-label={t('reported.label')}>
      {problem.chip ? <Pill tone={problem.chip.tone}>{problem.chip.text}</Pill> : null}
      {problem.report ? (
        <Button size="sm" className="fw-pord-push" heldReason={problem.report.held} onClick={() => actions?.onReportProblem?.()}>
          {t('reported.report')}
        </Button>
      ) : null}
    </section>
  )
}

/**
 * "Order files (3)": the newest three files we shared on this order and its lines (its documents read: confirmations only for a
 * role that sees prices — the API's own rule), each opened in place (a PDF) or downloaded, both logged; "All in Documents (7)"
 * opens the Documents tab (one home for files). Reading: its place; could not be read: said with Try again; none: not drawn.
 */
function OrderFiles({ model, record, actions }: { model: OrderRecordViewModel; record: OrderRecord; actions?: OrderRecordActions }) {
  const { t, locale, day } = useOrderWords()
  const documents = model.documents
  if (documents.state === 'noAccess') return null
  if (documents.state === 'loading') {
    return (
      <Card header={t('orderFiles.label')} headingLevel={2}>
        <Loading rows={2} height={44} />
      </Card>
    )
  }
  if (documents.state === 'error' || !documents.read) {
    return (
      <Card header={t('orderFiles.label')} headingLevel={2}>
        <ReadFailed title={t('orderFiles.failed')} onRetry={actions?.onRetryDocuments} />
      </Card>
    )
  }
  const files = orderFilesOf(documents.read.items)
  if (files.count === 0) return null
  return (
    <Card
      header={t('orderFiles.title', { count: files.count })}
      headingLevel={2}
      headerAction={
        <Button asChild size="sm" variant="quiet">
          <a href={recordHref(model.prefix, record.order.id, 'documents')}>{t('orderFiles.all', { count: files.count })}</a>
        </Button>
      }
    >
      <div className="fw-pord-stack" role="list" aria-label={t('orderFiles.label')}>
        {files.shown.map((doc) => {
          const title = doc.title[locale]
          const pdf = doc.files.find((file) => file.format === 'PDF') ?? null
          const first = doc.files[0] ?? null
          return (
            <div role="listitem" key={doc.id}>
              <FileRow
                name={title}
                status={<span className="fw-pord-docline">{[doc.kindWords[locale], day(doc.date.slice(0, 10))].join(' · ')}</span>}
                actions={
                  <>
                    {pdf ? (
                      <Button size="sm" variant="quiet" heldReason={model.fileHeld} aria-label={t('orderFiles.openOf', { name: title })} onClick={() => actions?.onPreview?.({ fileId: pdf.fileId, title })}>
                        <Eye size={13} aria-hidden /> {t('orderFiles.open')}
                      </Button>
                    ) : null}
                    {first ? (
                      <Button size="sm" variant="quiet" heldReason={model.fileHeld} aria-label={t('orderFiles.downloadOf', { name: title })} onClick={() => actions?.onDownload?.({ fileId: (pdf ?? first).fileId, name: (pdf ?? first).name })}>
                        <Download size={13} aria-hidden /> {t('orderFiles.download')}
                      </Button>
                    ) : null}
                  </>
                }
              />
            </div>
          )
        })}
      </div>
    </Card>
  )
}
// ---- end F-PR-24

function Requests({ model, actions }: { model: OrderRecordViewModel; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, locale, day, at } = words
  const requests = model.requests
  if (requests.state === 'noAccess' || (requests.state === 'ready' && requests.items.length === 0)) return null
  return (
    <Card header={t('requests.title')} headingLevel={2}>
      {requests.state === 'loading' ? (
        <Loading rows={1} height={48} />
      ) : requests.state === 'error' ? (
        <ReadFailed title={t('requests.failed')} onRetry={actions?.onRetryRequests} />
      ) : (
        <ul className="fw-pord-requests">
          {requests.items.map((request) => (
            <li key={request.id} className="fw-pord-request" id={`change-request:${request.id}`}>
              <div className="fw-pord-request-head">
                <strong>{request.kindWords[locale]}</strong>
                <Pill tone={requestTone(request.status)}>{request.words[locale]}</Pill>
                <span className="fw-pord-sub">{t(request.mine ? 'requests.askedByYou' : 'requests.asked', { when: at(request.askedAt) })}</span>
                {/* B-PR-23: the customer withdraws a change or a cancel here; a production ask is withdrawn where it was asked. */}
                {request.status === 'OPEN' && (request.kind === 'CHANGE' || request.kind === 'CANCEL') ? (
                  <Button size="sm" variant="quiet" className="fw-pord-push" heldReason={model.withdrawHeld} onClick={() => actions?.onWithdraw?.(request)}>
                    {t('requests.withdraw')}
                  </Button>
                ) : null}
              </div>
              <RequestWhat request={request} words={words} />
              {request.answer ? <p className="fw-pord-answer">{t('requests.ourAnswer', { answer: request.answer })}</p> : null}
              {request.status === 'ACCEPTED' && request.answeredAt ? <span className="fw-pord-sub">{t('requests.acceptedOn', { date: day(request.answeredAt.slice(0, 10)) })}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function RequestWhat({ request, words }: { request: ChangeRequest; words: OrderWords }) {
  const { t, locale, day } = words
  const parts: string[] = []
  if (request.kind === 'CANCEL') {
    parts.push(request.wholeOrder ? t('requests.wholeOrder') : t('requests.lines', { lines: [...new Set(request.cells.map((cell) => cell.seq))].join(', ') }))
    if (request.reasonWords) parts.push(request.reasonWords[locale])
    if (request.cancelFee?.pct && request.cancelFee.totalFee != null) parts.push(t('requests.fee', { fee: words.money(request.cancelFee.totalFee, request.cancelFee.currency) }))
  } else {
    for (const cell of request.cells) parts.push(t('requests.cell', { seq: cell.seq, size: cell.size ?? '—', old: cell.before, new: cell.asked }))
    if (request.requestedDate) parts.push(t('requests.date', { date: day(request.requestedDate) }))
    if (request.shipTo) parts.push(t('requests.shipTo', { address: request.shipTo.label }))
  }
  return (
    <div className="fw-pord-stack">
      <span>{parts.join(' · ')}</span>
      {request.note ? <span className="fw-pord-sub">{t('requests.note', { note: request.note })}</span> : null}
    </div>
  )
}

function Progress({ model, actions }: { model: OrderRecordViewModel; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, time } = words
  const progress = model.progress
  return (
    <Card header={t('progress.title')} headingLevel={2} headerAction={progress.read ? <span className="fw-pord-sub">{t('band.updated', { time: time(progress.read.asOf) })}</span> : null}>
      {progress.state === 'loading' ? (
        <Loading rows={2} height={40} />
      ) : progress.state === 'error' || !progress.read ? (
        <ReadFailed title={t('progress.failed')} onRetry={actions?.onRetryProgress} />
      ) : (
        <div className="fw-pord-stack">
          {progress.read.lines.map((line) => (
            <ProgressLine key={line.lineId} line={line} stages={progress.read!.stages} words={words} />
          ))}
          <p className="fw-pord-hint">{t('progress.refresh', { seconds: progress.read.refreshSeconds })}</p>
        </div>
      )}
    </Card>
  )
}

type ProgressLineRead = ProgressRead['lines'][number]

function ProgressLine({ line, stages, words }: { line: ProgressLineRead; stages: ProgressRead['stages']; words: OrderWords }) {
  const { t, locale } = words
  const figure = (stage: ProgressRead['stages'][number]['key'], of: Pick<ProgressLineRead, 'cut' | 'sewn' | 'inspected' | 'packed'>) => (stage === 'CUT' ? of.cut : stage === 'SEWN' ? of.sewn : stage === 'INSPECTED' ? of.inspected : of.packed)
  const title = t('progress.line', { seq: line.seq, style: line.style?.code ?? '—', colour: line.colourway?.name ?? '' })
  return (
    <div className="fw-pord-progress-line">
      <strong>{title}</strong>
      <div className="fw-pord-bars">
        {stages.map((stage) => {
          const value = figure(stage.key, line)
          return (
            <div key={stage.key} className="fw-pord-bar">
              <span>{value === null ? t('progress.notScanned', { stage: stage.words[locale] }) : t('progress.of', { stage: stage.words[locale], count: value, ordered: line.ordered })}</span>
              <ProgressBar value={value === null || line.ordered === 0 ? null : (value / line.ordered) * 100} ariaLabel={`${title}: ${stage.words[locale]}`} />
            </div>
          )
        })}
      </div>
      <Disclosure summary={t('progress.sizes')}>
        <SizeRunTable
          label={t('progress.sizesOf', { title })}
          run={{
            heads: [t('sizes.ordered'), ...stages.map((stage) => stage.words[locale])],
            rows: line.sizes.map((size) => ({ size: size.size ?? '—', cells: [size.ordered, ...stages.map((stage) => (figure(stage.key, size) === null ? '—' : String(figure(stage.key, size))))] })),
          }}
        />
      </Disclosure>
    </div>
  )
}

function Deposits({ model, deposits, depositRequired, actions }: { model: OrderRecordViewModel; deposits: readonly DepositRead[]; depositRequired: boolean; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, day } = words
  const open = openDeposits(deposits)
  return (
    <Card header={t('deposit.title')} headingLevel={2}>
      <div className="fw-pord-stack">
        {depositRequired && open.length > 0 ? <p className="fw-pord-strong">{t('deposit.gate')}</p> : null}
        {deposits.map((deposit) => {
          const pay = model.pay[deposit.id]
          return (
            <div key={deposit.id} className="fw-pord-deposit">
              <KeyValue
                columns={3}
                phoneColumns={2}
                labelCase="sentence"
                items={[
                  { label: t(`deposit.kind.${deposit.kind}`), value: words.money(deposit.amount, deposit.currency) },
                  { label: t('deposit.due'), value: day(deposit.dueDate) },
                  { label: t('deposit.status'), value: deposit.paidAt ? t('deposit.paidOn', { date: day(deposit.paidAt.slice(0, 10)) }) : t(`deposit.state.${deposit.status}`) },
                ]}
              />
              {pay ? (
                <Button variant="primary" size="sm" heldReason={pay.held} onClick={() => actions?.onPay?.(deposit.id)}>
                  {t('deposit.payCard')}
                </Button>
              ) : null}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function Facts({ record }: { record: OrderRecord }) {
  const words = useOrderWords()
  const { t, day } = words
  const order = record.order
  const shipTo = shipToLines(order.shipTo)
  const items: KeyValueItem[] = [
    { label: t('facts.orderedOn'), value: day(order.orderDate) },
    { label: t('facts.requested'), value: order.requestedDate ? day(order.requestedDate) : '—' },
    { label: t('facts.promise'), value: order.promiseDate ? day(order.promiseDate) : '—' },
    {
      label: t('facts.shipTo'),
      value: shipTo.length > 0 ? (
        <span className="fw-pord-address">
          {shipTo.map((line, index) => (
            <span key={index}>{line}</span>
          ))}
        </span>
      ) : (
        '—'
      ),
    },
    { label: t('facts.paymentTerms'), value: order.paymentTerms ?? '—' },
    ...(order.noWithdrawal ? [{ label: t('facts.withdrawal'), value: t('facts.noWithdrawal') }] : []),
  ]
  return (
    <Card header={t('facts.title')} headingLevel={2}>
      <KeyValue columns={3} labelCase="sentence" items={items} />
    </Card>
  )
}
