import { describe, expect, it } from 'vitest'
import { SYSTEM_ROLES } from '@nexus/shared/permissions'
import { OWNER_ONLY_TEAM_NOTE, canManageTeam, roleCardDescription } from './workspaceTeamModel'

describe('Team & Access — who is offered the owner-only changes', () => {
  it('offers them to an owner (canManage: true)', () => {
    expect(canManageTeam({ canManage: true })).toBe(true)
  })

  it('shows a member who may only read the team no changes (canManage: false)', () => {
    expect(canManageTeam({ canManage: false })).toBe(false)
  })

  it('reads an answer without canManage as an owner: the older API served the team to owners alone', () => {
    expect(canManageTeam({})).toBe(true)
  })

  it('offers nothing before the team has loaded', () => {
    expect(canManageTeam(null)).toBe(false)
    expect(canManageTeam(undefined)).toBe(false)
  })

  it('says why the changes are unavailable, and that the team itself is readable', () => {
    expect(OWNER_ONLY_TEAM_NOTE).toMatch(/^You can see this team\. Only an owner /)
  })
})

describe('Team & Access — the line under each business role', () => {
  it('shows a built-in role’s description, and the Admin’s says team changes stay with the owner', () => {
    const admin = SYSTEM_ROLES.ADMIN
    expect(roleCardDescription({ isSystem: true, description: admin.description })).toBe(`Built-in role · ${admin.description}`)
    expect(admin.description).toMatch(/Sees the team; inviting members and changing roles stay with the owner\./)
    // Nothing in it promises the user management an Admin does not have.
    expect(admin.description).not.toMatch(/user management/i)
  })

  it('keeps the plain labels when there is nothing to add', () => {
    expect(roleCardDescription({ isSystem: true, description: '' })).toBe('Built-in role')
    expect(roleCardDescription({ isSystem: false, description: '  ' })).toBe('Custom role for this business')
    expect(roleCardDescription({ isSystem: false, description: 'Lists and prices' })).toBe('Lists and prices')
  })
})
