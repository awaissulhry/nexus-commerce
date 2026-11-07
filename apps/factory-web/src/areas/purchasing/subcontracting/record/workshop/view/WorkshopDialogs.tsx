'use client'

import type { ReactNode } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { dayAt } from '../../../../../_shared/buying/model'
import { DECLINE_REASONS, type WorkshopAnswer } from '../api'
import { cellKey, dialogHeld, plain, sentLines, type WorkshopActions, type WorkshopDialog, type WorkshopPanelModel } from '../model'
import { useScrapWords, useWords } from './words'

type Of<K extends WorkshopDialog['kind']> = Extract<WorkshopDialog, { kind: K }>

interface DialogProps<K extends WorkshopDialog['kind']> {
  answer: WorkshopAnswer
  model: WorkshopPanelModel
  actions?: WorkshopActions | undefined
  dialog: Of<K>
}

/**
 * The panel's dialogs (B-W2b-176; Esc closes each and the focus goes back to its opener; ⌘↵ confirms where it may): send the
 * job link (to a contact, a typed address, or the address handed out once), answer the date the workshop proposed, and the
 * workshop's own acts recorded by the office for a workshop without e-mail (Owner answer C3) — its answer, the kit check,
 * finished pieces, a send-back —, and the cancel of an announced send-back. Each refusal is said inside its dialog.
 */
export function WorkshopDialogs({ answer, model, actions }: { answer: WorkshopAnswer; model: WorkshopPanelModel; actions?: WorkshopActions | undefined }) {
  const dialog = model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'link':
      return <LinkDialog answer={answer} model={model} actions={actions} dialog={dialog} />
    case 'date':
      return <DateDialog answer={answer} model={model} actions={actions} dialog={dialog} />
    case 'answer':
      return <AnswerDialog answer={answer} model={model} actions={actions} dialog={dialog} />
    case 'kit':
      return <KitDialog answer={answer} model={model} actions={actions} dialog={dialog} />
    case 'progress':
      return <ProgressDialog answer={answer} model={model} actions={actions} dialog={dialog} />
    case 'returns':
      return <ReturnsDialog answer={answer} model={model} actions={actions} dialog={dialog} />
    case 'cancelReturn':
      return <CancelReturnDialog answer={answer} model={model} actions={actions} dialog={dialog} />
  }
}

function Frame({ model, actions, answer, title, label, tone, size = 'md', onConfirm, children }: { model: WorkshopPanelModel; actions?: WorkshopActions | undefined; answer: WorkshopAnswer; title: string; label: string; tone?: 'danger'; size?: 'sm' | 'md' | 'lg'; onConfirm?: (() => void) | undefined; children: ReactNode }) {
  const { t, sayWords } = useWords()
  const reason = model.dialog ? dialogHeld(model.dialog, answer, model.today) : null
  const blocked = model.busy ? t('held.busy') : reason ? sayWords(reason) : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={title}
      size={size}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)} heldReason={model.busy ? t('held.busy') : null}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" tone={tone} heldReason={blocked} onClick={onConfirm} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy && <Spinner size={12} />} {label}
          </Button>
        </>
      }
    >
      <div
        className="fw-by-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !blocked) {
            event.preventDefault()
            onConfirm?.()
          }
        }}
      >
        {children}
        {model.problem && <Banner tone="danger" title={sayWords(model.problem)} />}
      </div>
    </Modal>
  )
}

/** The name the workshop gave by phone (optional): stored as who answered. */
function NameField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useWords()
  return (
    <Field label={t('dialog.name')} hint={t('dialog.nameHint')}>
      <Input size="sm" maxLength={200} value={value} onChange={(event) => onChange(event.target.value)} />
    </Field>
  )
}

