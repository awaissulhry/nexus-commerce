import type { FactoryClient } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_SETTINGS_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { QUOTE_RULE_DEFAULTS } from '@nexus/factory-domain/sales/quotes/rules'
import { SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import { NO_POLICY, policyInForce, policyProblems, type FreightPayer, type ReturnPolicy } from '@nexus/factory-domain/sales/returns/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { officeOf } from './access'

/**
 * The return policy (B-W2a-43; design ssettings.returns "Return window from delivery, condition rules, freight"; SAL-340
 * the reasons are the RETURN reason list of B-W2a-18). It lives on the sales settings rows (factory-db SalesSettings
 * return*): a company's row and the tenant-wide row. In force for a company: each field of the company's row when set,
 * else the tenant's (each field on its own).
 *
 *   GET  /sales/returns/policy?companyId=  (sales.returns.view) the tenant's policy, the company's own, the one in force
 *   PUT  /sales/returns/policy             (sales.settings.manage; the tenant-wide policy only by a grant over every
 *                                          company) the five fields of one row, at the version read. A company that
 *                                          follows the tenant's sales settings (no row of its own) is refused in words:
 *                                          its row also holds its quote rules, which this page does not set. The
 *                                          tenant's row is made with the quote defaults when it does not exist yet (the
 *                                          same rules that apply without it).
 */

type Reader = FactoryClient | CommandTx

const POLICY_COLUMNS = { id: true, companyId: true, returnWindowDays: true, returnGoodsDueDays: true, returnFreightPaidBy: true, returnRestockingFeePct: true, returnConditions: true, version: true, updatedAt: true } as const

type PolicyRow = { id: string; companyId: string | null; returnWindowDays: number | null; returnGoodsDueDays: number | null; returnFreightPaidBy: string | null; returnRestockingFeePct: { toString(): string } | null; returnConditions: string | null; version: number; updatedAt: Date }

const fee = (value: { toString(): string } | null): string | null => (value === null ? null : value.toString().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''))

const policyOfRow = (row: PolicyRow | null): ReturnPolicy | null =>
  row ? { windowDays: row.returnWindowDays, goodsDueDays: row.returnGoodsDueDays, freightPaidBy: row.returnFreightPaidBy as FreightPayer | null, restockingFeePct: fee(row.returnRestockingFeePct), conditions: row.returnConditions } : null

async function rowsOf(db: Reader, companyId: string | null): Promise<{ tenant: PolicyRow | null; company: PolicyRow | null }> {
  const tenant = await db.salesSettings.findFirst({ where: { companyId: null }, select: POLICY_COLUMNS })
  const company = companyId ? await db.salesSettings.findFirst({ where: { companyId }, select: POLICY_COLUMNS }) : null
  return { tenant, company }
}

/** The policy in force for the company (its own fields, else the tenant's; none: no policy). */
export async function policyOf(db: Reader, companyId: string | null): Promise<ReturnPolicy> {
  const rows = await rowsOf(db, companyId)
  return rows.tenant || rows.company ? policyInForce(policyOfRow(rows.company), policyOfRow(rows.tenant)) : NO_POLICY
}

const rowView = (row: PolicyRow | null) => (row ? { ...policyOfRow(row)!, id: row.id, companyId: row.companyId, version: row.version, updatedAt: toUtcIso(row.updatedAt) } : null)

