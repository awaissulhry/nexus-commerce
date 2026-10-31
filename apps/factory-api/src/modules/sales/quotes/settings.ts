import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { QUOTES_VIEW, SALES_SETTINGS_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { QUOTE_RULE_DEFAULTS, quoteRuleProblems, type QuoteRules } from '@nexus/factory-domain/sales/quotes/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { rulesInForce, SALES_SETTINGS_COLUMNS, settingsRowsFor, type SalesSettingsRow } from './rules'
import { officeContextOf } from './store'

/**
 * The sales settings (B-W1-21; SAL-184, FIN-023; the design's Sales settings): the quote rules of a company, or the
 * tenant-wide ones — the margin floor and the discount limit a quote is checked against, the default validity and
 * deposit. Read with quotes.view (the floor only with the margin grain: the grain filter drops it); saved with
 * sales.settings.manage (a tenant-wide row only by a grant over every company; sending the floor needs the margin grain).
 * The row is keyed by the company's id (the tenant's for the tenant-wide row): the first save creates it (no version),
 * later ones send its version. A quote takes the rules in force when it is made and at every change of its draft; a
 * version keeps the floor it was checked against.
 */

const settingsView = (row: SalesSettingsRow) => ({
  id: row.id,
  companyId: row.companyId,
  marginFloorPct: asMoney('margin', decimalText(row.marginFloorPct.toString())),
  discountLimitPct: decimalText(row.discountLimitPct.toString()),
  defaultValidityDays: row.defaultValidityDays,
  defaultDepositPct: row.defaultDepositPct === null ? null : decimalText(row.defaultDepositPct.toString()),
  version: row.version,
  updatedAt: toUtcIso(row.updatedAt),
})

const rulesView = (rules: QuoteRules) => ({ ...rules, marginFloorPct: asMoney('margin', rules.marginFloorPct) })

/** A company the caller may see quotes of, or 404. */
async function assertCompany(caller: CommandCaller, companyId: string): Promise<void> {
  const context = officeContextOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!row || !can(actorOf(context), QUOTES_VIEW, { companyId })) throw new NotFoundError('Company not found.')
}

