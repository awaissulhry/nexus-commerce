import { describe, expect, it } from 'vitest'
import { mapError } from '../../../core/errors'
import { RevisionLockedError, revisionLockGuarded, revisionLockRefusal } from './lock'

/** The database's refusal as Prisma's driver adapter carries it (the shape core/errors and ./lock read). */
const refused = (originalCode: string, originalMessage: string) =>
  Object.assign(new Error('Invalid prisma invocation'), { name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { driverAdapterError: { cause: { originalCode, originalMessage } } } })

const REVISION = '0190f1f2-0000-7000-8000-000000000001'

describe('a write that reaches the lock of a released revision (B-W2b-220, PRD-167)', () => {
  it('is a 409 in words with refusal/REVISION_LOCKED, never a 500', () => {
    const mapped = mapError(refused('23001', `product: revision ${REVISION} is RELEASED; its "PatternPiece" rows never change, a change is a new revision`))
    expect(mapped).toEqual({
      status: 409,
      code: 'conflict',
      message: 'This revision is released and locked: its pattern pieces cannot change. Start a new revision (a copy of it, as a draft) to change it.',
      issues: [{ path: 'refusal/REVISION_LOCKED', message: 'This revision is released and locked: its pattern pieces cannot change. Start a new revision (a copy of it, as a draft) to change it.' }],
      unexpected: false,
    })
    expect(mapError(refused('23001', `product: revision ${REVISION} is OBSOLETE; it never changes, a change is a new revision`)).status).toBe(409)
  })

  it('leaves every other database refusal as it was', () => {
    expect(mapError(refused('23001', 'product: a row of "BomLine" never moves to another revision')).status).toBe(500)
    expect(mapError(refused('23505', `product: revision ${REVISION} is RELEASED; its "BomLine" rows never change`)).status).toBe(500)
  })

  it('says it with the revision number where the write path knows it', async () => {
    const error = refused('23001', `product: revision ${REVISION} is RELEASED; its "BomLineAlternate" rows never change, a change is a new revision`)
    const words = revisionLockRefusal(error, 3)
    expect(words).toBeInstanceOf(RevisionLockedError)
    expect((words as Error).message).toBe('Revision 3 is released and locked: its BOM alternates cannot change. Start a new revision (a copy of it, as a draft) to change it.')
    const other = new Error('boom')
    expect(revisionLockRefusal(other)).toBe(other)
    await expect(revisionLockGuarded(async () => Promise.reject(error), 3)).rejects.toBeInstanceOf(RevisionLockedError)
    await expect(revisionLockGuarded(async () => 'done')).resolves.toBe('done')
  })
})
