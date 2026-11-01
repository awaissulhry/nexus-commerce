import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  changedChecks,
  changedFields,
  DEFAULT_IDLE_MINUTES,
  FIXED_FLOOR_RULES,
  fixedFloorRulesWords,
  floorChecksOf,
  floorChecksWords,
  floorRulesChangeProblems,
  floorRulesChangeWords,
  idleSignOutWords,
  type FloorChecks,
  type FloorRuleMode,
  type LimitChange,
} from '@nexus/factory-domain/production/settings/floor-rules'
import { PRODUCTION_SETTINGS_MANAGE, PRODUCTION_SETTINGS_VIEW } from '@nexus/factory-domain/production/settings/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import type { SiteView } from './contract'
import { mayOn, siteOf } from './settings'

/**
 * A site's floor rules per site (B-W2b-53; MES-294; design production.settings "Floor rules per site" fr-rules): the floor
 * checks on the site's ProductionSettings row (B-W2b-12's columns), read and changed by the office
 * (production.settings.view | manage over the site's company and the site), read by the floor (its own site, in
 * GET /production/floor-rules) and by the modules that act on them (the readers below).
 *
 *   GET  /production/settings/:siteId/floor-rules    the checks with what they mean; the rules that are the same at every
 *                                                    site for now (undo window, tablet clock, offline); idle sign-out as
 *                                                    the tablets' settings keep it (FloorSettings, changed there)
 *   POST /production/settings/:siteId/floor-rules    ONE command on the site's row (made the first time with the other
 *                                                    defaults): the quantity guard, the sequence (skippedOperationRule),
 *                                                    the scrap approval limit; audited before → after (with the reason when
 *                                                    given); event production.floor_rules_changed; the same values again
 *                                                    change nothing
 *
 * The scrap limit's history is its audit rows (the change's before → after): scrap waits only above the limit in force
 * when the scan was taken (`scrapLimitHistory`, factory-domain limitAt). The bundle code mode and the stuck-bundle hours
 * are shown, never changed here (the bundles step's, B-W2b-41).
 */

export const FLOOR_RULES_ACTION = 'production.changeFloorRules'

const CHECKS_SELECT = { quantityGuard: true, skippedOperationRule: true, scrapApprovalLimit: true, bundleCodeMode: true, stuckBundleHours: true } as const satisfies Prisma.ProductionSettingsSelect
const ROW_SELECT = { ...CHECKS_SELECT, id: true, version: true, updatedAt: true } as const satisfies Prisma.ProductionSettingsSelect
type Row = Prisma.ProductionSettingsGetPayload<{ select: typeof ROW_SELECT }>

const readRow = (db: Pick<CommandTx, 'productionSettings'>, siteId: string): Promise<Row | null> => db.productionSettings.findUnique({ where: { id: siteId }, select: ROW_SELECT })

/**
 * The site's floor checks (its row's, or the schema's defaults for a site without one), for the modules that act on them:
 * the checks before a scan counts (B-W2b-46: quantityGuard, skippedOperationRule), the bundles (B-W2b-41: bundleCodeMode,
 * stuckBundleHours) and scrap above the limit (scrapApprovalLimit). Office or floor scope, inside a command or on a
 * request's client: the floor role may read these columns of its own site's row (never the legal basis).
 */
export async function floorChecksFor(db: Pick<CommandTx, 'productionSettings'>, siteId: string): Promise<FloorChecks> {
  return floorChecksOf(await db.productionSettings.findUnique({ where: { id: siteId }, select: CHECKS_SELECT }))
}

/** What the audit rows keep of the checks. */
const audited = (checks: FloorChecks) => ({ quantityGuard: checks.quantityGuard, skippedOperationRule: checks.skippedOperationRule, scrapApprovalLimit: checks.scrapApprovalLimit })

const limitIn = (value: Prisma.JsonValue | null): number | null | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('scrapApprovalLimit' in value)) return undefined
  const limit = (value as { scrapApprovalLimit?: unknown }).scrapApprovalLimit
  return typeof limit === 'number' ? limit : limit === null ? null : undefined
}

/**
 * Each site's changes of the scrap limit, from the audit rows of this step's command (office or the tenant's system scope:
 * the floor role reads no audit row). A site whose limit was never changed has none (its limit now applies to every scan).
 */
export async function scrapLimitHistory(db: Pick<CommandTx, 'auditLog'>, siteIds: readonly string[]): Promise<Map<string, LimitChange[]>> {
  const history = new Map<string, LimitChange[]>()
  if (siteIds.length === 0) return history
  const rows = await db.auditLog.findMany({
    where: { recordType: 'ProductionSettings', recordId: { in: [...new Set(siteIds)] }, action: FLOOR_RULES_ACTION },
    select: { recordId: true, at: true, before: true, after: true },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
  })
  for (const row of rows) {
    const before = limitIn(row.before)
    const after = limitIn(row.after)
    if (after === undefined || (before ?? null) === after) continue
    history.set(row.recordId, [...(history.get(row.recordId) ?? []), { at: row.at, before: before ?? null, after }])
  }
  return history
}

async function idleOf(db: Pick<CommandTx, 'floorSettings'>, siteId: string) {
  const row = await db.floorSettings.findUnique({ where: { id: siteId }, select: { idleMinutes: true, shiftEnds: true, badgeOnlySignIn: true } })
  const idleMinutes = row?.idleMinutes ?? DEFAULT_IDLE_MINUTES
  return { idleMinutes, shiftEnds: row?.shiftEnds ?? [], badgeOnlySignIn: row?.badgeOnlySignIn ?? false, isDefault: row === null, words: idleSignOutWords(idleMinutes) }
}

