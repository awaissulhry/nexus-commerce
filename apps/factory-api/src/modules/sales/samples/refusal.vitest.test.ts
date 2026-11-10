import { describe, expect, it } from 'vitest'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { mapError } from '../../../core/errors'
import { databaseRefusal, SampleRefusedError } from './store'

/** The sample rounds' refusals on the wire (B-W2b-246): every one a 409 in words, never a 500. */

const prismaError = (originalCode: string, originalMessage: string, code = 'P2010') => Object.assign(new Error('db'), { code, meta: { driverAdapterError: { cause: { originalCode, originalMessage } } } })
const caught = (error: unknown): unknown => {
  try {
    databaseRefusal(error)
  } catch (thrown) {
    return thrown
  }
  return null
}

describe('sample round refusals', () => {
  it('a module refusal is a 409 with its code as the issue', () => {
    const mapped = mapError(new SampleRefusedError({ code: 'SENT_ONCE', message: 'The shipment was already sent: when it was sent stays as it was.' }))
    expect(mapped).toMatchObject({ status: 409, code: 'conflict', issues: [{ path: 'refusal/SENT_ONCE' }] })
  })

  it("the database's own refusal past the module's checks becomes a 409 in its words", () => {
    const round = caught(prismaError('23514', 'samples: sample round 01 is decided; only a certification result and certificate may still come'))
    expect(round).toBeInstanceOf(ConflictError)
    expect(mapError(round)).toMatchObject({ status: 409, message: 'Sample round 01 is decided; only a certification result and certificate may still come.' })
    const workOrder = caught(prismaError('23514', 'production: sample round 01 is CANCELLED; no work order is made for it'))
    expect(mapError(workOrder)).toMatchObject({ status: 409, message: 'Sample round 01 is CANCELLED; no work order is made for it.' })
    // Anything else is not this module's: thrown as it is (and mapped as any other error).
    const other = new Error('boom')
    expect(caught(other)).toBe(other)
    expect(caught(prismaError('23514', 'production: work order 01 is RELEASED'))).not.toBeInstanceOf(ConflictError)
  })
})
