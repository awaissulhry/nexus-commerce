'use client'

import { Ban, CheckCheck, ClipboardCheck, Eye, FilePlus2, GraduationCap, RotateCcw, Save, Wrench, X } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Checkbox, Input, Select, Spinner } from '@nexus/ui/primitives'
import { PRIORITIES } from '@nexus/factory-domain/plant/rules'
import { usePhotoWords } from '../../../../../lib/ds-words/photo-capture'
import { DateField, DateTimeField, FileDropzone, Modal, Textarea, useDsWords } from '../../../../../lib/i18n/ds-parts'
import type { IncidentRecord, InailFiling } from '../../api'
import {
  actionHeld,
  actionsOpen,
  cancelHeld,
  closeHeld,
  filingDraftHeld,
  filingDraftOf,
  filingPeople,
  filingPlan,
  filingTypeFor,
  filingsWaiting,
  makeHeld,
  newActionHeld,
  personName,
  planEmpty,
  reopenHeld,
  TRAINING_HELD,
  type ActionDraft,
} from '../../model'
import type { IncidentRecordActions, IncidentRecordModel, RecordDialog } from '../../view-model'
import { PeopleLaw, useWhen, useWords } from '../../view/parts'

/** The record's dialogs (design pop:close, pop:filing; the actions' make / done / cancel; a photo; the note before a protected read). */
export function RecordDialogs({ model, incident, actions }: { model: IncidentRecordModel; incident: IncidentRecord; actions?: IncidentRecordActions | undefined }) {
  const dialog = model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'close':
    case 'reopen':
      return <MoveDialog dialog={dialog} incident={incident} actions={actions} />
    case 'cancel':
      return <CancelDialog dialog={dialog} incident={incident} actions={actions} />
    case 'action':
      return <ActionDialog dialog={dialog} incident={incident} actions={actions} />
    case 'filing':
      return <FilingDialog model={model} dialog={dialog} incident={incident} actions={actions} />
    case 'photo':
      return <PhotoDialog dialog={dialog} incident={incident} actions={actions} />
    case 'peopleNote':
      return <PeopleNoteDialog incident={incident} actions={actions} />
    default:
      return null
  }
}

const Problem = ({ problem }: { problem: { key: string } | null }) => {
  const t = useWords()
  return problem ? <Banner tone="danger" title={t('dialog.refused')}>{t(problem.key)}</Banner> : null
}

/** design pop:close — Close incident: held while an action is open or a filing waits (said, with what is left). Reopen too. */
function MoveDialog({ dialog, incident, actions }: { dialog: Extract<RecordDialog, { kind: 'close' | 'reopen' }>; incident: IncidentRecord; actions?: IncidentRecordActions | undefined }) {
  const t = useWords()
  const held = dialog.kind === 'close' ? closeHeld(incident) : reopenHeld(incident)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(dialog.kind === 'close' ? 'close.title' : 'reopen.title', { number: incident.number })}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={dialog.busy ? t('held.saving') : held ? t(held) : null} onClick={() => (dialog.kind === 'close' ? actions?.onClose?.() : actions?.onReopen?.())}>
            {dialog.busy ? <Spinner size={12} /> : dialog.kind === 'close' ? <CheckCheck size={14} aria-hidden /> : <RotateCcw size={14} aria-hidden />} {t(dialog.kind === 'close' ? 'close.confirm' : 'reopen.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-inc-stack">
        <Problem problem={dialog.problem} />
        <p>{t(dialog.kind === 'close' ? 'close.body' : 'reopen.body')}</p>
        {dialog.kind === 'close' && (
          <ul className="fw-inc-list">
            <li>{t('close.actions', { count: actionsOpen(incident) })}</li>
            <li>{t('close.filings', { count: filingsWaiting(incident) })}</li>
          </ul>
        )}
      </div>
    </Modal>
  )
}

