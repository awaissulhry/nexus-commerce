'use client'

import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { SignBlock } from '@nexus/ui/components/SignBlock/index'
import { Button, Input, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { DateField, FileDropzone, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { AssessmentRecord } from '../../api'
import { atField, isDay, LIMITS, paperHeld, tooFar, versionNo } from '../../model'
import type { EditAssessmentState, RiskRecordActions, RiskRecordModel, SignState, WithdrawState } from '../../view-model'
import { Law, useDay, useWhen, useWords } from '../../view/parts'

/**
 * Sign version (design pop:sign, from the Versions tab): the DS SignBlock for the holder of the role, who types their own name
 * in the office (it must be the holder's; a fresh authenticator code is asked after every other check), or the paper signed
 * by hand recorded by the safety officer — the name and the day on it, its scan on file first. The floor's PIN variant is
 * not built (the API reads it, writes none: B-W2b-122's gap). Esc closes.
 */
export function SignDialog({ model, record, state, actions }: { model: RiskRecordModel; record: AssessmentRecord; state: SignState; actions?: RiskRecordActions | undefined }) {
  const t = useWords()
  const day = useDay()
  const when = useWhen()
  const version = record.versions.find((row) => row.id === state.versionId) ?? null
  const signer = version?.signers.find((row) => row.role === state.role) ?? null
  const close = () => actions?.onAddress?.({ sign: null })
  if (!version || !signer) {
    return (
      <Modal open onClose={close} title={t('sign.title')} size="md" footer={<Button onClick={close}>{t('common.close')}</Button>}>
        <Banner tone="warning" title={t('sign.gone')} />
      </Modal>
    )
  }
  const role = t(`role.${state.role}`)
  const done = state.done
  const summary = (
    <KeyValue
      items={[
        { label: t('sign.assessment'), value: `${record.assessment.name} · ${record.assessment.site.name}` },
        { label: t('sign.version'), value: `${versionNo(version)}${version.label ? ` · ${version.label}` : ''}` },
        { label: t('sign.file'), value: version.file.name },
        { label: t('sign.fingerprint'), value: `${version.sha256.slice(0, 16)}…` },
        { label: t('sign.frozen'), value: when(version.frozenAt) },
        { label: t('sign.role'), value: role },
      ]}
    />
  )
  const officeHeld = !signer.mine ? t('held.notYourRole') : !record.may.sign ? t('held.sign') : signer.signature ? t('refusal.SIGNED_ALREADY') : version.status !== 'AWAITING_SIGNATURES' ? t('held.notWaiting') : null
  const paperWhy = !record.may.manage ? 'held.manage' : !record.may.upload ? 'held.upload' : paperHeld(state.paper, version, model.today, state.busy)
  return (
    <Modal
      open
      onClose={close}
      title={t('sign.titleRole', { role, version: versionNo(version) })}
      size="lg"
      footer={
        done ? (
          <Button variant="primary" onClick={close}>
            {t('common.done')}
          </Button>
        ) : state.method === 'paper' ? (
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="primary" heldReason={paperWhy ? t(paperWhy) : null} onClick={() => actions?.onSignPaper?.()}>
              {state.busy ? <Spinner size={14} /> : null} {t('sign.recordPaper')}
            </Button>
          </>
        ) : (
          <Button onClick={close}>{t('common.cancel')}</Button>
        )
      }
    >
      <div className="fw-rk-form">
        {done ? (
          <Banner tone="success" title={t(done.complete ? 'sign.doneComplete' : 'sign.done', { role, date: day(done.version.certainDateOn) })}>
            {done.complete && !done.sealed ? t('sign.sealLater') : done.complete ? t('sign.sealed') : t('sign.waitingFor', { count: done.version.missing.length })}
          </Banner>
        ) : (
          <>
            {state.problem && !state.problem.field && <Banner tone="danger" title={t(state.problem.key)} />}
            <SegmentedControl
              size="sm"
              ariaLabel={t('sign.method')}
              value={state.method}
              onChange={(method) => actions?.onAddress?.({ method: method === 'paper' ? 'paper' : 'office' })}
              options={[
                { value: 'office', label: t('sign.office') },
                { value: 'paper', label: t('sign.paper') },
              ]}
            />
            {state.method === 'office' ? (
              <SignBlock
                title={t('sign.blockTitle', { name: signer.holder?.name ?? role })}
                summary={summary}
                legal={
                  <p>
                    {t('sign.legal', { role, assessment: record.assessment.name })} <Law law={record.law.versions} plain={t('law.versions')} />
                  </p>
                }
                nameLabel={t('sign.name')}
                nameHint={t('sign.nameHint')}
                expectedName={signer.holder?.name ?? ''}
                nameEmptyLabel={t('sign.nameEmpty')}
                nameMismatchLabel={t('refusal.NAME_MISMATCH')}
                acceptLabel={t('sign.accept')}
                busyLabel={t('held.saving')}
                onAccept={(acceptance) => actions?.onSignOffice?.(acceptance.name)}
                state={state.busy ? 'busy' : 'idle'}
                heldReason={officeHeld}
                message={state.problem?.field ? t(state.problem.key) : undefined}
              />
            ) : (
              <>
                {summary}
                <p className="fw-rk-muted">{t('sign.paperExplain')}</p>
                <div className="fw-rk-form-row">
                  <Field label={t('sign.paperName')} required hint={t('sign.paperNameHint')} error={atField(state.problem, 'signerName') ? t(state.problem!.key) : undefined}>
                    <Input value={state.paper.signerName} maxLength={200} onChange={(event) => actions?.onSignDraft?.({ ...state.paper, signerName: event.target.value })} />
                  </Field>
                  <Field label={t('sign.paperDay')} required hint={t('sign.paperDayHint', { date: day(version.frozenAt.slice(0, 10)) })} error={atField(state.problem, 'signedOn') ? t(state.problem!.key) : undefined}>
                    <DateField value={state.paper.signedOn} min={version.frozenAt.slice(0, 10)} max={model.today} onChange={(value) => actions?.onSignDraft?.({ ...state.paper, signedOn: value })} ariaLabel={t('sign.paperDay')} />
                  </Field>
                </div>
                <Field label={t('sign.scan')} required hint={t('sign.scanHint')}>
                  <FileDropzone onFiles={(files) => actions?.onSignScan?.(files[0] ?? null)} accept=".pdf,.jpg,.jpeg,.png,.webp,.heic" maxBytes={25 * 1024 * 1024} disabled={state.busy} hint={state.paper.scan ? state.paper.scan.name : t('sign.scanPick')} />
                </Field>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

/** Withdraw a version waiting for its signatures: the reason (kept with it; it stays in the list, never deleted). */
export function WithdrawDialog({ record, state, actions }: { record: AssessmentRecord; state: WithdrawState; actions?: RiskRecordActions | undefined }) {
  const t = useWords()
  const version = record.versions.find((row) => row.id === state.versionId) ?? null
  const close = () => actions?.onAddress?.({ withdraw: null })
  const held = !record.may.manage ? 'held.manage' : state.busy ? 'held.saving' : state.reason.trim() === '' ? 'held.reason' : state.reason.trim().length > LIMITS.reason ? 'held.reasonLong' : version && version.status !== 'AWAITING_SIGNATURES' ? 'refusal.NOT_AWAITING' : null
  return (
    <Modal
      open
      onClose={close}
      title={t('withdraw.title', { version: version ? versionNo(version) : '' })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onWithdraw?.()}>
            {state.busy ? <Spinner size={14} /> : null} {t('version.withdraw')}
          </Button>
        </>
      }
    >
      <div className="fw-rk-form">
        {state.problem && <Banner tone="danger" title={t(state.problem.key)} />}
        <p>{t('withdraw.explain')}</p>
        <Field label={t('withdraw.reason')} required>
          <Textarea value={state.reason} rows={3} onChange={(event) => actions?.onWithdrawReason?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/** The assessment's own facts: its name, the next review (a person types it: no interval is built in), a note. */
export function EditAssessmentDialog({ model, record, state, actions }: { model: RiskRecordModel; record: AssessmentRecord; state: EditAssessmentState; actions?: RiskRecordActions | undefined }) {
  const t = useWords()
  const close = () => actions?.onAddress?.({ add: null })
  const set = (change: Partial<EditAssessmentState>) => actions?.onEditDraft?.({ ...state, ...change, problem: null })
  const a = record.assessment
  const unchanged = state.name.trim() === a.name && (state.nextReviewOn || null) === a.nextReviewOn && (state.note.trim() || null) === (a.note ?? null)
  const held = !record.may.manage
    ? 'held.manage'
    : state.busy
      ? 'held.saving'
      : state.name.trim() === ''
        ? 'held.assessmentName'
        : state.nextReviewOn !== '' && !isDay(state.nextReviewOn)
          ? 'held.day'
          : state.nextReviewOn !== '' && tooFar(state.nextReviewOn, model.today)
            ? 'refusal.DUE_TOO_FAR'
            : unchanged
              ? 'held.nothingChanged'
              : null
  return (
    <Modal
      open
      onClose={close}
      title={t('editAssessment.title')}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onEditSave?.()}>
            {state.busy ? <Spinner size={14} /> : null} {t('editAssessment.save')}
          </Button>
        </>
      }
    >
      <div className="fw-rk-form">
        {state.problem && !state.problem.field && <Banner tone="danger" title={t(state.problem.key)} />}
        <Field label={t('version.assessmentName')} required error={atField(state.problem, 'name') ? t(state.problem!.key) : undefined}>
          <Input value={state.name} maxLength={200} onChange={(event) => set({ name: event.target.value })} />
        </Field>
        <Field label={t('version.nextReview')} hint={t('editAssessment.reviewHint')} error={atField(state.problem, 'nextReviewOn') ? t(state.problem!.key) : undefined}>
          <DateField value={state.nextReviewOn} clearable onChange={(value) => set({ nextReviewOn: value })} ariaLabel={t('version.nextReview')} />
        </Field>
        <Field label={t('editAssessment.note')}>
          <Textarea value={state.note} rows={3} onChange={(event) => set({ note: event.target.value })} />
        </Field>
        <p className="fw-rk-row fw-rk-muted">
          {t('editAssessment.law')} <Law law={record.law.review} plain={t('law.review')} />
        </p>
      </div>
    </Modal>
  )
}
