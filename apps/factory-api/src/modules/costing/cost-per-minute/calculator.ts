import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { ApplyCalcBody, CalcRecordView, CreateCalcBody, UpdateCalcBody } from '@nexus/factory-domain/costing/cost-per-minute/contracts'
import {
  appliedRateNote,
  costPerMinuteOf,
  cpmKey,
  CPM_REFUSAL_WORDS,
  figuresProblems,
  fitsCostPerMinute,
  MAX_CALC_MONTHS,
  minutesBasisProblems,
  monthsProblems,
  type CalcFigures,
} from '@nexus/factory-domain/costing/cost-per-minute/rules'
import type { LabourRateView } from '@nexus/factory-domain/costing/contracts'
import { costingCurrency, pickRate } from '@nexus/factory-domain/costing/inputs'
import { rateProblems } from '@nexus/factory-domain/costing/rates'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { contextOf } from '../../product/materials/store'
import { companyOrTenant, dayOf, RATE_COLUMNS, rateOf } from '../inputs'
import { createRateInCommand, rateViewIn, taken } from '../rates'
import { calcRecordIn } from './reads'
import { costRateRefusalOf, refused } from './refusals'
import { assertCompany, assertMayManage, CALC_COLUMNS, centresOf, dateOf, readCalc, text, type CalcRow } from './store'

/**
 * The cost-per-minute calculator's writes (B-W2b-419; FIN-005): make a calculation for a company's department (or one work
 * centre of it) and whole months, correct or remove it while it is not applied, and apply it: in ONE command the company's
 * labour rate of the department from a day (POST /costing/rates' own write: its audit row and labour_rate.created), then the
 * calculation marks it applied and changes no more. Every write needs costing.rates.manage over the company (applying writes
 * its rate) and the cost grain to send a figure; every write goes through command() with its audit row (figures marked
 * money.cost) and cost_per_minute.changed.
 *
 * Refused in words (`refusal/<CODE>`, factory-domain cost-per-minute/rules): a work centre not of the company and department
 * (NOT_OF_KIND), another currency than the company's (CURRENCY), one planned seat (ONE_SEAT: no figure about a single person),
 * a cost per minute too big to keep (TOO_BIG), an applied calculation changed (APPLIED), a second one of the department and
 * period applied (ANOTHER_APPLIED), a rate from a past day (PAST_DAY: work already costed would take another rate). A rate of
 * the department and day that exists is POST /costing/rates' own 409.
 */

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const refusedCalc = (code: keyof typeof CPM_REFUSAL_WORDS) => refused(code, CPM_REFUSAL_WORDS[code])
const invalid = (issues: readonly Issue[]): ValidationError => new ValidationError('The cost-per-minute calculation is not valid.', issues)
const zeroOr = (value: string | undefined): string => decimalText(value ?? '0')

/** The figures and the cost per minute they give, checked (TOO_BIG when it does not fit the column). */
function computed(figures: CalcFigures): CalcFigures & { costPerMinute: string } {
  const costPerMinute = costPerMinuteOf(figures)
  if (!fitsCostPerMinute(costPerMinute)) throw refusedCalc('TOO_BIG')
  // Written as the stored figures are read back (no trailing zeros), so a correction compares like with like.
  return { ...figures, costPerMinute: decimalText(costPerMinute) }
}

const auditedFigures = (row: CalcFigures & { costPerMinute: string }) => ({
  directLabourCost: markMoney('cost', row.directLabourCost),
  availableMinutes: row.availableMinutes,
  indirectPerMinute: markMoney('cost', row.indirectPerMinute),
  overheadPerMinute: markMoney('cost', row.overheadPerMinute),
  costPerMinute: markMoney('cost', row.costPerMinute),
})

const figuresOf = (row: CalcRow): CalcFigures & { costPerMinute: string } => ({
  directLabourCost: text(row.directLabourCost),
  availableMinutes: text(row.availableMinutes),
  indirectPerMinute: text(row.indirectPerMinute),
  overheadPerMinute: text(row.overheadPerMinute),
  costPerMinute: text(row.costPerMinute),
})

