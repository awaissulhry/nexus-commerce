'use client'

import Link from 'next/link'
import { CheckCheck, Wrench, X } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, SegmentedControl, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { CALL_LIMITS } from '@nexus/factory-domain/production/calls/rules'
import { useLocale } from '../../../../lib/i18n/provider'
import { cancelHeld, jobDraftHeld, RESOLUTIONS, solveHeld, type JobDraft, type Resolution } from '../model'
import type { CallDialog, CallsActions, CallsModel } from './CallsView'
import { say, useCallsT } from './parts'

/**
 * The page's dialogs (design production.calls: D "done with a resolution code", Cancel, "a machine call → Open a
 * maintenance job (plant.jobs)"): Solve one call or N selected (one resolution code and words for each; the calls a
 * write refused are said with why), Cancel a call (the reason is kept in the audit log), Open a maintenance job (the
 * machine at the call's station, priority, the problem in words; the job is then linked as what the call led to). Each
 * held with its reason; the server's refusal in words inside the dialog.
 */
export function CallDialogs({ model, actions }: { model: CallsModel; actions?: CallsActions }) {
  const dialog = model.dialog
  if (!dialog || dialog.kind === 'keys') return null
  if (dialog.kind === 'solve') return <SolveDialog model={model} dialog={dialog} actions={actions} />
  if (dialog.kind === 'cancel') return <CancelDialog model={model} dialog={dialog} actions={actions} />
  return <JobDialog model={model} dialog={dialog} actions={actions} />
}

function SolveDialog({ model, dialog, actions }: { model: CallsModel; dialog: Extract<CallDialog, { kind: 'solve' }>; actions?: CallsActions }) {
  const t = useCallsT()
  const held = solveHeld(dialog.draft, model.busy)
  const set = (draft: Partial<typeof dialog.draft>) => actions?.onDialog?.({ ...dialog, draft: { ...dialog.draft, ...draft }, problem: null })
  const count = dialog.ids.length
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={count === 1 ? t('solve.title') : t('solve.titleN', { count })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onSolve?.()}>
            {model.busy ? <Spinner size={13} /> : <CheckCheck size={14} aria-hidden />} {count === 1 ? t('solve.do') : t('solve.doN', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-cl-form">
        <p className="fw-cl-text">{count === 1 ? t('solve.body') : t('solve.bodyN', { count })}</p>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem)} />}
        <Field label={t('solve.code')} hint={t('solve.codeHint')}>
          <Select value={dialog.draft.code} disabled={model.busy} onChange={(event) => set({ code: event.target.value as Resolution | '' })}>
            <option value="">{t('solve.noCode')}</option>
            {RESOLUTIONS.map((code) => (
              <option key={code} value={code}>
                {t(`resolution.${code}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('solve.note')} hint={t('solve.noteHint')}>
          <Textarea rows={3} value={dialog.draft.note} limit={CALL_LIMITS.resolutionNote} disabled={model.busy} onChange={(event) => set({ note: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

function CancelDialog({ model, dialog, actions }: { model: CallsModel; dialog: Extract<CallDialog, { kind: 'cancel' }>; actions?: CallsActions }) {
  const t = useCallsT()
  const held = cancelHeld(dialog.reason, model.busy)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('cancel.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={held ? t(held) : null} onClick={() => actions?.onCancel?.()}>
            {model.busy ? <Spinner size={13} /> : <X size={14} aria-hidden />} {t('cancel.do')}
          </Button>
        </>
      }
    >
      <div className="fw-cl-form">
        <p className="fw-cl-text">{t('cancel.body')}</p>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem)} />}
        <Field label={t('cancel.reason')} required hint={t('cancel.reasonHint')}>
          <Textarea rows={3} value={dialog.reason} limit={CALL_LIMITS.reason} disabled={model.busy} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value, problem: null })} />
        </Field>
      </div>
    </Modal>
  )
}

function JobDialog({ model, dialog, actions }: { model: CallsModel; dialog: Extract<CallDialog, { kind: 'job' }>; actions?: CallsActions }) {
  const t = useCallsT()
  const locale = useLocale()
  const held = dialog.machines.status === 'ready' ? jobDraftHeld(dialog.draft, model.busy) : dialog.machines.status === 'loading' ? 'held.loading' : 'held.machine'
  const set = (draft: Partial<JobDraft>) => actions?.onDialog?.({ ...dialog, draft: { ...dialog.draft, ...draft }, problem: null })
  const machines = dialog.machines
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('job.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onJob?.()}>
            {model.busy ? <Spinner size={13} /> : <Wrench size={14} aria-hidden />} {t('job.do')}
          </Button>
        </>
      }
    >
      <div className="fw-cl-form">
        <p className="fw-cl-text">{t('job.body')}</p>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem)} />}
        <Field label={t('job.machine')} required>
          {machines.status === 'loading' ? (
            <Skeleton height={32} />
          ) : machines.status === 'error' ? (
            <p className="fw-cl-hint">{t(machines.problem)}</p>
          ) : machines.value.length === 0 ? (
            <p className="fw-cl-hint">
              {t('job.noMachine')}{' '}
              <Link className="fw-cl-link" href={`${model.prefix}/plant/jobs?new=1`}>
                {t('job.toPlant')}
              </Link>
            </p>
          ) : (
            <Select value={dialog.draft.machineId} disabled={model.busy} onChange={(event) => set({ machineId: event.target.value })}>
              <option value="" disabled>
                {t('job.pickMachine')}
              </option>
              {machines.value.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {t('job.machineOption', { asset: machine.assetNumber, kind: locale === 'it' ? machine.class.labelIt : machine.class.labelEn, status: t(`machine.${machine.status}`) })}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('job.priority')}>
          <SegmentedControl size="sm" ariaLabel={t('job.priority')} value={dialog.draft.priority} onChange={(value) => set({ priority: value as JobDraft['priority'] })} options={(['P1', 'P2', 'P3'] as const).map((priority) => ({ value: priority, label: t(`job.${priority}`) }))} />
        </Field>
        <Field label={t('job.problem')} required hint={t('job.problemHint')}>
          <Textarea rows={3} value={dialog.draft.problem} limit={2000} disabled={model.busy} onChange={(event) => set({ problem: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
