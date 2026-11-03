'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, GitMerge, Lock, Search, TriangleAlert, Wrench, X } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { Button, Checkbox, Input, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { usePhotoWords } from '../../../../lib/ds-words/photo-capture'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { CLOSE_REASONS, JOB_TYPES, PRIORITIES, type Symptom } from '../../_shared/api'
import { ageWords, labelOf, personWords } from '../../_shared/model'
import { AssigneeField } from '../../_shared/AssigneeField'
import { iconOf, MachinePill, say, SymptomText, useWords } from '../../_shared/parts'
import { mergeHeld, mergeSources, retarget, sourceHeld, targetKey, targetsOf } from '../depth/model'
import type { RequestsListActions, RequestsListModel } from '../view-model'
import { SignSafeDialog } from './SignSafeDialog'

/**
 * The queue's dialogs (design plant.requests): Make a job (prefilled from the request: the machine, the problem from the
 * symptom, the type Safety when unsafe else Corrective, P1 when unsafe or the line stopped, a technician, the due time; or
 * the machine's open job), Close without a job (the reason; a note for "Other"; keep a stopped machine down), Merge into
 * another open request of the machine, Sign safe (a technician, what was checked, the state after; a fresh two-factor
 * code: D.Lgs. 81/2008 art. 71, Owner answer H1) and Report a problem (the three floor steps in the office: the machine,
 * the symptom's icon, a photo or a note). B-W2b-140: Merge requests (several requests of one machine into one request or
 * into its open job: every reporter keeps their request and follows the one kept) and Lock as unsafe (the reach in words,
 * the law named, Enter locks). Each submit is held with its reason in words until it may go.
 */
export function RequestDialogs({ model, actions }: { model: RequestsListModel; actions?: RequestsListActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'makeJob':
      return <MakeJobDialog model={model} actions={actions} />
    case 'close':
      return <CloseDialog model={model} actions={actions} />
    case 'signSafe':
      return <RequestSignSafe model={model} actions={actions} />
    case 'mergeMany':
      return <MergeManyDialog model={model} actions={actions} />
    case 'lock':
      return <LockDialog model={model} actions={actions} />
    case 'report':
      return <ReportDialog model={model} actions={actions} />
  }
}

const recordOf = (model: RequestsListModel) => (model.detail?.loaded.status === 'ready' ? model.detail.loaded.value : null)

function Footer({ hint, held, busy, label, icon, onCancel, onSubmit, danger = false }: { hint?: string | null; held: string | null; busy: boolean; label: string; icon: React.ReactNode; onCancel: () => void; onSubmit: () => void; danger?: boolean }) {
  const t = useWords()
  return (
    <>
      {hint && <span className="fw-pl-hint">{hint}</span>}
      <span className="fw-pl-grow" />
      <Button size="sm" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      <Button size="sm" variant={danger ? 'danger' : 'primary'} heldReason={held} onClick={() => !held && onSubmit()} aria-keyshortcuts="Meta+Enter Control+Enter">
        {busy ? <Spinner size={12} /> : icon} {label}
      </Button>
    </>
  )
}

/** ⌘↵ submits a dialog's form (when it may go). */
const submitKeys = (held: string | null, submit: () => void) => (event: React.KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    if (!held) submit()
  }
}

// ---- Make a job ------------------------------------------------------------------------------------------------------------

