import { describe, expect, it } from 'vitest'
import { mapError } from '../../../core/errors'
import { issueRefusal, refusingInWords, taxRefusal } from './store'

// B-W2b-392: the database's refusals of the tax tables reach a route as 409 in words, never a 500.
const prismaError = (code: string, cause: { originalCode: string; originalMessage: string }, target?: string) =>
  Object.assign(new Error('db'), { name: 'PrismaClientKnownRequestError', code, meta: { driverAdapterError: { cause }, ...(target ? { target } : {}) } })

describe('taxRefusal', () => {
  it("turns a 'tax: …' or 'invoicing: …' check_violation into a 409 in its words", () => {
    const tax = taxRefusal(prismaError('P2010', { originalCode: '23514', originalMessage: 'tax: tax code 22 (IT) is in force since 2026-01-01; a code in use is never edited: end this version and make a new one' }))
    expect(mapError(tax)).toMatchObject({ status: 409, code: 'conflict', message: 'Tax code 22 (IT) is in force since 2026-01-01; a code in use is never edited: end this version and make a new one.', issues: [{ path: 'refusal/DATABASE' }] })
    const invoicing = taxRefusal(prismaError('P2010', { originalCode: '23514', originalMessage: 'invoicing: declarations of intent are switched off for this company until the accountant confirms them (GATE-ACCOUNTANT); invoice x names none' }))
    expect(invoicing?.message).toMatch(/^Declarations of intent are switched off/)
  })

  it('turns the partial uniques into their words, and leaves anything else alone', () => {
    expect(taxRefusal(prismaError('P2002', { originalCode: '23505', originalMessage: 'duplicate key value violates unique constraint "DeclarationOfIntent_one_live"' }))?.issues).toEqual([{ path: 'refusal/PROTOCOL_LIVE', message: expect.stringContaining('recorded already') }])
    expect(taxRefusal(prismaError('P2010', { originalCode: '23514', originalMessage: 'inventory: location A is blocked' }))).toBeNull()
    expect(taxRefusal(new Error('other'))).toBeNull()
  })

  it('refusingInWords rethrows the mapped refusal, else the error itself', async () => {
    await expect(refusingInWords(() => Promise.reject(prismaError('P2010', { originalCode: '23514', originalMessage: 'tax: a stamp duty quarter starts on 1 January, April, July or October, not on 2026-02-01' })))).rejects.toMatchObject({ code: 'conflict' })
    const other = new Error('boom')
    await expect(refusingInWords(() => Promise.reject(other))).rejects.toBe(other)
  })

  it("issueRefusal says the issue's words: one problem, or how many with the first", () => {
    expect(issueRefusal([{ code: 'A', path: 'p', message: 'One thing.' }]).message).toBe('One thing.')
    expect(issueRefusal([{ code: 'A', path: 'p', message: 'One thing.' }, { code: 'B', path: 'q', message: 'Other.' }]).message).toBe('This invoice cannot be issued yet: 2 things to fix. One thing.')
  })
})
