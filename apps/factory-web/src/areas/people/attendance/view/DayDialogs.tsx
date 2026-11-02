'use client'

import { useId, type ReactNode } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { DateTimeField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { AbsenceCode, ClockEvent, DayAbsence } from '../api'
import { CORRECTION_KINDS, correctionHeld, figureOf, FIX_CHOICES, FIX_EVENTS, fixHeld, hoursWords, MANUAL_REASONS, timeOf, type CorrectionKind, type FixChoice, type FixEvent, type ManualReason, type Words } from '../model'
import type { DayActions, DayDialog, DayState } from '../use-day'
import { said, useAttendanceWords, type AttendanceWords } from './parts'

const REASON_MIN = 3

/** The Modal's footer: Cancel and the verb, held with why (design rule: a button that cannot act says so). */
export function Footer({ t, held, busy, label, danger, onCancel, onSave }: { t: AttendanceWords; held: string | null; busy: boolean; label: string; danger?: boolean; onCancel: () => void; onSave: () => void }) {
  return (
    <>
      <span className="fw-pp-grow" />
      <Button size="sm" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      <Button size="sm" variant={danger ? 'danger' : 'primary'} heldReason={busy ? t('held.working') : held} onClick={onSave}>
        {busy ? <Spinner size={12} /> : null} {label}
      </Button>
    </>
  )
}

export function Form({ children, held, onSave }: { children: ReactNode; held: string | null; onSave: () => void }) {
  return (
    <form
      className="fw-pp-dialog"
      onSubmit={(event) => {
        event.preventDefault()
        if (!held) onSave()
      }}
    >
      {children}
      <button type="submit" hidden aria-hidden tabIndex={-1} />
    </form>
  )
}

export const Problem = ({ t, words }: { t: AttendanceWords; words: Words | null }) => (words ? <Banner tone="danger" title={said(t, words)} /> : null)

/** The reason of a manual change: a list and words (a health detail never goes here: a sickness is a code and a protocol number). */
export function ReasonFields({ t, id, draft, onDraft }: { t: AttendanceWords; id: string; draft: { reasonCode: ManualReason | ''; reason: string }; onDraft: (patch: { reasonCode?: ManualReason | ''; reason?: string }) => void }) {
  return (
    <>
      <Field label={t('field.reasonCode')} htmlFor={`${id}-why`}>
        <Select id={`${id}-why`} value={draft.reasonCode} onChange={(event) => onDraft({ reasonCode: event.target.value as ManualReason | '' })}>
          <option value="">{t('field.reasonPick')}</option>
          {MANUAL_REASONS.map((code) => (
            <option key={code} value={code}>
              {t(`reason.${code}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('field.reason')} required={draft.reasonCode === '' || draft.reasonCode === 'OTHER'} htmlFor={`${id}-reason`} hint={t('field.reasonHint')}>
        <Input id={`${id}-reason`} value={draft.reason} maxLength={500} onChange={(event) => onDraft({ reason: event.target.value })} />
      </Field>
    </>
  )
}

export const codeText = (code: AbsenceCode, locale: string): string => `${code.code} · ${code.labelI18n[locale] ?? code.labelI18n.it ?? code.code}`

/** The pop-ups of one person's day: Fix a day, Accept an anomaly, Reopen, Correct a closed day. */
export function DayDialogs({ state, codes, actions, events, absences }: { state: DayState; codes: readonly AbsenceCode[]; actions?: DayActions | undefined; events: readonly ClockEvent[]; absences: readonly DayAbsence[] }) {
  const t = useAttendanceWords()
  const { dialog } = state
  if (!dialog) return null
  if (dialog.kind === 'fix') return <FixDialog t={t} dialog={dialog} codes={codes} events={events} absences={absences} actions={actions} />
  if (dialog.kind === 'correct') return <CorrectDialog t={t} dialog={dialog} actions={actions} />
  const accept = dialog.kind === 'accept'
  const text = accept ? dialog.note : dialog.reason
  const held = text.trim().length < REASON_MIN ? t('held.reason') : null
  const save = () => (accept ? actions?.onAcceptSave() : actions?.onReopenSave())
  return (
    <Modal open onClose={() => actions?.onCloseDialog()} title={t(accept ? 'accept.title' : 'reopen.title')} size="sm" className="fw-at-over" footer={<Footer t={t} held={held} busy={dialog.busy} label={t(accept ? 'accept.submit' : 'reopen.submit')} onCancel={() => actions?.onCloseDialog()} onSave={save} />}>
      <Form held={held} onSave={save}>
        <Problem t={t} words={dialog.problem} />
        <p className="fw-pp-hint">{t(accept ? 'accept.body' : 'reopen.body')}</p>
        <Field label={t(accept ? 'accept.note' : 'field.reason')} required>
          <Textarea value={text} maxLength={500} rows={3} onChange={(event) => (accept ? actions?.onAcceptNote(event.target.value) : actions?.onReopenReason(event.target.value))} />
        </Field>
      </Form>
    </Modal>
  )
}

function FixDialog({ t, dialog, codes, events, absences, actions }: { t: AttendanceWords; dialog: Extract<DayDialog, { kind: 'fix' }>; codes: readonly AbsenceCode[]; events: readonly ClockEvent[]; absences: readonly DayAbsence[]; actions?: DayActions | undefined }) {
  const id = useId()
  const locale = useLocale()
  const { draft } = dialog
  const heldKey = fixHeld(draft)
  const held = heldKey ? t(heldKey) : null
  const voidable = events.filter((event) => !event.voided && event.kind !== 'VOID')
  const code = codes.find((entry) => entry.id === draft.codeId)
  const choices = FIX_CHOICES.filter((choice) => (choice === 'REMOVE_ABSENCE' ? absences.length > 0 : choice === 'VOID' ? voidable.length > 0 : true))
  const save = () => actions?.onFixSave()
  return (
    <Modal open onClose={() => actions?.onCloseDialog()} title={t('fix.title')} size="md" className="fw-at-over" footer={<Footer t={t} held={held} busy={dialog.busy} label={t('fix.submit')} onCancel={() => actions?.onCloseDialog()} onSave={save} />}>
      <Form held={held} onSave={save}>
        <Problem t={t} words={dialog.problem} />
        <div className="fw-pp-form">
          <Field label={t('fix.what')} required htmlFor={`${id}-what`} className="wide">
            <Select id={`${id}-what`} value={draft.choice} onChange={(event) => actions?.onFixDraft({ choice: event.target.value as FixChoice })}>
              {choices.map((choice) => (
                <option key={choice} value={choice}>
                  {t(`fix.choice.${choice}`)}
                </option>
              ))}
            </Select>
          </Field>
          {(draft.choice === 'ADD' || draft.choice === 'OFF_SITE') && (
            <>
              <Field label={t('fix.event')} required htmlFor={`${id}-event`}>
                <Select id={`${id}-event`} value={draft.event} onChange={(event) => actions?.onFixDraft({ event: event.target.value as FixEvent })}>
                  {FIX_EVENTS.map((event) => (
                    <option key={event} value={event}>
                      {t(`event.kind.${event}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('fix.at')} required htmlFor={`${id}-at`}>
                <DateTimeField id={`${id}-at`} value={draft.at} stepMinutes={5} onChange={(at) => actions?.onFixDraft({ at })} />
              </Field>
            </>
          )}
          {draft.choice === 'VOID' && (
            <Field label={t('fix.voidEvent')} required htmlFor={`${id}-void`} hint={t('fix.voidHint')} className="wide">
              <Select id={`${id}-void`} value={draft.clockEventId} onChange={(event) => actions?.onFixDraft({ clockEventId: event.target.value })}>
                <option value="">{t('fix.voidPick')}</option>
                {voidable.map((event) => (
                  <option key={event.id} value={event.id}>
                    {timeOf(event.occurredAt, locale)} · {t(`event.kind.${event.kind}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {draft.choice === 'ABSENCE' && (
            <>
              <Field label={t('fix.code')} required htmlFor={`${id}-code`}>
                <Select id={`${id}-code`} value={draft.codeId} onChange={(event) => actions?.onFixDraft({ codeId: event.target.value })}>
                  <option value="">{t('fix.codePick')}</option>
                  {codes.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {codeText(entry, locale)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('fix.hours')} htmlFor={`${id}-hours`} hint={t('fix.hoursHint')}>
                <Input id={`${id}-hours`} inputMode="decimal" value={draft.hours} onChange={(event) => actions?.onFixDraft({ hours: event.target.value })} />
              </Field>
              {code?.documentRequired && (
                <Field label={t('fix.document')} htmlFor={`${id}-doc`} hint={t('fix.documentHint')} className="wide">
                  <Input id={`${id}-doc`} value={draft.documentRef} maxLength={40} onChange={(event) => actions?.onFixDraft({ documentRef: event.target.value })} />
                </Field>
              )}
            </>
          )}
          {draft.choice === 'REMOVE_ABSENCE' && (
            <Field label={t('fix.removeAbsence')} required htmlFor={`${id}-remove`} className="wide">
              <Select id={`${id}-remove`} value={draft.absenceId} onChange={(event) => actions?.onFixDraft({ absenceId: event.target.value })}>
                <option value="">{t('fix.removePick')}</option>
                {absences.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.code} · {hoursWords(entry.minutes, locale)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <ReasonFields t={t} id={id} draft={draft} onDraft={(patch) => actions?.onFixDraft(patch)} />
        </div>
        <p className="fw-pp-hint">{t('fix.note')}</p>
      </Form>
    </Modal>
  )
}

function CorrectDialog({ t, dialog, actions }: { t: AttendanceWords; dialog: Extract<DayDialog, { kind: 'correct' }>; actions?: DayActions | undefined }) {
  const id = useId()
  const locale = useLocale()
  const { draft, record } = dialog
  const before = figureOf(record.figuresNow, draft.kind, draft.kind === 'ABSENCE' ? draft.absenceCodeId : null)
  const heldKey = correctionHeld(draft, before)
  const held = heldKey ? t(heldKey) : null
  const kinds = CORRECTION_KINDS.filter((kind) => kind !== 'ABSENCE' || record.figuresNow.absences.length > 0)
  const save = () => actions?.onCorrectSave()
  return (
    <Modal open onClose={() => actions?.onCloseDialog()} title={t('correct.title')} size="md" className="fw-at-over" footer={<Footer t={t} held={held} busy={dialog.busy} label={t('correct.submit')} onCancel={() => actions?.onCloseDialog()} onSave={save} />}>
      <Form held={held} onSave={save}>
        <Problem t={t} words={dialog.problem} />
        <div className="fw-pp-form">
          <Field label={t('correct.kind')} required htmlFor={`${id}-kind`}>
            <Select id={`${id}-kind`} value={draft.kind} onChange={(event) => actions?.onCorrectDraft({ kind: event.target.value as CorrectionKind })}>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`correctKind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          {draft.kind === 'ABSENCE' && (
            <Field label={t('fix.code')} required htmlFor={`${id}-code`}>
              <Select id={`${id}-code`} value={draft.absenceCodeId} onChange={(event) => actions?.onCorrectDraft({ absenceCodeId: event.target.value })}>
                {record.figuresNow.absences.map((entry) => (
                  <option key={entry.codeId} value={entry.codeId}>
                    {entry.code}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('correct.minutes')} required htmlFor={`${id}-minutes`} hint={t('correct.stands', { hours: hoursWords(before, locale), minutes: before })}>
            <Input id={`${id}-minutes`} inputMode="numeric" value={draft.minutes} onChange={(event) => actions?.onCorrectDraft({ minutes: event.target.value })} />
          </Field>
          <Field label={t('field.reason')} required htmlFor={`${id}-reason`} className="wide">
            <Input id={`${id}-reason`} value={draft.reason} maxLength={500} onChange={(event) => actions?.onCorrectDraft({ reason: event.target.value })} />
          </Field>
        </div>
        <p className="fw-pp-hint">{t('correct.note')}</p>
      </Form>
    </Modal>
  )
}

