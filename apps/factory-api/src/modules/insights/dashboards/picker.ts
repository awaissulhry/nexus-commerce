import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { BOARDS, boardOf, boardsInOrder, mayReadKpi, ON_TIME_KPI, WIP_KPI, type Board, type BoardPanel } from '@nexus/factory-domain/insights/dashboards/boards'
import { HOME_KPIS_VIEW } from '@nexus/factory-domain/insights/kpis/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import type { Reader } from '../facts/rows'
import { officeContextOf } from '../viewer'

/**
 * Which dashboard (B-W2b-434; design home.dashboards `picker`, ANA-001, ANA-002): every ready dashboard, the person's own roles'
 * first, each with the panels the person may see (a panel they may not read is absent, never a locked box: design "noPermission:
 * Section absent"), and the scope's choices (the companies and sites the person reaches with the KPI library). Read only.
 */

export const dashboardActor = (caller: CommandCaller): Actor => actorOf(officeContextOf(caller))

/** The board, or 404 for a key that is not one (the contract's enum already refuses most). */
export function boardFor(key: string): Board {
  const found = boardOf(key)
  if (!found) throw new NotFoundError('Dashboard not found.')
  return found
}

/** The panels of a board this person may see. Needs action reads their Today; the charts need their KPIs' lists. */
export function panelsFor(actor: Actor, entry: Board, companies: number): BoardPanel[] {
  return entry.panels
    .map((spec) => spec.id)
    .filter((panel) => {
      switch (panel) {
        case 'numbers':
          return true
        case 'needs-action':
          return holds(actor, HOME_VIEW)
        case 'trends':
          return mayReadKpi(actor, ON_TIME_KPI)
        case 'wip':
          return mayReadKpi(actor, WIP_KPI)
        case 'by-company':
          return entry.group && companies > 0
      }
    })
}

/** The person's office roles in force now: their keys and the templates their custom roles were copied from. */
async function roleKeysOf(db: Reader, userId: string, now: Date): Promise<string[]> {
  const rows = await db.roleAssignment.findMany({
    where: { userId, endedAt: null, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    select: { roleId: true },
  })
  if (rows.length === 0) return []
  const roles = await db.role.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.roleId))] } }, select: { key: true, basedOn: true } })
  return [...new Set(roles.flatMap((role) => [role.key, ...(role.basedOn ? [role.basedOn] : [])]))]
}

export interface ScopeCompany {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly sites: readonly { readonly id: string; readonly code: string; readonly name: string }[]
}

/** The companies (with their active sites) the person reaches with the KPI library, by code. */
export async function scopeCompanies(db: Reader, actor: Actor): Promise<ScopeCompany[]> {
  const companies = await db.company.findMany({
    where: scopeWhere(actor, HOME_KPIS_VIEW, { company: 'id' }) as Prisma.CompanyWhereInput,
    select: { id: true, code: true, legalName: true, tradeName: true },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
  })
  if (companies.length === 0) return []
  const sites = await db.site.findMany({
    where: { AND: [scopeWhere(actor, HOME_KPIS_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, { companyId: { in: companies.map((company) => company.id) }, status: 'ACTIVE' }] },
    select: { id: true, companyId: true, code: true, name: true },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
  })
  return companies.map((company) => ({ id: company.id, code: company.code, name: company.tradeName ?? company.legalName, sites: sites.filter((site) => site.companyId === company.id).map(({ id, code, name }) => ({ id, code, name })) }))
}

export interface Scope {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
}

/** The scope asked, checked: a company the person reaches, a site of it (or of any company they reach) — else 404. */
export async function checkScope(caller: CommandCaller, actor: Actor, scope: Scope): Promise<{ companies: ScopeCompany[]; companyId?: string; siteId?: string }> {
  const companies = await caller.withClient((db) => scopeCompanies(db, actor))
  const company = scope.companyId ? companies.find((entry) => entry.id === scope.companyId) : undefined
  if (scope.companyId && !company) throw new NotFoundError('Company not found.')
  if (scope.siteId) {
    const owner = (company ? [company] : companies).find((entry) => entry.sites.some((site) => site.id === scope.siteId))
    if (!owner) throw new NotFoundError('Site not found.')
    return { companies, companyId: owner.id, siteId: scope.siteId }
  }
  return { companies, ...(company ? { companyId: company.id } : {}) }
}

/** GET /insights/dashboards: the picker (my role first) and the scope's choices. */
export async function dashboardsAnswer(caller: CommandCaller) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  const { roles, companies } = await caller.withClient(async (db) => ({ roles: await roleKeysOf(db, context.actorId, now), companies: await scopeCompanies(db, actor) }))
  return {
    asOf: toUtcIso(now),
    boards: boardsInOrder(roles).map((entry) => ({ key: entry.key, mine: entry.mine, panels: panelsFor(actor, BOARDS.find((board) => board.key === entry.key)!, companies.length) })),
    companies: companies.map((company) => ({ ...company, sites: [...company.sites] })),
  }
}
