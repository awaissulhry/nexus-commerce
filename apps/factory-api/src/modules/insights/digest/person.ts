import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { heldRoles } from '../../../platform/auth/roles/access'

/**
 * A person as the scheduler reads for them (B-W2b-435): their LIVE office roles now (two-factor taken as proved, as the export
 * worker and the followed views read: the mail goes to their own address), a caller with their office context over the
 * system's client, so the modules' own reads apply their scopes and grains exactly as on their screens. Shared by the morning
 * e-mail and the report e-mails.
 */

type Reader = FactoryClient | CommandTx

export interface Person {
  readonly actor: Actor
  readonly caller: CommandCaller
}

/** The person's actor and caller (a person whose roles all lapsed has no grants: every section is left out). */
export async function personOf(system: CommandCaller, tenantId: string, user: { readonly id: string; readonly requireMfa: boolean }, now: Date, requestId: string, companyId: string | null = null): Promise<Person> {
  const held = await system.withClient((client) => heldRoles(client, user.id, now))
  const grants = sessionGrants({ requireMfa: user.requireMfa }, held, true)
  const actor: Actor = { audience: 'office', tenantId, grants }
  const context: OfficeContext = Object.freeze({ audience: 'office', tenantId, actorId: user.id, ...(companyId ? { companyId } : {}), grants, requestId })
  return { actor, caller: { factoryContext: context, withClient: (work) => system.withClient(work) } }
}

export interface ReachedCompany {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly timezone: string
  /** The zone of its first active site by code (the "site time" of its morning e-mail), else the company's. */
  readonly siteZone: string
}

/** The active companies a person reaches (home.view's scope: where their Today and their digest look), by code. */
export async function companiesReached(db: Reader, actor: Actor): Promise<ReachedCompany[]> {
  const rows = await db.company.findMany({
    where: { AND: [{ status: 'ACTIVE' }, scopeWhere(actor, HOME_VIEW, { company: 'id' }) as Prisma.CompanyWhereInput] },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
    select: { id: true, code: true, legalName: true, tradeName: true, timezone: true, sites: { where: { status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: 1, select: { timezone: true } } },
  })
  return rows.map((row) => ({ id: row.id, code: row.code, name: row.tradeName ?? row.legalName, timezone: row.timezone, siteZone: row.sites[0]?.timezone ?? row.timezone }))
}
