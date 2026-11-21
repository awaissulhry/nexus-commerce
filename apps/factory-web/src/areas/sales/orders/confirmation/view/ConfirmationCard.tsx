'use client'

import { ExternalLink, FileSignature, FileText, Send } from 'lucide-react'
import { Banner, Card, Disclosure, EmptyState, KeyValue } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame' // F-SA-236: the thread's one viewer
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Order } from '../../api'
import { confirmationHeld, confirmationHref, confirmationState, NAMESPACE } from '../../depth/model'
import type { OrderDepthActions, OrderDepthModel } from '../../depth/use-order-depth'
import '../../depth/depth.css'

/**
 * Changes › Confirmation & the customer's yes (design order.docs.confirmation, SAL-208; on B-W2b-303's API; F-SA-236): the newest
 * confirmation as ONE row — its version, when it was made, whether it still prints the order as it is, when it was sent — whose Open
 * shows it in the thread's one viewer (the versions walk there; no 70 % tall PDF block on the page), the versions behind a disclosure, "Sent to, when" (the version sent and the day; the mail itself is on the order's
 * thread), and Make confirmation (the same contents give the newest back), Send… (the one send dialog) and Open in new tab.
 * Refused while the order waits for a yes or was cancelled (said before the click). Fetches nothing.
 */
export function ConfirmationCard({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel | undefined; actions?: OrderDepthActions; prefix: string }) {
  if (!model?.confirmation) return null
  return (
    <WithMessages namespaces={[NAMESPACE, 'orders' /* F-CP-146: pricedPdf.held */]}>
      <Confirmation order={order} model={model} actions={actions} prefix={prefix} />
    </WithMessages>
  )
}

function Confirmation({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions; prefix: string }) {
  const d = useT(NAMESPACE)
  const o = useT('orders') // F-CP-146
  const locale = useLocale()
  const frame = useRecordFrame()
  const part = model.confirmation!
  const value = part.value
  const head = (
    <div className="fw-sod-head">
      <h2 className="fw-sod-h2">
        <FileSignature size={15} aria-hidden /> {d('confirmation.title')}
      </h2>
      {value && value.versions.length > 0 && (
        <Button size="sm" variant="quiet" asChild>
          <a href={confirmationHref(prefix, order.id)} target="_blank" rel="noopener">
            <ExternalLink size={13} aria-hidden /> {d('confirmation.newTab')}
          </a>
        </Button>
      )}
    </div>
  )
  if (!value) {
    return (
      <Card padded>
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
          <p className="fw-sod-hint" role="status">
            <Spinner size={14} /> {d('confirmation.reading')}
          </p>
        )}
      </Card>
    )
  }
  const state = confirmationState(value)
  const held = confirmationHeld(value, model.can)
  const newest = value.versions[0] ?? null
  const busy = model.busy ? d('held.busy') : null
  const make = (
    <Button size="sm" variant={state === 'none' ? 'primary' : 'secondary'} heldReason={held ? d(held.key) : busy} onClick={() => actions?.onMakeConfirmation?.()}>
      <FileText size={13} aria-hidden /> {state === 'outdated' ? d('confirmation.makeNew', { version: (newest?.version ?? 0) + 1 }) : d('confirmation.make')}
    </Button>
  )
  // F-CP-146 (money wall D1-c): the confirmation shows prices — it is sent by someone who sees prices (said on the button).
  const pricedHeld = model.can.price ? null : o('pricedPdf.held')
  const send = model.can.manage ? (
    <Button size="sm" variant={state === 'none' ? 'secondary' : 'primary'} heldReason={pricedHeld ?? (held ? d(held.key) : busy)} onClick={() => actions?.onDialog?.({ kind: 'send', cc: '', subject: '', message: '' })}>
      <Send size={13} aria-hidden /> {d('confirmation.send')}
    </Button>
  ) : null
  return (
    <Card padded>
      {head}
      {state === 'none' || state === 'notYet' ? (
        <EmptyState
          title={d('confirmation.none')}
          description={state === 'notYet' ? d(held?.key ?? 'confirmation.noneBody') : d('confirmation.noneBody')}
          action={
            model.can.manage ? (
              <span className="fw-sod-actions">
                {make}
                {send}
              </span>
            ) : undefined
          }
        />
      ) : (
        <>
          {state === 'outdated' && <Banner tone="warning" title={d('confirmation.outdated', { version: newest?.version ?? 1 })} />}
          {/* F-SA-236: the confirmation is a ROW that opens in the thread's ONE viewer (never a 70 % tall PDF block on the page). */}
          <div className="fw-so-confirm-row">
            <span className="fw-so-cell">
              <strong>{newest ? d('confirmation.rowTitle', { version: newest.version }) : d('confirmation.title')}</strong>
              <span className="fw-so-cell-sub">
                {[
                  newest ? d('confirmation.rowMade', { date: formatDate(newest.createdAt, { locale }) }) : null,
                  value.sentAt && value.sentVersion !== null ? d('confirmation.rowSent', { date: formatDate(value.sentAt, { locale }), version: value.sentVersion }) : d('confirmation.notSent'),
                  d(`confirmation.stateValue.${state}`),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <span className="fw-sod-actions">
              {newest && model.can.files && (
                <Button
                  size="sm"
                  onClick={(event) =>
                    frame?.openFiles
                      ? frame.openFiles({ files: value.versions.map((entry) => ({ id: entry.fileId, name: `${order.number}-v${entry.version}.pdf`, contentType: 'application/pdf' })), fileId: newest.fileId, returnTo: event.currentTarget })
                      : window.open(confirmationHref(prefix, order.id), '_blank', 'noopener')
                  }
                >
                  <FileText size={13} aria-hidden /> {d('confirmation.open')}
                </Button>
              )}
              {model.can.manage && (
                <>
                  {send}
                  {make}
                </>
              )}
            </span>
          </div>
          {!model.can.files && <p className="fw-sod-hint">{d('confirmation.noFiles')}</p>}
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
        </>
      )}
    </Card>
  )
}
