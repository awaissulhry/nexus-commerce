'use client'

import { useId } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, SegmentedControl, Select } from '@nexus/ui/primitives'
import { ConfirmPhraseField, DateField, DateTimeField, Modal } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { MonthPanel } from '../api'
import { dayShort, manualHeld, monthWords, phraseOf, type ManualChoice } from '../model'
import type { AttendanceActions, AttendanceModel, PageDialog } from '../view-model'
import { codeText, Footer, Form, Problem, ReasonFields } from './DayDialogs'
import { useAttendanceWords, type AttendanceWords } from './parts'

/** The page's own pop-ups: Manual entry, Close October 2026 (typed), and what a bulk approval held. */
export function PageDialogs({ model, actions }: { model: AttendanceModel; actions?: AttendanceActions | undefined }) {
  const t = useAttendanceWords()
  const { dialog } = model
  if (!dialog) return null
  if (dialog.kind === 'manual') return <ManualDialog t={t} model={model} dialog={dialog} actions={actions} />
  if (dialog.kind === 'held') return <HeldDialog t={t} model={model} dialog={dialog} actions={actions} />
  if (model.panel.status !== 'ready') return null
  return <CloseDialog t={t} panel={model.panel.value} dialog={dialog} actions={actions} />
}

function ManualDialog({ t, model, dialog, actions }: { t: AttendanceWords; model: AttendanceModel; dialog: Extract<PageDialog, { kind: 'manual' }>; actions?: AttendanceActions | undefined }) {
  const id = useId()
  const locale = useLocale()
  const { draft, people } = dialog
  const heldKey = model.can.people ? manualHeld(draft, model.today) : 'held.noPeople'
  const held = heldKey ? t(heldKey) : null
  const close = () => actions?.onCloseDialog()
  const save = () => actions?.onManualSave()
  return (
    <Modal open onClose={close} title={t('manual.title')} size="md" footer={<Footer t={t} held={held} busy={dialog.busy} label={t('manual.submit')} onCancel={close} onSave={save} />}>
      <Form held={held} onSave={save}>
        <Problem t={t} words={dialog.problem} />
        <div className="fw-pp-form">
          <Field label={t('manual.person')} required htmlFor={`${id}-find`} hint={draft.employeeName ? t('manual.chosen', { name: draft.employeeName }) : t('manual.personHint')} className="wide">
            <span className="fw-pp-stack tight">
              <Input id={`${id}-find`} type="search" placeholder={t('manual.personSearch')} disabled={!model.can.people} onChange={(event) => actions?.onFindPerson(event.target.value)} />
              {people && people.length > 0 && (
                <Select aria-label={t('manual.personPick')} value={draft.employeeId} onChange={(event) => actions?.onManualDraft({ employeeId: event.target.value, employeeName: people.find((entry) => entry.id === event.target.value)?.name ?? '' })}>
                  <option value="">{t('manual.personPick')}</option>
                  {people.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.code ? `${entry.code} · ${entry.name}` : entry.name}
                    </option>
                  ))}
                </Select>
              )}
              {people && people.length === 0 && <span className="fw-pp-hint">{t('manual.personNone')}</span>}
            </span>
          </Field>
          <Field label={t('manual.date')} required htmlFor={`${id}-date`}>
            <DateField id={`${id}-date`} value={draft.date} onChange={(date) => actions?.onManualDraft({ date })} />
          </Field>
          <Field label={t('manual.entry')} required>
            <SegmentedControl
              size="sm"
              ariaLabel={t('manual.entry')}
              value={draft.choice}
              onChange={(choice) => actions?.onManualDraft({ choice: choice as ManualChoice })}
              options={[
                { value: 'TIMES', label: t('manual.times') },
                { value: 'ABSENCE', label: t('manual.absence') },
              ]}
            />
          </Field>
          {draft.choice === 'TIMES' ? (
            <>
              <Field label={t('event.kind.IN')} htmlFor={`${id}-in`}>
                <DateTimeField id={`${id}-in`} value={draft.in} stepMinutes={5} onChange={(value) => actions?.onManualDraft({ in: value })} />
              </Field>
              <Field label={t('event.kind.OUT')} htmlFor={`${id}-out`}>
                <DateTimeField id={`${id}-out`} value={draft.out} stepMinutes={5} onChange={(value) => actions?.onManualDraft({ out: value })} />
              </Field>
              <div className="wide">
                <Checkbox label={t('manual.offSite')} checked={draft.offSite} onChange={(event) => actions?.onManualDraft({ offSite: event.target.checked })} />
              </div>
            </>
          ) : (
            <>
              <Field label={t('fix.code')} required htmlFor={`${id}-code`}>
                <Select id={`${id}-code`} value={draft.codeId} onChange={(event) => actions?.onManualDraft({ codeId: event.target.value })}>
                  <option value="">{t('fix.codePick')}</option>
                  {model.codes.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {codeText(entry, locale)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('fix.hours')} htmlFor={`${id}-hours`} hint={t('fix.hoursHint')}>
                <Input id={`${id}-hours`} inputMode="decimal" value={draft.hours} onChange={(event) => actions?.onManualDraft({ hours: event.target.value })} />
              </Field>
              {model.codes.find((entry) => entry.id === draft.codeId)?.documentRequired && (
                <Field label={t('fix.document')} htmlFor={`${id}-doc`} hint={t('fix.documentHint')} className="wide">
                  <Input id={`${id}-doc`} value={draft.documentRef} maxLength={40} onChange={(event) => actions?.onManualDraft({ documentRef: event.target.value })} />
                </Field>
              )}
            </>
          )}
          <ReasonFields t={t} id={id} draft={draft} onDraft={(patch) => actions?.onManualDraft(patch)} />
        </div>
        <p className="fw-pp-hint">{t('manual.note')}</p>
      </Form>
    </Modal>
  )
}

