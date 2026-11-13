'use client'

import { useId, useState } from 'react'
import { CalendarCheck, CalendarClock, CalendarPlus, CalendarX2, ClipboardPen, Mail } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Kbd, Pill, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { DateTimeField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useDsLabels } from '../../../../../lib/i18n/ds-labels'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import type { ProfileRecord } from '../../api'
import { appointmentHeld, appointmentTone, bookHeld, changeProblem, FITTING_MINUTES, formPoints, PLACE_PICKS, resultHeld, VERDICTS, type Measurer } from '../../model'
import { NoticeLine, useSubmitKey, useWords } from '../../parts'
import type { AppointmentPanel, ProfileRecordActions, ProfileRecordModel } from '../view-model'

/**
 * Book a fitting (design pop:mtm.fitting: date and time, place — showroom, track, dealer —, the fitter, the invite (.ics) to the
 * rider), the appointment's panel (move it, done or missed, cancel with why, send the invite again — each held with why) and
 * Record outcome (the Fittings tab: the fitting or the order line fitted, fits / alteration needed / remade, the change per point
 * in its unit, the days an alteration adds). ⌘↵ runs the primary; Esc closes. Fetches nothing.
 */
export function FittingDialogs({ model, record, actions }: { model: ProfileRecordModel; record: ProfileRecord; actions?: ProfileRecordActions }) {
  const dialog = model.dialog
  if (dialog?.kind === 'fitting') return <BookDialog model={model} record={record} dialog={dialog} actions={actions} />
  if (dialog?.kind === 'appointment') return <AppointmentDialog model={model} dialog={dialog} actions={actions} />
  if (dialog?.kind === 'outcome') return <OutcomeDialog model={model} record={record} dialog={dialog} actions={actions} />
  return null
}

const fitterValue = (fitter: Measurer): string => (fitter.kind === 'person' ? fitter.id : fitter.kind)

