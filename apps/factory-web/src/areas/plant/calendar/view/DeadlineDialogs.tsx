'use client'

import { useMemo } from 'react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { DEADLINE_KINDS, REPEAT_UNITS, type DeadlineKind } from '@nexus/factory-domain/safety/calendar/rules'
import { DateField, DetailModal, FileDropzone, FileRow, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { DueState } from '../../_shared/calendar/CalendarView'
import { ACCEPT, type Owner } from '../api'
import { atField, deadlineEdit, deadlineHeld, doneHeld, listRows, repeatWords, type DeadlineDraft, type Problem, type RepeatChoice } from '../model'
import type { CalendarPageActions, CalendarPageModel, DeadlineNewState, DeadlineOpenState, Read } from '../view-model'
import { problemText, say, useDay, useWords } from './parts'

/** The fields Add deadline and Edit share: title, type (new only), due, repeat, owner, evidence required. */
function DeadlineFields({ draft, owners, problem, onDraft, kindFixed = false }: { draft: DeadlineDraft; owners: Read<readonly Owner[]> | null; problem: Problem | null; onDraft: (draft: DeadlineDraft) => void; kindFixed?: boolean }) {
  const t = useWords()
  const error = (...fields: string[]) => {
    const key = atField(problem, ...fields)
    return key ? t(key) : undefined
  }
  return (
    <div className="fw-hs-form">
      <Field label={t('add.titleField')} required error={error('title')}>
        <Input value={draft.title} maxLength={200} placeholder={t('add.titlePlaceholder')} onChange={(event) => onDraft({ ...draft, title: event.target.value })} />
      </Field>
      <div className="fw-hs-form-row">
        <Field label={t('add.kind')} hint={kindFixed ? t('add.kindFixed') : undefined}>
          <Select value={draft.kind} disabled={kindFixed} onChange={(event) => onDraft({ ...draft, kind: event.target.value as DeadlineKind })}>
            {DEADLINE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`deadlineKind.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('add.due')} required error={error('dueOn')}>
          <DateField value={draft.dueOn} onChange={(dueOn) => onDraft({ ...draft, dueOn })} ariaLabel={t('add.due')} />
        </Field>
      </div>
      <div className="fw-hs-form-row">
        <Field label={t('add.repeat')} error={error('repeatUnit')}>
          <Select value={draft.repeat} onChange={(event) => onDraft({ ...draft, repeat: event.target.value as RepeatChoice })}>
            <option value="none">{t('repeat.none')}</option>
            {REPEAT_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {t(`repeat.unit.${unit}`)}
              </option>
            ))}
          </Select>
        </Field>
        {draft.repeat !== 'none' && (
          <Field label={t('add.every')} hint={t('add.everyHint')} error={error('repeatEvery')}>
            <Input type="number" inputMode="numeric" min={1} max={120} value={draft.every} onChange={(event) => onDraft({ ...draft, every: event.target.value })} />
          </Field>
        )}
      </div>
      <Field label={t('add.owner')} hint={owners?.status === 'error' ? t(owners.problem) : t('add.ownerHint')} error={error('ownerId')}>
        <Select value={draft.ownerId} disabled={!owners || owners.status !== 'ready'} onChange={(event) => onDraft({ ...draft, ownerId: event.target.value })}>
          <option value="">{owners?.status === 'loading' ? t('common.reading') : t('add.noOwner')}</option>
          {owners?.status === 'ready' &&
            owners.value.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.me ? t('add.ownerMe', { name: owner.name }) : owner.name}
              </option>
            ))}
        </Select>
      </Field>
      <Checkbox checked={draft.evidenceRequired} onChange={(event) => onDraft({ ...draft, evidenceRequired: event.target.checked })} label={t('add.evidence')} />
      <p className="fw-hs-muted">{t('add.evidenceHint')}</p>
    </div>
  )
}

/** Add deadline (design pop:deadline; `c` or the band): Esc closes and the focus goes back to the opener (the DS Modal). */
export function AddDeadlineModal({ model, state, actions }: { model: CalendarPageModel; state: DeadlineNewState; actions?: CalendarPageActions | undefined }) {
  const t = useWords()
  const held = !model.can.manageCalendar ? 'held.calendar' : !model.companyId ? 'held.company' : deadlineHeld(state.draft, state.busy)
  const place = model.scope.site ? t('add.site', { site: model.scope.site.name }) : t('add.wholeCompany', { company: model.scope.company?.name ?? '' })
  return (
    <Modal
      open
      onClose={() => actions?.onAddress?.({ newDeadline: false })}
      title={t('add.title')}
      subtitle={place}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onAddress?.({ newDeadline: false })}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onCreateDeadline?.()}>
            {state.busy ? <Spinner size={14} /> : null} {t('band.add')}
          </Button>
        </>
      }
    >
      <DeadlineFields draft={state.draft} owners={state.owners} problem={state.problem} onDraft={(draft) => actions?.onDeadlineDraft?.(draft)} />
      {state.problem && !state.problem.field && <Banner tone="danger" title={problemText(t, state.problem)} />}
    </Modal>
  )
}

/**
 * The Deadline window (design pop:item, a DetailModal; J / K over the list's deadlines): the facts, the evidence (FileRow
 * per file, the drop zone, generic files), Mark done (an optional note; held "Upload the evidence first" while evidence is
 * asked and none is on file), Edit, Cancel with the reason; a done repeating deadline says when the next one falls.
 */
export function DeadlineDetail({ model, state, actions }: { model: CalendarPageModel; state: DeadlineOpenState; actions?: CalendarPageActions | undefined }) {
  const t = useWords()
  const cv = useT('plant-calendar-view')
  const day = useDay()
  const record = state.read.status === 'ready' ? state.read.value : null
  const deadline = record?.deadline ?? null
  const items = model.calendar.status === 'ready' ? model.calendar.value.items : null
  // J / K: the deadlines typed here, in the List's order.
  const ids = useMemo(() => (items ? listRows(items, model.address.tile).filter((item) => item.kind === 'DEADLINE').map((item) => item.key) : []), [items, model.address.tile])
  const item = items?.find((entry) => entry.key === state.key) ?? null
  const canEdit = !!deadline && deadline.canManage && model.can.manageCalendar && deadline.status === 'OPEN'
  const editHeld = !deadline ? t('common.reading') : !deadline.canManage || !model.can.manageCalendar ? t('held.calendar') : deadline.status !== 'OPEN' ? t(deadline.status === 'DONE' ? 'held.doneAlready' : 'held.cancelledAlready') : null
  const done = deadline ? doneHeld({ ...deadline, canManage: deadline.canManage && model.can.manageCalendar }, state.busy) : 'held.reading'
  const canUpload = !!record && record.canUpload && model.can.upload
  const close = () => actions?.onAddress?.({ open: null })
  const repeat = deadline ? say(t, repeatWords(deadline.repeatEvery, deadline.repeatUnit)) : ''

  const footer =
    state.mode === 'edit' && deadline && state.draft ? (
      <>
        <Button onClick={() => actions?.onDeadlineMode?.('view')}>{t('common.back')}</Button>
        <Button variant="primary" heldReason={deadlineHeld(state.draft, state.busy) ? t(deadlineHeld(state.draft, state.busy)!) : deadlineEdit(deadline, state.draft) ? null : t('held.nothingChanged')} onClick={() => actions?.onSaveDeadline?.()}>
          {t('deadline.save')}
        </Button>
      </>
    ) : state.mode === 'cancel' ? (
      <>
        <Button onClick={() => actions?.onDeadlineMode?.('view')}>{t('common.back')}</Button>
        <Button variant="danger" heldReason={state.busy ? t('held.saving') : state.cancelReason.trim() ? null : t('held.reason')} onClick={() => actions?.onCancelDeadline?.()}>
          {t('deadline.cancelConfirm')}
        </Button>
      </>
    ) : (
      <>
        <Button heldReason={editHeld} onClick={() => actions?.onDeadlineMode?.('edit')}>
          {t('deadline.edit')}
        </Button>
        <Button heldReason={editHeld} onClick={() => actions?.onDeadlineMode?.('cancel')}>
          {t('deadline.cancel')}
        </Button>
        <span className="grow" />
        <Button variant="primary" heldReason={done ? t(done) : null} onClick={() => actions?.onMarkDone?.()}>
          {state.busy ? <Spinner size={14} /> : null} {t('deadline.markDone')}
        </Button>
      </>
    )

  return (
    <DetailModal
      open
      onClose={close}
      title={deadline?.title ?? t('deadline.noun')}
      subtitle={deadline ? t(`deadlineKind.${deadline.kind}`) : undefined}
      meta={
        deadline ? (
          <span className="fw-hs-meta">
            <DueState state={deadline.state} date={deadline.dueOn} today={model.today} say={cv} />
            {deadline.status !== 'OPEN' && <Pill tone={deadline.status === 'DONE' ? 'success' : 'neutral'}>{t(`status.${deadline.status}`)}</Pill>}
          </span>
        ) : undefined
      }
      nav={ids.includes(state.key) ? { ids, current: state.key, onGo: (key) => actions?.onAddress?.({ open: key }), noun: t('deadline.noun') } : undefined}
      loading={state.read.status === 'loading'}
      error={state.read.status === 'error' ? t(state.read.problem) : undefined}
      onRetry={() => actions?.onRetryDeadline?.()}
      footer={footer}
    >
      {deadline && record && (
        <div className="fw-hs-stack">
          {state.saved && <Banner tone="success" title={t(state.saved)} />}
          {state.problem && !(state.mode === 'edit' && state.problem.field) && <Banner tone="danger" title={problemText(t, state.problem)} />}
          {state.mode === 'edit' && state.draft ? (
            <DeadlineFields draft={state.draft} owners={state.owners} problem={state.problem} onDraft={(draft) => actions?.onDeadlineEditDraft?.(draft)} kindFixed />
          ) : state.mode === 'cancel' ? (
            <Field label={t('deadline.cancelReason')} hint={t('deadline.cancelHint')}>
              <Textarea value={state.cancelReason} rows={3} onChange={(event) => actions?.onCancelReason?.(event.target.value)} />
            </Field>
          ) : (
            <>
              <KeyValue
                columns={2}
                labelCase="sentence"
                items={[
                  { label: t('deadline.facts.due'), value: day(deadline.dueOn) },
                  { label: t('deadline.facts.repeat'), value: repeat },
                  { label: t('deadline.facts.owner'), value: deadline.owner ?? t('owner.none') },
                  { label: t('deadline.facts.place'), value: `${deadline.company.name} · ${deadline.site?.name ?? t('site.whole')}` },
                  { label: t('deadline.facts.evidence'), value: t(deadline.evidenceRequired ? 'deadline.evidenceAsked' : 'deadline.evidenceNotAsked') },
                  { label: t('deadline.facts.law'), value: item?.law ?? t('deadline.noLaw') },
                  ...(deadline.status === 'DONE' ? [{ label: t('deadline.facts.done'), value: t('deadline.doneBy', { date: day(deadline.doneAt), person: deadline.doneBy ?? '—' }), hint: deadline.doneNote ?? undefined }] : []),
                  ...(deadline.status === 'CANCELLED' ? [{ label: t('deadline.facts.cancelled'), value: day(deadline.cancelledAt), hint: deadline.cancelReason ?? undefined }] : []),
                ]}
              />
              {state.next ? (
                <Banner tone="info" title={t('deadline.next', { date: day(state.next.dueOn) })} />
              ) : deadline.status === 'DONE' && deadline.nextId ? (
                <Banner tone="info" title={t('deadline.nextMade')} />
              ) : deadline.status === 'OPEN' && deadline.repeatUnit ? (
                <p className="fw-hs-muted">{t('deadline.repeatNote')}</p>
              ) : null}
              <section className="fw-hs-stack" aria-labelledby="fw-hs-evidence">
                <h3 id="fw-hs-evidence" className="fw-hs-h3">
                  {t('deadline.evidenceTitle')}
                </h3>
                {deadline.evidence.length === 0 ? (
                  <p className="fw-hs-muted">{t(deadline.evidenceRequired ? 'deadline.evidenceNone' : 'deadline.evidenceNoneOptional')}</p>
                ) : (
                  <div className="fw-hs-files">
                    {deadline.evidence.map((file) => (
                      <FileRow
                        key={file.fileId}
                        name={file.name}
                        status={t('deadline.uploadedOn', { date: day(file.at) })}
                        actions={
                          <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(file.fileId)}>
                            {t('common.open')}
                          </Button>
                        }
                      />
                    ))}
                  </div>
                )}
                {canUpload ? (
                  <>
                    <FileDropzone onFiles={(files) => actions?.onEvidence?.(files)} accept={ACCEPT.SafetyDeadline} maxBytes={25 * 1024 * 1024} multiple disabled={state.uploading} hint={t('deadline.dropHint')} />
                    {state.uploading && (
                      <p className="fw-hs-muted" role="status">
                        <Spinner size={14} /> {t('common.uploading')}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="fw-hs-muted">{t('held.upload')}</p>
                )}
              </section>
              {deadline.status === 'OPEN' && canEdit && (
                <Field label={t('deadline.doneNote')} hint={done ? t(done) : t('deadline.doneNoteHint')}>
                  <Textarea value={state.doneNote} rows={2} onChange={(event) => actions?.onDoneNote?.(event.target.value)} />
                </Field>
              )}
              {record.earlier.length > 0 && (
                <section className="fw-hs-stack" aria-labelledby="fw-hs-earlier">
                  <h3 id="fw-hs-earlier" className="fw-hs-h3">
                    {t('deadline.earlier')}
                  </h3>
                  <ul className="fw-hs-list">
                    {record.earlier.map((entry) => (
                      <li key={entry.id}>{t('deadline.earlierRow', { date: day(entry.dueOn), status: t(`status.${entry.status}`), done: entry.doneAt ? day(entry.doneAt) : '—' })}</li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </DetailModal>
  )
}
