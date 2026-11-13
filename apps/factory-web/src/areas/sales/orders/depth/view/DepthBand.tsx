'use client'

import Link from 'next/link'
import { Hourglass } from 'lucide-react'
import { Banner, type MenuItemDef } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Order } from '../../api'
import { askHeld, depthEditHeld, NAMESPACE, openRequest, PRIORITY_TONE, waitPhrases, withdrawHeld } from '../model'
import type { OrderDepthActions, OrderDepthModel } from '../use-order-depth'
import '../depth.css'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The band's depth (B-W2b-323; design sales.orders grid Priority (W2b) and Season (W2b), shown on the order too): the priority
 * (URGENT with its reason), the season, and the band's notice. Fetches nothing.
 */
export function DepthPills({ model }: { model: OrderDepthModel }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Pills model={model} />
    </WithMessages>
  )
}

function Pills({ model }: { model: OrderDepthModel }) {
  const d = useT(NAMESPACE)
  const depth = model.depth.value
  if (!depth) return null
  const level = depth.priority.level
  return (
    <>
      {level !== 'NORMAL' && (
        <Pill tone={PRIORITY_TONE[level]} title={depth.priority.urgentReason ?? undefined}>
          {d(`priority.level.${level}`)}
        </Pill>
      )}
      {level === 'URGENT' && depth.priority.urgentReason && <span className="fw-sod-reason">{depth.priority.urgentReason}</span>}
      {depth.season && <Tag tone="neutral">{d('season.tag', { code: depth.season.code })}</Tag>}
      {depth.confirmation.sentAt && depth.confirmation.sentVersion !== null && <Tag tone="success">{d('confirmation.sentTag', { version: depth.confirmation.sentVersion })}</Tag>}
    </>
  )
}

/** The record's ⋯ verbs of the depth: Set priority…, Set season… (each held with its reason). */
export function depthMenuItems(order: Order, model: OrderDepthModel | undefined, actions: OrderDepthActions | undefined, d: Translate): MenuItemDef[] {
  if (!model || !model.can.manage) return []
  const held = depthEditHeld(order.status, model.can)
  const depth = model.depth.value
  return [
    { id: 'depth-priority', label: d('action.priority'), disabled: !!held || !depth, description: held ? d(held.key) : undefined, onSelect: () => depth && actions?.onDialog?.({ kind: 'priority', level: depth.priority.level, reason: depth.priority.urgentReason ?? '' }) },
    { id: 'depth-season', label: d('action.season'), disabled: !!held || !depth, description: held ? d(held.key) : undefined, onSelect: () => depth && actions?.onDialog?.({ kind: 'season', seasonId: depth.season?.id ?? '' }) },
  ]
}

/**
 * "Waiting for a yes" (B-W2b-303's SALES_ORDER kind; the order is PENDING_APPROVAL): why it waits, in words — a request open
 * (who decides, since when), nobody asked yet, the customer's credit — with Ask for a yes and Take the request back, each held
 * with its reason. The yes itself is given in Home › Approvals; nobody decides their own request.
 */
export function WaitingBanner({ model, actions, prefix }: { model: OrderDepthModel; actions?: OrderDepthActions; prefix: string }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Waiting model={model} actions={actions} prefix={prefix} />
    </WithMessages>
  )
}

function Waiting({ model, actions, prefix }: { model: OrderDepthModel; actions?: OrderDepthActions; prefix: string }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const part = model.approval
  if (!part) return null
  if (!part.value) {
    return part.problem ? (
      <Banner
        tone="danger"
        title={d('wait.failed')}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.('approval')}>
            {d('common.retry')}
          </Button>
        }
      >
        {d(part.problem)}
      </Banner>
    ) : null
  }
  const approval = part.value
  if (!approval.waiting) return null
  const request = openRequest(approval)
  const ask = askHeld(approval, model.can)
  const withdraw = withdrawHeld(approval, model.can)
  return (
    <div className="fw-sod-wait" role="region" aria-label={d('wait.title')}>
      <Banner
        tone="warning"
        icon={<Hourglass size={16} aria-hidden />}
        title={d('wait.title')}
        action={
          <span className="fw-sod-actions">
            {request ? (
              <Button size="sm" heldReason={withdraw ? d(withdraw.key) : model.busy ? d('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'withdraw' })}>
                {d('wait.withdraw')}
              </Button>
            ) : (
              <Button size="sm" variant="primary" heldReason={ask ? d(ask.key) : model.busy ? d('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'ask', note: '' })}>
                {d('wait.ask')}
              </Button>
            )}
            <Button size="sm" variant="quiet" asChild>
              <Link href={`${prefix}/home/approvals`}>{d('wait.openApprovals')}</Link>
            </Button>
          </span>
        }
      >
          <span className="fw-sod-stack">
            {waitPhrases(approval).map((entry) => (
              <span key={entry.key}>{d(entry.key, entry.params)}</span>
            ))}
            {request && (
              <span className="fw-sod-hint">
                {request.approver ? d('wait.askedOf', { who: request.approver, date: formatDate(request.requestedAt, { locale }) }) : d('wait.asked', { date: formatDate(request.requestedAt, { locale }) })}
                {request.mine && ` · ${d('wait.mine')}`}
              </span>
            )}
          </span>
      </Banner>
    </div>
  )
}

/** The depth's own notice (a write that went, a refusal outside a dialog). */
export function DepthNotice({ model, actions }: { model: OrderDepthModel; actions?: OrderDepthActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Notice model={model} actions={actions} />
    </WithMessages>
  )
}

function Notice({ model, actions }: { model: OrderDepthModel; actions?: OrderDepthActions }) {
  const d = useT(NAMESPACE)
  if (!model.notice) return null
  return (
    <Banner
      tone={model.notice.tone}
      title={d(model.notice.words.key, model.notice.words.params)}
      action={
        <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
          {d('common.dismiss')}
        </Button>
      }
    />
  )
}
