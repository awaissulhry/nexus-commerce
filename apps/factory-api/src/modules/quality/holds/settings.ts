import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_HOLDS_VIEW } from '@nexus/factory-domain/quality/holds/permissions'
import { isHoldRuleLoosening, placerMayReleaseInForce, type HoldSettingSource } from '@nexus/factory-domain/quality/holds/rules'
import { reasonProblem } from '@nexus/factory-domain/quality/final/rules'
import { QUALITY_SETTINGS_MANAGE } from '@nexus/factory-domain/quality/lab/permissions'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { ruleFor } from '../lab/read'
import { officeOf } from './holds'
import type { Reader } from './store'

/**
 * Who releases a hold, as a setting (B-W2b-17; design quality.settings qs-sod "A hold is released by someone other than
 * the person who placed it: on / off", qs-loosen; B-W2a-26 decision 1 made switchable). QualitySettings.placerMayRelease
 * (W2b schema wave 2): the company's row wins, else the tenant-wide row, else false. The release checks read it
 * (holds.ts releaseChecksFor); the database never held placer ≠ releaser (B-W2b-02 notes).
 *
 *   GET /quality/holds/settings?companyId   quality.holds.view over the company (tenant-wide: any grant)
 *   PUT /quality/holds/settings             quality.settings.manage over the company (tenant-wide: over every company),
 *                                           `version` = the row's version read (0: never saved). Letting the placer
 *                                           release (the looser rule) asks for the reason and the office's fresh code;
 *                                           the stricter rule never does. A new row keeps the Cr VI evidence rule in force.
 */

const COLUMNS = { id: true, placerMayRelease: true, version: true, updatedAt: true } as const

async function rowsOf(db: Reader, tenantId: string, companyId: string | null) {
  const rows = await db.qualitySettings.findMany({ where: { id: { in: companyId === null ? [tenantId] : [companyId, tenantId] } }, select: COLUMNS })
  return { company: companyId === null ? null : (rows.find((row) => row.id === companyId) ?? null), tenant: rows.find((row) => row.id === tenantId) ?? null }
}

/** The rule in force for a company's holds (the company's row, else the tenant-wide one, else false). */
export async function placerMayReleaseOf(db: Reader, companyId: string): Promise<{ placerMayRelease: boolean; source: HoldSettingSource }> {
  const tenant = await db.company.findUnique({ where: { id: companyId }, select: { tenantId: true } })
  if (!tenant) return { placerMayRelease: false, source: 'DEFAULT' }
  const rows = await rowsOf(db, tenant.tenantId, companyId)
  return placerMayReleaseInForce(rows.company?.placerMayRelease, rows.tenant?.placerMayRelease)
}

async function viewOf(db: Reader, tenantId: string, companyId: string | null) {
  const rows = await rowsOf(db, tenantId, companyId)
  const inForce = companyId === null ? placerMayReleaseInForce(null, rows.tenant?.placerMayRelease) : placerMayReleaseInForce(rows.company?.placerMayRelease, rows.tenant?.placerMayRelease)
  const own = companyId === null ? rows.tenant : rows.company
  return {
    companyId,
    inForce,
    own: own ? { placerMayRelease: own.placerMayRelease ?? null, updatedAt: toUtcIso(own.updatedAt) } : null,
    version: own?.version ?? 0,
  }
}
export type HoldSettingsView = Awaited<ReturnType<typeof viewOf>>

async function assertCompany(caller: CommandCaller, companyId: string): Promise<void> {
  const context = officeOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!row || !(can(actorOf(context), QUALITY_HOLDS_VIEW, { companyId }) || can(actorOf(context), QUALITY_SETTINGS_MANAGE, { companyId }))) throw new NotFoundError('Company not found.')
}

/** GET /quality/holds/settings */
export async function getHoldSettings(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const companyId = query.companyId ?? null
  if (companyId !== null) await assertCompany(caller, companyId)
  const settings = await caller.withClient((db) => viewOf(db, context.tenantId, companyId))
  return { settings, mayChange: mayWrite(actorOf(context), QUALITY_SETTINGS_MANAGE, companyId) }
}

