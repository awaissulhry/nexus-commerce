'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Banner, Card, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { DetailModal, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { MAX_REMINDER_TEXT, type Reminder } from '../api'
import { moneyText, needsCallNote, RECEIVABLES_NAMESPACE, stepPhrase, type ReceivablesCan } from '../model'
import { dayText } from './parts'

export interface ReminderDialogState {
  readonly id: string
  readonly value: Reminder | null
  readonly problem: string | null
  /** A step's own problem (a refusal in words), shown in that step. */
  readonly actionProblem?: string | null
  /** Design cases: a step open. */
  readonly step?: ReminderStep | null
}

export type ReminderStep = 'edit' | 'skip' | 'cancel' | 'call'

/**
 * One reminder (from Reminders to approve; a DetailModal with J / K over the list): what it asks (the invoices with
 * what is open now, the amount, the agreed interest), the level and the action (e-mail, letter, call), its text in the
 * customer's language — a preview to read before approving (a placeholder wording to confirm with the accountant) —,
 * the warnings (a payment being processed, a credit note being prepared, changed since prepared, no contact, switched
 * off: approval is not blocked by them), who prepared, approved and sent it. Edit text, Skip with reason, Approve (and
 * send while the Owner's switch is on; a call is recorded with what was said), Send an approved one. A approves.
 */
