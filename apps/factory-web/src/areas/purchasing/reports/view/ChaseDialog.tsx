'use client'

import { Mail } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { Failed, Shape } from './SpendPanel'
import type { ReportsActions, ReportsModel } from './types'

/** The most a chase message may say (factory-domain purchasing/expediting MAX_CHASE_MESSAGE). */
const MAX_MESSAGE = 4000

/**
 * Chase (design purchasing.reports sec late "Chase", the PO's own chase: "Lines late or unconfirmed; e-mail in their language
 * (preview)"; B-W2b-305's routes): one order — the lines it would chase, to whom, and the mail as the supplier will read it, in
 * its language — or the selected lines of several orders, one mail per order. A message of the buyer's may go with it. Send mails
 * the supplier (FAKE outside production) on the order's thread; each order's answer is said: sent to whom, or why not. No price,
 * no link in a chase.
 */
export function ChaseDialog({ model, actions }: { model: ReportsModel; actions?: ReportsActions | undefined }) {
  const t = useT('purchasing-reports')
  const locale = useLocale()
  const chase = model.chase
  if (!chase) return null
  const day = (date: string | null) => (date ? formatDate(`${date}T12:00:00Z`, { locale }) : '—')
  const one = chase.groups.length === 1 ? chase.groups[0]! : null
  const preview = chase.preview?.status === 'ready' ? chase.preview.value : null
  const done = chase.results !== null
  const sendHeld = done
    ? t('chase.held.done')
    : chase.busy
      ? t('chase.held.busy')
      : !model.can.send
        ? t('late.held.send')
        : one && chase.preview?.status !== 'ready'
          ? t('chase.held.reading')
          : preview && !preview.allowed
            ? (preview.why ?? t('chase.held.nothing'))
            : chase.message.length > MAX_MESSAGE
              ? t('chase.held.long', { count: MAX_MESSAGE })
              : null
  const title = one ? t('chase.titleOne', { supplier: one.supplierName, number: one.number }) : t('chase.titleMany', { count: chase.groups.length })
  const footer = (
    <>
      <Button size="sm" onClick={() => actions?.onChase?.(null)}>
        {done ? t('chase.close') : t('chase.cancel')}
      </Button>
      {done ? null : (
        <Button size="sm" variant="primary" onClick={() => actions?.onChaseSend?.()} heldReason={sendHeld}>
          <Mail size={14} aria-hidden /> {one ? t('chase.sendOne') : t('chase.sendMany', { count: chase.groups.length })}
        </Button>
      )}
    </>
  )
  return (
    <Modal open onClose={() => actions?.onChase?.(null)} title={title} subtitle={t('chase.subtitle')} size="lg" footer={footer}>
      <div className="fw-pr-chase">
        {chase.results ? (
          <SummaryTable
            label={t('chase.results')}
            columns={[t('chase.col.order'), t('chase.col.outcome')]}
            rows={chase.results.map((result) => ({ id: result.orderId, cells: [result.number, result.ok ? t('chase.sentTo', { to: result.words }) : t(result.words)] }))}
          />
        ) : null}
        {!done && one ? (
          <>
            {chase.preview?.status === 'loading' || chase.preview?.status === 'idle' ? <Shape chart={false} /> : null}
            {chase.preview?.status === 'error' ? <Failed title={t('chase.failed')} problem={chase.preview.problem} /> : null}
            {preview ? (
              <>
                {preview.allowed ? null : <Banner tone="warning" title={preview.why ?? t('chase.held.nothing')} />}
                <SummaryTable
                  label={t('chase.linesLabel')}
                  columns={[t('chase.col.line'), t('chase.col.needed'), t('chase.col.confirmed'), t('chase.col.why')]}
                  rows={preview.lines.map((line) => ({ id: line.lineId, cells: [line.label, day(line.needDate), day(line.confirmedDate), line.reasons.map((reason) => t(`reason.${reason}`)).join(', ')] }))}
                />
                <p className="fw-pr-muted">{preview.recipient ? t('chase.to', { name: preview.recipient.name, email: preview.recipient.email ?? '—', language: t(`language.${preview.language}`) }) : t('chase.noContact')}</p>
                <div className="fw-pr-mail" aria-label={t('chase.mailLabel')}>
                  <p className="fw-pr-mail-subject">{preview.subject}</p>
                  <pre className="fw-pr-mail-body">{preview.body}</pre>
                </div>
              </>
            ) : null}
          </>
        ) : null}
        {!done && !one ? (
          <SummaryTable
            label={t('chase.ordersLabel')}
            columns={[t('chase.col.order'), t('chase.col.supplier'), t('chase.col.lines')]}
            rows={chase.groups.map((group) => ({ id: group.orderId, cells: [group.number, group.supplierName, group.seqs.map((seq) => t('chase.lineSeq', { seq })).join(', ')] }))}
          />
        ) : null}
        {done ? null : (
          <Field label={t('chase.message')} hint={t('chase.messageHint')}>
            <Textarea value={chase.message} rows={3} maxLength={MAX_MESSAGE} onChange={(event) => actions?.onChaseMessage?.(event.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
