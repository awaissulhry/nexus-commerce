'use client'

import type { ReactNode } from 'react'
import { Banknote, Hourglass, Reply } from 'lucide-react'
import { ORDER_PHASES } from '@nexus/factory-domain/production-brand/stages'
import { CUSTOMER_GROUPS, PHASE_ICON } from '../../order-groups/groups'
import { GroupsBand, type GroupsBandModel } from '../../order-groups/view/GroupsBand'
import { NewMessagesBubble } from '../../last-message-cell/view/NewMessagesBubble'
import { RecordPicture } from '../../record-picture/view/RecordPicture'
import { useT } from '../../i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { customerStateChipOf, ORDER_STATUS_TONE, type Door } from '../model'
import { useCellWords } from '../words'
import { MarkChip } from './MarkChip'
import { OrderCard } from './OrderCard'
import { PromiseCell } from './PromiseCell'
import { ShippedCell } from './ShippedCell'
import { StateChip } from './StateChip'

/**
 * pg-t (portal grid plan § 2; 18-lead-settles Z1, Z2, Z10) — the lab of the shared order list parts (`/design/order-list-parts`): each
 * part drawn by BOTH its faces side by side — the office's (the customer page's Work tab, Sales › Orders) and the customer's (the
 * portal's Orders & requests). One part, one file, two pages: the same Pill, Tag, door, bar and card; only the words and the groups
 * differ. Made-up data only: no customer, no real number, no amount.
 */

export interface OrderCellsLabModel {
  readonly show: 'band' | 'band-states' | 'chips' | 'cells' | 'card' | 'bubble'
}

const DOOR: Door = { href: '/design/order-list-parts', tip: { key: 'door.promise', params: { number: 'Your order 12' } } }

function Pair({ office, customer }: { office: ReactNode; customer: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--nds-space-24)', padding: 'var(--nds-space-16)' }}>
      <section aria-label="office">
        <h3 style={{ margin: '0 0 var(--nds-space-8)' }}>office</h3>
        {office}
      </section>
      <section aria-label="customer">
        <h3 style={{ margin: '0 0 var(--nds-space-8)' }}>customer</h3>
        {customer}
      </section>
    </div>
  )
}

const office = (over: Partial<GroupsBandModel> = {}): GroupsBandModel => ({ face: 'office', groups: ORDER_PHASES.map((group, index) => ({ group, count: [3, 1, 2, 1, 2, 6, 1][index] ?? 0, door: true })), total: 16, shown: null, state: 'ready', customer: 'Brand Alpha', ...over })
const customer = (over: Partial<GroupsBandModel> = {}): GroupsBandModel => ({ face: 'customer', groups: CUSTOMER_GROUPS.map((group, index) => ({ group, count: [2, 1, 3, 1, 2, 5, 1, 2][index] ?? 0, door: true })), total: 9, needsYou: 2, shown: null, state: 'ready', ...over })

export function OrderCellsLab({ model }: { model: OrderCellsLabModel }) {
  return (
    <WithMessages namespaces={['orders-sheet', 'last-message']}>
      <Lab model={model} />
    </WithMessages>
  )
}