function MakeJobDialog({ model, actions }: { model: RequestsListModel; actions?: RequestsListActions }) {
  const t = useWords()
  const dialog = model.dialog as Extract<NonNullable<RequestsListModel['dialog']>, { kind: 'makeJob' }>
  const record = recordOf(model)
  const draft = dialog.draft
  const joining = draft.mode === 'join' && dialog.openJob !== null
  const held = !model.can.triage ? t('held.noTriage') : !joining && draft.problem.trim().length === 0 ? t('held.problemNeeded') : dialog.busy ? t('held.busy') : null
  const submit = () => actions?.onSubmitDialog?.()
  const request = record?.request
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t('makeJob.title', { machine: request?.machine.assetNumber ?? '—' })}
      size="lg"
      footer={
        <Footer
          hint={joining ? t('makeJob.joinHint', { number: dialog.openJob!.number }) : t('makeJob.hint')}
          held={held}
          busy={dialog.busy}
          label={joining ? t('makeJob.join', { number: dialog.openJob!.number }) : t('makeJob.create')}
          icon={<Wrench size={14} aria-hidden />}
          onCancel={() => actions?.onDialogClose?.()}
          onSubmit={submit}
        />
      }
    >
      <form
        className="fw-pl-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) submit()
        }}
        onKeyDown={submitKeys(held, submit)}
      >
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        {dialog.openJob && (
          <div className="fw-pl-choices" role="radiogroup" aria-label={t('makeJob.which')}>
            <RadioCard name="make-job-mode" value="join" checked={draft.mode === 'join'} selected={draft.mode === 'join'} onChange={() => actions?.onMakeJobDraft?.({ mode: 'join' })} title={t('makeJob.joinTitle', { number: dialog.openJob.number })} description={t('makeJob.joinBody')} />
            <RadioCard name="make-job-mode" value="new" checked={draft.mode === 'new'} selected={draft.mode === 'new'} onChange={() => actions?.onMakeJobDraft?.({ mode: 'new' })} title={t('makeJob.newTitle')} description={t('makeJob.newBody')} />
          </div>
        )}
        {!joining && (
          <div className="fw-pl-form">
            <Field label={t('field.type')} required>
              <Select value={draft.type} onChange={(event) => actions?.onMakeJobDraft?.({ type: event.target.value as typeof draft.type })}>
                {JOB_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`jobType.${type}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('field.priority')} required hint={t(`priorityHint.${draft.priority}`)}>
              <Select value={draft.priority} onChange={(event) => actions?.onMakeJobDraft?.({ priority: event.target.value as typeof draft.priority })}>
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {t(`priority.${priority}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('field.problem')} required className="wide">
              <Textarea value={draft.problem} rows={3} maxLength={2000} onChange={(event) => actions?.onMakeJobDraft?.({ problem: event.target.value })} />
            </Field>
            <AssigneeField value={draft.assignee} technicians={dialog.technicians} floorListed={dialog.floorListed} problem={dialog.techniciansProblem} onChange={(assignee) => actions?.onMakeJobDraft?.({ assignee })} />
            <Field label={t('field.due')} hint={t('field.dueHint')}>
              <Input type="datetime-local" value={draft.due} onChange={(event) => actions?.onMakeJobDraft?.({ due: event.target.value })} />
            </Field>
            <div className="wide">
              <Checkbox checked={draft.plan} onChange={(event) => actions?.onMakeJobDraft?.({ plan: event.target.checked })} label={t('makeJob.plan')} />
            </div>
          </div>
        )}
        {request?.unsafe && <p className="fw-pl-hint">{t('makeJob.unsafeHint')}</p>}
      </form>
    </Modal>
  )
}

// ---- Close without a job ---------------------------------------------------------------------------------------------------

