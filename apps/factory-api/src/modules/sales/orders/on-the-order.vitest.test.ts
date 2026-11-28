import { describe, expect, it } from 'vitest'
import { NO_ROWS, type Grant, type Permission } from '@nexus/factory-domain/core/permissions'
import type { OfficeContext } from '../../../core/context'
import { seenOrdersWhere } from './access'
import { seesOwnOrdersOnly } from './on-the-order'

/**
 * owb-of1a (plan.md § 5 D R20): the pure halves of the designer's scope — who reads a list through orders.view.own, and the list's
 * where (orders.view's rows OR the ids the person is on that orders.view.own reaches). The database half: on-the-order.pg.
 */

const P1 = '0190f0e2-5151-7000-8000-0000000000a1'
const SO = '0190f0e2-5151-7000-8000-0000000000b1'
const grant = (permissions: readonly string[], parties: Grant['parties'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties })
const context = (...grants: Grant[]): OfficeContext => ({ audience: 'office', tenantId: '0190f0e2-5151-7000-8000-0000000000f1', actorId: '0190f0e2-5151-7000-8000-0000000000e1', grants, requestId: 'test' })

describe('seesOwnOrdersOnly', () => {
  it('true only for a grant with orders.view.own and without orders.view (the Factory designer)', () => {
    expect(seesOwnOrdersOnly([grant(['orders.view.own', 'files.read'])])).toBe(true)
    expect(seesOwnOrdersOnly([grant(['orders.view', 'orders.view.own'])])).toBe(false) // the Owner, Read-only
    expect(seesOwnOrdersOnly([grant(['orders.view'])])).toBe(false) // Sales
    expect(seesOwnOrdersOnly([grant(['orders.view'], [P1]), grant(['orders.view.own'])])).toBe(true) // two roles: their grants add up
    expect(seesOwnOrdersOnly([])).toBe(false)
  })
})

describe('seenOrdersWhere', () => {
  it('without own ids: orders.view\'s scope alone (today\'s list, unchanged)', () => {
    expect(seenOrdersWhere(context(grant(['orders.view'])), null)).toEqual({})
    expect(seenOrdersWhere(context(grant(['orders.view'], [P1])), null)).toEqual({ partyId: { in: [P1] } })
  })

  it('the designer: only the ids it is on (orders.view reaches none)', () => {
    expect(seenOrdersWhere(context(grant(['orders.view.own'])), { salesOrderIds: [SO] })).toEqual({ AND: [{}, { id: { in: [SO] } }] })
    expect(seenOrdersWhere(context(grant(['orders.view.own'])), { salesOrderIds: [] })).toBe(NO_ROWS)
  })

  it('both: orders.view\'s rows OR the ids it is on; an every-row orders.view stays every row', () => {
    expect(seenOrdersWhere(context(grant(['orders.view'], [P1]), grant(['orders.view.own'])), { salesOrderIds: [SO] })).toEqual({ OR: [{ partyId: { in: [P1] } }, { AND: [{}, { id: { in: [SO] } }] }] })
    expect(seenOrdersWhere(context(grant(['orders.view']), grant(['orders.view.own'])), { salesOrderIds: [SO] })).toEqual({})
  })
})
