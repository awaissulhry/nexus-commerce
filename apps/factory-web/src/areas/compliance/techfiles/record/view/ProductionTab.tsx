'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { CalendarPlus, ClipboardCheck, MoreHorizontal } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, SegmentedControl, Select } from '@nexus/ui/primitives'
import { FREQUENCIES, TEST_KINDS, TEST_RESULTS, type TestKind } from '@nexus/factory-domain/compliance/techfiles/rules'
import { Countdown, DateField, FileDropzone, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { recordAddress as recordPage } from '../../../../../lib/records/record-links'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { evidenceAddress } from '../../../../quality/_shared/model'
import type { Batch } from '../../api'
import { LAB_REPORT_TYPES } from '../../api'
import { BATCH_TONE, buildHeld, daysUntil, dueInstant, PLAN_TONE, recordProblems, RESULT_TONE, scheduleProblems, valueOf } from '../../model'
import { NoticeBanner, SectionFailed, SectionHead, SectionLoading, StatePill, useDay, useWords } from '../../view/parts'
import type { RecordActions, RecordModel, TestDialog } from '../view-model'

/**
 * Technical file › Production control (design rec tab "production", sec tf-moduleC; PRD-302, QHS-048, QHS-110; PPE Reg. Annex
 * VIII / module C2): conformity to type per batch — the work order and its batch, the in-process checks (counts only, never
 * who), the production-control tests of the batch, the final inspection, the releases, and its state (Evidence complete /
 * Missing / Failed / In production) with what is missing in words; Record test or Schedule test where evidence is missing.
 * Below, the plan of periodic tests: what, how often, last tested, next due (Countdown) — and the tests planned and not yet
 * recorded. Recorded tests are kept ten years with their lab report.
 */
export function ProductionTab({ model, actions }: { model: RecordModel; actions?: RecordActions | undefined }) {
  const t = useWords()
  const day = useDay()
  const prefix = model.prefix
  const held = buildHeld(model.can, model.online)

  const columns = useMemo<ColDef<Batch>[]>(() => {
    const OrderCell = ({ data }: ICellRendererParams<Batch>) =>
      data ? (
        <span className="fw-tf-cell">
          {model.can.workOrders ? (
            <Link className="fw-tf-link" href={`${prefix}${recordPage({ type: 'WorkOrder', id: data.workOrder.id }, OFFICE_PAGES)}`}>
              {data.workOrder.number}
            </Link>
          ) : (
            <span>{data.workOrder.number}</span>
          )}
          <span className="fw-tf-muted">{data.workOrder.batchNumber ? t('production.batch', { batch: data.workOrder.batchNumber }) : t('production.noBatch')}</span>
        </span>
      ) : null
    const ChecksCell = ({ data }: ICellRendererParams<Batch>) =>
      data ? (
        <span className="fw-tf-cell">
          <span>{t('production.checks', { decided: data.inProcess.decided })}</span>
          <span className={data.inProcess.failed > 0 ? 'fw-tf-danger-text' : 'fw-tf-muted'}>{t('production.checksFailedOpen', { failed: data.inProcess.failed, open: data.inProcess.open })}</span>
        </span>
      ) : null
    const TestsCell = ({ data }: ICellRendererParams<Batch>) =>
      data ? (
        data.tests.length === 0 ? (
          <span className="fw-tf-muted">{t('production.noTests')}</span>
        ) : (
          <span className="fw-tf-pills">
            {data.tests.map((test) => (
              <Pill key={test.id} tone={test.result ? RESULT_TONE[test.result] : 'neutral'}>
                {`${test.testName ?? t(`testKind.${test.test}`)} · ${test.result ? t(`result.${test.result}`) : t('production.due', { date: day(test.dueOn) })}`}
              </Pill>
            ))}
          </span>
        )
      ) : null
    const FinalCell = ({ data }: ICellRendererParams<Batch>) =>
      data ? (
        data.finalInspection ? (
          <span className="fw-tf-cell">
            {model.can.inspections ? (
              <Link className="fw-tf-link" href={`${prefix}${recordPage({ type: 'Inspection', id: data.finalInspection.id }, OFFICE_PAGES)}`}>
                {data.finalInspection.number ?? t('production.inspection')}
              </Link>
            ) : (
              <span>{data.finalInspection.number ?? t('production.inspection')}</span>
            )}
            <span className="fw-tf-muted">
              {t(`inspectionStatus.${data.finalInspection.status}`)}
              {data.releases.count > 0 ? ` · ${t('production.releases', { count: data.releases.count, quantity: data.releases.quantity })}` : ` · ${t('production.notReleased')}`}
            </span>
          </span>
        ) : (
          <span className="fw-tf-muted">{t('production.noFinal')}</span>
        )
      ) : null
    const StateCell = ({ data }: ICellRendererParams<Batch>) =>
      data ? (
        <span className="fw-tf-cell">
          <StatePill group="batchState" state={data.evidence.state} tone={BATCH_TONE[data.evidence.state]} />
          {data.evidence.missing.length > 0 && (
            <span className="fw-tf-muted">
              {t('production.missingList', {
                list: data.evidence.missing.map((entry) => (entry.code === 'TEST' ? (entry.testName ?? t(`testKind.${entry.test ?? 'OTHER'}`)) : t(`missing.${entry.code}`))).join(', '),
              })}
            </span>
          )}
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<Batch>) => {
      if (!data) return null
      const due = data.tests.find((test) => !test.result) ?? null
      const trail = data.workOrder.batchNumber ? evidenceAddress(prefix, { batch: data.workOrder.batchNumber }) : null
      const items: MenuItemDef[] = [
        { id: 'record', label: due ? t('production.recordDue', { test: due.testName ?? t(`testKind.${due.test}`) }) : t('production.recordNew'), disabled: !!held, description: held ? t(held) : undefined, onSelect: () => actions?.onRecord?.(due?.id ?? null) },
        { id: 'schedule', label: t('production.scheduleFor', { number: data.workOrder.number }), disabled: !!held, description: held ? t(held) : undefined, onSelect: () => actions?.onSchedule?.(data.workOrder.id) },
        trail ? { id: 'trail', label: t('row.trail', { batch: data.workOrder.batchNumber ?? '' }), href: trail, target: '_blank' } : { id: 'trail', label: t('row.trailNone'), disabled: true, description: t('held.noBatch') },
      ]
      return <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('production.menu', { number: data.workOrder.number }) }} items={items} />
    }
    return [
      { colId: 'order', headerName: t('production.col.order'), minWidth: 160, flex: 1, valueGetter: (params) => params.data?.workOrder.number ?? '', cellRenderer: OrderCell, autoHeight: true },
      { colId: 'checks', headerName: t('production.col.checks'), minWidth: 150, flex: 1, valueGetter: (params) => params.data?.inProcess.decided ?? 0, cellRenderer: ChecksCell, autoHeight: true },
      { colId: 'tests', headerName: t('production.col.tests'), minWidth: 220, flex: 1.6, valueGetter: (params) => params.data?.tests.length ?? 0, cellRenderer: TestsCell, autoHeight: true, wrapText: true },
      { colId: 'final', headerName: t('production.col.final'), minWidth: 190, flex: 1.2, valueGetter: (params) => params.data?.finalInspection?.number ?? '', cellRenderer: FinalCell, autoHeight: true },
      { colId: 'state', headerName: t('production.col.state'), minWidth: 190, flex: 1.2, valueGetter: (params) => (params.data ? t(`batchState.${params.data.evidence.state}`) : ''), cellRenderer: StateCell, autoHeight: true },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, day, prefix, model.can.workOrders, model.can.inspections, held, actions])

  const head = (
    <SectionHead id="fw-tf-production" title={t('production.title')} note={t('production.note')}>
      <Button size="sm" heldReason={held ? t(held) : null} onClick={() => actions?.onRecord?.(null)}>
        <ClipboardCheck size={13} aria-hidden /> {t('production.record')}
      </Button>
      <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onSchedule?.(null)}>
        <CalendarPlus size={13} aria-hidden /> {t('production.schedule')}
      </Button>
    </SectionHead>
  )
  if (model.production === null || model.production.status === 'loading')
    return (
      <div className="fw-tf-tab">
        {head}
        <SectionLoading rows={5} />
      </div>
    )
  if (model.production.status === 'error')
    return (
      <div className="fw-tf-tab">
        {head}
        <SectionFailed title={t('production.failed')} problem={model.production.problem} onRetry={() => actions?.onRetry?.('production')} />
      </div>
    )
  const value = model.production.value
  const due = value.tests.filter((test) => test.result === null)
  return (
    <div className="fw-tf-tab">
      {head}
      <p className="fw-tf-muted">{t('production.summary', { made: value.summary.made, withEvidence: value.summary.withEvidence, missing: value.summary.missing, failed: value.summary.failed, inProgress: value.summary.inProgress })}</p>
      {value.summary.failed > 0 && <Banner tone="danger" title={t('production.failedBanner', { count: value.summary.failed })} />}
      <ListFrame<Batch>
        label={t('production.title')}
        listKey={null}
        rows={value.batches}
        rowId={(row) => row.workOrder.id}
        columns={columns}
        count={t('production.count', { count: value.batches.length })}
        state={value.batches.length === 0 ? <EmptyState icon={<ClipboardCheck size={22} aria-hidden />} title={t('production.emptyTitle')} description={t('production.empty')} /> : undefined}
        cards={{ fields: { order: { role: 'title' }, state: { role: 'aside' }, tests: { role: 'subtitle' } } }}
      />

      <SectionHead id="fw-tf-plan" title={t('plan.title')} note={t('plan.note')} />
      <Card padded>
        {value.plan.length === 0 ? (
          <EmptyState title={t('plan.emptyTitle')} description={t('plan.empty')} />
        ) : (
          <SummaryTable
            label={t('plan.title')}
            density="roomy"
            stackOnPhone
            columns={[t('plan.col.test'), t('plan.col.frequency'), t('plan.col.last'), t('plan.col.next'), t('plan.col.state'), '']}
            rows={value.plan.map((entry, index) => ({
              id: `${entry.test}-${entry.testName ?? ''}-${entry.frequency}-${index}`,
              cells: [
                entry.testName ? t('tests.kindNamed', { kind: t(`testKind.${entry.test}`), name: entry.testName }) : t(`testKind.${entry.test}`),
                t(`frequency.${entry.frequency}`),
                entry.lastTestedOn ? `${day(entry.lastTestedOn)}${entry.lastResult ? ` · ${t(`result.${entry.lastResult}`)}` : ''}` : t('plan.never'),
                entry.nextDueOn ? (
                  <span className="fw-tf-cell" key="next">
                    <span>{day(entry.nextDueOn)}</span>
                    <span className="fw-tf-muted">
                      {daysUntil(entry.nextDueOn, model.today) < 0 ? t('plan.overdueDays', { count: -daysUntil(entry.nextDueOn, model.today) }) : <Countdown to={dueInstant(entry.nextDueOn)} announce={false} doneLabel={t('plan.dueNow')} label={(left) => t('plan.dueIn', { left })} />}
                    </span>
                  </span>
                ) : (
                  t(entry.frequency === 'EVERY_BATCH' ? 'plan.everyBatch' : entry.frequency === 'ON_CHANGE' ? 'plan.onChange' : 'plan.none')
                ),
                <StatePill key="state" group="planState" state={entry.state} tone={PLAN_TONE[entry.state]} />,
                entry.dueTestId ? (
                  <Button key="act" size="sm" heldReason={held ? t(held) : null} onClick={() => actions?.onRecord?.(entry.dueTestId)}>
                    {t('plan.recordNow')}
                  </Button>
                ) : (
                  <Button key="act" size="sm" variant="quiet" heldReason={held ? t(held) : null} onClick={() => actions?.onSchedule?.(null)}>
                    {t('plan.scheduleNext')}
                  </Button>
                ),
              ],
            }))}
          />
        )}
      </Card>

      {due.length > 0 && (
        <>
          <SectionHead id="fw-tf-due" title={t('due.title', { count: due.length })} note={t('due.note')} />
          <Card padded>
            <SummaryTable
              label={t('due.title', { count: due.length })}
              density="roomy"
              stackOnPhone
              columns={[t('due.col.test'), t('due.col.batch'), t('due.col.dueOn'), t('due.col.clause'), '']}
              rows={due.map((test) => ({
                id: test.id,
                cells: [
                  test.testName ? t('tests.kindNamed', { kind: t(`testKind.${test.test}`), name: test.testName }) : t(`testKind.${test.test}`),
                  test.workOrder ? `${test.workOrder.number}${test.batchNumber ? ` · ${test.batchNumber}` : ''}` : (test.batchNumber ?? t('due.styleWide')),
                  <span key="due" className={test.overdue ? 'fw-tf-danger-text' : undefined}>
                    {day(test.dueOn)}
                    {test.overdue ? ` · ${t('due.overdue')}` : ''}
                  </span>,
                  test.standardClause ?? '—',
                  <span key="act" className="fw-tf-row-tight">
                    <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onRecord?.(test.id)}>
                      {t('due.record')}
                    </Button>
                    <Button size="sm" variant="quiet" heldReason={held ? t(held) : null} onClick={() => actions?.onRemoveTest?.(test.id)}>
                      {t('due.remove')}
                    </Button>
                  </span>,
                ],
              }))}
            />
          </Card>
        </>
      )}
    </div>
  )
}

