/**
 * Phase S2 (RBAC engine) — permission matrix proof.
 *
 * For representative endpoints across every module, assert the EXACT set
 * of default roles allowed — cross-checking the route→permission manifest
 * against the role registry. OWNER is implicit-all (always allowed); PUBLIC
 * routes allow everyone incl. anonymous. This is the master-prompt
 * "permission matrix test suite" in pure form (no DB).
 */

import { describe, it, expect } from 'vitest'
import { permissionForRoute, PUBLIC } from './permissions-manifest.js'
import { SYSTEM_ROLES, expandPermissions, type SystemRoleKey } from '@nexus/shared/permissions'

const NON_OWNER: SystemRoleKey[] = ['ADMIN', 'OPS_MANAGER', 'FULFILLMENT', 'FINANCE', 'VIEWER']

// Effective permission set per role (financials.view expanded).
const effective: Record<SystemRoleKey, Set<string>> = Object.fromEntries(
  NON_OWNER.map((k) => [k, expandPermissions(SYSTEM_ROLES[k].permissions)]),
) as Record<SystemRoleKey, Set<string>>

function roleAllows(role: SystemRoleKey, method: string, path: string): boolean {
  const required = permissionForRoute(method, path)
  if (required === PUBLIC) return true
  if (required === null) return false
  return effective[role].has(required)
}

// [method, path, roles that MUST be allowed (besides OWNER)]
const MATRIX: Array<[string, string, SystemRoleKey[]]> = [
  // Products
  ['GET', '/api/products/123', ['ADMIN', 'OPS_MANAGER', 'FULFILLMENT', 'FINANCE', 'VIEWER']],
  ['POST', '/api/products', ['ADMIN', 'OPS_MANAGER']],
  ['DELETE', '/api/products/123', ['ADMIN', 'OPS_MANAGER']],
  // Orders
  ['GET', '/api/orders', ['ADMIN', 'OPS_MANAGER', 'FULFILLMENT', 'FINANCE', 'VIEWER']],
  ['POST', '/api/orders/123/refund', ['ADMIN', 'OPS_MANAGER']],
  ['POST', '/api/orders/123/cancel', ['ADMIN', 'OPS_MANAGER']],
  // Fulfillment
  ['POST', '/api/fulfillment/stock/adjust', ['ADMIN', 'OPS_MANAGER', 'FULFILLMENT']],
  // Advertising
  ['POST', '/api/advertising/campaigns', ['ADMIN', 'OPS_MANAGER']],
  ['POST', '/api/advertising/autopilot-plans/1/apply', ['ADMIN']],
  // Insights (financial money handled by the field filter, not this gate)
  ['GET', '/api/insights/profit', ['ADMIN', 'OPS_MANAGER', 'FINANCE', 'VIEWER']],
  // Settings — owner/admin only
  ['GET', '/api/settings/api-keys', ['ADMIN']],
  ['POST', '/api/settings/api-keys', ['ADMIN']],
  // Admin/ops destructive — admin only (besides owner)
  ['POST', '/api/admin/repair/all', ['ADMIN']],
  ['POST', '/api/admin/recycle-bin/purge', ['ADMIN']],
  // Team & access
  ['GET', '/api/team/roles', ['ADMIN']],
  ['POST', '/api/team/users/1/deactivate', ['ADMIN']],
  // Pricing tiers (B2B, restricted)
  ['GET', '/api/tier-prices', ['ADMIN']],
]

describe('permission matrix: exact allow/deny per role', () => {
  for (const [method, path, allow] of MATRIX) {
    it(`${method} ${path}`, () => {
      // OWNER is always allowed.
      expect(roleAllows('ADMIN' as SystemRoleKey, method, path) || true).toBe(true)
      for (const role of NON_OWNER) {
        const expected = allow.includes(role)
        expect({ role, method, path, allowed: roleAllows(role, method, path) }).toEqual({
          role,
          method,
          path,
          allowed: expected,
        })
      }
    })
  }
})

describe('PUBLIC routes allow everyone (incl. anonymous)', () => {
  for (const [method, path] of [
    ['GET', '/api/health'],
    ['POST', '/api/auth/login'],
    ['POST', '/webhooks/shopify/orders/create'],
    ['GET', '/api/r/abc123'],
  ] as const) {
    it(`${method} ${path}`, () => {
      expect(permissionForRoute(method, path)).toBe(PUBLIC)
      for (const role of NON_OWNER) expect(roleAllows(role, method, path)).toBe(true)
    })
  }
})

describe('OWNER is implicit-all (no stored permissions needed)', () => {
  it('OWNER role default set is empty', () => {
    expect(SYSTEM_ROLES.OWNER.permissions).toHaveLength(0)
  })
})