function CloseDialog({ model, actions }: { model: RequestsListModel; actions?: RequestsListActions }) {
  const t = useWords()
  const dialog = model.dialog as Extract<NonNullable<RequestsListModel['dialog']>, { kind: 'close' }>
  const record = recordOf(model)
  const draft = dialog.draft
  const held = !model.can.triage ? t('held.noTriage') : !draft.reason ? t('held.reasonNeeded') : draft.reason === 'OTHER' && draft.note.trim().length === 0 ? t('held.noteNeeded') : dialog.busy ? t('held.busy') : null
  const submit = () => actions?.onSubmitDialog?.()
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t('closeRequest.title', { machine: record?.request.machine.assetNumber ?? '—' })}
      size="md"
      footer={<Footer hint={t('closeRequest.hint')} held={held} busy={dialog.busy} label={t('closeRequest.submit')} icon={<X size={14} aria-hidden />} onCancel={() => actions?.onDialogClose?.()} onSubmit={submit} />}
    >
      <form
        className="fw-pl-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) submit()
        }}
        onKeyDown={submitKeys(held, submit)}
      >
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        <div className="fw-pl-choices" role="radiogroup" aria-label={t('closeRequest.reason')}>
          {CLOSE_REASONS.map((reason) => (
            <RadioCard key={reason} name="close-reason" value={reason} checked={draft.reason === reason} selected={draft.reason === reason} onChange={() => actions?.onCloseDraft?.({ reason })} title={t(`closeReason.${reason}`)} description={t(`closeReasonHint.${reason}`)} />
          ))}
        </div>
        <Field label={t('field.note')} required={draft.reason === 'OTHER'} hint={draft.reason === 'OTHER' ? t('closeRequest.noteOther') : t('closeRequest.noteHint')}>
          <Textarea value={draft.note} rows={2} maxLength={500} onChange={(event) => actions?.onCloseDraft?.({ note: event.target.value })} />
        </Field>
        {dialog.machineDown && <Checkbox checked={draft.keepDown} onChange={(event) => actions?.onCloseDraft?.({ keepDown: event.target.checked })} label={t('closeRequest.keepDown')} />}
        {dialog.machineDown && <p className="fw-pl-hint">{draft.keepDown ? t('closeRequest.keepDownYes') : t('closeRequest.keepDownNo')}</p>}
      </form>
    </Modal>
  )
}

// ---- Sign safe (H1): the ONE dialog, shared with the job's Unsafe lock panel ----------------------------------------------

function RequestSignSafe({ model, actions }: { model: RequestsListModel; actions?: RequestsListActions }) {
  const t = useWords()
  const dialog = model.dialog as Extract<NonNullable<RequestsListModel['dialog']>, { kind: 'signSafe' }>
  const record = recordOf(model)
  const held = !model.can.signSafe ? t('held.noSignSafe') : dialog.draft.note.trim().length === 0 ? t('held.checkedNeeded') : dialog.busy ? t('held.busy') : null
  return (
    <SignSafeDialog
      machine={record?.request.machine.assetNumber ?? '—'}
      draft={dialog.draft}
      held={held}
      busy={dialog.busy}
      problem={dialog.problem}
      onDraft={actions?.onSignSafeDraft}
      onSubmit={actions?.onSubmitDialog}
      onClose={actions?.onDialogClose}
    />
  )
}

// ---- Merge requests (B-W2b-140; design pop:merge) ------------------------------------------------------------------------

/**
 * Target: the suggested open job or request of the same machine (or another of the group); the requests that go into it,
 * each one a tick (a request that still locks its machine joins a job but never another request: H1). "Merge 3"; every
 * reporter keeps their request, follows the one kept and confirms on their own.
 */
