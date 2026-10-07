import { WorkspaceCache } from '../../lib/workspace-cache.js'
import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * CX.3b — the one place that answers "which Amazon Ads profile serves this market?".
 *
 * Before this, ~75 sites each ran their own
 * `amazonAdsConnection.findFirst({ where: { marketplace, isActive } })`. That table is
 * the last private connection universe in the codebase; the connection core holds the
 * same facts as `ConnectionScope{kind:'profile'}` rows on the one `AMAZON_ADS`
 * connection, and CX.3a proved they agree.
 *
 * ── Two kinds of fact, and why the difference matters here ────────────────────
 * A scope carries facts of two provenances:
 *
 *   • the CHANNEL's   — profileId, region, market, currency. Discovery owns these and
 *                       refreshes them every heartbeat.
 *   • the OPERATOR's  — `mode` and `writesEnabledAt`: permission to spend real money.
 *
 * The operator's are the dangerous ones. They are written through
 * `/advertising/connection/{set-mode,enable-writes,disable-writes}`, and if this
 * resolver served them from a stale snapshot the write gate could allow a write the
 * operator had just disabled. So those routes dual-write into the scope metadata
 * (`recordOperatorDecision` below), and this resolver reads what they wrote — never a
 * migration-time snapshot that nothing keeps current.
 *
 * `NEXUS_CX_ADS_RESOLVER=0` forces the legacy row, and every answer reports which
 * source produced it, so a divergence is visible rather than silent.
 *
 * ── The scope metadata shape, in one place (CX.3c) ────────────────────────────
 * Three writers touch it, and they must compose rather than overwrite (the heartbeat
 * merges; see `cx-heartbeat.job.ts`):
 *
 *   discovery, every heartbeat — what the CHANNEL says:
 *     marketplace · marketplaceStringId · currencyCode · timezone
 *     accountId · accountName · accountType
 *   the operator's routes, mirrored as they write — what WE decided:
 *     mode · writesEnabledAt · lastWriteAt
 *   the CX.3a migration — provenance, until the legacy row goes:
 *     legacyRowId
 *
 * Anything not in this list is not part of the contract. Account-level facts —
 * token expiry, last verification, last error — belong on the CONNECTION, not on a
 * per-profile copy: that is what CX.3c fixed on /api/advertising/connections.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { normalizeMarketplaceCode } from '../../utils/marketplace-code.js'

export interface AdsProfileRef {
  profileId: string
  region: string
  /** The `AMAZON_ADS` ChannelConnection, when the core answered. */
  connectionId: string | null
  /** 'production' | 'sandbox' — the operator's decision, never inferred. */
  mode: string
  /** Non-null means the operator has explicitly enabled writes for this profile. */
  writesEnabledAt: Date | null
  lastWriteAt: Date | null
  marketplace: string
  source: 'scope' | 'row'
}

interface ScopeMetadata {
  marketplace?: unknown
  mode?: unknown
  writesEnabledAt?: unknown
  lastWriteAt?: unknown
}

const coreEnabled = () => process.env.NEXUS_CX_ADS_RESOLVER !== '0'

/**
 * Both sides through the canonical map before comparing.
 *
 * `AmazonAdsConnection.marketplace` holds a two-letter code on some rows and an Amazon
 * marketplace string id on others (the HB.8 sweep left both shapes behind), and a
 * caller may pass either. Comparing raw strings would silently resolve nothing for
 * half the markets — and "resolved nothing" reads to the write gate as "no active
 * connection", which is a refusal rather than a wrong write, but still wrong.
 */
function sameMarket(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a === b) return true
  // '' as the fallback, NOT the default 'UNKNOWN': two unrecognised markets both
  // normalise to 'UNKNOWN' and would compare EQUAL, which on this path means writing
  // to whichever profile happened to be unrecognised first. An unknown market must
  // match nothing but its own exact string, which the early return above covers.
  const na = normalizeMarketplaceCode(a, '')
  const nb = normalizeMarketplaceCode(b, '')
  return na !== '' && na === nb
}

