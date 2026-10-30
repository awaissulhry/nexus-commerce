'use client'

import Link from 'next/link'
import { Banner, Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { hasRecordPage, recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { Invoice, SdiSend } from '../../../_shared/api'
import { dayInstant, rejectionOf, SDI_TONE, sdiErrorKey, type StepState } from '../../../_shared/model'
import { PartState, StepIcon } from '../../../_shared/parts'
import type { InvoiceRecordActions, InvoiceRecordModel } from '../record-model'

const SEND_STATE: Record<SdiSend['status'], StepState> = { SENDING: 'current', SENT: 'current', DELIVERED: 'done', NOT_DELIVERABLE: 'problem', REJECTED: 'problem', FAILED: 'problem' }

/**
 * SDI status (design invoice tab "sdi"): where the invoice is in plain words with the next step, SDI's deadline to send
 * a rejected one again (five working days, same number and date) with its reason in our words and SDI's code, every
 * send as a timeline (the file, when it left, SDI's identifier, each notification in words: received, delivered, not
 * delivered — in the customer's tax drawer, rejected …), the legal archive, and the courtesy copy e-mailed when SDI could
 * not deliver. SDI is the tax agency's post office: the invoice is the XML it accepts; the PDF is a courtesy copy.
 */
export function SdiTab({ invoice, model, actions }: { invoice: Invoice; model: InvoiceRecordModel; actions?: InvoiceRecordActions }) {
  const t = useT('finance')
  const locale = useLocale()
  if (invoice.status === 'DRAFT') {
    return (
      <Card padded>
        <EmptyState title={t('sdi.draft.title')} description={t('sdi.draft.body')} />
      </Card>
    )
  }
  const part = model.sdi
  if (!part || !part.value) return <PartState problem={part?.problem ?? null} label={t('tab.sdi')} onRetry={() => actions?.onRetryPart?.('sdi')} />
  const sdi = part.value
  const code = sdi.state.code
  const action = sdi.state.next.action
  const at = (value: string | null) => (value ? formatDateTime(value, { locale }) : '—')
  const rejection = code === 'REJECTED' ? rejectionOf(sdi) : null
  const fixHref = (fix: string) =>
    fix === 'party' && hasRecordPage('Party', OFFICE_PAGES) && model.can.viewParties ? `${model.prefix}${recordAddress({ type: 'Party', id: invoice.buyerPartyId }, OFFICE_PAGES)}` : fix === 'company' ? `${model.prefix}/finance/settings` : null
  const sendHeld = !model.can.issueInvoices ? t('held.noIssue') : !sdi.canSend ? t('held.sdiNotNow') : model.busy ? t('held.busy') : null

  return (
    <div className="fw-fin-stack">
      <Card padded className="fw-fin-card">
        <div className="fw-fin-card-head">
          <h2 className="fw-fin-h2">
            {t('sdi.title')} <Pill tone={SDI_TONE[code]}>{t(`sdi.state.${code}`)}</Pill>
          </h2>
          <span className="fw-fin-actions">
            {(action === 'SEND' || action === 'SEND_AGAIN') && (
              <Button size="sm" variant="primary" heldReason={sendHeld} onClick={() => actions?.onDialog?.({ kind: 'send' })}>
                {t(action === 'SEND' ? 'step.send' : 'step.sendAgain')}
              </Button>
            )}
            {action === 'FIX_AND_RESEND' && (
              <Button size="sm" variant="primary" heldReason={model.can.issueInvoices ? (model.busy ? t('held.busy') : null) : t('held.noIssue')} onClick={() => actions?.onDialog?.({ kind: 'fix' })}>
                {t('step.fix')}
              </Button>
            )}
          </span>
        </div>
        <p className="fw-fin-hint">{t(`sdi.explain.${code}`)}</p>
        {!(code === 'REJECTED' && sdi.deadline) && (
          <p>
            <b>{t(`sdi.next.${action}`)}</b>
          </p>
        )}
        {code === 'REJECTED' && sdi.deadline && (
          <Banner
            tone={sdi.deadline.overdue ? 'danger' : 'warning'}
            title={t(sdi.deadline.overdue ? 'sdi.deadlineOverdue' : 'sdi.deadline', { date: formatDate(dayInstant(sdi.deadline.deadline), { locale }), count: sdi.deadline.workingDaysLeft })}
          />
        )}
        {rejection && (
          <div className="fw-fin-stack-tight">
            <h3 className="fw-fin-h3">{t('sdi.reason')}</h3>
            <ul className="fw-fin-checks" aria-label={t('sdi.reason')}>
              {rejection.errors.length === 0 ? (
                <li className="fw-fin-check">{t('sdi.noErrorList')}</li>
              ) : (
                rejection.errors.map((error, index) => {
                  const key = sdiErrorKey(error.code)
                  const href = fixHref(error.fix)
                  return (
                    <li key={`${error.code}-${index}`} className="fw-fin-check">
                      <StepIcon state="problem" />
                      <span className="fw-fin-step-body">
                        <span>{key ? t(key) : error.description || t('sdi.unknownError')}</span>
                        <span className="fw-fin-step-time">{t('sdi.errorCode', { code: error.code, text: error.description || '—' })}</span>
                        <span className="fw-fin-step-time">{t(`sdi.fixWhere.${error.fix}`)}</span>
                      </span>
                      {href && (
                        <Button size="sm" variant="link" asChild>
                          <Link href={href}>{t(`checks.fix.${error.fix}`)}</Link>
                        </Button>
                      )}
                    </li>
                  )
                })
              )}
            </ul>
          </div>
        )}
        {code === 'NOT_DELIVERED' && (
          <p className="fw-fin-hint">
            {sdi.courtesyCopies.queued.length > 0
              ? t('sdi.copySent', { date: at(sdi.courtesyCopies.queued[sdi.courtesyCopies.queued.length - 1]!.queuedAt) })
              : t('sdi.copyMissing')}
          </p>
        )}
        <p className="fw-fin-hint">{t('sdi.about')}</p>
      </Card>

      <Card padded className="fw-fin-card">
        <h2 className="fw-fin-h2">{t('sdi.timeline')}</h2>
        {sdi.sends.length === 0 ? (
          <EmptyState title={t('sdi.noSends.title')} description={t('sdi.noSends.body')} />
        ) : (
          <ol className="fw-fin-steps" aria-label={t('sdi.timeline')}>
            {[...sdi.sends]
              .sort((a, b) => a.attempt - b.attempt)
              .flatMap((send) => [
                <li key={send.id} className="fw-fin-step">
                  <StepIcon state={send.status === 'SENDING' ? 'current' : 'done'} />
                  <span className="fw-fin-step-body">
                    <b>{t(send.attempt > 1 ? 'sdi.sentAgain' : 'sdi.sent', { attempt: send.attempt })}</b>
                    <span className="fw-fin-code">{send.fileName}</span>
                    {send.sdiIdentifier && <span>{t('sdi.identifier', { id: send.sdiIdentifier })}</span>}
                    {send.failure && <span>{t((['REFUSED', 'NOT_SENT', 'NO_ANSWER'] as const).includes(send.failure.code as 'REFUSED') ? `sdi.failure.${send.failure.code}` : 'sdi.failure.OTHER')}</span>}
                    {send.failure?.uncertain && <span>{t('sdi.failureUncertain')}</span>}
                    <span className="fw-fin-step-time">{at(send.sentAt ?? send.createdAt)}</span>
                  </span>
                  <Pill tone={SEND_STATE[send.status] === 'done' ? 'success' : SEND_STATE[send.status] === 'problem' ? 'danger' : 'info'}>{t(`sdi.send.${send.status}`)}</Pill>
                </li>,
                ...send.notifications.map((notification) => (
                  <li key={notification.id} className="fw-fin-step">
                    <StepIcon state={notification.type === 'NS' ? 'problem' : notification.type === 'MC' || notification.type === 'AT' ? 'problem' : 'done'} />
                    <span className="fw-fin-step-body">
                      <b>{t(`sdi.notification.${notification.type}`)}</b>
                      <span className="fw-fin-step-time">
                        {at(notification.receivedAt)} · {t(`sdi.source.${notification.source}`)}
                      </span>
                    </span>
                  </li>
                )),
              ])}
            {sdi.archive && (
              <li className="fw-fin-step">
                <StepIcon state="done" />
                <span className="fw-fin-step-body">
                  <b>{t('sdi.archived', { date: formatDate(sdi.archive.archivedAt, { locale }) })}</b>
                  <span className="fw-fin-code">{sdi.archive.archiveRef}</span>
                </span>
              </li>
            )}
          </ol>
        )}
        <KeyValue
          dense
          labelCase="sentence"
          columns={2}
          items={[
            { label: t('sdi.numberDate'), value: `${sdi.number ?? '—'} · ${sdi.issueDate ? formatDate(dayInstant(sdi.issueDate), { locale }) : '—'}` },
            { label: t('sdi.archive'), value: sdi.archive ? t('sdi.archivedShort', { date: formatDate(sdi.archive.archivedAt, { locale }) }) : t('sdi.notArchived') },
          ]}
        />
      </Card>
    </div>
  )
}
