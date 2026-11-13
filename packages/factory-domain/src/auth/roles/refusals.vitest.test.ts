import { describe, expect, it } from 'vitest'
import { databaseRoleRefusal, ROLE_REFUSAL_ISSUES } from './refusals'

describe('databaseRoleRefusal()', () => {
  it("reads the database's archived-role refusals back as words with their issue path", () => {
    expect(databaseRoleRefusal('roles: role x is archived: it changes no more (restore it first)')).toEqual({
      path: ROLE_REFUSAL_ISSUES.archived,
      message: 'This role is archived: it changes no more. Restore it first.',
    })
    expect(databaseRoleRefusal('roles: role x is archived: it is given to nobody (assignment y)')?.message).toMatch(/given to nobody\. Pick another role/)
    expect(databaseRoleRefusal('roles: role x is archived: it is given to nobody (floor role y)')?.path).toBe(ROLE_REFUSAL_ISSUES.archived)
  })

  it('leaves every other message alone, the archive refusals no route reaches included', () => {
    expect(databaseRoleRefusal('roles: role x is still held: end its assignments first, then archive it')).toBeNull()
    expect(databaseRoleRefusal('roles: system role x is never archived (it follows its template)')).toBeNull()
    expect(databaseRoleRefusal('portal: partner role x holds at most the price grain, never cost, margin, wages or pay (it holds {cost})')).toBeNull()
  })
})
