import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { BundleCodeMode } from '@nexus/factory-domain/production/bundles/coupons'
import { DEFAULT_STUCK_BUNDLE_HOURS, stuckLimitProblems } from '@nexus/factory-domain/production/bundles/where'
import { PRODUCTION_SETTINGS_MANAGE, PRODUCTION_SETTINGS_VIEW } from '@nexus/factory-domain/production/settings/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * A site's bundle rules (B-W2b-41; MES-067, MES-168; design production.settings "Bundle codes"): one bundle code scanned
 * at every operation, or a coupon per operation (ProductionSettings.bundleCodeMode), and the working hours after which
 * a bundle with no scan is stuck (stuckBundleHours, 1-720). Office only: production.settings.view reads,
 * production.settings.manage changes (the floor rules' own permissions; the floor reads the mode through the bundles
 * step's answers). ONE command on the site's row (made the first time with the other defaults), with the row's version
 * as the edit guard, audited before and after, and the event production.bundle_rules_changed; the same values again
 * change nothing. Bundles and coupons already printed keep theirs: switching back to one code leaves the coupons valid
 * until they are scanned or voided.
 */

const SITE_SELECT = { id: true, companyId: true, code: true, name: true } as const
const RULES_SELECT = { id: true, bundleCodeMode: true, stuckBundleHours: true, version: true, updatedAt: true } as const

function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

async function siteOf(caller: CommandCaller, siteId: string, permission: Permission) {
  const context = officeOf(caller)
  const site = isUuid(siteId) ? await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: SITE_SELECT })) : null
  const may = (name: Permission) => !!site && can(actorOf(context), name, { companyId: site.companyId, siteId: site.id })
  if (!site || !may(PRODUCTION_SETTINGS_VIEW)) throw new NotFoundError('Site not found.')
  if (!may(permission)) throw new ForbiddenError()
  return { context, site }
}

const readRow = (db: Pick<CommandTx, 'productionSettings'>, siteId: string) => db.productionSettings.findUnique({ where: { id: siteId }, select: RULES_SELECT })

function viewOf(site: { id: string; code: string; name: string }, row: Awaited<ReturnType<typeof readRow>>) {
  return {
    site: { id: site.id, code: site.code, name: site.name },
    bundleCodeMode: (row?.bundleCodeMode ?? 'ONE_CODE') as BundleCodeMode,
    stuckBundleHours: row?.stuckBundleHours ?? DEFAULT_STUCK_BUNDLE_HOURS,
    /** The row's version (the edit guard); null: the site has no floor rules yet (the defaults apply). */
    version: row?.version ?? null,
    updatedAt: row ? toUtcIso(row.updatedAt) : null,
  }
}

/** production.settings.view: the site's bundle code mode and stuck limit. */
export async function bundleRules(caller: CommandCaller, siteId: string) {
  const { site } = await siteOf(caller, siteId, PRODUCTION_SETTINGS_VIEW)
  return caller.withClient(async (client) => ({ ...viewOf(site, await readRow(client, site.id)), changed: false }))
}

export interface BundleRulesInput {
  readonly bundleCodeMode?: BundleCodeMode | undefined
  readonly stuckBundleHours?: number | undefined
  readonly version?: number | undefined
}

/** production.settings.manage: change the site's bundle code mode and/or stuck limit. */
export async function changeBundleRules(caller: CommandCaller, siteId: string, body: BundleRulesInput, idempotencyKey?: string) {
  const { context, site } = await siteOf(caller, siteId, PRODUCTION_SETTINGS_MANAGE)
  if (body.bundleCodeMode === undefined && body.stuckBundleHours === undefined) throw new ValidationError('Name the bundle code mode, the stuck limit, or both.', [{ path: 'body', message: 'Nothing to change.' }])
  const problems = body.stuckBundleHours === undefined ? [] : stuckLimitProblems(body.stuckBundleHours)
  if (problems.length > 0) throw new ValidationError(problems[0]!, problems.map((message) => ({ path: 'body/stuckBundleHours', message })))
  const existing = await caller.withClient((client) => readRow(client, site.id))
  if (!existing && body.version !== undefined) throw new NotFoundError('This site has no floor rules yet; apply without a version.')
  const before = viewOf(site, existing)
  const wanted = { bundleCodeMode: body.bundleCodeMode ?? before.bundleCodeMode, stuckBundleHours: body.stuckBundleHours ?? before.stuckBundleHours }
  if (wanted.bundleCodeMode === before.bundleCodeMode && wanted.stuckBundleHours === before.stuckBundleHours) return { ...before, changed: false }
  const { result } = await command(
    caller,
    { name: 'production.changeBundleRules', idempotencyKey, input: { siteId: site.id, ...body }, ...(existing ? { record: { type: 'ProductionSettings' as const, id: site.id, expectedVersion: body.version } } : {}) },
    async (tools) => {
      if (existing) {
        await tools.tx.productionSettings.update({ where: { id: site.id }, data: wanted, select: { id: true } })
      } else {
        const { count } = await tools.tx.productionSettings.createMany({ data: [{ id: site.id, companyId: site.companyId, siteId: site.id, ...wanted, createdById: context.actorId }], skipDuplicates: true })
        if (count !== 1) throw new ConflictError('The floor rules of this site were just saved by someone else; reload them and apply again.')
      }
      const after = viewOf(site, await readRow(tools.tx, site.id))
      tools.audit({
        recordType: 'ProductionSettings',
        recordId: site.id,
        companyId: site.companyId,
        siteId: site.id,
        before: { bundleCodeMode: before.bundleCodeMode, stuckBundleHours: before.stuckBundleHours },
        after: { bundleCodeMode: after.bundleCodeMode, stuckBundleHours: after.stuckBundleHours },
      })
      tools.emit({ type: 'production.bundle_rules_changed', subject: site.id, companyId: site.companyId, siteId: site.id, payload: { siteId: site.id, bundleCodeMode: after.bundleCodeMode, stuckBundleHours: after.stuckBundleHours } })
      return { ...after, changed: true }
    },
  )
  return result
}