async function viewOf(db: Pick<CommandTx, 'floorSettings'>, site: SiteView, row: Row | null, canManage: boolean) {
  const checks = floorChecksOf(row)
  return {
    site,
    checks: { ...checks },
    isDefault: row === null,
    words: floorChecksWords(checks),
    fixed: { ...FIXED_FLOOR_RULES, onlineOnly: [...FIXED_FLOOR_RULES.onlineOnly], words: fixedFloorRulesWords() },
    idleSignOut: await idleOf(db, site.id),
    version: row?.version ?? null,
    updatedAt: row ? toUtcIso(row.updatedAt) : null,
    canManage,
  }
}

/** production.settings.view: one site's floor rules, what they mean, and the rules that are not per site yet. */
export async function getFloorRules(caller: CommandCaller, siteId: string) {
  const { context, site } = await siteOf(caller, siteId, PRODUCTION_SETTINGS_VIEW)
  return caller.withClient(async (client) => viewOf(client, site, await readRow(client, site.id), mayOn(context, PRODUCTION_SETTINGS_MANAGE, site)))
}

export interface ChangeFloorRulesInput {
  readonly quantityGuard?: FloorRuleMode | undefined
  readonly skippedOperationRule?: FloorRuleMode | undefined
  readonly scrapApprovalLimit?: number | null | undefined
  readonly reason?: string | null | undefined
  readonly version?: number | undefined
}

/**
 * production.settings.manage: the site's floor checks from now on. ONE command on the site's row (made the first time
 * with the other defaults: floor records still name workers, bundles of 10), at the version read; the same values again
 * change nothing (no row, no audit, no event).
 */
export async function changeFloorRules(caller: CommandCaller, siteId: string, body: ChangeFloorRulesInput, idempotencyKey?: string) {
  const { context, site } = await siteOf(caller, siteId, PRODUCTION_SETTINGS_MANAGE)
  const problems = floorRulesChangeProblems(body)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The floor rules are not valid.', problems)
  const existing = await caller.withClient((client) => readRow(client, site.id))
  if (!existing && body.version !== undefined) throw new NotFoundError('This site has no floor rules yet; apply without a version.')
  const wanted = changedChecks(floorChecksOf(existing), body)
  const reason = body.reason?.trim() || null
  if (changedFields(floorChecksOf(existing), wanted).length === 0) {
    const view = await caller.withClient(async (client) => viewOf(client, site, existing, true))
    return { ...view, changed: false, changedFields: [], changeWords: [] }
  }
  const { result } = await command(
    caller,
    {
      name: FLOOR_RULES_ACTION,
      idempotencyKey,
      input: { siteId: site.id, ...body },
      ...(existing ? { record: { type: 'ProductionSettings' as const, id: site.id, expectedVersion: body.version } } : {}),
    },
    async (tools) => {
      // The row is locked by the version bump (when it existed); a change made since the read is never overwritten.
      const beforeRow = existing ? await readRow(tools.tx, site.id) : null
      const before = floorChecksOf(beforeRow)
      const after = changedChecks(before, body)
      const data = { quantityGuard: after.quantityGuard, skippedOperationRule: after.skippedOperationRule, scrapApprovalLimit: after.scrapApprovalLimit }
      if (beforeRow) {
        await tools.tx.productionSettings.update({ where: { id: site.id }, data, select: { id: true } })
      } else {
        const { count } = await tools.tx.productionSettings.createMany({ data: [{ id: site.id, companyId: site.companyId, siteId: site.id, ...data, createdById: context.actorId }], skipDuplicates: true })
        if (count !== 1) throw new ConflictError('The floor rules of this site were just saved by someone else; reload them and apply again.')
      }
      const fields = changedFields(before, after)
      tools.audit({ action: FLOOR_RULES_ACTION, recordType: 'ProductionSettings', recordId: site.id, companyId: site.companyId, siteId: site.id, before: audited(before), after: audited(after), ...(reason ? { reason } : {}) })
      tools.emit({
        type: 'production.floor_rules_changed',
        subject: site.id,
        companyId: site.companyId,
        siteId: site.id,
        payload: { siteId: site.id, fields, quantityGuard: after.quantityGuard, skippedOperationRule: after.skippedOperationRule, scrapApprovalLimit: after.scrapApprovalLimit },
      })
      const view = await viewOf(tools.tx, site, await readRow(tools.tx, site.id), true)
      return { ...view, changed: true, changedFields: fields, changeWords: floorRulesChangeWords(before, after) }
    },
  )
  return result
}

/**
 * floor.work, for the floor's read (GET /production/floor-rules, beside its scan subject and bundle size): the device's own
 * site's checks a tablet shows or acts on (the scrap limit is a count: no money on the floor), and the undo window.
 */
export async function floorChecksRead(caller: CommandCaller) {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'floor') throw new ForbiddenError()
  const checks = await caller.withClient((client) => floorChecksFor(client, context.siteId))
  return {
    checks: { quantityGuard: checks.quantityGuard, skippedOperationRule: checks.skippedOperationRule, scrapApprovalLimit: checks.scrapApprovalLimit, bundleCodeMode: checks.bundleCodeMode },
    undoWindowSeconds: FIXED_FLOOR_RULES.undoWindowSeconds,
  }
}
