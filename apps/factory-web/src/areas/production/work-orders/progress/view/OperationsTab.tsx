'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Banner, Card, ProgressBar, SummaryTable } from '@nexus/ui/components'
import { SegmentedControl, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import type { WorkOrder, WorkOrderWip } from '../../../_shared/api'
import { percentOf } from '../../../_shared/model'
import type { WorkOrderRecordActions, WorkOrderRecordModel } from '../../record/record-model'
import { PartState } from '../../record/view/WorkOrderRecordView'

/**
 * SCR-072 — Operations and WIP (design wo-flow, wo-corrections; MES-079, MES-167): the operation bulletin of the frozen
 * routing with, per operation, the pieces arrived, waiting, good, scrap and rework and its bundles done / waiting / not
 * reached — or per size, the good pieces at each operation; output per line (F2: line totals only, never a person or a
 * station); the floor's correction requests waiting. A draft shows the operations the release would freeze.
 */
export function OperationsTab({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  if (workOrder.status === 'DRAFT') return <PlannedOperations workOrder={workOrder} />
  const wip = model.wip.value
  if (!wip) return <PartState label={t('tab.operations')} problem={model.wip.problem} onRetry={() => actions?.onRetryPart?.('wip')} />
  return <Flow workOrder={workOrder} wip={wip} prefix={model.prefix} bySize={!!model.draft?.opsBySize} />
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

function Flow({ workOrder, wip, prefix, bySize }: { workOrder: WorkOrder; wip: WorkOrderWip; prefix: string; bySize: boolean }) {
  const t = useT('production')
  const [view, setView] = useState<'operations' | 'sizes'>(bySize ? 'sizes' : 'operations')
  const minutes = new Map(workOrder.spec.operations.map((op) => [op.seq, op.standardMinutes]))
  const lines = new Map<string, { code: string; name: string; good: number }>()
  for (const op of wip.operations.filter((entry) => entry.final)) for (const line of op.lines) lines.set(line.lineId, { code: line.code, name: line.name, good: (lines.get(line.lineId)?.good ?? 0) + line.good })
  const scanned = wip.operations.filter((op) => op.scanRequired)
  return (
    <div className="fw-pr-stack">
      {wip.readyToComplete && <Banner tone="success" title={t('ops.readyToComplete')} />}
      <Card padded className="fw-pr-card">
        <div className="fw-pr-card-head">
          <h2 className="fw-pr-h2">{t('ops.title')}</h2>
          <SegmentedControl
            size="sm"
            ariaLabel={t('ops.viewLabel')}
            value={view}
            onChange={(value) => setView(value as 'operations' | 'sizes')}
            options={[
              { value: 'operations', label: t('ops.byOperation') },
              { value: 'sizes', label: t('ops.bySize') },
            ]}
          />
        </div>
        <div className="fw-pr-table">
          {view === 'operations' ? (
            <SummaryTable
              label={t('ops.title')}
              stackOnPhone
              columns={[t('ops.col.operation'), t('ops.col.minutes'), t('ops.col.arrived'), t('ops.col.waiting'), t('ops.col.good'), t('ops.col.scrap'), t('ops.col.rework'), t('ops.col.bundles'), t('ops.col.progress')]}
              align={[undefined, 'right', 'right', 'right', 'right', 'right', 'right', 'left', 'left']}
              widths={['22%', '7%', '7%', '7%', '7%', '7%', '7%', '21%', undefined]}
              rows={wip.operations.map((op) => ({
                id: op.operationId,
                cells: [
                  <span key="o" className="fw-pr-cell">
                    <span className="fw-pr-inline">
                      {op.seq} {op.code}
                      {op.final && <Tag tone="info">{t('ops.final')}</Tag>}
                      {op.sewn && !op.final && <Tag tone="neutral">{t('ops.sewn')}</Tag>}
                    </span>
                    <span className="nds-summary-sub">
                      {op.name} · {t(`kind.${op.workCentreKind}`)}
                      {op.scanRequired ? '' : ` · ${t('ops.notScanned')}`}
                    </span>
                  </span>,
                  minutes.get(op.seq) ?? '—',
                  String(op.arrived),
                  op.waiting > 0 ? <b key="w">{op.waiting}</b> : '0',
                  String(op.good),
                  String(op.scrap),
                  String(op.rework),
                  t('ops.bundleCounts', { done: op.bundles.done, waiting: op.bundles.waiting, notReached: op.bundles.notReached }),
                  <ProgressBar key="p" value={percentOf(op.good, workOrder.pieces)} height={6} showValue ariaLabel={t('ops.progressLabel', { operation: op.code })} />,
                ],
              }))}
            />
          ) : (
            <SummaryTable
              label={t('ops.bySize')}
              columns={[t('cutting.col.cell'), t('cutting.col.quantity'), ...scanned.map((op) => `${op.seq} ${op.code}`)]}
              align={[undefined, 'right', ...scanned.map(() => 'right' as const)]}
              rows={wip.cells.map((cell) => ({
                id: cell.workOrderSizeId,
                cells: [
                  `${cell.colourwayCode} ${cell.size}`,
                  String(cell.quantity),
                  ...scanned.map((op) => {
                    const at = op.cells.find((entry) => entry.workOrderSizeId === cell.workOrderSizeId)
                    return at ? String(at.good) : '—'
                  }),
                ],
              }))}
            />
          )}
        </div>
        <p className="fw-pr-hint">{t('ops.hint')}</p>
      </Card>
      <div className="fw-pr-cards">
        <Card padded className="fw-pr-card">
          <h2 className="fw-pr-h2">{t('ops.lines')}</h2>
          {lines.size === 0 ? (
            <p className="fw-pr-hint">{t('ops.noLines')}</p>
          ) : (
            <SummaryTable label={t('ops.lines')} columns={[t('ops.col.line'), t('ops.col.finished')]} rows={[...lines.entries()].map(([id, line]) => ({ id, cells: [`${line.code} · ${line.name}`, String(line.good)] }))} />
          )}
          <p className="fw-pr-hint">{t('ops.linesHint')}</p>
        </Card>
        <Card padded className="fw-pr-card">
          <h2 className="fw-pr-h2">{t('ops.corrections')}</h2>
          <p className="fw-pr-hint">
            {wip.correctionsWaiting === 0 ? t('ops.noCorrections') : t('ops.correctionsWaiting', { count: wip.correctionsWaiting })}{' '}
            {wip.correctionsWaiting > 0 && <Link href={`${prefix}/home/today`}>{t('ops.toToday')}</Link>}
          </p>
          <p className="fw-pr-hint">{t('ops.correctionsHint')}</p>
        </Card>
      </div>
    </div>
  )
}
