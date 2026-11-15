import { describe, expect, it } from 'vitest'
import { isClosedWorkOrderRefusal, logWaitsForReopen } from './after-close'

/**
 * B-W2b-F46 — which database refusal means "a cost arrived after the close" (the handler and the catch-up then end OK) and
 * which still fails as before; and the one info line it logs. Made-up ids; the messages as the …_cost_actuals_w2b_guards
 * raise them.
 */

/** A PrismaClientKnownRequestError as Prisma 7's client throws a trigger's refusal (the class is not exported here). */
const refusal = (originalCode: string, originalMessage: string) =>
  Object.assign(new Error('Raw query failed.'), { name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { driverAdapterError: { cause: { originalCode, originalMessage } } }, clientVersion: '7.10.0' })

describe('a closed work order refusal, and only that one', () => {
  it('a CLOSED work order, or one whose close is settled: after the close', () => {
    expect(isClosedWorkOrderRefusal(refusal('23514', 'cost: work order w is CLOSED; it takes no cost entry but a reversal (entry e, MATERIAL): reopen it first'))).toBe(true)
    expect(isClosedWorkOrderRefusal(refusal('23514', 'cost: the close of work order w is settled (its closing entry is posted); it takes no cost entry but a reversal (entry e, LABOUR): undo the close first'))).toBe(true)
  })

  it('any other refusal or error still fails as before', () => {
    expect(isClosedWorkOrderRefusal(refusal('23514', 'cost: VARIANCE entry e belongs to close c, which stands; it is reversed only once the close is undone (MES-013)'))).toBe(false)
    expect(isClosedWorkOrderRefusal(refusal('23514', 'inventory: stock move x takes 2 from location y, which holds 1 of it'))).toBe(false)
    expect(isClosedWorkOrderRefusal(refusal('40001', 'cost: work order w is CLOSED; it takes no cost entry but a reversal (entry e, MATERIAL): reopen it first'))).toBe(false)
    expect(isClosedWorkOrderRefusal(new Error('cost: work order w is CLOSED; it takes no cost entry but a reversal'))).toBe(false)
    expect(isClosedWorkOrderRefusal(null)).toBe(false)
    expect(isClosedWorkOrderRefusal(undefined)).toBe(false)
  })
})

describe('the one info line', () => {
  it('is structured, at info, names the work order and waits for a reopen; no log, no line', () => {
    const lines: unknown[] = []
    const log = { info: (fields: Record<string, unknown>, message: string) => lines.push(['info', fields, message]), warn: () => lines.push('warn'), error: () => lines.push('error') }
    logWaitsForReopen(log, { tenantId: 't', workOrderId: 'w', number: 'WO-1', entries: 2, eventId: 'e', eventType: 'inventory.moved' })
    expect(lines).toEqual([['info', { tenantId: 't', workOrderId: 'w', number: 'WO-1', entries: 2, eventId: 'e', eventType: 'inventory.moved', waitsFor: 'reopen' }, 'a cost arrived after its work order was closed: it waits for a reopen (the close freezes the actual)']])
    expect(() => logWaitsForReopen(undefined, { tenantId: 't', workOrderId: 'w' })).not.toThrow()
  })
})
