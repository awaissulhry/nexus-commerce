import { describe, expect, it } from 'vitest'
import { CUSTOMER_ALLOWED_ACTIONS, customerMayRead } from '../../sales/order-log/faces'

/**
 * owb-pd2 2.4 (S4 settle 11): a line's route is the factory's business — the audit actions of a pick and an exception
 * (modules/product/line-routes) are never on the customer's allow-list, so the portal's order log never shows them, even when the
 * row is the customer's own order's.
 */
describe("a line's route never reaches the customer's log", () => {
  it.each(['order.line.route_picked', 'order.line.route_exception'])('%s is not on the allow-list', (action) => {
    expect(CUSTOMER_ALLOWED_ACTIONS.has(action)).toBe(false)
    expect(customerMayRead({ action, audience: 'OFFICE', actorPartyId: null }, 'party-1')).toBe(false)
    expect(customerMayRead({ action, audience: 'PARTNER', actorPartyId: 'party-1' }, 'party-1')).toBe(false)
  })
})
