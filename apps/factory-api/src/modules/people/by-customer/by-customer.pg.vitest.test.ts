import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { admin, call, ok, person, startWorld, stepped, type Person, type World } from '../../../golden-flow/testing/world'
import { factoryPeopleGivenTo } from './given'

/**
 * owb-of2 step 3 (order workflow, plan.md § 5f "People by customer", "Extra rights", § 5h): the pool of office people per customer and
 * the extra rights, on the golden world (../../../golden-flow/testing/world.ts: every base seed, the real app and sign-in — an extra
 * right passes today's role assignment, its step-up included). Written, not run (Owner rule). Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/people/by-customer`.
 *
 *   PB-1  Sales (no roles.assign) gets 403 on the read and on every write
 *   PB-2  a given row exists once per customer and person; taking out ends it (never deleted)
 *   PB-3  "Give to every customer" skips the customers already given; "Take out for every customer" ends them all
 *   PB-4  an extra right is a role assignment of the base's template: it shows in the person's role list, and ends again
 *   PB-5  the export: the names given to a customer, and under the partner role never another customer's
 */

vi.setConfig({ testTimeout: 300_000 })

let w: World
const P = {} as Record<'owner' | 'admin' | 'sales' | 'designer', Person>

beforeAll(async () => {
  w = await startWorld()
  for (const [key, role] of [['owner', 'owner'], ['admin', 'admin'], ['sales', 'sales'], ['designer', 'designer']] as const) P[key] = await person(w, key, role)
}, 1_200_000)

afterAll(async () => {
  await w?.close()
}, 60_000)

const P1 = () => w.id('party:P1')
const P3 = () => w.id('party:P3')
const openRows = async (partyId: string | null, userId: string) =>
  (await admin<{ n: number }>(w, `SELECT count(*)::int AS n FROM "PartyOfficePerson" WHERE "tenantId" = $1 AND "userId" = $2 AND "endedAt" IS NULL ${partyId ? 'AND "partyId" = $3' : ''}`, partyId ? [w.tenant.id, userId, partyId] : [w.tenant.id, userId]))[0]!.n

describe('PB-1 Sales may not', () => {
  it('403 on the read and every write', async () => {
    for (const [method, url, body] of [
      ['GET', '/people/by-customer', undefined],
      ['PUT', `/people/by-customer/${P1()}/${P.designer.id}`, { given: true }],
      ['POST', '/people/by-customer/every-customer', { userId: P.designer.id, given: true }],
      ['PUT', `/people/by-customer/extra/${P.designer.id}`, { right: 'ALLOW_PRODUCTION', on: true }],
    ] as const) {
      const answer = await call(P.sales.browser, method, url, body)
      expect(answer.status, `${method} ${url}`).toBe(403)
    }
    expect(await openRows(null, P.designer.id)).toBe(0)
  })
})

describe('PB-2 one given row per customer and person', () => {
  it('giving twice keeps one open row; taking out ends it and keeps the row', async () => {
    const given = await ok(P.admin, 'PUT', `/people/by-customer/${P1()}/${P.designer.id}`, { given: true })
    expect(given.given).toEqual(expect.arrayContaining([expect.objectContaining({ partyId: P1(), userId: P.designer.id, byName: expect.any(String) })]))
    await ok(P.admin, 'PUT', `/people/by-customer/${P1()}/${P.designer.id}`, { given: true })
    expect(await openRows(P1(), P.designer.id)).toBe(1)
    const read = await ok(P.admin, 'GET', '/people/by-customer')
    expect(read.may).toEqual({ write: true })
    expect((read.given as { partyId: string; userId: string }[]).filter((row) => row.partyId === P1() && row.userId === P.designer.id)).toHaveLength(1)
    expect((read.customers as { partyId: string }[]).map((row) => row.partyId)).toContain(P1())
    const out = await ok(P.admin, 'PUT', `/people/by-customer/${P1()}/${P.designer.id}`, { given: false })
    expect((out.given as { userId: string }[]).map((row) => row.userId)).not.toContain(P.designer.id)
    const rows = await admin<{ endedAt: Date | null; endedById: string | null }>(w, `SELECT "endedAt", "endedById" FROM "PartyOfficePerson" WHERE "tenantId" = $1 AND "partyId" = $2 AND "userId" = $3`, [w.tenant.id, P1(), P.designer.id])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.endedAt).not.toBeNull()
    expect(rows[0]!.endedById).toBe(P.admin.id)
    // Not an office person: refused in words.
    expect((await call(P.admin.browser, 'PUT', `/people/by-customer/${P1()}/${newId()}`, { given: true })).status).toBe(400)
  })
})

