import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { INVENTORY_RULES_MANAGE } from '@nexus/factory-domain/inventory/posting/permissions'
import { adjustmentLimitLoosened, backDatingLoosened, BACK_DATING_LIMITS, looseningReasonProblem, postingWindow, rulesInForce, type RulesInForce, type SettingsRow } from '@nexus/factory-domain/inventory/posting/rules'
import type { RulesCard } from '@nexus/factory-domain/inventory-rules/events'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { seesCost } from '../ledger/access'
import type { RulesView } from './contract'
import { inForceOf, rowsOf, type Db, type Rows } from './store'

/**
 * The warehouse rules' cards of B-W2b-314 (SCM-196, SCM-281; design warehouse.settings ws-posting, ws-adjust; the low-stock
 * alerts switch), kept on InventorySettings (the company's row, id = the company's; or the tenant-wide row, id = the
 * tenant's):
 *
 *   GET /inventory/rules?companyId                  inventory.stock.view over the company (tenant-wide: any grant): what is
 *                                                   in force and where it comes from, the scope's own values, its version and
 *                                                   who changed it; the adjustment value only with the cost grain
 *   PUT /inventory/rules/posting-dates              inventory.rules.manage over the scope (tenant-wide: over every company):
 *                                                   the back-dating days; more days or no limit asks the reason and a code
 *   PUT /inventory/rules/adjustment-approval        the same and the cost grain: the value above which an adjustment waits;
 *                                                   a higher value or none asks the reason and a code
 *   PUT /inventory/rules/low-stock-alerts           the same: low-stock alerts on, off, or as every company's
 *
 * Each save is one command at the row's version (a new row at 0), checked again under the row's lock; nothing to change is
 * kept as an attempt (an audit row, no event). A change emits inventory.rules_changed. B-W2b-299 adds the separation-of-
 * duty cards to the same row (receiverNotMatcher, counterNotApprover); B-W2b-289 the default locations (another table).
 */

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

async function assertCompany(caller: CommandCaller, companyId: string): Promise<{ id: string; code: string; name: string }> {
  const context = officeOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, legalName: true } })) : null
  if (!row || !(can(actorOf(context), INVENTORY_STOCK_VIEW, { companyId }) || can(actorOf(context), INVENTORY_RULES_MANAGE, { companyId }))) throw new NotFoundError('Company not found.')
  return { id: row.id, code: row.code, name: row.legalName }
}

const LOOSEN_WORDS = {
  none: { en: 'No limit: a move may be dated any day back, but never inside a closed month (Finance).', it: 'Nessun limite: un movimento può avere qualsiasi data passata, ma mai in un mese chiuso (Finanza).' },
} as const

function postingWords(days: number | null): { en: string; it: string } {
  if (days === null) return LOOSEN_WORDS.none
  if (days === 0) return { en: 'A move counts on the day it is entered: no day back. Closed months are Finance’s.', it: 'Un movimento conta nel giorno in cui è registrato: nessun giorno indietro. I mesi chiusi sono della Finanza.' }
  return {
    en: `A move may be dated up to ${days} ${days === 1 ? 'day' : 'days'} before the day it is entered, never inside a closed month (Finance).`,
    it: `Un movimento può avere una data fino a ${days} ${days === 1 ? 'giorno' : 'giorni'} prima del giorno in cui è registrato, mai in un mese chiuso (Finanza).`,
  }
}

function approvalRuleWords(active: number): { en: string; it: string } {
  if (active === 0) {
    return {
      en: 'No approval rule for stock adjustments is on: adjustments above the value post without a yes until one names who approves (Admin › Automation › Approval rules).',
      it: 'Nessuna regola di approvazione per le rettifiche è attiva: le rettifiche sopra il valore si registrano senza un sì finché una regola non dice chi approva (Amministrazione › Automazione › Regole di approvazione).',
    }
  }
  return {
    en: `${active} approval ${active === 1 ? 'rule says' : 'rules say'} who approves an adjustment above the value (Admin › Automation › Approval rules).`,
    it: `${active} ${active === 1 ? 'regola di approvazione dice' : 'regole di approvazione dicono'} chi approva una rettifica sopra il valore (Amministrazione › Automazione › Regole di approvazione).`,
  }
}

