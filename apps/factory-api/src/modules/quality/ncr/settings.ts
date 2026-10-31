import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_SETTINGS_MANAGE } from '@nexus/factory-domain/quality/lab/permissions'
import { QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import { containmentHoursInForce, containmentHoursProblem, type SettingSource } from '@nexus/factory-domain/quality/ncr/rules'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { ruleFor } from '../lab/read'
import { officeOf } from './ncr'
import type { Reader } from './store'

/**
 * The default containment time of new NCRs, as a setting (B-W2b-17; B-W2a-47 decision 3 made a setting:
 * QualitySettings.defaultContainmentHours, W2b schema wave 2): hours after the problem was found by which its containment
 * is due when the person says nothing. The company's row wins, else the tenant-wide row, else 24 (factory-domain
 * quality/ncr/rules containmentHoursInForce). Raising an NCR reads it (ncr.ts raiseNcrInCommand); the prefill answers it.
 *
 *   GET /quality/ncr/settings?companyId   quality.ncr.view over the company (tenant-wide: any grant)
 *   PUT /quality/ncr/settings             quality.settings.manage over the company (tenant-wide: over every company),
 *                                         `version` = the row's version read (0: never saved); 1 to 720 hours, or null
 *                                         (follow the tenant-wide row / the default). A new row keeps the Cr VI rule.
 */

const COLUMNS = { id: true, defaultContainmentHours: true, version: true, updatedAt: true } as const

async function rowsOf(db: Reader, tenantId: string, companyId: string | null) {
  const rows = await db.qualitySettings.findMany({ where: { id: { in: companyId === null ? [tenantId] : [companyId, tenantId] } }, select: COLUMNS })
  return { company: companyId === null ? null : (rows.find((row) => row.id === companyId) ?? null), tenant: rows.find((row) => row.id === tenantId) ?? null }
}

/** The containment time in force for a company's new NCRs. */
export async function containmentHoursOf(db: Reader, companyId: string): Promise<{ hours: number; source: SettingSource }> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { tenantId: true } })
  if (!company) return containmentHoursInForce(null, null)
  const rows = await rowsOf(db, company.tenantId, companyId)
  return containmentHoursInForce(rows.company?.defaultContainmentHours, rows.tenant?.defaultContainmentHours)
}

async function viewOf(db: Reader, tenantId: string, companyId: string | null) {
  const rows = await rowsOf(db, tenantId, companyId)
  const inForce = companyId === null ? containmentHoursInForce(null, rows.tenant?.defaultContainmentHours) : containmentHoursInForce(rows.company?.defaultContainmentHours, rows.tenant?.defaultContainmentHours)
  const own = companyId === null ? rows.tenant : rows.company
  return {
    companyId,
    inForce,
    own: own ? { defaultContainmentHours: own.defaultContainmentHours ?? null, updatedAt: toUtcIso(own.updatedAt) } : null,
    version: own?.version ?? 0,
  }
}

async function assertCompany(caller: CommandCaller, companyId: string): Promise<void> {
  const context = officeOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!row || !(can(actorOf(context), QUALITY_NCR_VIEW, { companyId }) || can(actorOf(context), QUALITY_SETTINGS_MANAGE, { companyId }))) throw new NotFoundError('Company not found.')
}

/** GET /quality/ncr/settings */
export async function getNcrSettings(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const companyId = query.companyId ?? null
  if (companyId !== null) await assertCompany(caller, companyId)
  return { settings: await caller.withClient((db) => viewOf(db, context.tenantId, companyId)), mayChange: mayWrite(actorOf(context), QUALITY_SETTINGS_MANAGE, companyId) }
}

export interface SaveNcrSettingsBody {
  readonly companyId?: string | null | undefined
  readonly defaultContainmentHours: number | null
  readonly version: number
}

/** PUT /quality/ncr/settings */
export async function saveNcrSettings(caller: CommandCaller, body: SaveNcrSettingsBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWrite(actorOf(context), QUALITY_SETTINGS_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? 'The tenant-wide containment time is changed only by a role over every company.' : 'Changing the containment time needs quality.settings.manage for the company.')
  }
  if (companyId !== null) await assertCompany(caller, companyId)
  const problem = containmentHoursProblem(body.defaultContainmentHours)
  if (problem) throw new ValidationError(problem.message, [problem])
  const id = companyId ?? context.tenantId
  await command(caller, { name: 'quality.ncrSettings.save', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const [locked] = await tx.$queryRaw<{ version: number; defaultContainmentHours: number | null }[]>`SELECT "version", "defaultContainmentHours" FROM "QualitySettings" WHERE "id" = ${id}::uuid FOR UPDATE`
    const version = locked?.version ?? 0
    if (version !== body.version) throw new StaleVersionError('QualitySettings', id, version, body.version)
    const previous = locked?.defaultContainmentHours ?? null
    if (locked) {
      await tx.qualitySettings.update({ where: { id }, data: { defaultContainmentHours: body.defaultContainmentHours, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    } else {
      const crVi = await ruleFor(tx, context.tenantId, companyId)
      await tx.qualitySettings
        .create({ data: { id, companyId, crViEvidenceRule: crVi.rule, defaultContainmentHours: body.defaultContainmentHours, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
        .catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('These quality settings were just saved by someone else: read them again.')
          throw error
        })
    }
    tools.audit({ recordType: 'QualitySettings', recordId: id, companyId, before: { defaultContainmentHours: previous }, after: { defaultContainmentHours: body.defaultContainmentHours } })
    tools.emit({ type: 'ncr.settings_changed', subject: id, companyId, payload: { companyId, defaultContainmentHours: body.defaultContainmentHours, previous } })
    return { id }
  })
  return { settings: await caller.withClient((db) => viewOf(db, context.tenantId, companyId)), mayChange: true }
}
