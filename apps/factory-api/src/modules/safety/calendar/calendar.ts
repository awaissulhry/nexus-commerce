import type { FactoryClient } from '@nexus/factory-db'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { can, holds, type Permission } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_CALENDAR_MANAGE } from '@nexus/factory-domain/safety/calendar/permissions'
import { addDays, calendarTiles, DUE_SOON_DAYS, itemStateOf, windowProblems } from '@nexus/factory-domain/safety/calendar/rules'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { userNames } from '../../people/employees/employees'
import { asked, officeOf, placeScope, problemsError, siteScope, todayOf } from '../organisation/access'
import { missingCount } from '../organisation/reads'
import type { CalendarItemOut } from './contract'
import { processSources } from './registry'
import type { CalendarWindow, SourceItem, SourceScope } from './source'

/**
 * The safety calendar's reads (B-W2b-120; QHS-227; design plant.calendar tiles and calendar), office only, safety.view:
 *
 *   GET /safety/calendar?from&to[&companyId&siteId]   every item of every source (./sources/*.ts) due in the window, with
 *                                                     its company and site, owner and state; a source that fails is
 *                                                     named in `failed` (never drawn as "nothing due")
 *   GET /safety/calendar/counts[?companyId&siteId]    the tiles: overdue, due within 30 days, safety roles without a
 *                                                     person, RLS notices pending
 *
 * The sources read with the caller's client inside the caller's reach (safety.view over companies and sites, the screen's
 * company, the asked narrowing): row-level security holds, and a site's reader sees the whole company's items too.
 */

/** The scope filters every source applies (./source.ts SourceScope). */
export function scopeFor(context: OfficeContext, window: Pick<CalendarWindow, 'companyId' | 'siteId'>): SourceScope {
  return {
    place: { AND: [placeScope(context, SAFETY_VIEW), asked(window)] },
    site: { AND: [siteScope(context, SAFETY_VIEW), asked(window, 'strict')] },
  }
}

/** Every source's items of the window (each source on its own: one that throws is named, the others still answer). */
export async function readItems(client: FactoryClient, context: OfficeContext, window: CalendarWindow): Promise<{ items: SourceItem[]; failed: string[] }> {
  const scope = scopeFor(context, window)
  const items: SourceItem[] = []
  const failed: string[] = []
  for (const source of processSources()) {
    try {
      items.push(...(await source.read(client, context, window, scope)))
    } catch {
      failed.push(source.kind)
    }
  }
  return { items, failed }
}

const holdsHere = (context: OfficeContext, permission: Permission): boolean => (context.companyId ? can(actorOf(context), permission, { companyId: context.companyId }) : holds(actorOf(context), permission))

/** The items as the screens read them: company and site words, owner names, states; by day, then kind, then key. */
export async function itemViews(client: FactoryClient, items: readonly SourceItem[], today: BusinessDate): Promise<CalendarItemOut[]> {
  const companies = new Map((await client.company.findMany({ where: { id: { in: [...new Set(items.map((item) => item.companyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, { code: row.code, name: row.legalName }]))
  const siteIds = [...new Set(items.flatMap((item) => (item.siteId ? [item.siteId] : [])))]
  const sites = new Map((await client.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, { code: row.code, name: row.name }]))
  const owners = await userNames(client, items.map((item) => item.ownerId))
  return items
    .map((item) => ({
      key: item.key,
      kind: item.kind,
      recordType: item.recordType,
      recordId: item.recordId,
      companyId: item.companyId,
      company: companies.get(item.companyId) ?? { code: '', name: '' },
      siteId: item.siteId,
      site: item.siteId ? (sites.get(item.siteId) ?? null) : null,
      dueOn: item.dueOn,
      state: itemStateOf(item, today),
      toConfirm: item.toConfirm ?? false,
      count: item.count,
      params: { ...item.params },
      ownerId: item.ownerId,
      owner: item.ownerId ? (owners.get(item.ownerId) ?? null) : null,
      evidence: item.evidence,
      law: item.law,
      source: item.source,
      editable: item.editable,
    }))
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key))
}

/** GET /safety/calendar. */
export async function readCalendar(caller: CommandCaller, query: { readonly from: BusinessDate; readonly to: BusinessDate; readonly late?: boolean | undefined; readonly companyId?: string | undefined; readonly siteId?: string | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const problems = windowProblems(query.from, query.to)
  if (problems.length > 0) throw problemsError(problems, problems[0]!.message)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const { items, failed } = await readItems(client, context, { from: query.from, to: query.to, openFrom: query.late ? addDays(today, -LATE_DAYS) : query.from, today, companyId: query.companyId, siteId: query.siteId })
    return { items: await itemViews(client, items, today), from: query.from, to: query.to, today, failed, canManage: holdsHere(context, SAFETY_CALENDAR_MANAGE), canUpload: holdsHere(context, FILES_UPLOAD) }
  })
}

/** How far back the tiles look for what is still late (ten years: anything older is a register's own problem). */
const LATE_DAYS = 3660

/** GET /safety/calendar/counts. */
export async function calendarCounts(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const { overdue, dueSoon, failed } = await caller.withClient(async (client) => {
    const from = addDays(today, -LATE_DAYS)
    const { items, failed } = await readItems(client, context, { from, to: addDays(today, DUE_SOON_DAYS), openFrom: from, today, companyId: query.companyId, siteId: query.siteId })
    return { ...calendarTiles(items.map((item) => ({ state: itemStateOf(item, today) }))), failed }
  })
  const rlsPending = await caller.withClient((client) =>
    client.rlsNotice.count({ where: { status: 'PENDING', ...(query.companyId ? { companyId: query.companyId } : {}), appointment: { AND: [placeScope(context, SAFETY_VIEW), asked(query)] } as never } }),
  )
  return { overdue, dueSoon, rolesWithoutPerson: await missingCount(caller, query, now), rlsPending, failed, today }
}
