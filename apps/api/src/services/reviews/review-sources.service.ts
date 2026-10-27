/**
 * Reviews area — where each channel's reviews come from and whether they still arrive, in plain words (the Overview's
 * channel table and setup banner; Reviews Settings › Sources reads the same answer in PR D). It took over the job of
 * GET /reviews/ingest-health (retired in PR D) without ever naming a setting key: a person reads "Sign-in expired ·
 * Reconnect", never a variable.
 *
 * Shape: `readSourceFacts()` reads (connections, Amazon topic reads, review counts per channel and market, the last
 * review read), `sourcesFromFacts()` turns the facts into states and setup problems — pure, tested in
 * review-sources.vitest.test.ts. Fixture rows never count (review-visibility.ts).
 *
 * Phase 1 sources: Amazon = review topics per product (Customer Feedback API, weekly; not on Amazon.nl) + stars only from
 * reviews a person imports (no API gives Amazon stars, build spec ruling 5); eBay = seller feedback read every 30 min,
 * which belongs to the seller account, not to one eBay site: an account with no market covers every eBay market the
 * business sells on; Shopify = the store's review app, by file import. Etsy (PR I, 2026-10-27): the shop's reviews, read
 * every 30 minutes through the Etsy connection — one row once an Etsy account is connected or Etsy reviews exist.
 */
import { REVIEW_APP_NAME, type ReviewApp } from '@nexus/shared/review-reply-rules'
import prisma from '../../db.js'
import { visibleReviewWhere } from './review-visibility.js'

/** The CronRun the eBay feedback read records (review-ingest.service.ts): SUCCESS only when eBay answered. */
export const EBAY_READ_JOB = 'review-ingest-ebay'
import { channelMarketLabel, marketWords } from './overviewMath.js'

export type SourceStateKind = 'ok' | 'not_updating'

export interface ReviewSource {
  channel: string
  market: string | null
  state: SourceStateKind
  /** Why it is not updating, in words ("Sign-in expired"); null when it is fine. */
  reason: string | null
  /** Since when (ISO), when known. */
  since: string | null
  /** Where a person fixes it (Settings › Channels › the channel); null when no person can. */
  reconnectHref: string | null
  /** What this source gives, in words: "Topics · stars from imported reviews". */
  what: string
  /** How it arrives and when it last did: "file import · topics 20 Oct". */
  lastNote: string | null
  /** The newest visible review from it (ISO). */
  lastReviewAt: string | null
  /** Visible reviews held from it (all time). */
  reviews: number
  /**
   * Nexus reads new reviews from it by itself (eBay, Etsy, Judge.me). False where reviews arrive only when a person
   * imports a file: Amazon's product reviews (no API gives them) and a store review app that is not connected. Live
   * audit A06: such a source is never called "up to date".
   */
  readsItself: boolean
}

export interface SetupProblem {
  id: string
  title: string
  words: string
  actionLabel: string
  href: string
  /** Changes when the problem changes: a person who hid the banner sees it again then. */
  fingerprint: string
}

export interface SourceFacts {
  connections: Array<{
    id: string
    channelType: string
    marketplace: string | null
    isActive: boolean
    authStatus: string
    lastErrorAt: Date | null
    isPrimary: boolean
  }>
  /** One row per Amazon product × market topic read. */
  topics: Array<{ marketplace: string; accessStatus: string; fetchedAt: Date }>
  /** Visible reviews per channel × market × how they arrived. */
  reviewGroups: Array<{ channel: string; marketplace: string | null; ingestSource: string | null; count: number; lastPostedAt: Date | null; lastIngestedAt: Date | null }>
  /** The last successful review read (the 30-minute job), null when it never ran. */
  lastReadAt: Date | null
  /** The markets with an active eBay listing: where the business sells on eBay. */
  ebayListingMarkets: string[]
  /** Whether this Nexus reads eBay feedback and Amazon topics at all (deployment switches; never shown by name). */
  ebayFeedbackOn: boolean
  amazonTopicsOn: boolean
  /** PR I: whether this Nexus reads Etsy reviews (a deployment switch; never shown by name), and its last good read. */
  etsyReadOn?: boolean
  etsyLastReadAt?: Date | null
  /** PR I: the store's review app (Judge.me, Okendo, Yotpo, Loox) a business connected: its name, whether it holds a key, its last read. */
  shopifyApp?: { connected: boolean; lastReadAt: Date | null; name?: string } | null
}

