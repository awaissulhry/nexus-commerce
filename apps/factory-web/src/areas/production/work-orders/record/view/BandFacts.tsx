'use client'

import Link from 'next/link'
import { AlertTriangle, Hourglass } from 'lucide-react'
import { Skeleton, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { healthView, waitingView } from '../../../../../lib/production/model'
import { useProductionWords } from '../../../../../lib/production/words'
import type { WorkOrder } from '../../../_shared/api'
import { bandHealthOf, bandWaitingOf } from '../health/model'
import { customerFactOf, doneFact } from '../overview/model'
import type { WorkOrderRecordModel } from '../record-model'

/**
 * F-PR-05a — the band's facts (06-tree A.4 O-WO-band; 09-design §2(c) band meta): the customer (a link to it with parties.view, else
 * its code; "Mixed customers (made before the rule)" for an older work order of several), each sales order (a link with
 * orders.view) with its customer PO, % done (finished ÷ pieces; "Not released yet" before the release), and the health the customer
 * reads with who the work waits on (the worst of its orders, B-PR-35). The due date, rush, batch and revision follow as before.
 * The supervisor fact joins here with F-PR-21 (its own read; not drawn before). Health and waiting on are tags in the band (the
 * band keeps ONE status pill, the record frame's rule); the Overview's Health card draws the shared chip with its why.
 */
export function BandFacts({ workOrder, model }: { workOrder: WorkOrder; model: WorkOrderRecordModel }) {
  const t = useT('production')
  const words = useProductionWords()
  const fact = customerFactOf(workOrder)
  const done = doneFact(workOrder)
  const health = model.health ? bandHealthOf(model.health.orders, workOrder.daysLate) : null
  const waiting = model.health ? bandWaitingOf(model.health.orders) : null
  const orders = workOrder.orders.filter((order, index) => workOrder.orders.findIndex((other) => other.id === order.id) === index)
  return (
    <>
      {fact.kind === 'customer' ? (
        model.partiesView ? (
          <Link className="fw-pr-link" href={`${model.prefix}/sales/customers/${encodeURIComponent(fact.id)}`} title={t('band.customerOpen', { name: fact.name })}>
            {fact.name}
          </Link>
        ) : (
          <span>{fact.code}</span>
        )
      ) : fact.kind === 'mixed' ? (
        <Tag tone="warning">{t('customer.mixed')}</Tag>
      ) : null}
      {orders.map((order) => (
        <span key={order.id} className="fw-pr-inline">
          {model.can.orders ? (
            <Link className="fw-pr-link" href={`${model.prefix}/sales/orders/${encodeURIComponent(order.id)}`}>
              {order.number}
            </Link>
          ) : (
            <span>{order.number}</span>
          )}
          {order.customerRef ? <span className="fw-pr-hint">{t('list.po', { po: order.customerRef })}</span> : null}
        </span>
      ))}
      <Tag tone="neutral">{t(done.key, done.params)}</Tag>
      {health === 'loading' || waiting === 'loading' ? (
        <span role="status" aria-label={t('common.loading')}>
          <Skeleton width={120} height={18} radius={999} />
        </span>
      ) : null}
      {health && health !== 'loading' ? <HealthTag view={healthView('office', health)} say={words.say} unknown={t('parts.health.unknown')} /> : null}
      {waiting && waiting !== 'loading' ? <WaitingTag view={waitingView('office', waiting, Date.now())} say={words.say} unknown={t('parts.waiting.unknown')} /> : null}
      {/* F-PR-21: the supervisor fact ("Supervisor · Change…") comes here with its own read. */}
    </>
  )
}

function HealthTag({ view, say, unknown }: { view: ReturnType<typeof healthView>; say: (words: { key: string; params?: Readonly<Record<string, string | number>> }) => string; unknown: string }) {
  if (view === 'unknown' || view.state === null) return <Tag tone="neutral">{view === 'unknown' ? unknown : say(view.words)}</Tag>
  return (
    <Tag tone={view.tone}>
      <AlertTriangle size={11} aria-hidden /> {say(view.words)}
    </Tag>
  )
}

function WaitingTag({ view, say, unknown }: { view: ReturnType<typeof waitingView>; say: (words: { key: string; params?: Readonly<Record<string, string | number>> }) => string; unknown: string }) {
  if (view === null) return null
  if (view === 'unknown') return <Tag tone="neutral">{unknown}</Tag>
  return (
    <Tag tone={view.tone}>
      <Hourglass size={11} aria-hidden /> {[say(view.words), view.age ? say(view.age) : null].filter(Boolean).join(' · ')}
    </Tag>
  )
}