/** GET /sales/settings: the tenant-wide settings, a company's when asked, the rules in force for it and the defaults. */
export async function getSalesSettings(caller: CommandCaller, query: { companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  if (query.companyId !== undefined) await assertCompany(caller, query.companyId)
  const companyId = query.companyId ?? null
  return caller.withClient(async (client) => {
    const rows = await settingsRowsFor(client, companyId)
    const tenant = rows.find((row) => row.companyId === null && row.id === context.tenantId) ?? null
    const company = companyId === null ? null : (rows.find((row) => row.companyId === companyId && row.id === companyId) ?? null)
    return {
      settings: {
        tenant: tenant && settingsView(tenant),
        company: company && settingsView(company),
        inForce: rulesView(rulesInForce(rows, companyId)),
        defaults: rulesView(QUOTE_RULE_DEFAULTS),
      },
    }
  })
}

export interface SaveSalesSettingsInput {
  readonly companyId?: string | undefined
  readonly marginFloorPct?: string | undefined
  readonly discountLimitPct: string
  readonly defaultValidityDays: number
  readonly defaultDepositPct: string | null
  readonly version?: number | undefined
}

const FIELDS = ['marginFloorPct', 'discountLimitPct', 'defaultValidityDays', 'defaultDepositPct'] as const

/**
 * B-W2b-16 (design ssettings.approval "Raising a limit asks for step-up"): a change that lets more quotes through without
 * an approver — a higher discount limit or a lower margin floor than the rules in force before (the row's own, or for a
 * company's first row the rules it followed) — asks for a fresh step-up. Tightening, or other fields, does not.
 */
export function raisesApprovalLimit(before: { readonly marginFloorPct: string; readonly discountLimitPct: string }, after: { readonly marginFloorPct: string; readonly discountLimitPct: string }): boolean {
  return Number(after.discountLimitPct) > Number(before.discountLimitPct) || Number(after.marginFloorPct) < Number(before.marginFloorPct)
}

/** PUT /sales/settings (sales.settings.manage): a company's quote rules, or the tenant-wide ones. */
export async function saveSalesSettings(caller: CommandCaller, body: SaveSalesSettingsInput, idempotencyKey?: string, stepUp: () => void | Promise<void> = () => undefined) {
  const context = officeContextOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWrite(actorOf(context), SALES_SETTINGS_MANAGE, companyId)) throw new ForbiddenError(companyId === null ? 'The tenant-wide sales settings are changed only by a role over every company.' : undefined)
  if (companyId !== null) await assertCompany(caller, companyId)
  if (body.marginFloorPct === undefined) throw new ValidationError('The sales settings are not valid.', [{ path: 'body/marginFloorPct', message: 'Send the margin floor.' }])
  const wanted = {
    marginFloorPct: decimalText(body.marginFloorPct),
    discountLimitPct: decimalText(body.discountLimitPct),
    defaultValidityDays: body.defaultValidityDays,
    defaultDepositPct: body.defaultDepositPct === null ? null : decimalText(body.defaultDepositPct),
  }
  const problems = quoteRuleProblems({ marginFloorPct: body.marginFloorPct, discountLimitPct: body.discountLimitPct, defaultValidityDays: body.defaultValidityDays, defaultDepositPct: body.defaultDepositPct })
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The sales settings are not valid.', problems)
  const id = companyId ?? context.tenantId
  const existing = await caller.withClient((client) => client.salesSettings.findUnique({ where: { id }, select: SALES_SETTINGS_COLUMNS }))
  if (existing && body.version === undefined) throw new ConflictError('These sales settings exist: send their version to change them.')
  if (!existing && body.version !== undefined) throw new ConflictError('These sales settings do not exist yet: save them without a version.')
  // B-W2b-16: raising a limit (a higher discount limit, a lower margin floor) asks for a fresh step-up first.
  const inForce = existing ? settingsView(existing) : rulesInForce(await caller.withClient((client) => settingsRowsFor(client, companyId)), companyId)
  if (raisesApprovalLimit({ marginFloorPct: String(inForce.marginFloorPct), discountLimitPct: String(inForce.discountLimitPct) }, wanted)) await stepUp()

  const { result } = await command(
    caller,
    { name: 'sales.saveSettings', idempotencyKey, input: body, ...(existing ? { record: { type: 'SalesSettings', id, expectedVersion: body.version } } : {}) },
    async (tools) => {
      const { tx, now } = tools
      const row = existing ? await tx.salesSettings.findUniqueOrThrow({ where: { id }, select: SALES_SETTINGS_COLUMNS }) : null
      const before = row === null ? null : settingsView(row)
      const changed = before === null ? [...FIELDS] : FIELDS.filter((field) => String(before[field]) !== String(wanted[field]))
      if (row === null) {
        await tx.salesSettings.create({ data: { id, companyId, ...wanted, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
      } else if (changed.length > 0) {
        await tx.salesSettings.update({ where: { id }, data: { ...wanted, updatedAt: now }, select: { id: true } })
      }
      tools.audit({
        recordType: 'SalesSettings',
        recordId: id,
        companyId,
        ...(before === null ? {} : { before: { marginFloorPct: markMoney('margin', before.marginFloorPct), discountLimitPct: before.discountLimitPct, defaultValidityDays: before.defaultValidityDays, defaultDepositPct: before.defaultDepositPct } }),
        after: { companyId, marginFloorPct: markMoney('margin', wanted.marginFloorPct), discountLimitPct: wanted.discountLimitPct, defaultValidityDays: wanted.defaultValidityDays, defaultDepositPct: wanted.defaultDepositPct },
      })
      if (changed.length > 0) tools.emit({ type: 'sales_settings.changed', subject: id, companyId, payload: { settingsId: id, fields: [...changed] } })
      return { settings: settingsView(await tx.salesSettings.findUniqueOrThrow({ where: { id }, select: SALES_SETTINGS_COLUMNS })) }
    },
  ).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('These sales settings were just saved by someone else: reload them.')
    throw error
  })
  return result
}
