'use client'

import Link from 'next/link'
import { Banner, Card, Disclosure, ProgressBar, SummaryTable } from '@nexus/ui/components'
import { Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import type { WorkOrder, WorkOrderWip } from '../../../_shared/api'
// F-PR-06: ONE operation table, each operation opening to its sizes.
import { linesOutput, operationRows, type OperationRow } from '../model'
import type { WorkOrderRecordActions, WorkOrderRecordModel } from '../../record/record-model'
import { DAILY_NAMESPACE } from '../../daily/model'
import { PartState } from '../../record/view/WorkOrderRecordView'
import { ExtraPanel } from '../../extra/view/ExtraPanel'

/**
 * SCR-072 — Operations & WIP (design wo-flow, wo-corrections; MES-079, MES-167; F-PR-06, 06-tree A.4 Tab 4): ONE operation table
 * of the frozen routing with, per operation, the pieces arrived, waiting, good, scrap and rework and its bundles done / waiting /
 * not reached; each operation opens to its sizes (the By operation / By size switch went); an outsourced operation is marked;
 * unplanned operations; output per line (F2: line totals only, never a person or a station); the floor's correction requests
 * waiting, a door to Labour. A draft shows the operations the release would freeze.
 */
export function OperationsTab({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  if (workOrder.status === 'DRAFT') return <PlannedOperations workOrder={workOrder} />
  const wip = model.wip.value
  if (!wip) return <PartState label={t('tab.operations')} problem={model.wip.problem} onRetry={() => actions?.onRetryPart?.('wip')} />
  return (
    <div className="fw-pr-stack">
      <Flow workOrder={workOrder} wip={wip} prefix={model.prefix} labour={model.can.labour} />
      {model.extra && <ExtraPanel workOrder={workOrder} model={model.extra} actions={actions?.extra} />}
    </div>
  )
}

function PlannedOperations({ workOrder }: { workOrder: WorkOrder }) {
  const t = useT('production')
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('ops.planned')}</h2>
        <span className="fw-pr-hint">{t('ops.perGarment', { minutes: workOrder.spec.standardMinutes.perGarment })}</span>
      </div>
      {workOrder.spec.operations.length === 0 ? (
        <p className="fw-pr-hint">{t('ops.none')}</p>
      ) : (
        <SummaryTable
          label={t('ops.planned')}
          stackOnPhone
          columns={[t('ops.col.seq'), t('ops.col.operation'), t('ops.col.centre'), t('ops.col.minutes'), t('ops.col.scan')]}
          align={[undefined, undefined, undefined, 'right', 'left']}
          widths={['8%', undefined, '22%', '14%', '14%']}
          rows={workOrder.spec.operations.map((op) => ({
            id: String(op.seq),
            cells: [String(op.seq), `${op.code} · ${op.name}`, [t(`kind.${op.workCentreKind}`), op.workCentreCode].filter(Boolean).join(' · '), op.standardMinutes, op.scanRequired ? t('ops.scanned') : t('ops.notScanned')],
          }))}
        />
      )}
      <p className="fw-pr-hint">{t('ops.plannedHint')}</p>
    </Card>
  )
}

