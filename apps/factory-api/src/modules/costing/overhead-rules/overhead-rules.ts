import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { costingCurrency, pickOverhead } from '@nexus/factory-domain/costing/inputs'
import type {
  ArchiveOverheadRuleBody,
  CreateOverheadRuleBody,
  InForceQuery,
  InForceView,
  OverheadRulesQuery,
  OverheadRuleView,
  UpdateOverheadRuleBody,
} from '@nexus/factory-domain/costing/overhead-rules/contracts'
import {
  absorb,
  figureProblems,
  holds,
  inForceWords,
  MISSING_WORDS,
  OVERHEAD_BASES,
  OVERHEAD_REFUSAL_WORDS,
  OVERHEAD_UNVERIFIED,
  overheadKey,
  overheadRuleMachine,
  overlaps,
  periodProblems,
  rulesInForce,
  type OverheadRuleFacts,
} from '@nexus/factory-domain/costing/overhead-rules/rules'
import { COSTING_RATES_MANAGE, COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { contextOf, mayWrite } from '../../product/materials/store'
import { costRateRefusalOf, refused } from '../cost-per-minute/refusals'
import { companyOrTenant, dayOf, ownOverheadRows, SETTINGS_COLUMNS } from '../inputs'

/**
 * Overhead absorption rules (B-W2b-419; FIN-007; design finance.settings › Costing; OverheadRule of B-W2b-378): a percent of
 * labour, a cost per minute, per garment or per machine hour, for one kind of work centre or all, per company (or every
 * company) and whole months. Read with costing.view (the value only with the cost grain); kept with costing.rates.manage over
 * the rule's company (every company's rule: a grant over every company). A rule is corrected (its value, currency, end and
 * note), ended or archived, never deleted; a new figure from a later month is a new rule, and `endPrevious` ends the one
 * before it in the same command. The rules of one key never overlap (checked here in words under the key's advisory lock,
 * the database's too). `GET …/in-force` answers which rules a company's work of a kind takes on a day and the overhead they
 * absorb on the figures given, shaped as cost sheet lines (B-W2b-418 reads the same functions).
 *
 * UNVERIFIED (GATE-ACCOUNTANT): every answer says so; no rule changes a posted cost (factory-domain overhead-rules/rules.ts).
 */

const RULE_COLUMNS = {
  id: true,
  companyId: true,
  key: true,
  basis: true,
  workCentreKind: true,
  value: true,
  currency: true,
  periodStart: true,
  periodEnd: true,
  status: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.OverheadRuleSelect
type RuleRow = Prisma.OverheadRuleGetPayload<{ select: typeof RULE_COLUMNS }>
type Reader = FactoryClient | CommandTx

const RULE_SCOPE = { company: { field: 'companyId', nullable: true } } as const
const text = (value: { toString(): string }): string => decimalText(value.toString())
const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`)
const today = (): string => businessDate(serverClock.now())
const invalid = (issues: ValidationError['issues']): ValidationError => new ValidationError('The overhead rule is not valid.', issues ?? [])
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const refusedRule = (code: keyof typeof OVERHEAD_REFUSAL_WORDS) => refused(code, OVERHEAD_REFUSAL_WORDS[code])
/** The caller's tenant (every route here is the office's; the manifest refuses the others). */
const tenantOf = (context: RequestContext): string => {
  if (!('tenantId' in context)) throw new ForbiddenError()
  return context.tenantId
}

export const factsOf = (row: RuleRow): OverheadRuleFacts => ({
  id: row.id,
  companyId: row.companyId,
  basis: row.basis,
  workCentreKind: row.workCentreKind,
  value: text(row.value),
  currency: row.currency,
  periodStart: dayOf(row.periodStart),
  periodEnd: row.periodEnd ? dayOf(row.periodEnd) : null,
  status: row.status,
})

function viewOf(row: RuleRow, on: string): OverheadRuleView {
  const facts = factsOf(row)
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    basis: row.basis,
    workCentreKind: row.workCentreKind,
    value: asMoney('cost', facts.value),
    currency: row.currency,
    periodStart: facts.periodStart,
    periodEnd: facts.periodEnd,
    status: row.status,
    note: row.note,
    inForce: holds(facts, on),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The company exists and the caller may see its costs (else 404: the caller may not know it exists). */
async function assertCompany(caller: CommandCaller, companyId: string): Promise<RequestContext> {
  const context = contextOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((db) => db.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  return context
}

function assertMayManage(context: RequestContext, companyId: string | null): void {
  if (!mayWrite(actorOf(context), COSTING_RATES_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? "Every company's overhead rule is changed only by a role over every company." : undefined)
  }
}

async function readRule(caller: CommandCaller, ruleId: string): Promise<RuleRow> {
  const context = contextOf(caller)
  const row = isUuid(ruleId) ? await caller.withClient((db) => db.overheadRule.findUnique({ where: { id: ruleId }, select: RULE_COLUMNS })) : null
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Overhead rule not found.')
  return row
}

const order = (a: RuleRow, b: RuleRow): number =>
  Number(a.companyId !== null) - Number(b.companyId !== null) ||
  (a.companyId ?? '').localeCompare(b.companyId ?? '') ||
  OVERHEAD_BASES.indexOf(a.basis) - OVERHEAD_BASES.indexOf(b.basis) ||
  (a.workCentreKind === null ? -1 : WORK_CENTRE_KINDS.indexOf(a.workCentreKind)) - (b.workCentreKind === null ? -1 : WORK_CENTRE_KINDS.indexOf(b.workCentreKind)) ||
  b.periodStart.getTime() - a.periodStart.getTime()

/** GET /costing/overhead-rules: a company's own and every company's rules (or every rule the caller sees). */
export async function listOverheadRules(caller: CommandCaller, query: OverheadRulesQuery): Promise<{ rules: OverheadRuleView[]; unverified: string }> {
  const context = contextOf(caller)
  if (query.companyId !== undefined) await assertCompany(caller, query.companyId)
  const on = today()
  return caller.withClient(async (db) => {
    const scope = query.companyId === undefined ? (scopeWhere(actorOf(context), COSTING_VIEW, RULE_SCOPE) as Prisma.OverheadRuleWhereInput) : companyOrTenant(query.companyId)
    const rows = await db.overheadRule.findMany({
      where: { AND: [scope, query.basis ? { basis: query.basis } : {}, query.workCentreKind ? { workCentreKind: query.workCentreKind } : {}, query.status === 'ALL' ? {} : { status: query.status }] },
      select: RULE_COLUMNS,
      orderBy: [{ periodStart: 'desc' }, { id: 'asc' }],
      take: 500,
    })
    const shown = query.on ? rows.filter((row) => holds(factsOf(row), query.on!)) : rows
    return { rules: [...shown].sort(order).map((row) => viewOf(row, on)), unverified: OVERHEAD_UNVERIFIED }
  })
}

/** GET /costing/overhead-rules/:ruleId */
export async function overheadRuleRecord(caller: CommandCaller, ruleId: string): Promise<{ rule: OverheadRuleView; unverified: string }> {
  return { rule: viewOf(await readRule(caller, ruleId), today()), unverified: OVERHEAD_UNVERIFIED }
}

/** The key's advisory lock, the one the database's guard takes: two writers of one key take turns. */
async function lockKey(tools: CommandTools, key: string): Promise<void> {
  await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.overhead-rule', ${tenantOf(tools.context)}::uuid::text, ${key}::text), 0))`
}

/** The ACTIVE rules of a key whose period shares a day with this one (but the rule itself). */
async function clashes(tx: Reader, key: string, period: { periodStart: string; periodEnd: string | null }, except?: string): Promise<RuleRow[]> {
  const rows = await tx.overheadRule.findMany({ where: { key, status: 'ACTIVE', ...(except ? { id: { not: except } } : {}) }, select: RULE_COLUMNS })
  return rows.filter((row) => overlaps(factsOf(row), period))
}

const audited = (row: Pick<OverheadRuleFacts, 'value' | 'currency' | 'periodStart' | 'periodEnd'> & { note: string | null }) => ({
  value: markMoney('cost', row.value),
  currency: row.currency,
  periodStart: row.periodStart,
  periodEnd: row.periodEnd,
  note: row.note,
})

/**
 * costing.createOverheadRule: a rule from the first day of a month (open-ended or to the last day of a month). With
 * `endPrevious`, the active rule of the same key that starts earlier and runs into this period ends the day before (one
 * command, its own audit row and event); any other overlap is refused in words.
 */
export async function createOverheadRule(caller: CommandCaller, body: CreateOverheadRuleBody, idempotencyKey?: string): Promise<{ rule: OverheadRuleView; ended: OverheadRuleView | null; unverified: string }> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  assertMayManage(context, companyId)
  if (companyId !== null) await assertCompany(caller, companyId)
  const kind = body.workCentreKind ?? null
  // Required (a money field's type is optional; the grain filter refuses it from a caller without the cost grain).
  if (body.value === undefined) throw invalid([{ path: 'body/value', message: 'Send the percent of labour, or the amount per minute, garment or machine hour.' }])
  const figure = { basis: body.basis, value: decimalText(body.value), currency: body.currency ?? null }
  const period = { periodStart: body.periodStart, periodEnd: body.periodEnd ?? null }
  const problems = [...figureProblems(figure), ...periodProblems(period.periodStart, period.periodEnd)]
  if (problems.length > 0) throw invalid(problems)
  const key = overheadKey(companyId, body.basis, kind)
  const note = body.note ?? null

  const { result } = await command(caller, { name: 'costing.createOverheadRule', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockKey(tools, key)
    if (await tx.overheadRule.findFirst({ where: { key, periodStart: dateOf(period.periodStart) }, select: { id: true } })) throw refusedRule('START_TAKEN')
    const clashing = await clashes(tx, key, period)
    let ended: RuleRow | null = null
    if (clashing.length > 0) {
      const earlier = clashing.length === 1 && dayOf(clashing[0]!.periodStart) < period.periodStart ? clashing[0]! : null
      if (!body.endPrevious || !earlier) throw refusedRule('OVERLAPS')
      const lastDay = plusDays(period.periodStart, -1)
      ended = await tx.overheadRule.update({ where: { id: earlier.id }, data: { periodEnd: dateOf(lastDay), version: { increment: 1 }, updatedAt: now }, select: RULE_COLUMNS })
      tools.audit({
        action: 'costing.endOverheadRule',
        recordType: 'OverheadRule',
        recordId: earlier.id,
        companyId: earlier.companyId,
        before: { periodEnd: earlier.periodEnd ? dayOf(earlier.periodEnd) : null },
        after: { periodEnd: lastDay },
      })
      tools.emit({ type: 'overhead_rule.changed', subject: earlier.id, companyId: earlier.companyId, payload: { ruleId: earlier.id, basis: earlier.basis, workCentreKind: earlier.workCentreKind, change: 'ended' } })
    }
    const id = newId()
    const row = await tx.overheadRule.create({
      data: {
        id,
        companyId,
        key,
        basis: body.basis,
        workCentreKind: kind,
        value: figure.value,
        currency: figure.currency,
        periodStart: dateOf(period.periodStart),
        periodEnd: period.periodEnd === null ? null : dateOf(period.periodEnd),
        note,
        createdAt: now,
        updatedAt: now,
        createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
      },
      select: RULE_COLUMNS,
    })
    tools.audit({ recordType: 'OverheadRule', recordId: id, companyId, after: { companyId, key, basis: body.basis, workCentreKind: kind, ...audited({ ...figure, ...period, note }), status: 'ACTIVE' } })
    tools.emit({ type: 'overhead_rule.changed', subject: id, companyId, payload: { ruleId: id, basis: body.basis, workCentreKind: kind, change: 'created' } })
    const on = businessDate(now)
    return { rule: viewOf(row, on), ended: ended && viewOf(ended, on), unverified: OVERHEAD_UNVERIFIED }
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw refusedRule('START_TAKEN')
    throw costRateRefusalOf(error)
  })
  return result
}

