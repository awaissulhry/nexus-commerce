'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Banner, DateField, Field, Modal } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { REGISTER_RISKS, type EntryDetail, type PartyOption, type RegisterRisk } from '../../api'
import type { EntryAction } from '../../model'

/**
 * The register entry's action dialogs (SCR-113, design rg-event / rg-actions / rg-inform W1): each changes one thing with
 * the version read, explicitly (never autosaved), and says what it records. W1 records that distributors and the
 * authority were informed; it sends nothing (the mail goes from the entry's thread). A refusal shows our title with the
 * API's problem lines under it (a 409 `problem/<CODE>`). ⌘↵ confirms when allowed; Esc closes.
 */

export interface DialogsActions {
  onCloseDialog?: () => void
  onEditEvent?: (patch: { description: string; partyId: string | null }) => void
  onAssess?: (patch: { risk: RegisterRisk; investigation: string | null }) => void
  onAction?: (input: { actionTaken: string; done: boolean; doneOn: string }) => void
  onInform?: (input: { day: string; note: string }) => void
  onNotify?: (input: { day: string; reference: string; note: string }) => void
  onCloseEntry?: (reason: string) => void
}

export interface DialogsModel {
  readonly entry: EntryDetail
  readonly dialog: EntryAction | null
  readonly busy: boolean
  readonly problem: { key: string; lines: readonly string[] } | null
  readonly today: string
  /** The reporters the event may name (null: the person cannot list parties). */
  readonly parties: readonly PartyOption[] | null
}

function useConfirmKey(open: boolean, held: string | null, onConfirm: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
        event.preventDefault()
        onConfirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, held, onConfirm])
}

