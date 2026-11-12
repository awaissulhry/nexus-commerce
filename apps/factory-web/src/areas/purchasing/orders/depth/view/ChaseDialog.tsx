'use client'

import { Mail } from 'lucide-react'
import { Banner, Card, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Skeleton, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { PoStatus } from '../../api'
import { MAX_CHASE_MESSAGE } from '../api'
import { chaseHeld, DEPTH, laterPhrase, type ChaseActions, type ChaseModel, type DepthCan } from '../model'
import { useDay, useDepthSay } from './words'

/**
 * Chase <supplier> (design purchasing.orders pop:chase, row verb W2b; the PO studio's ⋯): the lines late or unconfirmed —
 * asked, the supplier's day, expected, why (late · not confirmed · confirmed later than needed) — each ticked to go in the
 * mail, to whom, and the mail as the supplier will read it in its language (the preview; no price, no link). A message of
 * the buyer's may go with it. Send chase mails it on the order's thread; done says to whom. Held with the reason in words.
 */
export function ChaseDialog({ model, status, can, offline, actions }: { model: ChaseModel; status: PoStatus | null; can: Pick<DepthCan, 'send'>; offline?: boolean; actions?: Omit<ChaseActions, 'onOpen'> | undefined }) {
  const t = useT(DEPTH)
  const tb = useT('buying')
  const say = useDepthSay()
  const sayWrite = useDepthSay('buying')
  const day = useDay()
  const locale = useLocale()
  const preview = model.preview.status === 'ready' ? model.preview.value : null
  const chosen = model.lineIds ?? preview?.lines.map((line) => line.lineId) ?? []
  const held = say(chaseHeld(model, status, can, offline))
  const toggle = (lineId: string, on: boolean) => actions?.onLines?.(on ? [...new Set([...chosen, lineId])] : chosen.filter((id) => id !== lineId))

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('chase.title', { supplier: model.supplier })}
      subtitle={t('chase.subtitle', { number: model.number })}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {model.done ? tb('common.close') : tb('common.cancel')}
          </Button>
          {!model.done && (
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onSend?.()}>
              {model.busy ? <Spinner size={12} /> : <Mail size={14} aria-hidden />} {t('chase.send')}
            </Button>
          )}
        </>
      }
    >
      <div className="fw-by-dialog">
        {model.done ? (
          <Banner tone="success" title={t('chase.done', { to: model.done.to, time: formatDateTime(model.done.at, { locale }) })}>
            {t('chase.doneHint')}
          </Banner>
        ) : model.preview.status === 'loading' ? (
          <div className="fw-by-stack" aria-busy="true">
            <p className="fw-by-hint" role="status">
              <Spinner size={14} /> {t('chase.reading')}
            </p>
            <Skeleton height={22} />
            <Skeleton height={22} />
            <Skeleton height={96} />
          </div>
        ) : model.preview.status !== 'ready' ? (
          <Card padded>
            <EmptyState
              title={t('chase.failed')}
              description={model.preview.status === 'error' ? tb(model.preview.problem) : tb('problem.read')}
              action={
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {tb('common.retry')}
                </Button>
              }
            />
          </Card>
        ) : preview && preview.lines.length === 0 ? (
          <Banner tone="info" title={t('chase.nothing')}>
            {t('chase.nothingHint')}
          </Banner>
        ) : preview ? (
          <>
            <SummaryTable
              label={t('chase.linesLabel')}
              density="roomy"
              stackOnPhone
              columns={[t('chase.col.take'), t('chase.col.line'), t('chase.col.asked'), t('chase.col.theirs'), t('chase.col.why')]}
              align={['left', 'left', 'left', 'left', 'left']}
              widths={['96px', undefined, '120px', '160px', undefined]}
              rows={preview.lines.map((line) => ({
                id: line.lineId,
                cells: [
                  <Checkbox key="take" checked={chosen.includes(line.lineId)} onChange={(event) => toggle(line.lineId, event.target.checked)} aria-label={t('chase.take', { seq: line.seq })} disabled={model.busy} />,
                  <span key="line" className="fw-by-cell">
                    <span>{t('chase.lineSeq', { seq: line.seq })}</span>
                    <span className="nds-summary-sub">{line.label}</span>
                  </span>,
                  day(line.needDate),
                  <span key="theirs" className="fw-by-cell">
                    <span>{line.confirmedDate ? day(line.confirmedDate) : t('chase.notConfirmed')}</span>
                    {line.confirmedLaterBy > 0 && <span className="nds-summary-sub fw-by-danger">{say(laterPhrase(line.confirmedLaterBy))}</span>}
                  </span>,
                  <span key="why" className="fw-by-cell">
                    <span>{line.reasons.map((reason) => t(`reason.${reason}`)).join(' · ')}</span>
                    {line.daysLate > 0 && <span className="nds-summary-sub fw-by-danger">{t('chase.daysLate', { count: line.daysLate })}</span>}
                  </span>,
                ],
              }))}
            />
            <p className="fw-by-hint">{preview.recipient ? t('chase.to', { name: preview.recipient.name, email: preview.recipient.email ?? t('chase.noEmail'), language: t(`language.${preview.language}`) }) : t('chase.noContact')}</p>
            <figure className="fw-pod-mail" aria-label={t('chase.mailLabel')}>
              <figcaption className="fw-pod-mail-subject">{preview.subject}</figcaption>
              <pre className="fw-pod-mail-body">{preview.body}</pre>
            </figure>
            <Field label={t('chase.message')} hint={t('chase.messageHint')}>
              <Textarea rows={3} maxLength={MAX_CHASE_MESSAGE} value={model.message} onChange={(event) => actions?.onMessage?.(event.target.value)} disabled={model.busy} />
            </Field>
          </>
        ) : null}
        {model.problem && <Banner tone="danger" title={sayWrite(model.problem) ?? ''} />}
      </div>
    </Modal>
  )
}
