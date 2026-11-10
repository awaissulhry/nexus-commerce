import type { Prisma } from '@nexus/factory-db'
import { dueTests, FREQUENCY_WORDS, type DueTest, type LotFacts, type LotResultFact, type PlanFacts, type TestFrequency } from '@nexus/factory-domain/compliance/test-plans/rules'
import { limitWords, SUBSTANCE_TESTS, type LimitBound, type SubstanceTest, type SubstanceUnit } from '@nexus/factory-domain/compliance/substances/rules'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { namesFor } from '../register-of-rules/common'
import { marketsFor, type Reader } from '../substances/store'

/**
 * Test plan rules (B-W2b-256; PRD-309): the columns each part names, the views the routes answer, and the facts the due
 * tests of a lot are judged on (every lot of the material, its current substance results, the markets sold to). One query
 * after another; nothing written here. No money: nothing is ordered from a lab, no lab price is kept.
 */

export const PLAN_SELECT = {
  id: true,
  companyId: true,
  itemKind: true,
  itemId: true,
  test: true,
  frequency: true,
  marketCode: true,
  substanceRuleId: true,
  method: true,
  switchedOn: true,
  offReason: true,
  switchedAt: true,
  switchedById: true,
  note: true,
  status: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.TestPlanRuleSelect
export type PlanRow = Prisma.TestPlanRuleGetPayload<{ select: typeof PLAN_SELECT }>

const decimal = (value: Prisma.Decimal | null): string | null => (value === null ? null : value.toFixed())
export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

export const planFacts = (row: PlanRow): PlanFacts => ({
  id: row.id,
  companyId: row.companyId,
  itemKind: row.itemKind,
  itemId: row.itemId,
  test: row.test as SubstanceTest,
  frequency: row.frequency as TestFrequency,
  marketCode: row.marketCode,
  substanceRuleId: row.substanceRuleId,
  method: row.method,
  switchedOn: row.switchedOn,
  status: row.status,
})

/** The plan rules as the list shows them: the material or kind, the test, how often, the market, the rule it proves, the switch. */
export async function planViews(db: Reader, rows: readonly PlanRow[]) {
  const itemIds = [...new Set(rows.flatMap((row) => (row.itemId ? [row.itemId] : [])))]
  const items = new Map((itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true, kind: true } })).map((row) => [row.id, row]))
  const ruleIds = [...new Set(rows.flatMap((row) => (row.substanceRuleId ? [row.substanceRuleId] : [])))]
  const rules = new Map(
    (ruleIds.length === 0 ? [] : await db.substanceRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, key: true, code: true, name: true, limitValue: true, limitUnit: true, limitBound: true, switchedOn: true, status: true } })).map((row) => [row.id, row]),
  )
  const name = await namesFor(db, rows.map((row) => row.switchedById))
  return rows.map((row) => {
    const item = row.itemId ? items.get(row.itemId) : undefined
    const rule = row.substanceRuleId ? rules.get(row.substanceRuleId) : undefined
    return {
      id: row.id,
      companyId: row.companyId,
      itemKind: row.itemKind,
      item: item ? { id: item.id, code: item.code, name: item.name, kind: item.kind } : null,
      test: row.test as SubstanceTest,
      frequency: row.frequency as TestFrequency,
      frequencyWords: FREQUENCY_WORDS[row.frequency as TestFrequency],
      marketCode: row.marketCode,
      substanceRule: rule
        ? {
            id: rule.id,
            key: rule.key,
            code: rule.code,
            name: rule.name,
            limit: limitWords(decimal(rule.limitValue), rule.limitUnit as SubstanceUnit | null, rule.limitBound as LimitBound | null),
            switchedOn: rule.switchedOn,
            status: rule.status,
          }
        : null,
      method: row.method,
      switchedOn: row.switchedOn,
      offReason: row.offReason,
      switchedAt: row.switchedAt ? toUtcIso(row.switchedAt) : null,
      switchedBy: name(row.switchedById),
      note: row.note,
      status: row.status as 'ACTIVE' | 'ARCHIVED',
      version: row.version,
      updatedAt: toUtcIso(row.updatedAt),
    }
  })
}
export type PlanView = Awaited<ReturnType<typeof planViews>>[number]

export const LOT_FACTS_SELECT = { id: true, code: true, itemId: true, companyId: true, siteId: true, supplierId: true, itemColourId: true, receivedAt: true, createdAt: true, qualityStatus: true, item: { select: { kind: true } } } as const satisfies Prisma.LotSelect
type LotFactsRow = Prisma.LotGetPayload<{ select: typeof LOT_FACTS_SELECT }>

export const lotFacts = (row: LotFactsRow): LotFacts => ({
  id: row.id,
  code: row.code,
  itemId: row.itemId,
  itemKind: row.item.kind,
  companyId: row.companyId,
  supplierId: row.supplierId,
  itemColourId: row.itemColourId,
  arrivedOn: dayOf(row.receivedAt ?? row.createdAt),
  createdAt: toUtcIso(row.createdAt),
})

/** The switched-on ACTIVE plan rules (every company's: a plan rule names its company, which planApplies checks). */
export async function activePlans(db: Reader): Promise<PlanFacts[]> {
  return (await db.testPlanRule.findMany({ where: { status: 'ACTIVE', switchedOn: true }, select: PLAN_SELECT })).map(planFacts)
}

/** Per material: every lot of it and the current results of its substance tests. */
async function historyOf(db: Reader, itemIds: readonly string[]): Promise<{ readonly lots: Map<string, LotFacts[]>; readonly results: Map<string, LotResultFact[]> }> {
  const lots = new Map<string, LotFacts[]>(itemIds.map((id) => [id, []]))
  const results = new Map<string, LotResultFact[]>(itemIds.map((id) => [id, []]))
  if (itemIds.length === 0) return { lots, results }
  for (const row of await db.lot.findMany({ where: { itemId: { in: [...itemIds] } }, select: LOT_FACTS_SELECT })) lots.get(row.itemId)?.push(lotFacts(row))
  const rows = await db.labResult.findMany({
    where: { itemId: { in: [...itemIds] }, test: { in: [...SUBSTANCE_TESTS] }, supersededBy: { none: {} } },
    select: { id: true, itemId: true, lotId: true, test: true, verdict: true, testedOn: true, createdAt: true },
  })
  for (const row of rows) {
    if (row.verdict !== 'PASS' && row.verdict !== 'FAIL') continue
    results.get(row.itemId)?.push({ resultId: row.id, lotId: row.lotId, test: row.test as SubstanceTest, verdict: row.verdict, testedOn: dayOf(row.testedOn), recordedAt: toUtcIso(row.createdAt) })
  }
  return { lots, results }
}

/** The tests due on each of these lots (PRD-309), with what covers each. */
export async function dueOfLots(db: Reader, rows: readonly LotFactsRow[], today: BusinessDate, plans?: readonly PlanFacts[]): Promise<Map<string, DueTest[]>> {
  const out = new Map<string, DueTest[]>()
  if (rows.length === 0) return out
  const all = plans ?? (await activePlans(db))
  const history = await historyOf(db, [...new Set(rows.map((row) => row.itemId))])
  const markets = new Map<string, string[]>()
  for (const row of rows) {
    if (!markets.has(row.companyId)) markets.set(row.companyId, await marketsFor(db, [row.companyId]))
    out.set(
      row.id,
      dueTests({ lot: lotFacts(row), plans: all, markets: markets.get(row.companyId)!, lots: history.lots.get(row.itemId) ?? [], results: history.results.get(row.itemId) ?? [], today }),
    )
  }
  return out
}
