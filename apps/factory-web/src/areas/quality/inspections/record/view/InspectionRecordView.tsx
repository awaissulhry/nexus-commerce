'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { ExternalLink, MoreHorizontal, PenLine, Undo2 } from 'lucide-react'
import { Banner, EmptyState, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { Button, Input, Pill, SegmentedControl, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { StepUpState } from '../../../_shared/hooks'
import { evidenceAddress } from '../../../_shared/model'
import { dash, Facts, NoticeBanner, QualityMessages, RecordFrame, Section, StepUpDialog } from '../../../_shared/parts'
import type { DefectBody, FinalCell, Inspection } from '../../api'
import { AssignDialog } from '../../view/AssignDialog'
import {
  assignedWords,
  checklistCounts,
  checklistGroups,
  dueState,
  recordAbilities,
  savedDefectIds,
  releaseHeld,
  releaseLabel,
  resultNow,
  reversedOf,
  secondPersonKeys,
  statusOf,
  whereKey,
  whoKey,
  type InspectionRecordModel,
  type PlanDraft,
  type RecordDialog,
  type RecordTab,
  type ReleaseDraft,
  type SignDraft,
} from '../../model'
import { CancelModal, PlanModal, ReleaseModal, resultReasons, SignModal } from './dialogs'
import { DefectsTab } from './DefectsTab'
import '../../inspections.css'

export interface InspectionRecordActions {
  onDialog?: (dialog: RecordDialog | null) => void
  onAnswer?: (code: string, change: { ok?: boolean | null; note?: string | null }) => void
  onSignDraft?: (draft: SignDraft) => void
  onSign?: () => void
  onReleaseDraft?: (draft: ReleaseDraft) => void
  onRelease?: () => void
  onPlanDraft?: (draft: PlanDraft) => void
  onSavePlan?: () => void
  // W2a (B-W2a-67): Defects & photos, Assign inspector, Place hold, Create NCR.
  onLines?: (lines: readonly DefectBody[]) => void
  onPhoto?: (index: number, photo: Blob) => void
  onRetryDefects?: () => void
  onDismissDefects?: () => void
  onAssign?: () => void
  onAssignValue?: (value: string) => void
  onAssignSave?: () => void
  onAssignClose?: () => void
  onPlaceHold?: () => void
  onRaiseNcr?: () => void
  /** B-W2b-17: the defect lines picked on Defects & photos, and "Create NCR from N defects" (their saved ids). */
  onPickDefects?: (keys: readonly string[]) => void
  onRaiseNcrFrom?: (defectIds: readonly string[]) => void
  onCancelReason?: (reason: string) => void
  onCancel?: () => void
  onReload?: () => void
  onRetryFinal?: () => void
  onDismissNotice?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}

const TAB_KEYS: Record<RecordTab, string> = { checks: 'record.tab.checks', defects: 'record.tab.defects', decision: 'record.tab.decision' }

/**
 * SCR-076 the inspection record (design quality.inspections "Inspection" record, 00 §2.2): the band (‹ Inspections, the
 * number and the work order, the state, the primary by state — Sign result while open, Release to ship once passed — and
 * ⋯ Evidence trail, Cancel, Copy), the link tabs Checks & results (the plan, the 12 checks answered per row with their save
 * state, the defects, and "Result now" with the rule in words and the maker check) and Decision & signature (the
 * result and its signature, who signs and why, the release per cell with the gate in words, this inspection's
 * releases). Fetches nothing: InspectionRecord.tsx reads and writes. Activity is absent: an inspection has no record
 * thread yet (the API's thread resolvers do not name it).
 */
export function InspectionRecordView({ model, actions, stepUp }: { model: InspectionRecordModel; actions?: InspectionRecordActions; stepUp?: StepUpState }) {
  return (
    <QualityMessages>
      <Record model={model} actions={actions} stepUp={stepUp} />
    </QualityMessages>
  )
}

function Record({ model, actions, stepUp }: { model: InspectionRecordModel; actions?: InspectionRecordActions; stepUp?: StepUpState }) {
  const t = useT('quality')
  const locale = useLocale()
  const { read, can } = model
  const inspection = read.inspection
  const abilities = recordAbilities(read, can)
  const dialog = model.dialog ?? null
  const open = (next: RecordDialog | null) => actions?.onDialog?.(next)
  const status = statusOf({ status: inspection.status, overridden: inspection.overridden, onHold: false, reversed: 0 })
  const base = `${model.prefix}/quality/inspections/${encodeURIComponent(inspection.id)}`
  const final = model.final.value
  const fromThis = final?.inspectionId === inspection.id
  const releasableCells = fromThis ? (final?.cells ?? []).filter((cell) => cell.releasable > 0) : []
  const evidence = evidenceAddress(model.prefix, { batch: read.workOrder.batchNumber })
  const releaseCell = dialog?.kind === 'release' ? (final?.cells.find((cell) => cell.workOrderSizeId === dialog.workOrderSizeId) ?? null) : null

  // s: Sign result (when it may be signed); the record's own keys skip fields, menus and dialogs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="radiogroup"]') || target.isContentEditable)) return
      if (event.key === 's' && !abilities.signHeld) {
        event.preventDefault()
        open({ kind: 'sign' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const primary =
    inspection.status === 'OPEN' ? (
      <Button size="sm" variant="primary" onClick={() => open({ kind: 'sign' })} heldReason={abilities.signHeld ? t(abilities.signHeld) : null}>
        <PenLine size={14} aria-hidden /> {t('record.sign')}
      </Button>
    ) : inspection.status === 'PASSED' && releasableCells.length > 0 ? (
      <Button size="sm" variant="primary" asChild>
        <Link href={`${base}?tab=decision`}>{t('record.releaseToShip')}</Link>
      </Button>
    ) : null
  const assignHeldKey = !can.inspectionsRecord ? 'assign.held.noRight' : inspection.status !== 'OPEN' ? 'assign.held.notOpen' : null
  const holdHeldKey = !can.holdsPlace ? 'held.noHoldPlace' : null
  const ncrHeldKey = !can.ncrRaise ? 'raiseNcr.held.noRight' : null
  const menu: MenuItemDef[] = [
    { id: 'assign', label: t('assign.menu'), onSelect: () => actions?.onAssign?.(), disabled: assignHeldKey !== null, description: assignHeldKey ? t(assignHeldKey) : undefined },
    { id: 'hold', label: t('row.placeHold'), onSelect: () => actions?.onPlaceHold?.(), disabled: holdHeldKey !== null, description: holdHeldKey ? t(holdHeldKey) : undefined },
    { id: 'ncr', label: t('row.createNcr'), onSelect: () => actions?.onRaiseNcr?.(), disabled: ncrHeldKey !== null, description: ncrHeldKey ? t(ncrHeldKey) : undefined },
    { id: 'sep0', separator: true },
    ...(evidence
      ? [{ id: 'evidence', label: t('record.evidence'), href: evidence, target: '_blank' as const, icon: <ExternalLink size={14} aria-hidden /> }]
      : [{ id: 'evidence-none', label: t('record.evidence'), disabled: true, description: t('held.noBatch') }]),
    { id: 'cancel', label: t('record.cancel'), onSelect: () => open({ kind: 'cancel' }), disabled: !!abilities.cancelHeld, description: abilities.cancelHeld ? t(abilities.cancelHeld) : undefined },
    { id: 'copy', label: t('row.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(inspection.label) },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => open({ kind: 'shortcuts' }) },
  ]
  const style = model.style?.value ?? null
  const meta = (
    <span className="fw-q-cell-row">
      <span className="fw-q-code">{read.workOrder.number}</span>
      {read.workOrder.batchNumber && <span className="fw-q-hint">· {t('record.batch', { batch: read.workOrder.batchNumber })}</span>}
      {style && <span className="fw-q-hint">· {style.code} {style.name}</span>}
      {inspection.status === 'OPEN' && <span className="fw-q-hint">· {t(assignedWords(inspection.assigned, model.me, true).key, assignedWords(inspection.assigned, model.me, true).params)}</span>}
      {/* B-W2b-17: by when it is due (overdue in words and in the danger tone). */}
      {inspection.dueAt && (inspection.status === 'OPEN' || inspection.overdue) && (
        <span className={dueState(inspection).tone === 'danger' ? 'fw-q-cell-row' : 'fw-q-hint'}>
          · {t(dueState(inspection).key, { at: formatDateTime(inspection.dueAt, { locale }) })}
          {dueState(inspection).tone === 'danger' && <Tag tone="danger">{t('due.overdueTag')}</Tag>}
        </span>
      )}
    </span>
  )

  return (
    <RecordFrame
      back={{ href: `${model.prefix}/quality/inspections`, label: t('record.back') }}
      title={t('record.title', { label: inspection.label })}
      meta={meta}
      status={
        <span className="fw-q-tags">
          <Pill tone={status.tone} dot>
            {t(status.key)}
          </Pill>
          {inspection.overridden && <Tag tone="warning">{t('record.overridden')}</Tag>}
        </span>
      }
      actions={
        <>
          {primary}
          <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('record.more') }} items={menu} />
        </>
      }
      tabs={(['checks', 'defects', 'decision'] as const).map((tab) => ({ id: tab, label: t(TAB_KEYS[tab]) }))}
      active={model.tab}
      tabHref={(tab) => `${base}?tab=${tab}`}
    >
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {model.stale && (
        <Banner
          tone="info"
          title={t('record.stale', { time: model.stale })}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('record.reload')}
            </Button>
          }
        />
      )}
      {inspection.status !== 'OPEN' && inspection.status !== 'CANCELLED' && inspection.decidedAt && (
        <Banner tone="neutral" title={t('record.locked', { where: t(whereKey(inspection.inspector, model.me)), date: formatDateTime(inspection.decidedAt, { locale }) })} />
      )}
      {inspection.status === 'CANCELLED' && <Banner tone="neutral" title={t('record.cancelledBanner')} />}
      {model.tab === 'checks' ? (
        <ChecksTab model={model} actions={actions} recordHeld={abilities.recordHeld} />
      ) : model.tab === 'defects' ? (
        <DefectsTab
          model={model.defects ?? { lines: [], saving: 'idle', library: { value: null, problem: null }, photos: { value: null, problem: null }, photoSrc: {} }}
          cells={final?.cells ?? []}
          sampleSize={inspection.plan.sampleSize}
          held={abilities.recordHeld}
          canRaise={can.ncrRaise}
          saved={savedDefectIds(inspection)}
          dialog={dialog?.kind === 'pick' || dialog?.kind === 'zone' || dialog?.kind === 'photo' ? dialog : null}
          actions={{
            onLines: actions?.onLines,
            onPhoto: actions?.onPhoto,
            onRetry: actions?.onRetryDefects,
            onDismiss: actions?.onDismissDefects,
            onRaiseNcr: () => actions?.onRaiseNcr?.(),
            onSelect: actions?.onPickDefects,
            onRaiseNcrFrom: actions?.onRaiseNcrFrom,
            onDialog: (next) => open(next),
          }}
        />
      ) : (
        <DecisionTab model={model} actions={actions} signHeld={abilities.signHeld} />
      )}

      <SignModal
        open={dialog?.kind === 'sign'}
        inspection={inspection}
        draft={model.signDraft ?? { result: resultNow(inspection).result, overrideReason: '', statement: inspection.notMakerStatement, note: '' }}
        statementNeeded={read.statementNeeded}
        busy={model.busy}
        problem={dialog?.kind === 'sign' ? model.dialogProblem : null}
        lines={model.dialogLines}
        onDraft={(draft) => actions?.onSignDraft?.(draft)}
        onSign={() => actions?.onSign?.()}
        onClose={() => open(null)}
      />
      <ReleaseModal
        open={dialog?.kind === 'release'}
        cell={releaseCell}
        draft={model.releaseDraft ?? { quantity: '', serialIds: [], note: '' }}
        overridden={inspection.overridden}
        canRelease={model.can.garmentsRelease}
        busy={model.busy}
        problem={dialog?.kind === 'release' ? model.dialogProblem : null}
        lines={model.dialogLines}
        onDraft={(draft) => actions?.onReleaseDraft?.(draft)}
        onRelease={() => actions?.onRelease?.()}
        onClose={() => open(null)}
      />
      <PlanModal
        open={dialog?.kind === 'plan'}
        draft={model.planDraft ?? { lotSize: '', sampleSize: '', inspectionLevel: '', aqlMajor: '', aqlMinor: '', acceptMajor: '', acceptMinor: '' }}
        busy={model.busy}
        problem={dialog?.kind === 'plan' ? model.dialogProblem : null}
        onDraft={(draft) => actions?.onPlanDraft?.(draft)}
        onSave={() => actions?.onSavePlan?.()}
        onClose={() => open(null)}
      />
      <CancelModal
        open={dialog?.kind === 'cancel'}
        reason={model.cancelReason ?? ''}
        busy={model.busy}
        problem={dialog?.kind === 'cancel' ? model.dialogProblem : null}
        onReason={(reason) => actions?.onCancelReason?.(reason)}
        onCancel={() => actions?.onCancel?.()}
        onClose={() => open(null)}
      />
      <AssignDialog state={model.assign ?? null} onValue={(value) => actions?.onAssignValue?.(value)} onSave={() => actions?.onAssignSave?.()} onClose={() => actions?.onAssignClose?.()} />
      {stepUp && <StepUpDialog state={stepUp} onSubmit={(code) => actions?.onStepUpSubmit?.(code)} onCancel={() => actions?.onStepUpCancel?.()} />}
      {dialog?.kind === 'shortcuts' && <RecordKeys onClose={() => open(null)} />}
    </RecordFrame>
  )
}

function RecordKeys({ onClose }: { onClose: () => void }) {
  const t = useT('quality')
  return (
    <Banner tone="info" title={t('keys.title')} onDismiss={onClose}>
      <ul className="fw-q-lines">
        <li>{t('keys.sign')}</li>
        <li>{t('keys.save')}</li>
        <li>{t('keys.tabs')}</li>
      </ul>
    </Banner>
  )
}

// ---- Checks & results -----------------------------------------------------------------------------------------------------------

function ChecksTab({ model, actions, recordHeld }: { model: InspectionRecordModel; actions?: InspectionRecordActions; recordHeld: string | null }) {
  const t = useT('quality')
  const inspection = model.read.inspection
  const rows = model.checklist
  const counts = checklistCounts(rows)
  const editable = recordHeld === null
  const computed = resultNow({ ...inspection, checklist: rows.filter((row) => row.answered).map((row) => ({ code: row.code, ok: row.ok, note: row.note })) })
  const reasons = resultReasons({ ...inspection, checklist: rows.filter((row) => row.answered) })
  const final = model.final.value
  return (
    <div className="fw-q-main-side">
      <div className="fw-q-stack">
        <Section
          id="plan"
          title={t('plan.heading')}
          sub={t('plan.sub')}
          actions={
            <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'plan' })} heldReason={recordHeld ? t(recordHeld) : null}>
              {t('plan.edit')}
            </Button>
          }
        >
          <Facts
            items={[
              { label: t('plan.lot'), value: inspection.plan.lotSize },
              { label: t('plan.sample'), value: inspection.plan.hundredPercent ? t('plan.hundred', { count: inspection.plan.sampleSize }) : inspection.plan.sampleSize },
              { label: t('plan.level'), value: inspection.plan.inspectionLevel },
              { label: t('plan.aqlMajor'), value: t('plan.aqlAccept', { aql: inspection.plan.aqlMajor, accept: inspection.plan.acceptMajor }) },
              { label: t('plan.aqlMinor'), value: t('plan.aqlAccept', { aql: inspection.plan.aqlMinor, accept: inspection.plan.acceptMinor }) },
            ]}
          />
        </Section>
        <Section id="checklist" title={t('checklist.heading')} sub={t('checklist.counts', { answered: counts.answered, total: counts.total, failed: counts.failed })}>
          {recordHeld && inspection.status === 'OPEN' && <p className="fw-q-hint">{t(recordHeld)}</p>}
          {checklistGroups(rows).map(({ group, rows: groupRows }) => (
            <div key={group}>
              <h3 className="fw-q-group-title">{t(`checklist.group.${group}`)}</h3>
              <ul className="fw-q-checkrows">
                {groupRows.map((row) => {
                  const value = !row.answered ? 'unset' : row.ok === true ? 'pass' : row.ok === false ? 'fail' : 'na'
                  const saving = model.saving?.[row.code]
                  return (
                    <li key={row.code} className="fw-q-checkrow">
                      <span className="fw-q-cell">
                        <span>{t(`checklist.item.${row.code}`)}</span>
                        {saving && (
                          <span className="fw-q-hint" role="status">
                            {saving === 'saving' ? (
                              <>
                                <Spinner size={10} /> {t('checklist.saving')}
                              </>
                            ) : (
                              t(`checklist.${saving}`)
                            )}
                          </span>
                        )}
                      </span>
                      {editable ? (
                        <SegmentedControl
                          size="sm"
                          ariaLabel={t('checklist.answerFor', { check: t(`checklist.item.${row.code}`) })}
                          value={value}
                          onChange={(next) => actions?.onAnswer?.(row.code, { ok: next === 'pass' ? true : next === 'fail' ? false : null })}
                          options={[
                            { value: 'pass', label: t('checklist.pass') },
                            { value: 'fail', label: t('checklist.fail') },
                            { value: 'na', label: t('checklist.na') },
                          ]}
                        />
                      ) : (
                        <Tag tone={value === 'pass' ? 'success' : value === 'fail' ? 'danger' : 'neutral'}>{t(`checklist.answer.${value}`)}</Tag>
                      )}
                      {editable && row.answered && row.ok === false ? (
                        <Input
                          size="sm"
                          aria-label={t('checklist.noteFor', { check: t(`checklist.item.${row.code}`) })}
                          placeholder={t('checklist.notePlaceholder')}
                          defaultValue={row.note ?? ''}
                          onBlur={(event) => {
                            if ((event.target.value.trim() || null) !== (row.note ?? null)) actions?.onAnswer?.(row.code, { note: event.target.value.trim() || null })
                          }}
                        />
                      ) : (
                        <span className="fw-q-hint">{row.note ?? ''}</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </Section>
        <Section
          id="defects"
          title={t('defects.heading')}
          sub={t('defects.counts', { critical: inspection.counts.critical, major: inspection.counts.major, minor: inspection.counts.minor })}
          actions={
            <Button size="sm" asChild>
              <Link href={`${model.prefix}/quality/inspections/${encodeURIComponent(inspection.id)}?tab=defects`}>{t('defects.openTab')}</Link>
            </Button>
          }
        >
          {inspection.defects.length === 0 ? (
            <p className="fw-q-hint">{t('defects.none')}</p>
          ) : (
            <SummaryTable
              label={t('defects.heading')}
              columns={[t('defects.classLabel'), t('defects.code'), t('defects.quantity'), t('defects.cell'), t('defects.note')]}
              rows={inspection.defects.map((defect) => {
                const cell = final?.cells.find((entry) => entry.workOrderSizeId === defect.workOrderSizeId)
                return {
                  id: defect.id,
                  cells: [
                    <Tag key="c" tone={defect.defectClass === 'CRITICAL' ? 'danger' : defect.defectClass === 'MAJOR' ? 'warning' : 'neutral'}>
                      {t(`defects.class.${defect.defectClass}`)}
                    </Tag>,
                    <span key="d" className="fw-q-code">
                      {defect.code}
                    </span>,
                    defect.quantity,
                    cell ? `${cell.colourwayCode} ${cell.size}` : '—',
                    dash(defect.note),
                  ],
                }
              })}
              align={[undefined, undefined, 'right']}
              stackOnPhone
            />
          )}
        </Section>
      </div>
      <Section id="now" title={t('result.heading')}>
        <Banner
          tone={inspection.status === 'OPEN' && counts.answered < counts.total ? (computed.result === 'FAIL' ? 'danger' : 'info') : computed.result === 'PASS' ? 'success' : 'danger'}
          title={
            inspection.status === 'OPEN' && counts.answered < counts.total
              ? t(computed.result === 'FAIL' ? 'result.incompleteFail' : 'result.incomplete', { count: counts.total - counts.answered })
              : t(inspection.status === 'OPEN' ? `result.computed.${computed.result}` : `result.decided.${inspection.status}`)
          }
        >
          {reasons.length === 0 ? (
            t('result.passWords')
          ) : (
            <ul className="fw-q-lines">
              {reasons.map((reason) => (
                <li key={reason.key}>{t(reason.key, reason.params)}</li>
              ))}
            </ul>
          )}
        </Banner>
        <p className="fw-q-hint">{t(model.read.maker.made ? 'result.makerYes' : 'result.makerNo')}</p>
        {model.read.statementNeeded && <p className="fw-q-hint">{t('result.statementNeeded')}</p>}
        {final && <CertificateLine cells={final.cells} />}
        {inspection.status === 'OPEN' && (
          <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.({ kind: 'sign' })} heldReason={recordAbilities(model.read, model.can).signHeld ? t(recordAbilities(model.read, model.can).signHeld!) : null}>
            {t('record.sign')}
          </Button>
        )}
      </Section>
    </div>
  )
}

/** The certificate gate in one line (its sentence for the first cell; every cell's on Decision). */
function CertificateLine({ cells }: { cells: readonly FinalCell[] }) {
  const t = useT('quality')
  const checks = cells.flatMap((cell) => cell.checks.filter((check) => check.code === 'CERTIFICATE'))
  if (checks.length === 0) return null
  const open = checks.filter((check) => check.state === 'OPEN').length
  return (
    <p className="fw-q-hint">
      {open === 0 ? t('result.certificateOk', { count: checks.length }) : t('result.certificateOpen', { count: open })} <span>{checks[0]!.message}</span>
    </p>
  )
}

// ---- Decision & signature ----------------------------------------------------------------------------------------------------------

function DecisionTab({ model, actions, signHeld }: { model: InspectionRecordModel; actions?: InspectionRecordActions; signHeld: string | null }) {
  const t = useT('quality')
  const locale = useLocale()
  const inspection: Inspection = model.read.inspection
  const final = model.final.value
  const fromThis = final?.inspectionId === inspection.id
  const newest = final?.inspections.find((entry) => entry.id === final.inspectionId) ?? null
  const ownReleases = (model.releases.value ?? []).filter((release) => release.inspectionId === inspection.id)
  const secondNeeded = inspection.overridden || (final?.cells.some((cell) => cell.secondPersonReasons.length > 0) ?? false)
  return (
    <div className="fw-q-stack">
      <div className="fw-q-two">
        <Section id="result" title={t('decision.result')}>
          {inspection.status === 'OPEN' ? (
            <>
              <p className="fw-q-hint">{t('decision.notSigned')}</p>
              <span>
                <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.({ kind: 'sign' })} heldReason={signHeld ? t(signHeld) : null}>
                  {t('record.sign')}
                </Button>
              </span>
            </>
          ) : inspection.status === 'CANCELLED' ? (
            <p className="fw-q-hint">{t('record.cancelledBanner')}</p>
          ) : (
            <Facts
              items={[
                { label: t('decision.decided'), value: t(`result.decided.${inspection.status}`) },
                { label: t('decision.computed'), value: t(`result.short.${inspection.computed.result}`) },
                { label: t('decision.override'), value: inspection.overridden ? dash(inspection.overrideReason) : t('decision.noOverride') },
                { label: t('decision.signedAt'), value: inspection.decidedAt ? formatDateTime(inspection.decidedAt, { locale }) : '—' },
                { label: t('decision.signature'), value: <span className="fw-q-code">{inspection.signatureSha256 ? `${inspection.signatureSha256.slice(0, 16)}…` : '—'}</span> },
              ]}
            />
          )}
        </Section>
        <Section id="who" title={t('decision.who')}>
          <ol className="fw-q-lines fw-q-steps">
            <li>
              {inspection.status === 'OPEN'
                ? t('decision.step1Waiting')
                : inspection.decidedAt
                  ? t('decision.step1Done', { where: t(whereKey(inspection.inspector, model.me)), method: t(inspection.inspector.kind === 'FLOOR' ? 'decision.pin' : 'decision.code'), date: formatDateTime(inspection.decidedAt, { locale }) })
                  : t('decision.step1None')}
            </li>
            <li>{secondNeeded ? t('decision.step2Second') : t('decision.step2Alone')}</li>
          </ol>
          {inspection.overridden && <p className="fw-q-hint">{t('secondPerson.OVERRIDE')}</p>}
          <p className="fw-q-hint">{t(model.read.maker.made ? 'result.makerYes' : 'result.makerNo')}</p>
          {final && <p className="fw-q-hint">{t('decision.ruleNow', { rule: t(`rules.rule.${final.rule.rule}`) })}</p>}
        </Section>
      </div>

      <Section id="release" title={t('decision.release')} sub={inspection.status === 'PASSED' ? t('decision.releaseSub') : undefined}>
        {model.final.problem ? (
          <EmptyState
            title={t('decision.finalFailed')}
            description={t(model.final.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetryFinal?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : final === null ? (
          <p className="fw-q-loading" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        ) : inspection.status === 'OPEN' ? (
          <p className="fw-q-hint">{t('decision.releaseAfterSign')}</p>
        ) : inspection.status === 'FAILED' ? (
          <p className="fw-q-hint">{t('decision.failedNoRelease')}</p>
        ) : inspection.status === 'CANCELLED' ? (
          <p className="fw-q-hint">{t('record.cancelledBanner')}</p>
        ) : !fromThis ? (
          <p className="fw-q-hint">
            {t('decision.notNewest')}{' '}
            {newest && (
              <Link className="fw-q-link" href={`${model.prefix}/quality/inspections/${encodeURIComponent(newest.id)}?tab=decision`}>
                {newest.label}
              </Link>
            )}
          </p>
        ) : (
          <SummaryTable
            label={t('decision.release')}
            columns={[t('decision.cell'), t('decision.pieces'), t('decision.released'), t('decision.releasable'), t('decision.gate'), '']}
            rows={final.cells.map((cell) => {
              const held = releaseHeld(cell, model.can)
              const open = cell.checks.filter((check) => check.state === 'OPEN' && check.code !== 'QUANTITY').length
              return {
                id: cell.workOrderSizeId,
                cells: [
                  `${cell.colourwayCode} ${cell.size}`,
                  cell.pieces,
                  cell.released,
                  cell.releasable,
                  open > 0 ? (
                    <Tag key="g" tone="warning">
                      {t('decision.gateOpen', { count: open })}
                    </Tag>
                  ) : cell.releasable === 0 ? (
                    <Tag key="g" tone="neutral">
                      {t('decision.gateDone')}
                    </Tag>
                  ) : (
                    <Tag key="g" tone="success">
                      {t('decision.gateReady')}
                    </Tag>
                  ),
                  cell.releasable > 0 || open > 0 ? (
                    <Button key="r" size="sm" onClick={() => actions?.onDialog?.({ kind: 'release', workOrderSizeId: cell.workOrderSizeId })}>
                      {held === null ? t('decision.releaseCell') : t('decision.seeGate')}
                    </Button>
                  ) : (
                    <span key="r" className="fw-q-hint">
                      {t('decision.nothingLeft')}
                    </span>
                  ),
                ],
              }
            })}
            align={[undefined, 'right', 'right', 'right']}
            stackOnPhone
          />
        )}
      </Section>

      <Section id="releases" title={t('decision.releases')} sub={t('decision.releasesSub')}>
        {model.releases.problem ? (
          <p className="fw-q-hint">{t(model.releases.problem)}</p>
        ) : model.releases.value === null ? (
          <p className="fw-q-loading" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        ) : ownReleases.length === 0 ? (
          <p className="fw-q-hint">{t('decision.noReleases')}</p>
        ) : (
          <SummaryTable
            label={t('decision.releases')}
            columns={[t('col.release'), t('decision.garments'), t('col.takenBack'), t('col.releasedBy'), t('decision.at'), '']}
            rows={ownReleases.map((release) => {
              const label = releaseLabel(release)
              const by = whoKey(release.releasedBy, model.me)
              return {
                id: release.id,
                cells: [
                  <span key="n" className="fw-q-code">
                    {t(label.key, label.params)}
                  </span>,
                  release.quantity,
                  reversedOf(release) > 0 ? (
                    <span key="b" className="fw-q-cell-row">
                      <Undo2 size={12} aria-hidden /> {reversedOf(release)}
                    </span>
                  ) : (
                    0
                  ),
                  t(by.key),
                  formatDateTime(release.releasedAt, { locale }),
                  <Link key="o" className="fw-q-link" href={`${model.prefix}/quality/inspections?open=${encodeURIComponent(release.id)}`}>
                    {t('decision.openRelease')}
                  </Link>,
                ],
              }
            })}
            align={[undefined, 'right', 'right']}
            stackOnPhone
          />
        )}
        {ownReleases.some((release) => release.secondPerson.reasons.length > 0) && (
          <ul className="fw-q-lines">
            {[...new Set(ownReleases.flatMap((release) => secondPersonKeys(release.secondPerson.reasons)))].map((key) => (
              <li key={key} className="fw-q-hint">
                {t(key)}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