function Frame({
  open,
  title,
  sub,
  confirm,
  held,
  busy,
  problem,
  tone = 'primary',
  onConfirm,
  onClose,
  children,
}: {
  open: boolean
  title: string
  sub?: string
  confirm: string
  held: string | null
  busy: boolean
  problem: DialogsModel['problem']
  tone?: 'primary' | 'danger'
  onConfirm: () => void
  onClose: () => void
  children?: ReactNode
}) {
  const t = useT('register')
  const q = useT('quality')
  const s = useScopedT('register')
  useConfirmKey(open, held ?? (busy ? t('dialog.saving') : null), onConfirm)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={sub}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{q('common.cancel')}</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} heldReason={held ?? (busy ? t('dialog.saving') : null)} onClick={onConfirm}>
            {busy ? <Spinner size={14} /> : null} {confirm}
          </Button>
        </>
      }
    >
      <div className="fw-q-form">
        {problem && (
          <Banner tone="danger" title={s(problem.key)}>
            {problem.lines.length > 0 && (
              <ul className="fw-q-lines">
                {problem.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        {children}
      </div>
    </Modal>
  )
}

export function EntryDialogs({ model, actions }: { model: DialogsModel; actions?: DialogsActions }) {
  const close = () => actions?.onCloseDialog?.()
  const { dialog } = model
  return (
    <>
      <EditEventDialog open={dialog === 'edit'} model={model} onClose={close} onSave={(patch) => actions?.onEditEvent?.(patch)} />
      <AssessDialog open={dialog === 'risk'} model={model} onClose={close} onSave={(patch) => actions?.onAssess?.(patch)} />
      <ActionDialog open={dialog === 'action'} model={model} onClose={close} onSave={(input) => actions?.onAction?.(input)} />
      <InformDialog open={dialog === 'distributors'} model={model} onClose={close} onSave={(input) => actions?.onInform?.(input)} />
      <NotifyDialog open={dialog === 'authority'} model={model} onClose={close} onSave={(input) => actions?.onNotify?.(input)} />
      <CloseDialog open={dialog === 'close'} model={model} onClose={close} onSave={(reason) => actions?.onCloseEntry?.(reason)} />
    </>
  )
}

interface DialogProps<T> {
  open: boolean
  model: DialogsModel
  onClose: () => void
  onSave: (value: T) => void
}

function EditEventDialog({ open, model, onClose, onSave }: DialogProps<{ description: string; partyId: string | null }>) {
  const t = useT('register')
  const [description, setDescription] = useState(model.entry.description)
  const [partyId, setPartyId] = useState(model.entry.partyId ?? '')
  useEffect(() => {
    if (open) {
      setDescription(model.entry.description)
      setPartyId(model.entry.partyId ?? '')
    }
  }, [open, model.entry.description, model.entry.partyId])
  const held = !description.trim() ? t('new.problem.description') : null
  return (
    <Frame
      open={open}
      title={t('dialog.edit.title')}
      sub={t('dialog.edit.sub')}
      confirm={t('dialog.edit.confirm')}
      held={held}
      busy={model.busy}
      problem={model.problem}
      onConfirm={() => onSave({ description: description.trim(), partyId: partyId || null })}
      onClose={onClose}
    >
      <Field label={t('new.description')} required>
        <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} limit={4000} />
      </Field>
      <Field label={t('new.reporter')} hint={model.parties === null ? t('new.reporterNoRight') : t('new.reporterHint')}>
        <Select value={partyId} onChange={(event) => setPartyId(event.target.value)} disabled={model.parties === null}>
          <option value="">{t('new.noReporter')}</option>
          {model.entry.party && !(model.parties ?? []).some((party) => party.id === model.entry.party!.id) && (
            <option value={model.entry.party.id}>
              {model.entry.party.name} ({model.entry.party.code})
            </option>
          )}
          {(model.parties ?? []).map((party) => (
            <option key={party.id} value={party.id}>
              {party.tradeName ?? party.legalName} ({party.code})
            </option>
          ))}
        </Select>
      </Field>
    </Frame>
  )
}

function AssessDialog({ open, model, onClose, onSave }: DialogProps<{ risk: RegisterRisk; investigation: string | null }>) {
  const t = useT('register')
  const [risk, setRisk] = useState<RegisterRisk>(model.entry.risk)
  const [investigation, setInvestigation] = useState(model.entry.investigation ?? '')
  useEffect(() => {
    if (open) {
      setRisk(model.entry.risk)
      setInvestigation(model.entry.investigation ?? '')
    }
  }, [open, model.entry.risk, model.entry.investigation])
  return (
    <Frame
      open={open}
      title={t('dialog.risk.title')}
      sub={t('dialog.risk.sub')}
      confirm={t('dialog.risk.confirm')}
      held={null}
      busy={model.busy}
      problem={model.problem}
      onConfirm={() => onSave({ risk, investigation: investigation.trim() || null })}
      onClose={onClose}
    >
      <fieldset className="fw-q-choices">
        <legend className="fw-q-hint">{t('new.risk')}</legend>
        <div className="fw-q-choices">
          {REGISTER_RISKS.map((value) => (
            <RadioCard key={value} name="assess-risk" value={value} checked={risk === value} selected={risk === value} onChange={() => setRisk(value)} title={t(`risk.${value}`)} description={t(`riskHint.${value}`)} />
          ))}
        </div>
      </fieldset>
      {risk === 'YES' && <Banner tone="warning" title={t('dialog.risk.yesWarning')} />}
      <Field label={t('dialog.risk.investigation')} hint={t('dialog.risk.investigationHint')}>
        <Textarea value={investigation} onChange={(event) => setInvestigation(event.target.value)} rows={4} limit={4000} />
      </Field>
    </Frame>
  )
}

function ActionDialog({ open, model, onClose, onSave }: DialogProps<{ actionTaken: string; done: boolean; doneOn: string }>) {
  const t = useT('register')
  const locale = useLocale()
  const [actionTaken, setActionTaken] = useState(model.entry.actionTaken ?? '')
  const [done, setDone] = useState(false)
  const [doneOn, setDoneOn] = useState(model.today)
  useEffect(() => {
    if (open) {
      setActionTaken(model.entry.actionTaken ?? '')
      setDone(false)
      setDoneOn(model.today)
    }
  }, [open, model.entry.actionTaken, model.today])
  const held = !actionTaken.trim() ? t('dialog.action.needsText') : done && !doneOn ? t('dialog.action.needsDay') : null
  return (
    <Frame
      open={open}
      title={t('dialog.action.title')}
      sub={t('dialog.action.sub')}
      confirm={done ? t('dialog.action.confirmDone') : t('dialog.action.confirm')}
      held={held}
      busy={model.busy}
      problem={model.problem}
      onConfirm={() => onSave({ actionTaken: actionTaken.trim(), done, doneOn })}
      onClose={onClose}
    >
      <Field label={t('dialog.action.text')} required hint={t('dialog.action.textHint')}>
        <Textarea value={actionTaken} onChange={(event) => setActionTaken(event.target.value)} rows={4} limit={4000} />
      </Field>
      <Checkbox checked={done} onChange={(event) => setDone(event.target.checked)} label={t('dialog.action.done')} />
      {done && (
        <Field label={t('dialog.action.doneOn')} hint={t('dialog.action.doneOnHint')}>
          <DateField value={doneOn} onChange={setDoneOn} max={model.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} ariaLabel={t('dialog.action.doneOn')} />
        </Field>
      )}
      <p className="fw-q-hint">{t('dialog.action.law')}</p>
    </Frame>
  )
}

function InformDialog({ open, model, onClose, onSave }: DialogProps<{ day: string; note: string }>) {
  const t = useT('register')
  const locale = useLocale()
  const [day, setDay] = useState(model.today)
  const [note, setNote] = useState('')
  useEffect(() => {
    if (open) {
      setDay(model.today)
      setNote('')
    }
  }, [open, model.today])
  const customers = model.entry.trace.customers
  const held = !note.trim() ? t('dialog.inform.needsNote') : !day ? t('dialog.action.needsDay') : null
  return (
    <Frame
      open={open}
      title={t('dialog.inform.title')}
      sub={t('dialog.inform.sub')}
      confirm={t('dialog.inform.confirm')}
      held={held}
      busy={model.busy}
      problem={model.problem}
      onConfirm={() => onSave({ day, note: note.trim() })}
      onClose={onClose}
    >
      <Banner tone="info" title={t('dialog.inform.recordsOnly')} />
      {customers.length > 0 ? (
        <div className="fw-q-stack">
          <p className="fw-q-hint">{t('dialog.inform.who', { count: customers.length })}</p>
          <ul className="fw-q-lines">
            {customers.map((customer) => (
              <li key={customer.partyId}>
                {customer.name} ({customer.code}) — {t('dialog.inform.garments', { count: customer.garments })}
                {customer.ddtNumbers.length > 0 ? ` · ${t('dialog.inform.ddt', { numbers: customer.ddtNumbers.join(', ') })}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="fw-q-hint">{t('dialog.inform.nobody')}</p>
      )}
      <Field label={t('dialog.inform.day')}>
        <DateField value={day} onChange={setDay} max={model.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} ariaLabel={t('dialog.inform.day')} />
      </Field>
      <Field label={t('dialog.inform.note')} required hint={t('dialog.inform.noteHint')}>
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} limit={4000} />
      </Field>
    </Frame>
  )
}

function NotifyDialog({ open, model, onClose, onSave }: DialogProps<{ day: string; reference: string; note: string }>) {
  const t = useT('register')
  const locale = useLocale()
  const [day, setDay] = useState(model.today)
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    if (open) {
      setDay(model.today)
      setReference('')
      setNote('')
    }
  }, [open, model.today])
  const held = !reference.trim() ? t('dialog.notify.needsReference') : !note.trim() ? t('dialog.notify.needsNote') : !day ? t('dialog.action.needsDay') : null
  return (
    <Frame
      open={open}
      title={t('dialog.notify.title')}
      sub={t('dialog.notify.sub')}
      confirm={t('dialog.notify.confirm')}
      held={held}
      busy={model.busy}
      problem={model.problem}
      onConfirm={() => onSave({ day, reference: reference.trim(), note: note.trim() })}
      onClose={onClose}
    >
      <Banner tone="info" title={t('dialog.notify.recordsOnly')} />
      <div className="fw-q-form-two">
        <Field label={t('dialog.notify.day')}>
          <DateField value={day} onChange={setDay} max={model.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} ariaLabel={t('dialog.notify.day')} />
        </Field>
        <Field label={t('dialog.notify.reference')} required hint={t('dialog.notify.referenceHint')}>
          <Input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={120} />
        </Field>
      </div>
      <Field label={t('dialog.notify.note')} required hint={t('dialog.notify.noteHint')}>
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} limit={4000} />
      </Field>
    </Frame>
  )
}

function CloseDialog({ open, model, onClose, onSave }: DialogProps<string>) {
  const t = useT('register')
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (open) setReason('')
  }, [open])
  const open_ = model.entry.toClose
  const held = !reason.trim() ? t('dialog.close.needsReason') : null
  return (
    <Frame
      open={open}
      title={t('dialog.close.title', { reference: model.entry.reference })}
      sub={t('dialog.close.sub')}
      confirm={t('dialog.close.confirm')}
      held={held}
      busy={model.busy}
      problem={model.problem}
      onConfirm={() => onSave(reason.trim())}
      onClose={onClose}
    >
      {open_.length > 0 && !model.problem && (
        <Banner tone="warning" title={t('dialog.close.stillOpen', { count: open_.length })}>
          <ul className="fw-q-lines">
            {open_.map((problem) => (
              <li key={problem.code}>{problem.message}</li>
            ))}
          </ul>
        </Banner>
      )}
      <Field label={t('dialog.close.reason')} required hint={t('dialog.close.reasonHint')}>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} limit={1000} />
      </Field>
      <p className="fw-q-hint">{t('dialog.close.final')}</p>
    </Frame>
  )
}
