import { z } from 'zod'
import type { Prisma } from '@nexus/factory-db'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { AREA_UOMS } from '@nexus/factory-domain/inventory/hides/area'
import { SHADE_RULES } from '@nexus/factory-domain/inventory/reservations/shade'
import {
  changedCuttingFields,
  changedCuttingRules,
  CUTTING_REASON_MAX,
  CUTTING_RULE_FIELDS,
  cuttingRulesChangeProblems,
  cuttingRulesOf,
  cuttingRulesWords,
  type CuttingRules,
} from '@nexus/factory-domain/production/settings/cutting-rules'
import { PRODUCTION_SETTINGS_MANAGE, PRODUCTION_SETTINGS_VIEW } from '@nexus/factory-domain/production/settings/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import type { SiteView } from './contract'
import { mayOn, siteOf } from './settings'

/**
 * A site's cutting rules (B-W2b-219; Production › Floor rules & codes, the Cutting card; the follow-ups of B-W2b-100, -103,
 * -132 on B-W2b-204's ProductionSettings columns; factory-domain production/settings/cutting-rules):
 *
 *   GET  /production/settings/:siteId/cutting-rules   production.settings.view: the shade rule, the photo before cutting
 *                                                      and the smallest remnant kept, in words, with the version
 *   POST /production/settings/:siteId/cutting-rules   production.settings.manage: ONE command on the site's row (made the
 *                                                      first time with the other defaults) at the version read; audited
 *                                                      before → after (with the reason when given); event
 *                                                      production.cutting_rules_changed; the same values change nothing
 *
 * The readers (`cuttingRulesFor`, office or floor scope: the floor role reads these columns of its own site's row) are the
 * shade rule (inventory/reservations/shade shadeRuleFor), the photo before Cut (production/cutting/photo) and the remnant
 * size (inventory/remnants/size). The row's version is shared with the other floor rules of the site (one row).
 */

export const CUTTING_RULES_ACTION = 'production.changeCuttingRules'

const RULES_SELECT = { shadeRule: true, hidePhotoRequired: true, minimumRemnantArea: true, minimumRemnantUom: true } as const satisfies Prisma.ProductionSettingsSelect
const ROW_SELECT = { ...RULES_SELECT, id: true, version: true, updatedAt: true } as const satisfies Prisma.ProductionSettingsSelect
type Row = Prisma.ProductionSettingsGetPayload<{ select: typeof ROW_SELECT }>

const readRow = (db: Pick<CommandTx, 'productionSettings'>, siteId: string): Promise<Row | null> => db.productionSettings.findUnique({ where: { id: siteId }, select: ROW_SELECT })

/** A site's cutting rules (its row's, or the defaults), and whether it runs on the defaults. Office or floor scope. */
export async function cuttingRulesFor(db: Pick<CommandTx, 'productionSettings'>, siteId: string): Promise<{ readonly rules: CuttingRules; readonly isDefault: boolean }> {
  const row = await db.productionSettings.findUnique({ where: { id: siteId }, select: RULES_SELECT })
  return { rules: cuttingRulesOf(row), isDefault: row === null }
}

/**
 * A guard of the database (a check_violation, SQLSTATE 23514) in words, for a write that reached it past the command's own
 * check: a 409 with the guard's sentence (its "production: " / "purchasing: " prefix dropped), never a 500. Else the error.
 */
export function databaseRefusal(error: unknown): unknown {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (cause?.originalCode !== '23514' || typeof cause.originalMessage !== 'string') return error
  if (cause.originalMessage.startsWith('period lock')) return error
  const text = cause.originalMessage.replace(/^[a-z-]+: /, '')
  return new ConflictError(`${text.charAt(0).toUpperCase()}${text.slice(1)}.`)
}

/** Runs `work`; a database guard's refusal comes back in its words (databaseRefusal). */
export async function inWords<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw databaseRefusal(error)
  }
}

const rulesOut = (rules: CuttingRules) => ({ shadeRule: rules.shadeRule, hidePhotoRequired: rules.hidePhotoRequired, minimumRemnant: { area: rules.minimumRemnant.area, uom: rules.minimumRemnant.uom } })

function viewOf(site: SiteView, row: Row | null, canManage: boolean) {
  const rules = cuttingRulesOf(row)
  return { site, rules: rulesOut(rules), isDefault: row === null, words: cuttingRulesWords(rules), version: row?.version ?? null, updatedAt: row ? toUtcIso(row.updatedAt) : null, canManage }
}

// ---- contracts ------------------------------------------------------------------------------------------------------------------

const rulesView = output({
  /** ORDER (the default): one shade lot per order · GARMENT: per garment, checked at the table · OFF: no check. */
  shadeRule: z.enum(SHADE_RULES),
  /** The hide check asks a photo of the hide on the table before its first cut. */
  hidePhotoRequired: z.boolean(),
  /** A leftover smaller than this is waste, not a remnant (four places). */
  minimumRemnant: output({ area: z.string(), uom: z.enum(AREA_UOMS) }),
})

const cuttingRulesView = {
  site: output({ id: id(), companyId: id(), code: z.string(), name: z.string() }),
  rules: rulesView,
  /** true: the site has no floor rules yet and runs on the defaults. */
  isDefault: z.boolean(),
  /** The shade rule, the photo and the smallest remnant in words, in that order. */
  words: z.array(z.string()),
  /** The site's floor rules version (one row with the other floor rules); null while it has none. */
  version: z.number().int().nullable(),
  updatedAt: instant().nullable(),
  /** The caller holds production.settings.manage over the site. */
  canManage: z.boolean(),
}