/**
 * The AMAZON_ADS connection id.
 *
 * MAP.3 — DECLARED: "the primary Amazon Ads account", not whichever row `findFirst`
 * returned. Cached briefly because the write gate calls this on every write and the
 * id is the one genuinely stable thing here — the operator's DECISIONS are never
 * cached, because enabling or revoking permission to spend has to take effect now.
 */
const connectionCache = new WorkspaceCache<string, { id: string | null; at: number }>()
const CONN_CACHE_MS = 60_000

async function adsConnectionId(): Promise<string | null> {
  const connCache = connectionCache.get('connection')
  if (connCache && Date.now() - connCache.at < CONN_CACHE_MS) return connCache.id
  const resolver = await import('../connection-resolver.service.js')
  let id: string | null = null
  try {
    id = (await resolver.resolveConnection({ channel: 'AMAZON_ADS', primary: true })).id
  } catch (err) {
    // No Ads grant on the core yet, or two with no primary — both mean "the core
    // cannot answer", and the caller falls back. Anything else is a real fault.
    if (!(err instanceof resolver.NoConnectionError || err instanceof resolver.AmbiguousConnectionError)) throw err
  }
  connectionCache.set('connection', { id, at: Date.now() })
  return id
}

function asDate(v: unknown): Date | null {
  if (!v) return null
  const d = new Date(v as string)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * The operator's decision, from the row, when the scope has not recorded one.
 *
 * Measured on prod 2026-08-29: the CX.3a migration seeded `mode`/`writesEnabledAt`
 * into the scope, and the heartbeats that ran before the metadata-merge fix deployed
 * REPLACED the metadata and dropped them. A resolver that then defaulted to sandbox
 * would have made the write gate refuse every market — fail-safe, but a full stop of
 * Ads automation. Absence of a recorded decision means "ask the system of record",
 * not "assume no permission"; only a genuinely absent profile is a refusal.
 */
async function decisionFromRow(profileId: string): Promise<{ mode: string; writesEnabledAt: Date | null; lastWriteAt: Date | null } | null> {
  const row = await prisma.amazonAdsConnection.findUnique({
    where: { workspace_profileId: workspaceKey({ profileId: profileId }) },
    select: { mode: true, writesEnabledAt: true, lastWriteAt: true },
  })
  return row ?? null
}

interface ProfileScopeRow {
  externalId: string
  region: string | null
  metadata: unknown
}

/**
 * CM-29 — the profile scopes in ONE order, so every caller that asks for a market gets the same profile.
 *
 * `findMany` has no order, and `find` takes the first scope whose market matches: with two profiles for one market
 * (two advertiser accounts on one grant) the gate, a create, a report and a sync could each pick a different one.
 * Sorted by Amazon's profile id here, in code, so the answer does not depend on how the database returns the rows.
 */
async function loadProfileScopes(): Promise<{ connectionId: string; scopes: ProfileScopeRow[] } | null> {
  const connectionId = await adsConnectionId()
  if (!connectionId) return null
  const scopes = await prisma.connectionScope.findMany({
    where: { connectionId, kind: 'profile' },
    select: { externalId: true, region: true, metadata: true, label: true },
  })
  const sorted = [...scopes].sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0))
  return { connectionId, scopes: sorted }
}

/**
 * One profile scope as the write gate reads it: the channel's facts from the scope; the operator's decision from the
 * scope only when it HAS one, and otherwise from the row that owns it (then sandbox, when neither records one).
 */
async function refFromScope(connectionId: string, scope: ProfileScopeRow, marketplace: string): Promise<AdsProfileRef> {
  const meta = (scope.metadata ?? {}) as ScopeMetadata
  const decision =
    typeof meta.mode === 'string'
      ? { mode: meta.mode, writesEnabledAt: asDate(meta.writesEnabledAt), lastWriteAt: asDate(meta.lastWriteAt) }
      : ((await decisionFromRow(scope.externalId)) ?? { mode: 'sandbox', writesEnabledAt: null, lastWriteAt: null })
  return {
    profileId: scope.externalId,
    region: scope.region ?? 'EU',
    connectionId,
    mode: decision.mode,
    writesEnabledAt: decision.writesEnabledAt,
    lastWriteAt: decision.lastWriteAt,
    marketplace: typeof meta.marketplace === 'string' ? meta.marketplace : marketplace,
    source: 'scope',
  }
}

