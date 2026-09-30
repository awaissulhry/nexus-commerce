import { describe, expect, it } from 'vitest'
import { OWNER_ONLY_TEAM_NOTE, canManageTeam } from './workspaceTeamModel'

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