export const getCuttingRulesContract = defineContract({
  params: input({ siteId: id() }),
  response: { 200: output(cuttingRulesView) },
})

export const changeCuttingRulesContract = defineContract({
  params: input({ siteId: id() }),
  body: input({
    shadeRule: z.enum(SHADE_RULES).optional(),
    hidePhotoRequired: z.boolean().optional(),
    /** Above 0, at most 10 m² in its unit, four decimals; with its unit. */
    minimumRemnantArea: z.string().max(16).optional(),
    minimumRemnantUom: z.enum(AREA_UOMS).optional(),
    /** Kept in the audit row. */
    reason: z.string().max(CUTTING_REASON_MAX).nullish(),
    /** The version read; left out while the site has no floor rules. */
    version: z.number().int().min(1).optional(),
  }),
  response: {
    200: output({
      ...cuttingRulesView,
      /** false: nothing changed (no audit row, no event). */
      changed: z.boolean(),
      changedFields: z.array(z.enum(CUTTING_RULE_FIELDS)),
    }),
  },
})

// ---- handlers -------------------------------------------------------------------------------------------------------------------

/** production.settings.view: one site's cutting rules. */
export async function getCuttingRules(caller: CommandCaller, siteId: string) {
  const { context, site } = await siteOf(caller, siteId, PRODUCTION_SETTINGS_VIEW)
  return caller.withClient(async (client) => viewOf(site, await readRow(client, site.id), mayOn(context, PRODUCTION_SETTINGS_MANAGE, site)))
}

export interface ChangeCuttingRulesInput {
  readonly shadeRule?: CuttingRules['shadeRule'] | undefined
  readonly hidePhotoRequired?: boolean | undefined
  readonly minimumRemnantArea?: string | undefined
  readonly minimumRemnantUom?: CuttingRules['minimumRemnant']['uom'] | undefined
  readonly reason?: string | null | undefined
  readonly version?: number | undefined
}

/**
 * production.settings.manage: the site's cutting rules from now on. ONE command on the site's row (made the first time with
 * the other defaults), at the version read; the same values again change nothing (no row, no audit, no event).
 */
export async function changeCuttingRules(caller: CommandCaller, siteId: string, body: ChangeCuttingRulesInput, idempotencyKey?: string) {
  const { context, site } = await siteOf(caller, siteId, PRODUCTION_SETTINGS_MANAGE)
  const problems = cuttingRulesChangeProblems(body)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The cutting rules are not valid.', problems)
  const existing = await caller.withClient((client) => readRow(client, site.id))
  if (!existing && body.version !== undefined) throw new NotFoundError('This site has no floor rules yet; apply without a version.')
  const reason = body.reason?.trim() || null
  if (changedCuttingFields(cuttingRulesOf(existing), changedCuttingRules(cuttingRulesOf(existing), body)).length === 0) {
    return { ...viewOf(site, existing, true), changed: false, changedFields: [] }
  }
  const { result } = await inWords(() =>
    command(
      caller,
      {
        name: CUTTING_RULES_ACTION,
        idempotencyKey,
        input: { siteId: site.id, ...body },
        ...(existing ? { record: { type: 'ProductionSettings' as const, id: site.id, expectedVersion: body.version } } : {}),
      },
      async (tools) => {
        // The row is locked by the version bump (when it existed); a change made since the read is never overwritten.
        const beforeRow = existing ? await readRow(tools.tx, site.id) : null
        const before = cuttingRulesOf(beforeRow)
        const after = changedCuttingRules(before, body)
        const data = { shadeRule: after.shadeRule, hidePhotoRequired: after.hidePhotoRequired, minimumRemnantArea: after.minimumRemnant.area, minimumRemnantUom: after.minimumRemnant.uom }
        if (beforeRow) {
          await tools.tx.productionSettings.update({ where: { id: site.id }, data, select: { id: true } })
        } else {
          const { count } = await tools.tx.productionSettings.createMany({ data: [{ id: site.id, companyId: site.companyId, siteId: site.id, ...data, createdById: context.actorId }], skipDuplicates: true })
          if (count !== 1) throw new ConflictError('The floor rules of this site were just saved by someone else; reload them and apply again.')
        }
        const fields = changedCuttingFields(before, after)
        tools.audit({ action: CUTTING_RULES_ACTION, recordType: 'ProductionSettings', recordId: site.id, companyId: site.companyId, siteId: site.id, before: rulesOut(before), after: rulesOut(after), ...(reason ? { reason } : {}) })
        tools.emit({
          type: 'production.cutting_rules_changed',
          subject: site.id,
          companyId: site.companyId,
          siteId: site.id,
          payload: { siteId: site.id, fields, shadeRule: after.shadeRule, hidePhotoRequired: after.hidePhotoRequired, minimumRemnantArea: after.minimumRemnant.area, minimumRemnantUom: after.minimumRemnant.uom },
        })
        return { ...viewOf(site, await readRow(tools.tx, site.id), true), changed: true, changedFields: fields }
      },
    ),
  )
  return result
}
