/**
 * The system roles' stored text follows the registry on every API boot (`seedSystemRoles`, apps/api/src/index.ts).
 *
 * 2026-09-30 — the Owner chose to keep team changes owner-only, so the Admin role no longer promises "user
 * management". A business that stored the old text gets the new one at the next boot: the seed rewrites name and
 * description (text) and the registry's permissions, and touches nobody's session unless asked.
 *
 * Runs the real seed on PostgreSQL (PGlite).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../db.js'
import { SYSTEM_ROLES } from '@nexus/shared/permissions'
import { seedSystemRoles } from './team-access.service.js'

const OLD_ADMIN_TEXT = 'Everything except granting Owner or deleting/demoting Owners. Full settings + user management.'
let personId = ''

beforeAll(async () => {
  await prisma.role.create({ data: { key: 'ADMIN', name: 'Admin', description: OLD_ADMIN_TEXT, permissions: [...SYSTEM_ROLES.ADMIN.permissions], isSystem: true, requireMfa: true } })
  personId = (await prisma.userProfile.create({ data: { email: 'team-seed@example.test', status: 'active' } })).id
}, 60_000)
afterAll(async () => { await state.db?.close() })

it('rewrites the stored Admin description to say team changes stay with the owner, and nothing else about the role', async () => {
  const before = await prisma.role.findUniqueOrThrow({ where: { key: 'ADMIN' } })
  const person = await prisma.userProfile.findUniqueOrThrow({ where: { id: personId }, select: { permissionsVersion: true } })
  expect(await seedSystemRoles()).toBe(Object.keys(SYSTEM_ROLES).length)
  const after = await prisma.role.findUniqueOrThrow({ where: { key: 'ADMIN' } })
  expect(after.description).toBe(SYSTEM_ROLES.ADMIN.description)
  expect(after.description).toBe('Full settings. Sees the team; inviting members and changing roles stay with the owner.')
  expect(after).toMatchObject({ id: before.id, name: 'Admin', isSystem: true, requireMfa: true })
  expect([...after.permissions].sort()).toEqual([...before.permissions].sort())
  // A text change re-resolves nobody's permissions.
  expect(await prisma.userProfile.findUniqueOrThrow({ where: { id: personId }, select: { permissionsVersion: true } })).toEqual(person)
})