async function refFromScopes(connectionId: string, scopes: ProfileScopeRow[], marketplace: string): Promise<AdsProfileRef | null> {
  const hit = scopes.find((s) => sameMarket((s.metadata as ScopeMetadata | null)?.marketplace, marketplace))
  if (!hit) return null
  return refFromScope(connectionId, hit, marketplace)
}

async function fromScopes(marketplace: string): Promise<AdsProfileRef | null> {
  const loaded = await loadProfileScopes()
  if (!loaded) return null
  return refFromScopes(loaded.connectionId, loaded.scopes, marketplace)
}

async function fromRow(marketplace: string): Promise<AdsProfileRef | null> {
  const row = await prisma.amazonAdsConnection.findFirst({
    where: { marketplace, isActive: true },
    // CM-29 — one order, so two rows for one market always give the same answer.
    orderBy: { profileId: 'asc' },
    select: { profileId: true, region: true, mode: true, writesEnabledAt: true, lastWriteAt: true, marketplace: true },
  })
  if (!row) return null
  return {
    profileId: row.profileId,
    region: row.region,
    connectionId: null,
    mode: row.mode,
    writesEnabledAt: row.writesEnabledAt,
    lastWriteAt: row.lastWriteAt,
    marketplace: row.marketplace,
    source: 'row',
  }
}

