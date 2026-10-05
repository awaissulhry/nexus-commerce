/**
 * Ads wave 4b (finding F4) — each Amazon Ads account's currency, timezone and country, stored; and a report in an
 * unknown currency is skipped, never counted as euro.
 *
 * Before this, nothing wrote `AmazonAdsProfile`, and every report path read `profile?.currencyCode ?? 'EUR'`. A pound,
 * zloty, krona or dollar account would have stored its spend and sales as euro — money numbers that are simply wrong.
 *
 * ## Where the facts come from — no new Amazon call
 * The heartbeat's discovery (`cx/connectors/amazon-ads/spec.ts discoverScopes`) reads `GET /v2/profiles` every 15
 * minutes and merges each profile's `currencyCode`, `timezone`, market and account into its `ConnectionScope.metadata`.
 * The daily region reconcile (`jobs/p45b-ads-region-reconcile.job.ts`) already reads those scopes; it now hands them to
 * `fillAdsProfileFacts`, an additive upsert. A field discovery did not report is never blanked, and a profile is never
 * created without a currency (the column's schema default is "EUR", which would be the same guess again).
 *
 * ## The currency of a report — `adsProfileCurrency`
 *   1. `AmazonAdsProfile.currencyCode` (kept current by the reconcile);
 *   2. else the discovery scope's `currencyCode` (fresh every heartbeat; covers the time before the first reconcile);
 *   3. else Amazon's checked market table (`@nexus/shared/ads-market-limits`: IT, DE, FR, ES bill in EUR), so the four
 *      euro markets keep working exactly as before even with no stored row and no scope;
 *   4. else unknown → the caller skips that account's report and says so (log, plus one alert a day per account).
 */
import { workspaceKey } from '@nexus/database/workspace-context'
import { marketLimitsOf } from '@nexus/shared/ads-market-limits'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { normalizeMarketplaceCode } from '../../utils/marketplace-code.js'
import { asAdsRegion } from '../ads-core/ads-regions.js'

const CURRENCY = /^[A-Z]{3}$/

/** An ISO 4217 code, upper-cased, or null. Anything else is not evidence of a currency. */
export function currencyCodeOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const code = v.trim().toUpperCase()
  return CURRENCY.test(code) ? code : null
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** What discovery says about one profile, as the AmazonAdsProfile columns want it. */
export interface AdsProfileFacts {
  profileId: string
  marketplace: string
  region: string
  countryCode: string | null
  currencyCode: string | null
  timezone: string | null
  accountType: string | null
  accountEntityId: string | null
  accountName: string | null
}

export interface ProfileScopeLike {
  externalId: string
  region: string | null
  metadata: unknown
}

/**
 * The facts in one discovery scope. Null when the scope names no market or no region: those are not evidence, and a
 * row keyed on a guessed market or region would be the defect this file exists to remove.
 */
export function profileFactsOf(scope: ProfileScopeLike): AdsProfileFacts | null {
  const meta = (scope.metadata && typeof scope.metadata === 'object' ? scope.metadata : {}) as Record<string, unknown>
  const marketplace = text(meta.marketplace)
  const region = asAdsRegion(scope.region)
  if (!marketplace || !region) return null
  return {
    profileId: scope.externalId,
    marketplace,
    region,
    // Discovery records the profile's `countryCode` as its market; a two-letter value is that country code.
    countryCode: /^[A-Z]{2}$/.test(marketplace) ? marketplace : null,
    currencyCode: currencyCodeOf(meta.currencyCode),
    timezone: text(meta.timezone),
    accountType: text(meta.accountType),
    accountEntityId: text(meta.accountId),
    accountName: text(meta.accountName),
  }
}

export interface FillAdsProfileFactsReport {
  /** Rows created or changed. */
  filled: number
  unchanged: number
  /** Markets whose currency discovery did not report: no row is created for them. */
  noCurrency: string[]
  /** Scopes with no market or region (not evidence). */
  skipped: number
}

type StoredProfile = {
  profileId: string
  marketplace: string
  region: string
  countryCode: string | null
  currencyCode: string
  timezone: string | null
  accountType: string
  accountEntityId: string | null
  accountName: string | null
}

const FACT_FIELDS = ['marketplace', 'region', 'countryCode', 'currencyCode', 'timezone', 'accountType', 'accountEntityId', 'accountName'] as const

/**
 * Additive upsert of every discovered profile's facts into AmazonAdsProfile. Never blanks a stored field, never creates
 * a row without a currency, and writes nothing when the stored row already agrees. Makes no Amazon call.
 */