export function ReminderDialog({
  state,
  ids,
  can,
  switchedOn,
  prefix,
  busy,
  onGo,
  onClose,
  onRetry,
  onApprove,
  onSend,
  onEdit,
  onSkip,
  onCancel,
}: {
  state: ReminderDialogState
  ids: readonly string[]
  can: ReceivablesCan
  switchedOn: boolean
  prefix: string
  busy: boolean
  onGo?: (id: string) => void
  onClose?: () => void
  onRetry?: () => void
  onApprove?: (
    reminder: Reminder,
    input: {
      send: boolean
      subject?: string
      body?: string
      callNote?: string
    },
  ) => Promise<boolean>
  onSend?: (reminder: Reminder, callNote?: string) => Promise<boolean>
  onEdit?: (reminder: Reminder, input: { subject?: string; body?: string; language?: 'it' | 'en' }) => Promise<boolean>
  onSkip?: (reminder: Reminder, reason: string) => Promise<boolean>
  onCancel?: (reminder: Reminder, reason: string) => Promise<boolean>
}) {
  const t = useT(RECEIVABLES_NAMESPACE)
  const locale = useLocale()
  const reminder = state.value
  const [step, setStep] = useState<ReminderStep | null>(state.step ?? null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [language, setLanguage] = useState<'it' | 'en'>('it')
  const [reason, setReason] = useState('')
  const [callNote, setCallNote] = useState('')
  const [callFor, setCallFor] = useState<'approve' | 'send'>('approve')

  useEffect(() => {
    if (!reminder) return
    setSubject(reminder.text?.subject ?? '')
    setBody(reminder.text?.body ?? '')
    setLanguage(reminder.language.startsWith('it') ? 'it' : 'en')
  }, [reminder?.id, reminder?.version])

  const busyHeld = busy ? t('held.busy') : null
  const approveHeld = busyHeld ?? (!can.approve ? t('held.approve', { permission: 'receivables.reminders.approve' }) : reminder && !reminder.actions.approve ? t('held.notPrepared') : null)
  const manageHeld = busyHeld ?? (!can.manage ? t('held.manage', { permission: 'receivables.reminders.manage' }) : null)
  const editHeld = manageHeld ?? (!can.price ? t('held.price', { permission: 'money.price' }) : reminder && !reminder.actions.edit ? t('held.notPrepared') : null)
  const skipHeld = manageHeld ?? (reminder && !reminder.actions.skip ? t('held.notPrepared') : null)
  const cancelHeld = manageHeld ?? (reminder && !reminder.actions.cancel ? t('held.notOpen') : null)
  const sendHeld =
    busyHeld ??
    (!can.approve ? t('held.approve', { permission: 'receivables.reminders.approve' }) : !switchedOn ? t('held.switchedOff') : reminder && !reminder.actions.send ? t('held.notApproved') : null)
  const sending = switchedOn
  const say = (key: string, params?: Record<string, string | number>) => t(key, params)

  // A: approve the open reminder (not while typing or inside a step).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'a' || event.metaKey || event.ctrlKey || event.altKey || step || !reminder || approveHeld) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]') || target.isContentEditable)) return
      event.preventDefault()
      approve()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function approve() {
    if (!reminder) return
    if (needsCallNote(reminder, sending)) {
      setCallFor('approve')
      setStep('call')
      return
    }
    void onApprove?.(reminder, { send: sending })
  }

  return (
    <>
      <DetailModal
        open
        onClose={() => onClose?.()}
        title={t('reminder.title', {
          customer: reminder?.customer.name ?? t('reminder.thisCustomer'),
        })}
        subtitle={
          reminder
            ? `${say(stepPhrase(reminder).key, stepPhrase(reminder).params)} · ${t(`action.${reminder.action}`)} · ${t(`language.${reminder.language.startsWith('it') ? 'it' : 'en'}`)}`
            : undefined
        }
        meta={
          reminder ? (
            <Pill tone={reminder.status === 'SENT' ? 'success' : reminder.status === 'PREPARED' ? 'info' : reminder.status === 'APPROVED' ? 'warning' : 'neutral'}>
              {t(`status.${reminder.status}`)}
            </Pill>
          ) : undefined
        }
        nav={
          ids.length > 1 && ids.includes(state.id)
            ? {
                ids,
                current: state.id,
                onGo: (id) => onGo?.(id),
                noun: t('reminder.noun'),
              }
            : undefined
        }
        loading={!reminder && !state.problem}
        error={state.problem ? t(state.problem) : undefined}
        onRetry={state.problem ? onRetry : undefined}
        footer={
          reminder ? (
            <>
              {reminder.status === 'PREPARED' && (
                <>
                  <Button size="sm" heldReason={skipHeld} onClick={() => setStep('skip')}>
                    {t('reminder.skip')}
                  </Button>
                  <Button size="sm" heldReason={editHeld} onClick={() => setStep('edit')}>
                    {t('reminder.edit')}
                  </Button>
                </>
              )}
              {(reminder.status === 'PREPARED' || reminder.status === 'APPROVED') && (
                <Button size="sm" variant="quiet" heldReason={cancelHeld} onClick={() => setStep('cancel')}>
                  {t('reminder.cancel')}
                </Button>
              )}
              <span className="grow" />
              {reminder.status === 'PREPARED' && (
                <Button size="sm" variant="primary" heldReason={approveHeld} aria-keyshortcuts="a" onClick={approve}>
                  {sending ? t('reminder.approveSend') : t('reminder.approve')}
                </Button>
              )}
              {reminder.status === 'APPROVED' && (
                <Button
                  size="sm"
                  variant="primary"
                  heldReason={sendHeld}
                  onClick={() => {
                    if (reminder.action === 'CALL') {
                      setCallFor('send')
                      setStep('call')
                    } else void onSend?.(reminder)
                  }}
                >
                  {t(reminder.action === 'CALL' ? 'reminder.recordCall' : 'reminder.send')}
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        {reminder && (
          <div className="fw-frv-detail">
            {state.actionProblem && !step && <Banner tone="danger" title={t(state.actionProblem)} />}
            {reminder.held.length > 0 && (
              <Banner tone="warning" title={t('reminder.heldTitle', { count: reminder.held.length })}>
                <ul className="fw-frv-held">
                  {reminder.held.map((entry) => (
                    <li key={entry.code}>{t(`heldReason.${entry.code}`)}</li>
                  ))}
                </ul>
              </Banner>
            )}
            {reminder.status === 'PREPARED' && !switchedOn && (
              <Banner tone="info" title={t('switch.offTitle')}>
                {t('reminder.offBody')}
              </Banner>
            )}
            <div className="fw-frv-pair">
              <Card padded aria-label={t('reminder.asks')}>
                <div className="fw-frv-card">
                  <h3 className="fw-frv-h3">{t('reminder.asks')}</h3>
                  <SummaryTable
                    label={t('reminder.asks')}
                    stackOnPhone
                    columns={[t('col.invoice'), t('col.issued'), t('col.due'), ...(can.price ? [t('col.openNow')] : [])]}
                    align={['left', 'left', 'left', 'right']}
                    rows={reminder.invoices.map((invoice) => ({
                      id: invoice.id,
                      cells: [
                        can.invoices ? (
                          <Link key="n" className="fw-frv-link" href={`${prefix}/finance/invoices/${encodeURIComponent(invoice.id)}`}>
                            {invoice.number ?? t('reminder.draftInvoice')}
                          </Link>
                        ) : (
                          (invoice.number ?? t('reminder.draftInvoice'))
                        ),
                        dayText(invoice.issueDate, locale),
                        dayText(invoice.dueDate, locale),
                        ...(can.price
                          ? [
                              <span key="o" className="fw-frv-num">
                                {moneyText(invoice.openNow ?? null, reminder.currency, locale)}
                              </span>,
                            ]
                          : []),
                      ],
                    }))}
                  />
                  <KeyValue
                    columns={1}
                    labelCase="sentence"
                    items={[
                      ...(can.price
                        ? [
                            {
                              label: t('reminder.amountDue'),
                              value: moneyText(reminder.amountDue ?? null, reminder.currency, locale),
                            },
                          ]
                        : []),
                      ...(can.price && typeof reminder.interestAmount === 'number'
                        ? [
                            {
                              label: t('reminder.interest'),
                              value: moneyText(reminder.interestAmount, reminder.currency, locale),
                            },
                          ]
                        : []),
                      {
                        label: t('reminder.oldestDueLabel'),
                        value: dayText(reminder.oldestDueDate, locale),
                      },
                      {
                        label: t('reminder.levelLabel'),
                        value: `${t('reminder.level', { level: reminder.level })} · ${say(stepPhrase(reminder).key, stepPhrase(reminder).params)}`,
                      },
                      {
                        label: t('reminder.actionLabel'),
                        value: <Tag tone="neutral">{t(`action.${reminder.action}`)}</Tag>,
                      },
                    ]}
                  />
                </div>
              </Card>
              <Card padded aria-label={t('reminder.textTitle')}>
                <div className="fw-frv-card">
                  <h3 className="fw-frv-h3">{t('reminder.textTitle')}</h3>
                  {!can.price ? (
                    <p className="fw-frv-muted">{t('reminder.textNoPrice', { permission: 'money.price' })}</p>
                  ) : reminder.action === 'CALL' && !reminder.text?.body ? (
                    <p className="fw-frv-muted">{t('reminder.callText')}</p>
                  ) : (
                    <>
                      <p className="fw-frv-muted">
                        <b>{reminder.text?.subject ?? t('reminder.noSubject')}</b>
                      </p>
                      <pre className="fw-frv-text">{reminder.text?.body ?? t('reminder.noText')}</pre>
                    </>
                  )}
                  <p className="fw-frv-muted">{t('reminders.wording')}</p>
                </div>
              </Card>
            </div>
            <Card padded aria-label={t('reminder.history')}>
              <div className="fw-frv-card">
                <h3 className="fw-frv-h3">{t('reminder.history')}</h3>
                <KeyValue
                  columns={2}
                  labelCase="sentence"
                  items={[
                    {
                      label: t('reminder.prepared'),
                      value: `${formatDateTime(reminder.preparedAt, { locale })} · ${reminder.preparedBy?.name ?? (reminder.byHand ? t('reminder.someone') : t('reminder.ladder'))}`,
                    },
                    ...(reminder.approvedAt
                      ? [
                          {
                            label: t('reminder.approved'),
                            value: `${formatDateTime(reminder.approvedAt, { locale })} · ${reminder.approvedBy?.name ?? t('reminder.someone')}`,
                          },
                        ]
                      : []),
                    ...(reminder.sentAt
                      ? [
                          {
                            label: t('reminder.sent'),
                            value: formatDateTime(reminder.sentAt, { locale }),
                          },
                        ]
                      : []),
                    ...(reminder.email
                      ? [
                          {
                            label: t('reminder.email'),
                            value: t('reminder.emailState', {
                              status: t(`emailStatus.${emailStatusKey(reminder.email.status)}`),
                              to: reminder.email.to.join(', '),
                            }),
                          },
                        ]
                      : []),
                    ...(reminder.callNote
                      ? [
                          {
                            label: t('reminder.callNote'),
                            value: reminder.callNote,
                          },
                        ]
                      : []),
                    ...(reminder.skippedAt
                      ? [
                          {
                            label: t('reminder.skipped'),
                            value: `${formatDateTime(reminder.skippedAt, { locale })} · ${reminder.skippedBy?.name ?? t('reminder.someone')} · ${reminder.skipReason ?? ''}`,
                          },
                        ]
                      : []),
                    ...(reminder.cancelledAt
                      ? [
                          {
                            label: t('reminder.cancelled'),
                            value: `${formatDateTime(reminder.cancelledAt, { locale })} · ${reminder.cancelReason ?? ''}`,
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            </Card>
          </div>
        )}
      </DetailModal>

      {reminder && step === 'edit' && (
        <Modal
          open
          onClose={() => setStep(null)}
          title={t('edit.title')}
          size="lg"
          footer={
            <>
              <Button size="sm" onClick={() => setStep(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                heldReason={editHeld ?? (!subject.trim() || !body.trim() ? t('held.text') : null)}
                onClick={async () => {
                  const languageChanged = language !== (reminder.language.startsWith('it') ? 'it' : 'en')
                  const textChanged = subject !== (reminder.text?.subject ?? '') || body !== (reminder.text?.body ?? '')
                  if (
                    await onEdit?.(
                      reminder,
                      languageChanged && !textChanged
                        ? { language }
                        : {
                            subject: subject.trim(),
                            body: body.trim(),
                            ...(languageChanged ? { language } : {}),
                          },
                    )
                  )
                    setStep(null)
                }}
              >
                {t('common.save')}
              </Button>
            </>
          }
        >
          <div className="fw-frv-form">
            <Field label={t('edit.language')} hint={t('edit.languageHint')}>
              <SegmentedControl
                size="sm"
                ariaLabel={t('edit.language')}
                value={language}
                onChange={(value) => setLanguage(value as 'it' | 'en')}
                options={[
                  { value: 'it', label: t('language.it') },
                  { value: 'en', label: t('language.en') },
                ]}
              />
            </Field>
            <Field label={t('edit.subject')} required>
              <Input value={subject} maxLength={MAX_REMINDER_TEXT.subject} onChange={(event) => setSubject(event.target.value)} />
            </Field>
            <Field label={t('edit.body')} required>
              <Textarea value={body} rows={12} maxLength={MAX_REMINDER_TEXT.body} onChange={(event) => setBody(event.target.value)} />
            </Field>
            {state.actionProblem && <Banner tone="danger" title={t(state.actionProblem)} />}
          </div>
        </Modal>
      )}

      {reminder && (step === 'skip' || step === 'cancel') && (
        <Modal
          open
          onClose={() => setStep(null)}
          title={t(`${step}.title`)}
          size="md"
          footer={
            <>
              <Button size="sm" onClick={() => setStep(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                heldReason={(step === 'skip' ? skipHeld : cancelHeld) ?? (!reason.trim() ? t('held.reason') : null)}
                onClick={async () => {
                  const done = step === 'skip' ? await onSkip?.(reminder, reason.trim()) : await onCancel?.(reminder, reason.trim())
                  if (done) setStep(null)
                }}
              >
                {t(`${step}.confirm`)}
              </Button>
            </>
          }
        >
          <div className="fw-frv-form">
            <p className="fw-frv-muted">{t(`${step}.body`)}</p>
            <Field label={t(`${step}.reason`)} required>
              <Textarea value={reason} rows={3} maxLength={MAX_REMINDER_TEXT.reason} onChange={(event) => setReason(event.target.value)} />
            </Field>
            {state.actionProblem && <Banner tone="danger" title={t(state.actionProblem)} />}
          </div>
        </Modal>
      )}

      {reminder && step === 'call' && (
        <Modal
          open
          onClose={() => setStep(null)}
          title={t('call.title', { customer: reminder.customer.name })}
          size="md"
          footer={
            <>
              <Button size="sm" onClick={() => setStep(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                heldReason={(callFor === 'approve' ? approveHeld : sendHeld) ?? (!callNote.trim() ? t('held.callNote') : null)}
                onClick={async () => {
                  const done =
                    callFor === 'approve'
                      ? await onApprove?.(reminder, {
                          send: true,
                          callNote: callNote.trim(),
                        })
                      : await onSend?.(reminder, callNote.trim())
                  if (done) setStep(null)
                }}
              >
                {t('call.confirm')}
              </Button>
            </>
          }
        >
          <div className="fw-frv-form">
            <p className="fw-frv-muted">{t('call.body')}</p>
            <Field label={t('call.note')} required>
              <Textarea value={callNote} rows={4} maxLength={MAX_REMINDER_TEXT.callNote} onChange={(event) => setCallNote(event.target.value)} />
            </Field>
            {state.actionProblem && <Banner tone="danger" title={t(state.actionProblem)} />}
          </div>
        </Modal>
      )}
    </>
  )
}

export const EMAIL_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED'] as const
/** An e-mail's delivery state as a word key (an unknown one: "other"). */
export const emailStatusKey = (status: string): string => ((EMAIL_STATUSES as readonly string[]).includes(status) ? status : 'OTHER')
