import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { describeSweep, runResumableSweep, type SweepReport } from '../services/pim/resumable-sweep.js'
import { recordChannelReadback } from '../services/channel-drift.service.js'
import { amazonContentOurs, type OursResult } from '../services/channel-drift/amazon-content-ours.js'
import { AMAZON_CONTENT_SOURCE, compareAmazonAttributes, compareAmazonContent, mergeComparisons } from '../services/channel-drift/amazon-content-compare.js'

/**
 * PLAN A-39 (R-41) — Step 3.5b slice b1: a bounded, ROTATING nightly read of what Amazon holds for each listing's content
 * and mapped attributes, compared with what Nexus would send, into `ChannelDrift` (source `amazon-content`).
 *
 * Read only: nothing is written to Amazon or to any listing's content (R-34). The run is the A-30 pattern:
 *   · due = never checked by THIS source, then the oldest check (`ChannelDrift.checkedBySource['amazon-content'].at`),
 *     so a catalogue above one night's budget refreshes every ⌈listings ÷ listings-per-night⌉ nights — never the same
 *     first N every night;
 *   · `countOutstanding` is the same predicate, so the dry run prints a real due count;
 *   · 10-minute budget per business per night (the clustered cron runs once per active business), batch 25;
 *   · ≤ 1 Amazon read a second: 20% of the account's listings-read bucket (5/s, `gateway/rate.ts`); live publishing
 *     keeps the rest.
 * A listing that cannot be compared (404, no schema, a resolver error, an unreviewed draft) is recorded as NOT COMPARED
 * with its reason — never as clean.
 */
const NIGHTLY_BUDGET_MS = 10 * 60_000
/** 20 h, not 24: the next night must find last night's work due again (the readiness job's reasoning). */
const DUE_AFTER_MS = 20 * 60 * 60_000
/** The pace: at most one Amazon listing read a second. */
export const MIN_READ_GAP_MS = 1_000

type Clock = { at?: string }
const clockOf = (checkedBySource: unknown): number | null => {
  const at = (checkedBySource as Record<string, Clock> | null | undefined)?.[AMAZON_CONTENT_SOURCE]?.at
  const ms = at ? Date.parse(at) : NaN
  return Number.isFinite(ms) ? ms : null
}

