'use client'

import { CheckCircle2, Clock, Eye, Info, Truck } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { readOnlyOnPage } from '../../../model'
import type { OrderRecordModel } from '../../record-model'
import { headOf } from '../head'
import type { WhereModel } from '../where'
import { sentenceOf, useShipSay } from './say'

/**
 * F-OS-101 (order SHIPMENTS tab, 10-design §3) — the tab's one answer above its three sections (no card, no h2): a DS Banner in the
 * case's tone, and under it, once for the whole tab, "Read-only: your role sees shipments but does not change them." for a reader who
 * changes nothing on the page (Warehouse's own words). Draws its model (shipments/head.ts); reads nothing.
 */
export function ShipmentsHead({ order, model, where }: { order: Order; model: OrderRecordModel; where: WhereModel }) {
  const say = useShipSay()
  const s = useT('shipments')
  const head = headOf(order, where, model.shipmentDeliveries?.value ?? null)
  const icon = head.tone === 'success' ? <CheckCircle2 size={18} aria-hidden /> : head.tone === 'warning' ? <Clock size={18} aria-hidden /> : head.tone === 'info' ? <Truck size={18} aria-hidden /> : <Info size={18} aria-hidden />
  const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
  return (
    <Banner className="fw-os-head" tone={head.tone} icon={icon} title={sentenceOf(head.parts.map(say))}>
      {readOnly ? (
        <span className="fw-os-head-wall">
          <Eye size={13} aria-hidden /> {s('record.readOnly')}
        </span>
      ) : null}
    </Banner>
  )
}