function Flow({ workOrder, wip, prefix, labour }: { workOrder: WorkOrder; wip: WorkOrderWip; prefix: string; labour: boolean }) {
  const t = useT('production')
  const rows = operationRows(workOrder, wip)
  const lines = linesOutput(wip)
  return (
    <div className="fw-pr-stack">
      {wip.readyToComplete && <Banner tone="success" title={t('ops.readyToComplete')} />}
      <Card padded className="fw-pr-card">
        <div className="fw-pr-card-head">
          <h2 className="fw-pr-h2">{t('ops.title')}</h2>
        </div>
        <div className="fw-pr-table">
          <SummaryTable
            label={t('ops.title')}
            stackOnPhone
            columns={[t('ops.col.operation'), t('ops.col.minutes'), t('ops.col.arrived'), t('ops.col.waiting'), t('ops.col.good'), t('ops.col.scrap'), t('ops.col.rework'), t('ops.col.bundles'), t('ops.col.progress')]}
            align={[undefined, 'right', 'right', 'right', 'right', 'right', 'right', 'left', 'left']}
            widths={['26%', '7%', '7%', '7%', '7%', '7%', '7%', '18%', undefined]}
            rows={rows.map((op) => ({
              id: op.id,
              cells: [
                <OperationCell key="o" op={op} />,
                op.minutes ?? '—',
                String(op.arrived),
                <WaitingCell key="w" op={op} />,
                String(op.good),
                String(op.scrap),
                String(op.rework),
                t('ops.bundleCounts', { done: op.bundles.done, waiting: op.bundles.waiting, notReached: op.bundles.notReached }),
                <ProgressBar key="p" value={op.progress} height={6} showValue ariaLabel={t('ops.progressLabel', { operation: op.code })} />,
              ],
            }))}
          />
        </div>
        <p className="fw-pr-hint">{t('ops.hint')}</p>
      </Card>
      <div className="fw-pr-cards">
        <Card padded className="fw-pr-card">
          <h2 className="fw-pr-h2">{t('ops.lines')}</h2>
          {lines.length === 0 ? (
            <p className="fw-pr-hint">{t('ops.noLines')}</p>
          ) : (
            <SummaryTable label={t('ops.lines')} columns={[t('ops.col.line'), t('ops.col.finished')]} rows={lines.map((line) => ({ id: line.id, cells: [`${line.code} · ${line.name}`, String(line.good)] }))} />
          )}
          <p className="fw-pr-hint">{t('ops.linesHint')}</p>
        </Card>
        <Card padded className="fw-pr-card">
          <h2 className="fw-pr-h2">{t('ops.corrections')}</h2>
          <p className="fw-pr-hint">
            {wip.correctionsWaiting === 0 ? t('ops.noCorrections') : t('ops.correctionsWaiting', { count: wip.correctionsWaiting })}{' '}
            {wip.correctionsWaiting > 0 && (labour ? <Link href={`${prefix}/production/labour?kind=CORRECTION`}>{t('ops.toLabour')}</Link> : <Link href={`${prefix}/home/today`}>{t('ops.toToday')}</Link>)}
          </p>
          <p className="fw-pr-hint">{t('ops.correctionsHint')}</p>
        </Card>
      </div>
    </div>
  )
}

/** The pile waiting before an operation; the biggest marked (B-W2a-46 wo-flow: the OperationFlow's mark, in the one table). */
function WaitingCell({ op }: { op: OperationRow }) {
  const tw = useT(DAILY_NAMESPACE)
  if (op.waiting === 0) return <span>0</span>
  return (
    <span className="fw-pr-cell">
      <b>{op.waiting}</b>
      {op.bottleneck && <Tag tone="warning">{tw('flow.bottleneck')}</Tag>}
    </span>
  )
}

/** An operation's cell: its code and marks, its name and work centre, and its sizes behind a Disclosure (the row opens to them). */
function OperationCell({ op }: { op: OperationRow }) {
  const t = useT('production')
  return (
    <span className="fw-pr-cell">
      <span className="fw-pr-inline">
        {op.seq} {op.code}
        {op.final && <Tag tone="info">{t('ops.final')}</Tag>}
        {op.sewn && !op.final && <Tag tone="neutral">{t('ops.sewn')}</Tag>}
        {op.unplanned && <Tag tone="warning">{t('ops.unplanned')}</Tag>}
        {op.outsourced && <Tag tone="info">{t('ops.outsourced')}</Tag>}
      </span>
      <span className="nds-summary-sub">
        {op.name} · {t(`kind.${op.kind}`)}
        {op.scanned || op.unplanned ? '' : ` · ${t('ops.notScanned')}`}
      </span>
      {op.outsourced && <span className="nds-summary-sub">{t('ops.outsourcedHint')}</span>}
      {op.sizes.length > 0 ? (
        <Disclosure summary={t('ops.sizes', { count: op.sizes.length })}>
          <SummaryTable
            label={t('ops.sizesOf', { operation: `${op.seq} ${op.code}` })}
            columns={[t('cutting.col.cell'), t('cutting.col.quantity'), t('ops.col.good'), t('ops.col.waiting'), t('ops.col.scrap'), t('ops.col.rework')]}
            align={[undefined, 'right', 'right', 'right', 'right', 'right']}
            rows={op.sizes.map((size) => ({ id: size.id, cells: [size.cell, String(size.quantity), String(size.good), String(size.waiting), String(size.scrap), String(size.rework)] }))}
          />
        </Disclosure>
      ) : (
        !op.unplanned && !op.scanned && <span className="nds-summary-sub">{t('ops.noSizes')}</span>
      )}
    </span>
  )
}
