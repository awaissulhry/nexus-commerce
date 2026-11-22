'use client'

import { FileSignature, FileText, Send } from 'lucide-react'
import { Banner, Disclosure, KeyValue } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame' // F-SA-236: the thread's one viewer
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Order } from '../../api'
import { confirmationHeld, confirmationHref, confirmationState, NAMESPACE } from '../../depth/model'
import type { OrderDepthActions, OrderDepthModel } from '../../depth/use-order-depth'
import { LineMenuButton } from '../../record/view/LineMenu'
import { sendVersionOf } from '../../record/changes/agreement'
import '../../depth/depth.css'

/**
 * F-OC-203 (order CHANGES tab, 10-design §6; 18-lead-settles L9, L10) — Customer's agreement › Our confirmation: whether the newest
 * confirmation prints the order as it is now (Out of date · Up to date · Not sent yet), when and to whom it was sent (every send once
 * the read lists them, B-OC-014), the versions folded. Its doors: [Open] (the thread's ONE viewer) · [Send version N…] (the ONE send
 * dialog) · ⋯ Make only (to print) · Open to print — held in words while the order waits for a yes or was cancelled.
 * L10 (the money wall): the confirmation shows prices — for a reader without the price grain Open, Make and Send are hidden and ONE
 * line of words says who sends it. L9: it is made and sent in the order's language. Fetches nothing.
 */
export function ConfirmationCard({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel | undefined; actions?: OrderDepthActions; prefix: string }) {
  if (!model?.confirmation) return null
  return (
    <WithMessages namespaces={[NAMESPACE, 'orders']}>
      <Confirmation order={order} model={model} actions={actions} prefix={prefix} />
    </WithMessages>
  )
}

const STATE_TONE = Object.freeze({ upToDate: 'success', outdated: 'warning', none: 'warning', notYet: 'neutral' } as const)

