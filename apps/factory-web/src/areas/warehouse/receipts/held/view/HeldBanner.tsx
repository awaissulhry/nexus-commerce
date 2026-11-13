'use client'

import Link from 'next/link'
import { Hourglass } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { quantity } from '../../../../_shared/buying/model'
import type { ReceiptLine } from '../../api'
import { heldLinesOf, MAX_CANCEL_REASON, requestHref, requestWordsOf, taskOf, WORDS_NS } from '../model'
import type { HeldActions, HeldModel } from '../use-held-receipt'
import '../held.css'

/**
 * A receipt that waits for a yes, said on its record and right after it is recorded (B-W2b-382; SCR-062-held, SCR-061-held):
 * nothing is posted yet (no lot, no move, the order has not moved); which lines wait and why (what came against what was
 * expected, beyond the delivery tolerance), who is asked or who refused, each request opened in Home › Approvals; Cancel
 * (a reason; held with why for a person who does not receive goods, offline, busy). A refused line: cancel and receive again
 * within the tolerance. Every line approved: posted by itself in a moment, else Post here. The receipt's own words; no money.
 */
export function HeldBanner({ model, actions, numbered = false }: { model: HeldModel; actions?: HeldActions; numbered?: boolean }) {
  return (
    <WithMessages namespaces={[WORDS_NS, 'buying']}>
      <Held model={model} actions={actions} numbered={numbered} />
    </WithMessages>
  )
}

function Held({ model, actions, numbered }: { model: HeldModel; actions?: HeldActions | undefined; numbered: boolean }) {
  const t = useT(WORDS_NS)
  const locale = useLocale()
  const receipt = model.receipt
  const actionHeld = model.actionHeld ? t(model.actionHeld) : null
  const done = model.done ? (
    <div role="status">
      <Banner
        tone="success"
        title={t(model.done.key, { number: model.done.number })}
        action={
          <Button size="sm" variant="quiet" onClick={() => actions?.onDismiss?.()}>
            {t('held.dismiss')}
          </Button>
        }
      />
    </div>
  ) : null
  if (model.state === 'none') return done ?? (receipt.status === 'CANCELLED' ? <Banner tone="neutral" title={t('held.cancelledTitle', { number: receipt.number })} /> : null)

  if (model.state === 'released') {
    return (
      <div className="fw-rch">
        {done}
        <Banner
          tone="info"
          title={numbered ? t('held.releasedTitleOf', { number: receipt.number }) : t('held.releasedTitle')}
          action={
            <Button size="sm" variant="primary" heldReason={actionHeld} onClick={() => actions?.onPost?.()}>
              {model.busy && <Spinner size={12} />} {t('held.post')}
            </Button>
          }
        >
          {t('held.releasedBody')}
        </Banner>
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    )
  }

  const lines = heldLinesOf(receipt)
  const refused = model.state === 'refused'
  return (
    <div className="fw-rch">
      {done}
      <Banner
        tone={refused ? 'danger' : 'warning'}
        title={refused ? t('held.refusedTitle') : numbered ? t('held.titleOf', { number: receipt.number }) : t('held.title')}
        action={
          <Button size="sm" variant={refused ? 'primary' : 'secondary'} tone="danger" heldReason={actionHeld} onClick={() => actions?.onCancel?.()}>
            {t('held.cancel')}
          </Button>
        }
      >
        {refused ? t('held.refusedBody') : t('held.body', { count: lines.length })}
      </Banner>
      <ul className="fw-rch-lines" aria-label={t('held.linesLabel')}>
        {lines.map((line) => (
          <HeldLineItem key={line.id} line={line} model={model} />
        ))}
      </ul>
      {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      <p className="fw-rch-hint">
        <Hourglass size={12} aria-hidden /> {t('held.since', { time: lines[0]?.heldForApprovalAt ? formatDateTime(lines[0].heldForApprovalAt, { locale, timeZone: model.timeZone }) : '—' })}
      </p>
    </div>
  )
}

function HeldLineItem({ line, model }: { line: ReceiptLine; model: HeldModel }) {
  const t = useT(WORDS_NS)
  const buying = useT('buying')
  const locale = useLocale()
  const request = model.requests?.[line.id]
  const said = requestWordsOf(request)
  const taskId = taskOf(line.id, model.held, model.requests)
  const diff = line.difference
  const unit = buying(`uom.${line.uom}`)
  return (
    <li className="fw-rch-line">
      <span className="fw-rch-what">
        <b>{t('held.line', { seq: line.seq, item: line.item.code })}</b> {line.item.name}
        {line.colour ? ` · ${line.colour.code} ${line.colour.name}` : ''}
      </span>
      <span className="fw-rch-why">
        {diff
          ? t('held.why', { after: quantity(diff.after, locale), expected: quantity(diff.expected, locale), more: quantity(diff.difference, locale), unit })
          : t('held.whyQuantity', { quantity: quantity(line.quantity, locale), unit })}
      </span>
      <span className={request?.status === 'REJECTED' ? 'fw-rch-state is-refused' : 'fw-rch-state'}>
        {t(said.key, said.params)}
        {taskId && (
          <>
            {' · '}
            <Link className="fw-rch-link" href={requestHref(model.prefix, taskId)}>
              {t('held.openRequest')}
            </Link>
          </>
        )}
      </span>
    </li>
  )
}

/** "Cancel receipt GR-…?" — what cancelling does (nothing was posted; its requests are withdrawn) and why, in words. */
export function CancelHeldDialog({ model, actions }: { model: HeldModel; actions?: HeldActions }) {
  return model.dialog ? (
    <WithMessages namespaces={[WORDS_NS, 'buying']}>
      <CancelDialog model={model} actions={actions} />
    </WithMessages>
  ) : null
}

function CancelDialog({ model, actions }: { model: HeldModel; actions?: HeldActions | undefined }) {
  const t = useT(WORDS_NS)
  const dialog = model.dialog!
  const held = model.actionHeld ? t(model.actionHeld) : dialog.reason.trim().length === 0 ? t('held.problem.reason') : null
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t('held.cancelTitle', { number: model.receipt.number })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseDialog?.()}>
            {t('held.keep')}
          </Button>
          <Button size="sm" variant="primary" tone="danger" heldReason={held} onClick={() => actions?.onCancelConfirm?.()}>
            {model.busy && <Spinner size={12} />} {t('held.cancelGo')}
          </Button>
        </>
      }
    >
      <div className="fw-rch">
        <p className="fw-rch-hint">{t('held.cancelBody')}</p>
        <Field label={t('held.reason')} required hint={t('held.reasonHint')}>
          <Textarea rows={3} maxLength={MAX_CANCEL_REASON} value={dialog.reason} onChange={(event) => actions?.onReason?.(event.target.value)} autoFocus />
        </Field>
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
      </div>
    </Modal>
  )
}
