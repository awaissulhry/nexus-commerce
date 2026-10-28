import { describe, expect, it } from 'vitest'
import { assertTransition, canTransition } from '../../state/machine'
import { userStatus } from './status'

describe('the user status machine', () => {
  const admin = { isAdmin: true, otherActiveAdmins: 1 }
  const lastAdmin = { isAdmin: true, otherActiveAdmins: 0 }
  const member = { isAdmin: false, otherActiveAdmins: 0 }

  it('allows the lifecycle moves and nothing else', () => {
    expect(canTransition(userStatus, 'INVITED', 'ACTIVE').ok).toBe(true)
    expect(canTransition(userStatus, 'ACTIVE', 'SUSPENDED', member).ok).toBe(true)
    expect(canTransition(userStatus, 'SUSPENDED', 'ACTIVE').ok).toBe(true)
    expect(canTransition(userStatus, 'SUSPENDED', 'DEACTIVATED', member).ok).toBe(true)
    expect(canTransition(userStatus, 'DEACTIVATED', 'INVITED').ok).toBe(true)
    expect(canTransition(userStatus, 'DEACTIVATED', 'ACTIVE')).toMatchObject({ ok: false, reason: 'not_allowed' })
    expect(canTransition(userStatus, 'INVITED', 'SUSPENDED')).toMatchObject({ ok: false, reason: 'not_allowed' })
    expect(canTransition(userStatus, 'ACTIVE', 'INVITED')).toMatchObject({ ok: false, reason: 'not_allowed' })
  })

  it('keeps an active administrator: the last one is neither suspended nor deactivated', () => {
    expect(canTransition(userStatus, 'ACTIVE', 'SUSPENDED', admin).ok).toBe(true)
    expect(canTransition(userStatus, 'ACTIVE', 'SUSPENDED', lastAdmin)).toMatchObject({ ok: false, reason: 'guard', missing: ['another active administrator of the tenant'] })
    expect(() => assertTransition(userStatus, 'ACTIVE', 'DEACTIVATED', lastAdmin)).toThrow(/another active administrator/)
  })

  it('refuses a guarded move made without its facts (fail closed)', () => {
    expect(canTransition(userStatus, 'ACTIVE', 'DEACTIVATED')).toMatchObject({ ok: false, reason: 'guard', missing: ['the administrator check'] })
  })
})
