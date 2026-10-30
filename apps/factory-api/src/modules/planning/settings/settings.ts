import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { planBuckets } from '@nexus/factory-domain/planning/settings/buckets'
import { PLANNING_SETTINGS_MANAGE } from '@nexus/factory-domain/planning/settings/permissions'
import { changedSettings, efficiencyPctOf, settingsProblems, type PlanningSettingsValues } from '@nexus/factory-domain/planning/settings/settings'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf, siteFor } from '../access'
import { SITE_COLUMNS, type SiteRow } from '../store'
import type { EditSettingsBody } from './contract'
import { readSettings, SETTINGS_SELECT, settingsValuesOf, settingsViewOf, siteViewOf, storedAnswer, type SettingsRow } from './store'

/**
 * A site's planning settings (B-W2a-16; PLN-003; design planning.settings "Horizon & fences"): how far the plan looks
 * ahead and in which buckets, the default efficiency of a lane without its own (PLN-014) and the nightly run's time.
 * Read with planning.view, kept with planning.settings.manage over the site's company and the site. The row has the
 * site's own id; a site without one plans by the defaults. A change is ONE command on the row (its version bump locks
 * it; the first save makes it): audited before and after, and planning.settings_changed for the screens. The same
 * values again change nothing.
 */

const todayAt = (site: SiteRow) => businessDate(serverClock.now(), site.timezone)

function detailOf(site: SiteRow, row: SettingsRow | null) {
  const settings = settingsViewOf(row)
  return { site: siteViewOf(site), settings, horizon: planBuckets(settings, todayAt(site)) }
}

/** planning.view: every site the caller plans at, with its settings (the defaults when it has none). */
export async function listSettings(caller: CommandCaller, query: { companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const where: Prisma.SiteWhereInput = {
    AND: [scopeWhere(actorOf(context), PLANNING_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, { status: 'ACTIVE' }, query.companyId ? { companyId: query.companyId } : {}],
  }
  return caller.withClient(async (client) => {
    const sites = await client.site.findMany({ where, select: SITE_COLUMNS, orderBy: [{ companyId: 'asc' }, { code: 'asc' }] })
    const rows = await client.planningSettings.findMany({ where: { id: { in: sites.map((site) => site.id) } }, select: SETTINGS_SELECT })
    const byId = new Map(rows.map((row) => [row.id, row]))
    return { sites: sites.map((site) => ({ site: siteViewOf(site), settings: settingsViewOf(byId.get(site.id) ?? null) })) }
  })
}

/** planning.view: one site's settings and the plan's buckets from today. */
export async function getSettings(caller: CommandCaller, siteId: string) {
  const site = await siteFor(caller, siteId, PLANNING_VIEW)
  return caller.withClient(async (client) => detailOf(site, await readSettings(client, site.id)))
}

/** The settings after the change (the current ones, or the defaults, with the fields sent). */
function merged(current: PlanningSettingsValues, body: EditSettingsBody): PlanningSettingsValues {
  return {
    horizonWeeks: body.horizonWeeks ?? current.horizonWeeks,
    dayBucketWeeks: body.dayBucketWeeks ?? current.dayBucketWeeks,
    weekBucketWeeks: body.weekBucketWeeks ?? current.weekBucketWeeks,
    defaultEfficiencyPct: body.defaultEfficiencyPct === undefined ? current.defaultEfficiencyPct : (efficiencyPctOf(body.defaultEfficiencyPct) ?? body.defaultEfficiencyPct),
    scheduledRunTime: body.scheduledRunTime === undefined ? current.scheduledRunTime : body.scheduledRunTime === '' ? null : body.scheduledRunTime,
  }
}

/**
 * planning.settings.manage: changes the fields sent (the others stay). Buckets must fit the horizon (days ≤ weeks ≤
 * horizon); refused in words with the field (400). With a version: the one read (409 when it moved on).
 */
export async function editSettings(caller: CommandCaller, siteId: string, body: EditSettingsBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, siteId, PLANNING_SETTINGS_MANAGE)
  const existing = await caller.withClient((client) => readSettings(client, site.id))
  if (!existing && body.version !== undefined) throw new NotFoundError('This site has no planning settings yet; save them without a version.')
  const before = settingsValuesOf(existing)
  const after = merged(before, body)
  const problems = settingsProblems(after)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The planning settings cannot be saved this way.', problems)
  const changed = changedSettings(before, after)
  const input = { siteId: site.id, ...body }
  if (existing && changed.length === 0) {
    const replay = await storedAnswer<ReturnType<typeof detailOf> & { changed: string[] }>(caller, { name: 'planning.editSettings', idempotencyKey, input }, [undefined, { type: 'PlanningSettings', id: site.id, expectedVersion: body.version }])
    return replay ?? { ...detailOf(site, existing), changed: [] as string[] }
  }
  const { result } = await command(
    caller,
    {
      name: 'planning.editSettings',
      idempotencyKey,
      input,
      ...(existing ? { record: { type: 'PlanningSettings' as const, id: site.id, expectedVersion: body.version } } : {}),
    },
    async (tools) => {
      // The row is locked by the version bump (when it existed); a change made since the read is never overwritten.
      const current = existing ? await readSettings(tools.tx, site.id) : null
      const from = settingsValuesOf(current)
      const data = merged(from, body)
      if (current) {
        await tools.tx.planningSettings.update({ where: { id: site.id }, data, select: { id: true } })
      } else {
        const { count } = await tools.tx.planningSettings.createMany({ data: [{ id: site.id, companyId: site.companyId, siteId: site.id, ...data, createdById: context.actorId }], skipDuplicates: true })
        if (count !== 1) throw new ConflictError('The planning settings of this site were just saved by someone else; reload them and save again.')
      }
      const row = (await readSettings(tools.tx, site.id))!
      const fields = changedSettings(from, settingsValuesOf(row))
      tools.audit({ recordType: 'PlanningSettings', recordId: site.id, companyId: site.companyId, siteId: site.id, before: current ? from : null, after: settingsValuesOf(row) })
      tools.emit({ type: 'planning.settings_changed', subject: site.id, companyId: site.companyId, siteId: site.id, payload: { siteId: site.id, created: current === null, changed: fields } })
      return { ...detailOf(site, row), changed: fields as string[] }
    },
  )
  return result
}

