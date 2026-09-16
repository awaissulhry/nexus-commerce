/**
 * The forwarder's Amazon Marketing Stream POST (`/api/advertising/marketing-stream/ingest`).
 *
 * The route is PUBLIC (shared-secret), so a request carries no business profile — and every table the
 * three consumers write is profile-scoped. Since business profiles went on (2026-09-16 12:39 UTC) every
 * write threw `workspace_required` inside their catches and the route still answered 200: production
 * saved 0 new hourly rows per hour from 13:00 UTC, where it had saved 10-25. The SQS poller already
 * routed each record to its owner; this is the same rule for the POST path.
 *
 * Each record goes to the profile that owns its Amazon Ads account (`amsRecordAdvertiser` →
 * `verifiedChannelWorkspace`). A record naming no account, or an account no active profile owns, is
 * counted in `unrouted` and logged — never written into a guessed profile.
 */
import { logger } from '../../utils/logger.js'
import { WorkspaceError } from '../../lib/workspace-context.js'
import { verifiedChannelWorkspace, withIngressWorkspace } from '../../lib/workspace-ingress.js'
import { amsRecordAdvertiser, routeRecords } from '../ads-core/ams-dataset.js'
import { flushAdsCache } from './ads-cache.js'
import { ingestMarketingStream, type AmsIngestResult } from './ads-marketing-stream.service.js'
import { ingestBudgetUsage, ingestEntityChanges, type BudgetIngestResult, type ChangeIngestResult } from './ads-stream-change.service.js'

type AmsRecord = Record<string, unknown>

export interface AmsBatchResult {
  received: number
  upserted: number
  skipped: number
  routed: { performance: number; change: number; budget: number; unknownDataset: number }
  change?: ChangeIngestResult
  budget?: BudgetIngestResult
  /** Records whose Amazon Ads account no active business profile owns (or that name no account). */
  unrouted: number
}

function addCounts<T extends object>(total: T | undefined, next: T): T {
  if (!total) return { ...next }
  const sum = { ...total } as Record<string, unknown>
  for (const [key, value] of Object.entries(next)) if (typeof value === 'number') sum[key] = ((sum[key] as number) ?? 0) + value
  return sum as T
}

interface GroupResult { perf: AmsIngestResult | null; change: ChangeIngestResult | null; budget: BudgetIngestResult | null }

async function ingestGroup(records: AmsRecord[]): Promise<GroupResult> {
  const routed = routeRecords(records)
  const perf = routed.performance.length ? await ingestMarketingStream(routed.performance as never) : null
  const change = routed.change.length ? await ingestEntityChanges(routed.change) : null
  const budget = routed.budget.length ? await ingestBudgetUsage(routed.budget) : null
  // Invalidate the ads read cache of the profile just written, while that profile is in scope. The
  // route's onResponse flush has no profile here (and used to reject unhandled).
  if (perf || change || budget) {
    await flushAdsCache().catch((error: unknown) => {
      logger.warn('[ams-ingest] ads cache flush failed', { error: error instanceof Error ? error.message : String(error) })
    })
  }
  return { perf, change, budget }
}

export async function ingestAmsBatch(records: AmsRecord[]): Promise<AmsBatchResult> {
  const routed = routeRecords(records)
  const result: AmsBatchResult = {
    received: records.length,
    upserted: 0,
    skipped: 0,
    routed: { performance: routed.performance.length, change: routed.change.length, budget: routed.budget.length, unknownDataset: routed.unknown.length },
    unrouted: 0,
  }
  const absorb = (group: GroupResult) => {
    result.upserted += group.perf?.upserted ?? 0
    result.skipped += group.perf?.skipped ?? 0
    if (group.change) result.change = addCounts(result.change, group.change)
    if (group.budget) result.budget = addCounts(result.budget, group.budget)
  }

  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') {
    absorb(await ingestGroup(records))
    return result
  }

  const owners = new Map<string, string | null>()
  const groups = new Map<string, AmsRecord[]>()
  const unroutedAccounts = new Set<string>()
  for (const record of records) {
    const account = amsRecordAdvertiser(record)
    if (!account) { result.unrouted += 1; unroutedAccounts.add('(none)'); continue }
    if (!owners.has(account)) {
      try {
        owners.set(account, (await verifiedChannelWorkspace('AMAZON_ADS', account)).workspaceId)
      } catch (error) {
        // Zero or several owners is a routing answer, not an outage. Anything else (database) propagates.
        if (error instanceof WorkspaceError && error.code === 'ingress_account_ambiguous') owners.set(account, null)
        else throw error
      }
    }
    const workspaceId = owners.get(account)
    if (!workspaceId) { result.unrouted += 1; unroutedAccounts.add(account); continue }
    groups.set(workspaceId, [...(groups.get(workspaceId) ?? []), record])
  }
  if (result.unrouted) {
    logger.warn('[ams-ingest] records not saved: no active business profile owns their Amazon Ads account', { unrouted: result.unrouted, accounts: [...unroutedAccounts] })
  }
  for (const [workspaceId, group] of groups) absorb(await withIngressWorkspace(workspaceId, () => ingestGroup(group)))
  return result
}
