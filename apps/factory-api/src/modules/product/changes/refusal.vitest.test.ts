import { describe, expect, it } from 'vitest'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { mapError } from '../../../core/errors'
import { ChangeRefusedError, databaseRefusal } from './store'

/** The change-control refusals on the wire (B-W2b-226): every one a 409 in words, never a 500. */

const prismaError = (originalCode: string, originalMessage: string, code = 'P2010') => Object.assign(new Error('db'), { code, meta: { driverAdapterError: { cause: { originalCode, originalMessage } } } })
const caught = (error: unknown): unknown => {
  try {
    databaseRefusal(error)
  } catch (thrown) {
    return thrown
  }
  return null
}

describe('change-control refusals', () => {
  it("a module refusal is a 409 with its code as the issue", () => {
    const mapped = mapError(new ChangeRefusedError({ code: 'OWN_APPROVAL', message: 'The author of change order ECO-2026-0001 cannot approve it.' }))
    expect(mapped).toMatchObject({ status: 409, code: 'conflict', issues: [{ path: 'refusal/OWN_APPROVAL' }] })
  })

  it("the database's own refusal past the module's checks becomes a 409 in its words", () => {
    const error = caught(prismaError('23514', 'changes: the approver of change order 01 is never its author (approval 02)'))
    expect(error).toBeInstanceOf(ConflictError)
    expect(mapError(error)).toMatchObject({ status: 409, message: 'The approver of change order 01 is never its author (approval 02).' })
    expect(mapError(caught(prismaError('23505', 'duplicate key', 'P2002')))).toMatchObject({ status: 409 })
    // Anything else is not this module's: thrown as it is.
    const other = new Error('boom')
    expect(caught(other)).toBe(other)
    expect(caught(prismaError('23514', 'production: something else'))).not.toBeInstanceOf(ConflictError)
  })
})