/** Cancel the report (a duplicate or a mistake), with the reason; held as close is. */
function CancelDialog({ dialog, incident, actions }: { dialog: Extract<RecordDialog, { kind: 'cancel' }>; incident: IncidentRecord; actions?: IncidentRecordActions | undefined }) {
  const t = useWords()
  const held = cancelHeld(incident) ?? (dialog.reason.trim() ? null : 'held.reason')
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('cancel.title', { number: incident.number })}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={dialog.busy ? t('held.saving') : held ? t(held) : null} onClick={() => actions?.onCancel?.()}>
            <Ban size={14} aria-hidden /> {t('cancel.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-inc-stack">
        <Problem problem={dialog.problem} />
        <p>{t('cancel.body')}</p>
        <Field label={t('cancel.reason')} required>
          <Textarea value={dialog.reason} onChange={(event) => actions?.onCancelReason?.(event.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}

const MAKE_ICON = { MAINTENANCE_JOB: <Wrench size={14} aria-hidden />, RISK_MEASURE: <ClipboardCheck size={14} aria-hidden />, TRAINING_SESSION: <GraduationCap size={14} aria-hidden /> } as const

/** An action: new (with "make into" in the same step), or one action — make it into its record, done, cancel, change. */
function ActionDialog({ dialog, incident, actions }: { dialog: Extract<RecordDialog, { kind: 'action' }>; incident: IncidentRecord; actions?: IncidentRecordActions | undefined }) {
  const t = useWords()
  const when = useWhen()
  const action = dialog.actionId === 'new' ? null : (incident.actions.find((entry) => entry.id === dialog.actionId) ?? null)
  const draft = dialog.draft
  const set = (change: Partial<ActionDraft>) => actions?.onActionDraft?.({ ...draft, ...change })
  const isNew = dialog.actionId === 'new'
  const baseHeld = action ? actionHeld(incident, action) : null
  const machines = dialog.machines?.status === 'ready' ? dialog.machines.value : []

  const makeFields = (
    <>
      {draft.into === 'MAINTENANCE_JOB' && (
        <div className="fw-inc-form-row">
          <Field label={t('make.machine')} hint={incident.machine ? t('make.machineDefault', { asset: incident.machine.assetNumber }) : undefined}>
            <Select value={draft.machineId ?? incident.machine?.id ?? ''} onChange={(event) => set({ machineId: event.target.value || null })}>
              <option value="">{dialog.machines?.status === 'loading' ? t('common.reading') : t('make.chooseMachine')}</option>
              {incident.machine && !machines.some((machine) => machine.id === incident.machine!.id) ? <option value={incident.machine.id}>{incident.machine.assetNumber}</option> : null}
              {machines.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.assetNumber}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('make.priority')} hint={t('make.priorityHint')}>
            <Select value={draft.priority ?? ''} onChange={(event) => set({ priority: (event.target.value || null) as ActionDraft['priority'] })}>
              <option value="">{t('make.priorityDefault')}</option>
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {t(`priority.${priority}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('make.problem')}>
            <Input value={draft.problem} onChange={(event) => set({ problem: event.target.value })} maxLength={1000} placeholder={draft.title || incident.what.slice(0, 80)} />
          </Field>
        </div>
      )}
      {draft.into === 'RISK_MEASURE' && (
        <Field label={t('make.risk')} hint={t('make.riskHint')}>
          <Input value={draft.risk} onChange={(event) => set({ risk: event.target.value })} maxLength={500} />
        </Field>
      )}
    </>
  )

  if (isNew || dialog.mode === 'edit') {
    const held = isNew ? newActionHeld(draft, incident) : (baseHeld ?? (draft.title.trim() ? null : 'held.action.title'))
    return (
      <Modal
        open
        onClose={() => actions?.onDialog?.(null)}
        title={isNew ? t('action.newTitle') : t('action.editTitle', { n: action?.seq ?? '' })}
        size="lg"
        footer={
          <>
            <Button onClick={() => actions?.onDialog?.(null)}>{t('common.cancel')}</Button>
            <span className="grow" />
            <Button variant="primary" heldReason={dialog.busy ? t('held.saving') : held ? t(held) : null} onClick={() => actions?.onActionSave?.()}>
              {dialog.busy ? <Spinner size={12} /> : <Save size={14} aria-hidden />} {isNew ? t(draft.into === 'NONE' ? 'action.add' : `action.addMake.${draft.into}`) : t('action.save')}
            </Button>
          </>
        }
      >
        <div className="fw-inc-form">
          <Problem problem={dialog.problem} />
          <Field label={t('action.title')} required>
            <Input value={draft.title} onChange={(event) => set({ title: event.target.value })} maxLength={300} />
          </Field>
          <div className="fw-inc-form-row">
            <Field label={t('action.due')}>
              <DateField value={draft.dueOn} onChange={(value) => set({ dueOn: value })} />
            </Field>
            {isNew ? (
              <Field label={t('action.owner')} hint={t('action.ownerHint')}>
                <Checkbox label={t('action.mine')} checked={draft.mine} onChange={(event) => set({ mine: event.target.checked })} />
              </Field>
            ) : null}
          </div>
          {isNew && (
            <fieldset className="fw-inc-fieldset">
              <legend>{t('make.legend')}</legend>
              <div className="fw-inc-make">
                {(['NONE', 'MAINTENANCE_JOB', 'RISK_MEASURE', 'TRAINING_SESSION'] as const).map((into) => {
                  const intoHeld = into === 'NONE' ? null : makeHeld(into, { machineId: draft.machineId }, incident)
                  return (
                    <Button key={into} size="sm" variant={draft.into === into ? 'primary' : 'secondary'} aria-pressed={draft.into === into} heldReason={into === 'TRAINING_SESSION' ? t(TRAINING_HELD) : null} onClick={() => set({ into })}>
                      {into === 'NONE' ? null : MAKE_ICON[into]} {t(`make.${into}`)}
                      {intoHeld && into !== 'TRAINING_SESSION' ? <span className="fw-inc-vh">{t(intoHeld)}</span> : null}
                    </Button>
                  )
                })}
              </div>
              {draft.into !== 'NONE' && <p className="fw-inc-muted">{t(`makeHint.${draft.into}`)}</p>}
              {makeFields}
            </fieldset>
          )}
        </div>
      </Modal>
    )
  }

  if (!action) return null

  if (dialog.mode === 'make') {
    const held = baseHeld ?? (action.madeInto ? 'refusal.MADE_ALREADY' : makeHeld(draft.into, draft, incident))
    return (
      <Modal
        open
        onClose={() => actions?.onDialog?.(null)}
        title={t(`make.title.${draft.into}`, { n: action.seq })}
        size="lg"
        footer={
          <>
            <Button onClick={() => actions?.onActionMode?.('view')}>{t('common.back')}</Button>
            <span className="grow" />
            <Button variant="primary" heldReason={dialog.busy ? t('held.saving') : held ? t(held) : null} onClick={() => actions?.onActionSave?.()}>
              {dialog.busy ? <Spinner size={12} /> : draft.into === 'NONE' ? null : MAKE_ICON[draft.into]} {t(`make.do.${draft.into}`)}
            </Button>
          </>
        }
      >
        <div className="fw-inc-form">
          <Problem problem={dialog.problem} />
          <p>
            <b>{`${action.seq}. ${action.title}`}</b>
          </p>
          <p className="fw-inc-muted">{t(`makeHint.${draft.into}`)}</p>
          {makeFields}
        </div>
      </Modal>
    )
  }

  if (dialog.mode === 'done' || dialog.mode === 'cancel') {
    const held = baseHeld ?? (dialog.mode === 'cancel' && !draft.reason.trim() ? 'held.reason' : null)
    return (
      <Modal
        open
        onClose={() => actions?.onDialog?.(null)}
        title={t(dialog.mode === 'done' ? 'action.doneTitle' : 'action.cancelTitle', { n: action.seq })}
        size="md"
        footer={
          <>
            <Button onClick={() => actions?.onActionMode?.('view')}>{t('common.back')}</Button>
            <span className="grow" />
            <Button variant={dialog.mode === 'done' ? 'primary' : 'danger'} heldReason={dialog.busy ? t('held.saving') : held ? t(held) : null} onClick={() => actions?.onActionSave?.()}>
              {dialog.busy ? <Spinner size={12} /> : dialog.mode === 'done' ? <CheckCheck size={14} aria-hidden /> : <X size={14} aria-hidden />} {t(dialog.mode === 'done' ? 'action.done' : 'action.cancel')}
            </Button>
          </>
        }
      >
        <div className="fw-inc-form">
          <Problem problem={dialog.problem} />
          <p>
            <b>{`${action.seq}. ${action.title}`}</b>
          </p>
          {dialog.mode === 'done' ? (
            <Field label={t('action.evidence')} hint={t('action.evidenceHint')}>
              <Textarea value={draft.evidenceNote} onChange={(event) => set({ evidenceNote: event.target.value })} rows={3} maxLength={2000} />
            </Field>
          ) : (
            <Field label={t('action.reason')} required>
              <Textarea value={draft.reason} onChange={(event) => set({ reason: event.target.value })} rows={2} maxLength={500} />
            </Field>
          )}
        </div>
      </Modal>
    )
  }

  // view
  const made = action.madeInto !== null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={`${action.seq}. ${action.title}`}
      size="lg"
      footer={
        <>
          <Button variant="danger-outline" heldReason={baseHeld ? t(baseHeld) : null} onClick={() => actions?.onActionMode?.('cancel')}>
            <X size={14} aria-hidden /> {t('action.cancel')}
          </Button>
          <Button heldReason={baseHeld ? t(baseHeld) : null} onClick={() => actions?.onActionMode?.('edit')}>
            {t('action.change')}
          </Button>
          <span className="grow" />
          <Button variant="primary" heldReason={baseHeld ? t(baseHeld) : null} onClick={() => actions?.onActionMode?.('done')}>
            <CheckCheck size={14} aria-hidden /> {t('action.done')}
          </Button>
        </>
      }
    >
      <div className="fw-inc-stack">
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('col.status'), value: t(`actionStatus.${action.status}`) },
            { label: t('col.owner'), value: action.owner?.name ?? t('action.noOwner') },
            { label: t('col.due'), value: action.dueOn ? when.day(action.dueOn) : t('action.noDue'), hint: action.overdue ? t('action.overdue') : undefined },
            { label: t('col.madeInto'), value: action.record ? `${t(`madeInto.${action.madeInto}`)}: ${action.record.label}` : t('madeInto.none') },
            ...(action.evidenceNote ? [{ label: t('col.evidence'), value: action.evidenceNote }] : []),
          ]}
        />
        {!made && (
          <fieldset className="fw-inc-fieldset">
            <legend>{t('make.oneStep')}</legend>
            <div className="fw-inc-make">
              {(['MAINTENANCE_JOB', 'RISK_MEASURE', 'TRAINING_SESSION'] as const).map((into) => (
                <Button key={into} size="sm" heldReason={baseHeld ? t(baseHeld) : into === 'TRAINING_SESSION' ? t(TRAINING_HELD) : null} onClick={() => actions?.onActionMode?.('make', into)}>
                  {MAKE_ICON[into]} {t(`make.${into}`)}
                </Button>
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </Modal>
  )
}

/** design pop:filing — Record INAIL filing: the absence decides the type; the certificate starts the 48 h clock; filed at, protocol, receipt. */
function FilingDialog({ model, dialog, incident, actions }: { model: IncidentRecordModel; dialog: Extract<RecordDialog, { kind: 'filing' }>; incident: IncidentRecord; actions?: IncidentRecordActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const when = useWhen()
  const filings = model.filings.state === 'open' ? model.filings.value.filings : []
  const people = model.people.state === 'open' ? filingPeople(model.people.value) : []
  const draft = dialog.draft
  const filing = draft.filingId === 'new' ? null : (filings.find((entry) => entry.id === draft.filingId) ?? null)
  const set = (change: Partial<typeof draft>) => actions?.onFilingDraft?.({ ...draft, ...change })
  const now = new Date()
  const held = filingDraftHeld(draft, filing, { occurredAt: incident.occurredAt, now }) ?? (planEmpty(filingPlan(draft, filing)) ? 'held.noChange' : null)
  const type = filing ? filing.type : filingTypeFor(draft.expectedAbsenceDays)
  const certificateAt = draft.certificateReceivedAt ? new Date(draft.certificateReceivedAt) : null
  const dueBy = certificateAt ? new Date(certificateAt.getTime() + incident.inail.rule.hoursAfterCertificate * 3_600_000).toISOString() : null
  const at = (field: string) => (dialog.problem?.field === field ? t(dialog.problem.key) : undefined)
  const filed = filing?.status === 'FILED'

  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('filingDialog.title', { number: incident.number })}
      size="xl"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.cancel')}</Button>
          <span className="grow" />
          <Button variant="primary" heldReason={dialog.busy ? t('held.saving') : held ? t(held) : null} onClick={() => actions?.onFilingSave?.()}>
            {dialog.busy ? <Spinner size={12} /> : <FilePlus2 size={14} aria-hidden />} {t('filingDialog.save')}
          </Button>
        </>
      }
    >
      <div className="fw-inc-form">
        <PrivacyNote level="protected" variant="panel" recorded text={t('filingDialog.privacy')} whoMore={t('people.who')} law={<PeopleLaw />} labels={ds.privacyNote} />
        {dialog.problem && !dialog.problem.field && <Banner tone="danger" title={t('dialog.refused')}>{t(dialog.problem.key)}</Banner>}
        {dialog.done.length > 0 && (
          <Banner tone="info" title={t('filingDialog.partly')}>
            {dialog.done.map((step) => t(`filingDialog.step.${step}`)).join(' · ')}
          </Banner>
        )}
        <Field label={t('filingDialog.which')}>
          <Select value={draft.filingId} onChange={(event) => actions?.onFilingDraft?.(filingDraftOf(filings.find((entry) => entry.id === event.target.value) ?? null, people))}>
            {filings.map((entry: InailFiling) => (
              <option key={entry.id} value={entry.id}>
                {`${entry.person.name} · ${t(`filingType.${entry.type}`)} · ${t(`filingState.${entry.state}`)}`}
              </option>
            ))}
            <option value="new">{t('filingDialog.new')}</option>
          </Select>
        </Field>
        {draft.filingId === 'new' ? (
          <div className="fw-inc-form-row">
            <Field label={t('filingDialog.person')} required error={at('incidentPersonId')} hint={people.length === 0 ? t('filingDialog.noPerson') : undefined}>
              <Select value={draft.personId ?? ''} onChange={(event) => set({ personId: event.target.value || null })}>
                <option value="">{t('filingDialog.choosePerson')}</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {personName(person)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('filing.expected')} required error={at('expectedAbsenceDays')} hint={type ? t('filingDialog.calls', { type: t(`filingType.${type}`) }) : draft.expectedAbsenceDays.trim() ? t('refusal.NO_FILING_NEEDED') : t('filingDialog.daysHint')}>
              <Input inputMode="numeric" value={draft.expectedAbsenceDays} onChange={(event) => set({ expectedAbsenceDays: event.target.value })} />
            </Field>
          </div>
        ) : filing ? (
          <div className="fw-inc-form-row">
            <Field label={t('filingDialog.type')} hint={t('filingDialog.typeHint')}>
              <Input value={t(`filingType.${filing.type}`)} readOnly />
            </Field>
            <Field label={t('filing.expected')} error={at('expectedAbsenceDays')}>
              <Input inputMode="numeric" value={draft.expectedAbsenceDays} disabled={filed} onChange={(event) => set({ expectedAbsenceDays: event.target.value })} />
            </Field>
            <Field label={t('filing.actual')} error={at('actualAbsenceDays')}>
              <Input inputMode="numeric" value={draft.actualAbsenceDays} disabled={filed} onChange={(event) => set({ actualAbsenceDays: event.target.value })} />
            </Field>
          </div>
        ) : null}
        <div className="fw-inc-form-row">
          <Field label={t('filingDialog.certificateAt')} error={at('certificateReceivedAt')} hint={dueBy ? t('filingDialog.dueBy', { at: when.at(dueBy) }) : t('filingDialog.certificateHint')}>
            <DateTimeField value={draft.certificateReceivedAt} onChange={(value) => set({ certificateReceivedAt: value })} min={incident.occurredAt} max={now.toISOString()} stepMinutes={5} ariaLabel={t('filingDialog.certificateAt')} disabled={filed} />
          </Field>
          <Field label={t('filingDialog.certificateRef')} error={at('certificateReference')}>
            <Input value={draft.certificateReference} disabled={filed} onChange={(event) => set({ certificateReference: event.target.value })} maxLength={100} />
          </Field>
        </div>
        <fieldset className="fw-inc-fieldset">
          <legend>{t('filingDialog.filedLegend')}</legend>
          <p className="fw-inc-muted">{t('filingDialog.filedHint')}</p>
          <div className="fw-inc-form-row">
            <Field label={t('filingDialog.filedAt')} error={at('filedAt')}>
              <DateTimeField value={draft.filedAt} onChange={(value) => set({ filedAt: value })} min={draft.certificateReceivedAt || incident.occurredAt} max={now.toISOString()} stepMinutes={5} ariaLabel={t('filingDialog.filedAt')} disabled={filed} />
            </Field>
            <Field label={t('filingDialog.protocol')} error={at('protocolNumber')}>
              <Input value={draft.protocolNumber} disabled={filed} onChange={(event) => set({ protocolNumber: event.target.value })} maxLength={100} />
            </Field>
          </div>
          <Field label={t('filingDialog.receipt')} hint={draft.receipt ? draft.receipt.name : filing?.receipt ? t('filingDialog.receiptOnFile', { name: filing.receipt.name }) : t('filingDialog.receiptHint')}>
            <FileDropzone accept=".pdf" maxBytes={20 * 1024 * 1024} onFiles={(files) => set({ receipt: files[0] ?? null })} />
          </Field>
        </fieldset>
      </div>
    </Modal>
  )
}

/** A photo of the incident from the office (the DS photo capture with markup: no faces). */
function PhotoDialog({ dialog, incident, actions }: { dialog: Extract<RecordDialog, { kind: 'photo' }>; incident: IncidentRecord; actions?: IncidentRecordActions | undefined }) {
  const t = useWords()
  const words = usePhotoWords()
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('photos.addTitle', { number: incident.number })} size="lg">
      <div className="fw-inc-stack">
        <Problem problem={dialog.problem} />
        <PhotoCapture label={t('report.photoLabel')} words={words} onCapture={(photo) => actions?.onPhoto?.(photo)} onCancel={() => actions?.onDialog?.(null)} heldReason={dialog.busy ? t('held.saving') : null} />
      </div>
    </Modal>
  )
}

/** Before a protected read the page says what it opens and that the opening is recorded (PrivacyNote), then reads. */
function PeopleNoteDialog({ incident, actions }: { incident: IncidentRecord; actions?: IncidentRecordActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('note.title', { number: incident.number })}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => actions?.onConfirmNote?.()}>
            <Eye size={14} aria-hidden /> {t('note.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-inc-stack">
        <PrivacyNote level="protected" variant="panel" recorded text={t('note.body')} whoMore={t('people.who')} law={<PeopleLaw />} labels={ds.privacyNote} />
        <p className="fw-inc-muted">{t('note.what')}</p>
      </div>
    </Modal>
  )
}

