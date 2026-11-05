'use client'

import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Checkbox, Input, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { Combobox, DateField, FileDropzone, FileRow, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { REPORT_ACCEPT, REPORT_MAX_BYTES, type CheckPlan, type CheckResult } from '../api'
import { atField, CHECK_OUTCOMES, machineText, nextDueOf, offersJob, offersLock, resultHeld, typeLabel, withOutcome, type ResultDraft } from '../model'
import type { PreventivePageActions, PreventivePageModel, ResultNewState } from '../view-model'
import { CheckLaw, intervalText, problemText, useDay, useWords } from './parts'

/** The law of the lock (Owner answer H1; D.Lgs. 81/2008 art. 71: equipment kept safe; only a technician signs it safe). */
export const LOCK_LAW = 'D.Lgs. 81/2008 art. 71'

/**
 * Record a check result (design pop:result; band primary `r`, a plan's Record result, a result's Correct): date ·
 * outcome · remarks · who did it · the report upload · next due; a failed check offers "Make a job" (ticked) and "Lock as
 * unsafe" in the same step (a check with remarks offers the job). The lock is hidden when the machine is locked already
 * (it stays do-not-use until a technician signs it safe); each offer missing its right is held and says which. The report
 * files go once the result is saved (they are a file of the result; the result itself never changes). Esc closes.
 */
export function ResultDialog({ model, state, actions }: { model: PreventivePageModel; state: ResultNewState; actions?: PreventivePageActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const day = useDay()
  const ds = useDsWords()
  const { draft, problem } = state
  const plan: CheckPlan | null = state.plan?.status === 'ready' ? state.plan.value : null
  const corrects: CheckResult | null = state.corrects?.status === 'ready' ? state.corrects.value : null
  const machines = state.machines?.status === 'ready' ? state.machines.value : []
  const picked = machines.find((entry) => entry.id === draft.machineId) ?? null
  const types = state.types?.status === 'ready' ? state.types.value : []
  const machineLocked = plan?.machine.locked ?? picked?.locked ?? false
  const planId = plan?.id ?? (state.plan ? 'reading' : null)
  const context = { planId, correctsId: corrects?.id ?? (state.corrects ? 'reading' : null), machineLocked, can: model.can }
  const reading = state.plan?.status === 'loading' || state.corrects?.status === 'loading'
  const held = reading ? 'held.reading' : resultHeld(draft, context, model.today, state.busy || state.uploading)
  const set = (change: Partial<ResultDraft>) => actions?.onResultDraft?.({ ...draft, ...change })
  const error = (...fields: string[]) => {
    const key = atField(problem, ...fields)
    return key ? t(key) : undefined
  }
  const nextDue = nextDueOf(draft, plan)
  const close = () => actions?.onAddress?.({ record: null, corrects: null })
  const subject = plan ?? corrects
  const readFailed = state.plan?.status === 'error' ? state.plan.problem : state.corrects?.status === 'error' ? state.corrects.problem : null

  return (
    <Modal
      open
      onClose={close}
      title={corrects || state.corrects ? t('result.correctTitle') : t('result.title')}
      subtitle={subject ? `${typeLabel(subject.checkType, locale)} · ${machineText(subject.machine)}` : t('result.pickSubtitle')}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onSaveResult?.()}>
            {state.busy || state.uploading ? <Spinner size={14} /> : null} {state.uploading ? t('result.sending') : t('result.save')}
          </Button>
        </>
      }
    >
      <div className="fw-pv-form">
        {readFailed && <Banner tone="danger" title={t(readFailed)} />}
        {subject && (
          <div className="fw-pv-row">
            <CheckLaw type={subject.checkType} say={t} />
            {plan && <span className="fw-pv-muted">{t('result.planFacts', { interval: intervalText(t, plan.interval, plan.intervalUnit), date: day(plan.nextDueOn) })}</span>}
          </div>
        )}
        {corrects && (
          <Banner tone="info" title={t('result.corrects', { date: day(corrects.performedOn), outcome: t(`outcome.${corrects.outcome}`) })}>
            {t('result.correctsBody')}
          </Banner>
        )}
        {!state.plan && !state.corrects && (
          <div className="fw-pv-form-row">
            <Field label={t('plan.machine')} required hint={state.machines?.status === 'loading' ? t('common.reading') : state.machines?.status === 'error' ? t(state.machines.problem) : t('result.machineHint')} error={error('machineId')}>
              <Combobox value={draft.machineId} placeholder={t('plan.machinePlaceholder')} options={machines.map((entry) => ({ value: entry.id, label: machineText(entry) }))} onChange={(machineId) => actions?.onPickResultMachine?.(machineId)} />
            </Field>
            <Field label={t('plan.type')} required hint={!picked ? t('plan.typeFirst') : state.types?.status === 'loading' ? t('common.reading') : t('result.typeHint')} error={error('checkTypeId')}>
              <Select value={draft.checkTypeId} disabled={!picked || state.types?.status !== 'ready'} onChange={(event) => set({ checkTypeId: event.target.value })}>
                <option value="">{t('plan.typePick')}</option>
                {types.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {typeLabel(entry, locale)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <div className="fw-pv-form-row">
          <Field label={t('result.date')} required hint={t('result.dateHint')} error={error('performedOn')}>
            <DateField value={draft.performedOn} onChange={(performedOn) => set({ performedOn })} ariaLabel={t('result.date')} />
          </Field>
          <Field label={t('result.by')} required hint={t('result.byHint')} error={error('performedBy')}>
            <Input value={draft.performedBy} maxLength={200} onChange={(event) => set({ performedBy: event.target.value })} />
          </Field>
        </div>
        <fieldset className="fw-pv-fieldset">
          <legend className="fw-pv-h3">{t('result.outcome')}</legend>
          <div className="fw-pv-outcomes">
            {CHECK_OUTCOMES.map((outcome) => (
              <RadioCard key={outcome} name="fw-pv-outcome" value={outcome} checked={draft.outcome === outcome} selected={draft.outcome === outcome} onChange={() => actions?.onResultDraft?.(withOutcome(draft, outcome))} title={t(`outcome.${outcome}`)} description={t(`outcomeHint.${outcome}`)} />
            ))}
          </div>
        </fieldset>
        <Field label={t('result.remarks')} required={draft.outcome !== '' && draft.outcome !== 'PASSED'} hint={draft.outcome === 'FAILED' ? t('result.remarksFailed') : t('result.remarksHint')} error={error('remarks')}>
          <Textarea value={draft.remarks} rows={3} onChange={(event) => set({ remarks: event.target.value })} />
        </Field>
        {(offersJob(draft.outcome) || offersLock(draft.outcome)) && (
          <fieldset className="fw-pv-fieldset">
            <legend className="fw-pv-h3">{t('result.sameStep')}</legend>
            {offersJob(draft.outcome) && (
              <>
                <Checkbox checked={draft.makeJob} disabled={!model.can.makeJob} onChange={(event) => set({ makeJob: event.target.checked })} label={t('result.makeJob')} />
                <p className="fw-pv-muted">{model.can.makeJob ? t(draft.outcome === 'FAILED' ? 'result.makeJobFailed' : 'result.makeJobRemarks') : t('held.jobRight')}</p>
              </>
            )}
            {offersLock(draft.outcome) &&
              (machineLocked ? (
                <p className="fw-pv-warn">{t('result.lockedAlready')}</p>
              ) : (
                <>
                  <Checkbox checked={draft.lock} disabled={!model.can.lock} onChange={(event) => set({ lock: event.target.checked })} label={t('result.lock')} />
                  {model.can.lock ? (
                    <div className="fw-pv-stack">
                      <ul className="fw-pv-list fw-pv-muted">
                        <li>{t('lock.reach')}</li>
                        <li>{t('lock.reversal')}</li>
                      </ul>
                      <LawRef law={LOCK_LAW} plain={t('lock.law')} labels={ds.lawRef} />
                      {draft.lock && (
                        <Field label={t('lock.note')} hint={t('lock.noteHint')}>
                          <Input value={draft.lockNote} maxLength={500} onChange={(event) => set({ lockNote: event.target.value })} />
                        </Field>
                      )}
                    </div>
                  ) : (
                    <p className="fw-pv-muted">{t('held.lockRight')}</p>
                  )}
                </>
              ))}
          </fieldset>
        )}
        <Field label={t('result.nextDue')} hint={nextDue ? t('result.nextDueHint', { date: day(nextDue) }) : t('result.nextDueNone')} error={error('nextDueOn')}>
          <DateField value={draft.nextDueOn} onChange={(nextDueOn) => set({ nextDueOn })} ariaLabel={t('result.nextDue')} />
        </Field>
        {(corrects || state.corrects) && (
          <Field label={t('result.correctionReason')} required error={error('correctionReason')}>
            <Textarea value={draft.correctionReason} rows={2} onChange={(event) => set({ correctionReason: event.target.value })} />
          </Field>
        )}
        <section className="fw-pv-stack" aria-labelledby="fw-pv-report-pick">
          <h3 id="fw-pv-report-pick" className="fw-pv-h3">
            {t('result.report')}
          </h3>
          {draft.files.map((file, index) => (
            <FileRow key={`${file.name}-${index}`} name={file.name} size={file.size} status={t('result.reportAfter')} onRemove={() => set({ files: draft.files.filter((_, at) => at !== index) })} disabled={state.busy || state.uploading} />
          ))}
          <FileDropzone onFiles={(files) => set({ files: [...draft.files, ...files] })} accept={REPORT_ACCEPT} maxBytes={REPORT_MAX_BYTES} multiple disabled={state.busy || state.uploading} hint={t('result.reportHint')} />
        </section>
        {plan === null && corrects === null && !state.plan && !state.corrects && draft.machineId && draft.checkTypeId && <p className="fw-pv-muted">{t('result.planAuto')}</p>}
        {problem && !problem.field && <Banner tone="danger" title={problemText(t, problem)}>{problem.unknown ? t('problem.unknownHint') : null}</Banner>}
        {state.uploading && (
          <KeyValue labelCase="sentence" items={[{ label: t('result.report'), value: t('result.sending') }]} />
        )}
      </div>
    </Modal>
  )
}
