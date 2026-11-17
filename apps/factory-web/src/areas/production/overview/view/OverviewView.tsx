'use client'

import { useId, type ReactNode } from 'react'
import Link from 'next/link'
import { MoreHorizontal, PauseCircle } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag, Toggle } from '@nexus/ui/primitives'
import { formatDate, formatNumber, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { HealthPill } from '../../../../lib/production/view/HealthPill'
import { WaitingOnPill } from '../../../../lib/production/view/WaitingOnPill'
import { WithMessages } from '../../../../record-panels/i18n'
import type { CustomerFilterState } from '../../_shared/customer/model'
import { CustomerFilter } from '../../_shared/customer/view/CustomerFilter'
import type { LiveState } from '../../_shared/hooks'
import type { ProductionCan } from '../../_shared/model'
import { NOTES_NS, type NoteDialogActions, type NoteDialogModel } from '../../_shared/notes/model'
import { NoteDialog } from '../../_shared/notes/view/NoteDialog'
import { SUPERVISOR_NS } from '../../../_shared/production-supervisor/model'
import { WIP_STAGES, type Issues, type Overview } from '../api'
import {
  customerCodesOf,
  EXCEPTION_COLUMNS,
  exceptionRows,
  issueLineOf,
  issuesSummary,
  nothingOpen,
  tilesOf,
  urgentFooter,
  urgentLineOf,
  wipRows,
  type Door,
  type OverviewTerms,
  type RowLabel,
  type StageCell,
  type UrgentLine,
} from '../model'
import '../../_shared/production.css'
import '../overview.css'

/** F-PR-04 — Production › Overview's view model (OverviewView draws it and fetches nothing). */
export interface OverviewModel {
  prefix: string
  can: ProductionCan
  terms: OverviewTerms
  /** parties.view: a customer is named (and opens its record); else its code. */
  names: boolean
  overview: { value: Overview | null; problem: string | null }
  issues: { value: Issues | null; problem: string | null }
  asOf: string | null
  /** The read's clock (ms): the waiting ages count from it. */
  now: number
  live: LiveState
  /** The Production pages' one customer filter (`?party=`). */
  customers?: CustomerFilterState
  /** threads.post: Most urgent's row ⋯ "Ask the supervisor" (held in words without it). */
  noteCan: boolean
  /** The work order whose note dialog is being opened (its record read). */
  asking: string | null
  /** A refusal in words (a production catalogue key), e.g. the work order could not be read. */
  notice: string | null
  /** THE note dialog (F-PR-22) while open. */
  note: NoteDialogModel | null
}

export interface OverviewActions {
  onRetry?: () => void
  onRetryIssues?: () => void
  /** A customer picked (null: every customer). */
  onCustomer?: (party: string | null) => void
  /** Only mine on or off. */
  onMine?: (mine: boolean) => void
  onMoreIssues?: () => void
  /** Most urgent's row ⋯ Ask the supervisor. */
  onAsk?: (workOrderId: string) => void
  onDismissNotice?: () => void
  note?: NoteDialogActions
}

/**
 * F-PR-04 — Production › Overview (production plan §5; 06-tree A.1; design 09 §2(a)): the six tiles (waiting on us, waiting on the
 * customer, late, at risk, blocked, customer requests), Exceptions by customer with the mixed work orders made before the rule and the
 * Total, WIP by stage × customer (held work in its own On hold column), Most urgent "10 of N · Show all" (row ⋯ Ask the supervisor), and
 * the open issues. Every number opens Work orders with its filters (Customer requests opens Home › Approvals); Only mine and the customer
 * filter go with every door. Every figure is the API's: a person limited to some customers sees only theirs, and the Total is theirs.
 */
export function OverviewView({ model, actions }: { model: OverviewModel; actions?: OverviewActions }) {
  return (
    <WithMessages namespaces={['production', NOTES_NS, SUPERVISOR_NS]}>
      <OverviewScreen model={model} actions={actions} />
    </WithMessages>
  )
}

function OverviewScreen({ model, actions }: { model: OverviewModel; actions?: OverviewActions }) {
  const t = useT('production')
  const locale = useLocale()
  const mineId = useId()
  const answer = model.overview.value
  const tiles = tilesOf(answer, model.prefix, model.terms)
  const limited = answer ? !answer.everyCustomer : model.customers?.everyCustomer === false

  return (
    <div className="fw-pr">
      <div className="fw-pr-head">
        <span className="fw-pr-head-text">
          <span className="fw-pr-status" role="status">
            {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
            {' · '}
            {t(`live.${model.live}`)}
          </span>
          <span className="fw-pr-hint">{limited ? t('ovw.scopeMine') : t('ovw.hint')}</span>
        </span>
        <span className="fw-pr-actions">
          {model.customers && <CustomerFilter state={model.customers} onPick={actions?.onCustomer} />}
          <span className="fw-pov-switch">
            <Toggle size="sm" checked={model.terms.mine} onChange={(next) => actions?.onMine?.(next)} aria-labelledby={mineId} aria-describedby={`${mineId}-hint`} />
            <span id={mineId}>{t('ovw.mine.label')}</span>
            <span id={`${mineId}-hint`} className="fw-pr-hint">
              {t('ovw.mine.hint')}
            </span>
          </span>
        </span>
      </div>

      {model.notice && (
        <Banner
          tone="danger"
          title={t('ovw.urgent.askFailed', { reason: t(model.notice) })}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      <MetricStrip
        metrics={tiles.map((tile) => ({
          label: t(`ovw.tile.${tile.id}`),
          value: tile.value === null ? '—' : formatNumber(tile.value, locale),
          href: tile.href,
          ...(tile.id === 'customerRequests' ? { hint: t('ovw.tile.requestsHint') } : {}),
        }))}
      />

      {model.overview.problem ? (
        <Card padded className="fw-pr-card">
          <EmptyState title={t('ovw.failed')} description={t(model.overview.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
        </Card>
      ) : !answer ? (
        <Card padded className="fw-pr-card">
          <p className="fw-pr-hint" role="status">
            <Spinner size={12} /> {t('common.loading')}
          </p>
        </Card>
      ) : nothingOpen(answer) ? (
        <Card padded className="fw-pr-card">
          <EmptyState
            title={t(model.terms.mine ? 'ovw.empty.mineTitle' : 'ovw.empty.title')}
            description={t(model.terms.mine ? 'ovw.empty.mineBody' : 'ovw.empty.body')}
            action={
              model.can.manage && !model.terms.mine ? (
                <Button size="sm" asChild>
                  <Link href={`${model.prefix}/production/work-orders?new=1`}>{t('list.new')}</Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <ExceptionsCard model={model} answer={answer} />
          <div className="fw-pov-pair">
            <WipCard model={model} answer={answer} />
            <UrgentCard model={model} answer={answer} actions={actions} />
          </div>
        </>
      )}

      <IssuesCard model={model} actions={actions} />

      {model.note && <NoteDialog model={model.note} actions={actions?.note} />}
    </div>
  )
}

/** A row's name in a table: the customer (a link to its record with parties.view), the mixed or no-customer words, or Total. */
function RowName({ label, prefix, names }: { label: RowLabel; prefix: string; names: boolean }) {
  const t = useT('production')
  if (label.kind === 'customer')
    return names ? (
      <Link className="fw-pr-link" href={`${prefix}/sales/customers/${encodeURIComponent(label.partyId)}`}>
        {label.text}
      </Link>
    ) : (
      <span>{label.text}</span>
    )
  if (label.kind === 'mixed') return <span>{t('customer.mixed')}</span>
  if (label.kind === 'none') return <span>{t('list.noCustomer')}</span>
  return <strong>{t('ovw.total')}</strong>
}

/** The words a row is called by (a door's spoken name). */
function useRowWords(): (label: RowLabel) => string {
  const t = useT('production')
  return (label) => (label.kind === 'customer' ? label.text : label.kind === 'mixed' ? t('customer.mixed') : label.kind === 'none' ? t('list.noCustomer') : t('ovw.total'))
}

/** A figure that opens its list (above 0), or said plainly (0). */
function DoorCell({ door, what, who, approvals = false, strong = false }: { door: Door; what: string; who: string; approvals?: boolean; strong?: boolean }) {
  const t = useT('production')
  const locale = useLocale()
  const value = formatNumber(door.value, locale)
  const shown = strong ? <strong>{value}</strong> : value
  if (!door.href) return <span className="fw-pov-zero">{shown}</span>
  return (
    <Link className="fw-pr-link" href={door.href} aria-label={t(approvals ? 'ovw.doorApprovals' : 'ovw.door', { what, who, count: value })}>
      {shown}
    </Link>
  )
}

function ExceptionsCard({ model, answer }: { model: OverviewModel; answer: Overview }) {
  const t = useT('production')
  const locale = useLocale()
  const who = useRowWords()
  const rows = exceptionRows(answer, model.prefix, model.terms, model.names)
  const columns = [t('ovw.col.customer'), ...EXCEPTION_COLUMNS.map((column) => t(`ovw.col.${column}`))]
  return (
    <Card header={t('ovw.exceptions.title')} description={t('ovw.exceptions.hint')} headingLevel={2} className="fw-pov-card">
      <div className="fw-pov-wide">
        <SummaryTable
          label={t('ovw.exceptions.title')}
          stackOnPhone
          columns={columns}
          widths={['16%']}
          align={['left', ...EXCEPTION_COLUMNS.map(() => 'right' as const)]}
          rows={rows.map((row) => ({
            id: row.id,
            cells: [
              <RowName key="name" label={row.label} prefix={model.prefix} names={model.names} />,
              ...EXCEPTION_COLUMNS.map((column) => {
                const door = row.cells[column]
                const what = t(`ovw.col.${column}`)
                if (column === 'inProduction')
                  return (
                    <span key={column} className="fw-pr-cell">
                      <DoorCell door={door} what={what} who={who(row.label)} strong={row.total} />
                      <span className="nds-summary-sub">{t('ovw.pieces', { count: row.pieces, pieces: formatNumber(row.pieces, locale) })}</span>
                    </span>
                  )
                if (column === 'requests')
                  return (
                    <span key={column} className="fw-pr-cell">
                      <DoorCell door={door} what={what} who={who(row.label)} approvals strong={row.total} />
                      {row.requestsWaiting !== door.value ? <span className="nds-summary-sub">{t('ovw.requestsWaiting', { count: row.requestsWaiting })}</span> : null}
                    </span>
                  )
                return <DoorCell key={column} door={door} what={what} who={who(row.label)} strong={row.total} />
              }),
            ],
          }))}
        />
      </div>
    </Card>
  )
}

function StageFigure({ cell, what, who }: { cell: StageCell; what: string; who: string }) {
  const t = useT('production')
  if (!cell.counted)
    return (
      <span className="fw-pov-zero">
        <span aria-hidden>—</span>
        <span className="nds-vh">{t('ovw.wip.notCounted')}</span>
      </span>
    )
  return <DoorCell door={cell} what={what} who={who} />
}

function WipCard({ model, answer }: { model: OverviewModel; answer: Overview }) {
  const t = useT('production')
  const who = useRowWords()
  const rows = wipRows(answer, model.prefix, model.terms, model.names)
  const total = rows.find((row) => row.total)
  return (
    <Card header={t('ovw.wip.title')} description={t('ovw.wip.hint')} headingLevel={2} className="fw-pov-card">
      <div className="fw-pov-wide">
        <SummaryTable
          label={t('ovw.wip.title')}
          stackOnPhone
          columns={[t('ovw.col.customer'), t('ovw.wip.pieces'), ...WIP_STAGES.map((stage) => t(`ovw.wip.stage.${stage}`))]}
          widths={['18%']}
          align={['left', 'right', ...WIP_STAGES.map(() => 'right' as const)]}
          rows={rows.map((row) => ({
            id: row.id,
            cells: [
              <RowName key="name" label={row.label} prefix={model.prefix} names={model.names} />,
              <DoorCell key="pieces" door={row.pieces} what={t('ovw.wip.pieces')} who={who(row.label)} strong={row.total} />,
              ...WIP_STAGES.map((stage) => <StageFigure key={stage} cell={row.stages[stage]} what={t(`ovw.wip.stage.${stage}`)} who={who(row.label)} />),
            ],
          }))}
        />
      </div>
      {total && total.sewingNotCounted > 0 ? <p className="fw-pr-hint">{t('ovw.wip.sewingNotCounted', { count: total.sewingNotCounted })}</p> : null}
    </Card>
  )
}

function UrgentCard({ model, answer, actions }: { model: OverviewModel; answer: Overview; actions?: OverviewActions }) {
  const t = useT('production')
  const footer = urgentFooter(answer, model.prefix, model.terms)
  const lines = answer.mostUrgent.items.map((item) => urgentLineOf(item, model.prefix, model.names))
  return (
    <Card header={t('ovw.urgent.title')} description={t('ovw.urgent.hint')} headingLevel={2} className="fw-pov-card">
      {lines.length === 0 ? (
        <p className="fw-pr-hint">{t('ovw.urgent.none')}</p>
      ) : (
        <SummaryTable
          label={t('ovw.urgent.title')}
          stackOnPhone
          density="roomy"
          columns={[t('col.number'), t('ovw.col.customer'), t('col.style'), t('col.due'), t('col.health'), t('col.waitingOn'), t('col.blockedBy'), t('ovw.urgent.supervisor'), t('col.more')]}
          widths={['12%', '14%', '16%', '12%', undefined, undefined, undefined, undefined, '6%']}
          rows={lines.map((line) => ({ id: line.id, cells: urgentCells(line, model, actions) }))}
        />
      )}
      <p className="fw-pov-foot">
        <span className="fw-pr-hint">{t('ovw.urgent.shownOf', { shown: footer.shown, count: footer.count })}</span>
        {footer.count > 0 ? (
          <Link className="fw-pr-link" href={footer.href}>
            {t('ovw.urgent.showAll')}
          </Link>
        ) : null}
      </p>
    </Card>
  )
}

function urgentCells(line: UrgentLine, model: OverviewModel, actions: OverviewActions | undefined): ReactNode[] {
  return [
    <Link key="n" className="fw-pr-link" href={line.href}>
      {line.number}
    </Link>,
    <RowName key="c" label={line.customer} prefix={model.prefix} names={model.names} />,
    <span key="s" className="fw-pr-ellipsis">
      {line.style}
    </span>,
    <DueCell key="d" dueDate={line.dueDate} daysLate={line.daysLate} />,
    <HealthCellOf key="h" line={line} />,
    <WaitingOnPill key="w" face="office" who={line.waiting.who} since={line.waiting.since} now={model.now} />,
    <BlockedCell key="b" blockedKey={line.blockedKey} />,
    <SupervisorMark key="m" mark={line.supervisorKey} />,
    <AskMenu key="a" line={line} model={model} actions={actions} />,
  ]
}

function DueCell({ dueDate, daysLate }: { dueDate: string | null; daysLate: number | null }) {
  const t = useT('production')
  const locale = useLocale()
  return (
    <span className="fw-pr-inline">
      {dueDate ? formatDate(`${dueDate}T12:00:00Z`, { locale }) : '—'}
      {daysLate ? <Tag tone="danger">{t('list.daysLate', { count: daysLate })}</Tag> : null}
    </span>
  )
}

function HealthCellOf({ line }: { line: UrgentLine }) {
  const t = useT('production')
  const cell = line.health
  if (cell.kind === 'none') return <span>—</span>
  if (cell.kind === 'unknown') return <HealthPill face="office" computed={undefined} explain={false} />
  if (cell.kind === 'blocked')
    return (
      <Pill tone="warning" icon={<PauseCircle size={12} aria-hidden />}>
        {t('risk.BLOCKED')}
      </Pill>
    )
  return <HealthPill face="office" {...cell.input} explain={false} />
}

function BlockedCell({ blockedKey }: { blockedKey: string | null }) {
  const t = useT('production')
  return blockedKey ? <Tag tone="warning">{t(blockedKey)}</Tag> : <span>—</span>
}

/** The supervisor for the reader: Me / Someone else / Not set — never a name on a list; no customer: "—". */
function SupervisorMark({ mark }: { mark: string | null }) {
  const ts = useT(SUPERVISOR_NS)
  return <span>{mark ? ts(mark) : '—'}</span>
}

/** Most urgent's row ⋯: Ask the supervisor (THE note dialog, F-PR-22), held in words without threads.post or while one opens. */
function AskMenu({ line, model, actions }: { line: UrgentLine; model: OverviewModel; actions: OverviewActions | undefined }) {
  const t = useT('production')
  const tn = useT(NOTES_NS)
  const held = !model.noteCan ? tn('held.noRight') : model.asking ? t('common.loading') : null
  return (
    <Menu
      label={<MoreHorizontal size={16} aria-hidden />}
      align="right"
      triggerProps={{ 'aria-label': t('ovw.urgent.more', { number: line.number }) }}
      items={[
        {
          id: 'ask',
          label: tn('open.ask'),
          ...(held ? { disabled: true, description: held } : { description: tn('open.askHint'), onSelect: () => actions?.onAsk?.(line.id) }),
        },
      ]}
    />
  )
}

function IssuesCard({ model, actions }: { model: OverviewModel; actions?: OverviewActions }) {
  const t = useT('production')
  const ts = useT(SUPERVISOR_NS)
  const locale = useLocale()
  const issues = model.issues.value
  const codes = customerCodesOf(model.overview.value)
  const today = model.overview.value?.today ?? null
  const day = (value: string) => formatDate(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value, { locale })
  const summary = issues ? issuesSummary(issues, model.terms.mine) : null
  return (
    <Card
      header={t('ovw.issues.title')}
      description={issues ? t('ovw.issues.figures', { open: issues.counts.open, noReply: issues.counts.noReplyYet, escalated: issues.counts.escalated, mine: issues.counts.mine }) : t('ovw.issues.hint')}
      headingLevel={2}
      className="fw-pov-card"
    >
      {model.issues.problem ? (
        <p className="fw-pov-foot">
          <span className="fw-pr-hint">{t(model.issues.problem)}</span>
          <Button size="sm" onClick={() => actions?.onRetryIssues?.()}>
            {t('common.retry')}
          </Button>
        </p>
      ) : !issues ? (
        <p className="fw-pr-hint" role="status">
          <Spinner size={12} /> {t('common.loading')}
        </p>
      ) : issues.issues.length === 0 ? (
        <p className="fw-pr-hint">{t(model.terms.mine ? 'ovw.issues.noneMine' : 'ovw.issues.none')}</p>
      ) : (
        <SummaryTable
          label={t('ovw.issues.title')}
          stackOnPhone
          columns={[t('ovw.issues.col.record'), t('ovw.col.customer'), t('ovw.issues.col.source'), t('ovw.issues.col.raised'), t('ovw.issues.col.due'), t('ovw.issues.col.state'), t('ovw.issues.col.task')]}
          widths={['14%', '18%', '10%', '12%', '12%', undefined, '12%']}
          rows={issues.issues.map((issue) => {
            const line = issueLineOf(issue, model.prefix, model.names, codes, today)
            return {
              id: line.id,
              cells: [
                <Link key="r" className="fw-pr-link" href={line.record.href}>
                  {line.record.label}
                </Link>,
                <span key="c">{line.customer ?? '—'}</span>,
                <span key="s">{t(`ovw.issues.source.${line.source}`)}</span>,
                <span key="at">{day(line.raisedAt)}</span>,
                <span key="due" className="fw-pr-inline">
                  {day(line.dueOn)}
                  {line.overdue ? <Tag tone="danger">{t('ovw.issues.overdue')}</Tag> : null}
                </span>,
                <Tag key="st" tone={line.stateTone}>
                  {t(line.state.key, line.state.params)}
                </Tag>,
                <span key="tk">{line.taskKey ? ts(line.taskKey) : '—'}</span>,
              ],
            }
          })}
        />
      )}
      {summary && summary.shown > 0 ? (
        <p className="fw-pov-foot">
          <span className="fw-pr-hint">{t('ovw.issues.shownOf', { shown: summary.shown, count: summary.count })}</span>
          {summary.more ? (
            <Button size="sm" onClick={() => actions?.onMoreIssues?.()}>
              {t('ovw.issues.showMore')}
            </Button>
          ) : null}
        </p>
      ) : null}
    </Card>
  )
}
