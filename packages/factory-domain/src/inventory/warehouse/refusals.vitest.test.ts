import { describe, expect, it } from 'vitest'
import { databaseWarehouseRefusal, WAREHOUSE_REFUSAL_ISSUES } from './refusals'

describe('databaseWarehouseRefusal()', () => {
  it("reads the database's warehouse refusals into words, without the move's id", () => {
    expect(databaseWarehouseRefusal('inventory: location A1-DMG-01 is blocked (DAMAGE); it takes no move in or out until it is unblocked (stock move 0193…)')).toEqual({
      path: WAREHOUSE_REFUSAL_ISSUES.blocked,
      message: 'Location A1-DMG-01 is blocked (damage): nothing moves in or out of it until it is unblocked.',
    })
    expect(databaseWarehouseRefusal('inventory: count CNT-2026-0004 is counting this material at location A1-CNT-01 (a frozen line); its moves wait until the line is counted (stock move 0193…)')).toEqual({
      path: WAREHOUSE_REFUSAL_ISSUES.frozen,
      message: 'Count CNT-2026-0004 is counting this material at A1-CNT-01: its moves there wait until the line is counted.',
    })
    expect(databaseWarehouseRefusal('inventory: stock move 0193… enters or leaves a transit location without its transfer; goods in transit move only with their transfer (the ship, the receipt, a difference written off)')?.path).toBe(WAREHOUSE_REFUSAL_ISSUES.transit)
  })

  it('leaves every other message to the caller', () => {
    expect(databaseWarehouseRefusal('inventory: stock move 0193… takes 2 from location X, which holds 1 of it; stock never goes below zero')).toBeNull()
    expect(databaseWarehouseRefusal('period lock: stock move 0193… is dated 2026-09-30, inside the closed period')).toBeNull()
  })
})