function LinkDialog({ answer, model, actions, dialog }: DialogProps<'link'>) {
  const { t } = useWords()
  const set = (patch: Partial<Of<'link'>>) => actions?.onDialog?.({ ...dialog, ...patch })
  return (
    <Frame model={model} actions={actions} answer={answer} title={t('link.title', { number: answer.job.number })} label={t(dialog.mode === 'hand' ? 'link.confirmHand' : 'link.confirmMail')} onConfirm={actions?.onSendLink}>
      <p className="fw-by-hint">{t('link.what')}</p>
      <div className="fw-by-cards" role="radiogroup" aria-label={t('link.how')}>
        <RadioCard name="link-mode" checked={dialog.mode === 'mail'} selected={dialog.mode === 'mail'} onChange={() => set({ mode: 'mail' })} title={t('link.mail')} description={t('link.mailHint')} />
        <RadioCard name="link-mode" checked={dialog.mode === 'hand'} selected={dialog.mode === 'hand'} onChange={() => set({ mode: 'hand' })} title={t('link.hand')} description={t('link.handHint')} />
      </div>
      {dialog.mode === 'mail' && (
        <div className="fw-by-fields">
          {answer.reach.contacts.length > 0 && (
            <Field label={t('link.contact')}>
              <Select size="sm" value={dialog.contactId} onChange={(event) => set({ contactId: event.target.value })}>
                {answer.reach.contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name} · {contact.email}
                  </option>
                ))}
                <option value="">{t('link.typed')}</option>
              </Select>
            </Field>
          )}
          {!dialog.contactId && (
            <Field label={t('link.email')} required>
              <Input size="sm" type="email" maxLength={254} value={dialog.email} autoFocus onChange={(event) => set({ email: event.target.value })} />
            </Field>
          )}
        </div>
      )}
      <Field label={t('link.language')}>
        <Select size="sm" value={dialog.language} onChange={(event) => set({ language: event.target.value as Of<'link'>['language'] })}>
          <option value="">{t('link.languageDefault')}</option>
          <option value="it">{t('link.languageIt')}</option>
          <option value="en">{t('link.languageEn')}</option>
        </Select>
      </Field>
      {answer.links.some((link) => link.state === 'LIVE') && <p className="fw-by-hint">{t('link.replaces')}</p>}
    </Frame>
  )
}

function DateDialog({ answer, model, actions, dialog }: DialogProps<'date'>) {
  const { t } = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const proposed = answer.job.answer.proposedDate ? formatDate(dayAt(answer.job.answer.proposedDate), place) : ''
  const accept = dialog.decision === 'ACCEPTED'
  return (
    <Frame model={model} actions={actions} answer={answer} size="sm" title={t(accept ? 'date.acceptTitle' : 'date.refuseTitle', { day: proposed })} label={t(accept ? 'date.accept' : 'date.refuse')} tone={accept ? undefined : 'danger'} onConfirm={actions?.onDecideDate}>
      <ul className="fw-by-list">
        <li>{t('date.reason', { reason: answer.job.answer.proposedDateReason ?? '' })}</li>
        <li>{t(accept ? 'date.acceptWhat' : 'date.refuseWhat', { day: proposed, asked: answer.job.expectedBackDate ? formatDate(dayAt(answer.job.expectedBackDate), place) : '—' })}</li>
        <li>{t('date.once')}</li>
      </ul>
    </Frame>
  )
}

