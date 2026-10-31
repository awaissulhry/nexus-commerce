import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, grantsFor, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { PAYABLES_SETTINGS, PAYABLES_VIEW } from '@nexus/factory-domain/payables/permissions'
import type { Refusal } from '@nexus/factory-domain/payables/rules'
import {
  effectivePayablesSettings,
  matchSettingsOf,
  sdiApprovalProblem,
  PAYABLES_SETTING_FIELDS,
  payablesSettingsProblems,
  type EffectivePayablesSettings,
  type PayablesSdiApproval,
  type PayablesSettingsInput,
  type PayablesSettingsRow,
} from '@nexus/factory-domain/payables/settings'
import type { MatchBasis } from '@nexus/factory-domain/payables/match'
import { command, type CommandCaller } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { officeOf, type Reader } from './store'

/**
 * The payables settings (B-W2b-21, Z8:03; factory-db PayablesSettings of B-W2b-02; B-W2a-62's schema need; the rule:
 * factory-domain payables/settings). Per company (its row's values win) or tenant-wide (id = the tenant's; a grant over every
 * company changes it); a null follows the tenant row, and nothing anywhere keeps the W2a rule.
 *
 *   GET /payables/settings?companyId   payables.view: the company's row, the tenant row, what applies (and where each value
 *                                      comes from), the match's words as the invoice record shows them, mayManage
 *   PUT /payables/settings             payables.settings: { companyId (null: tenant-wide), version (absent: the row is
 *                                      made), the six values … } — ONE command on the row FOR UPDATE at the version read;
 *                                      payables_settings.changed. What it changes applies to the next match of an invoice
 *                                      (each match row copies its tolerances) and the next approval.
 *
 * The tolerances and the billing basis are the accountant's figures (GATE-ACCOUNTANT): finance types them once agreed; the
 * answer says whether every match figure is set (`decided`).
 */

const SETTINGS_COLUMNS = {
  id: true,
  companyId: true,
  quantityTolerancePct: true,
  priceTolerancePct: true,
  differenceToleranceAmount: true,
  billingBasis: true,
  sdiApproval: true,
  sdiApproverIds: true,
  accepterMayNotApprove: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.PayablesSettingsSelect
type SettingsRecord = Prisma.PayablesSettingsGetPayload<{ select: typeof SETTINGS_COLUMNS }>

const rowOf = (row: SettingsRecord | null): PayablesSettingsRow | null =>
  row
    ? {
        quantityTolerancePct: row.quantityTolerancePct === null ? null : row.quantityTolerancePct.toString(),
        priceTolerancePct: row.priceTolerancePct === null ? null : row.priceTolerancePct.toString(),
        differenceToleranceAmount: row.differenceToleranceAmount,
        billingBasis: row.billingBasis as MatchBasis | null,
        sdiApproval: row.sdiApproval as PayablesSdiApproval | null,
        sdiApproverIds: [...row.sdiApproverIds],
        accepterMayNotApprove: row.accepterMayNotApprove,
      }
    : null

const tenantIdOf = (context: OfficeContext): string => context.tenantId

/** The company's row and the tenant-wide row (companyId null; row-level security keeps the tenant), either may be missing. */
async function rowsOf(db: Reader, companyId: string | null): Promise<{ company: SettingsRecord | null; tenant: SettingsRecord | null }> {
  const rows = await db.payablesSettings.findMany({ where: { OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] }, select: SETTINGS_COLUMNS })
  return { company: companyId ? (rows.find((row) => row.companyId === companyId) ?? null) : null, tenant: rows.find((row) => row.companyId === null) ?? null }
}

/** The settings that apply to a company (its row, then the tenant's, then the W2a rule): the match and the approval read them. */
export async function payablesSettingsFor(db: Reader, companyId: string): Promise<EffectivePayablesSettings> {
  const rows = await rowsOf(db, companyId)
  return effectivePayablesSettings(rowOf(rows.company), rowOf(rows.tenant))
}

/** The people who sent the orders an invoice's lines bill: the purchase order's sender (else its maker), the subcontract order's issuer (else its maker). */
export async function buyersOf(db: Reader, invoiceId: string): Promise<string[]> {
  const lines = await db.supplierInvoiceLine.findMany({ where: { invoiceId }, select: { purchaseOrderLine: { select: { purchaseOrder: { select: { sentById: true, createdById: true } } } }, subcontractOrder: { select: { issuedById: true, createdById: true } } } })
  const ids = lines.flatMap((line) => [line.purchaseOrderLine ? (line.purchaseOrderLine.purchaseOrder.sentById ?? line.purchaseOrderLine.purchaseOrder.createdById) : null, line.subcontractOrder ? (line.subcontractOrder.issuedById ?? line.subcontractOrder.createdById) : null])
  return [...new Set(ids.filter((id): id is string => id !== null))]
}

