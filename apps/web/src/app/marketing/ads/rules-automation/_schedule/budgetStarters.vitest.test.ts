/**
 * BSP-B5 — the starters must be DERIVED, not shipped.
 *
 * The claim the approved phase made is "starter schedules built from *this* account's measured
 * hours". A hard-coded 18:00–23:00 would satisfy every test that only checked the shape, so these
 * assert the RELATIONSHIP instead: move the spend to different hours and the window must follow.
 * That is the only kind of test that can fail if someone later replaces the arithmetic with a
 * constant.
 */
import { describe, expect, it } from 'vitest'
import { budgetStarters, starterType, DAY_MOVE_NOTE } from './budgetStarters'
import type { RawCell } from './heatMetrics'

const cell = (dow: number, hour: number, costEur: number, salesEur = 0, orders = 0): RawCell => ({
  dow, hour, costCents: Math.round(costEur * 100), salesCents: Math.round(salesEur * 100),
  orders, clicks: 0, impressions: 0, acos: salesEur > 0 ? (costEur / salesEur) * 100 : null,
  roas: costEur > 0 ? salesEur / costEur : null,
})

/** Spend concentrated in `peakHours`, a flat trickle elsewhere, across all seven weekdays. */
const account = (peakHours: number[], deadHours: number[] = []) => {
  const out: RawCell[] = []
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      if (peakHours.includes(h)) out.push(cell(d, h, 10, 40, 2))
      else if (deadHours.includes(h)) out.push(cell(d, h, 3, 0, 0))   // spends, returns nothing
      else out.push(cell(d, h, 1, 4, 1))
    }
  }
  return out
}

const byKey = (cells: RawCell[], n = 7) => Object.fromEntries(budgetStarters(cells, n).map((s) => [s.key, s]))
const byKey2 = (cells: RawCell[], n: number, budgets: Array<number | null>) =>
  Object.fromEntries(budgetStarters(cells, n, budgets).map((s) => [s.key, s]))

describe('budgetStarters — the peak window follows the data', () => {
  it('🔴 moving the spend peak moves the window', () => {
    const evening = byKey(account([19, 20, 21])).peak
    const morning = byKey(account([6, 7, 8])).peak
    expect(evening.windows![0].start).toBe('19:00')
    expect(evening.windows![0].end).toBe('22:00')
    expect(morning.windows![0].start).toBe('06:00')
    expect(morning.windows![0].end).toBe('09:00')
    expect(morning.windows![0].start).not.toBe(evening.windows![0].start)
  })

  it('covers every weekday, because a window is per-day', () => {
    const s = byKey(account([20])).peak
    expect(new Set(s.windows!.map((w) => w.day)).size).toBe(7)
  })

  it('is sized to the write gate: +50%, the largest raise that always clears the ceiling', () => {
    const s = byKey(account([20])).peak
    expect(s.windows!.every((w) => w.adj === 'incPct' && w.value === '50')).toBe(true)
  })

  it('the description quotes the real euros it derived, not a placeholder', () => {
    const s = byKey(account([20])).peak
    // 7 days x €10 in the peak hour
    expect(s.desc).toContain('€70.00')
    expect(s.desc).toContain('20:00–21:00')
    expect(s.desc).not.toMatch(/undefined|NaN/)
  })
})

describe('budgetStarters — the dead window is evidence, not absence', () => {
  it('finds a run that SPENT and returned nothing', () => {
    const s = byKey(account([20], [3, 4, 5])).dead
    expect(s.windows).not.toBeNull()
    expect(s.windows![0].start).toBe('03:00')
    expect(s.windows![0].end).toBe('06:00')
    expect(s.windows![0].adj).toBe('decPct')
    expect(s.windows![0].value).toBe('30')  // the gate's daily drop limit
  })

  it('🔴 an hour with NO spend and no sales is not "dead" — that is absence, not evidence', () => {
    const cells: RawCell[] = []
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) cells.push(h >= 2 && h <= 6 ? cell(d, h, 0, 0, 0) : cell(d, h, 5, 20, 1))
    const s = byKey(cells).dead
    expect(s.windows).toBeNull()
    expect(s.reason).toContain('no dead span')
  })

  it('a single dead hour is not a run — it needs at least two', () => {
    expect(byKey(account([20], [3])).dead.windows).toBeNull()
  })

  it('picks the LONGEST dead run when there are several', () => {
    const s = byKey(account([20], [2, 3, 9, 10, 11])).dead
    expect(s.windows![0].start).toBe('09:00')
    expect(s.windows![0].end).toBe('12:00')
  })
})

describe('budgetStarters — the multiplier starter', () => {
  it('🔴 carries NO hours, which is what the executor reads as all-day', () => {
    const s = byKey(account([20])).allday
    expect(s.windows!.every((w) => w.start === '' && w.end === '')).toBe(true)
    expect(s.windows!.map((w) => w.day).sort()).toEqual([0, 6])
    expect(s.windows!.every((w) => w.adj === 'mult')).toBe(true)
  })

  it('states the weekend share it measured', () => {
    // 7 equal days ⇒ Sat+Sun are 2/7 = 29%
    expect(byKey(account([20])).allday.desc).toContain('29%')
  })

  it('needs the Budget Multiplier type; the other two need Campaign Budget', () => {
    expect(starterType('allday')).toBe('budget-multiplier')
    expect(starterType('peak')).toBe('campaign-budget')
    expect(starterType('dead')).toBe('campaign-budget')
  })
})