async function recordOf(tools: CommandTools, calcId: string): Promise<CalcRecordView> {
  const row = await tools.tx.costPerMinuteCalc.findUniqueOrThrow({ where: { id: calcId }, select: CALC_COLUMNS })
  return calcRecordIn(tools.tx, row, businessDate(tools.now))
}

/** costing.createCostPerMinute: a department's (or work centre's) calculation for whole months, not applied. */
export async function createCalc(caller: CommandCaller, body: CreateCalcBody, idempotencyKey?: string): Promise<CalcRecordView> {
  const context = contextOf(caller)
  assertMayManage(context, body.companyId)
  await assertCompany(caller, body.companyId)
  // Required (a money field's type is optional; the grain filter refuses it from a caller without the cost grain).
  if (body.directLabourCost === undefined) throw invalid([{ path: 'body/directLabourCost', message: "Send the department's labour cost for the period." }])
  const figures = { directLabourCost: decimalText(body.directLabourCost), availableMinutes: decimalText(body.availableMinutes), indirectPerMinute: zeroOr(body.indirectPerMinute), overheadPerMinute: zeroOr(body.overheadPerMinute) }
  const problems = [...monthsProblems(body.periodStart, body.periodEnd, { maxMonths: MAX_CALC_MONTHS }), ...figuresProblems(figures), ...minutesBasisProblems(body.minutesBasis)]
  if (problems.length > 0) throw invalid(problems)
  const row = computed(figures)
  const workCentreId = body.workCentreId ?? null
  const key = cpmKey(body.companyId, body.workCentreKind, workCentreId)
  const note = body.note ?? null

  const { result } = await command(caller, { name: 'costing.createCostPerMinute', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const company = await tx.company.findUniqueOrThrow({ where: { id: body.companyId }, select: { currency: true } })
    const currency = costingCurrency(company.currency)
    if (body.currency !== undefined && body.currency !== currency) throw refusedCalc('CURRENCY')
    const centres = await centresOf(tx, body.companyId, body.workCentreKind, workCentreId)
    if (centres.reduce((sum, centre) => sum + centre.seats, 0) === 1) throw refusedCalc('ONE_SEAT')
    const id = newId()
    await tx.costPerMinuteCalc.create({
      data: {
        id,
        companyId: body.companyId,
        workCentreKind: body.workCentreKind,
        siteId: workCentreId === null ? null : centres[0]!.siteId,
        workCentreId,
        key,
        periodStart: dateOf(body.periodStart),
        periodEnd: dateOf(body.periodEnd),
        currency,
        ...row,
        ...(body.minutesBasis === undefined ? {} : { minutesBasis: body.minutesBasis as Prisma.InputJsonObject }),
        note,
        createdAt: now,
        updatedAt: now,
        createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
      },
      select: { id: true },
    })
    tools.audit({
      recordType: 'CostPerMinuteCalc',
      recordId: id,
      companyId: body.companyId,
      after: { workCentreKind: body.workCentreKind, workCentreId, periodStart: body.periodStart, periodEnd: body.periodEnd, currency, ...auditedFigures(row), note },
    })
    tools.emit({ type: 'cost_per_minute.changed', subject: id, companyId: body.companyId, payload: { calcId: id, workCentreKind: body.workCentreKind, change: 'created', labourRateId: null } })
    return recordOf(tools, id)
  }).catch((error: unknown) => {
    throw costRateRefusalOf(error)
  })
  return result
}