function MergeManyDialog({ model, actions }: { model: RequestsListModel; actions?: RequestsListActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const dialog = model.dialog as Extract<NonNullable<RequestsListModel['dialog']>, { kind: 'mergeMany' }>
  const { group, draft } = dialog
  const sources = mergeSources(group, draft)
  const heldKey = mergeHeld(group, draft, model.can, dialog.busy)
  const held = heldKey ? t(heldKey) : null
  const submit = () => !held && actions?.onSubmitDialog?.()
  const requestOf = (id: string) => group.requests.find((request) => request.id === id)
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t('mergeMany.title', { machine: group.machine.assetNumber })}
      size="lg"
      footer={<Footer hint={t('mergeMany.hint')} held={held} busy={dialog.busy} label={sources.length > 0 ? t('mergeMany.submit', { count: sources.length }) : t('mergeMany.open')} icon={<GitMerge size={14} aria-hidden />} onCancel={() => actions?.onDialogClose?.()} onSubmit={submit} />}
    >
      <div className="fw-pl-dialog" onKeyDown={submitKeys(held, submit)}>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        <p className="fw-pl-text">{t('mergeMany.body', { count: group.requests.length, class: labelOf(group.machine.class, locale), machine: group.machine.assetNumber, age: ageWords(t, group.withinMinutes) })}</p>
        <p className="fw-pl-h3">{t('mergeMany.target')}</p>
        <div className="fw-pl-choices" role="radiogroup" aria-label={t('mergeMany.target')}>
          {targetsOf(group).map((target) => {
            const key = targetKey(target)
            const request = target.kind === 'REQUEST' ? requestOf(target.id) : undefined
            const suggested = key === targetKey(group.suggested)
            const title = target.kind === 'JOB' ? t('mergeMany.intoJob', { number: target.number }) : request ? t('mergeMany.intoRequest', { when: formatDateTime(request.reportedAt, place) }) : '—'
            const description = [suggested ? t('mergeMany.suggested') : null, target.kind === 'JOB' ? t('mergeMany.intoJobHint') : request ? `${personWords(t, request.reportedBy)}${request.locking ? ` · ${t('unsafe.tag')}` : ''}` : null].filter(Boolean).join(' · ')
            return <RadioCard key={key} name="merge-target" value={key} checked={draft.target === key} selected={draft.target === key} onChange={() => actions?.onMergeDraft?.(retarget(group, { target: key, picked: draft.picked }))} title={title} description={description} />
          })}
        </div>
        <p className="fw-pl-h3">{t('mergeMany.which')}</p>
        <ul className="fw-pd-pick">
          {group.requests.map((request) => {
            const why = sourceHeld(request, draft)
            const picked = why === null && draft.picked.includes(request.id)
            return (
              <li key={request.id}>
                <Checkbox
                  checked={picked}
                  disabled={why !== null}
                  onChange={(event) => actions?.onMergeDraft?.({ target: draft.target, picked: event.target.checked ? [...draft.picked, request.id] : draft.picked.filter((id) => id !== request.id) })}
                  label={<SymptomText symptom={request.symptom} description={request.description} />}
                />
                <span className="fw-pl-sub">
                  {formatDateTime(request.reportedAt, place)} · {personWords(t, request.reportedBy)}
                  {why ? ` · ${t(why)}` : ''}
                </span>
              </li>
            )
          })}
        </ul>
        <p className="fw-pl-hint">{t('mergeMany.reporters')}</p>
      </div>
    </Modal>
  )
}

// ---- Lock as unsafe (B-W2b-140; design pop:lock, a confirm) -----------------------------------------------------------------

/**
 * The reach in words — the machine becomes do-not-use on its station, the planning board and every list; no work is sent
 * to it; a hazard report (Incidents) — and the reversal: only a technician signs it safe (D.Lgs. 81/2008 art. 71). Enter
 * locks, Esc cancels. Composed on the DS Modal: the DS ActionConfirm has no busy state and no refusal of the server.
 */
function LockDialog({ model, actions }: { model: RequestsListModel; actions?: RequestsListActions }) {
  const t = useWords()
  const ds = useDsWords()
  const dialog = model.dialog as Extract<NonNullable<RequestsListModel['dialog']>, { kind: 'lock' }>
  const record = recordOf(model)
  const machine = record?.request.machine.assetNumber ?? '—'
  const held = !model.can.report ? t('held.noReport') : dialog.busy ? t('held.busy') : null
  const submit = () => !held && actions?.onSubmitDialog?.()
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t('lockAsUnsafe.title', { machine })}
      size="md"
      footer={<Footer hint={t('lockAsUnsafe.keys')} held={held} busy={dialog.busy} label={t('lockAsUnsafe.submit')} icon={<Lock size={14} aria-hidden />} danger onCancel={() => actions?.onDialogClose?.()} onSubmit={submit} />}
    >
      <form
        className="fw-pl-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => {
          // Enter confirms from the note (which holds the focus when the dialog opens); a button keeps its own Enter.
          if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
            event.preventDefault()
            submit()
          }
        }}
      >
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        <p className="fw-pl-h3">{t('lockAsUnsafe.reachTitle')}</p>
        <ul className="fw-pl-list">
          <li>{t('lockAsUnsafe.reach.station', { machine })}</li>
          <li>{t('lockAsUnsafe.reach.lists')}</li>
          <li>{t('lockAsUnsafe.reach.dispatch')}</li>
          <li>{t('lockAsUnsafe.reach.request')}</li>
          <li>{t('lockAsUnsafe.reach.hazard')}</li>
        </ul>
        <p className="fw-pl-row">
          <LawRef law="D.Lgs. 81/2008 art. 71" plain={t('lockAsUnsafe.lawPlain')} labels={ds.lawRef} />
          <span className="fw-pl-text">{t('lockAsUnsafe.reversal')}</span>
        </p>
        <Field label={t('lockAsUnsafe.note')} hint={t('lockAsUnsafe.noteHint')}>
          <Input value={dialog.note} maxLength={500} data-autofocus onChange={(event) => actions?.onLockNote?.(event.target.value)} />
        </Field>
      </form>
    </Modal>
  )
}

