import { describe, expect, it } from 'vitest'
import { ACTUAL_COST_REFUSAL_ISSUES, databaseActualCostRefusal } from './actuals-refusals'

describe('databaseActualCostRefusal()', () => {
  it("reads the database's closed-work-order refusals back as words with their issue path", () => {
    expect(databaseActualCostRefusal('cost: work order w is CLOSED; it takes no cost entry but a reversal (entry e, LABOUR): reopen it first')).toEqual({
      path: ACTUAL_COST_REFUSAL_ISSUES.closed,
      message: 'This work order is closed: it takes no cost entry but a reversal. Reopen it first.',
    })
    expect(
      databaseActualCostRefusal('cost: the close of work order w is settled (its closing entry is posted); it takes no cost entry but a reversal (entry e, MATERIAL): undo the close first')?.message,
    ).toMatch(/close is settled: .* Undo the close first\./)
    expect(databaseActualCostRefusal('cost: CLOSE entry e belongs to close c, which stands; it is reversed only once the close is undone (MES-013)')).toEqual({
      path: ACTUAL_COST_REFUSAL_ISSUES.closeStands,
      message: "This entry is part of a work order's close that stands: undo the close, which reverses it.",
    })
  })

  it('leaves every other message alone, the rules no existing route reaches included', () => {
    expect(databaseActualCostRefusal("cost: the company's figures for the accountant are switched off (GATE-ACCOUNTANT): cost of goods sold x is written only once a person switches them on in the costing settings")).toBeNull()
    expect(databaseActualCostRefusal('cost: work order w is IN_PROGRESS; a work order is closed once it is COMPLETED (close c)')).toBeNull()
    expect(databaseActualCostRefusal('costing: reversal r says why')).toBeNull()
  })
})