function AnswerDialog({ answer, model, actions, dialog }: DialogProps<'answer'>) {
  const { t } = useWords()
  const locale = useLocale()
  const set = (patch: Partial<Of<'answer'>>) => actions?.onDialog?.({ ...dialog, ...patch })
  const acceptOpen = answer.job.acts.accept === null
  const declineOpen = answer.job.acts.decline === null
  return (
    <Frame model={model} actions={actions} answer={answer} title={t('answerDialog.title', { number: answer.job.number })} label={t(dialog.mode === 'decline' ? 'answerDialog.confirmDecline' : 'answerDialog.confirmAccept')} tone={dialog.mode === 'decline' ? 'danger' : undefined} onConfirm={actions?.onAnswer}>
      <p className="fw-by-hint">{t('dialog.forWorkshop')}</p>
      <div className="fw-ws-choices" role="radiogroup" aria-label={t('answerDialog.how')}>
        {acceptOpen && <RadioCard name="answer-mode" checked={dialog.mode === 'accept'} selected={dialog.mode === 'accept'} onChange={() => set({ mode: 'accept' })} title={t('answerDialog.accept')} description={t('answerDialog.acceptHint')} />}
        {acceptOpen && <RadioCard name="answer-mode" checked={dialog.mode === 'move'} selected={dialog.mode === 'move'} onChange={() => set({ mode: 'move' })} title={t('answerDialog.move')} description={t('answerDialog.moveHint')} />}
        {declineOpen && <RadioCard name="answer-mode" checked={dialog.mode === 'decline'} selected={dialog.mode === 'decline'} onChange={() => set({ mode: 'decline' })} title={t('answerDialog.decline')} description={t('answerDialog.declineHint')} />}
      </div>
      {dialog.mode === 'move' && (
        <div className="fw-by-fields">
          <Field label={t('answerDialog.day')} required>
            <DateField value={dialog.proposedDate} min={model.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} onChange={(value) => set({ proposedDate: value })} />
          </Field>
          <Field label={t('answerDialog.why')} required>
            <Textarea rows={2} maxLength={2000} value={dialog.reason} onChange={(event) => set({ reason: event.target.value })} />
          </Field>
        </div>
      )}
      {dialog.mode === 'decline' && (
        <div className="fw-by-fields">
          <Field label={t('answerDialog.declineReason')} required>
            <Select size="sm" value={dialog.declineReason} onChange={(event) => set({ declineReason: event.target.value as Of<'answer'>['declineReason'] })}>
              <option value="">{t('answerDialog.pick')}</option>
              {DECLINE_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {t(`declineReason.${reason}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('answerDialog.note')} required={dialog.declineReason === 'OTHER'}>
            <Textarea rows={2} maxLength={1900} value={dialog.note} onChange={(event) => set({ note: event.target.value })} />
          </Field>
        </div>
      )}
      <NameField value={dialog.name} onChange={(name) => set({ name })} />
    </Frame>
  )
}

function KitDialog({ answer, model, actions, dialog }: DialogProps<'kit'>) {
  const { t } = useWords()
  const open = sentLines(answer.job).filter((line) => line.check === null)
  const set = (patch: Partial<Of<'kit'>>) => actions?.onDialog?.({ ...dialog, ...patch })
  const line = (id: string, patch: Partial<{ quantity: string; note: string }>) => set({ lines: { ...dialog.lines, [id]: { quantity: dialog.lines[id]?.quantity ?? '', note: dialog.lines[id]?.note ?? '', ...patch } } })
  return (
    <Frame model={model} actions={actions} answer={answer} size="lg" title={t('kitDialog.title', { number: answer.job.number })} label={t('kitDialog.confirm')} onConfirm={actions?.onKit}>
      <p className="fw-by-hint">{t('dialog.forWorkshop')}</p>
      <Checkbox checked={dialog.all} onChange={(event) => set({ all: event.target.checked })} label={t('kitDialog.all', { count: open.length })} />
      {!dialog.all && (
        <ul className="fw-ws-rows">
          {open.map((entry) => (
            <li key={entry.id} className="fw-by-fields">
              <Field label={t('kitDialog.counted', { line: entry.seq, code: entry.item.code, sent: `${plain(entry.quantity)} ${entry.uom}` })}>
                <Input size="sm" inputMode="decimal" value={dialog.lines[entry.id]?.quantity ?? ''} onChange={(event) => line(entry.id, { quantity: event.target.value })} />
              </Field>
              <Field label={t('kitDialog.note')} hint={t('kitDialog.noteHint')}>
                <Input size="sm" maxLength={2000} value={dialog.lines[entry.id]?.note ?? ''} onChange={(event) => line(entry.id, { note: event.target.value })} />
              </Field>
            </li>
          ))}
        </ul>
      )}
      <p className="fw-by-hint">{t('kitDialog.photos')}</p>
    </Frame>
  )
}

function ProgressDialog({ answer, model, actions, dialog }: DialogProps<'progress'>) {
  const { t } = useWords()
  const locale = useLocale()
  const set = (patch: Partial<Of<'progress'>>) => actions?.onDialog?.({ ...dialog, ...patch })
  const cell = (key: string, value: string) => set({ cells: { ...dialog.cells, [key]: value } })
  return (
    <Frame model={model} actions={actions} answer={answer} size="lg" title={t('progressDialog.title', { number: answer.job.number })} label={t('progressDialog.confirm')} onConfirm={actions?.onProgress}>
      <p className="fw-by-hint">{t('dialog.forWorkshop')}</p>
      {answer.job.operations.map((operation) => (
        <fieldset key={operation.id} className="fw-ws-fieldset">
          <legend className="fw-by-h3">{t('progress.line', { line: operation.seq, code: operation.code, name: operation.name })}</legend>
          <p className="fw-by-hint">{t('progress.finished', { finished: operation.finished, pieces: operation.pieces })}</p>
          <div className="fw-by-fields">
            {operation.sizes.length === 0 ? (
              <Field label={t('progressDialog.whole')}>
                <Input size="sm" inputMode="numeric" value={dialog.cells[cellKey(operation.id, null)] ?? ''} onChange={(event) => cell(cellKey(operation.id, null), event.target.value)} />
              </Field>
            ) : (
              operation.sizes.map((size) => (
                <Field key={size.workOrderSizeId} label={t('progressDialog.size', { cell: `${size.colourway} ${size.size}`, finished: size.finished, pieces: size.pieces })}>
                  <Input size="sm" inputMode="numeric" value={dialog.cells[cellKey(operation.id, size.workOrderSizeId)] ?? ''} onChange={(event) => cell(cellKey(operation.id, size.workOrderSizeId), event.target.value)} />
                </Field>
              ))
            )}
          </div>
        </fieldset>
      ))}
      <div className="fw-by-fields">
        <Field label={t('progressDialog.finishBy')} hint={t('progressDialog.finishByHint')}>
          <DateField value={dialog.finishBy} min={answer.job.orderDate} clearable locale={locale === 'it' ? 'it-IT' : 'en-GB'} onChange={(value) => set({ finishBy: value })} />
        </Field>
        <Field label={t('progressDialog.note')}>
          <Textarea rows={2} maxLength={2000} value={dialog.note} onChange={(event) => set({ note: event.target.value })} />
        </Field>
      </div>
      <NameField value={dialog.name} onChange={(name) => set({ name })} />
    </Frame>
  )
}

function ReturnsDialog({ answer, model, actions, dialog }: DialogProps<'returns'>) {
  const { t } = useWords()
  const scrapWords = useScrapWords()
  const locale = useLocale()
  const set = (patch: Partial<Of<'returns'>>) => actions?.onDialog?.({ ...dialog, ...patch })
  const row = (operationId: string, patch: Partial<{ finished: string; scrapped: string; reasonCode: string }>) =>
    set({ rows: { ...dialog.rows, [operationId]: { finished: dialog.rows[operationId]?.finished ?? '0', scrapped: dialog.rows[operationId]?.scrapped ?? '0', reasonCode: dialog.rows[operationId]?.reasonCode ?? '', ...patch } } })
  const dateLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  return (
    <Frame model={model} actions={actions} answer={answer} size="lg" title={t('returnsDialog.title', { number: answer.job.number })} label={t('returnsDialog.confirm')} onConfirm={actions?.onReturn}>
      <p className="fw-by-hint">{t('dialog.forWorkshop')} {t('returnsDialog.nothingMoves')}</p>
      {answer.job.operations
        .filter((operation) => operation.announceable > 0)
        .map((operation) => {
          const value = dialog.rows[operation.id]
          return (
            <fieldset key={operation.id} className="fw-ws-fieldset">
              <legend className="fw-by-h3">{t('progress.line', { line: operation.seq, code: operation.code, name: operation.name })}</legend>
              <p className="fw-by-hint">{t('returnsDialog.left', { left: operation.announceable, ready: operation.ready })}</p>
              <div className="fw-by-fields">
                <Field label={t('returnsDialog.finished')}>
                  <Input size="sm" inputMode="numeric" value={value?.finished ?? ''} onChange={(event) => row(operation.id, { finished: event.target.value })} />
                </Field>
                <Field label={t('returnsDialog.scrapped')}>
                  <Input size="sm" inputMode="numeric" value={value?.scrapped ?? ''} onChange={(event) => row(operation.id, { scrapped: event.target.value })} />
                </Field>
                <Field label={t('returnsDialog.scrapReason')} required={Number(value?.scrapped ?? '0') > 0}>
                  <Select size="sm" value={value?.reasonCode ?? ''} onChange={(event) => row(operation.id, { reasonCode: event.target.value })}>
                    <option value="">{t('answerDialog.pick')}</option>
                    {answer.job.choices.scrapReasons.map((reason) => (
                      <option key={reason.code} value={reason.code}>
                        {scrapWords(reason.code)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </fieldset>
          )
        })}
      {sentLines(answer.job).length > 0 && (
        <fieldset className="fw-ws-fieldset">
          <legend className="fw-by-h3">{t('returnsDialog.material')}</legend>
          <div className="fw-by-fields">
            {sentLines(answer.job).map((line) => (
              <Field key={line.id} label={t('returnsDialog.materialLine', { line: line.seq, code: line.item.code, sent: `${plain(line.quantity)} ${line.uom}` })}>
                <Input size="sm" inputMode="decimal" value={dialog.material[line.id] ?? ''} onChange={(event) => set({ material: { ...dialog.material, [line.id]: event.target.value } })} />
              </Field>
            ))}
          </div>
        </fieldset>
      )}
      <div className="fw-by-fields">
        <Field label={t('returnsDialog.parcels')} required>
          <Input size="sm" inputMode="numeric" value={dialog.parcels} onChange={(event) => set({ parcels: event.target.value })} />
        </Field>
        <Field label={t('returnsDialog.day')} required>
          <DateField value={dialog.expectedDate} min={model.today} locale={dateLocale} onChange={(value) => set({ expectedDate: value })} />
        </Field>
        <Field label={t('returnsDialog.ddtNumber')} hint={t('returnsDialog.ddtHint')}>
          <Input size="sm" maxLength={40} value={dialog.ddtNumber} onChange={(event) => set({ ddtNumber: event.target.value })} />
        </Field>
        <Field label={t('returnsDialog.ddtDate')}>
          <DateField value={dialog.ddtDate} clearable locale={dateLocale} onChange={(value) => set({ ddtDate: value })} />
        </Field>
      </div>
      <Checkbox checked={dialog.weCollect} onChange={(event) => set({ weCollect: event.target.checked })} label={t('returnsDialog.weCollect')} />
      <Field label={t('returnsDialog.note')}>
        <Textarea rows={2} maxLength={2000} value={dialog.note} onChange={(event) => set({ note: event.target.value })} />
      </Field>
      <NameField value={dialog.name} onChange={(name) => set({ name })} />
    </Frame>
  )
}

function CancelReturnDialog({ answer, model, actions, dialog }: DialogProps<'cancelReturn'>) {
  const { t } = useWords()
  const notice = answer.job.returns.find((entry) => entry.id === dialog.returnNoticeId)
  return (
    <Frame model={model} actions={actions} answer={answer} size="sm" title={t('cancelReturn.title', { seq: notice?.seq ?? '' })} label={t('cancelReturn.confirm')} tone="danger" onConfirm={actions?.onCancelReturn}>
      <ul className="fw-by-list">
        <li>{t('cancelReturn.what', { pieces: notice?.pieces ?? 0 })}</li>
        <li>{t('cancelReturn.final')}</li>
      </ul>
      <Field label={t('cancelReturn.reason')} required>
        <Textarea rows={3} maxLength={2000} value={dialog.reason} autoFocus onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
      </Field>
    </Frame>
  )
}
