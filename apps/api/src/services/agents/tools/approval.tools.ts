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
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { PLAN_TOOL, type AgentTool } from '../tool-types.js'
import { planView } from '../change-plan.service.js'
import { campaignStructureCounts } from '../../advertising/ads-entity-lookup.service.js'

/** Each stored status, said plainly: the model repeats it to a person. */
const MEANING: Record<string, string> = {
  pending: 'Waiting for a person to approve or reject it in Nexus. Nothing has changed yet.',
  scheduled: 'Approved. It runs when the short undo window closes.',
  executing: 'Approved, and running now.',
  // MCP.12 — "done" was said while the marketplace pushes it queued were still waiting. What an executed change
  // did beyond Nexus depends on the tool: executedMeaning says it per tool.
  executed: 'Approved, and it ran.',
  approved: 'Approved. This tool only previews, so nothing ran.',
  rejected: 'A person rejected it. Nothing changed.', // outcomeOf says who, and their words when they gave some
  expired: 'Nobody decided in time. Nothing changed.',
  superseded: 'A person replaced it with an edited request.',
}

/**
 * Approvals grid (2026-10-05) — what became of a request that did NOT simply wait or run, said so Claude can tell the
 * person plainly: rejected (with the person's words when they gave some — a reject reason is optional), withdrawn by
 * Nexus, replaced by an edited request (and which), approved but handed back without running (and why), or approved,
 * tried and failed (and why). Null for every other state, which MEANING says on its own.
 */
export interface Outcome {
  meaning: string
  /** The person's own words on a reject; absent when they gave none. */
  rejectedReason?: string
  /** The edited request that replaced this one: follow it with approval-status. */
  replacedBy?: string
  /** Why an approved request was handed back to a person without running. */
  handedBack?: string
  /** Why an approved request failed when Nexus ran it. */
  failed?: string
}

const HANDED_BACK = /^not run(?: by rule)? — /
const FAILED = /^execution (?:failed|error): /

export function outcomeOf(ap: {
  status: string
  reason: string | null
  operatorNote: string | null
  decidedBy: string | null
}, replacedBy: string | null = null): Outcome | null {
  const reason = ap.reason ?? ''
  if (ap.status === 'rejected') {
    if (reason.startsWith('withdrawn:')) {
      return { meaning: `Nexus withdrew it (${reason.replace(/^withdrawn:\s*/, '')}). Nothing changed.` }
    }
    const who = ap.decidedBy ?? 'A person'
    const words = ap.operatorNote?.trim()
    return words
      ? { meaning: `${who} rejected it, saying: "${words}". Nothing changed.`, rejectedReason: words }
      : { meaning: `${who} rejected it without giving a reason. Nothing changed.` }
  }
  if (ap.status === 'superseded') {
    return replacedBy
      ? { meaning: `A person edited it before approving, so it was replaced by a new request (${replacedBy}). Nothing ran from this one; call approval-status with replacedBy to follow the new one.`, replacedBy }
      : { meaning: 'A person edited it before approving, so it was replaced by a new request. Nothing ran from this one.' }
  }
  if (ap.status === 'pending' && HANDED_BACK.test(reason)) {
    const why = reason.replace(HANDED_BACK, '')
    return {
      meaning: `It was approved, but Nexus did not run it: ${why}. Nothing changed; it waits for a person to approve or reject it again.`,
      handedBack: why,
    }
  }
  if (ap.status === 'pending' && FAILED.test(reason)) {
    const why = reason.replace(FAILED, '')
    return {
      meaning: `It was approved and Nexus tried to run it, but it failed: ${why}. It waits for a person to approve it again or reject it.`,
      failed: why,
    }
  }
  return null
}

/** The request that replaced an edited one: the edit's audit row names both (agent-fleet-approvals amend, amendPlan). */
async function replacementOf(approvalId: string): Promise<string | null> {
  const edit = await prisma.agentControlAudit.findFirst({
    where: { action: 'amend_action', fromValue: { path: ['approvalId'], equals: approvalId } },
    orderBy: { createdAt: 'desc' },
    select: { toValue: true },
  })
  const next = (edit?.toValue as { approvalId?: unknown } | null)?.approvalId
  return typeof next === 'string' ? next : null
}