function Lab({ model }: { model: OrderCellsLabModel }) {
  const words = useCellWords()
  const sheet = useT('orders-sheet')
  const l = useT('last-message')
  const noop = () => undefined
  if (model.show === 'band') return <Pair office={<GroupsBand model={office()} actions={{ onGroup: noop }} />} customer={<GroupsBand model={customer()} actions={{ onGroup: noop, onEverything: noop }} />} />
  if (model.show === 'band-states')
    return (
      <Pair
        office={
          <>
            <GroupsBand model={office({ state: 'reading', groups: ORDER_PHASES.map((group) => ({ group, count: null, door: true })), total: null })} />
            <GroupsBand model={office({ state: 'failed' })} actions={{ onRetry: noop }} />
          </>
        }
        customer={
          <>
            <GroupsBand model={customer({ state: 'reading', groups: CUSTOMER_GROUPS.map((group) => ({ group, count: null, door: false })), total: null, needsYou: null })} />
            <GroupsBand model={customer({ state: 'failed' })} actions={{ onRetry: noop }} />
          </>
        }
      />
    )
  if (model.show === 'chips')
    return (
      <Pair
        office={
          <span className="fw-sheet-wi">
            <StateChip chip={{ words: words.orders('status.PARTLY_SHIPPED'), tone: ORDER_STATUS_TONE.PARTLY_SHIPPED, mark: PHASE_ICON.SHIPPED, tail: words.sheet('shippedOf', { shipped: 40, units: 114 }) }} />
            <MarkChip chip={{ tone: 'warning', mark: Banknote, head: words.orders('board.deposit.OPEN'), tail: '25/11/2026' }} />
            <MarkChip chip={{ tone: 'neutral', mark: Hourglass, head: 'Waiting on customer', tail: '3 d' }} />
          </span>
        }
        customer={
          <span className="fw-sheet-wi">
            <StateChip chip={customerStateChipOf('PARTLY_SHIPPED', 'Partly shipped')} />
            <MarkChip chip={{ tone: 'warning', mark: Reply, head: words.list('customer.mark.needsYou') }} />
          </span>
        }
      />
    )
  if (model.show === 'cells')
    return (
      <Pair
        office={
          <div style={{ display: 'grid', gap: 'var(--nds-space-12)', maxWidth: 240 }}>
            <PromiseCell cell={{ face: 'office', day: '04/12/2026', door: DOOR, lateDays: 3 }} t={sheet} />
            <PromiseCell cell={{ face: 'office', day: null, door: DOOR }} t={sheet} />
            <ShippedCell cell={{ shipped: 40, units: 114, record: 'Your order 12', door: DOOR }} t={sheet} />
          </div>
        }
        customer={
          <div style={{ display: 'grid', gap: 'var(--nds-space-12)', maxWidth: 240 }}>
            <PromiseCell cell={{ face: 'customer', day: '04/12/2026', was: '28/11/2026', door: DOOR }} t={sheet} />
            <PromiseCell cell={{ face: 'customer', of: 'asked', day: '01/12/2026', door: DOOR }} t={sheet} />
            <PromiseCell cell={{ face: 'customer', of: 'wanted', day: '15/12/2026', door: DOOR }} t={sheet} />
            <ShippedCell cell={{ shipped: 40, units: 114, record: 'Your order 12', door: DOOR, tip: words.list('customer.shipped.tip', { name: words.list('customer.shipped.parcel', { order: 12, n: 2 }), date: '04/12/2026' }) }} t={sheet} />
          </div>
        }
      />
    )
  if (model.show === 'card') {
    const chips = (face: 'office' | 'customer') => (face === 'office' ? <StateChip chip={{ words: words.orders('status.IN_PRODUCTION'), tone: ORDER_STATUS_TONE.IN_PRODUCTION, mark: PHASE_ICON.IN_PRODUCTION }} /> : <StateChip chip={customerStateChipOf('IN_PRODUCTION', 'In production')} />)
    return (
      <Pair
        office={<OrderCard picture={<RecordPicture source="order" recordId="demo" number="Your order 12" picture={null} size="phone" />} sub={<span className="fw-sheet-sub fw-sheet-wraps">PO DEMO-1</span>} chips={chips('office')} promise={<span>04/12/2026</span>} />}
        customer={<OrderCard picture={<RecordPicture source="order" recordId="demo" number="Your order 12" picture={null} size="phone" />} sub={<span className="fw-ocl-sub">Your PO DEMO-1</span>} chips={chips('customer')} promise={<span>04/12/2026 · 40 of 114 shipped</span>} />}
      />
    )
  }
  return <Pair office={<NewMessagesBubble unread={{ newCount: 2, lastAt: null }} href="/design/order-list-parts" record="Your order 12" l={l} />} customer={<NewMessagesBubble unread={{ newCount: 120, lastAt: null }} href="/design/order-list-parts" record="Your order 12" l={l} />} />
}
