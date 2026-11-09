import { z } from 'zod'
import type { Prisma } from '@nexus/factory-db'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, grantsFor, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { AREA_TOLERANCE_PERCENT } from '@nexus/factory-domain/inventory/hides/measure'
import { PURCHASING_MANAGE, PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { systemContext } from '../../../platform/outbox/system'
import { inWords } from '../../production/settings/cutting-rules'

/**
 * The leather area tolerance where a purchase order line names none (B-W2b-219; SCM-249, QHS-025; the follow-up of B-W2b-80,
 * -94, -98 on B-W2b-204's PurchasingSettings.leatherAreaTolerancePct): how far a leather lot's measured area may differ from
 * the tannery's before the area check opens a claim. The PO line's own tolerance wins; else the company's row, else the
 * tenant-wide row (every company), else AREA_TOLERANCE_PERCENT (2 %). The incoming area check and the re-measure read it
 * (inventory/hides/facts toleranceOfLot; quality/incoming/area-tolerance for the floor bench).
 *
 *   GET /purchasing/settings/leather-tolerance?companyId   purchasing.view: the company's (or, without companyId, every
 *                                                           company's) tolerance, where it comes from, the rows' versions
 *   PUT /purchasing/settings/leather-tolerance              purchasing.manage over the company (every company: a role over
 *        {companyId | null, percent | null, version?}       every company): ONE command on the row FOR UPDATE at the version
 *                                                           read (a company's first change makes its own row; null clears
 *                                                           the row's own value); audited; purchasing_settings
 *                                                           .leather_tolerance_changed; the same value changes nothing
 *
 * The floor has no grant on PurchasingSettings (B-W2b-204): a floor request reads the setting through the tenant's system
 * scope (`leatherToleranceFor` with the request), never in its own transaction.
 */

export const TOLERANCE_SETTING_SOURCES = ['COMPANY', 'TENANT', 'DEFAULT'] as const
export type ToleranceSettingSource = (typeof TOLERANCE_SETTING_SOURCES)[number]

/** The tolerance a lot without its own (no PO line value) is checked with, and the row it comes from. */
export interface ToleranceSetting {
  /** Percent either way, two decimals. */
  readonly percent: string
  readonly from: ToleranceSettingSource
}

const COLUMNS = { id: true, companyId: true, leatherAreaTolerancePct: true, version: true, updatedAt: true } as const satisfies Prisma.PurchasingSettingsSelect
type SettingsRow = Prisma.PurchasingSettingsGetPayload<{ select: typeof COLUMNS }>

const two = (value: { toString(): string }): string => new Dec(value.toString()).toFixed(2)

/** The rows' tolerance: the company's own value, else the tenant-wide one, else the domain's 2 %. */
export function toleranceFromRows(company: { readonly leatherAreaTolerancePct: { toString(): string } | null } | null, tenant: { readonly leatherAreaTolerancePct: { toString(): string } | null } | null): ToleranceSetting {
  if (company?.leatherAreaTolerancePct !== null && company?.leatherAreaTolerancePct !== undefined) return { percent: two(company.leatherAreaTolerancePct), from: 'COMPANY' }
  if (tenant?.leatherAreaTolerancePct !== null && tenant?.leatherAreaTolerancePct !== undefined) return { percent: two(tenant.leatherAreaTolerancePct), from: 'TENANT' }
  return { percent: AREA_TOLERANCE_PERCENT, from: 'DEFAULT' }
}

/** The company's row and the tenant's (office or system scope only: the floor has no grant). */
async function rowsOf(db: Pick<CommandTx, 'purchasingSettings'>, tenantId: string, companyId: string | null): Promise<{ company: SettingsRow | null; tenant: SettingsRow | null }> {
  const company = companyId === null ? null : await db.purchasingSettings.findUnique({ where: { id: companyId }, select: COLUMNS })
  const tenant = await db.purchasingSettings.findUnique({ where: { id: tenantId }, select: COLUMNS })
  return { company: company && company.companyId === companyId ? company : null, tenant: tenant && tenant.companyId === null ? tenant : null }
}

/** The setting for a company, read in the session's own scope (office or system: the floor has no grant on the table). */
export async function toleranceSettingIn(db: Pick<CommandTx, 'purchasingSettings'>, tenantId: string, companyId: string | null): Promise<ToleranceSetting> {
  const rows = await rowsOf(db, tenantId, companyId)
  return toleranceFromRows(rows.company, rows.tenant)
}

/**
 * May this session read PurchasingSettings (the office's and the system's scope may; the floor's may not)? Asked of the
 * database, so a floor transaction is never broken by a refused read.
 */
export async function maySeeSettings(db: Pick<CommandTx, '$queryRaw'>): Promise<boolean> {
  const [row] = await db.$queryRaw<{ ok: boolean }[]>`SELECT has_table_privilege('"PurchasingSettings"', 'SELECT') AS ok`
  return row?.ok === true
}

/** The request seen as its tenant's system (reads only): the floor's way to the purchasing settings. */
function systemReader(caller: CommandCaller): CommandCaller | null {
  const context = caller.factoryContext
  if (!context || !('tenantId' in context) || !context.tenantId) return null
  const view = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  view.factoryContext = systemContext(context.tenantId, context.requestId)
  return view
}

/**
 * The setting for a company, for any request: the office reads it itself; a floor request reads it through the tenant's
 * system scope (B-W2b-204: the floor has no grant on PurchasingSettings).
 */
export async function leatherToleranceFor(caller: CommandCaller, companyId: string): Promise<ToleranceSetting> {
  const context = caller.factoryContext
  if (!context || !('tenantId' in context) || !context.tenantId) return { percent: AREA_TOLERANCE_PERCENT, from: 'DEFAULT' }
  const tenantId = context.tenantId
  const reader = context.audience === 'office' || context.audience === 'system' ? caller : systemReader(caller)
  if (!reader) return { percent: AREA_TOLERANCE_PERCENT, from: 'DEFAULT' }
  return reader.withClient((client) => toleranceSettingIn(client, tenantId, companyId))
}

// ---- the setting itself: read and change ------------------------------------------------------------------------------------

function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

const everyCompany = (context: OfficeContext, permission: Permission): boolean => grantsFor(actorOf(context), permission).some((grant) => grant.companies === 'all')
const mayAt = (context: OfficeContext, permission: Permission, companyId: string | null): boolean => (companyId === null ? everyCompany(context, permission) : can(actorOf(context), permission, { companyId }))

const rowView = (row: SettingsRow | null) => (row ? { id: row.id, percent: row.leatherAreaTolerancePct === null ? null : two(row.leatherAreaTolerancePct), version: row.version, updatedAt: toUtcIso(row.updatedAt) } : null)

const settingsRowView = output({ id: id(), percent: z.string().nullable(), version: z.number().int(), updatedAt: instant() })
const toleranceView = output({
  /** null: every company (the tenant-wide row). */
  companyId: id().nullable(),
  /** The tolerance a lot whose order line names none is checked with, percent either way. */
  percent: z.string(),
  /** COMPANY: the company's own; TENANT: every company's; DEFAULT: none set (2 %). */
  from: z.enum(TOLERANCE_SETTING_SOURCES),
  company: settingsRowView.nullable(),
  tenant: settingsRowView.nullable(),
  /** The caller may change it here (purchasing.manage over the company; every company: a role over every company). */
  mayChange: z.boolean(),
})

export const getLeatherToleranceContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: toleranceView },
})

