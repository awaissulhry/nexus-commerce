'use client'

import { useMemo, type ReactNode } from 'react'
import { Banner, Field, KeyValue, MultiSelect, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Checkbox, Input, Pill, RadioCard, Select, Spinner, Tag } from '@nexus/ui/primitives'
import type { ReviewChange } from '@nexus/ui/patterns'
import { ActionConfirm, DateField, DetailModal, Modal, ReviewChangesModal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { minutesOfHours, TIME_ZONE } from '../../_shared/model'
import type { CheckedPerson, LimitWarning, OvertimePerson, PlanChange, PlanPreview, ShiftChoice } from '../api'
import { clockFull, dayLong, dayShort, hoursWords, minuteOfClock, overtimeHeld, rangeText, STAGE_TONE, valueWords, warningWords } from '../model'
import type { AssignDraft, OvertimeDraft, RequestState, ReviewPhase, ShiftsActions, ShiftsDialog, ShiftsModel } from '../view-model'
import { said, useShiftWords, type ShiftWords } from './parts'
import { shiftOptions } from './RosterSheet'

/**
 * Every pop-up of People › Shifts: Assign shifts (who, days, which shift; "Only these days" or the person's "Default shift")
 * → the review of the cells that change; Copy last week; Publish; Request overtime (each person with their limit check);
 * one overtime request (its people and answers, Ask, Approve, record a spoken answer, Cancel). A worker's yes is theirs:
 * overtime is never automatic (D.Lgs. 66/2003 art. 5), the lead records what the person said.
 */

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

export function ShiftDialogs({ model, actions }: { model: ShiftsModel; actions?: ShiftsActions | undefined }) {
  const dialog = model.dialog
  return (
    <>
      {dialog?.kind === 'assign' && <AssignDialog draft={dialog.draft} model={model} actions={actions} />}
      {dialog?.kind === 'assign-review' && <AssignReview dialog={dialog} actions={actions} />}
      {dialog?.kind === 'default-review' && <DefaultReview dialog={dialog} model={model} actions={actions} />}
      {dialog?.kind === 'copy' && <CopyReview dialog={dialog} actions={actions} />}
      {dialog?.kind === 'publish' && <PublishConfirm dialog={dialog} model={model} actions={actions} />}
      {dialog?.kind === 'overtime' && <OvertimeDialog draft={dialog.draft} model={model} actions={actions} />}
      {model.request && <RequestDialog state={model.request} model={model} actions={actions} />}
    </>
  )
}

// ---- Assign shifts --------------------------------------------------------------------------------------------------------

/** Why Review is held, in words, or null. */
export function assignHeld(draft: AssignDraft, t: ShiftWords): string | null {
  if (draft.people.length === 0) return t('held.noPeopleToAssign')
  if (draft.mode === 'default') return draft.option && draft.option !== 'off' ? null : t('held.pickPattern')
  if (!draft.option) return t('held.pickShift')
  if (draft.from > draft.to) return t('held.badRange')
  if (draft.weekdays.length === 0) return t('held.pickWeekday')
  return null
}

function AssignDialog({ draft, model, actions }: { draft: AssignDraft; model: ShiftsModel; actions?: ShiftsActions | undefined }) {
  const t = useShiftWords()
  const locale = useLocale()
  const options = useMemo(() => (draft.mode === 'default' ? uniquePatterns(model.choices) : shiftOptions(model.choices, t)), [draft.mode, model.choices, t])
  const held = assignHeld(draft, t)
  const defaultHeld = model.can.defaultShift ? null : t('held.noDefaultShift')
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog()}
      title={t('assign.title')}
      size="lg"
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onCloseDialog()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => actions?.onAssignReview()} heldReason={draft.busy ? t('common.busy') : held}>
            {t('assign.review', { count: draft.people.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pp-stack">
        {draft.problem && <Banner tone="danger" title={t(draft.problem)} />}
        <div>
          <p className="fw-pp-text">{t('assign.people', { count: draft.people.length })}</p>
          <p className="fw-pp-hint">{draft.people.slice(0, 8).map((person) => person.name).join(', ')}{draft.people.length > 8 ? ` ${t('assign.andMore', { count: draft.people.length - 8 })}` : ''}</p>
          {draft.leftOut > 0 && <p className="fw-pp-hint">{t('assign.leftOut', { count: draft.leftOut })}</p>}
        </div>
        <div className="fw-pp-stack tight" role="radiogroup" aria-label={t('assign.mode')}>
          <RadioCard name="assign-mode" title={t('assign.modeDays')} description={t('assign.modeDaysHint')} checked={draft.mode === 'days'} selected={draft.mode === 'days'} onChange={() => actions?.onAssignDraft({ mode: 'days', option: '' })} />
          <RadioCard
            name="assign-mode"
            title={t('assign.modeDefault')}
            description={defaultHeld ?? t('assign.modeDefaultHint')}
            checked={draft.mode === 'default'}
            selected={draft.mode === 'default'}
            disabled={defaultHeld !== null}
            onChange={() => actions?.onAssignDraft({ mode: 'default', option: '' })}
          />
        </div>
        <Field label={draft.mode === 'default' ? t('assign.pattern') : t('assign.shift')} required>
          <Select value={draft.option} onChange={(event) => actions?.onAssignDraft({ option: event.target.value })}>
            <option value="">{t('assign.choose')}</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        {draft.mode === 'days' && (
          <>
            <div className="fw-rs-pair">
              <Field label={t('assign.from')} required>
                <DateField value={draft.from} onChange={(value) => actions?.onAssignDraft({ from: value ?? draft.from })} />
              </Field>
              <Field label={t('assign.to')} required>
                <DateField value={draft.to} onChange={(value) => actions?.onAssignDraft({ to: value ?? draft.to })} />
              </Field>
            </div>
            <fieldset className="fw-rs-weekdays">
              <legend>{t('assign.weekdays')}</legend>
              {WEEKDAYS.map((weekday) => (
                <Checkbox
                  key={weekday}
                  label={new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, weekday)))}
                  checked={draft.weekdays.includes(weekday)}
                  onChange={(event) => actions?.onAssignDraft({ weekdays: event.target.checked ? [...draft.weekdays, weekday].sort() : draft.weekdays.filter((day) => day !== weekday) })}
                />
              ))}
            </fieldset>
            <Checkbox label={t('assign.closedToo')} checked={draft.closedToo} onChange={(event) => actions?.onAssignDraft({ closedToo: event.target.checked })} />
          </>
        )}
      </div>
    </Modal>
  )
}

