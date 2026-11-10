import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCT_SETTINGS_MANAGE } from '@nexus/factory-domain/product/lifecycle/permissions'
import { EDIT_RULE_COLUMNS, editRuleFor, STYLE_LIFECYCLES, type EditRuleRow } from '@nexus/factory-domain/product/lifecycle/rules'
import type { SettingsQuery, SettingsView, UpdateSettingsBody } from '@nexus/factory-domain/product/settings/contracts'
import { storedByKind, toleranceFor, toleranceProblems, toleranceTable, type ToleranceRow } from '@nexus/factory-domain/product/settings/rules'
import { can } from '@nexus/factory-domain/core/permissions'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertMayWrite, contextOf, isUniqueViolation } from '../styles/store'
// B-W2b-239: whether the caller may change the row (the Product settings screen draws the fields as text otherwise).
import { mayWrite } from '../materials/store'

/**
 * The product settings (B-W2b-221; PRD-105, PRD-182; design products.settings psettings.lifecycle, psettings.tolerance;
 * factory-db ProductSettings): one row per company and one for the whole tenant (id = the company's id, or the tenant's).
 *
 *   GET /product/settings[?companyId]   product.styles.view (over the company; the tenant-wide row for any holder): each
 *                                       state's edit rule and the consumption tolerance (general and per material kind),
 *                                       each with this row's own value and the one in force with its source
 *   PUT /product/settings               product.settings.manage over the company (the tenant-wide row: over every company):
 *                                       {companyId, version?, editRules?, consumptionTolerance?, consumptionTolerancePct?,
 *                                       consumptionToleranceByKind?, reason?}
 *
 * A change is ONE command: on the row at its version (command()'s record guard), or the row made when there is none yet (a
 * second maker at the same time fails on the id: 409). Audit row with the reason; product_settings.changed. What a value
 * set to null means: the company follows the tenant-wide row, the tenant-wide row the product module's defaults (edit rules:
 * factory-domain product/lifecycle DEFAULT_EDIT_RULES; tolerance: MAY_DIFFER). Costing defaults are not here: Finance
 * settings is their one home (psettings.costing).
 */

const SETTINGS_SELECT = {
  id: true,
  companyId: true,
  editRuleConcept: true,
  editRuleDevelopment: true,
  editRuleSampling: true,
  editRuleApproved: true,
  editRuleInProduction: true,
  editRulePhaseOut: true,
  editRuleDiscontinued: true,
  consumptionTolerance: true,
  consumptionTolerancePct: true,
  consumptionToleranceByKind: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.ProductSettingsSelect
type SettingsRow = Prisma.ProductSettingsGetPayload<{ select: typeof SETTINGS_SELECT }>

type Reader = FactoryClient | CommandTx

const toleranceRowOf = (row: SettingsRow | null): ToleranceRow | null =>
  row === null ? null : { consumptionTolerance: row.consumptionTolerance, consumptionTolerancePct: row.consumptionTolerancePct?.toString() ?? null, consumptionToleranceByKind: row.consumptionToleranceByKind }

/** The company's row and the tenant-wide row, read with one client (one after the other). */
export async function settingsRows(db: Reader, tenantId: string, companyId: string | null): Promise<{ own: SettingsRow | null; tenant: SettingsRow | null }> {
  const tenant = await db.productSettings.findUnique({ where: { id: tenantId }, select: SETTINGS_SELECT })
  const own = companyId === null ? tenant : await db.productSettings.findUnique({ where: { id: companyId }, select: SETTINGS_SELECT })
  return { own, tenant }
}

function settingsViewOf(companyId: string | null, own: SettingsRow | null, tenant: SettingsRow | null, mayChange: boolean): SettingsView {
  // For the tenant-wide row, "company" is the row itself and nothing sits above it but the defaults.
  const company = companyId === null ? null : own
  const ruleRow = (row: SettingsRow | null): EditRuleRow | null => row
  const editRules = STYLE_LIFECYCLES.map((state) => {
    const inForce = companyId === null ? editRuleFor(state, null, ruleRow(own)) : editRuleFor(state, ruleRow(company), ruleRow(tenant))
    return { state, own: own?.[EDIT_RULE_COLUMNS[state]] ?? null, ...inForce }
  })
  const [companyTolerance, tenantTolerance] = companyId === null ? [null, toleranceRowOf(own)] : [toleranceRowOf(company), toleranceRowOf(tenant)]
  const general = toleranceFor(companyTolerance, tenantTolerance, null)
  const ownByKind = (own?.consumptionToleranceByKind ?? null) as Record<string, { rule: SettingsView['tolerance']['rule']; percent?: string }> | null
  return {
    companyId,
    exists: own !== null,
    version: own?.version ?? null,
    updatedAt: own ? toUtcIso(own.updatedAt) : null,
    mayChange,
    editRules,
    tolerance: {
      own: { rule: own?.consumptionTolerance ?? null, percent: own?.consumptionTolerancePct?.toString() ?? null },
      rule: general.rule,
      percent: general.percent,
      source: general.source,
      byKind: toleranceTable(companyTolerance, tenantTolerance).map((entry) => {
        const mine = ownByKind?.[entry.kind]
        return { ...entry, own: mine ? { rule: mine.rule, percent: mine.percent ?? null } : null }
      }),
    },
  }
}

function tenantOf(caller: CommandCaller): string {
  const context = contextOf(caller)
  if (context.audience === 'platform') throw new NotFoundError('No settings here.')
  return context.tenantId
}

/** The company, when the caller may see it (else 404). */
async function companyFor(caller: CommandCaller, companyId: string | null): Promise<void> {
  if (companyId === null) return
  const context = contextOf(caller)
  const company = await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } }))
  if (!company || !can(actorOf(context), PRODUCT_STYLES_VIEW, { companyId })) throw new NotFoundError('Company not found.')
}