export const putLeatherToleranceContract = defineContract({
  body: input({
    /** null: every company (the tenant-wide row). */
    companyId: id().nullable(),
    /** 0 to 100, two decimals at most; null: this row sets none (a company then follows every company's, else 2 %). */
    percent: z.string().max(8).nullable(),
    /** The version of the row read; left out while it does not exist. */
    version: z.number().int().min(1).optional(),
  }),
  response: { 200: toleranceView.extend({ changed: z.boolean() }) },
})

/** GET /purchasing/settings/leather-tolerance (purchasing.view). */
export async function getLeatherTolerance(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const companyId = query.companyId ?? null
  if (companyId !== null && !can(actorOf(context), PURCHASING_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  return caller.withClient(async (client) => {
    if (companyId !== null && !(await client.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const rows = await rowsOf(client, context.tenantId, companyId)
    const effective = companyId === null ? toleranceFromRows(null, rows.tenant) : toleranceFromRows(rows.company, rows.tenant)
    return { companyId, percent: effective.percent, from: effective.from, company: rowView(rows.company), tenant: rowView(rows.tenant), mayChange: mayAt(context, PURCHASING_MANAGE, companyId) }
  })
}

const PERCENT_TEXT = /^\d{1,3}(\.\d{1,2})?$/

/** Why a tolerance cannot be kept (null when it can): 0 to 100, two decimals at most. */
export function percentProblem(percent: string | null): string | null {
  if (percent === null) return null
  const text = percent.trim()
  if (!PERCENT_TEXT.test(text) || new Dec(text).gt(100)) return 'The tolerance is a percent from 0 to 100, with up to two decimals.'
  return null
}

/** The row a change writes, locked: the company's own (made on its first change), or the tenant's. */
async function rowToChange(tools: CommandTools, context: OfficeContext, companyId: string | null, version: number | undefined): Promise<SettingsRow> {
  const { tx, now } = tools
  const rowId = companyId ?? context.tenantId
  if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
  await tx.$queryRaw`SELECT id FROM "PurchasingSettings" WHERE id = ${rowId}::uuid FOR UPDATE`
  const existing = await tx.purchasingSettings.findUnique({ where: { id: rowId }, select: COLUMNS })
  if (existing) {
    if (version === undefined || version !== existing.version) {
      throw new DomainError('conflict', `These settings changed since they were read; they are now at version ${existing.version}. Reload them and change the tolerance again.`, [{ path: 'body/version', message: `The current version is ${existing.version}.` }])
    }
    return existing
  }
  if (version !== undefined) throw new DomainError('conflict', 'These settings do not exist yet: send no version to make them.', [{ path: 'body/version', message: 'Leave it out for new settings.' }])
  // A company's first row keeps the switch it followed (the reminders' rule: the tenant's value, else off).
  const tenant = companyId !== null ? await tx.purchasingSettings.findUnique({ where: { id: context.tenantId }, select: { confirmationRemindersEnabled: true } }) : null
  return tx.purchasingSettings.create({
    data: { id: rowId, companyId, confirmationRemindersEnabled: tenant?.confirmationRemindersEnabled ?? false, createdAt: now, updatedAt: now, createdById: context.actorId },
    select: COLUMNS,
  })
}

/** PUT /purchasing/settings/leather-tolerance (purchasing.manage). */
export async function putLeatherTolerance(caller: CommandCaller, body: { readonly companyId: string | null; readonly percent: string | null; readonly version?: number | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  if (body.companyId !== null && !can(actorOf(context), PURCHASING_VIEW, { companyId: body.companyId })) throw new NotFoundError('Company not found.')
  if (!mayAt(context, PURCHASING_MANAGE, body.companyId)) {
    throw new ForbiddenError(body.companyId === null ? 'The tolerance of every company is changed only by a role over every company.' : 'Changing the leather area tolerance is for a person allowed to manage purchasing.')
  }
  const problem = percentProblem(body.percent)
  if (problem) throw new ValidationError(problem, [{ path: 'body/percent', message: problem }])
  const percent = body.percent === null ? null : new Dec(body.percent.trim()).toFixed(2)
  // The same value again changes nothing: no command, no audit, no event (the version is still checked).
  const current = await caller.withClient((client) => client.purchasingSettings.findUnique({ where: { id: body.companyId ?? context.tenantId }, select: COLUMNS }))
  const now = current?.leatherAreaTolerancePct === null || current?.leatherAreaTolerancePct === undefined ? null : two(current.leatherAreaTolerancePct)
  if (now === percent && (current ? body.version === current.version : body.version === undefined)) {
    return { ...(await getLeatherTolerance(caller, { companyId: body.companyId ?? undefined })), changed: false }
  }
  let changed = false
  await inWords(() =>
    command(caller, { name: 'purchasing.leatherTolerance', idempotencyKey, input: body }, async (tools) => {
      const row = await rowToChange(tools, context, body.companyId, body.version)
      const before = row.leatherAreaTolerancePct === null ? null : two(row.leatherAreaTolerancePct)
      if (before === percent) {
        // Made just now with nothing to set, or set the same meanwhile: the command still says what it found.
        tools.audit({ action: 'purchasing.leatherTolerance', recordType: 'PurchasingSettings', recordId: row.id, companyId: row.companyId, after: { leatherAreaTolerancePct: percent, unchanged: true } })
        return { id: row.id }
      }
      const after = await tools.tx.purchasingSettings.update({ where: { id: row.id }, data: { leatherAreaTolerancePct: percent, version: row.version + 1, updatedAt: tools.now }, select: COLUMNS })
      tools.audit({ action: 'purchasing.leatherTolerance', recordType: 'PurchasingSettings', recordId: row.id, companyId: row.companyId, before: { leatherAreaTolerancePct: before }, after: { leatherAreaTolerancePct: percent } })
      tools.emit({ type: 'purchasing_settings.leather_tolerance_changed', subject: row.id, companyId: row.companyId, payload: { settingsId: row.id, companyId: row.companyId, leatherAreaTolerancePct: after.leatherAreaTolerancePct === null ? null : two(after.leatherAreaTolerancePct) } })
      changed = true
      return { id: row.id }
    }),
  )
  return { ...(await getLeatherTolerance(caller, { companyId: body.companyId ?? undefined })), changed }
}
