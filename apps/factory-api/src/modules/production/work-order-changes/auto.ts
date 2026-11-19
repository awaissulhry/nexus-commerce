import { DomainError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { applyRouteOf, takesEveryCell, type ApplyRoute, type Words } from '@nexus/factory-domain/order-apply/rules'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { reachesWorkOrder } from '../work-orders/scope'
import { createWorkOrderInCommand, type DraftRight } from '../work-orders/work-orders'
import { applyChangeInCommand, failureWords, madeByChange, newDraftBody, routeRefusalWords } from './apply'
import type { ChangeOrder, Proposed } from './propose'
import { WORK_ORDER_COLUMNS, type ChangeWorkOrder } from './read'

/**
 * B-OP-012 (order page plan N2, decisions D1 + D3; 13-backend §1.2; review R-4, R-11, R-17): the work orders follow an office
 * change of the order IN ITS OWN COMMAND. The office change itself always lands (commercial truth first); each WorkOrderChange
 * it proposes (./propose.ts proposeGapsInCommand) is applied right after it is written when the person may, else it waits —
 * PROPOSED, decided on the order page — with its words:
 *
 *   a DRAFT's change              SET_DRAFT_CELLS, a DRAFT's CANCEL_WORK_ORDER, MAKE_MORE's NEW_DRAFT: anyone who may change the
 *                                 order (orders.manage over its company and customer, the caller's check): nothing is on the floor
 *   a released work order's       LOWER_RELEASED, the cancel of a released one (never below cut: Lower to the order and the
 *                                 database's floor keep what is cut): only a holder of workorders.manage over the work order's
 *                                 company, site and customer (the brand wall); else it waits ("production applies it")
 *   a mixed work order            one made before the one-customer rule (partyId null) is never changed from an order (R-11): it
 *                                 waits ("shared with other customers: change it on its page")
 *   a route it cannot take now    ON_HOLD, no longer open, released for a raise: it waits with the route's words (kept as lastError)
 *
 * A work order the reader does not reach with workorders.view (its customer, site; a mixed one: every customer) is "a work order"
 * in the answer — no id, no number, words that name none — as the order's Still to do says it (the wall).
 *
 * Nothing an apply does releases a work order (a raise on a released one is a new DRAFT; deposit, credit and compliance gates stay
 * on Release). The floor's note and the reprint mark follow every applied change (sales.orderChangeNotes on
 * work_order_change.applied; `applied[].reprint`); the proposal's bell is never rung for a change applied in the same command
 * (./notices.ts reads its status).
 *
 * The tenant scope runs no SAVEPOINT, so a refused apply cannot be undone alone: ONE runner, `withAutoApply`, the adjust-approval
 * pattern (modules/inventory/stock/adjust-approval.ts). Run 1 applies what it may; an apply refused (ON_HOLD, CHANGED_SINCE,
 * CUTTING_UNDER_WAY, REPLAN_LAY, CELL_IN_USE, UNIT_CUT, the database's own refusal …) throws `AutoApplyRefused` naming its work
 * order, the whole command rolls back and runs again under the same Idempotency-Key with that work order left out — its change is
 * written PROPOSED with the refusal's words in lastError (the database writes a new change with none: the words follow at once, its
 * version 2). At most MAX_APPLY_RUNS runs apply; after them one last run applies nothing.
 */

/** How the runs that apply may go: what is left out, and with which words (by work order; a new DRAFT by its cells). */
export interface AutoApply {
  readonly apply: 'IF_ALLOWED' | 'NEVER'
  readonly skip: ReadonlyMap<string, SkippedWords>
}
export interface SkippedWords {
  /** The refusal's words, kept on the change (lastError, one language as the apply route keeps them). */
  readonly lastError: string
  /** The words the order page shows for it. */
  readonly words: Words
}

/** An office change that carries no work order along (a split, the system's own commands). */
export const NEVER_APPLY: AutoApply = Object.freeze({ apply: 'NEVER', skip: new Map() })

/** At most this many runs of one office change apply; one more applies nothing. */
export const MAX_APPLY_RUNS = 3

/** A work-order change the office change carried out in its command. */
export interface AppliedChange {
  readonly changeId: string
  /** The work order it changed, or the DRAFT it made (null: one the reader does not reach with workorders.view). */
  readonly workOrderId: string | null
  readonly number: string | null
  readonly route: ApplyRoute
  /** A traveller printed before is out of date (a released work order lowered): the floor reprints it. */
  readonly reprint: boolean
}

/** A work-order change that waits, PROPOSED, with why (decided on the order page or by production). */
export interface WaitingChange {
  readonly changeId: string
  readonly workOrderId: string | null
  readonly number: string | null
  readonly words: Words
}

/** The answer of an office change: what its work orders did in its command, and what waits (R-17: the web never applies twice). */
export interface FollowedWorkOrders {
  readonly applied: AppliedChange[]
  readonly waiting: WaitingChange[]
}

/** A run's apply refused on one work order: the command rolls back and runs again without it (`withAutoApply`). */
export class AutoApplyRefused extends Error {
  override name = 'AutoApplyRefused'
  constructor(
    readonly key: string,
    readonly skipped: SkippedWords,
    readonly refusal: unknown,
  ) {
    super(skipped.lastError)
  }
}

/**
 * THE runner of the office routes that carry their work orders along (amend, priced change, put-back, close lines, cancel, accept):
 * `run` is the route's whole command (its own Idempotency-Key, unchanged between runs). See the file's head.
 */
export async function withAutoApply<Result>(run: (auto: AutoApply) => Promise<Result>): Promise<Result> {
  let skip = new Map<string, SkippedWords>()
  for (let runs = 1; ; runs += 1) {
    const auto: AutoApply = runs <= MAX_APPLY_RUNS ? { apply: 'IF_ALLOWED', skip } : { apply: 'NEVER', skip }
    try {
      return await run(auto)
    } catch (error) {
      if (!(error instanceof AutoApplyRefused) || auto.apply === 'NEVER') throw error instanceof AutoApplyRefused ? error.refusal : error
      skip = new Map([...skip, [error.key, error.skipped]])
    }
  }
}

/** Words the order page shows of a change that waits (it + en; a work order's number only when the reader sees it whole). */
export const FOLLOW_WORDS = {
  production: (number: string): Words => ({
    en: `${number} is released: production applies the change (a planner or a production manager).`,
    it: `${number} è rilasciato: la modifica la applica la produzione (un pianificatore o un responsabile di produzione).`,
  }),
  shared: (number: string): Words => ({ en: `${number} is shared with other customers: change it on its own page.`, it: `${number} è condiviso con altri clienti: cambialo dalla sua pagina.` }),
  /** A work order the reader does not reach: named by nothing. */
  unseen: (): Words => ({ en: 'A work order waits: production applies the change on its own page.', it: 'Un ordine di lavoro è in attesa: la modifica la applica la produzione dalla sua pagina.' }),
  notNow: (number: string | null): Words =>
    number
      ? { en: `${number} waits: apply the change from the order page.`, it: `${number} è in attesa: applica la modifica dalla pagina dell'ordine.` }
      : { en: 'The new work order waits: apply the change from the order page.', it: "Il nuovo ordine di lavoro è in attesa: applica la modifica dalla pagina dell'ordine." },
  refused: (number: string | null): Words =>
    number
      ? { en: `${number} waits: its change could not be applied now — see why on the change, then apply it again.`, it: `${number} è in attesa: la sua modifica non si è potuta applicare ora — vedi il perché sulla modifica, poi applicala di nuovo.` }
      : { en: 'The new work order waits: it could not be made now — see why on the change, then apply it again.', it: 'Il nuovo ordine di lavoro è in attesa: non si è potuto fare ora — vedi il perché sulla modifica, poi applicala di nuovo.' },
} as const

/** The key a change is left out by: its work order, or (a new DRAFT, a new id every run) the cells it asks. */
const skipKeyOf = (change: Pick<Proposed, 'workOrderId' | 'cells'>): string =>
  change.workOrderId ?? `new:${change.cells.map((cell) => `${cell.salesOrderLineId}|${cell.size}`).sort().join(',')}`

/** Who may carry the change out now, by its route on the work order as it is (see the file's head); null: it waits, `why`. */
type Decision = { readonly route: ApplyRoute; readonly right: DraftRight } | { readonly why: Words; readonly lastError: string | null }

async function decisionOf(tools: CommandTools, context: OfficeContext, order: ChangeOrder, change: Proposed, workOrder: ChangeWorkOrder | null): Promise<Decision> {
  const actor = actorOf(context)
  if (change.kind === 'MAKE_MORE' && change.workOrderId === null) {
    return can(actor, ORDERS_MANAGE, { companyId: order.companyId, partyId: order.partyId }) ? { route: 'NEW_DRAFT', right: 'ORDER' } : { why: FOLLOW_WORDS.notNow(null), lastError: null }
  }
  if (!workOrder) return { why: FOLLOW_WORDS.unseen(), lastError: null }
  // R-11: a work order of several customers (made before the one-customer rule) is never changed from an order.
  if (workOrder.partyId === null) return { why: FOLLOW_WORDS.shared(workOrder.number), lastError: null }
  if (workOrder.partyId !== order.partyId) return { why: FOLLOW_WORDS.notNow(workOrder.number), lastError: null }
  const cellIds = (await tools.tx.workOrderSize.findMany({ where: { workOrderId: workOrder.id }, select: { id: true } })).map((cell) => cell.id)
  const route = applyRouteOf({ kind: change.kind, workOrderId: workOrder.id }, workOrder, change.kind === 'LOWER_TO_ORDER' && takesEveryCell(change.cells, cellIds))
  if ('refusal' in route) {
    const words = routeRefusalWords(route.refusal, workOrder.number)
    return { why: words, lastError: words.en }
  }
  // D1: a DRAFT follows for whoever may change the order; a released work order only for workorders.manage over it (the wall).
  if (workOrder.status === 'DRAFT') return can(actor, ORDERS_MANAGE, { companyId: order.companyId, partyId: order.partyId }) ? { route: route.route, right: 'ORDER' } : { why: FOLLOW_WORDS.notNow(workOrder.number), lastError: null }
  return reachesWorkOrder(actor, WORKORDERS_MANAGE, workOrder) ? { route: route.route, right: 'WORK_ORDER' } : { why: FOLLOW_WORDS.production(workOrder.number), lastError: null }
}

/** Words of a refusal for the order page: its own when it has them (a change's or a lowering's refusal), else ours. */
const wordsOfRefusal = (error: unknown, number: string | null): Words => {
  const words = (error as { words?: unknown } | null)?.words as Partial<Words> | undefined
  return words && typeof words.en === 'string' && typeof words.it === 'string' ? { en: words.en, it: words.it } : FOLLOW_WORDS.refused(number)
}

/** A waiting change's words kept on it (lastError: the database writes a new change with none, so they follow at once). */
async function keepWords(tools: CommandTools, changeId: string, lastError: string): Promise<void> {
  await tools.tx.workOrderChange.update({ where: { id: changeId }, data: { lastError: lastError.trim().slice(0, 500) || 'Refused.', version: { increment: 1 } }, select: { id: true } })
}

/**
 * The changes just proposed in this command carried out where the person may (see the file's head), in the plan's order. A refusal
 * of one throws AutoApplyRefused (the runner runs the command again without it); everything else is left as it is.
 */
export async function followInCommand(tools: CommandTools, context: OfficeContext, order: ChangeOrder, proposed: readonly Proposed[], auto: AutoApply): Promise<FollowedWorkOrders> {
  if (proposed.length === 0) return { applied: [], waiting: [] }
  const ids = [...new Set(proposed.flatMap((change) => (change.workOrderId ? [change.workOrderId] : [])))]
  const workOrders = new Map((ids.length > 0 ? await tools.tx.workOrder.findMany({ where: { id: { in: ids } }, select: WORK_ORDER_COLUMNS }) : []).map((row) => [row.id, row]))
  const actor = actorOf(context)
  // The wall: a work order is named only to a person who reaches it with workorders.view (a mixed one: every customer); a new
  // DRAFT is of the order's customer.
  const newOnesSeen = can(actor, WORKORDERS_VIEW, { companyId: order.companyId, partyId: order.partyId })
  const applied: AppliedChange[] = []
  const waiting: WaitingChange[] = []
  for (const change of proposed) {
    const workOrder = change.workOrderId ? (workOrders.get(change.workOrderId) ?? null) : null
    const seen = workOrder ? reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder) : newOnesSeen
    const number = workOrder && seen ? workOrder.number : null
    const wait = (words: Words) => waiting.push({ changeId: change.id, workOrderId: seen ? change.workOrderId : null, number, words: seen ? words : FOLLOW_WORDS.unseen() })
    const skipped = auto.skip.get(skipKeyOf(change))
    if (skipped) {
      await keepWords(tools, change.id, skipped.lastError)
      wait(skipped.words)
      continue
    }
    const decision = await decisionOf(tools, context, order, change, workOrder)
    if ('why' in decision) {
      if (decision.lastError) await keepWords(tools, change.id, decision.lastError)
      wait(decision.why)
      continue
    }
    if (auto.apply === 'NEVER') {
      wait(FOLLOW_WORDS.notNow(number))
      continue
    }
    try {
      if (decision.route === 'NEW_DRAFT') {
        const made = await createWorkOrderInCommand(tools, context, newDraftBody(change.cells), madeByChange(context, change.id), decision.right)
        applied.push({ changeId: change.id, workOrderId: seen ? made.workOrder.id : null, number: seen ? made.workOrder.number : null, route: 'NEW_DRAFT', reprint: false })
      } else {
        const done = await applyChangeInCommand(tools, context, change.id, null, decision.right)
        applied.push({ changeId: change.id, workOrderId: seen ? done.workOrderId : null, number, route: decision.route, reprint: done.reprint.traveller })
      }
    } catch (error) {
      // A rule's refusal (the apply route keeps the same words): left out, the command runs again. Anything else is the command's.
      if (!(error instanceof DomainError) && failureWords(error) === null) throw error
      throw new AutoApplyRefused(skipKeyOf(change), { lastError: failureWords(error) ?? (error as Error).message, words: wordsOfRefusal(error, workOrder?.number ?? null) }, error)
    }
  }
  return { applied, waiting }
}