function Confirmation({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions; prefix: string }) {
  const d = useT(NAMESPACE)
  const t = useT('orders')
  const locale = useLocale()
  const frame = useRecordFrame()
  const part = model.confirmation!
  const value = part.value
  const head = (
    <h3 className="fw-pt-h3">
      <FileSignature size={15} aria-hidden /> {t('changesTab.agreement.ours')}
    </h3>
  )
  if (!value) {
    return (
      <div className="fw-pt-blk fw-oc-ag-half">
        {head}
        {part.problem ? (
          <Banner
            tone="danger"
            title={d('confirmation.failed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.('confirmation')}>
                {d('common.retry')}
              </Button>
            }
          >
            {d(part.problem)}
          </Banner>
        ) : (
          <p className="fw-pt-quiet" role="status">
            <Spinner size={14} /> {d('confirmation.reading')}
          </p>
        )}
      </div>
    )
  }
  const state = confirmationState(value)
  const held = confirmationHeld(value, model.can)
  const newest = value.versions[0] ?? null
  const busy = model.busy ? d('held.busy') : null
  const lastSend = value.sends?.[0] ?? null
  // When and to whom it was sent: every send once the read lists them (B-OC-014), else the last one the order knows.
  // fx6 (walk 12; #1849): a send the read names without its addressee says when only; nothing made yet says it once (the tag).
  const sentWords = lastSend
    ? lastSend.to.length > 0
      ? t('changesTab.agreement.sentTo', { version: lastSend.version, date: formatDate(lastSend.at, { locale }), to: lastSend.to.join(', ') })
      : d('confirmation.rowSent', { date: formatDate(lastSend.at, { locale }), version: lastSend.version })
    : value.sentAt && value.sentVersion !== null
      ? d('confirmation.rowSent', { date: formatDate(value.sentAt, { locale }), version: value.sentVersion })
      : newest
        ? d('confirmation.notSent')
        : null
  const sent = sentWords && state === 'outdated' && (lastSend || value.sentAt) ? `${sentWords} · ${t('changesTab.agreement.changedAfter')}` : sentWords
  const priced = model.can.price
  const open = (event: { currentTarget: HTMLElement }) =>
    frame?.openFiles && newest
      ? frame.openFiles({ files: value.versions.map((entry) => ({ id: entry.fileId, name: `${order.number}-v${entry.version}.pdf`, contentType: 'application/pdf' })), fileId: newest.fileId, returnTo: event.currentTarget })
      : window.open(confirmationHref(prefix, order.id), '_blank', 'noopener')
  // ⋯ Make only (to print) · Open to print — the price reader's (Make: orders.manage, held in words like Send).
  const more = [
    ...(model.can.manage ? [{ id: 'make', label: t('changesTab.agreement.makeOnly'), disabled: !!(held ?? busy), description: held ? d(held.key) : (busy ?? undefined), onSelect: () => actions?.onMakeConfirmation?.() }] : []),
    ...(newest ? [{ id: 'print', label: t('changesTab.agreement.openToPrint'), onSelect: () => window.open(confirmationHref(prefix, order.id), '_blank', 'noopener') }] : []),
  ]
  return (
    <div className="fw-pt-blk fw-oc-ag-half">
      {head}
      <div className="fw-oc-ag-row">
        <div className="fw-oc-ag-txt">
          <span className="fw-pt-inline">
            {/* fx6 (walk 12): ONE heading ("Our confirmation"); the version names itself only once one is made. */}
            {newest ? <strong>{d('confirmation.rowTitle', { version: newest.version })}</strong> : null}
            <Tag tone={STATE_TONE[state]}>{t(`changesTab.agreement.state.${state}`)}</Tag>
          </span>
          {newest || sent ? <span className="fw-pt-sub">{[newest ? d('confirmation.rowMade', { date: formatDate(newest.createdAt, { locale }) }) : null, sent].filter(Boolean).join(' · ')}</span> : null}
          {/* L9: the PDF is made in the order's language (the customer reads it), never the office person's. */}
          <span className="fw-pt-sub">{t('changesTab.agreement.language', { language: t(`changesTab.agreement.lang.${order.language === 'en' ? 'en' : 'it'}`) })}</span>
        </div>
        {priced ? (
          <div className="fw-oc-ag-doors">
            {newest && model.can.files && (
              <Button size="sm" onClick={open}>
                <FileText size={13} aria-hidden /> {d('confirmation.open')}
              </Button>
            )}
            {model.can.manage && order.status !== 'CANCELLED' && (
              <Button size="sm" variant="primary" heldReason={held ? d(held.key) : busy} onClick={() => actions?.onDialog?.({ kind: 'send', cc: '', subject: '', message: '' })}>
                <Send size={13} aria-hidden /> {t('changesTab.agreement.send', { version: sendVersionOf(value) })}
              </Button>
            )}
            {more.length > 0 && order.status !== 'CANCELLED' && <LineMenuButton label={t('changesTab.agreement.more')} items={more} />}
          </div>
        ) : null}
      </div>
      {/* L10: no price grain — no Open, no Make, no Send; one line says who does it. */}
      {!priced && <p className="fw-pt-quiet">{t('changesTab.agreement.noPrice')}</p>}
      {priced && !model.can.files && newest && <p className="fw-pt-quiet">{d('confirmation.noFiles')}</p>}
      {/* fx6 (walk 12): every send is a row of What changed (B-OC-014). */}
      {lastSend || value.sentAt ? <p className="fw-pt-quiet">{t('changesTab.agreement.sendsListed')}</p> : null}
      {value.versions.length > 1 && (
        <Disclosure summary={d('confirmation.versionsCount', { count: value.versions.length })}>
          <KeyValue
            dense
            labelCase="sentence"
            items={value.versions.map((entry) => ({
              label: entry.number ?? d('confirmation.versionValue', { version: entry.version }),
              value: `${formatDateTime(entry.createdAt, { locale })}${entry.sent ? ` · ${d('confirmation.wasSent')}` : ''}`,
              hint: entry.createdBy ?? undefined,
            }))}
          />
        </Disclosure>
      )}
    </div>
  )
}