/** Each pattern once, for a person's default shift. */
function uniquePatterns(choices: readonly ShiftChoice[]): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>()
  for (const choice of choices) if (!seen.has(choice.patternId)) seen.set(choice.patternId, `${choice.patternCode} · ${choice.patternName}`)
  return [...seen].map(([value, label]) => ({ value, label }))
}

function reviewRows(preview: PlanPreview | null, t: ShiftWords, locale: string): ReviewChange[] {
  return (preview?.changes ?? []).map((change: PlanChange) => ({
    id: `${change.employeeId}-${change.date}`,
    where: change.name,
    what: dayLong(change.date, locale),
    now: `${said(t, valueWords(change.from))}${change.fromSource === 'DEFAULT' ? ` ${t('review.defaultMark')}` : ''}`,
    next: `${said(t, valueWords(change.to))}${change.toSource === 'DEFAULT' ? ` ${t('review.defaultMark')}` : ''}`,
  }))
}

/** What the plan leaves out and what it warns of: one sentence each, person and day named (inside one review). */
function PlanNotes({ preview }: { preview: PlanPreview | null }) {
  const t = useShiftWords()
  const locale = useLocale()
  if (!preview) return null
  return (
    <div className="fw-pp-stack tight">
      {!preview.absences.shown && <p className="fw-pp-hint">{t('review.absencesOff')}</p>}
      {preview.skipped.length > 0 && (
        <details>
          <summary>{t('review.skipped', { count: preview.skipped.length })}</summary>
          <ul className="fw-pp-list">
            {preview.skipped.slice(0, 60).map((entry) => (
              <li key={`${entry.employeeId}-${entry.date}`}>{t(`skip.${entry.why}`, { name: entry.name, day: dayShort(entry.date, locale) })}</li>
            ))}
          </ul>
        </details>
      )}
      {preview.warnings.length > 0 && (
        <details open>
          <summary>{t('review.warnings', { count: preview.warnings.length })}</summary>
          <ul className="fw-pp-list">
            {preview.warnings.slice(0, 60).map((entry) => (
              <li key={`${entry.employeeId}-${entry.warning.rule}-${entry.warning.date}`}>
                <b>{entry.name}</b> · {said(t, warningWords(entry.warning, locale))}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

const reviewState = (review: ReviewPhase, t: ShiftWords, changes: readonly ReviewChange[], saved: string) =>
  review.phase === 'failed'
    ? { phase: 'failed' as const, error: t(review.problem) }
    : review.phase === 'done'
      ? { phase: 'done' as const, results: Object.fromEntries(changes.map((change) => [change.id, { ok: true, words: saved }])) }
      : review.phase === 'saving'
        ? { phase: 'saving' as const }
        : review.phase === 'reading'
          ? { phase: 'reading' as const }
          : { phase: 'ready' as const }

function AssignReview({ dialog, actions }: { dialog: Extract<ShiftsDialog, { kind: 'assign-review' }>; actions?: ShiftsActions | undefined }) {
  const t = useShiftWords()
  const locale = useLocale()
  const changes = useMemo(() => reviewRows(dialog.preview, t, locale), [dialog.preview, t, locale])
  const blocked = dialog.preview?.blocked ?? 0
  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.onCloseDialog()}
      changes={changes}
      state={reviewState(dialog.review, t, changes, t('review.saved'))}
      title={t('assign.reviewTitle')}
      summary={t('review.summary')}
      lead={<PlanNotes preview={dialog.preview} />}
      problems={blocked > 0 ? [t('review.blocked', { count: blocked })] : []}
      saveLabel={t('assign.apply', { count: dialog.preview?.people ?? dialog.draft.people.length })}
      onSave={() => actions?.onAssignSave()}
      onRetry={() => actions?.onAssignReview()}
      {...(dialog.review.phase === 'done' ? { onUndo: () => actions?.onAssignUndo() } : {})}
      doneActions={
        dialog.review.phase !== 'done' ? (
          <Button variant="quiet" onClick={() => actions?.onAssignBack()}>
            {t('common.back')}
          </Button>
        ) : undefined
      }
      size="xl"
    />
  )
}

function DefaultReview({ dialog, model, actions }: { dialog: Extract<ShiftsDialog, { kind: 'default-review' }>; model: ShiftsModel; actions?: ShiftsActions | undefined }) {
  const t = useShiftWords()
  const next = model.choices.find((choice) => choice.patternId === dialog.draft.option)
  const changes = useMemo<ReviewChange[]>(
    () =>
      dialog.draft.people
        .filter((person) => person.defaultPattern?.id !== dialog.draft.option)
        .map((person) => ({ id: person.id, where: person.name, what: t('assign.defaultWhat'), now: person.defaultPattern ? person.defaultPattern.name : t('review.noDefault'), next: next?.patternName ?? '' })),
    [dialog.draft, next, t],
  )
  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.onCloseDialog()}
      changes={changes}
      state={reviewState(dialog.review, t, changes, t('review.saved'))}
      title={t('assign.defaultTitle')}
      summary={t('assign.defaultSummary')}
      lead={
        dialog.refused.length > 0 ? (
          <ul className="fw-pp-list">
            {dialog.refused.map((entry) => (
              <li key={entry.name}>
                <b>{entry.name}</b> — {t(entry.words)}
              </li>
            ))}
          </ul>
        ) : undefined
      }
      saveLabel={t('assign.apply', { count: changes.length })}
      onSave={() => actions?.onAssignSave()}
    />
  )
}

function CopyReview({ dialog, actions }: { dialog: Extract<ShiftsDialog, { kind: 'copy' }>; actions?: ShiftsActions | undefined }) {
  const t = useShiftWords()
  const locale = useLocale()
  const changes = useMemo(() => reviewRows(dialog.preview, t, locale), [dialog.preview, t, locale])
  const blocked = dialog.preview?.blocked ?? 0
  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.onCloseDialog()}
      changes={changes}
      state={reviewState(dialog.review, t, changes, t('review.saved'))}
      title={t('copy.title')}
      summary={t('copy.summary', { source: rangeText(dialog.source, locale), target: rangeText(dialog.target, locale) })}
      lead={<PlanNotes preview={dialog.preview} />}
      problems={blocked > 0 ? [t('review.blocked', { count: blocked })] : []}
      saveLabel={t('copy.apply', { count: changes.length })}
      onSave={() => actions?.onCopySave()}
      onRetry={() => actions?.onCopyRetry()}
      {...(dialog.review.phase === 'done' ? { onUndo: () => actions?.onCopyUndo() } : {})}
      size="xl"
    />
  )
}

function PublishConfirm({ dialog, model, actions }: { dialog: Extract<ShiftsDialog, { kind: 'publish' }>; model: ShiftsModel; actions?: ShiftsActions | undefined }) {
  const t = useShiftWords()
  const locale = useLocale()
  return (
    <ActionConfirm
      impact={{
        level: 'confirm',
        reach: 'local',
        title: t('publish.title', { count: dialog.drafts, range: rangeText(model.range, locale) }),
        confirmLabel: t('publish.apply', { count: dialog.drafts }),
        consequences: [t('publish.floor', { count: dialog.people }), t('publish.changes')],
        reversal: { verb: t('publish.reversal'), fidelity: 'exact' },
        ...(dialog.problem ? { refusal: { reason: t(dialog.problem) } } : {}),
      }}
      onConfirm={() => actions?.onPublishSave()}
      onCancel={() => actions?.onCloseDialog()}
    />
  )
}

// ---- Request overtime -----------------------------------------------------------------------------------------------------

/** The person's limit check in the page's words (with the law). */
function ChecksLine({ checks }: { checks: readonly LimitWarning[] }) {
  const t = useShiftWords()
  const locale = useLocale()
  const ds = useDsWords()
  if (checks.length === 0) return <span className="fw-pp-hint">{t('ot.personOk')}</span>
  return (
    <ul className="fw-pp-list">
      {checks.map((check) => (
        <li key={`${check.rule}-${check.date}`} className={check.level === 'BLOCK' ? 'fw-rs-check is-block' : 'fw-rs-check'}>
          <Tag tone={check.level === 'BLOCK' ? 'danger' : 'warning'}>{t(check.level === 'BLOCK' ? 'ot.held' : 'ot.warned')}</Tag> {said(t, warningWords(check, locale))} <LawRef law={check.law} plain={t(`law.${check.rule}`)} labels={ds.lawRef} />
        </li>
      ))}
    </ul>
  )
}

/** What is missing before anyone is asked, in words; null: ready. */
export function overtimeProblems(draft: OvertimeDraft, t: ShiftWords): { field: Record<string, string>; held: string | null } {
  const field: Record<string, string> = {}
  const minutes = minutesOfHours(draft.hours)
  if (!draft.hours.trim() || minutes === undefined || minutes === null) field.hours = t('ot.problem.hours')
  else if (minutes < 1 || minutes > 720) field.hours = t('ot.problem.hoursRange')
  if (minuteOfClock(draft.start) === undefined) field.start = t('ot.problem.start')
  if (!draft.reason.trim()) field.reason = t('ot.problem.reason')
  if (draft.picked.length === 0) field.people = t('ot.problem.people')
  const blocked = Object.values(draft.checks ?? {}).some((person) => draft.picked.includes(person.employeeId) && person.checks.some((check) => check.level === 'BLOCK'))
  const held = !draft.siteId ? t('held.pickSite') : Object.keys(field).length > 0 ? Object.values(field)[0]! : blocked ? t('held.limitBlocks') : null
  return { field, held }
}

function OvertimeDialog({ draft, model, actions }: { draft: OvertimeDraft; model: ShiftsModel; actions?: ShiftsActions | undefined }) {
  const t = useShiftWords()
  const problems = overtimeProblems(draft, t)
  const shown = draft.tried ? problems.field : {}
  const people = useMemo(
    () => model.rows.flatMap((row) => (row.kind === 'person' && (!draft.lineId || row.row.line?.id === draft.lineId) && (!draft.siteId || row.row.site.id === draft.siteId) ? [{ value: row.row.employeeId, label: row.row.name }] : [])),
    [model.rows, draft.lineId, draft.siteId],
  )
  const named = (id: string) => people.find((person) => person.value === id)?.label ?? draft.checks?.[id]?.name ?? ''
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog()}
      title={t('ot.newTitle')}
      subtitle={t('ot.newHint')}
      size="xl"
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onCloseDialog()}>
            {t('common.cancel')}
          </Button>
          <span className="grow" />
          <Button variant="secondary" onClick={() => actions?.onOvertimeSave(false)} heldReason={draft.busy ? t('common.busy') : (draft.tried ? problems.held : null)}>
            {t('ot.saveDraft')}
          </Button>
          <Button variant="primary" onClick={() => actions?.onOvertimeSave(true)} heldReason={draft.busy ? t('common.busy') : (draft.tried ? problems.held : null)}>
            {t('ot.askPeople', { count: draft.picked.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pp-stack">
        {draft.problem && <Banner tone="danger" title={t(draft.problem)} />}
        {!draft.siteId && <Banner tone="info" title={t('held.pickSite')} />}
        <div className="fw-rs-form">
          <Field label={t('ot.date')} required>
            <DateField value={draft.date} onChange={(value) => actions?.onOvertimeDraft({ date: value ?? draft.date })} />
          </Field>
          <Field label={t('ot.line')}>
            <Select value={draft.lineId ?? ''} onChange={(event) => actions?.onOvertimeDraft({ lineId: event.target.value || null })}>
              <option value="">{t('ot.anyLine')}</option>
              {model.lines.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.code} · {line.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('ot.hoursEach')} required error={shown.hours} hint={t('ot.hoursHint')}>
            <Input value={draft.hours} inputMode="decimal" onChange={(event) => actions?.onOvertimeDraft({ hours: event.target.value })} />
          </Field>
          <Field label={t('ot.start')} error={shown.start} hint={t('ot.startHint')}>
            <Input value={draft.start} placeholder="18:00" onChange={(event) => actions?.onOvertimeDraft({ start: event.target.value })} />
          </Field>
        </div>
        <Field label={t('ot.reason')} required error={shown.reason}>
          <Textarea rows={2} honourRows value={draft.reason} maxLength={500} onChange={(event) => actions?.onOvertimeDraft({ reason: event.target.value })} />
        </Field>
        <Field label={t('ot.pick')} required error={shown.people} hint={t('ot.pickHint')}>
          <MultiSelect options={people} value={[...draft.picked]} onChange={(next) => actions?.onOvertimeDraft({ picked: next })} placeholder={t('ot.pickNone')} formatLabel={(value) => t('ot.picked', { count: value.length })} searchable width="auto" ariaLabel={t('ot.pick')} />
        </Field>
        {draft.picked.length > 0 && (
          <div>
            {draft.checking && (
              <p className="fw-pp-hint" role="status">
                <Spinner size={12} /> {t('ot.checking')}
              </p>
            )}
            <SummaryTable label={t('ot.checksTitle')} columns={[t('ot.person'), t('ot.limits')]} align={['left', 'left']} rows={draft.picked.map((id) => ({ id, cells: [named(id), <PersonChecks key={id} checks={draft.checks?.[id]} />] }))} />
            <p className="fw-pp-hint">{t('ot.capHint')}</p>
          </div>
        )}
      </div>
    </Modal>
  )
}

function PersonChecks({ checks }: { checks: CheckedPerson | undefined }) {
  const t = useShiftWords()
  if (!checks) return <span className="fw-pp-hint">{t('ot.notChecked')}</span>
  return <ChecksLine checks={checks.checks} />
}

// ---- one overtime request -------------------------------------------------------------------------------------------------

function RequestDialog({ state, model, actions }: { state: RequestState; model: ShiftsModel; actions?: ShiftsActions | undefined }) {
  const t = useShiftWords()
  const locale = useLocale()
  const close = () => actions?.onOpenRequest(null)
  if (state.status !== 'ready') {
    return <DetailModal open onClose={close} title={t('ot.record')} {...(state.status === 'loading' ? { loading: true } : { error: t(state.problem) })} />
  }
  const { record, busy } = state
  const request = record.request
  const time = (at: string) => formatDateTime(at, { locale, timeZone: TIME_ZONE })
  const held = (action: Parameters<typeof overtimeHeld>[0]) => {
    const key = overtimeHeld(action, request)
    return key ? t(key) : null
  }
  const answerHeld = !record.canManage ? t('held.noOvertime') : held('ANSWER')
  const peopleHeld = !record.canManage ? t('held.noOvertime') : held('ADD_PEOPLE')
  const actionsBar: ReactNode = (
    <>
      {record.canManage && request.status === 'DRAFT' && (
        <Button size="sm" variant="primary" onClick={() => actions?.onRequestAsk()} heldReason={busy ? t('common.busy') : held('ASK')}>
          {t('ot.askPeople', { count: request.counts.asked })}
        </Button>
      )}
      {record.canApprove && (request.status === 'ASKED' || request.status === 'AGREED') && (
        <Button size="sm" variant="primary" onClick={() => actions?.onRequestApprove()} heldReason={busy ? t('common.busy') : held('APPROVE')}>
          {t('ot.approve')}
        </Button>
      )}
      {record.canManage && (
        <Button size="sm" variant="quiet" onClick={() => actions?.onRequestCancelling('')} heldReason={held('CANCEL')}>
          {t('ot.cancel')}
        </Button>
      )}
    </>
  )
  const addable = model.rows.flatMap((row) => (row.kind === 'person' && row.row.site.id === request.site.id && !record.people.some((person) => person.employeeId === row.row.employeeId) ? [{ value: row.row.employeeId, label: row.row.name }] : []))
  return (
    <DetailModal
      open
      onClose={close}
      title={t('ot.recordTitle', { day: dayLong(request.date, locale) })}
      subtitle={request.reason}
      meta={
        <span className="fw-pp-chips">
          <Pill tone={STAGE_TONE[request.stage]} dot>
            {t(`stage.${request.stage}`)}
          </Pill>
          <Tag>{request.line ? request.line.code : t('ot.anyLine')}</Tag>
          <Tag>{request.site.code}</Tag>
        </span>
      }
      actions={actionsBar}
    >
      <div className="fw-pp-stack">
        {state.problem && <Banner tone="danger" title={t(state.problem)} />}
        {request.status === 'APPROVED' && <Banner tone="success" title={t('ot.approvedNote')} />}
        {request.status === 'CANCELLED' && <Banner tone="info" title={t('ot.cancelledNote', { reason: request.cancelReason ?? '' })} />}
        <KeyValue
          columns={2}
          dense
          labelCase="sentence"
          items={[
            { label: t('ot.hoursEach'), value: `${hoursWords(request.minutes)}${request.startMinute !== null ? ` · ${clockFull(request.startMinute)}` : ''}` },
            { label: t('ot.asked'), value: t('ot.counts', { asked: request.counts.asked, agreed: request.counts.agreed, declined: request.counts.declined, pending: request.counts.pending }) },
            ...(request.askedAt ? [{ label: t('ot.askedBy'), value: `${request.askedBy ?? '—'} · ${time(request.askedAt)}` }] : []),
            ...(request.approvedAt ? [{ label: t('ot.approvedBy'), value: `${request.approvedBy ?? '—'} · ${time(request.approvedAt)}` }] : []),
          ]}
        />
        <SummaryTable
          label={t('ot.peopleTitle')}
          density="roomy"
          stackOnPhone
          columns={[t('ot.person'), t('ot.answer'), t('ot.limits'), '']}
          align={['left', 'left', 'left', 'right']}
          rows={record.people.map((person) => ({
            id: person.agreementId,
            cells: [person.name, <AnswerText key="answer" person={person} />, <ChecksLine key="checks" checks={person.checks} />, <AnswerButtons key="buttons" person={person} held={answerHeld} peopleHeld={peopleHeld} actions={actions} />],
          }))}
        />
        {record.canManage && peopleHeld === null && (
          state.picking ? (
            <div className="fw-pp-actions">
              <MultiSelect options={addable} value={state.picking.ids} onChange={(next) => actions?.onRequestPicking(next)} placeholder={t('ot.pickNone')} formatLabel={(value) => t('ot.picked', { count: value.length })} searchable width="auto" ariaLabel={t('ot.addPeople')} />
              <Button size="sm" variant="primary" onClick={() => actions?.onRequestAdd()} heldReason={busy ? t('common.busy') : (state.picking.ids.length > 0 ? null : t('ot.problem.people'))}>
                {t('ot.addCount', { count: state.picking.ids.length })}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => actions?.onRequestPicking(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => actions?.onRequestPicking([])} heldReason={addable.length > 0 ? null : t('held.nobodyToAdd')}>
              {t('ot.addPeople')}
            </Button>
          )
        )}
        {state.cancelling && (
          <div className="fw-pp-stack tight">
            <Field label={t('ot.cancelReason')} required>
              <Textarea rows={2} honourRows value={state.cancelling.reason} maxLength={500} onChange={(event) => actions?.onRequestCancelling(event.target.value)} />
            </Field>
            <span className="fw-pp-actions">
              <Button size="sm" variant="danger" onClick={() => actions?.onRequestCancel()} heldReason={busy ? t('common.busy') : (state.cancelling.reason.trim() ? null : t('ot.problem.reason'))}>
                {t('ot.cancelConfirm')}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => actions?.onRequestCancelling(null)}>
                {t('common.back')}
              </Button>
            </span>
          </div>
        )}
      </div>
    </DetailModal>
  )
}

