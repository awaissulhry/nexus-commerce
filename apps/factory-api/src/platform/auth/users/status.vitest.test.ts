import { describe, expect, it } from 'vitest'
import { assertTransition, canTransition } from '@nexus/factory-domain/state/machine'
import { userStatus } from './status'

describe('the user status machine', () => {
  const owner = { isOwner: true, otherActiveOwners: 1 }
  const lastOwner = { isOwner: true, otherActiveOwners: 0 }
  const member = { isOwner: false, otherActiveOwners: 0 }

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

  it('keeps an active owner: the last one is neither suspended nor deactivated', () => {
    expect(canTransition(userStatus, 'ACTIVE', 'SUSPENDED', owner).ok).toBe(true)
    expect(canTransition(userStatus, 'ACTIVE', 'SUSPENDED', lastOwner)).toMatchObject({ ok: false, reason: 'guard', missing: ['another active owner of the tenant'] })
    expect(() => assertTransition(userStatus, 'ACTIVE', 'DEACTIVATED', lastOwner)).toThrow(/another active owner/)
  })

  it('refuses a guarded move made without its facts (fail closed)', () => {
    expect(canTransition(userStatus, 'ACTIVE', 'DEACTIVATED')).toMatchObject({ ok: false, reason: 'guard', missing: ['the owner check'] })
  })
})
