import { describe, expect, it } from 'vitest'
import type { ViewReader } from '../rules'
import { openingViewFor, personalDefaultFor, personalDefaultRefusal, type PersonalDefaultFacts } from './rules'

/** My default view of a list (B-W2b-24, Z12:07; PLT-163): only my own view; it opens before any role default. */

const me = 'u-me'
const other = 'u-other'
const sales = 'r-sales'
const reader = (over: Partial<ViewReader> = {}): ViewReader => ({ userId: me, roleIds: [sales], save: true, manage: false, ...over })
type View = PersonalDefaultFacts & { id: string }
const view = (over: Partial<View> = {}): View => ({ id: 'v', ownerId: me, audience: 'ONLY_ME', roleId: null, roleDefault: false, isPersonalDefault: false, ...over })

describe('who may make a view their default', () => {
  it('the owner with views.save, whoever else sees the view', () => {
    expect(personalDefaultRefusal(view(), reader())).toBeNull()
    expect(personalDefaultRefusal(view({ audience: 'EVERYONE' }), reader())).toBeNull()
    expect(personalDefaultRefusal(view({ audience: 'ROLE', roleId: sales, roleDefault: true }), reader())).toBeNull()
  })

  it('never a view someone else shared (the mark is the row owner’s); never without views.save', () => {
    expect(personalDefaultRefusal(view({ ownerId: other, audience: 'EVERYONE' }), reader({ manage: true }))).toMatch(/save this one as your own/)
    expect(personalDefaultRefusal(view(), reader({ save: false }))).toMatch(/views\.save/)
    expect(personalDefaultRefusal(view(), reader({ save: false, manage: true }))).toMatch(/views\.save/)
  })
})

describe('the view a list opens on', () => {
  it('my own default first, before any role default; another person’s mark is not mine', () => {
    const roleDefault = view({ id: 'role', ownerId: other, audience: 'ROLE', roleId: sales, roleDefault: true })
    const mine = view({ id: 'mine', isPersonalDefault: true })
    const theirs = view({ id: 'theirs', ownerId: other, audience: 'EVERYONE', isPersonalDefault: true })
    expect(personalDefaultFor([theirs, roleDefault, mine], reader())?.id).toBe('mine')
    expect(openingViewFor([theirs, roleDefault, mine], reader())?.id).toBe('mine')
    expect(openingViewFor([theirs, roleDefault], reader())?.id).toBe('role')
    expect(personalDefaultFor([theirs], reader())).toBeNull()
    expect(openingViewFor([theirs], reader())).toBeNull()
  })
})