/** Amazon review topics exist for these markets only; never on Amazon.nl (ruling 5). */
export const NO_TOPICS_MARKETS: ReadonlySet<string> = new Set(['NL'])

/** A review read older than this means eBay stopped updating (the job runs every 30 min). */
export const READ_LATE_MS = 2 * 60 * 60 * 1000

const BROKEN_AUTH: Record<string, string> = {
  needs_reauth: 'Sign-in expired',
  revoked: 'Access was removed on the channel',
  disconnected: 'Not connected',
}

export function settingsHref(channel: string): string {
  return `/settings/channels/${channel.toLowerCase()}`
}

/** "Mon 20 Oct" (UTC). */
export function dayWords(at: Date): string {
  return at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '')
}

/** "20 Oct" (UTC). */
export function shortDay(at: Date): string {
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** How a review arrived, in words. */
export function arrivalWords(ingestSource: string | null): string | null {
  switch (ingestSource) {
    case 'IMPORT_CSV': return 'file import'
    case 'AMAZON_VOC': return 'review feed'
    case 'EBAY_API': return 'read from eBay'
    case 'EBAY_REST': return 'read from eBay'
    case 'SHOPIFY_WEBHOOK': return 'sent by Shopify'
    case 'ETSY_API': return 'read from Etsy'
    case 'JUDGEME_API': return 'read from Judge.me'
    case 'OKENDO_API': return 'read from Okendo'
    case 'YOTPO_API': return 'read from Yotpo'
    case 'LOOX_API': return 'read from Loox'
    case 'MANUAL': return 'added by hand'
    case 'AMAZON_SELLER_FEEDBACK': return 'seller feedback report'
    default: return null
  }
}

/** A connection's sign-in in words: null when it works, else what is wrong. */
export function connectionProblem(conn: { isActive: boolean; authStatus: string } | undefined, channelName: string): string | null {
  if (!conn) return `No ${channelName} account is connected`
  if (!conn.isActive) return `The ${channelName} account is switched off in Nexus`
  return BROKEN_AUTH[conn.authStatus] ?? null
}

interface TopicState {
  lastOkAt: Date | null
  lastAt: Date | null
  /** The newest read was refused because the Selling Partner Insights (Brand Analytics) role is missing. */
  roleMissing: boolean
}

/** Per market: when topics last arrived, and whether the newest read was refused for the missing role. */
export function topicStates(topics: SourceFacts['topics']): Map<string, TopicState> {
  const out = new Map<string, TopicState>()
  for (const t of topics) {
    const market = t.marketplace.toUpperCase()
    const s = out.get(market) ?? { lastOkAt: null, lastAt: null, roleMissing: false }
    if (t.accessStatus === 'OK' && (!s.lastOkAt || t.fetchedAt > s.lastOkAt)) s.lastOkAt = t.fetchedAt
    if (!s.lastAt || t.fetchedAt >= s.lastAt) {
      s.lastAt = t.fetchedAt
      s.roleMissing = t.accessStatus === 'NEEDS_BRAND_ANALYTICS_ROLE'
    }
    out.set(market, s)
  }
  return out
}

function newest(dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null
  for (const d of dates) if (d && (!best || d > best)) best = d
  return best
}

const key = (channel: string, market: string | null) => `${channel}|${market ?? ''}`

/** A market code as the Reviews pages use it: two letters, upper case, Great Britain as the UK; anything else null. */
export function marketCode(raw: string | null | undefined): string | null {
  const code = raw?.trim().toUpperCase() ?? ''
  if (!/^[A-Z]{2}$/.test(code)) return null
  return code === 'GB' ? 'UK' : code
}

/** States for every channel × market Nexus knows reviews for, and the problems a person can fix. Pure. */
export function sourcesFromFacts(facts: SourceFacts, now: Date): { sources: ReviewSource[]; setup: SetupProblem[] } {
  const groups = new Map<string, SourceFacts['reviewGroups']>()
  for (const g of facts.reviewGroups) {
    const k = key(g.channel.toUpperCase(), g.marketplace?.toUpperCase() ?? null)
    groups.set(k, [...(groups.get(k) ?? []), g])
  }
  const reviewsOf = (channel: string, market: string | null) => groups.get(key(channel, market)) ?? []
  const marketsOf = (channel: string) => new Set(facts.reviewGroups.filter(g => g.channel.toUpperCase() === channel && g.marketplace).map(g => g.marketplace!.toUpperCase()))
  const active = (channel: string) => facts.connections.filter(c => c.channelType.toUpperCase() === channel && c.isActive)
  const anyConnection = (channel: string) => facts.connections.some(c => c.channelType.toUpperCase() === channel)

  const sources: ReviewSource[] = []
  const setup: SetupProblem[] = []
  const summary = (channel: string, market: string | null) => {
    const rows = reviewsOf(channel, market)
    const latest = rows.reduce<SourceFacts['reviewGroups'][number] | null>((best, g) => (!best || (g.lastIngestedAt ?? 0) > (best.lastIngestedAt ?? 0) ? g : best), null)
    return {
      count: rows.reduce((n, g) => n + g.count, 0),
      lastReviewAt: newest(rows.map(g => g.lastPostedAt)),
      lastArrival: latest ? arrivalWords(latest.ingestSource) : null,
      imported: rows.some(g => g.ingestSource === 'IMPORT_CSV' && g.count > 0),
      // Amazon's 1–3 star seller feedback (PR H) is held but gives no product stars.
      sellerFeedback: rows.filter(g => g.ingestSource === 'AMAZON_SELLER_FEEDBACK').reduce((n, g) => n + g.count, 0),
    }
  }

  // ── Amazon: topics per market (weekly) + stars only from imported reviews ──
  const topics = topicStates(facts.topics)
  const amazonMarkets = new Set<string>([...marketsOf('AMAZON'), ...topics.keys()])
  for (const market of [...amazonMarkets].sort()) {
    const s = summary('AMAZON', market)
    const t = topics.get(market)
    const noTopics = NO_TOPICS_MARKETS.has(market)
    const topicsRead = !noTopics && t?.lastOkAt != null
    const stars = s.imported || s.count - s.sellerFeedback > 0
    const feedback = s.sellerFeedback > 0 ? ' · seller feedback 1–3 stars' : ''
    const what = noTopics
      ? `${stars ? 'Stars from imported reviews' : 'No reviews imported'} · no topics on Amazon.${market.toLowerCase()}${feedback}`
      : `${facts.amazonTopicsOn || topicsRead ? 'Topics · ' : ''}${stars ? 'stars from imported reviews' : 'no reviews imported'}${feedback}`
    const notes = [s.lastArrival, topicsRead ? `topics ${shortDay(t!.lastOkAt!)}` : null].filter(Boolean)
    sources.push({
      channel: 'AMAZON', market, state: 'ok', reason: null, since: null, reconnectHref: null, readsItself: false,
      what: what.charAt(0).toUpperCase() + what.slice(1),
      lastNote: notes.length ? notes.join(' · ') : null,
      lastReviewAt: s.lastReviewAt?.toISOString() ?? null, reviews: s.count,
    })
  }
  const amazonConn = active('AMAZON')
  const amazonBroken = anyConnection('AMAZON') ? connectionProblem(amazonConn.find(c => c.isPrimary) ?? amazonConn[0], 'Amazon') : null
  if (amazonBroken && amazonBroken !== 'No Amazon account is connected') {
    setup.push({
      id: 'amazon-signin',
      title: 'Amazon stopped answering Nexus.',
      words: `${amazonBroken}. Until someone connects Amazon again, Nexus cannot read Amazon's review topics or ask Amazon to request reviews.`,
      actionLabel: 'Reconnect in Settings',
      href: settingsHref('AMAZON'),
      fingerprint: `amazon-signin:${amazonBroken}`,
    })
  }
  const denied = [...topics.entries()].filter(([m, t]) => !NO_TOPICS_MARKETS.has(m) && t.roleMissing).sort(([a], [b]) => a.localeCompare(b))
  if (denied.length > 0) {
    const lastOk = newest(denied.map(([, t]) => t.lastOkAt))
    const where = denied.map(([m]) => marketWords(m)).filter(Boolean).join(', ')
    setup.push({
      id: 'amazon-topics-role',
      title: lastOk ? 'Amazon review topics did not update.' : 'Amazon review topics are not available.',
      words: `Amazon refused the weekly read for ${where}: Nexus needs the Selling Partner Insights role (Brand Analytics), and the Amazon connection does not have it. ${lastOk ? `Topics stay at ${dayWords(lastOk)}` : 'No topics show'} until the account owner adds the role in Seller Central and connects Amazon again.`,
      actionLabel: 'Fix in Settings',
      href: settingsHref('AMAZON'),
      fingerprint: `amazon-topics-role:${denied.map(([m]) => m).join(',')}:${lastOk?.toISOString().slice(0, 10) ?? 'never'}`,
    })
  }

  // ── eBay: seller feedback, read every 30 minutes ──
  // Feedback belongs to the seller account, not to one eBay site. An account connected for one market covers that
  // market; an account with no market covers every eBay market the business sells on (listings, feedback held, the
  // markets of other accounts). A market has a state of its own only for its own account.
  const ebayAll = facts.connections.filter(c => c.channelType.toUpperCase() === 'EBAY')
  const ebayMarketOf = (c: SourceFacts['connections'][number]) => marketCode(c.marketplace)
  const ebayWide = ebayAll.filter(c => ebayMarketOf(c) == null)
  const pickAccount = (list: SourceFacts['connections']) => list.find(c => c.isActive && c.isPrimary) ?? list.find(c => c.isActive)
  /** The account that reads a market: its own working account, else an account-wide one, else a switched-off one. */
  const ebayAccountFor = (market: string | null) => {
    const own = market ? ebayAll.filter(c => ebayMarketOf(c) === market) : []
    return pickAccount(own) ?? pickAccount(ebayWide) ?? own[0] ?? ebayWide[0]
  }
  const ebayMarkets = new Set<string>([
    ...marketsOf('EBAY'),
    ...ebayAll.filter(c => c.isActive).map(ebayMarketOf).filter((m): m is string => m != null),
    // Where the business sells on eBay counts only once an eBay account exists (else there is nothing to read with).
    ...(ebayAll.length > 0 ? facts.ebayListingMarkets.map(marketCode).filter((m): m is string => m != null) : []),
  ])
  // An account-wide account with no market to show yet still has a state: one row for eBay as a whole.
  const ebayRows: Array<string | null> = ebayMarkets.size > 0 ? [...ebayMarkets].sort() : ebayWide.length > 0 ? [null] : []
  const bannerFor = new Set<string>()
  for (const market of ebayRows) {
    const s = summary('EBAY', market)
    const conn = ebayAccountFor(market)
    const broken = connectionProblem(conn, 'eBay')
    const late = facts.ebayFeedbackOn && !broken && (!facts.lastReadAt || now.getTime() - facts.lastReadAt.getTime() > READ_LATE_MS)
    let state: SourceStateKind = 'ok'
    let reason: string | null = null
    let since: Date | null = null
    let reconnectHref: string | null = null
    if (broken) {
      state = 'not_updating'
      reason = broken
      since = conn?.lastErrorAt ?? null
      reconnectHref = settingsHref('EBAY')
      // One banner per account that exists and stopped (an account-wide one names eBay, not each market): a market
      // nobody connected is not a problem to fix.
      if (conn && !bannerFor.has(conn.id)) {
        bannerFor.add(conn.id)
        const connMarket = ebayMarketOf(conn)
        const where = channelMarketLabel('EBAY', connMarket)
        setup.push({
          id: `ebay-signin:${connMarket ?? 'ALL'}`,
          title: `${where} stopped updating.`,
          words: `${broken}${since ? ` (since ${dayWords(since)})` : ''}. Nexus cannot read new feedback from ${where} or send replies there until someone connects the account again.`,
          actionLabel: 'Reconnect in Settings',
          href: settingsHref('EBAY'),
          fingerprint: `ebay-signin:${connMarket ?? 'ALL'}:${broken}:${since?.toISOString() ?? ''}`,
        })
      }
    } else if (!facts.ebayFeedbackOn) {
      state = 'not_updating'
      reason = 'Nexus does not read eBay feedback in this setup yet'
    } else if (late) {
      state = 'not_updating'
      reason = facts.lastReadAt ? `Nexus has not read eBay since ${dayWords(facts.lastReadAt)}` : 'Nexus has not read eBay yet'
      since = facts.lastReadAt
    }
    sources.push({
      channel: 'EBAY', market, state, reason, since: since?.toISOString() ?? null, reconnectHref, readsItself: true,
      what: 'Seller feedback',
      lastNote: state === 'ok' ? 'read every 30 min' : s.lastArrival,
      lastReviewAt: s.lastReviewAt?.toISOString() ?? null, reviews: s.count,
    })
  }

  // ── Etsy (PR I): the shop's reviews, read every 30 minutes through the Etsy connection ──
  // One shop, one state: a row per market its reviews came from (the order's market), else one row for Etsy.
  const etsyAll = facts.connections.filter(c => c.channelType.toUpperCase() === 'ETSY')
  const etsyMarkets = [...marketsOf('ETSY')].sort()
  const etsyRows: Array<string | null> = etsyMarkets.length ? etsyMarkets : (etsyAll.length > 0 || summary('ETSY', null).count > 0 ? [null] : [])
  if (etsyRows.length > 0) {
    const conn = etsyAll.find(c => c.isActive && c.isPrimary) ?? etsyAll.find(c => c.isActive) ?? etsyAll[0]
    const broken = etsyAll.length > 0 ? connectionProblem(conn, 'Etsy') : null
    const off = !broken && !facts.etsyReadOn
    for (const market of etsyRows) {
      // Reviews with no market belong to the shop as a whole: the first row counts them too.
      const here = [summary('ETSY', market), ...(market !== null && market === etsyRows[0] ? [summary('ETSY', null)] : [])]
      sources.push({
        channel: 'ETSY', market, readsItself: true,
        state: broken || off ? 'not_updating' : 'ok',
        reason: broken ?? (off ? 'Nexus does not read Etsy reviews in this setup yet' : null),
        since: broken ? conn?.lastErrorAt?.toISOString() ?? null : null,
        reconnectHref: broken ? settingsHref('ETSY') : null,
        what: 'Shop reviews, one photo each',
        lastNote: broken || off ? null : facts.etsyLastReadAt ? `read every 30 min · last ${shortDay(facts.etsyLastReadAt)}` : 'read every 30 min',
        lastReviewAt: newest(here.map(s => s.lastReviewAt))?.toISOString() ?? null,
        reviews: here.reduce((n, s) => n + s.count, 0),
      })
    }
  }

  // ── Shopify: the store's review app, by file import for now ──
  const shopify = summary('SHOPIFY', null)
  const shopifyMarketReviews = [...marketsOf('SHOPIFY')].map(m => summary('SHOPIFY', m))
  const shopifyCount = shopify.count + shopifyMarketReviews.reduce((n, s) => n + s.count, 0)
  const app = facts.shopifyApp?.connected ? facts.shopifyApp : null
  if (shopifyCount > 0 || active('SHOPIFY').length > 0 || app) {
    const lastImport = newest(facts.reviewGroups.filter(g => g.channel.toUpperCase() === 'SHOPIFY' && g.ingestSource === 'IMPORT_CSV').map(g => g.lastIngestedAt))
    sources.push({
      channel: 'SHOPIFY', market: null, state: 'ok', reason: null, since: null, reconnectHref: null, readsItself: !!app,
      what: app ? `Store review app (${app.name ?? 'Judge.me'}), read every 30 min` : 'Store review app, by file import',
      lastNote: app
        ? (app.lastReadAt ? `${app.name ?? 'Judge.me'} read ${shortDay(app.lastReadAt)}` : `${app.name ?? 'Judge.me'} not read yet`)
        : lastImport ? `last file import ${shortDay(lastImport)}` : 'no file imported yet',
      lastReviewAt: newest([shopify.lastReviewAt, ...shopifyMarketReviews.map(s => s.lastReviewAt)])?.toISOString() ?? null,
      reviews: shopifyCount,
    })
  }

  return { sources, setup }
}

/**
 * The connected review apps as one fact: the names joined ("Judge.me and Okendo") and the newest read; null when none
 * holds a key. Pure.
 */
export function shopifyAppFact(rows: ReadonlyArray<{ app: string; credentials: string | null; state: string; lastReadAt: Date | null }>): SourceFacts['shopifyApp'] {
  const live = rows.filter((r) => !!r.credentials && r.state !== 'DISCONNECTED')
  if (live.length === 0) return null
  const names = live.map((r) => REVIEW_APP_NAME[r.app as ReviewApp] ?? r.app)
  const name = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return { connected: true, lastReadAt: newest(live.map((r) => r.lastReadAt)), name }
}

/** The facts `sourcesFromFacts` needs, read in the business the request runs in. */
export async function readSourceFacts(): Promise<SourceFacts> {
  const [connections, topics, grouped, lastRead, ebayListings, etsyRead, reviewApp] = await Promise.all([
    prisma.channelConnection.findMany({
      where: { channelType: { in: ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] } },
      select: { id: true, channelType: true, marketplace: true, isActive: true, authStatus: true, lastErrorAt: true, isPrimary: true },
    }),
    prisma.amazonReviewInsight.findMany({ select: { marketplace: true, accessStatus: true, fetchedAt: true } }),
    prisma.review.groupBy({
      by: ['channel', 'marketplace', 'ingestSource'],
      where: visibleReviewWhere(),
      _count: { _all: true },
      _max: { postedAt: true, ingestedAt: true },
    }),
    // eBay's own read (audit B1): the job's SUCCESS said nothing about eBay — it finished even when eBay refused.
    // Until the first recorded eBay read, the job's last success stands in.
    prisma.cronRun.findFirst({ where: { jobName: { in: [EBAY_READ_JOB, 'review-ingest'] }, status: 'SUCCESS' }, orderBy: [{ jobName: 'desc' }, { startedAt: 'desc' }], select: { startedAt: true, jobName: true } }),
    prisma.channelListing.groupBy({ by: ['marketplace'], where: { channel: 'EBAY', listingStatus: 'ACTIVE' } }),
    prisma.cronRun.findFirst({ where: { jobName: 'etsy-reviews-read', status: { in: ['SUCCESS', 'PARTIAL'] } }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
    prisma.reviewAppConnection.findMany({ where: { credentials: { not: null }, state: { not: 'DISCONNECTED' } }, select: { app: true, credentials: true, state: true, lastReadAt: true } }),
  ])
  return {
    connections,
    topics,
    reviewGroups: grouped.map(g => ({
      channel: g.channel,
      marketplace: g.marketplace,
      ingestSource: g.ingestSource,
      count: g._count._all,
      lastPostedAt: g._max.postedAt ?? null,
      lastIngestedAt: g._max.ingestedAt ?? null,
    })),
    lastReadAt: lastRead?.startedAt ?? null,
    ebayListingMarkets: ebayListings.map(l => l.marketplace).filter((m): m is string => typeof m === 'string'),
    // Deployment switches, read here and never named on screen.
    ebayFeedbackOn: process.env.NEXUS_EBAY_REAL_API === 'true' && process.env.NEXUS_REVIEW_INGEST_MODE === 'live',
    amazonTopicsOn: process.env.NEXUS_ENABLE_AMAZON_REVIEW_INSIGHTS === '1',
    etsyReadOn: process.env.NEXUS_ENABLE_ETSY_REVIEWS_READ === '1',
    etsyLastReadAt: etsyRead?.startedAt ?? null,
    shopifyApp: shopifyAppFact(reviewApp),
  }
}

/** Every review source's state and the setup problems, now. */
export async function reviewSources(now: Date = new Date()): Promise<{ sources: ReviewSource[]; setup: SetupProblem[] }> {
  return sourcesFromFacts(await readSourceFacts(), now)
}