function AnswerText({ person }: { person: OvertimePerson }) {
  const t = useShiftWords()
  const locale = useLocale()
  const when = person.answeredAt ? formatDateTime(person.answeredAt, { locale, timeZone: TIME_ZONE }) : null
  return (
    <span>
      <Pill tone={person.answer === 'AGREED' ? 'success' : person.answer === 'DECLINED' ? 'neutral' : 'info'} dot>
        {t(`answer.${person.answer}`)}
      </Pill>
      {when && <span className="fw-pp-hint"> {person.via === 'OFFICE' ? t('answer.viaOffice', { name: person.recordedBy ?? '—', when }) : t('answer.viaFloor', { when })}</span>}
    </span>
  )
}

function AnswerButtons({ person, held, peopleHeld, actions }: { person: OvertimePerson; held: string | null; peopleHeld: string | null; actions?: ShiftsActions | undefined }) {
  const t = useShiftWords()
  return (
    <span className="fw-pp-actions">
      <Button size="sm" variant="quiet" onClick={() => actions?.onRequestAnswer(person.agreementId, 'AGREED')} heldReason={held ?? (person.answer === 'AGREED' ? t('held.alreadySaid') : null)}>
        {t('ot.saidYes')}
      </Button>
      <Button size="sm" variant="quiet" onClick={() => actions?.onRequestAnswer(person.agreementId, 'DECLINED')} heldReason={held ?? (person.answer === 'DECLINED' ? t('held.alreadySaid') : null)}>
        {t('ot.saidNo')}
      </Button>
      {person.answer === 'PENDING' && peopleHeld === null && (
        <Button size="sm" variant="quiet" onClick={() => actions?.onRequestRemove(person.employeeId)}>
          {t('ot.remove')}
        </Button>
      )}
    </span>
  )
}