/** Typed confirm: a typed phrase only for the monthly run and the final month close (Owner answer P1). */
function CloseDialog({ t, panel, dialog, actions }: { t: AttendanceWords; panel: MonthPanel; dialog: Extract<PageDialog, { kind: 'close' }>; actions?: AttendanceActions | undefined }) {
  const locale = useLocale()
  const month = monthWords(panel.month, locale)
  const phrase = phraseOf(panel, locale)
  const held = dialog.typed === phrase ? null : t('held.typePhrase', { phrase })
  const close = () => actions?.onCloseDialog()
  const save = () => actions?.onCloseSave()
  return (
    <Modal open onClose={close} title={t('close.dialogTitle', { month })} size="sm" footer={<Footer t={t} held={held} busy={dialog.busy} danger label={t('close.submit')} onCancel={close} onSave={save} />}>
      <Form held={held} onSave={save}>
        <Problem t={t} words={dialog.problem} />
        <ul className="fw-at-confirm-list">
          <li>{t('close.consequence.lock')}</li>
          <li>{t('close.consequence.corrections')}</li>
          <li>{t('close.consequence.seal')}</li>
        </ul>
        <ConfirmPhraseField phrase={phrase} value={dialog.typed} onChange={(typed) => actions?.onCloseTyped(typed)} />
      </Form>
    </Modal>
  )
}

function HeldDialog({ t, model, dialog, actions }: { t: AttendanceWords; model: AttendanceModel; dialog: Extract<PageDialog, { kind: 'held' }>; actions?: AttendanceActions | undefined }) {
  const locale = useLocale()
  const team = (id: string | null) => model.teams.find((entry) => entry.id === id)?.code ?? null
  const close = () => actions?.onCloseDialog()
  return (
    <Modal
      open
      onClose={close}
      title={t('held.title', { approved: dialog.approved })}
      size="md"
      footer={
        <>
          <span className="fw-pp-grow" />
          <Button size="sm" variant="primary" onClick={close}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="fw-pp-stack tight">
        {dialog.groups.map((group) => (
          <Banner key={group.code} tone="warning" title={`${t(group.code === 'OUT_OF_REACH' ? 'held.outOfReach' : `hold.day.${group.code}`)} (${group.days.length})`}>
            <span className="fw-pp-row">
              {group.days.slice(0, 12).map((day) => (
                <Button
                  key={day.id}
                  size="sm"
                  variant="quiet"
                  onClick={() => {
                    close()
                    actions?.onOpenDay(day.id)
                  }}
                >
                  {day.date ? dayShort(day.date, locale) : t('day.title')}
                  {team(day.teamId) ? ` · ${team(day.teamId)}` : ''}
                </Button>
              ))}
              {group.days.length > 12 && <span className="fw-pp-hint">{t('held.more', { count: group.days.length - 12 })}</span>}
            </span>
          </Banner>
        ))}
      </div>
    </Modal>
  )
}