describe('budgetStarters — absent, not fabricated', () => {
  it('🔴 no cells ⇒ NO windows, and a reason naming the cause', () => {
    for (const s of budgetStarters([], 0)) {
      expect(s.windows).toBeNull()
      expect(s.reason).toContain('Add campaigns first')
    }
  })

  it('campaigns selected but no hourly rows says THAT, not "add campaigns"', () => {
    for (const s of budgetStarters([], 4)) {
      expect(s.reason).toContain('no hourly spend')
      expect(s.reason).not.toContain('Add campaigns first')
    }
  })

  it('hourly rows with zero spend everywhere cannot produce a peak', () => {
    const flat: RawCell[] = []
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) flat.push(cell(d, h, 0, 0, 0))
    const s = byKey(flat).peak
    expect(s.windows).toBeNull()
    expect(s.reason).toContain('no recorded spend')
  })

  it('every starter is always OFFERED — never silently dropped from the list', () => {
    expect(budgetStarters([], 0).map((s) => s.key)).toEqual(['peak', 'dead', 'allday'])
    expect(budgetStarters(account([20]), 3).map((s) => s.key)).toEqual(['peak', 'dead', 'allday'])
  })
})

describe('budgetStarters — prose', () => {
  it('the gate note states the limit rather than promising the write will land', () => {
    expect(DAY_MOVE_NOTE).toContain('−30%')
    expect(DAY_MOVE_NOTE).toContain('+50%')
    expect(DAY_MOVE_NOTE).toContain('counting every writer')
    expect(DAY_MOVE_NOTE).not.toMatch(/guarantee|will be applied/i)
  })

  it('no description or reason is malformed', () => {
    for (const cells of [[], account([20], [3, 4])]) {
      for (const s of budgetStarters(cells as RawCell[], 3)) {
        const text = s.windows ? s.desc : s.reason
        expect(text, text).not.toMatch(/undefined|NaN|\.\./)
        expect(text, text).toMatch(/\.$/)
      }
    }
  })
})

describe('budgetStarters — a flat curve has no peak, and says so', () => {
  /**
   * 🔴 Found on the rig against the real IT selection: the derivation faithfully returned
   * 11:00–00:00, a THIRTEEN-hour "peak". The number was true and the word was not — a +50% lift
   * across 13 hours a day is an across-the-board budget rise, not peak funding.
   */
  const flatTop = () => {
    const out: RawCell[] = []
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) out.push(cell(d, h, h >= 11 ? 10 : 1, h >= 11 ? 30 : 3, 1))
    return out
  }

  it('refuses to call a 13-hour span a peak', () => {
    const s = byKey(flatTop()).peak
    expect(s.windows).toBeNull()
    expect(s.reason).toContain('Spend is spread evenly')
    expect(s.reason).toContain('13 of 24 hours')
    expect(s.reason).toContain('belongs to the monthly plan')
  })

  it('still offers a genuine narrow peak', () => {
    const s = byKey(account([19, 20, 21])).peak
    expect(s.windows).not.toBeNull()
    expect(s.windows![0].start).toBe('19:00')
  })

  it('the boundary: 11 hours is still a peak, 12 is not', () => {
    const mk = (from: number) => {
      const out: RawCell[] = []
      for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) out.push(cell(d, h, h >= from ? 10 : 1, 30, 1))
      return out
    }
    expect(byKey(mk(13)).peak.windows).not.toBeNull()   // 13..23 = 11 hours
    expect(byKey(mk(12)).peak.windows).toBeNull()       // 12..23 = 12 hours
  })
})

describe('budgetStarters — the €1 floor caveat (verified against the real executor)', () => {
  /**
   * 🔴 `computeBudget(1, 'campaign-budget', 'decPct', 30)` returns €1.00 — a cut on a floored
   * campaign does nothing. 35 of this account's 70 enabled campaigns sit there, so a cut starter
   * that stayed silent about it would be promising something it cannot deliver.
   */
  const cells = account([20], [3, 4, 5])

  it('counts the floored campaigns in the SELECTION and names them in the cut starter', () => {
    const s = byKey2(cells, 5, [1, 1, 1, 4.5, 9])
    expect(s.dead.desc).toContain('3 of the 5 selected campaigns are already at Amazon’s €1 floor'.replace('’', "'"))
    expect(s.dead.desc).toContain('no-op')
  })

  it('says nothing about the floor when nothing is on it', () => {
    expect(byKey2(cells, 3, [4, 9, 12]).dead.desc).not.toContain('floor')
  })

  it('singular reads correctly', () => {
    expect(byKey2(cells, 2, [1, 8]).dead.desc).toContain('1 of the 2 selected campaign is')
  })

  it('the RAISE starter carries no floor caveat — a floor only blocks decreases', () => {
    expect(byKey2(account([20]), 3, [1, 1, 1]).peak.desc).not.toContain('floor')
  })
})
