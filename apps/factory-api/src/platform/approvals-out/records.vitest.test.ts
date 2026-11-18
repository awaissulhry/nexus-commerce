// fix-pr-10: this file starts where order-changes.pg starts, on the sales side of an import cycle: reacceptance → amend → moves →
// the internal approvals engine → its kinds → BRAND_OVERRIDE (B-PR-38) → this registry → reacceptance again. Keep this import first.
import { REACCEPTANCE_ADAPTER } from '../../modules/sales/orders/reacceptance'
import { describe, expect, it } from 'vitest'
import { adapterFor, adapterOf } from './records'

/**
 * The registry of approval records (B-W2b-184) is read at first use, not while its module loads: a module that is still
 * loading when the registry's module runs (the cycle above) is then complete. Before, the registry read REACCEPTANCE_ADAPTER
 * while reacceptance.ts was still loading, and the suite died at import ("Cannot read properties of undefined (reading
 * 'recordType')"), whatever the order of the app's routes.
 */
describe('approval records (fix-pr-10)', () => {
  it('loads from the sales side of the cycle, and the revised order is registered once', () => {
    expect(REACCEPTANCE_ADAPTER.recordType).toBe('SalesOrderAmendment')
    expect(adapterFor('SalesOrderAmendment')).toBe(REACCEPTANCE_ADAPTER)
    expect(adapterOf('REVISED_ORDER', 'SalesOrderAmendment')).toBe(REACCEPTANCE_ADAPTER)
    expect(adapterOf('SAMPLE', 'SalesOrderAmendment')).toBeUndefined()
    expect(adapterFor('NoSuchRecord')).toBeUndefined()
  })
})
