/**
 * MCP.7 — what became of a change that waits for a person's decision.
 *
 * Claude cannot approve anything (D1 = A): a change it asks for is queued, and a person decides
 * in the Nexus Approvals page. `approval-status` lets it follow up. It reads approvals of the
 * caller's own business only (call-tool.ts binds it, the row-level policy holds it), and shows
 * the stored preview only to a caller who may use the tool that made it, filtered for money.
 */

import prisma from '../../../db.js'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool } from '../tool-types.js'

/** Each stored status, said plainly: the model repeats it to a person. */
const MEANING: Record<string, string> = {
  pending: 'Waiting for a person to approve or reject it in Nexus. Nothing has changed yet.',
  scheduled: 'Approved. It runs when the short undo window closes.',
  executing: 'Approved, and running now.',
  // MCP.12 — "done" was said while the marketplace pushes it queued were still waiting. What an executed change
  // did beyond Nexus depends on the tool: executedMeaning says it per tool.
  executed: 'Approved, and it ran.',
  approved: 'Approved. This tool only previews, so nothing ran.',
  rejected: 'A person rejected it. Nothing changed.',
  expired: 'Nobody decided in time. Nothing changed.',
  superseded: 'A person replaced it with an edited request.',
}

/**
 * MCP.12 — the tools whose approved change is sent on to a marketplace by the outbound queue: which rows they queue
 * (masterPriceService's price pushes; publish-listing's LISTING_SYNC) and the products their arguments name.
 */
const QUEUED_BY: Record<string, { syncType: string; source: string; what: string; products: string }> = {
  'set-price': { syncType: 'PRICE_UPDATE', source: 'MASTER_PRICE_CHANGE', what: 'price update', products: 'this product' },
  'bulk-price-change': { syncType: 'PRICE_UPDATE', source: 'MASTER_PRICE_CHANGE', what: 'price update', products: 'these products' },
  'publish-listing': { syncType: 'LISTING_SYNC', source: 'AGENT_PUBLISH', what: 'publish', products: 'this product' },
}

/** A queue row's state, in the words a person uses. */
const QUEUE_STATE: Record<string, 'waiting' | 'sent' | 'failed' | 'notSent'> = {
  PENDING: 'waiting',
  IN_PROGRESS: 'waiting',
  SUCCESS: 'sent',
  FAILED: 'failed',
  SKIPPED: 'notSent',
  CANCELLED: 'notSent',
}

/** The approval's products, in this business: ids first, then SKUs (bulk-price-change takes either). */
async function productIdsOf(toolName: string, args: Record<string, unknown>): Promise<string[]> {
  const refs = toolName === 'bulk-price-change'
    ? (Array.isArray(args.products) ? args.products.filter((r): r is string => typeof r === 'string') : [])
    : typeof args.productId === 'string' ? [args.productId] : []
  if (!refs.length) return []
  const rows = await prisma.product.findMany({ where: { OR: [{ id: { in: refs } }, { sku: { in: refs } }] }, select: { id: true } })
  return rows.map((row) => row.id)
}

/** Clock margin between the decision and the rows its run creates (the queue rows take the database's time). */
const QUEUE_CLOCK_MARGIN_MS = 2000

export interface ChannelQueue {
  queued: number
  waiting: number
  sent: number
  failed: number
  notSent: number
}

/**
 * MCP.12 — the queue rows an executed change created, counted by state. The queue does not record which approval made a
 * row, so it counts this tool's kind of row for the approval's products created since the decision; business-scoped
 * by the row-level policy like every read here.
 */