/** GET /sales/returns/policy */
export async function getPolicy(caller: CommandCaller, query: { companyId?: string | undefined }) {
  const context = officeOf(caller)
  const companyId = query.companyId ?? null
  if (companyId !== null) {
    const company = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
    if (!company || !can(actorOf(context), SALES_RETURNS_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  }
  return caller.withClient(async (client) => {
    const rows = await rowsOf(client, companyId)
    return {
      policy: {
        tenant: rowView(rows.tenant),
        company: rowView(rows.company),
        inForce: rows.tenant || rows.company ? policyInForce(policyOfRow(rows.company), policyOfRow(rows.tenant)) : NO_POLICY,
        /** A company without its own sales settings row follows the tenant's (its policy is changed there). */
        followsTenant: companyId !== null && rows.company === null,
        canManage: mayWrite(actorOf(context), SALES_SETTINGS_MANAGE, companyId),
      },
    }
  })
}

export interface SavePolicyBody extends ReturnPolicy {
  readonly companyId?: string | undefined
  /** The row's version read (none: the tenant's row does not exist yet). */
  readonly version?: number | undefined
}

const FIELDS = [
  ['windowDays', 'returnWindowDays'],
  ['goodsDueDays', 'returnGoodsDueDays'],
  ['freightPaidBy', 'returnFreightPaidBy'],
  ['restockingFeePct', 'returnRestockingFeePct'],
  ['conditions', 'returnConditions'],
] as const

/** PUT /sales/returns/policy */
export async function savePolicy(caller: CommandCaller, body: SavePolicyBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWrite(actorOf(context), SALES_SETTINGS_MANAGE, companyId)) throw new ForbiddenError(companyId === null ? 'The tenant-wide return policy is changed only by a role over every company.' : undefined)
  const policy: ReturnPolicy = {
    windowDays: body.windowDays,
    goodsDueDays: body.goodsDueDays,
    freightPaidBy: body.freightPaidBy,
    restockingFeePct: body.restockingFeePct === null || body.restockingFeePct.trim() === '' ? null : body.restockingFeePct.trim(),
    conditions: body.conditions === null || body.conditions.trim() === '' ? null : body.conditions.trim(),
  }
  const problems = policyProblems(policy)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The return policy is not valid.', problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
  if (companyId !== null) {
    const company = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
    if (!company) throw new NotFoundError('Company not found.')
  }
  const { result } = await command(caller, { name: 'returns.savePolicy', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const rows = await rowsOf(tx, companyId)
    let row = companyId === null ? rows.tenant : rows.company
    if (companyId !== null && row === null) {
      throw new ValidationError('This company follows the tenant-wide sales settings: change the tenant’s return policy, or give the company its own quote rules first (Sales settings).', [{ path: 'body/companyId', message: 'No sales settings of its own.' }])
    }
    const before = policyOfRow(row)
    if (row === null) {
      // The tenant's row with the quote defaults (the rules in force without a row), then the policy on it.
      row = await tx.salesSettings.create({
        data: { id: context.tenantId, companyId: null, marginFloorPct: QUOTE_RULE_DEFAULTS.marginFloorPct, discountLimitPct: QUOTE_RULE_DEFAULTS.discountLimitPct, defaultValidityDays: QUOTE_RULE_DEFAULTS.defaultValidityDays, defaultDepositPct: QUOTE_RULE_DEFAULTS.defaultDepositPct, createdAt: now, updatedAt: now, createdById: context.actorId },
        select: POLICY_COLUMNS,
      })
    } else if (body.version !== undefined && body.version !== row.version) {
      throw new StaleVersionError('SalesSettings', row.id, row.version, body.version)
    }
    const { count } = await tx.salesSettings.updateMany({
      where: { id: row.id, version: row.version },
      data: { returnWindowDays: policy.windowDays, returnGoodsDueDays: policy.goodsDueDays, returnFreightPaidBy: policy.freightPaidBy, returnRestockingFeePct: policy.restockingFeePct, returnConditions: policy.conditions, version: row.version + 1, updatedAt: now },
    })
    if (count !== 1) throw new StaleVersionError('SalesSettings', row.id, row.version + 1, row.version)
    const fields = FIELDS.filter(([key]) => (before?.[key] ?? null) !== policy[key]).map(([key]) => key)
    tools.audit({ recordType: 'SalesSettings', recordId: row.id, companyId, before: before ?? null, after: policy })
    tools.emit({ type: 'return_policy.changed', subject: row.id, companyId, payload: { companyId, fields } })
    const saved = await tx.salesSettings.findUniqueOrThrow({ where: { id: row.id }, select: POLICY_COLUMNS })
    return { policy: rowView(saved)! }
  })
  return result
}
