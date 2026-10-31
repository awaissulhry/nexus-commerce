import { describe, expect, it } from 'vitest'
import { mapError } from '../../core/errors'
import { PeriodLockedError, SoftLockedError } from './period-guard'

/**
 * The month locks' refusals on the wire (B-W2a-F8), without a database: the commands' own checks (HARD at the write's
 * path, SOFT with `period/SOFT_LOCKED`), and the error mapper's last line of defence for the database's check_violation
 * 'period lock: …' as Prisma's driver adapter reports it (the shape a PG test also proves on the real stack).
 */

const databaseRefusal = (code: string, message: string) =>
  Object.assign(new Error(`Invalid \`tx.payment.create()\` invocation: Database error. Code: \`${code}\`. Message: \`${message}\``), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2039',
    meta: { modelName: 'Payment', driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: code, originalMessage: message, kind: 'postgres', code, severity: 'ERROR', message } } },
  })

const LOCKED =
  'period lock: payment 0190f000-0000-7000-8000-000000000001 (CRO-1) is dated 2026-09-15, inside the closed period 2026-09-01 to 2026-09-30 of its company (a HARD lock: the accountant has it; lift the lock first, with a reason)'

describe('month locks on the wire', () => {
  it("answers the database's HARD refusal as a 409 in words (period/HARD_LOCKED), never a 500", () => {
    expect(mapError(databaseRefusal('23514', LOCKED))).toEqual({
      status: 409,
      code: 'conflict',
      message:
        'September 2026 is closed for good (a hard lock): the payment (CRO-1) dated 15 Sep 2026 is not written. Only someone who may lift a hard lock (accounting.unlock: the owner, by default) reopens the month, with a reason, in Finance › Accounting; agree it with the accountant first.',
      issues: [{ path: 'period/HARD_LOCKED', message: 'Dated inside a month closed for good.' }],
      unexpected: false,
    })
  })

  it('leaves every other database error unexpected (500, logged)', () => {
    expect(mapError(databaseRefusal('23514', 'payments: deposit request x is PAID (final); its allocations stay'))).toMatchObject({ status: 500, code: 'internal_error', unexpected: true })
    expect(mapError(databaseRefusal('23505', LOCKED))).toMatchObject({ status: 500, unexpected: true })
  })

  it("answers the commands' own checks as 409s at their paths", () => {
    expect(mapError(new PeriodLockedError('September 2026 is closed for good …', 'body/receivedOn'))).toMatchObject({ status: 409, code: 'conflict', issues: [{ path: 'body/receivedOn', message: 'Dated inside a month closed for good.' }] })
    expect(mapError(new SoftLockedError('October 2026 is soft-locked …', 'body/paidOn'))).toMatchObject({
      status: 409,
      code: 'conflict',
      issues: [
        { path: 'period/SOFT_LOCKED', message: 'Inside a soft-locked month: send it again with an override reason (periodLockOverride.reason), or have the soft lock lifted.' },
        { path: 'body/paidOn', message: 'Dated inside a soft-locked month.' },
      ],
    })
  })
})