async function viewOf(db: Db, context: OfficeContext, companyId: string | null, company: { id: string; code: string; name: string } | null, now: Date): Promise<RulesView> {
  const rows = await rowsOf(db, context.tenantId, companyId)
  const own = companyId === null ? rows.tenant : rows.company
  const inForce = inForceOf(companyId, rows)
  const today = businessDate(now)
  const window = postingWindow(today, inForce.backDatingDays.value)
  const withCost = seesCost(context)
  const currency = companyId === null ? null : ((await db.company.findUnique({ where: { id: companyId }, select: { currency: true } }))?.currency ?? null)
  const active = await db.approvalRule.count({ where: { kind: 'STOCK_ADJUSTMENT', active: true, ...(companyId === null ? {} : { OR: [{ companyId: null }, { companyId }] }) } })
  const changer = own?.updatedById ? await db.user.findUnique({ where: { id: own.updatedById }, select: { id: true, displayName: true } }) : null
  return {
    companyId,
    company,
    version: own?.version ?? 0,
    updatedAt: own ? toUtcIso(own.updatedAt) : null,
    changedBy: changer ? { id: changer.id, name: changer.displayName } : null,
    mayChange: mayWrite(actorOf(context), INVENTORY_RULES_MANAGE, companyId),
    postingDates: {
      own: own?.backDatingDays ?? null,
      inForce: { days: inForce.backDatingDays.value, source: inForce.backDatingDays.source },
      today,
      earliest: window.earliest,
      limits: { min: BACK_DATING_LIMITS.min, max: BACK_DATING_LIMITS.max },
      words: postingWords(inForce.backDatingDays.value),
    },
    adjustmentApproval: {
      ...(withCost ? { own: asMoney('cost', own?.adjustmentApprovalAmount ?? null) } : {}),
      inForce: {
        ...(withCost ? { amount: asMoney('cost', inForce.adjustmentApprovalAmount.value) } : {}),
        source: inForce.adjustmentApprovalAmount.source,
        set: inForce.adjustmentApprovalAmount.value !== null,
      },
      currency,
      approvalRules: { active, words: approvalRuleWords(active) },
      held: withCost ? null : 'The value of an adjustment is a cost: your roles do not show costs.',
    },
    lowStockAlerts: { own: own?.lowStockAlerts ?? null, inForce: { on: inForce.lowStockAlerts.value, source: inForce.lowStockAlerts.source } },
  }
}

/** GET /inventory/rules */
export async function getRules(caller: CommandCaller, query: { readonly companyId?: string | undefined }, now: Date = new Date()): Promise<RulesView> {
  const context = officeOf(caller)
  const companyId = query.companyId ?? null
  const company = companyId === null ? null : await assertCompany(caller, companyId)
  if (companyId === null && !can(actorOf(context), INVENTORY_STOCK_VIEW, {}) && !can(actorOf(context), INVENTORY_RULES_MANAGE, {})) throw new ForbiddenError()
  return caller.withClient((db) => viewOf(db, context, companyId, company, now))
}

function assertMayChange(caller: CommandCaller, companyId: string | null): OfficeContext {
  const context = officeOf(caller)
  if (!mayWrite(actorOf(context), INVENTORY_RULES_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? 'The warehouse rules of every company are changed only by a role over every company.' : 'Changing the warehouse rules needs inventory.rules.manage for the company.')
  }
  return context
}