export interface SaveHoldSettingsBody {
  readonly companyId?: string | null | undefined
  /** null: this row follows the tenant-wide rule (a company) or the default (tenant-wide). */
  readonly placerMayRelease: boolean | null
  readonly version: number
  readonly reason?: string | null | undefined
}

/** PUT /quality/holds/settings */
export async function saveHoldSettings(caller: CommandCaller, body: SaveHoldSettingsBody, options: { readonly stepUp: () => void | Promise<void>; readonly idempotencyKey?: string | undefined }) {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWrite(actorOf(context), QUALITY_SETTINGS_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? 'The tenant-wide hold rule is changed only by a role over every company.' : 'Changing who releases holds needs quality.settings.manage for the company.')
  }
  if (companyId !== null) await assertCompany(caller, companyId)
  const inForceAfter = async (db: Reader) => {
    const rows = await rowsOf(db, context.tenantId, companyId)
    const before = companyId === null ? placerMayReleaseInForce(null, rows.tenant?.placerMayRelease) : placerMayReleaseInForce(rows.company?.placerMayRelease, rows.tenant?.placerMayRelease)
    const after = companyId === null ? placerMayReleaseInForce(null, body.placerMayRelease) : placerMayReleaseInForce(body.placerMayRelease, rows.tenant?.placerMayRelease)
    return { before: before.placerMayRelease, after: after.placerMayRelease }
  }
  const planned = await caller.withClient(inForceAfter)
  const loosens = isHoldRuleLoosening(planned.before, planned.after)
  if (loosens) {
    const problem = reasonProblem(body.reason)
    if (problem) throw new ValidationError('Letting the person who placed a hold release it needs the reason.', [{ ...problem, path: 'body/reason' }])
    await options.stepUp()
  }
  const id = companyId ?? context.tenantId
  await command(caller, { name: 'quality.holdRule.save', idempotencyKey: options.idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const [locked] = await tx.$queryRaw<{ version: number; placerMayRelease: boolean | null }[]>`SELECT "version", "placerMayRelease" FROM "QualitySettings" WHERE "id" = ${id}::uuid FOR UPDATE`
    const version = locked?.version ?? 0
    if (version !== body.version) throw new StaleVersionError('QualitySettings', id, version, body.version)
    const now_ = await inForceAfter(tx)
    if (isHoldRuleLoosening(now_.before, now_.after) && !loosens) {
      throw new ValidationError('The rule in force changed: read it again, then let the placer release with the reason and a fresh code.', [{ path: 'body/version', message: 'Read the rule again.' }])
    }
    const previous = locked?.placerMayRelease ?? null
    if (locked) {
      await tx.qualitySettings.update({ where: { id }, data: { placerMayRelease: body.placerMayRelease, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    } else {
      // A new row keeps the Cr VI evidence rule in force as it is (a company's row would otherwise reset it to the default).
      const crVi = await ruleFor(tx, context.tenantId, companyId)
      await tx.qualitySettings
        .create({ data: { id, companyId, crViEvidenceRule: crVi.rule, placerMayRelease: body.placerMayRelease, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
        .catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('These quality settings were just saved by someone else: read them again.')
          throw error
        })
    }
    tools.audit({ recordType: 'QualitySettings', recordId: id, companyId, before: { placerMayRelease: previous }, after: { placerMayRelease: body.placerMayRelease }, ...(body.reason?.trim() ? { reason: body.reason.trim() } : {}) })
    tools.emit({ type: 'quality.hold_rule_changed', subject: id, companyId, payload: { companyId, placerMayRelease: body.placerMayRelease, previous, loosened: loosens } })
    return { id }
  })
  return { settings: await caller.withClient((db) => viewOf(db, context.tenantId, companyId)), loosened: loosens, mayChange: true }
}
