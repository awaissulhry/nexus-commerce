/**
 * BID BRAIN BB-14 (2026-10-08, design BRAIN-UPGRADES-DESIGN.md U1a) — the newest day of each ad product that Nexus holds a
 * SETTLED copy of, read from the report jobs, and handed to the settled window (`ads-settled-window.ts setSettledFacts`)
 * before a decision reads it. A day is settled when a pull of it was asked at least the attribution window after the day
 * (7 days Sponsored Products, 14 Brands and Display) and ingested (`ads-report-settle.ts settledThrough`).
 *
 * Per ad product the fact is the OLDEST newest-settled day over every account and report the decisions read (campaign,
 * search term, targeting) that ran in the last 14 days: a window must not reach a day one market has not settled. A
 * report with recent jobs and no settled day at all makes the fact null (the window keeps the clock rule and says the
 * newest days may still be filling).
 *
 * `primeSettledWindow` runs before every scheduled job (utils/cron-observability.ts) and before the screens and tools that
 * show a window; it reads at most once per 15 minutes per business and process, and never fails its caller.
 */
import { LEGACY_WORKSPACE_ID, workspaceContext } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { settledThrough, type PullJob } from './ads-report-settle.js'
import { setSettledFacts, type SettledFacts } from './ads-settled-window.js'

const DAY = 86_400_000
/** The reports a decision window reads, per ad-product group. */
const SETTLING_REPORTS: Record<'sp' | 'other', readonly string[]> = {
  sp: ['spCampaigns', 'spSearchTerm', 'spTargeting'],
  other: ['sbCampaigns', 'sbSearchTerm', 'sdCampaigns'],
}
/** A report counts when it ran in this many days (a dormant ad product's reports stop and drop out). */
const ACTIVE_DAYS = 14
/** Jobs read: enough to hold the settling pull of the newest settled day and the reports active within ACTIVE_DAYS. */
const READ_DAYS = 21
const PRIME_EVERY_MS = 15 * 60_000

/** Pure: the newest settled day the decision windows may use, per group, from `jobs`. */
export function settledFactsOf(jobs: readonly PullJob[], now: Date): SettledFacts {
  const activeSince = now.getTime() - ACTIVE_DAYS * DAY
  const through = (reportTypes: readonly string[]): Date | null => {
    const groups = new Map<string, { profileId: string; adProduct: string; reportTypeId: string }>()
    for (const j of jobs) {
      if (!reportTypes.includes(j.reportTypeId) || j.createdAt.getTime() < activeSince) continue
      groups.set(`${j.profileId}|${j.adProduct}|${j.reportTypeId}`, { profileId: j.profileId, adProduct: j.adProduct, reportTypeId: j.reportTypeId })
    }
    if (!groups.size) return null
    let oldest: Date | null = null
    for (const key of groups.values()) {
      const s = settledThrough(jobs, key)
      if (!s) return null
      if (!oldest || s.getTime() < oldest.getTime()) oldest = s
    }
    return oldest
  }
  return { spThrough: through(SETTLING_REPORTS.sp), otherThrough: through(SETTLING_REPORTS.other) }
}

/** Reads the facts for the business in context. */
export async function readSettledFacts(now: Date = new Date()): Promise<SettledFacts> {
  const jobs = await prisma.amazonAdsReportJob.findMany({
    where: { reportTypeId: { in: [...SETTLING_REPORTS.sp, ...SETTLING_REPORTS.other] }, createdAt: { gte: new Date(now.getTime() - READ_DAYS * DAY) } },
    select: { profileId: true, adProduct: true, reportTypeId: true, startDate: true, endDate: true, createdAt: true, status: true, ingestedAt: true },
  })
  return settledFactsOf(jobs, now)
}

const primedAt = new Map<string, number>()

/** Hands the settled window fresh facts for the business in context (at most once per 15 minutes). Never throws. */
export async function primeSettledWindow(): Promise<void> {
  const business = workspaceContext()?.workspaceId ?? LEGACY_WORKSPACE_ID
  if (Date.now() - (primedAt.get(business) ?? 0) < PRIME_EVERY_MS) return
  primedAt.set(business, Date.now())
  try {
    setSettledFacts(await readSettledFacts())
  } catch (err) {
    logger.warn('[ads-settled-facts] settled days not read: the decision windows keep the clock rule', { error: String(err).slice(0, 300) })
  }
}

/** Tests: read again on the next prime. */
export function resetSettledPrime(): void {
  primedAt.clear()
}