async function channelQueueOf(toolName: string, args: Record<string, unknown>, decidedAt: Date | null): Promise<ChannelQueue | null> {
  const kind = QUEUED_BY[toolName]
  if (!kind || !decidedAt) return null
  const ids = await productIdsOf(toolName, args)
  const counts: ChannelQueue = { queued: 0, waiting: 0, sent: 0, failed: 0, notSent: 0 }
  if (!ids.length) return counts
  const rows = await prisma.outboundSyncQueue.groupBy({
    by: ['syncStatus'],
    where: {
      productId: { in: ids },
      syncType: kind.syncType,
      createdAt: { gte: new Date(decidedAt.getTime() - QUEUE_CLOCK_MARGIN_MS) },
      payload: { path: ['source'], equals: kind.source },
    },
    _count: { _all: true },
  })
  for (const row of rows) {
    const n = row._count._all
    counts.queued += n
    counts[QUEUE_STATE[row.syncStatus] ?? 'notSent'] += n
  }
  return counts
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** MCP.12 — what an executed change did, said per tool: in Nexus, and what it queued to the channels. */
export function executedMeaning(toolName: string, queue: ChannelQueue | null): string {
  if (toolName === 'bulk-attribute-change') {
    return 'Approved and applied in Nexus. Nothing was sent to a marketplace: Amazon, eBay, Shopify and Etsy change only when someone publishes from Nexus.'
  }
  const kind = QUEUED_BY[toolName]
  if (!kind || !queue) return MEANING.executed
  const head = kind.syncType === 'PRICE_UPDATE' ? 'Approved and applied in Nexus: the master price changed.' : 'Approved: the publish was queued in Nexus.'
  if (queue.queued === 0) {
    return kind.syncType === 'PRICE_UPDATE'
      ? `${head} No price update was queued to a marketplace for ${kind.products}: no listing follows the master price, or each one is paused, has its own price, or sells in another currency.`
      : `${head} No publish for this product is in the outbound queue now.`
  }
  const states = [
    queue.waiting ? `${queue.waiting} waiting to be sent` : '',
    queue.sent ? `${queue.sent} sent` : '',
    queue.failed ? `${queue.failed} failed` : '',
    queue.notSent ? `${queue.notSent} not sent (skipped or cancelled)` : '',
  ].filter(Boolean).join(', ')
  const next = queue.waiting ? 'The channels update next' : 'The outbound queue has handled them'
  return `${head} ${next}: ${plural(queue.queued, kind.what)} ${queue.queued === 1 ? 'was' : 'were'} queued for ${kind.products} since it was approved — ${states}.`
}

const approvalStatus: AgentTool = {
  name: 'approval-status',
  title: 'Approval status',
  input: z.object({ approvalId: z.string().min(1).describe('the approvalId a change tool returned') }),
  requires: [F.aiView],
  category: 'approvals',
  riskTier: 'low',
  readOnly: true,
  description:
    'Check a change that was queued for approval: whether a person approved or rejected it, when, and when it expires. '
    + 'For an approved change that is sent on to a marketplace (a price change, a publish), channels counts the queue rows '
    + 'it made: waiting to be sent, sent, failed.',
  async handler(args, ctx) {
    const id = String(args.approvalId ?? '')
    if (!id) return { ok: false, error: 'approvalId is required' }
    const ap = await prisma.agentApproval.findUnique({
      where: { id },
      select: {
        id: true,
        toolName: true,
        status: true,
        requestedAt: true,
        expiresAt: true,
        decidedAt: true,
        decidedBy: true,
        executeAfter: true,
        reason: true,
        preview: true,
        args: true,
      },
    })
    if (!ap) return { ok: false, error: 'Approval not found' }
    const preview = ap.preview == null ? null : (ctx.storedOutput?.(ap.toolName, ap.preview) ?? null)
    const asked = (ap.args && typeof ap.args === 'object' && !Array.isArray(ap.args) ? ap.args : {}) as Record<string, unknown>
    const channels = ap.status === 'executed' ? await channelQueueOf(ap.toolName, asked, ap.decidedAt) : null
    return {
      ok: true,
      data: {
        approvalId: ap.id,
        tool: ap.toolName,
        status: ap.status,
        meaning: ap.status === 'executed' ? executedMeaning(ap.toolName, channels) : (MEANING[ap.status] ?? null),
        ...(channels ? { channels } : {}),
        requestedAt: ap.requestedAt,
        expiresAt: ap.expiresAt,
        decidedAt: ap.decidedAt,
        decidedBy: ap.decidedBy,
        runsAt: ap.executeAfter,
        note: ap.reason,
        preview,
        ...(ap.preview != null && preview === null
          ? { previewHidden: `The preview needs the permissions of ${ap.toolName}.` }
          : {}),
      },
    }
  },
}

export const APPROVAL_TOOLS: AgentTool[] = [approvalStatus]
