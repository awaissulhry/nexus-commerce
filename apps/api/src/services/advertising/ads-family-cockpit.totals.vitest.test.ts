/**
 * AM-35 — the Family Cockpit's totals follow the Portfolios rule: enabled + paused campaigns are counted and their
 * 30-day spend and sales summed; archived members are counted apart and never added in. It counted every member, so
 * the cockpit said more campaigns, and more spend, than the Portfolios row one click before it.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { familyTotals } from './ads-family-cockpit.service.js'

const camp = (status: string, spend: number, sales: number, extra: { allow?: boolean; budget?: number } = {}) => ({
  status, liveWritesEnabled: extra.allow ?? false, spend30dCents: spend, sales30dCents: sales, dailyBudgetEur: extra.budget ?? 0,
})

describe('familyTotals', () => {
  it('counts enabled + paused, says archived apart, and leaves archived spend out', () => {
    const t = familyTotals([
      camp('ENABLED', 1000, 4000, { allow: true, budget: 10 }),
      camp('PAUSED', 500, 0, { allow: true, budget: 5 }),
      camp('ARCHIVED', 9000, 1000, { allow: true, budget: 50 }),
    ])
    expect(t).toEqual({
      campaigns: 2, enabled: 1, archived: 1, allowlisted: 2,
      spend30dCents: 1500, sales30dCents: 4000, acos30d: 1500 / 4000, dailyBudgetEur: 10,
    })
  })

  it('a family of archived campaigns only has nothing counted and no ACoS', () => {
    const t = familyTotals([camp('ARCHIVED', 700, 100)])
    expect(t).toMatchObject({ campaigns: 0, enabled: 0, archived: 1, spend30dCents: 0, sales30dCents: 0, acos30d: null })
  })
})