/** Every Amazon listing that exists on Amazon (an ASIN, live or inactive) and is due, NEVER CHECKED first, then the OLDEST. */
async function dueListings(dueBefore: Date): Promise<string[]> {
  const due: Array<{ id: string; at: number }> = []
  let cursor: string | undefined
  while (true) {
    const page = await prisma.channelListing.findMany({
      where: { channel: 'AMAZON', externalListingId: { not: null }, channelConnectionId: { not: null }, listingStatus: { in: ['ACTIVE', 'INACTIVE'] }, product: { deletedAt: null } },
      select: { id: true }, orderBy: { id: 'asc' }, take: 200, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (!page.length) break
    cursor = page[page.length - 1].id
    const ids = page.map(p => p.id)
    const clocks = new Map((await prisma.channelDrift.findMany({ where: { channelListingId: { in: ids } }, select: { channelListingId: true, checkedBySource: true } }))
      .map(r => [r.channelListingId, clockOf(r.checkedBySource)]))
    for (const id of ids) {
      const at = clocks.get(id) ?? null
      if (at === null || at < dueBefore.getTime()) due.push({ id, at: at ?? -Infinity })
    }
    if (page.length < 200) break
  }
  return due.sort((a, b) => (a.at === b.at ? 0 : a.at - b.at)).map(d => d.id)
}

export interface AmazonRead { success: boolean; asin: string | null; attributes: Record<string, unknown> | null; error?: string | null }

/** Test seams — never production. */
export interface ContentDriftDeps {
  ours?: (listingId: string) => Promise<OursResult>
  read?: (input: { accountId: string; sku: string; marketplaceId: string }) => Promise<AmazonRead>
  sleep?: (ms: number) => Promise<void>
  /** The pacing clock. */
  clock?: () => number
}

async function readAmazonListing(input: { accountId: string; sku: string; marketplaceId: string }): Promise<AmazonRead> {
  const { amazonSpApiClient } = await import('../clients/amazon-sp-api.client.js')
  const { getAmazonSellerId } = await import('../lib/amazon-sp-client.js')
  const sellerId = await getAmazonSellerId(input.accountId)
  const r = await amazonSpApiClient.getListingsItem({ sellerId, sku: input.sku, marketplaceId: input.marketplaceId, includedData: ['attributes', 'summaries'] } as never) as any
  return { success: !!r.success, asin: r.asin ?? null, attributes: r.rawResponse?.attributes ?? null, error: r.error ?? null }
}

export interface ContentDriftTally { compared: number; drifted: number; notCompared: number; reasons: Record<string, number> }
export type ContentDriftReport = SweepReport & { tally: ContentDriftTally }

/** A reason's first clause, so the summary groups "404 …" or "no cached COAT schema …" instead of listing every SKU. */
const reasonKey = (reason: string) => reason.split(/ — |: /)[0].slice(0, 80)

export async function runContentDrift(options: { dryRun?: boolean; budgetMs?: number; batchSize?: number; now?: () => number; at?: Date; deps?: ContentDriftDeps } = {}): Promise<ContentDriftReport> {
  const at = options.at ?? new Date()
  const dueBefore = new Date(at.getTime() - DUE_AFTER_MS)
  const deps = options.deps ?? {}
  const ours = deps.ours ?? amazonContentOurs
  const read = deps.read ?? readAmazonListing
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const clock = deps.clock ?? Date.now
  const tally: ContentDriftTally = { compared: 0, drifted: 0, notCompared: 0, reasons: {} }
  const notCompared = (reason: string) => { tally.notCompared++; const k = reasonKey(reason); tally.reasons[k] = (tally.reasons[k] ?? 0) + 1 }
  let lastRead: number | null = null

  const apply = async (listingId: string): Promise<number> => {
    const listing = await prisma.channelListing.findUniqueOrThrow({ where: { id: listingId }, select: { marketplace: true } })
    const write = (input: { compared: string[]; differing: Array<{ field: string; ours: unknown; theirs: unknown }>; outcome: 'compared' | 'not_compared'; reason?: string; notCompared?: number }) =>
      recordChannelReadback({ channelListingId: listingId, channel: 'AMAZON', marketplace: listing.marketplace, source: AMAZON_CONTENT_SOURCE, checkedAt: at, ...input })
    const built = await ours(listingId)
    if ('reason' in built) { notCompared(built.reason); await write({ compared: [], differing: [], outcome: 'not_compared', reason: built.reason }); return 1 }
    // The pace: one Amazon read a second at most, measured from the last read's start.
    if (lastRead !== null) { const gap = MIN_READ_GAP_MS - (clock() - lastRead); if (gap > 0) await sleep(gap) }
    lastRead = clock()
    const theirs = await read({ accountId: built.ours.accountId, sku: built.ours.sku, marketplaceId: built.ours.marketplaceId })
    const unreadable = !theirs.success ? `the Amazon read failed: ${theirs.error ?? 'no detail'}` : !theirs.asin ? 'Amazon answered 404 — no listing for this SKU in this market' : null
    if (unreadable) { notCompared(unreadable); await write({ compared: [], differing: [], outcome: 'not_compared', reason: unreadable }); return 1 }
    const result = mergeComparisons(
      compareAmazonContent(built.ours.content, theirs.attributes, { marketplaceId: built.ours.marketplaceId, tags: built.ours.tags }),
      compareAmazonAttributes(built.ours.attributes, theirs.attributes))
    const skipped = built.ours.notCompared.length + result.notCompared.length
    if (!result.compared.length) {
      // Up to three DISTINCT reasons, so "no German text" is not hidden behind "no DE schema".
      const reason = [...new Set([...built.ours.notCompared, ...result.notCompared].map(n => n.reason))].slice(0, 3).join(' · ') || 'nothing of ours to compare'
      notCompared(reason)
      await write({ compared: [], differing: [], outcome: 'not_compared', reason, notCompared: skipped })
      return 1
    }
    tally.compared++
    if (result.differing.length) tally.drifted++
    await write({ compared: result.compared, differing: result.differing, outcome: 'compared', notCompared: skipped })
    return 1
  }

  const report = await runResumableSweep({
    name: 'content-drift',
    budgetMs: options.budgetMs ?? NIGHTLY_BUDGET_MS,
    batchSize: options.batchSize ?? 25,
    // The CRON applies; a human-started run asks for it (the script is dry-run only).
    dryRun: options.dryRun ?? false,
    nextBatch: async take => (await dueListings(dueBefore)).slice(0, take),
    countOutstanding: async () => (await dueListings(dueBefore)).length,
    apply,
    ...(options.now ? { now: options.now } : {}),
  })
  return { ...report, tally }
}

/** 15.7 #2 — the sampled production metric, as the job's own CronRun line. */
export function describeContentDrift(report: ContentDriftReport): string {
  const reasons = Object.entries(report.tally.reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join('; ')
  return `amazon-content: compared ${report.tally.compared} · drifted ${report.tally.drifted} · not compared ${report.tally.notCompared}${reasons ? ` (${reasons})` : ''} · ${describeSweep(report)}`
}

let scheduled: ReturnType<typeof cron.schedule> | null = null

export function startContentDriftCron() {
  if (scheduled || process.env.NEXUS_ENABLE_CONTENT_DRIFT === '0') return
  // 03:37 — after the readiness sweep (02:17), before the Amazon quantity read-back (04:15). The claim outlives the
  // bounded run (10 min) three times over, as the readiness job's does.
  scheduled = cron.schedule('37 3 * * *', async () => {
    await recordCronRun('content-drift', async () => {
      const report = await runContentDrift()
      const line = describeContentDrift(report)
      if (report.failed > 0) throw new Error(line)
      return line
    })
  }, { lockTtlMs: 30 * 60_000 })
}
