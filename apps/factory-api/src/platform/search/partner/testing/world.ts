import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect } from 'vitest'
import type { FactoryClient } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { seedUuid, type SeedContext } from '../../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../../core/command'
import { applySystemRoleChanges, systemRoleChanges } from '../../../auth/roles/system-roles'
import { usePortalOptions } from '../../../auth/portal/service'
import { mailedCode, portalBrowser } from '../../../auth/portal/testing/portal'
import type { Browser, Harness } from '../../../auth/sessions/testing/harness'
import { systemContext } from '../../../outbox/system'
import { rebuildIndex } from '../../indexing'
import { loadIndexers } from '../../registry'

/**
 * Test helpers for B-W2b-168's PostgreSQL tests (the portal's record threads and search; never imported by a route): the
 * base seeds (made-up records of every module) in a harness database under one namespace, the partner system roles
 * synced, the seeded partners' portals switched on, partner people with their roles, the search index built, and a portal
 * sign-in by e-mail code from the FAKE mailbox (with the first visit where the terms are due).
 */

const SEED_DIR = fileURLToPath(new URL('../../../../../../../packages/factory-db/seed/', import.meta.url))
const SRC = fileURLToPath(new URL('../../../..', import.meta.url))

export interface PartnerWorld {
  readonly namespace: string
  readonly tenantId: string
  readonly companyA: string
  readonly companyCode: string
  readonly p1: string
  readonly p2: string
  /** The office person of the seeds (the owner). */
  readonly officeId: string
  readonly people: {
    /** P1 (customer) buyer: customer-buyer + can comment (the seed's portal buyer). */
    readonly buyer: Person
    /** P1 viewer: customer-viewer, view only, no price; an address outside the party's contacts' domain. */
    readonly viewer: Person
    /** P2 (supplier) order desk: supplier-orders + can comment (the seed's). */
    readonly orders: Person
    /** P2 (workshop) jobs: subcontractor-jobs. */
    readonly workshop: Person
    /** P1 with only "can comment" (no main role). */
    readonly commentOnly: Person
  }
}

export interface Person {
  readonly id: string
  readonly email: string
  readonly name: string
}

export const inTenant = <T>(h: Harness, world: Pick<PartnerWorld, 'tenantId' | 'officeId'>, work: (client: FactoryClient) => Promise<T>): Promise<T> =>
  h.database.withScope({ audience: 'office', tenantId: world.tenantId, actorId: world.officeId }, work)

/** Seeds the namespace, syncs the system roles, switches the portals on, adds the people and builds the search index. */
export async function partnerWorld(h: Harness, namespace: string): Promise<PartnerWorld> {
  usePortalOptions({ answerFloorMs: 0 })
  const context: SeedContext = { db: h.database, namespace }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(`${SEED_DIR}${file}`).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
  const id = (key: string): string => seedUuid(namespace, key)
  const base = { namespace, tenantId: id('tenant'), companyA: id('company:A'), companyCode: 'SCA', p1: id('party:P1'), p2: id('party:P2'), officeId: id('actor') }
  const now = h.clock.now()
  const person = (key: string, email: string, name: string): Person => ({ id: key, email, name })
  const people = {
    buyer: person(id('portal:user:P1:buyer'), `buyer.portal.${namespace}@example.com`, 'Seed Portal Buyer'),
    viewer: person(newId(), `anna.viewer.${namespace}@studio-alpha.example`, 'Anna Viewer'),
    orders: person(id('portal:user:P2:orders'), `orders.portal.${namespace}@example.com`, 'Seed Portal Order Desk'),
    workshop: person(newId(), `jobs.${namespace}@workshop-beta.example`, 'Bruno Jobs'),
    commentOnly: person(newId(), `comment.${namespace}@studio-alpha.example`, 'Carla Comment'),
  }
  await inTenant(h, base, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now, actorId: base.officeId })
    await client.portalSettings.updateMany({ where: { partyId: { in: [base.p1, base.p2] } }, data: { portalOn: true } })
    for (const [who, partyId, kind] of [
      [people.viewer, base.p1, 'CUSTOMER'],
      [people.workshop, base.p2, 'SUBCONTRACTOR'],
      [people.commentOnly, base.p1, 'CUSTOMER'],
    ] as const) {
      await client.user.create({ data: { id: who.id, email: who.email, displayName: who.name, status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: kind, locale: 'en' }, select: { id: true } })
    }
    const roles = new Map((await client.role.findMany({ where: { audience: 'PARTNER' }, select: { id: true, key: true } })).map((role) => [role.key, role.id]))
    const give = async (who: Person, partyId: string, keys: readonly string[]) => {
      for (const key of keys) {
        const roleId = roles.get(key)
        if (!roleId) throw new Error(`no partner role ${key}`)
        await client.roleAssignment.create({ data: { id: newId(), userId: who.id, roleId, allCompanies: true, partyIds: [partyId], validFrom: new Date(now.getTime() - 60_000) }, select: { id: true } })
      }
    }
    await give(people.buyer, base.p1, ['customer-buyer', 'partner-comment'])
    await give(people.viewer, base.p1, ['customer-viewer'])
    await give(people.orders, base.p2, ['supplier-orders', 'partner-comment'])
    await give(people.workshop, base.p2, ['subcontractor-jobs'])
    await give(people.commentOnly, base.p1, ['partner-comment'])
  })
  // The search seed's sample entries are not the indexers': the index is built from the records, as the worker does.
  await h.db.admin.query('DELETE FROM "SearchEntry" WHERE "tenantId" = $1', [base.tenantId])
  const indexers = await loadIndexers(SRC)
  await rebuildIndex(callerFor(h.database, systemContext(base.tenantId, `pt-${namespace}`)), indexers, { recordTypes: null, key: `pt-rebuild-${newId()}` })
  return { ...base, people }
}

/** Signs a partner person in by e-mail code on the company's portal, and acknowledges the terms when they are due. */
export async function signIn(h: Harness, world: PartnerWorld, who: Person): Promise<Browser> {
  const browser = await portalBrowser(h)
  expect((await browser.post('/portal/signin/start', { tenant: world.namespace, company: world.companyCode, email: who.email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: world.namespace, company: world.companyCode, email: who.email, code: mailedCode(h, who.email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const me = await browser.get('/portal/me')
  expect(me.status, JSON.stringify(me.body)).toBe(200)
  if (me.body.termsDue) {
    const terms = await browser.get('/portal/terms?locale=en')
    expect(terms.status, JSON.stringify(terms.body)).toBe(200)
    const done = await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
  }
  return browser
}
