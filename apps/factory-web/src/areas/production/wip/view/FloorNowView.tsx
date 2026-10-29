'use client'

import Link from 'next/link'
import { Card, EmptyState, MetricStrip, ProgressBar, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { SiteWip, SiteWipRow, WorkOrderCounts, WorkOrderRow } from '../../_shared/api'
import type { LiveState } from '../../_shared/hooks'
import { percentOf, progressPhrase, type ProductionCan } from '../../_shared/model'
import '../../_shared/production.css'

/** SCR-073 — Floor now's view model (FloorNowView draws it and fetches nothing). */
export interface FloorNowModel {
  prefix: string
  can: ProductionCan
  wip: { value: SiteWip | null; problem: string | null }
  counts: WorkOrderCounts | null
  late: { items: WorkOrderRow[] | null; problem: string | null }
  asOf: string | null
  live: LiveState
}

export interface FloorNowActions {
  onRetry?: () => void
}

/**
 * SCR-073 — Floor now (Production; design production.floor; MES-167, MES-305): the tiles (work orders in progress,
 * released and not started, late; pieces waiting between operations and scrap on the open work orders), every open work
 * order with its operations in routing order — pieces waiting · done at each, the operation with the most waiting
 * marked in words — each operation opening the bundles waiting there, and the late work orders. Totals per work order,
 * operation and line only: no person, no station (Statuto dei Lavoratori art. 4; Owner F2). Live from the floor's scans.
 */
export function FloorNowView({ model, actions }: { model: FloorNowModel; actions?: FloorNowActions }) {
  return (
    <WithMessages namespaces={['production']}>
      <FloorNow model={model} actions={actions} />
    </WithMessages>
  )
}

function FloorNow({ model, actions }: { model: FloorNowModel; actions?: FloorNowActions }) {
  const t = useT('production')
  const locale = useLocale()
  const rows = model.wip.value?.workOrders ?? null
  const waiting = rows ? rows.reduce((sum, row) => sum + row.operations.reduce((acc, op) => acc + (op.scanRequired ? op.waiting : 0), 0), 0) : null
  const scrap = rows ? rows.reduce((sum, row) => sum + row.operations.reduce((acc, op) => acc + op.scrap, 0), 0) : null
  const listHref = (view: string) => `${model.prefix}/production/work-orders?view=${view}`
  const sites = rows ? new Set(rows.map((row) => row.siteCode)).size : 0

  return (
    <div className="fw-pr">
      <div className="fw-pr-head">
        <span className="fw-pr-status" role="status">
          {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-pr-hint">{t('floor.privacy')}</span>
      </div>

      <MetricStrip
        metrics={[
          { label: t('floor.tile.inProgress'), value: model.counts ? String(model.counts.inProgress) : '—', href: listHref('IN_PROGRESS') },
          { label: t('floor.tile.released'), value: model.counts ? String(model.counts.released) : '—', href: listHref('RELEASED') },
          { label: t('floor.tile.late'), value: model.counts ? String(model.counts.late) : '—', href: listHref('late') },
          { label: t('floor.tile.waiting'), value: waiting === null ? '—' : String(waiting), hint: t('floor.tile.waitingHint') },
          { label: t('floor.tile.scrap'), value: scrap === null ? '—' : String(scrap), hint: t('floor.tile.scrapHint') },
        ]}
      />

      <Card padded className="fw-pr-card">
        <div className="fw-pr-card-head">
          <h2 className="fw-pr-h2">{t('floor.wip')}</h2>
          <span className="fw-pr-hint">{t('floor.wipHint')}</span>
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
          <div className="fw-pr-floor">
            {rows.map((row) => (
              <FloorRow key={row.workOrder.id} row={row} prefix={model.prefix} showSite={sites > 1} />
            ))}
          </div>
        )}
      </Card>

      <Card padded className="fw-pr-card">
        <h2 className="fw-pr-h2">{t('floor.late')}</h2>
        {model.late.problem ? (
          <p className="fw-pr-hint">{t(model.late.problem)}</p>
        ) : !model.late.items ? (
          <p className="fw-pr-hint" role="status">
            <Spinner size={12} /> {t('common.loading')}
          </p>
        ) : model.late.items.length === 0 ? (
          <p className="fw-pr-hint">{t('floor.noLate')}</p>
        ) : (
          <SummaryTable
            label={t('floor.late')}
            stackOnPhone
            columns={[t('col.number'), t('col.style'), t('col.customer'), t('col.due'), t('col.progress')]}
            widths={['16%', '22%', '24%', '18%', undefined]}
            rows={model.late.items.map((row) => {
              const words = progressPhrase(row)
              return {
                id: row.id,
                cells: [
                  <Link key="n" className="fw-pr-link" href={`${model.prefix}/production/work-orders/${row.id}`}>
                    {row.number}
                  </Link>,
                  `${row.styleCode} · ${row.styleName}`,
                  [...new Set(row.orders.map((order) => order.partyName))].join(', ') || '—',
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
      </Card>
    </div>
  )
}

function FloorRow({ row, prefix, showSite }: { row: SiteWipRow; prefix: string; showSite: boolean }) {
  const t = useT('production')
  const locale = useLocale()
  const href = `${prefix}/production/work-orders/${row.workOrder.id}`
  const pile = row.operations.filter((op) => op.scanRequired && op.waiting > 0).sort((a, b) => b.waiting - a.waiting)[0] ?? null
  return (
    <div className="fw-pr-floor-row">
      <div className="fw-pr-cell">
        <span className="fw-pr-inline">
          <Link className="fw-pr-link" href={`${href}?tab=operations`}>
            {row.workOrder.number}
          </Link>
          {row.daysLate ? <Tag tone="danger">{t('list.daysLate', { count: row.daysLate })}</Tag> : null}
        </span>
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
              {!op.scanRequired && <span className="fw-pr-op-figures">{t('ops.notScanned')}</span>}
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