describe('PB-3 every customer', () => {
  it('gives the person to every customer, skipping the ones already given; takes them out of every one', async () => {
    await ok(P.admin, 'PUT', `/people/by-customer/${P1()}/${P.designer.id}`, { given: true })
    const every = await ok(P.admin, 'POST', '/people/by-customer/every-customer', { userId: P.designer.id, given: true })
    const customers = ((await ok(P.admin, 'GET', '/people/by-customer')).customers as { partyId: string }[]).map((row) => row.partyId)
    expect((every.given as { partyId: string }[]).map((row) => row.partyId).sort()).toEqual([...customers].sort())
    expect(await openRows(P1(), P.designer.id)).toBe(1)
    await ok(P.admin, 'POST', '/people/by-customer/every-customer', { userId: P.designer.id, given: false })
    expect(await openRows(null, P.designer.id)).toBe(0)
  })
})

describe('PB-4 an extra right is today\'s role assignment', () => {
  it('"Allow production" shows in the person\'s role list and ends again', async () => {
    await stepped(w, P.admin)
    const on = await ok(P.admin, 'PUT', `/people/by-customer/extra/${P.designer.id}`, { right: 'ALLOW_PRODUCTION', on: true })
    expect(on.person).toEqual({ userId: P.designer.id, extra: ['ALLOW_PRODUCTION'] })
    const assignments = (await ok(P.admin, 'GET', `/auth/users/${P.designer.id}/roles`)).assignments as { roleKey: string; live: boolean }[]
    expect(assignments.filter((row) => row.live).map((row) => row.roleKey)).toContain('extra_allow_production')
    const listed = ((await ok(P.admin, 'GET', '/people/by-customer')).people as { userId: string; extra: string[]; roleWords: string }[]).find((row) => row.userId === P.designer.id)!
    expect(listed.extra).toEqual(['ALLOW_PRODUCTION'])
    expect(listed.roleWords).not.toContain('Allow production')
    await stepped(w, P.admin)
    const off = await ok(P.admin, 'PUT', `/people/by-customer/extra/${P.designer.id}`, { right: 'ALLOW_PRODUCTION', on: false })
    expect(off.person.extra).toEqual([])
  })
})

describe('PB-5 the names a customer reads', () => {
  it('the export names only the people given to that customer; under another customer\'s partner role it names nobody', async () => {
    await ok(P.admin, 'PUT', `/people/by-customer/${P1()}/${P.designer.id}`, { given: true })
    const name = (await admin<{ displayName: string }>(w, 'SELECT "displayName" FROM "User" WHERE id = $1', [P.designer.id]))[0]!.displayName
    const office = await w.h.database.withScope({ audience: 'office', tenantId: w.tenant.id, actorId: P.admin.id }, (client) => factoryPeopleGivenTo(client, P1()))
    expect(office).toEqual([name])
    expect(await w.h.database.withScope({ audience: 'office', tenantId: w.tenant.id, actorId: P.admin.id }, (client) => factoryPeopleGivenTo(client, P3()))).toEqual([])
    const asOtherCustomer = await w.h.database.withScope({ audience: 'partner', tenantId: w.tenant.id, actorId: newId(), partyId: P3() }, (client) => factoryPeopleGivenTo(client, P1()))
    expect(asOtherCustomer).toEqual([])
  })
})
