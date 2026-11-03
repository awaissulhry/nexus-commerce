import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { holds } from '@nexus/factory-domain/core/permissions'
import { QUALITY_TRIGGERS_MANAGE } from '@nexus/factory-domain/quality/triggers/permissions'
import type { TriggerEvent } from '@nexus/factory-domain/quality/triggers/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import type { RuleView } from './contract'
import { eventsView, mayManage, mayView, officeOf, readRule, ruleViews, viewWhere, type Db } from './store'

/**
 * The reads of "When inspections are created" (B-W2b-101; design quality.plans pl-triggers):
 *
 *   GET /quality/inspection-triggers?companyId=&event=&active=   the rules of the companies the caller sees (or one), in
 *                                                               each company's order, each with what it did in the last
 *                                                               30 days; what each event can do now (the rule form)
 *   GET /quality/inspection-triggers/:triggerId                 one rule
 */

export async function listRules(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly event?: TriggerEvent | undefined; readonly active?: 'true' | 'false' | undefined }) {
  const context = officeOf(caller)
  if (query.companyId && !mayView(context, query.companyId)) throw new NotFoundError('Company not found.')
  const where: Prisma.InspectionTriggerWhereInput = {
    AND: [viewWhere(context) as Prisma.InspectionTriggerWhereInput, ...(query.companyId ? [{ companyId: query.companyId }] : []), ...(query.event ? [{ event: query.event }] : []), ...(query.active ? [{ active: query.active === 'true' }] : [])],
  }
  const rules = await caller.withClient((client) => ruleViews(client as unknown as Db, where, serverClock.now()))
  return { rules, events: eventsView(), canManage: query.companyId ? mayManage(context, query.companyId) : holds(actorOf(context), QUALITY_TRIGGERS_MANAGE) }
}

export async function getRule(caller: CommandCaller, triggerId: string): Promise<{ rule: RuleView }> {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const db = client as unknown as Db
    const row = await readRule(db, context, triggerId)
    const [rule] = await ruleViews(db, { id: row.id }, serverClock.now())
    return { rule: rule! }
  })
}

/** Every rule of one company, as views (the answer of a write). */
export const companyRules = (db: Db, companyId: string, now: Date): Promise<RuleView[]> => ruleViews(db, { companyId }, now)
