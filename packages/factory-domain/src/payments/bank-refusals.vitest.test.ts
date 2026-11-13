import { describe, expect, it } from 'vitest'
import { BANK_REFUSAL_ISSUES, databaseBankRefusal } from './bank-refusals'

describe('databaseBankRefusal()', () => {
  it("reads the database's write-off, reminder stop and export refusals back as words with their issue path", () => {
    expect(databaseBankRefusal('payments: allocation x has a write-off still standing; reverse the write-off first')?.path).toBe(BANK_REFUSAL_ISSUES.standing)
    expect(databaseBankRefusal('payments: payment x has a write-off still standing; reverse the write-off before the payment is voided')?.message).toMatch(/void the payment/)
    expect(databaseBankRefusal('payments: payment x of 50 has 0 allocated; 50 more passes it (0 of it refunded or due to be, 25 written off)')?.path).toBe(BANK_REFUSAL_ISSUES.writtenOff)
    expect(databaseBankRefusal('payments: invoice x is open for 0 (gross 61000, credited 0, paid 60950, written off 50); 1 more passes it')?.path).toBe(BANK_REFUSAL_ISSUES.writtenOff)
    expect(databaseBankRefusal('refunds: payment x of 50 has 0 allocated, 0 refunded or due and 25 written off; refund y of 50 passes what is unplaced')?.path).toBe(BANK_REFUSAL_ISSUES.writtenOff)
    const stopped = databaseBankRefusal('receivables: reminder x covers invoice y, whose reminders are stopped (PROMISE_TO_PAY); it is not approved or sent while the stop holds')
    expect(stopped).toEqual({ path: BANK_REFUSAL_ISSUES.stopped, message: expect.stringContaining('the customer promised to pay') })
    expect(databaseBankRefusal('accounting: export x hands over Invoice y as NEW, but export z handed it over already (a re-export carries it as CHANGED)')?.path).toBe(BANK_REFUSAL_ISSUES.handedOver)
  })

  it('leaves every other message alone, the W1 caps with nothing written off included', () => {
    expect(databaseBankRefusal('payments: payment x of 10000 has 6000 allocated; 5000 more passes it (0 of it refunded or due to be)')).toBeNull()
    expect(databaseBankRefusal('payments: invoice x is open for 0 (gross 12200, credited 0, paid 12200); 1 more passes it')).toBeNull()
    expect(databaseBankRefusal('refunds: payment x of 100 has 0 allocated and 50 refunded or due; refund y of 60 passes what is unplaced')).toBeNull()
    expect(databaseBankRefusal('payments: write-off x of 200 passes the company\'s write-off tolerance of 100 (or names another)')).toBeNull()
  })
})