/** The payables settings' SDI rule for this person on this invoice, as approval refusals (empty: the rule allows it). */
export async function sdiRuleRefusals(db: Reader, invoice: { readonly id: string; readonly companyId: string; readonly source: string }, approverId: string): Promise<Refusal[]> {
  if (invoice.source !== 'SDI') return []
  const settings = await payablesSettingsFor(db, invoice.companyId)
  if (settings.sdiApproval === 'ANY_APPROVER') return []
  const refusal = sdiApprovalProblem(settings, invoice, approverId, settings.sdiApproval === 'NOT_THE_BUYER' ? await buyersOf(db, invoice.id) : [])
  return refusal ? [refusal] : []
}

const mayEveryCompany = (context: OfficeContext, permission: Permission): boolean => grantsFor(actorOf(context), permission).some((grant) => grant.companies === 'all')
const mayAt = (context: OfficeContext, permission: Permission, companyId: string | null): boolean => (companyId === null ? mayEveryCompany(context, permission) : can(actorOf(context), permission, { companyId }))

function viewOf(row: SettingsRecord | null) {
  if (!row) return null
  return {
    id: row.id,
    companyId: row.companyId,
    version: row.version,
    quantityTolerancePct: row.quantityTolerancePct === null ? null : row.quantityTolerancePct.toFixed(4),
    priceTolerancePct: row.priceTolerancePct === null ? null : row.priceTolerancePct.toFixed(4),
    differenceToleranceAmount: asMoney('cost', row.differenceToleranceAmount),
    billingBasis: row.billingBasis as MatchBasis | null,
    sdiApproval: row.sdiApproval as PayablesSdiApproval | null,
    sdiApproverIds: [...row.sdiApproverIds],
    accepterMayNotApprove: row.accepterMayNotApprove,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** GET /payables/settings (payables.view over the company; without one, the tenant-wide row). */
export async function getPayablesSettings(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const companyId = query.companyId ?? null
  if (companyId !== null && !can(actorOf(context), PAYABLES_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  if (companyId === null && !mayEveryCompany(context, PAYABLES_VIEW) && !can(actorOf(context), PAYABLES_VIEW, {})) throw new ForbiddenError()
  const { rows, people } = await caller.withClient(async (db) => {
    if (companyId !== null && !(await db.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const found = await rowsOf(db, companyId)
    const ids = [...new Set([...(found.company?.sdiApproverIds ?? []), ...(found.tenant?.sdiApproverIds ?? [])])]
    const users = ids.length === 0 ? [] : await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true }, orderBy: { id: 'asc' } })
    return { rows: found, people: users }
  })
  const effective = effectivePayablesSettings(rowOf(rows.company), rowOf(rows.tenant))
  const match = matchSettingsOf(effective)
  return {
    companyId,
    company: viewOf(rows.company),
    tenant: viewOf(rows.tenant),
    effective: {
      quantityTolerancePct: effective.quantityTolerancePct,
      priceTolerancePct: effective.priceTolerancePct,
      differenceToleranceAmount: asMoney('cost', effective.differenceToleranceAmount),
      billingBasis: effective.billingBasis,
      sdiApproval: effective.sdiApproval,
      sdiApproverIds: [...effective.sdiApproverIds],
      accepterMayNotApprove: effective.accepterMayNotApprove,
      decided: effective.decided,
      source: effective.source,
    },
    /** The match's settings in words, as the invoice record's tolerance block says them. */
    words: match.words,
    /** The users the LISTED rules name (inside the settings: names). */
    people: people.map((user) => ({ id: user.id, name: user.displayName })),
    mayManage: mayAt(context, PAYABLES_SETTINGS, companyId),
  }
}

export interface PutPayablesSettings extends PayablesSettingsInput {
  readonly companyId: string | null
  readonly version?: number | undefined
}

/** PUT /payables/settings (payables.settings): the values sent change; the values left out stay. */
export async function putPayablesSettings(caller: CommandCaller, body: PutPayablesSettings, idempotencyKey?: string) {
  const context = officeOf(caller)
  if (!mayAt(context, PAYABLES_SETTINGS, body.companyId)) throw new ForbiddenError(body.companyId === null ? 'The payables settings of every company are changed only by a role over every company.' : undefined)
  const tenantId = tenantIdOf(context)
  const fields = PAYABLES_SETTING_FIELDS.filter((field) => body[field] !== undefined)
  if (fields.length === 0 && body.sdiApproverIds === undefined) throw new ValidationError('Send what changes.', [{ path: 'body', message: 'Nothing to change.' }])
  // The values sent, checked on their own first (400 before any version question); the whole row is checked again in the command.
  const sent = payablesSettingsProblems({ quantityTolerancePct: body.quantityTolerancePct ?? null, priceTolerancePct: body.priceTolerancePct ?? null, differenceToleranceAmount: body.differenceToleranceAmount ?? null, billingBasis: null, sdiApproval: null, sdiApproverIds: [], accepterMayNotApprove: body.accepterMayNotApprove ?? null })
  if (sent.length > 0) throw new ValidationError('The payables settings are not valid.', sent)
  await command(caller, { name: 'payables.settings', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const id = body.companyId ?? tenantId
    if (body.companyId !== null && !(await tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    await tx.$queryRaw`SELECT id FROM "PayablesSettings" WHERE id = ${id}::uuid FOR UPDATE`
    const existing = await tx.payablesSettings.findUnique({ where: { id }, select: SETTINGS_COLUMNS })
    if (existing && body.version !== existing.version) {
      throw new DomainError('conflict', `These settings changed since they were read; they are now at version ${existing.version}. Reload them and change them again.`, [{ path: 'body/version', message: `The current version is ${existing.version}.` }])
    }
    if (!existing && body.version !== undefined) throw new DomainError('conflict', 'These settings do not exist yet: send no version to make them.', [{ path: 'body/version', message: 'Leave it out for new settings.' }])
    const before = rowOf(existing) ?? { quantityTolerancePct: null, priceTolerancePct: null, differenceToleranceAmount: null, billingBasis: null, sdiApproval: null, sdiApproverIds: [], accepterMayNotApprove: null }
    // A rule that is not LISTED lists nobody: switching away from LISTED clears the list unless it is sent.
    const sdiApproval = body.sdiApproval !== undefined ? body.sdiApproval : before.sdiApproval
    const after: PayablesSettingsRow = {
      quantityTolerancePct: body.quantityTolerancePct !== undefined ? body.quantityTolerancePct : before.quantityTolerancePct,
      priceTolerancePct: body.priceTolerancePct !== undefined ? body.priceTolerancePct : before.priceTolerancePct,
      differenceToleranceAmount: body.differenceToleranceAmount !== undefined ? body.differenceToleranceAmount : before.differenceToleranceAmount,
      billingBasis: body.billingBasis !== undefined ? body.billingBasis : before.billingBasis,
      sdiApproval,
      sdiApproverIds: body.sdiApproverIds !== undefined ? [...body.sdiApproverIds] : sdiApproval === 'LISTED' ? before.sdiApproverIds : [],
      accepterMayNotApprove: body.accepterMayNotApprove !== undefined ? body.accepterMayNotApprove : before.accepterMayNotApprove,
    }
    const problems = payablesSettingsProblems(after)
    if (after.sdiApproverIds.length > 0) {
      const known = await tx.user.findMany({ where: { id: { in: [...after.sdiApproverIds] } }, select: { id: true } })
      after.sdiApproverIds.forEach((userId, index) => {
        if (!known.some((user) => user.id === userId)) problems.push({ path: `body/sdiApproverIds/${index}`, message: 'Not an office user of this tenant.' })
      })
    }
    if (problems.length > 0) throw new ValidationError('The payables settings are not valid.', problems)
    const data = {
      quantityTolerancePct: after.quantityTolerancePct,
      priceTolerancePct: after.priceTolerancePct,
      differenceToleranceAmount: after.differenceToleranceAmount,
      billingBasis: after.billingBasis,
      sdiApproval: after.sdiApproval,
      sdiApproverIds: [...after.sdiApproverIds],
      accepterMayNotApprove: after.accepterMayNotApprove,
    }
    const row = existing
      ? await tx.payablesSettings.update({ where: { id }, data: { ...data, version: existing.version + 1, updatedAt: now }, select: SETTINGS_COLUMNS })
      : await tx.payablesSettings.create({ data: { id, companyId: body.companyId, ...data, createdAt: now, updatedAt: now, createdById: context.actorId }, select: SETTINGS_COLUMNS })
    const audited = (value: PayablesSettingsRow) => ({ ...value, differenceToleranceAmount: markMoney('cost', value.differenceToleranceAmount) })
    tools.audit({ action: 'payables.settings', recordType: 'PayablesSettings', recordId: id, companyId: body.companyId, before: existing ? audited(before) : null, after: audited(after) })
    const changed = [...PAYABLES_SETTING_FIELDS.filter((field) => JSON.stringify(after[field]) !== JSON.stringify(before[field])), ...(JSON.stringify(after.sdiApproverIds) !== JSON.stringify(before.sdiApproverIds) ? ['sdiApproverIds' as const] : [])]
    tools.emit({ type: 'payables_settings.changed', subject: id, companyId: body.companyId, payload: { settingsId: id, companyId: body.companyId, fields: changed, created: !existing } })
    return { id: row.id }
  })
  return getPayablesSettings(caller, { companyId: body.companyId ?? undefined })
}