/**
 * MCP.12 — the tools whose approved change is sent on to a marketplace by the outbound queue: which rows they queue
 * (masterPriceService's price pushes) and the products their arguments name. publish-listing queues nothing since L5:
 * it publishes through the studio, and its publication says what became of it (publishedMeaning).
 */
const QUEUED_BY: Record<string, { syncType: string; source: string; what: string; products: string }> = {
  'set-price': { syncType: 'PRICE_UPDATE', source: 'MASTER_PRICE_CHANGE', what: 'price update', products: 'this product' },
  'bulk-price-change': { syncType: 'PRICE_UPDATE', source: 'MASTER_PRICE_CHANGE', what: 'price update', products: 'these products' },
  'set-master-prices': { syncType: 'PRICE_UPDATE', source: 'MASTER_PRICE_CHANGE', what: 'price update', products: 'these products' },
}

/** MCP full control L5 — what an executed publish-listing did: its studio publication, by the status Nexus stored. */
export function publishedMeaning(status: string | null): string {
  const head = 'Approved: it was published through the Nexus studio, as the person who approved it.'
  switch (status) {
    case 'SUBMITTED': return `${head} Amazon is processing the feed; the listing is not confirmed live yet.`
    case 'UNVERIFIED': return `${head} The channel acknowledged it, but its live status is not confirmed yet.`
    case 'PUBLISHING': return `${head} The channel is processing it.`
    case 'ACCEPTED': case 'VERIFIED': return `${head} The channel accepted it.`
    case 'PARTIAL': return `${head} The channel rejected some of its products: publication-status names them.`
    case 'FAILED': return `${head} The channel rejected it: publication-status says why.`
    default: return `${head} publication-status reads its result.`
  }
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
    : toolName === 'set-master-prices'
      ? (Array.isArray(args.prices) ? args.prices.map((p) => (p as { product?: unknown })?.product).filter((r): r is string => typeof r === 'string') : [])
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
export async function channelQueueOf(toolName: string, args: Record<string, unknown>, decidedAt: Date | null): Promise<ChannelQueue | null> {
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

// ── MCP full control A9 — what an approved ad change did at Amazon (and eBay) ─────────────────────────

/** The Amazon ad tools whose writes carry their approval as change set (changeSetId = approvalId). */
const AD_CHANGE_TOOLS = new Set([
  'set-target-bid', 'create-negative-keyword', 'graduate-keyword', 'set-campaign-budget', 'set-placement-multipliers',
  'bulk-ad-bid-change', 'suppress-campaign', 'restore-campaign', 'undo-ad-change',
  // A11 — its creates are not queued: approval-status counts what it created and how much of it Amazon holds.
  'create-ad-campaign',
  // AA-W2-12/13 — a pause, an enable and an archive: one status write per ad.
  'pause-ads', 'enable-ads', 'archive-ads',
  // W3-3 — a stock lowering and its give-back: one bid write per bid moved.
  'lower-ad-bids-for-stock', 'restore-ad-bids-after-stock',
  // PB-5a — a playbook build: its creates run detached; approval-status reads its run (status, what Amazon holds).
  'apply-ads-playbook',
  // B-1 — a Replicate run, likewise.
  'replicate-ad-structure',
  // B-2 — an AI goal's campaigns: created at once, not queued; approval-status counts them and how much Amazon holds.
  'create-ai-goal-campaigns',
  // B-3 — a one-off SP Super Wizard set: its creates run detached too; approval-status reads its run the same way.
  'build-sp-wizard-campaigns',
  // W4-5 — targets, negatives and a harvest are created at once (approval-status counts them and how many Amazon holds); a
  // retire is one queued archive per negative. (set-harvest-destination is Nexus only: no ad write to follow.)
  'add-ad-targets', 'add-negative-targets', 'harvest-search-term', 'retire-negatives',
])

export interface AdDelivery {
  /** Where the person was told it lands (the approved preview): live at Amazon, or sandbox. */
  reach: 'live' | 'sandbox' | null
  writes: number
  waiting: number
  sent: number
  refusedByGate: number
  failed: number
  notSent: number
  /** W4-5 — of `notSent`: Nexus-only records removed (a retire of a negative Amazon never held) — done in Nexus, nothing to send. */
  nexusOnly?: number
  /** The write gate's own words, for the refused ones (at most 3): money may be named, so it is a money key. */
  gateReasons?: string[]
  /** Negatives and keywords the request created: how many exist at Amazon (they are created at once, not queued). */
  created?: { total: number; atAmazon: number }
  /** PB-5a — a playbook build's run (B-1: or a Replicate run's; B-3: or a one-off SP Super Wizard set's): its status and how far it is (the creates run detached). */
  build?: { applicationId: string; status: string; done: number | null; total: number | null; campaigns: number; errors: number; stopped?: boolean }
}

/** One queue row's (or an inline write's) outcome, in the five words a person uses. */
function deliveryWord(row: { syncStatus?: string | null; errorCode?: string | null; amazonResponseStatus?: string | null }): keyof Pick<AdDelivery, 'waiting' | 'sent' | 'refusedByGate' | 'failed' | 'notSent'> {
  if (row.syncStatus) {
    if (row.syncStatus === 'SKIPPED' && row.errorCode === 'WRITE_GATE_DENIED') return 'refusedByGate'
    if (row.syncStatus === 'PENDING' || row.syncStatus === 'IN_PROGRESS') return 'waiting'
    if (row.syncStatus === 'SUCCESS') return 'sent'
    if (row.syncStatus === 'FAILED') return 'failed'
    return 'notSent'
  }
  if (row.amazonResponseStatus === 'SUCCESS') return 'sent'
  if (row.amazonResponseStatus === 'FAILED') return 'failed'
  // W4-5 — an inline write never sent (a Nexus-only record removed) is done, not waiting.
  if (row.amazonResponseStatus === 'SKIPPED' || row.amazonResponseStatus === 'CANCELLED' || row.amazonResponseStatus === 'SUPERSEDED') return 'notSent'
  return 'waiting'
}

/** W4-5 — an audit row of a Nexus-only record removed (retire-negatives' local path): never sent, done in Nexus. */
function removedInNexusOnly(log: { outboundQueueId: string | null; amazonResponseStatus: string | null; payloadAfter: unknown }): boolean {
  return !log.outboundQueueId && log.amazonResponseStatus === 'SKIPPED' && (log.payloadAfter as { delivery?: unknown } | null)?.delivery === 'not_applicable'
}

/**
 * A9 — the writes an approved ad change made, by their change set (= the approval id): each queued write by its
 * outbound row (waiting, sent, refused by the write gate in the worker, failed, not sent), each inline write by its
 * audit row, and the negatives / keywords it created by whether Amazon gave them an id. Business-scoped like every
 * read here. Null when the approval's tool writes ads nowhere.
 */
export async function adDeliveryOf(approvalId: string, toolName: string, preview: unknown): Promise<AdDelivery | null> {
  if (!AD_CHANGE_TOOLS.has(toolName)) return null
  const reach = ((preview as { reach?: { reach?: unknown } } | null)?.reach?.reach ?? null) as AdDelivery['reach']
  const logs = await prisma.advertisingActionLog.findMany({
    where: { executionId: approvalId },
    select: { outboundQueueId: true, amazonResponseStatus: true, payloadAfter: true },
  })
  const queueIds = logs.map((l) => l.outboundQueueId).filter((id): id is string => !!id)
  const queued = queueIds.length
    ? await prisma.outboundSyncQueue.findMany({ where: { id: { in: queueIds } }, select: { id: true, syncStatus: true, errorCode: true, errorMessage: true } })
    : []
  const byId = new Map(queued.map((q) => [q.id, q]))
  const out: AdDelivery = { reach, writes: logs.length, waiting: 0, sent: 0, refusedByGate: 0, failed: 0, notSent: 0 }
  const reasons: string[] = []
  for (const log of logs) {
    const q = log.outboundQueueId ? byId.get(log.outboundQueueId) : undefined
    const word = deliveryWord(q ? { syncStatus: q.syncStatus, errorCode: q.errorCode } : { amazonResponseStatus: log.amazonResponseStatus })
    out[word]++
    if (word === 'notSent' && !q && removedInNexusOnly(log)) out.nexusOnly = (out.nexusOnly ?? 0) + 1
    if (word === 'refusedByGate' && q?.errorMessage && reasons.length < 3) reasons.push(q.errorMessage.replace(/^\[ADS-WRITE-GATE-DENY\]\s*/, ''))
  }
  if (reasons.length) out.gateReasons = reasons
  const change = await prisma.agentChange.findFirst({ where: { approvalId }, orderBy: { executedAt: 'desc' }, select: { after: true } })
  const after = (change?.after ?? null) as { negatives?: Array<{ targetId?: unknown }>; targetId?: unknown; campaignId?: unknown } | null
  if (toolName === 'apply-ads-playbook' || toolName === 'build-sp-wizard-campaigns' || toolName === 'replicate-ad-structure') {
    // PB-5a — a build (B-3: a one-off SP Super Wizard set too): its run row, and everything its campaigns hold ("at Amazon"
    // only when it went live). B-1 — a Replicate run is read the same way, from its own run row.
    const applicationId = (after as { applicationId?: unknown } | null)?.applicationId
    if (typeof applicationId !== 'string') return out
    const run = toolName === 'replicate-ad-structure'
      ? await (await import('../../advertising/ads-blueprint-apply.service.js')).replicateRunDelivery(applicationId)
      : await (await import('../../advertising/ads-playbook/build.js')).buildRunDelivery(applicationId)
    if (!run) return out
    out.build = { applicationId, status: run.status, done: run.done, total: run.total, campaigns: run.createdCampaignIds.length, errors: run.errors, ...(run.stopped ? { stopped: true } : {}) }
    let total = 0, atAmazon = 0
    for (const id of run.createdCampaignIds) {
      const counts = await campaignStructureCounts(id)
      total += counts.total
      atAmazon += reach === 'live' ? counts.withAmazonId : 0
    }
    out.created = { total, atAmazon }
    return out
  }
  if (toolName === 'create-ai-goal-campaigns') {
    // B-2 — every campaign of the goal and everything under them; "at Amazon" only when it went live.
    const goal = after as { campaignIds?: unknown; notAtAmazon?: unknown } | null
    const ids = [...(Array.isArray(goal?.campaignIds) ? goal!.campaignIds : []), ...(Array.isArray(goal?.notAtAmazon) ? goal!.notAtAmazon : [])].filter((id): id is string => typeof id === 'string')
    let total = 0, atAmazon = 0
    for (const id of ids) {
      const counts = await campaignStructureCounts(id)
      total += counts.total
      atAmazon += reach === 'live' ? counts.withAmazonId : 0
    }
    if (ids.length) out.created = { total, atAmazon }
    return out
  }
  if (toolName === 'create-ad-campaign') {
    // A11 — the campaign and everything under it; "at Amazon" only when it went live (a sandbox id is not Amazon's).
    if (typeof after?.campaignId === 'string') {
      const counts = await campaignStructureCounts(after.campaignId)
      out.created = { total: counts.total, atAmazon: reach === 'live' ? counts.withAmazonId : 0 }
    }
    return out
  }
  // W4-5 — what the list tools and a harvest created (a harvest's undo op creates nothing).
  const made = after as { targets?: Array<{ targetId?: unknown }>; keyword?: { targetId?: unknown } | null; negative?: { targetId?: unknown } | null } | null
  const createdIds = toolName === 'create-negative-keyword' || toolName === 'add-negative-targets'
    ? (after?.negatives ?? []).map((n) => String(n.targetId ?? '')).filter(Boolean)
    : toolName === 'graduate-keyword' && typeof after?.targetId === 'string' ? [after.targetId]
      : toolName === 'add-ad-targets' ? (made?.targets ?? []).map((t) => String(t.targetId ?? '')).filter(Boolean)
        : toolName === 'harvest-search-term' ? [made?.keyword?.targetId, made?.negative?.targetId].filter((id): id is string => typeof id === 'string')
          : []
  if (createdIds.length) {
    const atAmazon = reach === 'live'
      ? await prisma.adTarget.count({ where: { id: { in: createdIds }, externalTargetId: { not: null } } })
      : 0
    out.created = { total: createdIds.length, atAmazon }
  }
  return out
}

/** The eBay ad tools: each CampaignAction they write carries their approval as `executionId` (A14/A15). */
const EBAY_AD_TOOLS = new Set(['set-ebay-ad-rates', 'promote-ebay-listings', 'set-ebay-campaign-budget', 'ebay-keywords-change', 'create-ebay-campaign'])

export interface EbayDelivery {
  writes: number
  /** Reached eBay (its answer recorded). */
  sent: number
  /** Recorded in Nexus only: eBay ad writes were off (sandbox), so nothing reached eBay. */
  sandbox: number
  /** Some items of one write reached eBay, some did not. */
  partly: number
  failed: number
  waiting: number
}

/**
 * A9 — eBay ad writes made by this approval (CampaignAction.executionId), when an eBay ad tool ran it. A14 — a write
 * the eBay layer ran in sandbox (`_mode` in its payload) is counted as such: it never reached eBay.
 */
export async function ebayDeliveryOf(approvalId: string): Promise<EbayDelivery | null> {
  const rows = await prisma.campaignAction.findMany({ where: { executionId: approvalId, channel: 'EBAY' }, select: { channelResponseStatus: true, payloadAfter: true } })
  if (!rows.length) return null
  const out: EbayDelivery = { writes: 0, sent: 0, sandbox: 0, partly: 0, failed: 0, waiting: 0 }
  for (const r of rows) {
    out.writes++
    const sandboxed = (r.payloadAfter as { _mode?: unknown } | null)?._mode === 'sandbox'
    if (r.channelResponseStatus === 'FAILED') out.failed++
    else if (r.channelResponseStatus === 'SUCCESS') out[sandboxed ? 'sandbox' : 'sent']++
    else if (r.channelResponseStatus === 'PARTIAL') out[sandboxed ? 'sandbox' : 'partly']++
    else out.waiting++
  }
  return out
}

/** A14 — what an executed eBay ad change did, in a sentence: in Nexus, then at eBay. */
export function ebayMeaning(d: EbayDelivery | null): string {
  if (!d || !d.writes) return 'Approved and run. No eBay ad write was recorded for it.'
  const parts = [
    d.sent ? `${d.sent} sent` : '',
    d.partly ? `${d.partly} partly sent (some items refused)` : '',
    d.failed ? `${d.failed} failed` : '',
    d.waiting ? `${d.waiting} with no answer recorded` : '',
  ].filter(Boolean)
  const sandbox = d.sandbox ? ` Sandbox: ${plural(d.sandbox, 'write')} recorded in Nexus only — eBay ad writes are off, so nothing reached eBay.` : ''
  return `Approved and written in Nexus.${parts.length ? ` eBay: ${parts.join(', ')} (of ${plural(d.writes, 'write')}).` : ''}${sandbox}`
}

/** PB-5a / B-1 — where a detached run (a playbook build, a Replicate run) is, in a sentence. */
function runWords(b: NonNullable<AdDelivery['build']>): string {
  const of = b.total != null ? ` (${b.done ?? 0} of ${plural(b.total, 'campaign')} done)` : ''
  if (b.stopped) {
    return `The run stopped without finishing${of}: a deploy or a restart stopped it and it does not resume; archive-ads buildRunId ${b.applicationId} archives what it made.`
  }
  if (b.status === 'RUNNING') return `The run is still going${of}: ask again to follow it.`
  if (b.status === 'APPLIED') return `The run finished: ${plural(b.campaigns, 'campaign')} made.`
  if (b.status === 'PARTIAL') return `The run finished in part: ${plural(b.campaigns, 'campaign')} made, ${plural(b.errors, 'problem')} recorded.`
  if (b.status === 'FAILED') return `The run failed: ${plural(b.campaigns, 'campaign')} made, ${plural(b.errors, 'error')} recorded.`
  if (b.status === 'ROLLED_BACK') return 'The run was rolled back: its campaigns were archived.'
  return `The run is ${b.status.toLowerCase()}.`
}

/** A9 — what an executed ad change did, in a sentence: in Nexus, then at Amazon. */
export function adMeaning(d: AdDelivery): string {
  // PB-5a / B-1 — a build or a Replicate run runs on its own after approval: say where the run is, never only "run".
  if (d.build) {
    const created = d.created ? ` In Nexus: ${d.created.total} created${d.reach === 'sandbox' ? '' : `, ${d.created.atAmazon} of them confirmed at Amazon`}.` : ''
    const sandbox = d.reach === 'sandbox' ? ' Sandbox: Amazon ads writes are not live, so nothing was sent to Amazon.' : ''
    return `Approved. ${runWords(d.build)}${created}${sandbox}`
  }
  if (d.reach === 'sandbox') {
    const what = !d.writes && d.created ? `${d.created.total} created` : plural(d.writes, 'write')
    return `Approved and written in Nexus (${what}). Sandbox: Amazon ads writes are not live, so nothing was sent to Amazon.`
  }
  const parts = [
    d.sent ? `${d.sent} sent` : '',
    d.waiting ? `${d.waiting} waiting to be sent (a queued ad write waits out a 5-minute cancel window)` : '',
    d.refusedByGate ? `${d.refusedByGate} refused by the write gate` : '',
    d.failed ? `${d.failed} failed` : '',
    d.notSent - (d.nexusOnly ?? 0) ? `${d.notSent - (d.nexusOnly ?? 0)} not sent (skipped or cancelled)` : '',
    d.nexusOnly ? `${d.nexusOnly} removed in Nexus only (Amazon never held ${d.nexusOnly === 1 ? 'it' : 'them'}: nothing to send)` : '',
  ].filter(Boolean)
  const created = d.created ? ` Created ${d.created.total}, ${d.created.atAmazon} of them confirmed at Amazon.` : ''
  if (!d.writes) return `Approved and run.${created}`.trim()
  return `Approved and written in Nexus. Amazon: ${parts.join(', ')} (of ${plural(d.writes, 'write')}).${created}`
}

const approvalStatus: AgentTool = {
  name: 'approval-status',
  title: 'Approval status',
  input: z.object({ approvalId: z.string().min(1).describe('the approvalId a change tool returned') }),
  requires: [F.aiView],
  // A9 — the write gate's words for a refused ad write can name an amount.
  restrictedFields: { gateReasons: FIELDS.financialsAdspendView },
  category: 'approvals',
  riskTier: 'low',
  readOnly: true,
  description:
    'Check a change that was queued for approval: whether a person approved or rejected it, when, and when it expires. '
    + 'A rejected one says so, with the person\'s words in rejectedReason when they gave a reason; one replaced by an '
    + 'edit names the new request in replacedBy; one approved but handed back without running says why in handedBack; '
    + 'one that failed when it ran says why in failed (both wait for a person again). '
    + 'For an approved change that is sent on to a marketplace (a price change, a publish), channels counts the queue rows '
    + 'it made: waiting to be sent, sent, failed. For an approved ad change, ads counts its writes at Amazon: waiting, '
    + 'sent, refused by the write gate, failed (or says it ran in sandbox), and ebay counts eBay ad writes. For an approved '
    + 'publish, publication names its studio publication and its status (publication-status reads it in full). Once it ran, '
    + 'change.changeId names the change for undo-change. For a change plan, plan says what became of each step (done, '
    + 'skipped with its reason, failed).',
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
        operatorNote: true,
        preview: true,
        args: true,
      },
    })
    if (!ap) return { ok: false, error: 'Approval not found' }
    // Approvals grid — rejected (and why), replaced by an edit (and by which), handed back or failed (and why).
    const outcome = outcomeOf(ap, ap.status === 'superseded' ? await replacementOf(ap.id) : null)
    const preview = ap.preview == null ? null : (ctx.storedOutput?.(ap.toolName, ap.preview) ?? null)
    const asked = (ap.args && typeof ap.args === 'object' && !Array.isArray(ap.args) ? ap.args : {}) as Record<string, unknown>
    const channels = ap.status === 'executed' ? await channelQueueOf(ap.toolName, asked, ap.decidedAt) : null
    // A9 — an ad change's writes at Amazon, by its change set; eBay ad writes by theirs.
    const ads = ap.status === 'executed' ? await adDeliveryOf(ap.id, ap.toolName, ap.preview) : null
    const ebay = ap.status === 'executed' ? await ebayDeliveryOf(ap.id) : null
    // C2 — the change it made, once it ran: undo-change takes its changeId.
    // C6 — a plan: each step's fate (the first 20), and the counts.
    const plan = ap.toolName === PLAN_TOOL ? await planView(ap.id, { limit: 20 }) : null
    const recorded = ap.status === 'executed' && !plan
      ? await prisma.agentChange.findFirst({
          where: { approvalId: ap.id },
          orderBy: { executedAt: 'desc' },
          select: { id: true, reversibility: true, undoneAt: true, undoneByApprovalId: true, after: true },
        })
      : null
    // L5 — a publish's publication, as Nexus stored it (a pure read; it settles through the sweep or the studio).
    const publicationId = ap.toolName === 'publish-listing' ? (recorded?.after as { publicationId?: unknown } | null)?.publicationId : undefined
    const stored = typeof publicationId === 'string' ? await (await import('../../pim/studio-publication.service.js')).readStoredPublication(publicationId) : null
    const publication = typeof publicationId === 'string'
      ? { publicationId, status: stored?.status ?? null, settled: !!stored && !['PREVIEW', 'PUBLISHING', 'SUBMITTED', 'UNVERIFIED'].includes(stored.status) }
      : null
    return {
      ok: true,
      data: {
        approvalId: ap.id,
        tool: ap.toolName,
        status: ap.status,
        meaning: outcome ? outcome.meaning
          : ap.status !== 'executed' ? (MEANING[ap.status] ?? null)
          : publication ? publishedMeaning(publication.status)
          : ads ? adMeaning(ads) : EBAY_AD_TOOLS.has(ap.toolName) ? ebayMeaning(ebay) : executedMeaning(ap.toolName, channels),
        ...(outcome?.rejectedReason ? { rejectedReason: outcome.rejectedReason } : {}),
        ...(outcome?.replacedBy ? { replacedBy: outcome.replacedBy } : {}),
        ...(outcome?.handedBack ? { handedBack: outcome.handedBack } : {}),
        ...(outcome?.failed ? { failed: outcome.failed } : {}),
        ...(channels ? { channels } : {}),
        ...(ads ? { ads } : {}),
        ...(ebay ? { ebay } : {}),
        ...(publication ? { publication } : {}),
        ...(plan
          ? {
              plan: {
                title: plan.title,
                summary: plan.summary,
                planHash: plan.planHash,
                steps: plan.steps,
                byStatus: plan.byStatus,
                list: plan.list.map(({ step, tool, status, reason, changeId }) => ({ step, tool, status, reason, changeId })),
                ...(plan.steps > plan.list.length ? { moreSteps: plan.steps - plan.list.length } : {}),
              },
            }
          : {}),
        ...(recorded
          ? {
              change: {
                changeId: recorded.id,
                reversibility: recorded.reversibility,
                undoneAt: recorded.undoneAt,
                undoneByApprovalId: recorded.undoneByApprovalId,
              },
            }
          : {}),
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
