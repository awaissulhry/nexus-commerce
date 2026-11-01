import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { valueMove } from '../../inventory/ledger/valuation'
import { postWorkOrderCosts, type PostScope } from './post'

/**
 * The worker's half of the cost ledger (B-W2a-21; FIN-026, FIN-027, FIN-038): after each event that can cost a work order,
 * its ledger is posted (./post.ts, ONE writer), in the event's tenant's system context, with a key made from the event
 * (a repeated event or a retried job posts nothing twice; the entries' own keys make sure of it too):
 *
 *   inventory.moved            an ISSUE, RETURN, SCRAP or PRODUCTION_RECEIPT of a work order (or its reversal); a floor
 *                              move not valued yet is valued first (the same command as inventory.valueFloorMoves, once)
 *   production.scan_recorded   a report (labour, its scrap) and the scan an undo or a correction voids (their reversal)
 *   production.rework_moved    a rework DONE with scrap
 *   production.scrap_over_limit_decided  B-W2b-53 (MES-128): a scan's scrap above its site's limit approved (its scrap
 *                              posts now) or refused (nothing posts)
 * Anything that cannot post yet (no value, no labour rate) waits; the next event of the work order, the catch-up route
 * (POST /costing/work-orders/:id/post) or the nightly catch-up (./catch-up.ts, cron costing.catchUp; B-W2b-22) posts it.
 *
 * Listed in background.ts HANDLERS for the worker: ...costingHandlers().
 */
const COSTED = new Set(['ISSUE', 'RETURN', 'SCRAP', 'PRODUCTION_RECEIPT'])

export function costingHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'costing.postWorkOrderCosts',
      // B-W2b-53: + the decision on scrap above a site's limit.
      events: ['inventory.moved', 'production.scan_recorded', 'production.rework_moved', 'production.scrap_over_limit_decided'],
      async handle(event, { caller }) {
        const key = `costing-post:${event.eventId}`
        let workOrderId: string | null = null
        let scope: PostScope
        if (event.type === 'inventory.moved') {
          const payload = event.payload as { moveId: string; reason: string; reversalOfId: string | null; postedBy: string; valued: boolean; changesValue: boolean }
          if (!COSTED.has(payload.reason)) return
          workOrderId = await caller.withClient(async (db) => {
            const move = await db.stockMove.findUnique({ where: { id: payload.moveId }, select: { workOrderId: true } })
            if (move?.workOrderId) return move.workOrderId
            if (!payload.reversalOfId) return null
            return (await db.stockMove.findUnique({ where: { id: payload.reversalOfId }, select: { workOrderId: true } }))?.workOrderId ?? null
          })
          if (!workOrderId) return
          if (payload.postedBy === 'FLOOR' && !payload.valued && payload.changesValue) await valueMove(caller, payload.moveId, event.eventId)
          scope = { moveIds: [payload.moveId, ...(payload.reversalOfId ? [payload.reversalOfId] : [])] }
        } else if (event.type === 'production.scan_recorded') {
          const payload = event.payload as { workOrderId: string; scanId: string; correctsId: string | null }
          workOrderId = payload.workOrderId
          scope = { scanIds: [payload.scanId, ...(payload.correctsId ? [payload.correctsId] : [])] }
        } else if (event.type === 'production.scrap_over_limit_decided') {
          // B-W2b-53: approved scrap posts now; refused scrap posts nothing (post.ts reads the decision).
          const payload = event.payload as { workOrderId: string; scanId: string; decision: string }
          if (payload.decision !== 'APPROVED') return
          workOrderId = payload.workOrderId
          scope = { scanIds: [payload.scanId] }
        } else {
          const payload = event.payload as { workOrderId: string; reworkId: string; status: string; scrapQuantity: number }
          if (payload.status !== 'DONE' || payload.scrapQuantity === 0) return
          workOrderId = payload.workOrderId
          scope = { reworkIds: [payload.reworkId] }
        }
        await postWorkOrderCosts(caller, workOrderId, { idempotencyKey: key, causationId: event.eventId, scope })
      },
    }),
  ]
}
