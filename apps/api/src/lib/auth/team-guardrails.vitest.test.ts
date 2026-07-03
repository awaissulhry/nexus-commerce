/**
 * Phase S2 (RBAC engine) — Owner-supremacy guardrail tests.
 */

import { describe, it, expect } from 'vitest'
import {
  GuardrailError,
  assertCanAssignRole,
  assertCanRemoveOwner,
  assertCanDeactivate,
  assertRoleEditable,
  assertRoleDeletable,
  assertValidPermissions,
} from './team-guardrails.js'

describe('only an owner grants owner', () => {
  it('non-owner granting OWNER throws', () => {
    expect(() => assertCanAssignRole(false, 'OWNER')).toThrow(GuardrailError)
  })
  it('owner granting OWNER is allowed', () => {
    expect(() => assertCanAssignRole(true, 'OWNER')).not.toThrow()
  })
  it('anyone granting a non-owner role is allowed', () => {
    expect(() => assertCanAssignRole(false, 'VIEWER')).not.toThrow()
  })
})

describe('last-owner protection', () => {
  it('removing the OWNER role from the last owner throws', () => {
    expect(() => assertCanRemoveOwner(true, 1)).toThrow('last Owner')
  })
  it('removing OWNER when others exist is allowed', () => {
    expect(() => assertCanRemoveOwner(true, 2)).not.toThrow()
  })
  it('deactivating the last owner throws', () => {
    expect(() => assertCanDeactivate(true, 1)).toThrow(GuardrailError)
  })
  it('deactivating a non-owner is always allowed', () => {
    expect(() => assertCanDeactivate(false, 1)).not.toThrow()
  })
})

describe('system role protection', () => {
  it('OWNER role is not editable', () => {
    expect(() => assertRoleEditable({ key: 'OWNER', isSystem: true })).toThrow('system-protected')
  })
  it('custom roles are editable', () => {
    expect(() => assertRoleEditable({ key: 'custom-x', isSystem: false })).not.toThrow()
  })
  it('system roles cannot be deleted', () => {
    expect(() => assertRoleDeletable({ isSystem: true }, 0)).toThrow(GuardrailError)
  })
  it('custom role with members cannot be deleted', () => {
    expect(() => assertRoleDeletable({ isSystem: false }, 3)).toThrow('member')
  })
  it('empty custom role can be deleted', () => {
    expect(() => assertRoleDeletable({ isSystem: false }, 0)).not.toThrow()
  })
})

describe('permission validation', () => {
  it('rejects unknown permissions', () => {
    expect(() => assertValidPermissions(['products.view', 'not.a.real.perm'])).toThrow('Unknown permission')
  })
  it('accepts registry permissions', () => {
    expect(() => assertValidPermissions(['products.view', 'financials.view'])).not.toThrow()
  })
})