/** The scope's row FOR UPDATE at the version read (0: no row yet), then the rows as they are now. */
async function lockRow(tools: CommandTools, context: OfficeContext, companyId: string | null, version: number): Promise<{ id: string; exists: boolean; rows: Rows }> {
  const id = companyId ?? context.tenantId
  const [locked] = await tools.tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "InventorySettings" WHERE "id" = ${id}::uuid FOR UPDATE`
  const current = locked?.version ?? 0
  if (current !== version) throw new StaleVersionError('InventorySettings', id, current, version)
  return { id, exists: !!locked, rows: await rowsOf(tools.tx, context.tenantId, companyId) }
}

async function writeRow(tools: CommandTools, context: OfficeContext, companyId: string | null, id: string, exists: boolean, data: Record<string, unknown>): Promise<void> {
  const { tx, now } = tools
  if (exists) {
    await tx.inventorySettings.update({ where: { id }, data: { ...data, version: { increment: 1 }, updatedAt: now, updatedById: context.actorId }, select: { id: true } })
    return
  }
  await tx.inventorySettings
    .create({ data: { id, companyId, ...data, createdAt: now, updatedAt: now, createdById: context.actorId, updatedById: context.actorId }, select: { id: true } })
    .catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('These warehouse rules were just saved by someone else: read them again.')
      throw error
    })
}

interface CardPlan<Value> {
  readonly card: RulesCard
  readonly field: 'backDatingDays' | 'adjustmentApprovalAmount' | 'lowStockAlerts'
  readonly value: Value
  /** The rule in force before and after (for the loosening). */
  readonly loosened: (before: RulesInForce, after: RulesInForce) => boolean
  readonly money?: boolean
}

/** One card's save: the value as the scope's own, loosening checked twice (before and under the lock), one command. */
async function saveCard<Value>(
  caller: CommandCaller,
  body: { readonly companyId?: string | null | undefined; readonly version: number; readonly reason?: string | null | undefined },
  plan: CardPlan<Value>,
  options: { readonly stepUp: () => void | Promise<void>; readonly idempotencyKey?: string | undefined },
): Promise<{ rules: RulesView; loosened: boolean }> {
  const companyId = body.companyId ?? null
  const context = assertMayChange(caller, companyId)
  const company = companyId === null ? null : await assertCompany(caller, companyId)
  // The rules in force once the scope's own value is the new one.
  const next = (rows: Rows): RulesInForce => {
    const own = companyId === null ? rows.tenant : rows.company
    const changed = { backDatingDays: own?.backDatingDays ?? null, adjustmentApprovalAmount: own?.adjustmentApprovalAmount ?? null, lowStockAlerts: own?.lowStockAlerts ?? null, [plan.field]: plan.value } as SettingsRow
    return companyId === null ? rulesInForce(undefined, changed) : rulesInForce(changed, rows.tenant)
  }
  const loosens = (rows: Rows) => plan.loosened(inForceOf(companyId, rows), next(rows))
  const loosened = loosens(await caller.withClient((db) => rowsOf(db, context.tenantId, companyId)))
  if (loosened) {
    const problem = looseningReasonProblem(body.reason)
    if (problem) throw new ValidationError(problem, [{ path: 'body/reason', message: problem }])
    await options.stepUp()
  }
  await command(caller, { name: 'inventory.rules.save', idempotencyKey: options.idempotencyKey, input: body }, async (tools) => {
    const { id, exists, rows } = await lockRow(tools, context, companyId, body.version)
    const now = loosens(rows)
    if (now && !loosened) {
      throw new ValidationError('The rules in force changed meanwhile: read them again, then loosen them with the reason and a fresh code.', [{ path: 'body/version', message: 'Read the rules again.' }])
    }
    const own = companyId === null ? rows.tenant : rows.company
    const before = own ? own[plan.field] : null
    const mark = (value: unknown) => (plan.money ? markMoney('cost', value) : value)
    if (before === plan.value) {
      tools.audit({ action: 'inventory.rules.unchanged', recordType: 'InventorySettings', recordId: id, companyId, after: { card: plan.card } })
      return { id }
    }
    await writeRow(tools, context, companyId, id, exists, { [plan.field]: plan.value })
    tools.audit({
      action: 'inventory.rules.save',
      recordType: 'InventorySettings',
      recordId: id,
      companyId,
      before: { [plan.field]: mark(before) },
      after: { [plan.field]: mark(plan.value), card: plan.card, loosened: now },
      ...(body.reason?.trim() ? { reason: body.reason.trim() } : {}),
    })
    tools.emit({ type: 'inventory.rules_changed', subject: id, companyId, payload: { companyId, card: plan.card, fields: [plan.field], loosened: now } })
    return { id }
  })
  return { rules: await caller.withClient((db) => viewOf(db, context, companyId, company, new Date())), loosened }
}

type Options = { readonly stepUp: () => void | Promise<void>; readonly idempotencyKey?: string | undefined }

/** PUT /inventory/rules/posting-dates */
export function savePostingDates(caller: CommandCaller, body: { readonly companyId?: string | null; readonly version: number; readonly backDatingDays: number | null; readonly reason?: string | null }, options: Options) {
  return saveCard(caller, body, { card: 'POSTING_DATES', field: 'backDatingDays', value: body.backDatingDays, loosened: (before, after) => backDatingLoosened(before.backDatingDays.value, after.backDatingDays.value) }, options)
}

/** PUT /inventory/rules/adjustment-approval (the cost grain: the value is a cost). */
export function saveAdjustmentApproval(caller: CommandCaller, body: { readonly companyId?: string | null; readonly version: number; readonly amount?: number | null; readonly reason?: string | null }, options: Options) {
  const context = officeOf(caller)
  if (!seesCost(context)) throw new ForbiddenError('The value of an adjustment is a cost: changing it needs the cost grain.')
  if (body.amount === undefined) throw new ValidationError('Send the value (null: none).', [{ path: 'body/amount', message: 'Send the value in minor units, or null.' }])
  const amount = body.amount
  return saveCard(caller, body, { card: 'ADJUSTMENT_APPROVAL', field: 'adjustmentApprovalAmount', value: amount, money: true, loosened: (before, after) => adjustmentLimitLoosened(before.adjustmentApprovalAmount.value, after.adjustmentApprovalAmount.value) }, options)
}

/** PUT /inventory/rules/low-stock-alerts (switching them off widens nobody's rights: no code asked). */
export function saveLowStockAlerts(caller: CommandCaller, body: { readonly companyId?: string | null; readonly version: number; readonly on: boolean | null }, idempotencyKey?: string) {
  return saveCard(caller, body, { card: 'LOW_STOCK_ALERTS', field: 'lowStockAlerts', value: body.on, loosened: () => false }, { stepUp: () => undefined, idempotencyKey })
}
