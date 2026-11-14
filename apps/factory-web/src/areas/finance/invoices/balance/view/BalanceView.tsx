'use client'

import Link from 'next/link'
import { PackageX } from 'lucide-react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money, type Phrase } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import { DEPTH, DEPTH_NAMESPACES, type DepthProblem } from '../../test-mode/depth'
import type { BalanceHold } from '../api'
import { releaseHeld, releaseWordsProblem, type BalanceOrder } from '../model'
import '../../../_shared/finance.css'

export interface BalanceModel {
  prefix: string
  price: boolean
  recordPayments: boolean
  /** The invoice's orders with a balance before shipping (null while read; empty: nothing drawn). */
  orders: BalanceOrder[] | null
  /** The read failed (a finance message key). */
  problem: string | null
  /** The holds could not be read (no shipping.view, or the read failed): only the open balance is said. */
  holdsUnknown: boolean
  releasing: BalanceHold | null
  words: string
  busy: boolean
  writeProblem: DepthProblem | null
  notice: Phrase | null
}

export interface BalanceActions {
  onRelease?: (hold: BalanceHold | null) => void
  onWords?: (words: string) => void
  onConfirmRelease?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * Balance before shipping on Deposits & payments (design finance.invoices rec:Invoice deposits/payments "Balance before
 * shipping (W2b): shipment held until paid"; FIN-079): for each order of the invoice whose before-shipping step is still
 * open, what is left to pay (by grain) and every shipment the system holds until it is paid; Record a payment opens
 * Payments; finance may let a shipment go with the reason (the system then does not hold it again for that step), the
 * others see the button held with why. Nothing is drawn when no order has a balance before shipping.
 */
export function BalanceView({ model, actions }: { model: BalanceModel; actions?: BalanceActions }) {
  if (model.orders !== null && model.orders.length === 0 && !model.problem && !model.notice) return null
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Balance model={model} actions={actions} />
    </WithMessages>
  )
}

function Balance({ model, actions }: { model: BalanceModel; actions?: BalanceActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const locale = useLocale()
  return (
    <Card padded className="fw-fin-card">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">{w('balance.title')}</h2>
        {model.recordPayments && (model.orders?.some((order) => order.open.length > 0) ?? false) && (
          <Button size="sm" asChild>
            <Link href={`${model.prefix}/finance/payments?new=1`}>{w('balance.record')}</Link>
          </Button>
        )}
      </div>
      <p className="fw-fin-hint">{w('balance.explain')}</p>
      {model.notice && (
        <Banner
          tone="success"
          title={w(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {model.problem ? (
        <p className="fw-fin-hint">
          {w('balance.failed', { why: t(model.problem) })}{' '}
          <Button size="sm" variant="link" onClick={() => actions?.onRetry?.()}>
            {t('common.retry')}
          </Button>
        </p>
      ) : model.orders === null ? (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {w('balance.reading')}
        </p>
      ) : (
        model.orders.map((order) => (
          <div key={order.orderId} className="fw-fin-stack-tight">
            <h3 className="fw-fin-h3">{w('balance.order', { number: order.number })}</h3>
            {order.open.map((item) => (
              <p key={item.id} className="fw-fin-hint">
                {model.price && item.openAmount !== undefined ? w('balance.open', { amount: money(item.openAmount, item.currency ?? 'EUR', locale) }) : w('balance.openNoPrice')}
              </p>
            ))}
            {order.open.length === 0 && <p className="fw-fin-hint">{w('balance.paidHeld')}</p>}
            {order.holds.length > 0 ? (
              <ul className="fw-fin-steps" aria-label={w('balance.heldLabel', { number: order.number })}>
                {order.holds.map((hold) => {
                  const held = releaseHeld(hold, model.busy)
                  return (
                    <li key={hold.id} className="fw-fin-check">
                      <PackageX size={14} aria-hidden className="fw-fin-ico" />
                      <span className="fw-fin-step-body">
                        <span>{w('balance.heldShipment', { number: hold.shipment.number })}</span>
                        <span className="fw-fin-step-time">{w('balance.since', { date: formatDate(hold.placedAt, { locale }) })}</span>
                      </span>
                      {!hold.bySystem && <Tag tone="neutral">{w('balance.byPerson')}</Tag>}
                      <Button size="sm" heldReason={held ? w(held.key) : null} onClick={() => actions?.onRelease?.(hold)}>
                        {w('balance.release')}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            ) : order.open.length > 0 ? (
              <p className="fw-fin-hint">{w(model.holdsUnknown ? 'balance.holdsUnknown' : 'balance.noShipmentYet')}</p>
            ) : null}
          </div>
        ))
      )}
      {model.releasing && <ReleaseDialog model={model} hold={model.releasing} actions={actions} />}
    </Card>
  )
}

function ReleaseDialog({ model, hold, actions }: { model: BalanceModel; hold: BalanceHold; actions?: BalanceActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const problem = releaseWordsProblem(model.words)
  const held = model.busy ? w('held.busy') : problem ? w(problem.key) : null
  return (
    <DialogFrame
      title={w('balance.releaseTitle', { number: hold.shipment.number })}
      held={held}
      go={() => actions?.onConfirmRelease?.()}
      goLabel={model.busy ? t('common.working') : w('balance.releaseGo')}
      onClose={() => actions?.onRelease?.(null)}
      problem={model.writeProblem ? { key: model.writeProblem.key, ...(model.writeProblem.params ? { params: model.writeProblem.params } : {}) } : null}
    >
      <p className="fw-fin-hint">{w('balance.releaseExplain', { order: hold.shipment.salesOrderNumber })}</p>
      <Field label={w('balance.releaseWords')} hint={w('balance.releaseHint')}>
        <Textarea value={model.words} rows={3} maxLength={2000} onChange={(event) => actions?.onWords?.(event.target.value)} />
      </Field>
    </DialogFrame>
  )
}
