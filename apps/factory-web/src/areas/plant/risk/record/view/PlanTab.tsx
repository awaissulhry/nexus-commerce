'use client'

import { useEffect } from 'react'
import { ClipboardList, Plus, Printer } from 'lucide-react'
import { Card, EmptyState, MetricStrip, Sparkline, type Metric } from '@nexus/ui/components'
import { SelectionLabel } from '@nexus/ui/grid'
import { Button, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { AssessmentRecord, MeasureView } from '../../api'
import { burnSummary, MEASURE_VIEWS, planPrintHref } from '../../model'
import type { RiskRecordActions, RiskRecordModel } from '../../view-model'
import { useMeasureColumns, withheldCost } from '../../view/MeasureParts'
import { Law, PAGE_KEYS, SectionFailed, SectionHead, SectionLoading, useDay, useWords } from '../../view/parts'

/**
 * The Improvement plan tab (design rec tab plan; QHS-234, art. 28 c.2 c-d): the plan's figures (open, late, due in 30 days,
 * done, verified, cancelled), its measures — measure, risk or area, roles, owner, due (DueCell), cost (the cost grain only),
 * status, evidence, source — with owner, due and status edited in their cells (autosaved, the save mark beside each), a
 * row opening the measure (its facts, evidence files and moves), Print N; and "Open measures over time" (whether the plan
 * is moving: the open measures at the end of each week of the last year).
 */
export function PlanTab({ model, record, actions, onHelp }: { model: RiskRecordModel; record: AssessmentRecord; actions?: RiskRecordActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const day = useDay()
  const answer = model.measures.status === 'ready' ? model.measures.value : null
  const rows = answer?.measures ?? null
  const selected = model.selected ?? []
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.id === id))) actions?.onSelected?.(selected.filter((id) => rows.some((row) => row.id === id)))
  }, [rows, selected, actions])
  const columns = useMeasureColumns({ frame: model, cells: model.cells, owners: model.owners, site: false, evidence: true, onTitle: (row) => actions?.onAddress?.({ measure: row.id }), actions })
  const plan = record.plan
  const figures: Metric[] = (['open', 'overdue', 'dueSoon', 'done', 'verified', 'cancelled'] as const).map((key) => ({
    label: t(`plan.${key}`),
    value: String(plan[key]),
    onClick: () => actions?.onAddress?.({ view: key === 'verified' ? 'done' : key }),
    active: model.address.view === key,
    ...(key === 'overdue' && plan.overdue > 0 ? { accent: 'var(--nds-danger)' } : key === 'dueSoon' && plan.dueSoon > 0 ? { accent: 'var(--nds-warning)' } : {}),
  }))
  const burn = burnSummary(plan.burn)
  const addHeld = !record.may.manage ? t('held.manage') : null
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))

  return (
    <div className="fw-rk-stack">
      <MetricStrip metrics={figures} minTileWidth={150} />
      <section className="fw-rk-section" aria-labelledby="fw-rk-plan-measures">
        <SectionHead id="fw-rk-plan-measures" title={t('plan.measures')} note={<Law law={record.law.plan} plain={t('law.plan')} />}>
          <Button size="sm" asChild>
            <a href={planPrintHref(model.prefix, { assessments: [record.assessment.id], view: model.address.view })} target="_blank" rel="noopener">
              <Printer size={13} aria-hidden /> {t('plan.print')}
            </a>
          </Button>
          <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={addHeld} onClick={() => actions?.onAddress?.({ add: 'measure' })}>
            <Plus size={13} aria-hidden /> {t('band.addMeasure')}
          </Button>
        </SectionHead>
        {model.measures.status === 'error' ? (
          <SectionFailed title={t('measures.failed')} problem={model.measures.problem} onRetry={actions?.onRetryMeasures} />
        ) : !answer || !rows ? (
          <SectionLoading rows={5} />
        ) : (
          <ListFrame
            label={t('plan.label')}
            title={t('plan.measures')}
            listKey={null}
            rows={rows}
            rowId={(row) => row.id}
            columns={columns}
            count={t('measures.count', { count: rows.length })}
            search={
              <Select size="sm" value={model.address.view} aria-label={t('measures.viewLabel')} onChange={(event) => actions?.onAddress?.({ view: event.target.value as MeasureView })}>
                {MEASURE_VIEWS.map((view) => (
                  <option key={view} value={view}>
                    {t(`view.${view}`)}
                  </option>
                ))}
              </Select>
            }
            selection={{
              selected,
              onChange: (ids) => actions?.onSelected?.(ids),
              actions: (
                <Button size="sm" aria-label={t('bulk.print', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneChosen') : null} onClick={() => window.open(planPrintHref(model.prefix, { ids: picked.map((row) => row.id), view: 'all' }), '_blank', 'noopener')}>
                  <Printer size={13} aria-hidden /> <SelectionLabel>{t('bulk.print', { count: picked.length })}</SelectionLabel>
                </Button>
              ),
            }}
            keys={PAGE_KEYS(t)}
            onHelp={onHelp}
            onOpen={(row) => actions?.onAddress?.({ measure: row.id })}
            withheld={withheldCost(t, model.can.cost)}
            more={answer.complete ? null : { label: t('measures.more'), onMore: () => undefined, held: t('measures.moreHeld') }}
            state={rows.length === 0 ? <EmptyState icon={<ClipboardList size={22} aria-hidden />} title={t(model.address.view === 'all' ? 'plan.empty' : 'measures.noneInView')} description={t('plan.emptyHint')} /> : undefined}
            cards={{ fields: { title: { role: 'title' }, status: { role: 'subtitle' } } }}
          />
        )}
      </section>
      <section className="fw-rk-section" aria-labelledby="fw-rk-burn">
        <SectionHead id="fw-rk-burn" title={t('plan.burnTitle')} note={t('plan.burnNote')} />
        <Card padded>
          <div className="fw-rk-stack">
            <Sparkline values={plan.burn.map((point) => point.open)} label={t('plan.burnLabel')} shape="step" domain={[0, null]} format={(n) => t('plan.burnValue', { count: n })} emptyLabel={t('plan.burnEmpty')} fluid height={120} />
            <div className="fw-rk-burn-axis" aria-hidden>
              <span>{burn.first ? day(burn.first.on) : '—'}</span>
              <span>{burn.last ? day(burn.last.on) : '—'}</span>
            </div>
            <p className="fw-rk-muted">{t('plan.burnSummary', { first: burn.first?.open ?? 0, peak: burn.peak, now: burn.last?.open ?? 0 })}</p>
          </div>
        </Card>
      </section>
    </div>
  )
}
