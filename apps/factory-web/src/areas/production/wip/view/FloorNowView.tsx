'use client'

import Link from 'next/link'
import { Tv } from 'lucide-react'
import { Card, EmptyState, Menu, MetricStrip, ProgressBar, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { SiteWip, SiteWipRow, WorkOrderCounts, WorkOrderRow } from '../../_shared/api'
import type { LiveState } from '../../_shared/hooks'
import { percentOf, progressPhrase, type ProductionCan } from '../../_shared/model'
import '../../_shared/production.css'
// B-W2a-38: the Lines section (fn-lines) and the line scope it sets.
import { LinesPanel, type LinesPanelModel } from './LinesPanel'
// B-W2b-66: the W2b sections (hour by hour, the heat map, stuck bundles, the line TV).
import type { BoardsState } from '../use-floor-boards'
import { bundlesHref, lineTvHref, tvLine, type FloorBoardsCan } from '../model'
import type { Hour, LineHours } from '../api'
import { HeatPanel, type HeatPanelActions, type HeatPanelModel } from './HeatPanel'
import { HourlyPanel, type BoardRefusal } from './HourlyPanel'
import { StuckPanel, type StuckPanelActions } from './StuckPanel'
import { TargetsDialog, type TargetsDialogModel } from './TargetsDialog'
// B-W2b-130: the Cutting room section (fn-cutting).
import { CuttingRoomPanel, type CuttingRoomModel } from '../cutting/view/CuttingRoomPanel'
import '../wip.css'
// F-PR-17: the customer filter, the Customer on each row, held work, no silent cap, line totals only with every customer.
import { withParty, type CustomerFilterState } from '../../_shared/customer/model'
import { CustomerFilter, EveryCustomerNotice, useCustomerCell } from '../../_shared/customer/view/CustomerFilter'
import { heldPhrase, shownOf } from '../model'

/** SCR-073 — Floor now's view model (FloorNowView draws it and fetches nothing). */
export interface FloorNowModel {
  prefix: string
  can: ProductionCan
  wip: { value: SiteWip | null; problem: string | null }
  counts: WorkOrderCounts | null
  late: { items: WorkOrderRow[] | null; problem: string | null }
  asOf: string | null
  live: LiveState
  /** B-W2a-38: each line at a glance (GET /production/reports/lines); absent: the section is not drawn. */
  lines?: LinesPanelModel['lines']
  /** B-W2a-38: the line the page is scoped to (`?line=`): the work orders on it only; null: all lines. */
  lineScope?: string | null
  /** B-W2b-66: the W2b sections; absent: none is drawn. */
  boards?: FloorBoardsModel
  /** B-W2b-130: the Cutting room (production.cutting.view); absent: not drawn. */
  cutting?: CuttingRoomModel
  /** F-PR-17: the customer filter (`?party=`); absent: none drawn. */
  customers?: CustomerFilterState
  /** F-PR-17: the person reaches only some customers: the line totals are not drawn and the page says why, once. */
  mixedWithheld?: boolean
  /** F-PR-17: Show more is reading the next work orders. */
  moreWip?: boolean
}

/** B-W2b-66: what the W2b sections draw (each only for a person who may read it). */
export interface FloorBoardsModel extends BoardsState {
  can: FloorBoardsCan
  cell?: HeatPanelModel['cell']
  targets?: TargetsDialogModel | null
  /** Design cases: the reason pop-up of this hour stands open. */
  openReason?: string
}

export interface FloorNowActions {
  onRetry?: () => void
  /** F-PR-17: a customer picked (null: every customer). */
  onCustomer?: (party: string | null) => void
  /** F-PR-17: the next work orders on the floor (no silent cap). */
  onMoreWip?: () => void
  /** B-W2a-38: a line card sets the line scope (null: all lines). */
  onLine?: (lineId: string | null) => void
  onRetryLines?: () => void
  /** B-W2b-66. */
  onRetryBoards?: () => void
  onSaveReason?: (hour: Hour, draft: { code: string; note: string }) => Promise<BoardRefusal | null>
  onSetTargets?: (line: LineHours['line']) => void
  onCloseTargets?: () => void
  onSaveTargets?: Parameters<typeof TargetsDialog>[0]['onSave']
  onCell?: HeatPanelActions['onCell']
  onCloseCell?: () => void
  onOpenBundle?: StuckPanelActions['onOpen']
  onExportStuck?: StuckPanelActions['onExport']
  /** B-W2b-130. */
  onRetryCutting?: () => void
}

/**
 * SCR-073 — Floor now (Production; design production.floor; MES-167, MES-305): the tiles (work orders in progress,
 * released and not started, late; pieces waiting between operations and scrap on the open work orders), every open work
 * order with its operations in routing order — pieces waiting · done at each, the operation with the most waiting
 * marked in words — each operation opening the bundles waiting there, and the late work orders. Totals per work order,
 * operation and line only: no person, no station (Statuto dei Lavoratori art. 4; Owner F2). Live from the floor's scans.
 * B-W2b-66: the tiles for stuck bundles and open help calls, Open line TV, the heat map, hour by hour with the lead's
 * reasons, the stuck bundles. B-W2b-130: the Cutting room (cut orders waiting and cutting, cut against plan today, hides used
 * and yield today, the fabric used; no cutter names).
 */
export function FloorNowView({ model, actions }: { model: FloorNowModel; actions?: FloorNowActions }) {
  return (
    <WithMessages namespaces={['production', 'production-reports', 'production-floor', 'production-cutboard']}>
      <FloorNow model={model} actions={actions} />
    </WithMessages>
  )
}

function FloorNow({ model, actions }: { model: FloorNowModel; actions?: FloorNowActions }) {
  const t = useT('production')
  const tr = useT('production-reports')
  const tf = useT('production-floor')
  const locale = useLocale()
  // B-W2a-38: scoped to a line, the work orders on it (allocated or planned there today) only.
  const scoped = model.lineScope ? (model.lines?.value?.lines.find((line) => line.id === model.lineScope) ?? null) : null
  const onLine = scoped ? new Set(scoped.workOrders.map((row) => row.id)) : null
  const rows = model.wip.value ? model.wip.value.workOrders.filter((row) => !onLine || onLine.has(row.workOrder.id)) : null
  const lateItems = model.late.items ? model.late.items.filter((row) => !onLine || onLine.has(row.id)) : null
  const waiting = rows ? rows.reduce((sum, row) => sum + row.operations.reduce((acc, op) => acc + (op.scanRequired ? op.waiting : 0), 0), 0) : null
  const scrap = rows ? rows.reduce((sum, row) => sum + row.operations.reduce((acc, op) => acc + op.scrap, 0), 0) : null
  const listHref = (view: string) => `${model.prefix}/production/work-orders?view=${view}`
  const sites = rows ? new Set(rows.map((row) => row.siteCode)).size : 0
  // B-W2b-66: the stuck bundles of the picked line's work orders, the tiles' counts, the line TV.
  const boards = model.boards
  const stuckRows = boards?.stuck.value ? boards.stuck.value.filter((row) => !onLine || onLine.has(row.workOrder.id)) : null
  const stuckLimit = boards?.tiles?.stuckLimitHours ?? null
  const openCalls = scoped ? scoped.openCalls : (boards?.openCalls ?? null)
  const lineCards = model.lines?.value?.lines ?? null
  // F-PR-17: how many work orders the floor holds beyond those shown, and how many late ones beyond the 20 listed.
  const customerCell = useCustomerCell(model.customers?.names ?? false)
  const wipMore = model.wip.value ? shownOf(model.wip.value.workOrders.length, model.wip.value.total) : null
  const lateMore = model.late.items && model.counts && !onLine ? shownOf(model.late.items.length, model.counts.late) : null
  const partial = wipMore ? { hint: t('floor.tile.shownOnly', { count: wipMore.shown }) } : null
  const party = model.customers?.party ?? null
  const stuckHref = bundlesHref(model.prefix, '?stuck=true')

  return (
    <div className="fw-pr">
      <div className="fw-pr-head">
        <span className="fw-pr-status" role="status">
          {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-pr-hint">{t('floor.privacy')}</span>
        {model.customers && <CustomerFilter state={model.customers} onPick={actions?.onCustomer} />}
        {boards?.can.boards && <LineTvAction prefix={model.prefix} lines={lineCards} scope={model.lineScope ?? null} />}
      </div>

      <MetricStrip
        metrics={[
          { label: t('floor.tile.inProgress'), value: model.counts ? String(model.counts.inProgress) : '—', href: listHref('IN_PROGRESS') },
          { label: t('floor.tile.released'), value: model.counts ? String(model.counts.released) : '—', href: listHref('RELEASED') },
          { label: t('floor.tile.late'), value: model.counts ? String(model.counts.late) : '—', href: listHref('late') },
          // F-PR-17: held work is on the floor too (09-design R11).
          { label: t('floor.tile.onHold'), value: model.counts?.onHold === undefined ? '—' : String(model.counts.onHold), href: listHref('ON_HOLD') },
          { label: t('floor.tile.waiting'), value: waiting === null ? '—' : String(waiting), hint: partial?.hint ?? t('floor.tile.waitingHint') },
          { label: t('floor.tile.scrap'), value: scrap === null ? '—' : String(scrap), hint: partial?.hint ?? t('floor.tile.scrapHint') },
          // F-PR-17: Bundles and Help calls open narrowed to the same customer.
          ...(boards?.can.bundles ? [{ label: stuckLimit === null ? tf('tile.stuckAny') : tf('tile.stuck', { count: stuckLimit }), value: stuckRows ? String(stuckRows.length) : '—', href: stuckHref ? withParty(stuckHref, party) : '#fn-stuck' }] : []),
          ...(boards?.can.calls ? [{ label: tf('tile.calls'), value: openCalls === null ? '—' : String(openCalls), href: withParty(`${model.prefix}/production/calls`, party) }] : []),
        ]}
      />

      {model.lines && (
        <Card padded className="fw-pr-card">
          <LinesPanel model={{ lines: model.lines, scope: model.lineScope ?? null }} actions={{ onLine: actions?.onLine, onRetry: actions?.onRetryLines }} />
        </Card>
      )}
      {/* F-PR-17: Lines, the heat map, hour by hour and the cutting room add up every customer (B-PR-07). */}
      {model.mixedWithheld && (
        <Card padded className="fw-pr-card">
          <h2 className="fw-pr-h2">{t('floor.lineTotals')}</h2>
          <EveryCustomerNotice compact />
        </Card>
      )}

      <Card padded className="fw-pr-card">
        <div className="fw-pr-card-head">
          <h2 className="fw-pr-h2">{t('floor.wip')}</h2>
          <span className="fw-pr-hint">{scoped ? tr('lines.scoped', { line: `${scoped.code} · ${scoped.name}` }) : t('floor.wipHint')}</span>
        </div>
        {model.wip.problem ? (
          <EmptyState title={t('floor.failed')} description={t(model.wip.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
        ) : !rows ? (
          <p className="fw-pr-hint" role="status">
            <Spinner size={12} /> {t('common.loading')}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState
            title={t('floor.empty.title')}
            description={t('floor.empty.body')}
            action={
              model.can.release ? (
                <Button size="sm" asChild>
                  <Link href={listHref('DRAFT')}>{t('floor.empty.action')}</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="fw-pr-floor">
              {rows.map((row) => (
                <FloorRow key={row.workOrder.id} row={row} prefix={model.prefix} showSite={sites > 1} customer={customerCell(row)} />
              ))}
            </div>
            {/* F-PR-17: no silent cap — "100 of 143 · Show more". */}
            {wipMore && (
              <p className="fw-pr-inline">
                <span className="fw-pr-hint">{t('floor.shownOf', { shown: wipMore.shown, total: wipMore.total })}</span>
                <Button size="sm" onClick={() => actions?.onMoreWip?.()} heldReason={model.moreWip ? t('common.loading') : undefined}>
                  {model.moreWip ? <Spinner size={12} /> : null} {t('floor.showMore')}
                </Button>
              </p>
            )}
          </>
        )}
      </Card>

      {boards?.can.boards && (
        <>
          <Card padded className="fw-pr-card">
            <HeatPanel model={{ prefix: model.prefix, heat: boards.heat, lineScope: model.lineScope ?? null, cell: boards.cell }} actions={{ onCell: actions?.onCell, onCloseCell: actions?.onCloseCell, onRetry: actions?.onRetryBoards }} />
          </Card>
          <Card padded className="fw-pr-card">
            <HourlyPanel
              model={{ hourly: boards.hourly, lineScope: model.lineScope ?? null, canSetTargets: boards.can.targets, openReason: boards.openReason }}
              actions={{ onSaveReason: actions?.onSaveReason, onSetTargets: actions?.onSetTargets, onRetry: actions?.onRetryBoards }}
            />
          </Card>
        </>
      )}

      <Card padded className="fw-pr-card">
        <h2 className="fw-pr-h2">{t('floor.late')}</h2>
        {model.late.problem ? (
          <p className="fw-pr-hint">{t(model.late.problem)}</p>
        ) : !lateItems ? (
          <p className="fw-pr-hint" role="status">
            <Spinner size={12} /> {t('common.loading')}
          </p>
        ) : lateItems.length === 0 ? (
          <p className="fw-pr-hint">{t('floor.noLate')}</p>
        ) : (
          <SummaryTable
            label={t('floor.late')}
            stackOnPhone
            columns={[t('col.number'), t('col.style'), t('col.customer'), t('col.due'), t('col.progress')]}
            widths={['16%', '22%', '24%', '18%', undefined]}
            rows={lateItems.map((row) => {
              const words = progressPhrase(row)
              return {
                id: row.id,
                cells: [
                  <Link key="n" className="fw-pr-link" href={`${model.prefix}/production/work-orders/${row.id}`}>
                    {row.number}
                  </Link>,
                  `${row.styleCode} · ${row.styleName}`,
                  // F-PR-17: the work order's one customer (B-PR-03), by name or code; a mixed one made before the rule says so.
                  row.customer !== undefined || row.mixedCustomers !== undefined ? customerCell(row) : [...new Set(row.orders.map((order) => order.partyName))].join(', ') || '—',
                  <span key="d" className="fw-pr-inline">
                    {row.dueDate ? formatDate(`${row.dueDate}T12:00:00Z`, { locale }) : '—'}
                    {row.daysLate ? <Tag tone="danger">{t('list.daysLate', { count: row.daysLate })}</Tag> : null}
                  </span>,
                  t(words.key, words.params),
                ],
              }
            })}
          />
        )}
        {/* F-PR-17: no silent cap on the late work orders either — "20 of 26 · Show all in Work orders". */}
        {lateMore && (
          <p className="fw-pr-inline">
            <span className="fw-pr-hint">{t('floor.shownOf', { shown: lateMore.shown, total: lateMore.total })}</span>
            <Link className="fw-pr-link" href={listHref('late')}>
              {t('floor.showAll')}
            </Link>
          </p>
        )}
      </Card>

      {boards?.can.bundles && (
        <Card padded className="fw-pr-card">
          <StuckPanel model={{ prefix: model.prefix, stuck: { value: stuckRows, problem: boards.stuck.problem }, capped: boards.stuckCapped }} actions={{ onOpen: actions?.onOpenBundle, onExport: actions?.onExportStuck, onRetry: actions?.onRetryBoards }} />
        </Card>
      )}

      {model.cutting && (
        <Card padded className="fw-pr-card">
          <CuttingRoomPanel model={model.cutting} actions={{ onRetry: actions?.onRetryCutting }} />
        </Card>
      )}

      {boards?.targets && <TargetsDialog model={boards.targets} onClose={() => actions?.onCloseTargets?.()} onSave={(changes) => actions?.onSaveTargets?.(changes) ?? Promise.resolve(null)} />}
    </div>
  )
}

/** "Open line TV" (design production.floor band): the picked or only line in a new tab; several lines: choose one; none: held. */
function LineTvAction({ prefix, lines, scope }: { prefix: string; lines: readonly { id: string; code: string; name: string }[] | null; scope: string | null }) {
  const tf = useT('production-floor')
  const line = tvLine(lines, scope)
  if (line) {
    return (
      <Button size="sm" asChild>
        <a href={lineTvHref(prefix, line)} target="_blank" rel="noopener" aria-label={tf('tv.openNewTab')}>
          <Tv size={14} aria-hidden /> {tf('tv.open')}
        </a>
      </Button>
    )
  }
  if (!lines || lines.length === 0) {
    return (
      <Button size="sm" heldReason={lines ? tf('tv.held') : tf('loading')}>
        <Tv size={14} aria-hidden /> {tf('tv.open')}
      </Button>
    )
  }
  return (
    <Menu
      label={
        <>
          <Tv size={14} aria-hidden /> {tf('tv.open')}
        </>
      }
      align="right"
      triggerProps={{ 'aria-label': tf('tv.pick') }}
      items={lines.map((entry) => ({ id: entry.id, label: `${entry.code} · ${entry.name}`, href: lineTvHref(prefix, entry.id), target: '_blank' as const }))}
    />
  )
}

function FloorRow({ row, prefix, showSite, customer }: { row: SiteWipRow; prefix: string; showSite: boolean; customer: string }) {
  const t = useT('production')
  const locale = useLocale()
  const href = `${prefix}/production/work-orders/${row.workOrder.id}`
  const held = heldPhrase(row)
  const pile = row.operations.filter((op) => op.scanRequired && op.waiting > 0).sort((a, b) => b.waiting - a.waiting)[0] ?? null
  return (
    <div className="fw-pr-floor-row">
      <div className="fw-pr-cell">
        <span className="fw-pr-inline">
          <Link className="fw-pr-link" href={`${href}?tab=operations`}>
            {row.workOrder.number}
          </Link>
          {row.daysLate ? <Tag tone="danger">{t('list.daysLate', { count: row.daysLate })}</Tag> : null}
          {held && <Tag tone="warning">{t(held.key, held.params)}</Tag>}
        </span>
        {/* F-PR-17: the work order's customer (the floor's Customer column). */}
        <span className="fw-pr-cell-sub">{customer}</span>
        <span className="fw-pr-cell-sub">
          {row.style.code} · {row.style.name}
          {showSite ? ` · ${row.siteCode}` : ''}
        </span>
        <span className="fw-pr-cell-sub">{row.dueDate ? t('floor.due', { date: formatDate(`${row.dueDate}T12:00:00Z`, { locale }) }) : t('floor.noDue')}</span>
        <ProgressBar value={percentOf(row.finished, row.pieces)} height={6} ariaLabel={t('floor.finishedLabel', { number: row.workOrder.number })} />
        <span className="fw-pr-cell-sub">{row.finished === null ? t('floor.notCounted') : t('floor.finished', { done: row.finished, total: row.pieces })}</span>
      </div>
      <div className="fw-pr-ops" role="list" aria-label={t('floor.opsOf', { number: row.workOrder.number })}>
        {row.operations.map((op) => {
          const body = (
            <>
              <span className="fw-pr-op-name">
                {op.seq} {op.code}
              </span>
              <span className="fw-pr-op-figures">{t('floor.opFigures', { waiting: op.waiting, good: op.good })}</span>
              {op.scrap > 0 && <span className="fw-pr-op-figures">{t('floor.opScrap', { count: op.scrap })}</span>}
              {pile?.operationId === op.operationId && <Tag tone="warning">{t('floor.mostWaiting')}</Tag>}
              {!op.scanRequired && <span className="fw-pr-op-figures">{t(op.unplanned ? 'ops.unplanned' : 'ops.notScanned')}</span>}
            </>
          )
          const cls = pile?.operationId === op.operationId ? 'fw-pr-op is-pile' : 'fw-pr-op'
          return (
            <div key={op.operationId} role="listitem" className="fw-pr-op-item">
              {op.scanRequired ? (
                <Link className={cls} href={`${href}?tab=bundles&at=${op.seq}`} aria-label={t('floor.opLink', { seq: op.seq, code: op.code, waiting: op.waiting, good: op.good })}>
                  {body}
                </Link>
              ) : (
                <div className={cls}>{body}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