export async function fillAdsProfileFacts(scopes: ProfileScopeLike[]): Promise<FillAdsProfileFactsReport> {
  const report: FillAdsProfileFactsReport = { filled: 0, unchanged: 0, noCurrency: [], skipped: 0 }
  if (scopes.length === 0) return report
  const stored = new Map<string, StoredProfile>(
    (
      await prisma.amazonAdsProfile.findMany({
        where: { profileId: { in: scopes.map((s) => s.externalId) } },
        select: { profileId: true, marketplace: true, region: true, countryCode: true, currencyCode: true, timezone: true, accountType: true, accountEntityId: true, accountName: true },
      })
    ).map((p) => [p.profileId, p]),
  )

  for (const scope of scopes) {
    const facts = profileFactsOf(scope)
    if (!facts) { report.skipped++; continue }
    if (!facts.currencyCode) report.noCurrency.push(facts.marketplace)
    const existing = stored.get(facts.profileId)

    // Only what discovery reported; a missing fact never overwrites a stored one.
    const known: Partial<Record<(typeof FACT_FIELDS)[number], string>> = {}
    for (const f of FACT_FIELDS) {
      const v = facts[f]
      if (v != null) known[f] = v
    }

    if (!existing) {
      if (!facts.currencyCode) continue
      await prisma.amazonAdsProfile.create({
        data: { profileId: facts.profileId, ...known, marketplace: facts.marketplace, region: facts.region, currencyCode: facts.currencyCode, lastProfileFetchAt: new Date() },
      })
      report.filled++
      continue
    }

    const changed = Object.fromEntries(Object.entries(known).filter(([k, v]) => existing[k as keyof StoredProfile] !== v))
    if (Object.keys(changed).length === 0) { report.unchanged++; continue }
    await prisma.amazonAdsProfile.update({
      where: { workspace_profileId: workspaceKey({ profileId: facts.profileId }) },
      data: { ...changed, lastProfileFetchAt: new Date() },
    })
    if (changed.currencyCode) {
      logger.warn('[ads-profile-facts] stored currency corrected from discovery', {
        profileId: facts.profileId, marketplace: facts.marketplace, was: existing.currencyCode, now: changed.currencyCode,
      })
    }
    report.filled++
  }
  return report
}

export type AdsCurrencySource = 'profile' | 'discovery' | 'market-limits'

/** The currency Amazon bills this account in, and where that answer came from; null when nothing knows. */
export async function adsProfileCurrency(
  profileId: string,
  marketplace: string | null | undefined,
): Promise<{ currencyCode: string; source: AdsCurrencySource } | null> {
  const profile = await prisma.amazonAdsProfile.findUnique({
    where: { workspace_profileId: workspaceKey({ profileId }) },
    select: { currencyCode: true },
  })
  const stored = currencyCodeOf(profile?.currencyCode)
  if (stored) return { currencyCode: stored, source: 'profile' }

  const scope = await prisma.connectionScope.findFirst({
    where: { kind: 'profile', externalId: profileId },
    select: { metadata: true },
  })
  const discovered = currencyCodeOf((scope?.metadata as Record<string, unknown> | null)?.currencyCode)
  if (discovered) return { currencyCode: discovered, source: 'discovery' }

  const checked = marketLimitsOf(normalizeMarketplaceCode(marketplace, '') || marketplace)?.currency
  if (checked) return { currencyCode: checked, source: 'market-limits' }
  return null
}

// One alert per account per UTC day per process: the report cycles run several times a night.
const alerted = new Set<string>()

/**
 * The currency for one account's report, or null after saying why it is skipped. `step` names the report path
 * ("campaign report", "ingest", "gap fill") for the log.
 */
export async function reportCurrencyOrSkip(profile: { profileId: string; marketplace: string | null | undefined }, step: string): Promise<string | null> {
  const found = await adsProfileCurrency(profile.profileId, profile.marketplace)
  if (found) return found.currencyCode
  const market = profile.marketplace || 'unknown market'
  logger.warn('[ads-reports] currency unknown — report skipped, never counted as EUR', { profileId: profile.profileId, marketplace: market, step })
  const key = `${new Date().toISOString().slice(0, 10)}:${profile.profileId}`
  if (!alerted.has(key)) {
    alerted.add(key)
    try {
      const { alertService, AlertType } = await import('../monitoring/alert.service.js')
      await alertService.createAlert(
        AlertType.SYNC_FAILURE,
        `Amazon Ads ${market}: reports skipped, currency unknown`,
        `Nexus does not know which currency Amazon bills the ${market} advertising account in, so its reports are not requested or stored (never counted as euro). The connection's heartbeat reports each account's currency; if this repeats, reconnect Amazon Ads in Settings → Channels.`,
        1,
        [profile.profileId],
      )
    } catch (err) {
      logger.warn('[ads-reports] could not raise the currency alert', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  return null
}

export const __adsProfileFactsTest = { clearAlerted: () => alerted.clear() }