/** costing.updateCostPerMinute: a correction while not applied (versioned); the cost per minute is computed again. */
export async function updateCalc(caller: CommandCaller, calcId: string, body: UpdateCalcBody, idempotencyKey?: string): Promise<CalcRecordView> {
  const context = contextOf(caller)
  const seen = await readCalc(caller, calcId)
  assertMayManage(context, seen.companyId)
  if (seen.appliedAt) throw refusedCalc('APPLIED')
  const { result } = await command(
    caller,
    { name: 'costing.updateCostPerMinute', idempotencyKey, input: { calcId, ...body }, record: { type: 'CostPerMinuteCalc', id: calcId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const row = await tx.costPerMinuteCalc.findUniqueOrThrow({ where: { id: calcId }, select: CALC_COLUMNS })
      if (row.appliedAt) throw refusedCalc('APPLIED')
      const before = { periodStart: dayOf(row.periodStart), periodEnd: dayOf(row.periodEnd), ...figuresOf(row), note: row.note }
      const period = { periodStart: body.periodStart ?? before.periodStart, periodEnd: body.periodEnd ?? before.periodEnd }
      const figures = {
        directLabourCost: body.directLabourCost === undefined ? before.directLabourCost : decimalText(body.directLabourCost),
        availableMinutes: body.availableMinutes === undefined ? before.availableMinutes : decimalText(body.availableMinutes),
        indirectPerMinute: body.indirectPerMinute === undefined ? before.indirectPerMinute : decimalText(body.indirectPerMinute),
        overheadPerMinute: body.overheadPerMinute === undefined ? before.overheadPerMinute : decimalText(body.overheadPerMinute),
      }
      const problems = [...monthsProblems(period.periodStart, period.periodEnd, { maxMonths: MAX_CALC_MONTHS }), ...figuresProblems(figures), ...minutesBasisProblems(body.minutesBasis)]
      if (problems.length > 0) throw invalid(problems)
      const next = { ...period, ...computed(figures), note: body.note === undefined ? before.note : body.note }
      await tx.costPerMinuteCalc.update({
        where: { id: calcId },
        data: {
          periodStart: dateOf(next.periodStart),
          periodEnd: dateOf(next.periodEnd),
          directLabourCost: next.directLabourCost,
          availableMinutes: next.availableMinutes,
          indirectPerMinute: next.indirectPerMinute,
          overheadPerMinute: next.overheadPerMinute,
          costPerMinute: next.costPerMinute,
          note: next.note,
          ...(body.minutesBasis ? { minutesBasis: body.minutesBasis as Prisma.InputJsonObject } : {}),
          updatedAt: now,
        },
        select: { id: true },
      })
      // factory-db exports Prisma's types, not its runtime DbNull: a JSON column is cleared in SQL.
      if (body.minutesBasis === null && row.minutesBasis !== null) await tx.$executeRaw`UPDATE "CostPerMinuteCalc" SET "minutesBasis" = NULL WHERE "id" = ${calcId}::uuid`
      const fields = (['periodStart', 'periodEnd', 'directLabourCost', 'availableMinutes', 'indirectPerMinute', 'overheadPerMinute', 'costPerMinute', 'note'] as const).filter((field) => before[field] !== next[field])
      const pick = (values: typeof before) => Object.fromEntries(fields.map((field) => [field, field === 'periodStart' || field === 'periodEnd' || field === 'availableMinutes' || field === 'note' ? values[field] : markMoney('cost', values[field])]))
      tools.audit({ recordType: 'CostPerMinuteCalc', recordId: calcId, companyId: row.companyId, before: pick(before), after: { ...pick(next), ...(body.minutesBasis === undefined ? {} : { minutesBasis: body.minutesBasis }) } })
      tools.emit({ type: 'cost_per_minute.changed', subject: calcId, companyId: row.companyId, payload: { calcId, workCentreKind: row.workCentreKind, change: 'updated', labourRateId: null } })
      return recordOf(tools, calcId)
    },
  ).catch((error: unknown) => {
    throw costRateRefusalOf(error)
  })
  return result
}

/** costing.removeCostPerMinute: a calculation not applied is removed (an applied one is kept: its rate came from it). */
export async function removeCalc(caller: CommandCaller, calcId: string, version: number, idempotencyKey?: string): Promise<void> {
  const context = contextOf(caller)
  const seen = await readCalc(caller, calcId)
  assertMayManage(context, seen.companyId)
  if (seen.appliedAt) throw refusedCalc('APPLIED')
  await command(caller, { name: 'costing.removeCostPerMinute', idempotencyKey, input: { calcId, version }, record: { type: 'CostPerMinuteCalc', id: calcId, expectedVersion: version } }, async (tools) => {
    await tools.tx.costPerMinuteCalc.delete({ where: { id: calcId }, select: { id: true } })
    tools.audit({ recordType: 'CostPerMinuteCalc', recordId: calcId, companyId: seen.companyId, before: { workCentreKind: seen.workCentreKind, workCentreId: seen.workCentreId, periodStart: dayOf(seen.periodStart), periodEnd: dayOf(seen.periodEnd), ...auditedFigures(figuresOf(seen)) } })
    tools.emit({ type: 'cost_per_minute.changed', subject: calcId, companyId: seen.companyId, payload: { calcId, workCentreKind: seen.workCentreKind, change: 'removed', labourRateId: null } })
    return { id: calcId, removed: true }
  }).catch((error: unknown) => {
    throw costRateRefusalOf(error)
  })
}

/**
 * costing.applyCostPerMinute: the calculation becomes the company's labour rate of its department from a day (today or
 * later), in ONE command — the rate written as POST /costing/rates writes it (its planned efficiency: the one sent, else the
 * rate in force for the department that day, else 100), then the calculation applied (its rate, when, by whom) and frozen.
 */
export async function applyCalc(caller: CommandCaller, calcId: string, body: ApplyCalcBody, idempotencyKey?: string): Promise<{ calc: CalcRecordView; rate: LabourRateView }> {
  const context = contextOf(caller)
  const seen = await readCalc(caller, calcId)
  assertMayManage(context, seen.companyId)
  if (seen.appliedAt) throw refusedCalc('APPLIED')
  if (body.plannedEfficiencyPct !== undefined) {
    const problems = rateProblems({ plannedEfficiencyPct: decimalText(body.plannedEfficiencyPct) }).map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
    if (problems.length > 0) throw invalid(problems)
  }
  const { result } = await command(
    caller,
    { name: 'costing.applyCostPerMinute', idempotencyKey, input: { calcId, ...body }, record: { type: 'CostPerMinuteCalc', id: calcId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      if (tools.context.audience !== 'office') throw new ForbiddenError()
      if (body.validFrom < businessDate(now)) throw refusedCalc('PAST_DAY')
      const row = await tx.costPerMinuteCalc.findUniqueOrThrow({ where: { id: calcId }, select: CALC_COLUMNS })
      if (row.appliedAt) throw refusedCalc('APPLIED')
      if (await tx.costPerMinuteCalc.findFirst({ where: { key: row.key, periodStart: row.periodStart, appliedAt: { not: null } }, select: { id: true } })) throw refusedCalc('ANOTHER_APPLIED')
      const rates = await tx.labourRate.findMany({ where: { AND: [companyOrTenant(row.companyId), { workCentreKind: row.workCentreKind }] }, select: RATE_COLUMNS })
      const inForce = pickRate(rates.map(rateOf), row.workCentreKind, row.companyId, body.validFrom)
      const plannedEfficiencyPct = body.plannedEfficiencyPct === undefined ? (inForce?.plannedEfficiencyPct ?? '100') : decimalText(body.plannedEfficiencyPct)
      const costPerMinute = text(row.costPerMinute)
      const rateId = await createRateInCommand(tools, {
        companyId: row.companyId,
        workCentreKind: row.workCentreKind,
        costPerMinute,
        currency: row.currency,
        plannedEfficiencyPct,
        validFrom: body.validFrom,
        note: body.note ?? appliedRateNote(dayOf(row.periodStart), dayOf(row.periodEnd)),
      })
      await tx.costPerMinuteCalc.update({ where: { id: calcId }, data: { labourRateId: rateId, appliedAt: now, appliedById: tools.context.actorId, updatedAt: now }, select: { id: true } })
      tools.audit({
        recordType: 'CostPerMinuteCalc',
        recordId: calcId,
        companyId: row.companyId,
        before: { applied: false },
        after: { applied: true, labourRateId: rateId, validFrom: body.validFrom, costPerMinute: markMoney('cost', costPerMinute), plannedEfficiencyPct },
      })
      tools.emit({ type: 'cost_per_minute.changed', subject: calcId, companyId: row.companyId, payload: { calcId, workCentreKind: row.workCentreKind, change: 'applied', labourRateId: rateId } })
      return { calc: await recordOf(tools, calcId), rate: await rateViewIn(tx, rateId, businessDate(now)) }
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw String((error as Error).message).includes('CostPerMinuteCalc') ? refusedCalc('ANOTHER_APPLIED') : taken(seen.workCentreKind, body.validFrom)
    throw costRateRefusalOf(error)
  })
  return result
}