/** Schedule test (what, how often, when, for which batch) or Record test (result, day, lab, report number, the lab report). */
export function TestDialogView({ model, state, actions }: { model: RecordModel; state: TestDialog; actions?: RecordActions | undefined }) {
  const t = useWords()
  const production = valueOf(model.production)
  const close = () => actions?.onTestClose?.()
  const planned = state.testId ? production?.tests.find((test) => test.id === state.testId) ?? null : null
  const recording = state.kind === 'record'
  const problems = recording ? [...recordProblems(state.record, model.today), ...(planned ? [] : scheduleProblems(state.schedule))] : scheduleProblems(state.schedule)
  const held = !model.online ? t('held.offline') : problems[0] ? t(problems[0]) : null
  const schedule = (patch: Partial<TestDialog['schedule']>) => actions?.onTestDraft?.({ schedule: patch })
  const record = (patch: Partial<TestDialog['record']>) => actions?.onTestDraft?.({ record: patch })
  const batches = production?.batches ?? []
  return (
    <Modal
      open
      onClose={close}
      title={recording ? (planned ? t('testDialog.recordPlanned', { test: planned.testName ?? t(`testKind.${planned.test}`) }) : t('testDialog.recordTitle')) : t('testDialog.scheduleTitle')}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={state.writing.busy} heldReason={held} onClick={() => actions?.onTestSave?.()}>
            {t(recording ? 'testDialog.recordDo' : 'testDialog.scheduleDo')}
          </Button>
        </>
      }
    >
      <div className="fw-tf-form">
        <NoticeBanner notice={state.writing.problem} />
        {!planned && (
          <div className="fw-tf-grid2">
            <Field label={t('testDialog.test')} required>
              <Select size="sm" value={state.schedule.test} onChange={(event) => schedule({ test: event.target.value as TestKind })}>
                {TEST_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`testKind.${kind}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('testDialog.testName')} required={state.schedule.test === 'OTHER'} hint={t('testDialog.testNameHint')}>
              <Input size="sm" value={state.schedule.testName} maxLength={200} onChange={(event) => schedule({ testName: event.target.value })} />
            </Field>
            <Field label={t('testDialog.frequency')} required>
              <Select size="sm" value={state.schedule.frequency} onChange={(event) => schedule({ frequency: event.target.value as TestDialog['schedule']['frequency'] })}>
                {FREQUENCIES.map((frequency) => (
                  <option key={frequency} value={frequency}>
                    {t(`frequency.${frequency}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {!recording && (
              <Field label={t('testDialog.dueOn')} required>
                <DateField value={state.schedule.dueOn} onChange={(value) => schedule({ dueOn: value })} />
              </Field>
            )}
            <Field label={t('testDialog.batch')} hint={t('testDialog.batchHint')}>
              <Select size="sm" value={state.schedule.workOrderId ?? ''} onChange={(event) => schedule({ workOrderId: event.target.value || null })}>
                <option value="">{t('testDialog.styleWide')}</option>
                {batches.map((batch) => (
                  <option key={batch.workOrder.id} value={batch.workOrder.id}>
                    {batch.workOrder.batchNumber ? `${batch.workOrder.number} · ${batch.workOrder.batchNumber}` : batch.workOrder.number}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('testDialog.clause')} hint={t('testDialog.clauseHint')}>
              <Input size="sm" value={state.schedule.standardClause} maxLength={100} onChange={(event) => schedule({ standardClause: event.target.value })} />
            </Field>
            <Field label={t('testDialog.sample')}>
              <Input size="sm" value={state.schedule.sample} maxLength={500} onChange={(event) => schedule({ sample: event.target.value })} />
            </Field>
          </div>
        )}
        {recording && (
          <>
            <div className="fw-tf-grid2">
              <Field label={t('testDialog.result')} required>
                <SegmentedControl ariaLabel={t('testDialog.result')} size="sm" value={state.record.result ?? ''} onChange={(value) => record({ result: value as TestDialog['record']['result'] })} options={TEST_RESULTS.map((result) => ({ value: result, label: t(`result.${result}`) }))} />
              </Field>
              <Field label={t('testDialog.testedOn')} required>
                <DateField value={state.record.testedOn} max={model.today} onChange={(value) => record({ testedOn: value })} />
              </Field>
              <Field label={t('testDialog.testedBy')} required hint={t('testDialog.testedByHint')}>
                <Input size="sm" value={state.record.testedBy} maxLength={200} onChange={(event) => record({ testedBy: event.target.value })} />
              </Field>
              <Field label={t('testDialog.reportNumber')}>
                <Input size="sm" value={state.record.reportNumber} maxLength={100} onChange={(event) => record({ reportNumber: event.target.value })} />
              </Field>
            </div>
            <Field label={t('testDialog.resultNote')}>
              <Textarea rows={2} value={state.record.resultNote} maxLength={2000} onChange={(event) => record({ resultNote: event.target.value })} />
            </Field>
            <Field label={t('testDialog.labReport')} hint={model.can.filesUpload ? t('testDialog.labReportHint') : t('held.filesUpload')}>
              <FileDropzone accept={LAB_REPORT_TYPES.join(',')} maxBytes={20 * 1024 * 1024} disabled={!model.can.filesUpload} onFiles={(files) => actions?.onTestFile?.(files[0] ?? null)} />
            </Field>
            {state.record.file && <p className="fw-tf-muted">{t('testDialog.chosen', { name: state.record.file.name })}</p>}
            <p className="fw-tf-muted">{t('testDialog.kept')}</p>
          </>
        )}
      </div>
    </Modal>
  )
}
