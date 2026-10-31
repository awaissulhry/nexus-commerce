import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { receipt } from './demo/fixtures'
import { dailyCan, ddtFixBody, ddtFixDraftOf, ddtFixHeld, ddtFixOpenHeld, ddtFixProblem } from './daily-model'

/**
 * Warehouse › Receipts, W2b (B-W2b-14; Z1:02): the supplier's DDT number and date corrected on a posted receipt — who
 * may, when, why Save is held, the body, refusals in our words (made-up data).
 */

const can = dailyCan(['inventory.receive', 'inventory.stock.view', 'files.upload'])
const viewer = dailyCan(['inventory.stock.view'])

describe("a posted receipt's DDT corrected (Z1:02)", () => {
  const posted = receipt()

  it('only a POSTED receipt, with inventory.receive', () => {
    expect(ddtFixOpenHeld(posted, can)).toBeNull()
    expect(ddtFixOpenHeld(posted, viewer)).toEqual({ key: 'held.noReceive' })
    expect(ddtFixOpenHeld({ ...posted, status: 'REVERSED' }, can)).toEqual({ key: 'ddtFix.held.REVERSED' })
    expect(ddtFixOpenHeld({ ...posted, status: 'OPEN' }, can)).toEqual({ key: 'ddtFix.held.open' })
  })

  it('Save is held until something changes, the date is not after today and goes with a number, and why is said', () => {
    const start = ddtFixDraftOf(posted)
    expect(start).toEqual({ ddtNumber: posted.supplierDdtNumber, ddtDate: posted.supplierDdtDate, reason: '' })
    const today = '2026-10-31'
    expect(ddtFixHeld(start, posted, can, false, today)).toEqual({ key: 'ddtFix.held.same' })
    expect(ddtFixHeld({ ...start, ddtNumber: 'DDT-DEMO-526' }, posted, can, false, today)).toEqual({ key: 'ddtFix.held.reason' })
    expect(ddtFixHeld({ ...start, ddtDate: '2026-11-02', reason: 'Data sbagliata' }, posted, can, false, today)).toEqual({ key: 'ddtFix.held.future' })
    expect(ddtFixHeld({ ddtNumber: '', ddtDate: '2026-10-20', reason: 'Solo la data' }, posted, can, false, today)).toEqual({ key: 'ddtFix.held.dateAlone' })
    expect(ddtFixHeld({ ...start, ddtNumber: 'DDT-DEMO-526', reason: 'Cifre invertite' }, posted, can, true, today)).toEqual({ key: 'held.busy' })
    expect(ddtFixHeld({ ...start, ddtNumber: 'DDT-DEMO-526', reason: 'Cifre invertite' }, posted, can, false, today)).toBeNull()
  })

  it('the body names the version as read; blank is none', () => {
    expect(ddtFixBody({ ddtNumber: ' DDT-DEMO-526 ', ddtDate: '2026-10-28', reason: ' Cifre invertite ' }, posted)).toEqual({ version: posted.version, supplierDdtNumber: 'DDT-DEMO-526', supplierDdtDate: '2026-10-28', reason: 'Cifre invertite' })
    expect(ddtFixBody({ ddtNumber: '', ddtDate: '', reason: 'Arrivata senza DDT' }, posted)).toMatchObject({ supplierDdtNumber: null, supplierDdtDate: null })
  })

  it('refusals in our words', () => {
    expect(ddtFixProblem(new ApiError('conflict', 409, 'invalid_state', 'Receipt GR-1 is reversed', 'req'))).toEqual({ key: 'ddtFix.refused.state' })
    expect(ddtFixProblem(new ApiError('conflict', 409, 'conflict', 'This GoodsReceipt changed since it was read', 'req'))).toEqual({ key: 'refused.moved' })
    expect(ddtFixProblem(new ApiError('invalid', 400, 'invalid_input', 'Bad', 'req', [{ path: 'body/reason', message: 'x' }]))).toEqual({ key: 'ddtFix.held.reason' })
    expect(ddtFixProblem(new ApiError('invalid', 400, 'invalid_input', 'Bad', 'req', [{ path: 'body/supplierDdtDate', message: 'x' }]))).toEqual({ key: 'ddtFix.held.future' })
  })
})
