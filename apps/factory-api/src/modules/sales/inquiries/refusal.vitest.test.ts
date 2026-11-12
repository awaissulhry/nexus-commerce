import { describe, expect, it } from 'vitest'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { databaseRefusal, InquiryRefusedError } from './store'

/** B-W2b-295: a database refusal of an inquiry write reaches a person as a 409 in words, never a 500. */

const driverError = (originalCode: string, originalMessage: string, meta: object = {}) => Object.assign(new Error('driver'), { meta: { ...meta, driverAdapterError: { cause: { originalCode, originalMessage } } } })

describe('the inquiries database refusals', () => {
  it("turns the sales intake guard's words into a 409", () => {
    const thrown = (() => {
      try {
        databaseRefusal(driverError('23514', 'customers: inquiry 0190 is QUOTED and never changes (only its note, and the erasure of its prospect)'))
      } catch (error) {
        return error
      }
    })()
    expect(thrown).toBeInstanceOf(ConflictError)
    expect((thrown as Error).message).toBe('Inquiry 0190 is QUOTED and never changes (only its note, and the erasure of its prospect).')
  })

  it('names the one-inquiry-per-mail and per-quote indexes, and leaves anything else as it is', () => {
    expect(() => databaseRefusal(driverError('23505', 'duplicate key value violates unique constraint "Inquiry_one_per_mail"'))).toThrow(InquiryRefusedError)
    try {
      databaseRefusal(driverError('23505', 'duplicate key value violates unique constraint "Inquiry_one_per_quote"'))
    } catch (error) {
      expect((error as InquiryRefusedError).issues[0]!.path).toBe('refusal/QUOTE_TAKEN')
    }
    const other = new Error('connection lost')
    expect(() => databaseRefusal(other)).toThrow(other)
    expect(() => databaseRefusal(driverError('23514', 'samples: not ours'))).toThrow('driver')
  })
})