// ---- Report a problem --------------------------------------------------------------------------------------------------------

function ReportDialog({ model, actions }: { model: RequestsListModel; actions?: RequestsListActions }) {
  const t = useWords()
  const locale = useLocale()
  const reasonWords = useReasonWords()
  const photoWords = usePhotoWords()
  const dialog = model.dialog as Extract<NonNullable<RequestsListModel['dialog']>, { kind: 'report' }>
  const draft = dialog.draft
  const [query, setQuery] = useState(draft.query)
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onFindMachine?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])

  const symptom: Symptom | null = (dialog.symptoms ?? []).find((entry) => entry.id === draft.symptomId) ?? null
  const tiles = useMemo<ReasonTile[]>(
    () =>
      (dialog.symptoms ?? []).map((entry) => {
        const Icon = iconOf(entry.icon)
        return { id: entry.id, label: labelOf(entry, locale), hint: entry.unsafe ? t('report.unsafeSymptom') : entry.needsDetail ? t('report.needsWords') : undefined, icon: <Icon size={22} aria-hidden />, tone: entry.unsafe ? 'danger' : 'neutral' }
      }),
    [dialog.symptoms, locale, t],
  )
  const unsafe = draft.unsafe || (symptom?.unsafe ?? false)
  const needWords = (symptom?.needsDetail ?? false) || (!symptom && draft.description.trim().length === 0)
  const held = !model.can.report
    ? t('held.noReport')
    : !draft.machine
      ? t('held.machineNeeded')
      : draft.machine.status === 'RETIRED'
        ? t('held.machineRetired')
        : needWords && draft.description.trim().length === 0
          ? t(symptom ? 'held.wordsNeeded' : 'held.symptomOrWords')
          : dialog.busy
            ? t('held.busy')
            : null
  const submit = () => actions?.onSubmitDialog?.()

  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t('report.title')}
      size="lg"
      footer={
        <Footer
          hint={unsafe ? t('report.footUnsafe') : draft.down ? t('report.footDown') : t('report.foot')}
          held={held}
          busy={dialog.busy}
          label={t('report.submit')}
          icon={<TriangleAlert size={14} aria-hidden />}
          danger={unsafe}
          onCancel={() => actions?.onDialogClose?.()}
          onSubmit={submit}
        />
      }
    >
      <form
        className="fw-pl-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) submit()
        }}
        onKeyDown={submitKeys(held, submit)}
      >
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        <p className="fw-pl-h3">{t('report.step1')}</p>
        <div className="fw-pl-form">
          <Field label={t('report.find')} hint={t('report.findHint')}>
            <Input
              type="search"
              leadingIcon={dialog.searching ? <Spinner size={12} /> : <Search size={13} aria-hidden />}
              value={query}
              placeholder={t('report.findPlaceholder')}
              onChange={(event) => {
                typed.current = true
                setQuery(event.target.value)
                actions?.onReportDraft?.({ query: event.target.value })
              }}
            />
          </Field>
          <Field label={t('report.machine')} required>
            <Select
              value={draft.machine?.id ?? ''}
              disabled={!dialog.found || dialog.found.length === 0}
              onChange={(event) => actions?.onReportDraft?.({ machine: dialog.found?.find((entry) => entry.id === event.target.value) ?? null, symptomId: null })}
            >
              <option value="">{dialog.found === null ? t('report.findFirst') : dialog.found.length === 0 ? t('report.noneFound') : t('report.pick')}</option>
              {draft.machine && !dialog.found?.some((entry) => entry.id === draft.machine?.id) && <option value={draft.machine.id}>{`${draft.machine.assetNumber} · ${labelOf(draft.machine.class, locale)}`}</option>}
              {(dialog.found ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`${entry.assetNumber} · ${labelOf(entry.class, locale)}${entry.station ? ` · ${entry.station.code}` : ''}`}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {draft.machine && (
          <p className="fw-pl-row">
            <MachinePill status={draft.machine.status} locked={draft.machine.locked} />
            <span className="fw-pl-hint">{[draft.machine.make, draft.machine.modelName, draft.machine.station ? `${draft.machine.station.code} · ${draft.machine.station.name}` : null].filter(Boolean).join(' · ')}</span>
          </p>
        )}

        <p className="fw-pl-h3">{t('report.step2')}</p>
        {!draft.machine ? (
          <p className="fw-pl-hint">{t('report.machineFirst')}</p>
        ) : dialog.symptoms === null ? (
          <p className="fw-pl-hint" role="status">
            <Spinner size={12} /> {t('report.symptomsLoading')}
          </p>
        ) : (
          <ReasonGrid label={t('report.symptom')} reasons={tiles} value={draft.symptomId} onChange={(id) => actions?.onReportDraft?.({ symptomId: draft.symptomId === id ? null : id })} words={reasonWords} locale={locale} />
        )}
        <div className="fw-pl-form">
          <Field label={t('report.words')} required={needWords} hint={needWords ? t('report.wordsNeeded') : t('report.wordsHint')} className="wide">
            <Textarea value={draft.description} rows={2} maxLength={2000} onChange={(event) => actions?.onReportDraft?.({ description: event.target.value })} />
          </Field>
          <Checkbox checked={draft.down} onChange={(event) => actions?.onReportDraft?.({ down: event.target.checked })} label={t('report.down')} />
          <Checkbox
            tone="danger"
            checked={unsafe}
            disabled={symptom?.unsafe ?? false}
            onChange={(event) => actions?.onReportDraft?.({ unsafe: event.target.checked })}
            label={symptom?.unsafe ? t('report.unsafeBySymptom') : t('report.unsafe')}
          />
        </div>
        {unsafe && (
          <Banner tone="danger" title={t('report.unsafeTitle')}>
            {t('report.unsafeBody')}
          </Banner>
        )}

        <p className="fw-pl-h3">{t('report.step3')}</p>
        {draft.photo ? (
          <p className="fw-pl-row">
            <Camera size={14} aria-hidden /> <span>{t('report.photoReady', { width: draft.photo.width, height: draft.photo.height })}</span>
            <Button size="sm" variant="quiet" onClick={() => actions?.onReportDraft?.({ photo: null })}>
              {t('report.photoRemove')}
            </Button>
          </p>
        ) : draft.photoStep ? (
          <PhotoCapture
            label={t('report.photoLabel')}
            words={photoWords}
            onCapture={(photo) => actions?.onReportDraft?.({ photo, photoStep: false })}
            onCancel={() => actions?.onReportDraft?.({ photoStep: false })}
            heldReason={model.can.upload ? null : t('held.noUpload')}
          />
        ) : (
          <span className="fw-pl-row">
            <Button size="sm" heldReason={model.can.upload ? null : t('held.noUpload')} onClick={() => actions?.onReportDraft?.({ photoStep: true })}>
              <Camera size={14} aria-hidden /> {t('report.addPhoto')}
            </Button>
            <span className="fw-pl-hint">{t('report.photoHint')}</span>
          </span>
        )}
      </form>
    </Modal>
  )
}
