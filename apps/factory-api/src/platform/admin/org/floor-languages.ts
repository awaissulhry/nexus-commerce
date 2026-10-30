import type { Prisma } from '@nexus/factory-db'
import { SITES_MANAGE, SITES_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { planFloorLanguages } from '@nexus/factory-domain/privacy/floor-languages'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import type { FloorLanguagesSiteView, SetFloorLanguagesBody } from './contract'

/**
 * The floor languages of the sites (B-W2a-41; PLT-128; design admin.languages "Floor languages"; GATE-PRIVACY):
 *
 *   GET /org/floor-languages                 every site the reader sees (sites.view) with the languages its tablets
 *                                            offer, the active workers per language (workers.view there), and the
 *                                            languages of its company's worker notice in force
 *   PUT /org/sites/:siteId/floor-languages   the site's languages after the change (sites.manage): an ADDED language
 *                                            needs the worker notice in force in it (its text or PDF), a REMOVED one
 *                                            no active worker who reads it (factory-domain privacy/floor-languages);
 *                                            one command on the Site (its version), audited from → to.
 *
 * The floor reads Site.floorLocales from its own Site row (Owner: the mechanism ships with Italian and English; each
 * new language needs the Owner's list, Q23, and the consultant's notice text).
 */

type Client = Prisma.TransactionClient
const WORKERS_VIEW = 'workers.view' satisfies Permission

const actorOfCaller = (caller: CommandCaller): Actor => {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return actorOf(caller.factoryContext)
}

const SITE = { id: true, companyId: true, code: true, name: true, status: true, floorLocales: true, version: true, company: { select: { code: true, legalName: true } } } as const satisfies Prisma.SiteSelect
type SiteRow = Prisma.SiteGetPayload<{ select: typeof SITE }>

/** The worker notice in force per company: its id, label and languages. */
async function noticesOf(client: Client, companyIds: readonly string[]): Promise<Map<string, { id: string; label: string; locales: string[] }>> {
  const out = new Map<string, { id: string; label: string; locales: string[] }>()
  if (companyIds.length === 0) return out
  const notices = await client.privacyNotice.findMany({
    where: { companyId: { in: [...new Set(companyIds)] }, kind: 'WORKER_FLOOR', status: 'PUBLISHED' },
    select: { id: true, companyId: true, label: true, texts: { select: { locale: true }, orderBy: { locale: 'asc' } } },
  })
  for (const notice of notices) out.set(notice.companyId, { id: notice.id, label: notice.label, locales: notice.texts.map((text) => text.locale) })
  return out
}

/** Active workers per language at each site (only the sites whose workers the reader may see). */
async function workersOf(client: Client, actor: Actor, sites: readonly SiteRow[]): Promise<Map<string, Record<string, number>>> {
  const seen = sites.filter((site) => can(actor, WORKERS_VIEW, { companyId: site.companyId, siteId: site.id }))
  const out = new Map<string, Record<string, number>>()
  if (seen.length === 0) return out
  for (const site of seen) out.set(site.id, {})
  const rows = await client.worker.groupBy({ by: ['siteId', 'locale'], where: { siteId: { in: seen.map((site) => site.id) }, status: 'ACTIVE' }, _count: { _all: true } })
  for (const row of rows) out.get(row.siteId)![row.locale] = row._count._all
  return out
}

function viewOf(site: SiteRow, actor: Actor, notices: Map<string, { id: string; label: string; locales: string[] }>, workers: Map<string, Record<string, number>>): FloorLanguagesSiteView {
  return {
    id: site.id,
    companyId: site.companyId,
    companyCode: site.company.code,
    companyName: site.company.legalName,
    code: site.code,
    name: site.name,
    status: site.status,
    locales: [...site.floorLocales],
    version: site.version,
    workers: workers.get(site.id) ?? null,
    notice: notices.get(site.companyId) ?? null,
    canManage: site.status === 'ACTIVE' && can(actor, SITES_MANAGE, { companyId: site.companyId, siteId: site.id }),
  }
}

/** GET /org/floor-languages. */
export async function listFloorLanguages(caller: CommandCaller, query: { companyId?: string | undefined; includeArchived?: boolean | undefined }): Promise<FloorLanguagesSiteView[]> {
  const actor = actorOfCaller(caller)
  const scope = scopeWhere(actor, SITES_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput
  return caller.withClient(async (client) => {
    const sites = await client.site.findMany({
      where: { AND: [scope, query.companyId ? { companyId: query.companyId } : {}, query.includeArchived ? {} : { status: 'ACTIVE' }] },
      select: SITE,
      orderBy: [{ company: { code: 'asc' } }, { code: 'asc' }],
      take: 500,
    })
    const notices = await noticesOf(client, sites.map((site) => site.companyId))
    const workers = await workersOf(client, actor, sites)
    return sites.map((site) => viewOf(site, actor, notices, workers))
  })
}

/** org.setFloorLanguages: the site's languages after the change, the rules of planFloorLanguages, one audit row. */
export async function setFloorLanguages(caller: CommandCaller, siteId: string, input: SetFloorLanguagesBody, idempotencyKey?: string): Promise<FloorLanguagesSiteView> {
  const actor = actorOfCaller(caller)
  const site = await caller.withClient(async (client) => {
    const found = isUuid(siteId) ? await client.site.findUnique({ where: { id: siteId }, select: SITE }) : null
    if (!found || !can(actor, SITES_VIEW, { companyId: found.companyId, siteId: found.id })) throw new NotFoundError('Site not found.')
    return found
  })
  if (!can(actor, SITES_MANAGE, { companyId: site.companyId, siteId: site.id })) throw new ForbiddenError()
  if (site.status !== 'ACTIVE') throw new DomainError('invalid_state', 'The site is archived.', [{ path: 'params/siteId', message: 'archived' }])
  const { result } = await command(
    caller,
    { name: 'org.setFloorLanguages', idempotencyKey, input: { siteId, ...input }, record: { type: 'Site', id: site.id, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      const current = await tx.site.findUniqueOrThrow({ where: { id: site.id }, select: SITE })
      const notice = (await noticesOf(tx, [current.companyId])).get(current.companyId) ?? null
      const counts = await tx.worker.groupBy({ by: ['locale'], where: { siteId: current.id, status: 'ACTIVE' }, _count: { _all: true } })
      const plan = planFloorLanguages(input.locales, {
        current: current.floorLocales,
        noticeLanguages: notice ? notice.locales : null,
        workersByLanguage: Object.fromEntries(counts.map((row) => [row.locale, row._count._all])),
      })
      if (plan.problems.length > 0) throw new DomainError('conflict', plan.problems[0]!.message, [...plan.problems])
      await tx.site.update({ where: { id: current.id }, data: { floorLocales: [...plan.locales] }, select: { id: true } })
      audit({
        recordType: 'Site',
        recordId: current.id,
        companyId: current.companyId,
        siteId: current.id,
        before: { floorLocales: current.floorLocales },
        after: { floorLocales: plan.locales, added: plan.added, removed: plan.removed, notice: notice ? notice.label : null },
        ...(input.reason ? { reason: input.reason } : {}),
      })
      const saved = await tx.site.findUniqueOrThrow({ where: { id: current.id }, select: SITE })
      return viewOf(saved, actor, new Map(notice ? [[saved.companyId, notice]] : []), await workersOf(tx, actor, [saved]))
    },
  )
  return result
}
