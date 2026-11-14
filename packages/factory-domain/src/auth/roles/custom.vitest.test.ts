import { describe, expect, it } from 'vitest'
import type { Grant, Permission } from '../../core/permissions'
import { beyondMaker, customContentRefusals, holdsEveryOfficePermission, reviewOf } from './custom'
import { templateOf } from './templates'

const grant = (permissions: string[]): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' })

describe('custom roles never hold more than their maker (PLT-031)', () => {
  const maker = [grant(['quotes.view', 'quotes.manage', 'money.price']), grant(['orders.view'])]

  it('names what the maker does not hold, permissions and grains', () => {
    expect(beyondMaker({ permissions: ['quotes.view', 'orders.view'] as Permission[], grains: ['price'] }, maker)).toEqual({ permissions: [], grains: [] })
    expect(beyondMaker({ permissions: ['quotes.view', 'invoices.issue'] as Permission[], grains: ['price', 'cost'] }, maker)).toEqual({ permissions: ['invoices.issue'], grains: ['cost'] })
  })

  it('checks all of a new role, only the additions of an edit', () => {
    const before = { permissions: ['invoices.issue', 'quotes.view'] as Permission[], grains: [] as const }
    expect(customContentRefusals(null, before, maker).map((issue) => issue.path)).toEqual(['body/permissions/invoices.issue/beyondYou'])
    // The editor removes quotes.view and adds orders.view: what the role already had is not theirs to hold.
    expect(customContentRefusals(before, { permissions: ['invoices.issue', 'orders.view'] as Permission[], grains: [] }, maker)).toEqual([])
    expect(customContentRefusals(before, { permissions: ['invoices.issue'] as Permission[], grains: ['margin'] }, maker).map((issue) => issue.path)).toEqual(['body/grains/margin/beyondYou'])
  })

  it("never the owner's every(): no custom role holds every office permission", () => {
    const owner = templateOf('owner')!
    expect(holdsEveryOfficePermission(owner.permissions)).toBe(true)
    expect(holdsEveryOfficePermission(templateOf('admin')!.permissions)).toBe(false)
    const everything = [grant([...owner.permissions])]
    expect(customContentRefusals(null, { permissions: owner.permissions, grains: [] }, everything).map((issue) => issue.path)).toEqual(['body/permissions/ownerEvery'])
  })
})

describe('the review of a change (Change role)', () => {
  it('says what it adds and removes and whether it raises rights', () => {
    const before = { permissions: ['quotes.view', 'quotes.manage'] as Permission[], grains: ['price'] as const, requireMfa: true }
    expect(reviewOf(before, { ...before, permissions: ['quotes.view'] as Permission[] })).toEqual({
      permissionsAdded: [],
      permissionsRemoved: ['quotes.manage'],
      grainsAdded: [],
      grainsRemoved: [],
      requireMfa: { before: true, after: true },
      raises: false,
    })
    expect(reviewOf(before, { ...before, grains: ['price', 'cost'] }).raises).toBe(true)
    expect(reviewOf(before, { ...before, requireMfa: false }).raises).toBe(true)
    expect(reviewOf({ ...before, requireMfa: false }, before).raises).toBe(false)
  })
})