/** GET /product/settings[?companyId] */
export async function readSettings(caller: CommandCaller, query: SettingsQuery): Promise<SettingsView> {
  const companyId = query.companyId ?? null
  await companyFor(caller, companyId)
  const tenantId = tenantOf(caller)
  const { own, tenant } = await caller.withClient((client) => settingsRows(client, tenantId, companyId))
  return settingsViewOf(companyId, own, tenant, mayWrite(actorOf(contextOf(caller)), PRODUCT_SETTINGS_MANAGE, companyId))
}

/** The fields a change names, as the row's columns (only what was sent). */
function columnsOf(body: UpdateSettingsBody): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const [state, rule] of Object.entries(body.editRules ?? {})) data[EDIT_RULE_COLUMNS[state as keyof typeof EDIT_RULE_COLUMNS]] = rule
  if (body.consumptionTolerance !== undefined) data.consumptionTolerance = body.consumptionTolerance
  if (body.consumptionTolerancePct !== undefined) data.consumptionTolerancePct = body.consumptionTolerancePct
  if (body.consumptionToleranceByKind !== undefined) data.consumptionToleranceByKind = storedByKind(body.consumptionToleranceByKind ?? null)
  return data
}

const plain = (value: unknown): unknown => (value === null || value === undefined ? null : typeof value === 'object' && 'toFixed' in (value as object) ? String(value) : value)

/** PUT /product/settings */
export async function updateSettings(caller: CommandCaller, body: UpdateSettingsBody, idempotencyKey?: string): Promise<SettingsView> {
  const context = contextOf(caller)
  const companyId = body.companyId
  await companyFor(caller, companyId)
  assertMayWrite(context, PRODUCT_SETTINGS_MANAGE, companyId)
  const tenantId = tenantOf(caller)
  const rowId = companyId ?? tenantId
  const data = columnsOf(body)
  const fields = Object.keys(data)
  if (fields.length === 0) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send an edit rule or a tolerance to change.' }])
  const existing = await caller.withClient((client) => client.productSettings.findUnique({ where: { id: rowId }, select: { version: true } }))
  if (existing && body.version === undefined) throw new ValidationError('The settings exist: send the version you read.', [{ path: 'body/version', message: 'Send the version you read.' }])
  if (!existing && body.version !== undefined) throw new ConflictError('These settings were removed or never made: load them again.')

  const { result } = await command(
    caller,
    { name: 'product.settings.update', idempotencyKey, input: { ...body }, ...(existing ? { record: { type: 'ProductSettings' as const, id: rowId, expectedVersion: body.version! } } : {}) },
    async (tools) => {
      const { tx, now } = tools
      const before = await tx.productSettings.findUnique({ where: { id: rowId }, select: SETTINGS_SELECT })
      if (!before && existing) throw new ConflictError('These settings were removed: load them again.')
      // The tolerance as it will be (what the change leaves out stays), checked as the database will.
      const rule = (data.consumptionTolerance !== undefined ? data.consumptionTolerance : (before?.consumptionTolerance ?? null)) as ToleranceRow['consumptionTolerance']
      const percent = data.consumptionTolerancePct !== undefined ? (data.consumptionTolerancePct as string | null) : (before?.consumptionTolerancePct?.toString() ?? null)
      const problems = toleranceProblems({ rule, percent, byKind: body.consumptionToleranceByKind === undefined ? null : (body.consumptionToleranceByKind ?? null) })
      if (problems.length > 0) throw new ValidationError('The tolerance is not valid.', problems)
      // A JSON column is cleared in SQL (Prisma takes no plain null for it), as W1 clears a style's names.
      const { consumptionToleranceByKind: byKind, ...columns } = data
      const written = { ...columns, ...(byKind === null || byKind === undefined ? {} : { consumptionToleranceByKind: byKind }) }
      if (before) {
        await tx.productSettings.update({ where: { id: rowId }, data: { ...(written as Prisma.ProductSettingsUncheckedUpdateInput), updatedAt: now }, select: { id: true } })
        if (byKind === null) await tx.$executeRaw`UPDATE "ProductSettings" SET "consumptionToleranceByKind" = NULL WHERE "id" = ${rowId}::uuid`
      } else {
        const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
        await tx.productSettings.create({ data: { id: rowId, companyId, ...(written as object), createdAt: now, updatedAt: now, createdById } as Prisma.ProductSettingsUncheckedCreateInput, select: { id: true } })
      }
      tools.audit({
        action: 'product.settings.update',
        recordType: 'ProductSettings',
        recordId: rowId,
        companyId,
        before: Object.fromEntries(fields.map((field) => [field, plain(before?.[field as keyof SettingsRow])])),
        after: Object.fromEntries(fields.map((field) => [field, plain(data[field])])),
        ...(body.reason ? { reason: body.reason } : {}),
      })
      tools.emit({ type: 'product_settings.changed', subject: rowId, companyId, payload: { companyId, fields } })
      const rows = await settingsRows(tx, tenantId, companyId)
      return settingsViewOf(companyId, rows.own, rows.tenant, true)
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('These settings were made at the same time by someone else: load them again.')
    throw error
  })
  return result
}