function BookDialog({ model, record, dialog, actions }: { model: ProfileRecordModel; record: ProfileRecord; dialog: Extract<NonNullable<ProfileRecordModel['dialog']>, { kind: 'fitting' }>; actions?: ProfileRecordActions }) {
  const { t, say, locale } = useWords()
  const ds = useDsLabels()
  const ids = { when: useId(), minutes: useId(), place: useId(), fitter: useId(), name: useId(), notes: useId() }
  const [now] = useState(() => new Date())
  const held = say(bookHeld(dialog.draft, new Date())) ?? (dialog.busy ? t('common.working') : model.live === 'offline' ? t('held.offline') : null)
  const onKey = useSubmitKey(true, !!held, () => actions?.onBook?.())
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="md"
      title={t('book.title')}
      subtitle={t('book.sub', { rider: record.riderName, garment: record.garmentType, revision: record.revisions[0]?.revision ?? 0 })}
      footer={
        <span className="fw-mtm-actions">
          <Button variant="secondary" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onBook?.()} aria-keyshortcuts="Meta+Enter">
            {dialog.busy ? <Spinner size={12} /> : <CalendarPlus size={14} aria-hidden />} {dialog.draft.invite ? t('book.saveInvite') : t('book.save')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-mtm-stack" onKeyDown={onKey}>
        <NoticeLine notice={dialog.notice} />
        <div className="fw-mtm-fields">
          <Field label={t('book.when')} required htmlFor={ids.when}>
            <DateTimeField id={ids.when} value={dialog.draft.startsAt} onChange={(value) => actions?.onBookDraft?.({ startsAt: value })} min={now.toISOString()} defaultTime="10:00" locale={INTL_LOCALE[locale]} ariaLabel={t('book.when')} labels={ds.dateTimeField} />
          </Field>
          <Field label={t('book.minutes')} htmlFor={ids.minutes}>
            <Select id={ids.minutes} size="sm" value={String(dialog.draft.minutes)} onChange={(event) => actions?.onBookDraft?.({ minutes: Number(event.target.value) })}>
              {FITTING_MINUTES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {t('book.minutesValue', { count: minutes })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('book.place')} required htmlFor={ids.place} hint={t('book.placeHint')}>
          <span className="fw-mtm-tight">
            <Input id={ids.place} size="sm" value={dialog.draft.place} onChange={(event) => actions?.onBookDraft?.({ place: event.target.value })} />
            <span className="fw-mtm-actions">
              {PLACE_PICKS.map((pick) => (
                <Button key={pick} size="sm" variant="quiet" onClick={() => actions?.onBookDraft?.({ place: t(`book.pick.${pick}`) })}>
                  {t(`book.pick.${pick}`)}
                </Button>
              ))}
            </span>
          </span>
        </Field>
        <div className="fw-mtm-fields">
          <Field label={t('book.fitter')} htmlFor={ids.fitter}>
            <Select
              id={ids.fitter}
              size="sm"
              value={fitterValue(dialog.draft.fitter)}
              onChange={(event) => {
                const value = event.target.value
                actions?.onBookDraft?.({ fitter: value === 'me' ? { kind: 'me' } : value === 'outside' ? { kind: 'outside' } : { kind: 'person', id: value } })
              }}
            >
              <option value="me">{t('book.fitterMe')}</option>
              {(dialog.people ?? [])
                .filter((person) => person.id !== model.me)
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              <option value="outside">{t('book.fitterOutside')}</option>
            </Select>
          </Field>
          {dialog.draft.fitter.kind === 'outside' && (
            <Field label={t('book.fitterName')} required htmlFor={ids.name}>
              <Input id={ids.name} size="sm" value={dialog.draft.fitterName} onChange={(event) => actions?.onBookDraft?.({ fitterName: event.target.value })} />
            </Field>
          )}
        </div>
        <Field label={t('book.notes')} htmlFor={ids.notes}>
          <Textarea id={ids.notes} rows={2} value={dialog.draft.notes} onChange={(event) => actions?.onBookDraft?.({ notes: event.target.value })} />
        </Field>
        <Checkbox checked={dialog.draft.invite} onChange={(event) => actions?.onBookDraft?.({ invite: event.target.checked })} label={t('book.invite')} />
        <p className="fw-mtm-hint">{dialog.draft.invite ? t('book.inviteHint') : t('book.noInviteHint')}</p>
      </div>
    </Modal>
  )
}

function AppointmentDialog({ model, dialog, actions }: { model: ProfileRecordModel; dialog: AppointmentPanel; actions?: ProfileRecordActions }) {
  const { t, say, when, locale } = useWords()
  const ds = useDsLabels()
  const ids = { when: useId(), place: useId(), reason: useId(), notes: useId() }
  const offline = model.live === 'offline'
  const appointment = dialog.appointment
  const busy = dialog.busy ? t('common.working') : null
  const footerClose = (
    <Button variant="secondary" onClick={() => actions?.onDialog?.(null)}>
      {t('common.close')}
    </Button>
  )
  let footer = footerClose
  if (appointment && dialog.mode === 'view') {
    footer = (
      <span className="fw-mtm-actions">
        {footerClose}
        <Button variant="secondary" heldReason={say(appointmentHeld(appointment, 'invite', model.can, offline)) ?? busy} onClick={() => actions?.onInvite?.()}>
          <Mail size={14} aria-hidden /> {t('appt.invite')}
        </Button>
        <Button variant="secondary" heldReason={say(appointmentHeld(appointment, 'move', model.can, offline)) ?? busy} onClick={() => actions?.onAppointmentMode?.('move')}>
          <CalendarClock size={14} aria-hidden /> {t('appt.move')}
        </Button>
        <Button variant="danger-outline" heldReason={say(appointmentHeld(appointment, 'cancel', model.can, offline)) ?? busy} onClick={() => actions?.onAppointmentMode?.('cancel')}>
          <CalendarX2 size={14} aria-hidden /> {t('appt.cancel')}
        </Button>
        <Button variant="secondary" heldReason={say(appointmentHeld(appointment, 'close', model.can, offline)) ?? busy} onClick={() => actions?.onAppointmentMode?.('close')}>
          <CalendarCheck size={14} aria-hidden /> {t('appt.close')}
        </Button>
        <Button variant="primary" heldReason={say(appointmentHeld(appointment, 'result', model.can, offline)) ?? busy} onClick={() => actions?.onOpenOutcome?.(appointment.id)}>
          <ClipboardPen size={14} aria-hidden /> {t('fit.record')}
        </Button>
      </span>
    )
  } else if (appointment && dialog.mode !== 'view') {
    const formHeld = dialog.mode === 'cancel' && !dialog.reason.trim() ? t('appt.held.reason') : dialog.mode === 'move' && !dialog.move.place.trim() ? t('book.held.place') : busy
    footer = (
      <span className="fw-mtm-actions">
        <Button variant="secondary" onClick={() => actions?.onAppointmentMode?.('view')}>
          {t('common.back')}
        </Button>
        <Button variant={dialog.mode === 'cancel' ? 'danger' : 'primary'} heldReason={formHeld} onClick={() => (dialog.mode === 'move' ? actions?.onMove?.() : dialog.mode === 'cancel' ? actions?.onCancelAppointment?.() : actions?.onClose?.())}>
          {dialog.busy && <Spinner size={12} />} {t(`appt.do.${dialog.mode}`)}
        </Button>
      </span>
    )
  }
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} size="md" title={appointment ? t('appt.title', { kind: t(`apptKind.${appointment.kind}`), when: when(appointment.startsAt) }) : t('appt.reading')} footer={footer}>
      <div className="fw-mtm-stack">
        <NoticeLine notice={dialog.notice} />
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        {!appointment && !dialog.problem && (
          <p className="fw-mtm-hint" role="status">
            <Spinner size={12} /> {t('appt.reading')}
          </p>
        )}
        {appointment && (
          <>
            <p className="fw-mtm-row">
              <Pill tone={appointmentTone(appointment.status)}>{t(`apptStatus.${appointment.status}`)}</Pill>
              {appointment.inviteSentAt ? <span className="fw-mtm-hint">{t('appt.invitedAt', { when: when(appointment.inviteSentAt) })}</span> : <span className="fw-mtm-hint">{appointment.mailTo ? t('fit.notInvited') : t('appt.held.noAddress')}</span>}
            </p>
            <KeyValue
              columns={2}
              labelCase="sentence"
              items={[
                { label: t('fit.col.when'), value: `${when(appointment.startsAt)} – ${when(appointment.endsAt)}` },
                { label: t('fit.col.place'), value: appointment.place },
                { label: t('fit.col.fitter'), value: appointment.with.name ?? '—' },
                { label: t('appt.rider'), value: appointment.rider.name ?? '—' },
                { label: t('appt.revision'), value: appointment.profile ? t('row.revisionValue', { revision: appointment.profile.revision }) : '—' },
                { label: t('appt.results'), value: String(appointment.results) },
                ...(appointment.closedAt ? [{ label: t('appt.closedAt'), value: t('appt.closedBy', { when: when(appointment.closedAt), name: appointment.closedBy?.name ?? '—' }) }] : []),
                ...(appointment.cancelReason ? [{ label: t('appt.cancelReason'), value: appointment.cancelReason }] : []),
              ]}
            />
            {appointment.notes && <p className="fw-mtm-text">{appointment.notes}</p>}
            {appointment.mails.length > 0 && (
              <ul className="fw-mtm-lines">
                {appointment.mails.map((mail) => (
                  <li key={mail.id}>{t('appt.mail', { mail: t(`appt.mailKind.${mail.mail}`), when: when(mail.sentAt ?? mail.queuedAt), status: t(mail.sentAt ? 'appt.mailSent' : 'appt.mailQueued') })}</li>
                ))}
              </ul>
            )}
            {dialog.mode === 'move' && (
              <div className="fw-mtm-stack">
                <div className="fw-mtm-fields">
                  <Field label={t('book.when')} htmlFor={ids.when}>
                    <DateTimeField id={ids.when} value={dialog.move.startsAt} onChange={(value) => actions?.onAppointmentDraft?.({ move: { ...dialog.move, startsAt: value } })} min={new Date().toISOString()} defaultTime="10:00" locale={INTL_LOCALE[locale]} ariaLabel={t('book.when')} labels={ds.dateTimeField} />
                  </Field>
                  <Field label={t('book.place')} htmlFor={ids.place}>
                    <Input id={ids.place} size="sm" value={dialog.move.place} onChange={(event) => actions?.onAppointmentDraft?.({ move: { ...dialog.move, place: event.target.value } })} />
                  </Field>
                </div>
                <Checkbox checked={dialog.move.invite} onChange={(event) => actions?.onAppointmentDraft?.({ move: { ...dialog.move, invite: event.target.checked } })} label={t('appt.moveInvite')} />
              </div>
            )}
            {dialog.mode === 'cancel' && (
              <Field label={t('appt.reason')} required htmlFor={ids.reason} hint={t('appt.reasonHint')}>
                <Textarea id={ids.reason} rows={2} value={dialog.reason} onChange={(event) => actions?.onAppointmentDraft?.({ reason: event.target.value })} />
              </Field>
            )}
            {dialog.mode === 'close' && (
              <div className="fw-mtm-stack">
                <SegmentedControl
                  ariaLabel={t('appt.close')}
                  size="sm"
                  value={dialog.close.status}
                  onChange={(value) => actions?.onAppointmentDraft?.({ close: { ...dialog.close, status: value === 'MISSED' ? 'MISSED' : 'DONE' } })}
                  options={[
                    { value: 'DONE', label: t('apptStatus.DONE') },
                    { value: 'MISSED', label: t('apptStatus.MISSED') },
                  ]}
                />
                <Field label={t('book.notes')} htmlFor={ids.notes}>
                  <Textarea id={ids.notes} rows={2} value={dialog.close.notes} onChange={(event) => actions?.onAppointmentDraft?.({ close: { ...dialog.close, notes: event.target.value } })} />
                </Field>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

function OutcomeDialog({ model, record, dialog, actions }: { model: ProfileRecordModel; record: ProfileRecord; dialog: Extract<NonNullable<ProfileRecordModel['dialog']>, { kind: 'outcome' }>; actions?: ProfileRecordActions }) {
  const { t, say, when } = useWords()
  const ids = { appointment: useId(), line: useId(), notes: useId(), days: useId() }
  const points = formPoints(record.template?.points)
  const latest = record.revisions[0]
  const measured = points.filter((point) => latest?.measurements[point.code])
  const appointments = (model.fittings.items?.appointments ?? []).filter((appointment) => appointment.kind === 'FITTING' && appointment.status !== 'CANCELLED' && appointment.status !== 'MISSED')
  const orderUnits = record.units.filter((unit) => unit.kind === 'ORDER')
  const held = say(resultHeld(dialog.draft)) ?? (dialog.busy ? t('common.working') : model.live === 'offline' ? t('held.offline') : null)
  const onKey = useSubmitKey(true, !!held, () => actions?.onRecordOutcome?.())
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="lg"
      title={t('result.title')}
      subtitle={t('result.sub', { rider: record.riderName, revision: latest?.revision ?? 0 })}
      footer={
        <span className="fw-mtm-actions">
          <Button variant="secondary" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onRecordOutcome?.()} aria-keyshortcuts="Meta+Enter">
            {dialog.busy ? <Spinner size={12} /> : <ClipboardPen size={14} aria-hidden />} {t('result.save')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-mtm-stack" onKeyDown={onKey}>
        <NoticeLine notice={dialog.notice} />
        <div className="fw-mtm-fields">
          <Field label={t('result.appointment')} htmlFor={ids.appointment} hint={t('result.appointmentHint')}>
            <Select id={ids.appointment} size="sm" value={dialog.draft.appointmentId} onChange={(event) => actions?.onOutcomeDraft?.({ appointmentId: event.target.value })}>
              <option value="">{t('result.noAppointment')}</option>
              {appointments.map((appointment) => (
                <option key={appointment.id} value={appointment.id}>
                  {when(appointment.startsAt)} · {appointment.place} · {t(`apptStatus.${appointment.status}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('result.line')} htmlFor={ids.line} hint={orderUnits.length === 0 ? t('result.noLines') : t('result.lineHint')}>
            <Select id={ids.line} size="sm" value={dialog.draft.orderLineId} disabled={orderUnits.length === 0} onChange={(event) => actions?.onOutcomeDraft?.({ orderLineId: event.target.value })}>
              <option value="">{t('result.noLine')}</option>
              {orderUnits.map((unit) => (
                <option key={unit.lineId} value={unit.lineId}>
                  {unit.number} · {unit.style.code} {unit.colourway.code} · {t('row.revisionValue', { revision: unit.revision })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('result.verdict')}>
          <SegmentedControl ariaLabel={t('result.verdict')} size="sm" value={dialog.draft.verdict} onChange={(value) => actions?.onOutcomeDraft?.({ verdict: VERDICTS.includes(value as (typeof VERDICTS)[number]) ? (value as (typeof VERDICTS)[number]) : 'OK' })} options={VERDICTS.map((verdict) => ({ value: verdict, label: t(`verdict.${verdict}`) }))} />
        </Field>
        {dialog.draft.verdict !== 'OK' && (
          <section className="fw-mtm-tight" aria-label={t('result.changes')}>
            <h3 className="fw-mtm-h3">{t('result.changes')}</h3>
            <p className="fw-mtm-hint">{t('result.changesHint')}</p>
            <div className="fw-mtm-points">
              {measured.map((point) => {
                const entry = dialog.draft.changes[point.code] ?? { change: '', note: '' }
                const problem = say(changeProblem(entry.change))
                return (
                  <Field key={point.code} label={t('result.pointLabel', { point: point.name, value: latest?.measurements[point.code]?.value ?? '—', unit: point.unit })} error={problem ?? undefined}>
                    <span className="fw-mtm-tight">
                      <span className="fw-mtm-value">
                        <Input size="sm" inputMode="decimal" placeholder="+2.0" value={entry.change} onChange={(event) => actions?.onChange?.(point.code, { change: event.target.value })} aria-label={t('result.changeOf', { point: point.name, unit: point.unit })} />
                        <span className="fw-mtm-unit">{point.unit}</span>
                      </span>
                      {entry.change.trim() && <Input size="sm" placeholder={t('result.notePlaceholder')} value={entry.note} onChange={(event) => actions?.onChange?.(point.code, { note: event.target.value })} aria-label={t('result.noteOf', { point: point.name })} />}
                    </span>
                  </Field>
                )
              })}
            </div>
          </section>
        )}
        {dialog.draft.verdict === 'ALTER' && (
          <Field label={t('result.days')} htmlFor={ids.days} hint={dialog.draft.orderLineId ? t('result.daysHint') : t('result.daysNoLine')}>
            <Input id={ids.days} size="sm" inputMode="numeric" value={dialog.draft.days} onChange={(event) => actions?.onOutcomeDraft?.({ days: event.target.value })} />
          </Field>
        )}
        {dialog.draft.verdict === 'REMAKE' && <p className="fw-mtm-hint">{t('result.remakeHint')}</p>}
        <Field label={t('result.notes')} htmlFor={ids.notes}>
          <Textarea id={ids.notes} rows={3} value={dialog.draft.notes} onChange={(event) => actions?.onOutcomeDraft?.({ notes: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
