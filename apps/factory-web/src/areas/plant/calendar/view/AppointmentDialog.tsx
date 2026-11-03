'use client'

import { useId } from 'react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { SignBlock } from '@nexus/ui/components/SignBlock/index'
import { Button, Input, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { SAFETY_ROLES, type AppointmentSignMethod, type SafetyRole } from '@nexus/factory-domain/safety/organisation/rules'
import { Combobox, DateField, FileDropzone, FileRow, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { ACCEPT, type Appointment, type AppointmentRecord } from '../api'
import { appointmentHeld, atField, endHeld, isRlsRole, isTeamRole, noticeToConfirm, signHeld, type AppointmentDraft, type Who } from '../model'
import type { AppointmentNewState, AppointmentOpenState, CalendarPageActions, CalendarPageModel } from '../view-model'
import { placeText, signedText, trainingText } from './OrganisationSection'
import { problemText, RoleLaw, SectionFailed, useDay, useWords } from './parts'

/**
 * The Appointment (design pop:appoint; from the band's Safety organisation, a row, "Nobody holds … · Appoint"): a new
 * appointment — role, a person of the company OR an outside contact, site or whole company, the shift for a team, from,
 * until, note, and for an RLS or RLST the notice to INAIL (due by the first day, "to confirm", or already filed) — then on
 * the saved one the letter (generic files), the appointee's signature (the DS SignBlock: the appointee types their own name
 * at the office; or a paper signature with the signed letter on file), End term and the note. Esc closes (the DS Modal).
 */
export function AppointmentDialog({ model, state, actions }: { model: CalendarPageModel; state: AppointmentNewState | AppointmentOpenState; actions?: CalendarPageActions | undefined }) {
  return state.mode === 'new' ? <NewAppointment model={model} state={state} actions={actions} /> : <OpenAppointment model={model} state={state} actions={actions} />
}

const close = (actions: CalendarPageActions | undefined) => actions?.onAddress?.({ appoint: null, role: null, at: null })

function NewAppointment({ model, state, actions }: { model: CalendarPageModel; state: AppointmentNewState; actions?: CalendarPageActions | undefined }) {
  const t = useWords()
  const personLabel = useId()
  const contactLabel = useId()
  const { draft, problem } = state
  const set = (change: Partial<AppointmentDraft>) => actions?.onAppointmentDraft?.({ ...draft, ...change })
  const held = !model.can.manageOrganisation ? 'held.organisation' : !model.companyId ? 'held.company' : appointmentHeld(draft, model.today, state.busy)
  const error = (...fields: string[]) => {
    const key = atField(problem, ...fields)
    return key ? t(key) : undefined
  }
  const company = model.organisation.status === 'ready' ? model.organisation.value.companies.find((entry) => entry.id === model.companyId) : undefined
  const sites = company?.sites ?? model.scope.sites.map((site) => ({ id: site.id, code: site.code ?? '', name: site.name }))
  const people = state.people.status === 'ready' ? state.people.value : null
  const contacts = state.contacts.status === 'ready' ? state.contacts.value : null
  const role = draft.role

  return (
    <Modal
      open
      onClose={() => close(actions)}
      title={t('appoint.newTitle')}
      subtitle={company?.name ?? model.scope.company?.name}
      size="lg"
      footer={
        <>
          <Button onClick={() => close(actions)}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onSaveAppointment?.()}>
            {state.busy ? <Spinner size={14} /> : null} {t('appoint.save')}
          </Button>
        </>
      }
    >
      <div className="fw-hs-form">
        <div className="fw-hs-form-row">
          <Field label={t('appoint.role')} required error={error('role')}>
            <Select value={role} onChange={(event) => set({ role: event.target.value as SafetyRole | '', ...(event.target.value === 'RLST' ? { who: 'outside' as Who } : event.target.value === 'RLS' ? { who: 'person' as Who } : {}) })}>
              <option value="">{t('appoint.chooseRole')}</option>
              {SAFETY_ROLES.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`role.${entry}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('appoint.site')} error={error('siteId')}>
            <Select value={draft.siteId} onChange={(event) => set({ siteId: event.target.value })}>
              <option value="">{t('site.whole')}</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {role && (
          <p className="fw-hs-row">
            <RoleLaw role={role} /> <span className="fw-hs-muted">{t(`roleHint.${role}`)}</span>
          </p>
        )}
        <Field label={t('appoint.who')}>
          <SegmentedControl
            size="sm"
            ariaLabel={t('appoint.who')}
            value={draft.who}
            onChange={(who) => set({ who: who as Who })}
            options={[
              { value: 'person', label: t('appoint.person') },
              { value: 'outside', label: t('appoint.outside') },
            ]}
          />
        </Field>
        {draft.who === 'person' ? (
          <Field label={<span id={personLabel}>{t('appoint.personField')}</span>} required error={error('employeeId')} hint={state.people.status === 'error' ? t(state.people.problem) : people && !people.complete ? t('appoint.peoplePartial') : t('appoint.personHint')}>
            {people ? (
              <Combobox labelledBy={personLabel} value={draft.employeeId} onChange={(employeeId) => set({ employeeId })} options={people.people.map((person) => ({ value: person.id, label: [person.name, person.employeeCode, person.site.name].filter(Boolean).join(' · ') }))} />
            ) : (
              <span className="fw-hs-muted">{state.people.status === 'loading' ? t('common.reading') : '—'}</span>
            )}
          </Field>
        ) : (
          <div className="fw-hs-form-row">
            <Field label={t('appoint.outsideName')} required error={error('outsideName')} hint={t('appoint.outsideHint')}>
              <Input value={draft.outsideName} maxLength={200} onChange={(event) => set({ outsideName: event.target.value })} />
            </Field>
            <Field label={<span id={contactLabel}>{t('appoint.contact')}</span>} hint={state.contacts.status === 'error' ? t(state.contacts.problem) : t('appoint.contactHint')} error={error('outsidePartyId', 'outsideContactId')}>
              {contacts ? (
                <Combobox
                  labelledBy={contactLabel}
                  value={draft.contact}
                  onChange={(value) => {
                    const picked = contacts.contacts.find((entry) => `${entry.partyId}|${entry.contactId ?? ''}` === value)
                    set({ contact: value, ...(picked && !draft.outsideName.trim() ? { outsideName: picked.name } : {}) })
                  }}
                  options={contacts.contacts.map((entry) => ({ value: `${entry.partyId}|${entry.contactId ?? ''}`, label: `${entry.name} · ${entry.partyName}` }))}
                />
              ) : (
                <span className="fw-hs-muted">{state.contacts.status === 'loading' ? t('common.reading') : '—'}</span>
              )}
            </Field>
          </div>
        )}
        {isTeamRole(role) && (
          <Field label={t('appoint.shift')} hint={state.shifts.status === 'error' ? t(state.shifts.problem) : t('appoint.shiftHint')} error={error('shiftPatternId')}>
            <Select value={draft.shiftId} onChange={(event) => set({ shiftId: event.target.value })}>
              <option value="">{t('appoint.everyShift')}</option>
              {state.shifts.status === 'ready' &&
                state.shifts.value.map((shift) => (
                  <option key={shift.id} value={shift.id}>
                    {shift.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <div className="fw-hs-form-row">
          <Field label={t('appoint.from')} required error={error('fromDate')}>
            <DateField value={draft.fromDate} onChange={(fromDate) => set({ fromDate })} ariaLabel={t('appoint.from')} />
          </Field>
          <Field label={t('appoint.until')} hint={t('appoint.untilHint')} error={error('untilDate')}>
            <DateField value={draft.untilDate} onChange={(untilDate) => set({ untilDate })} clearable ariaLabel={t('appoint.until')} />
          </Field>
        </div>
        {isRlsRole(role) && (
          <fieldset className="fw-hs-fieldset">
            <legend className="fw-hs-h3">{t('appoint.noticeTitle')}</legend>
            <SegmentedControl
              size="sm"
              ariaLabel={t('appoint.noticeTitle')}
              value={draft.notice}
              onChange={(notice) => set({ notice: notice === 'filed' ? 'filed' : 'due' })}
              options={[
                { value: 'due', label: t('appoint.noticeDue') },
                { value: 'filed', label: t('appoint.noticeFiled') },
              ]}
            />
            {draft.notice === 'due' ? (
              <Field label={t('appoint.noticeDueOn')} hint={t('appoint.noticeDueHint')} error={error('noticeDueOn')}>
                <DateField value={draft.noticeDueOn} onChange={(noticeDueOn) => set({ noticeDueOn })} clearable ariaLabel={t('appoint.noticeDueOn')} placeholder={t('appoint.noticeDefault')} />
              </Field>
            ) : (
              <div className="fw-hs-form-row">
                <Field label={t('filing.filedOn')} required error={error('noticeFiled', 'filedOn')}>
                  <DateField value={draft.filedOn} onChange={(filedOn) => set({ filedOn })} max={model.today} ariaLabel={t('filing.filedOn')} />
                </Field>
                <Field label={t('filing.reference')} required error={error('reference')}>
                  <Input value={draft.reference} maxLength={100} onChange={(event) => set({ reference: event.target.value })} />
                </Field>
              </div>
            )}
            <p className="fw-hs-muted">{t('rls.manual')}</p>
          </fieldset>
        )}
        <Field label={t('appoint.note')} error={error('note')}>
          <Textarea value={draft.note} rows={2} onChange={(event) => set({ note: event.target.value })} />
        </Field>
        <p className="fw-hs-muted">{t('appoint.afterSave')}</p>
        {problem && !problem.field && <Banner tone="danger" title={problemText(t, problem)} />}
      </div>
    </Modal>
  )
}

function OpenAppointment({ model, state, actions }: { model: CalendarPageModel; state: AppointmentOpenState; actions?: CalendarPageActions | undefined }) {
  const t = useWords()
  const record = state.read.status === 'ready' ? state.read.value : null
  const row = record?.appointment ?? null
  const canManage = !!row && row.canManage && model.can.manageOrganisation
  const endBlocked = !row ? t('common.reading') : !canManage ? t('held.organisation') : row.ended ? t('refusal.ENDED') : null
  const title = row ? t('appoint.title', { role: t(`role.${row.role}`) }) : t('appoint.loadingTitle')

  return (
    <Modal
      open
      onClose={() => close(actions)}
      title={title}
      subtitle={row?.appointee.name}
      size="lg"
      footer={
        state.step === 'end' && row ? (
          <>
            <Button onClick={() => actions?.onAppointmentStep?.('view')}>{t('common.back')}</Button>
            <Button variant="danger" heldReason={endHeld(state.end, [row], state.busy) ? t(endHeld(state.end, [row], state.busy)!) : null} onClick={() => actions?.onEndTerm?.()}>
              {t('end.confirm')}
            </Button>
          </>
        ) : (
          <>
            <Button heldReason={endBlocked} onClick={() => actions?.onAppointmentStep?.('end')}>
              {t('end.button')}
            </Button>
            <span className="grow" />
            <Button variant="primary" onClick={() => close(actions)}>
              {t('common.close')}
            </Button>
          </>
        )
      }
    >
      {state.read.status === 'loading' ? (
        <p className="fw-hs-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      ) : state.read.status === 'error' ? (
        <SectionFailed title={t('appoint.failed')} problem={state.read.problem} onRetry={actions?.onRetryAppointment} />
      ) : row && record ? (
        <div className="fw-hs-stack">
          {state.created && <Banner tone="success" title={t('appoint.created')} />}
          {state.saved && <Banner tone="success" title={t(state.saved)} />}
          {state.problem && !state.problem.field && state.problem.key !== 'refusal.NAME_MISMATCH' && <Banner tone="danger" title={problemText(t, state.problem)} />}
          {state.step === 'end' ? <EndStep state={state} actions={actions} /> : <AppointmentBody model={model} state={state} record={record} row={row} canManage={canManage} actions={actions} />}
        </div>
      ) : null}
    </Modal>
  )
}

function EndStep({ state, actions }: { state: AppointmentOpenState; actions?: CalendarPageActions | undefined }) {
  const t = useWords()
  const error = (...fields: string[]) => {
    const key = atField(state.problem, ...fields)
    return key ? t(key) : undefined
  }
  return (
    <div className="fw-hs-form">
      <p>{t('end.explain')}</p>
      <Field label={t('end.untilDate')} hint={t('end.untilHint')} required error={error('untilDate')}>
        <DateField value={state.end.untilDate} onChange={(untilDate) => actions?.onEndDraft?.({ ...state.end, untilDate })} ariaLabel={t('end.untilDate')} />
      </Field>
      <Field label={t('end.reason')} required error={error('endReason')}>
        <Textarea value={state.end.reason} rows={3} onChange={(event) => actions?.onEndDraft?.({ ...state.end, reason: event.target.value })} />
      </Field>
    </div>
  )
}

function AppointmentBody({ model, state, record, row, canManage, actions }: { model: CalendarPageModel; state: AppointmentOpenState; record: AppointmentRecord; row: Appointment; canManage: boolean; actions?: CalendarPageActions | undefined }) {
  const t = useWords()
  const day = useDay()
  const canUpload = canManage && model.can.upload
  const outside = row.appointee.kind === 'OUTSIDE'
  const signedHeld = signHeld({ ...row, canManage }, state.signMethod, state.busy)
  const noteChanged = (state.note ?? '') !== (row.note ?? '')
  return (
    <>
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('org.col.role'), value: <span className="fw-hs-row">{t(`role.${row.role}`)} <RoleLaw role={row.role} /></span> },
          { label: t('org.col.person'), value: row.appointee.name, hint: outside ? [row.appointee.partyName ?? t('org.outside'), row.appointee.email, row.appointee.phone].filter(Boolean).join(' · ') : t('appoint.ofCompany') },
          { label: t('org.col.place'), value: placeText(t, row) },
          { label: t('org.col.shift'), value: row.shift?.name ?? '—' },
          { label: t('org.col.from'), value: day(row.fromDate) },
          { label: t('org.col.until'), value: row.untilDate ? day(row.untilDate) : t('org.openEnded'), hint: row.endReason ?? undefined },
          { label: t('org.col.training'), value: trainingText(t, day, row.training) },
          { label: t('org.col.signed'), value: signedText(t, day, row), hint: row.signature?.signedBy ? t('sign.recordedBy', { person: row.signature.signedBy }) : undefined },
        ]}
      />

      <section className="fw-hs-stack" aria-labelledby="fw-hs-letter">
        <h3 id="fw-hs-letter" className="fw-hs-h3">
          {t('letter.title')}
        </h3>
        {row.letter ? (
          <FileRow
            name={row.letter.name}
            status={t('letter.onFile')}
            actions={
              <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(row.letter!.fileId)}>
                {t('common.open')}
              </Button>
            }
          />
        ) : (
          <p className="fw-hs-muted">{t('org.noLetter')}</p>
        )}
        {canUpload ? (
          <>
            <FileDropzone onFiles={(files) => actions?.onLetter?.(files)} accept={ACCEPT.SafetyAppointment} maxBytes={25 * 1024 * 1024} disabled={state.uploading} hint={t(row.letter ? 'letter.replaceHint' : 'letter.hint')} />
            {state.uploading && (
              <p className="fw-hs-muted" role="status">
                <Spinner size={14} /> {t('common.uploading')}
              </p>
            )}
          </>
        ) : (
          <p className="fw-hs-muted">{t(canManage ? 'held.upload' : 'held.organisation')}</p>
        )}
      </section>

      <section className="fw-hs-stack" aria-labelledby="fw-hs-sign">
        <h3 id="fw-hs-sign" className="fw-hs-h3">
          {t('sign.title')}
        </h3>
        {row.signature ? (
          <p>{signedText(t, day, row)}</p>
        ) : row.ended ? (
          <p className="fw-hs-muted">{t('refusal.ENDED')}</p>
        ) : !canManage ? (
          <p className="fw-hs-muted">{t('sign.notYet')} {t('held.organisation')}</p>
        ) : (
          <>
            <SegmentedControl
              size="sm"
              ariaLabel={t('sign.method')}
              value={state.signMethod}
              onChange={(method) => actions?.onSignMethod?.(method as AppointmentSignMethod)}
              options={[
                { value: 'OFFICE', label: t('sign.OFFICE') },
                { value: 'PAPER', label: t('sign.PAPER') },
              ]}
            />
            {state.signMethod === 'OFFICE' ? (
              <SignBlock
                title={t('sign.blockTitle', { name: row.appointee.name })}
                legal={<p>{t('sign.legal', { role: t(`role.${row.role}`), company: row.company.name })}</p>}
                nameLabel={t('sign.name')}
                nameHint={t('sign.nameHint')}
                expectedName={row.appointee.name}
                nameEmptyLabel={t('sign.nameEmpty')}
                nameMismatchLabel={t('refusal.NAME_MISMATCH')}
                acceptLabel={t('sign.accept')}
                busyLabel={t('held.saving')}
                onAccept={(acceptance) => actions?.onSign?.(acceptance.name)}
                state={state.busy ? 'busy' : 'idle'}
                heldReason={signedHeld && signedHeld !== 'held.saving' ? t(signedHeld) : null}
                message={state.problem?.key === 'refusal.NAME_MISMATCH' ? t('refusal.NAME_MISMATCH') : undefined}
              />
            ) : (
              <div className="fw-hs-stack">
                <p className="fw-hs-muted">{t('sign.paperExplain')}</p>
                <span>
                  <Button variant="primary" heldReason={signedHeld ? t(signedHeld) : null} onClick={() => actions?.onSign?.(row.appointee.name)}>
                    {t('sign.paperRecord')}
                  </Button>
                </span>
              </div>
            )}
          </>
        )}
      </section>

      {record.notices.length > 0 && (
        <section className="fw-hs-stack" aria-labelledby="fw-hs-notices">
          <h3 id="fw-hs-notices" className="fw-hs-h3">
            {t('rls.title')}
          </h3>
          <ul className="fw-hs-list">
            {record.notices.map((notice) => (
              <li key={notice.id} className="fw-hs-row">
                <span>
                  {notice.status === 'PENDING'
                    ? noticeToConfirm(notice)
                      ? t('rls.dueToConfirm', { date: day(notice.dueOn) })
                      : t('rls.dueOn', { date: day(notice.dueOn) })
                    : notice.status === 'FILED'
                      ? t('rls.filedRow', { date: day(notice.filedOn), reference: notice.reference ?? '—' })
                      : t('rls.cancelledRow', { reason: notice.cancelReason ?? '—' })}
                </span>
                {notice.status !== 'CANCELLED' && (
                  <Button size="sm" variant="quiet" onClick={() => actions?.onAddress?.({ appoint: null, filing: notice.id })}>
                    {t(notice.status === 'PENDING' ? 'rls.record' : 'rls.open')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Field label={t('appoint.note')} hint={canManage ? undefined : t('held.organisation')}>
        <Textarea value={state.note ?? ''} rows={2} disabled={!canManage} onChange={(event) => actions?.onNoteDraft?.(event.target.value)} />
      </Field>
      {canManage && (
        <span>
          <Button size="sm" heldReason={state.busy ? t('held.saving') : noteChanged ? null : t('held.nothingChanged')} onClick={() => actions?.onSaveNote?.()}>
            {t('appoint.saveNote')}
          </Button>
        </span>
      )}
    </>
  )
}
