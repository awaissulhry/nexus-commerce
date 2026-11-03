import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { chipsMatch, STAGE_WORDS, type Chip, type ChipFacts, type PlanStage } from '@nexus/factory-domain/quality/plans/rules'
import { inOrder, type TriggerEvent } from '@nexus/factory-domain/quality/triggers/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { chipLabels, chipsOf, chipViews } from '../plans/store'
import { lotSubjects, workOrderFacts, workshopSubject } from './facts'
import { becauseWords, officeOf, plansOf, TRIGGER_COLUMNS, type Db, type PlanFacts } from './store'

/**
 * Which plan the rules pick (B-W2b-101; QHS-010 "Plan assignment"; design quality.inspections qi-new "Plan: picked by the
 * trigger rules and explained - 'FIN-JACKET v3 applies because: category Jacket, customer Example Moto'"):
 *
 *   GET /quality/inspection-triggers/pick?stage&(lotId | subcontractReceiptId | workOrderId[&workOrderOperationId])
 *
 * The first ACTIVE rule of the company (any event, in the list's order) whose plan is of the stage, has an approved
 * version, and whose chips and plan's chips fit the subject; else the plan of the stage, with an approved version, whose
 * own chips fit (the most chips first: the narrowest wins), else none, in words. Office, quality.inspections.view over
 * the subject's company and site (the person opening an inspection by hand); the steps that open records (B-W2b-97, -98,
 * -99, -106) call `pickFor` inside their own command.
 */

export interface PickQuery {
  readonly stage: PlanStage
  readonly lotId?: string | undefined
  readonly subcontractReceiptId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly workOrderOperationId?: string | undefined
}

interface PickSubject {
  readonly companyId: string
  readonly siteId: string
  readonly facts: ChipFacts
}

async function subjectOf(db: Db, query: PickQuery): Promise<PickSubject | null> {
  if (query.lotId) return (await lotSubjects(db, [query.lotId]))[0] ?? null
  if (query.subcontractReceiptId) return workshopSubject(db, query.subcontractReceiptId)
  if (query.workOrderId) {
    const work = (await workOrderFacts(db, [query.workOrderId])).get(query.workOrderId)
    if (!work) return null
    const operation = query.workOrderOperationId ? await db.workOrderOperation.findFirst({ where: { id: query.workOrderOperationId, workOrderId: work.id }, select: { operationId: true } }) : null
    if (query.workOrderOperationId && !operation) return null
    return { companyId: work.companyId, siteId: work.siteId, facts: { STYLE: [work.styleId], CATEGORY: work.productType ? [work.productType] : [], CUSTOMER: [...work.customerIds], ...(operation ? { OPERATION: operation.operationId ? [operation.operationId] : [] } : {}) } }
  }
  throw new ValidationError("Name what is inspected: a lot, a workshop's receipt or a work order.", [{ path: 'query/lotId', message: "Name what is inspected: a lot, a workshop's receipt or a work order." }])
}

export interface Pick {
  readonly source: 'RULE' | 'PLAN'
  readonly rule: { readonly id: string; readonly position: number; readonly event: TriggerEvent } | null
  readonly plan: PlanFacts
  readonly because: readonly Chip[]
}

/** The pick for a subject's facts, read as the caller. */
export async function pickFor(db: Db, companyId: string, stage: PlanStage, facts: ChipFacts): Promise<Pick | null> {
  const rules = inOrder(await db.inspectionTrigger.findMany({ where: { companyId }, select: TRIGGER_COLUMNS }))
  const company = await db.inspectionPlan.findMany({ where: { companyId, stage }, select: { id: true } })
  const plans = await plansOf(db, [...rules.map((row) => row.planId), ...company.map((row) => row.id)])
  for (const [index, row] of rules.entries()) {
    const plan = plans.get(row.planId)
    if (!row.active || !plan || plan.stage !== stage || !plan.approved) continue
    const own = chipsMatch(chipsOf(row.appliesTo), facts)
    const its = chipsMatch(plan.appliesTo, facts)
    if (own.matches && its.matches) return { source: 'RULE', rule: { id: row.id, position: index + 1, event: row.event as TriggerEvent }, plan, because: [...own.because, ...its.because] }
  }
  const fitting = [...plans.values()]
    .filter((plan) => plan.companyId === companyId && plan.stage === stage && plan.approved && chipsMatch(plan.appliesTo, facts).matches)
    .sort((a, b) => b.appliesTo.length - a.appliesTo.length || a.code.localeCompare(b.code))
  const plan = fitting[0]
  return plan ? { source: 'PLAN', rule: null, plan, because: chipsMatch(plan.appliesTo, facts).because } : null
}

/** GET /quality/inspection-triggers/pick. */
export async function pickRoute(caller: CommandCaller, query: PickQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const db = client as unknown as Db
    const subject = await subjectOf(db, query)
    if (!subject || !can(actorOf(context), QUALITY_INSPECTIONS_VIEW, { companyId: subject.companyId, siteId: subject.siteId })) throw new NotFoundError('What is inspected was not found.')
    const pick = await pickFor(db, subject.companyId, query.stage, subject.facts)
    if (!pick) {
      const stage = STAGE_WORDS[query.stage]
      return { pick: null, none: { it: `Nessuna regola e nessun piano della fase ${stage.it.toLowerCase()} si applica: aprite l'ispezione su un piano a scelta.`, en: `No rule or plan of the ${stage.en.toLowerCase()} stage fits: open the inspection on a plan of your choice.` } }
    }
    const views = chipViews(pick.because, await chipLabels(db, pick.because))
    return {
      pick: {
        source: pick.source,
        rule: pick.rule,
        plan: { id: pick.plan.id, code: pick.plan.code, name: pick.plan.name, stage: pick.plan.stage },
        version: { id: pick.plan.approved!.id, number: pick.plan.approved!.number },
        because: views,
        words: await becauseWords(db, `${pick.plan.code} v${pick.plan.approved!.number}`, pick.because),
      },
      none: null,
    }
  })
}
