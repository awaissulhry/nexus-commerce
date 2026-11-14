import { can, holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import type { MessageKey } from '@nexus/factory-domain/notifications/rules'
import type { TrackingExceptionKind } from '@nexus/factory-domain/shipping/exceptions/rules'
import { SHIPPING_MANAGE } from '@nexus/factory-domain/shipping/permissions'
import { events as deliveryEvents } from '@nexus/factory-domain/shipping-delivery/events'
import type { Draft, FanOutRule, RuleContext } from '../../../platform/notifications/fan-out'

/**
 * Who is told of a tracking problem (B-W2b-398; LOG-063 "a task when a parcel is delayed, has an address problem, failed
 * delivery or has no scan for N days"): when one is raised (`shipment.tracking_problem_raised`), every ACTIVE office person
 * who may manage shipments at the shipment's company and site (shipping.manage, the dispatch desk) and still reaches Home
 * gets an ALERT anchored to the problem (a replay tells nobody twice). Resolved before the fan-out ran: nobody.
 */

const payloadSchema = deliveryEvents.find((event) => event.type === 'shipment.tracking_problem_raised')!.payload

const MESSAGE_KEYS: Readonly<Record<TrackingExceptionKind, MessageKey>> = Object.freeze({
  DELAYED: 'notifications.shipping.delayed',
  ADDRESS_PROBLEM: 'notifications.shipping.addressProblem',
  FAILED_DELIVERY: 'notifications.shipping.failedDelivery',
  NO_SCAN: 'notifications.shipping.noScan',
})

export const TRACKING_PROBLEM_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'shipping.trackingProblem',
    events: ['shipment.tracking_problem_raised'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadSchema.parse(raw)
      const row = await context.tx.trackingException.findUnique({ where: { id: payload.exceptionId }, select: { resolvedAt: true, shipment: { select: { companyId: true, siteId: true, partyId: true, number: true } } } })
      if (!row || row.resolvedAt !== null) return []
      const scope = { companyId: row.shipment.companyId, siteId: row.shipment.siteId, partyId: row.shipment.partyId }
      const drafts: Draft[] = []
      for (const userId of await context.people()) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, SHIPPING_MANAGE, scope)) continue
        drafts.push({
          userId,
          category: 'ALERT',
          record: { type: 'Shipment', id: payload.shipmentId, label: row.shipment.number },
          companyId: scope.companyId,
          anchor: `tracking-problem:${payload.exceptionId}`,
          messageKey: MESSAGE_KEYS[payload.kind],
          params: { exceptionId: payload.exceptionId, kind: payload.kind },
          actorId: null,
        })
      }
      return drafts
    },
  },
])