const RULE_FIELDS = ['value', 'currency', 'periodEnd', 'note'] as const
type RuleField = (typeof RULE_FIELDS)[number]

/** costing.updateOverheadRule: a correction of an ACTIVE rule (versioned): its value, currency, last day or note. */
export async function updateOverheadRule(caller: CommandCaller, ruleId: string, body: UpdateOverheadRuleBody, idempotencyKey?: string): Promise<{ rule: OverheadRuleView; ended: null; unverified: string }> {
  const context = contextOf(caller)
  const seen = await readRule(caller, ruleId)
  assertMayManage(context, seen.companyId)
  const { result } = await command(
    caller,
    { name: 'costing.updateOverheadRule', idempotencyKey, input: { ruleId, ...body }, record: { type: 'OverheadRule', id: ruleId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      await lockKey(tools, seen.key)
      const row = await tx.overheadRule.findUniqueOrThrow({ where: { id: ruleId }, select: RULE_COLUMNS })
      if (row.status !== 'ACTIVE') throw refusedRule('ARCHIVED')
      const facts = factsOf(row)
      const current: Record<RuleField, string | null> = { value: facts.value, currency: facts.currency, periodEnd: facts.periodEnd, note: row.note }
      const sent: Partial<Record<RuleField, string | null>> = {
        ...(body.value === undefined ? {} : { value: decimalText(body.value) }),
        ...(body.currency === undefined ? {} : { currency: body.currency }),
        ...(body.periodEnd === undefined ? {} : { periodEnd: body.periodEnd }),
        ...(body.note === undefined ? {} : { note: body.note }),
      }
      const next = { ...current, ...sent }
      const changed = RULE_FIELDS.filter((field) => field in sent && sent[field] !== current[field])
      if (changed.length === 0) throw refusedRule('NOTHING_CHANGES')
      const problems = [...figureProblems({ basis: row.basis, value: next.value!, currency: next.currency }), ...periodProblems(facts.periodStart, next.periodEnd)]
      if (problems.length > 0) throw invalid(problems)
      if (changed.includes('periodEnd') && (await clashes(tx, row.key, { periodStart: facts.periodStart, periodEnd: next.periodEnd }, ruleId)).length > 0) throw refusedRule('OVERLAPS')
      const data: Prisma.OverheadRuleUncheckedUpdateInput = Object.fromEntries(changed.map((field) => [field, field === 'periodEnd' && next.periodEnd !== null ? dateOf(next.periodEnd) : next[field]]))
      const updated = await tx.overheadRule.update({ where: { id: ruleId }, data: { ...data, updatedAt: now }, select: RULE_COLUMNS })
      const pick = (values: Record<RuleField, string | null>) => Object.fromEntries(changed.map((field) => [field, field === 'value' ? markMoney('cost', values[field]) : values[field]]))
      tools.audit({ recordType: 'OverheadRule', recordId: ruleId, companyId: row.companyId, before: pick(current), after: pick(next) })
      tools.emit({ type: 'overhead_rule.changed', subject: ruleId, companyId: row.companyId, payload: { ruleId, basis: row.basis, workCentreKind: row.workCentreKind, change: 'updated' } })
      return { rule: viewOf(updated, businessDate(now)), ended: null, unverified: OVERHEAD_UNVERIFIED }
    },
  ).catch((error: unknown) => {
    throw costRateRefusalOf(error)
  })
  return result
}

/** costing.archiveOverheadRule: no cost sheet takes it any more (final: a new figure is a new rule). */
export async function archiveOverheadRule(caller: CommandCaller, ruleId: string, body: ArchiveOverheadRuleBody, idempotencyKey?: string): Promise<{ rule: OverheadRuleView; ended: null; unverified: string }> {
  const context = contextOf(caller)
  const seen = await readRule(caller, ruleId)
  assertMayManage(context, seen.companyId)
  if (seen.status !== 'ACTIVE') throw refusedRule('ARCHIVED')
  const { result } = await command(
    caller,
    { name: 'costing.archiveOverheadRule', idempotencyKey, input: { ruleId, ...body }, record: { type: 'OverheadRule', id: ruleId, expectedVersion: body.version, transition: { machine: overheadRuleMachine, to: 'ARCHIVED' } } },
    async (tools) => {
      tools.audit({ recordType: 'OverheadRule', recordId: ruleId, companyId: seen.companyId, before: { status: tools.record!.from }, after: { status: 'ARCHIVED' }, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'overhead_rule.changed', subject: ruleId, companyId: seen.companyId, payload: { ruleId, basis: seen.basis, workCentreKind: seen.workCentreKind, change: 'archived' } })
      const row = await tools.tx.overheadRule.findUniqueOrThrow({ where: { id: ruleId }, select: RULE_COLUMNS })
      return { rule: viewOf(row, businessDate(tools.now)), ended: null, unverified: OVERHEAD_UNVERIFIED }
    },
  )
  return result
}

/** The ACTIVE rules a company's work may take (its own and every company's), as facts. */
export async function activeRulesOf(db: Reader, companyId: string): Promise<OverheadRuleFacts[]> {
  return (await db.overheadRule.findMany({ where: { AND: [companyOrTenant(companyId), { status: 'ACTIVE' }] }, select: RULE_COLUMNS, orderBy: [{ periodStart: 'asc' }, { id: 'asc' }] })).map(factsOf)
}

/**
 * GET /costing/overhead-rules/in-force: the rules a company's work of a kind takes on a day (one per basis, the most
 * specific) and, with the figures given, what they absorb in the company's currency. None in force: the costing settings'
 * percent the cost sheet keeps (W1).
 */
export async function overheadInForce(caller: CommandCaller, query: InForceQuery): Promise<InForceView> {
  const context = await assertCompany(caller, query.companyId)
  const on = query.on ?? today()
  const kind = query.workCentreKind ?? null
  return caller.withClient(async (db) => {
    const company = await db.company.findUniqueOrThrow({ where: { id: query.companyId }, select: { currency: true } })
    const currency = costingCurrency(company.currency)
    const rows = await db.overheadRule.findMany({ where: { AND: [companyOrTenant(query.companyId), { status: 'ACTIVE' }] }, select: RULE_COLUMNS })
    const chosen = rulesInForce(rows.map(factsOf), query.companyId, kind, on)
    const byId = new Map(rows.map((row) => [row.id, row]))
    const { lines, total } = absorb(chosen, { labourCost: query.labourCost, minutes: query.minutes, units: query.units, machineHours: query.machineHours }, currency)
    let fallback: InForceView['fallback'] = null
    if (chosen.length === 0) {
      const settings = ownOverheadRows(await db.costingSettings.findMany({ where: companyOrTenant(query.companyId), select: SETTINGS_COLUMNS }))
      // The tenant-wide row is keyed by the tenant's id; a company's by the company's (rates.ts getSettings).
      const own = settings.filter((row) => (row.companyId === null ? row.id === tenantOf(context) : row.id === query.companyId))
      const picked = pickOverhead(own.map((row) => ({ id: row.id, companyId: row.companyId, overheadPct: text(row.overheadPct), updatedAt: null })), query.companyId)
      fallback = picked && { settingsId: picked.id, overheadPct: picked.overheadPct }
    }
    return {
      companyId: query.companyId,
      workCentreKind: kind,
      on,
      currency,
      rules: chosen.map((rule) => viewOf(byId.get(rule.id)!, on)),
      lines: lines.map((line) => ({
        ...line,
        unitCost: asMoney('cost', line.unitCost),
        pct: asMoney('cost', line.pct),
        amount: asMoney('cost', line.amount),
        missingWords: line.missing ? MISSING_WORDS[line.missing] : null,
      })),
      total: asMoney('cost', total),
      fallback,
      words: inForceWords(chosen.length),
      unverified: OVERHEAD_UNVERIFIED,
    }
  })
}
