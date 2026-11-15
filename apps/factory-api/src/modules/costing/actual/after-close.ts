import { afterCloseLineWords, afterCloseSources, afterCloseWords, mainDraftOf, type AfterCloseView } from '@nexus/factory-domain/costing/close/after-close'
import { ACTUAL_COST_REFUSAL_ISSUES, databaseActualCostRefusal } from '@nexus/factory-domain/costing/actuals-refusals'
import type { EntryDraft } from '@nexus/factory-domain/costing/ledger/entries'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { Log } from '../../../core/queue'
import { planCosts, type PostScope } from './post'
import { readWorkOrder, type CostedWorkOrder, type Reader } from './store'
import { ledgerViews } from './views'

/**
 * B-W2b-F46 — a cost that arrives after a work order's close waits, in words, for a reopen (B-W2b-411's gap 4). The close
 * freezes the actual: the database takes no cost entry on a CLOSED work order but a reversal (…_cost_actuals_w2b_guards,
 * B-W2b-376; never weakened). Before, a source event of a closed work order (a late scan, a return, a workshop's fee, a
 * receipt) made the worker's handler throw (its job retried and failed) and the nightly catch-up log the same failure every
 * night until someone reopened the work order. Now:
 *
 *   handler    (./handlers.ts) reads the work order before the write: CLOSED → it ends OK without writing and logs ONE
 *              structured info line when the event's plan had anything to post; the database's own refusal (a close that
 *              landed between the read and the write) is read the same way. Any other refusal still fails as before.
 *   catch-up   (./catch-up.ts) skips a CLOSED work order and counts it as `afterClose` (not `failed`) in its run.
 *   reads      GET /production/work-orders/:id/close-check and GET /costing/work-orders/:id carry `afterClose` (null unless
 *              CLOSED): computed on read, no stored flag — what the work order's sources lack on its ledger (the same dry plan
 *              the catch-up posts by), one line per source in words; amounts money.cost only.
 *   reopen     the close after a reopen posts them first, as it posts anything the worker had not (modules/production/
 *              work-orders/close.ts → postCostsInCommand); the person's catch-up route (POST /costing/work-orders/:id/post)
 *              still answers 409 costing/WORK_ORDER_CLOSED in words on a closed work order.
 */

/** The database's refusal of a cost entry on a CLOSED work order (or one whose close is settled) — no other refusal. */
export function isClosedWorkOrderRefusal(error: unknown): boolean {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (cause?.originalCode !== '23514' || typeof cause.originalMessage !== 'string') return false
  return databaseActualCostRefusal(cause.originalMessage)?.path === ACTUAL_COST_REFUSAL_ISSUES.closed
}

export interface LateCosts {
  readonly workOrder: CostedWorkOrder
  /** The entries its sources would post now (the dry plan); none: nothing arrived. */
  readonly drafts: readonly EntryDraft[]
}

/** On a CLOSED work order: what its sources would post now (`scope`: an event's sources; none: all, as the catch-up). Else null. */
export async function lateCostsOf(db: Reader, workOrderId: string, scope?: PostScope): Promise<LateCosts | null> {
  const workOrder = await readWorkOrder(db, workOrderId)
  if (!workOrder || workOrder.status !== 'CLOSED') return null
  return { workOrder, drafts: (await planCosts(db, workOrder, scope)).drafts }
}

/** The one info line of a cost that waits for a reopen (no amount: a log line carries no money). */
export function logWaitsForReopen(log: Log | undefined, fields: { readonly tenantId: string; readonly workOrderId: string; readonly number?: string | null; readonly entries?: number | null; readonly eventId?: string; readonly eventType?: string; readonly raced?: boolean }): void {
  log?.info({ ...fields, waitsFor: 'reopen' }, 'a cost arrived after its work order was closed: it waits for a reopen (the close freezes the actual)')
}

/** The reads' `afterClose`: null unless the work order is CLOSED; else one line per source of what its sources lack. */
export async function afterCloseOf(db: Reader, workOrder: CostedWorkOrder, drafts: readonly EntryDraft[]): Promise<AfterCloseView | null> {
  if (workOrder.status !== 'CLOSED') return null
  const sources = afterCloseSources(drafts)
  const views = await ledgerViews(
    db,
    sources.map((source) => ({ ...mainDraftOf(source), workOrderId: workOrder.id, currency: workOrder.currency, costingMethod: 'UNDECIDED' as const, createdAt: mainDraftOf(source).occurredAt })),
  )
  const lines = sources.map((source, index) => {
    const view = views[index]!
    const label = view.document?.label || null
    return {
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      event: view.event,
      occurredAt: view.occurredAt,
      day: view.day,
      label,
      item: view.item,
      quantity: view.quantity,
      minutes: view.minutes,
      entries: source.drafts.length,
      amount: asMoney('cost', source.drafts.reduce((sum, draft) => sum + draft.amount, 0)),
      words: afterCloseLineWords({ event: view.event, label, item: view.item, quantity: view.quantity, minutes: view.minutes, day: view.day }),
    }
  })
  return { count: lines.length, lines, words: afterCloseWords(lines.length) }
}