/** The profile serving a market, or null. Null is a refusal upstream, never a guess. */
export async function adsProfileFor(marketplace: string | null | undefined): Promise<AdsProfileRef | null> {
  if (!marketplace) return null
  if (coreEnabled()) {
    try {
      const scoped = await fromScopes(marketplace)
      if (scoped) return scoped
    } catch (err) {
      logger.warn('[ads-resolver] the connection core could not answer; using the legacy row', {
        marketplace,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return fromRow(marketplace)
}

/**
 * The profile for each market, answered exactly as `adsProfileFor` answers one market (same source, same order, same
 * fallbacks), with the connection core read once. For the market lists (ads-markets.service.ts).
 */
export async function adsProfilesForMarkets(markets: readonly string[]): Promise<Map<string, AdsProfileRef | null>> {
  const out = new Map<string, AdsProfileRef | null>()
  let loaded: Awaited<ReturnType<typeof loadProfileScopes>> = null
  if (coreEnabled()) {
    try {
      loaded = await loadProfileScopes()
    } catch (err) {
      logger.warn('[ads-resolver] the connection core could not answer; using the legacy rows', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  for (const market of markets) {
    const scoped = loaded ? await refFromScopes(loaded.connectionId, loaded.scopes, market) : null
    out.set(market, scoped ?? (await fromRow(market)))
  }
  return out
}

/**
 * CM-29 / CC-30 — the profile and region an Amazon Ads call for this market goes to: the write gate's own answer
 * (`adsProfileFor`). Every create, read-back and settings refresh asks this, so the profile a write is approved for is
 * the profile the call reaches. Null when no profile serves the market.
 */
export async function adsClientContextFor(marketplace: string | null | undefined): Promise<{ profileId: string; region: 'EU' | 'NA' | 'FE' } | null> {
  const ref = await adsProfileFor(marketplace)
  if (!ref) return null
  const region = ref.region === 'NA' || ref.region === 'FE' ? ref.region : 'EU'
  return { profileId: ref.profileId, region }
}

/**
 * Every profile the account reaches, for the sites that sweep rather than look one up.
 *
 * Each profile is answered exactly as `adsProfileFor` answers its market — the write gate's own reading, in the same
 * order (by profile id): a scope that records no decision reads the row that owns it, and only then sandbox. It used to
 * assume sandbox there, so a sweep and the write gate disagreed on every profile whose scope lost its decision (the
 * 2026-08-29 heartbeats), and `activeOnly` dropped profiles the gate lets write.
 */
export async function listAdsProfiles(opts: { activeOnly?: boolean } = {}): Promise<AdsProfileRef[]> {
  if (coreEnabled()) {
    try {
      const loaded = await loadProfileScopes()
      if (loaded) {
        const refs: AdsProfileRef[] = []
        for (const scope of loaded.scopes) refs.push(await refFromScope(loaded.connectionId, scope, ''))
        if (refs.length > 0) return opts.activeOnly ? refs.filter((r) => r.mode === 'production') : refs
      }
    } catch (err) {
      logger.warn('[ads-resolver] scope sweep failed; using the legacy rows', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const rows = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true, ...(opts.activeOnly ? { mode: 'production' } : {}) },
    // CM-29 — the same order as the scopes and as `adsProfileFor`'s row lookup.
    orderBy: { profileId: 'asc' },
    select: { profileId: true, region: true, mode: true, writesEnabledAt: true, lastWriteAt: true, marketplace: true },
  })
  return rows.map((r) => ({ ...r, connectionId: null, source: 'row' as const }))
}

/**
 * Mirror an operator decision (or a completed write) onto the scope.
 *
 * Called by the routes that own those decisions and by `recordSuccessfulWrite`. Merges
 * into the existing metadata — discovery writes the channel's facts into the same
 * object every heartbeat, and neither side may erase the other's.
 *
 * Best-effort by design: the legacy row remains the system of record for these fields
 * until CX.3c, so a failure here must never fail the operator's action. It logs.
 */
export async function recordOperatorDecision(
  profileId: string,
  patch: { mode?: string; writesEnabledAt?: Date | null; lastWriteAt?: Date },
): Promise<void> {
  try {
    const connectionId = await adsConnectionId()
    if (!connectionId) return
    const scope = await prisma.connectionScope.findUnique({
      where: { connectionId_kind_externalId: workspaceKey({ connectionId, kind: 'profile', externalId: profileId }) },
      select: { metadata: true },
    })
    if (!scope) return
    const next: Record<string, unknown> = { ...((scope.metadata ?? {}) as Record<string, unknown>) }
    if (patch.mode !== undefined) next.mode = patch.mode
    if (patch.writesEnabledAt !== undefined) next.writesEnabledAt = patch.writesEnabledAt ? patch.writesEnabledAt.toISOString() : null
    if (patch.lastWriteAt !== undefined) next.lastWriteAt = patch.lastWriteAt.toISOString()
    await prisma.connectionScope.update({
      where: { connectionId_kind_externalId: workspaceKey({ connectionId, kind: 'profile', externalId: profileId }) },
      data: { metadata: next as never, isActive: next.mode === 'production' },
    })
  } catch (err) {
    logger.warn('[ads-resolver] could not mirror the operator decision onto the scope', {
      profileId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Mirror onto every profile of a market (what `recordSuccessfulWrite` needs). */
export async function recordWriteForMarket(marketplace: string, at: Date = new Date()): Promise<void> {
  const ref = await adsProfileFor(marketplace)
  if (ref?.source === 'scope') await recordOperatorDecision(ref.profileId, { lastWriteAt: at })
}

/**
 * Can we authenticate as this Ads account at all?
 *
 * "Has credentials" stopped being a property of a ROW at CX.3a: one grant covers every
 * profile and the credential lives once on the connection. Callers that used to test
 * `credentialsEncrypted != null` per row ask this instead — otherwise archiving the
 * duplicate blobs would make them all answer "no" and stop working in silence.
 */
export async function adsAccountHasCredential(): Promise<boolean> {
  try {
    const connectionId = await adsConnectionId()
    if (!connectionId) return false
    const row = await prisma.channelConnection.findUnique({
      where: { id: connectionId },
      select: { credentialsEnc: true },
    })
    return !!row?.credentialsEnc
  } catch {
    return false
  }
}

export const __adsResolverTest = {
  sameMarket,
  fromScopes,
  fromRow,
  /** Tests and the reseed job need a clean slate; nothing in production clears it. */
  clearConnectionCache: () => { connectionCache.clear() },
}

export async function adsProfileAccountLabel(profileId: string): Promise<string | null> {
  const profile = await prisma.amazonAdsConnection.findFirst({ where: { profileId }, select: { accountLabel: true } })
  return profile?.accountLabel ?? null
}
