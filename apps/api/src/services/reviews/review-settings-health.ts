/**
 * Reviews › Settings (2026-10-26, build spec §3.6, PR D) — the Sources and Pipeline health sections: where each kind of
 * review data comes from and whether it still arrives, and the jobs behind them (schedule, last and next run, state).
 *
 * Sources build on review-sources.service.ts (the Overview's answer), never naming a setting: a person reads
 * "Sign-in expired · Reconnect eBay Germany", never a variable. Sources that arrive in a later phase are rows that say
 * "Coming later" (build spec ruling 3); Amazon gives sellers topics only, no review text and no stars (ruling 5).
 *
 * Pipeline jobs are read from the CronRun rows the jobs write (`recordCronRun`) and the schedules they use; the
 * output-freshness guard (review-pipeline-health.service.ts) adds what a job that "ran fine" did not do. A failure's
 * own text is shown only as a code in a tooltip, with any setting name taken out.
 *
 * Reviews PR I (2026-10-27): the Etsy row reads whether Nexus reads Etsy reviews (review-shop-channel-math.ts
 * `etsySource`), and the Shopify row the store's review app (Judge.me: connected, last read, or what went wrong; its
 * action opens the connect window on the page). Okendo, Yotpo and Loox stay "Coming later".
 *
 * Pure parts exported and tested in review-settings.vitest.test.ts.
 */
import prisma from '../../db.js'
import { channelMarketLabel, marketWords } from './overviewMath.js'
import { computeReviewPipelineFreshness, type PipelineFreshness } from './review-pipeline-health.service.js'
import { readAlert } from './review-settings.service.js'
import { visibleReviewWhere } from './review-visibility.js'
import { etsySource, type EtsySource } from './review-shop-channel-math.js'
import type { ReviewAppView } from './review-app-connection.service.js'
import { readSellerFeedbackState, SELLER_FEEDBACK_JOB, sellerFeedbackOn, sellerFeedbackSchedule, type SellerFeedbackState } from './amazon-seller-feedback.service.js'
import {
  NO_TOPICS_MARKETS, dayWords, readSourceFacts, settingsHref, sourcesFromFacts, topicStates, type SourceFacts,
} from './review-sources.service.js'

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

// ── Sources ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type SourceRowKey =
  | 'amazon-requests' | 'amazon-topics' | 'amazon-seller-feedback' | 'amazon-review-text' | 'ebay-feedback' | 'etsy-reviews' | 'shopify-app'

export type SourceTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info'

export interface SourceAction {
  /**
   * rules = the request rules / queue; reconnect / connect = Settings › Channels; import = the Inbox's Import window;
   * app = the review app's connect window on the page; page = a Reviews page (`href`);
   * fetch = "Fetch now" (POST /api/reviews/amazon/seller-feedback/fetch).
   */
  kind: 'rules' | 'reconnect' | 'connect' | 'import' | 'app' | 'page' | 'fetch'
  label: string
  /** Set for reconnect / connect (Settings › Channels › the channel); the page builds the Reviews links itself. */
  href: string | null
  /** Why the action cannot run now, in words (a held button says it); null when it can. */
  held?: string | null
}

export interface SettingsSourceRow {
  key: SourceRowKey
  name: string
  /** What it gives, in words. */
  what: string
  stateWords: string
  tone: SourceTone
  /** What is going on, in words a person can act on. */
  words: string
  /** "Coming later" words for the part that arrives in a later update; null when nothing does. */
  later: string | null
  /** When it last worked (ISO); null when never or not applicable. */
  lastAt: string | null
  /** The last-read cell in words when a date alone does not say it ("Never worked"). */
  lastWords: string | null
  action: SourceAction | null
}

export interface SourceExtraFacts {
  /** Amazon review requests sent in the last 30 days, per market. */
  amazonSent30: Array<{ marketplace: string | null; count: number }>
  amazonLastSentAt: Date | null
  /** The review-request mailer's pause, when a person paused it. */
  mailerPaused: { at: Date | null } | null
  /** Whether Nexus reads Etsy reviews (PR I). */
  etsy: EtsySource
  /** The store's review app (Judge.me) as the Shopify page shows it (PR I). */
  judgeme: ReviewAppView | null
  /** Amazon seller feedback fetches (PR H); left out = not read (the row says it could not be checked). */
  sellerFeedback?: SellerFeedbackState | null
}

const TOPIC_MARKETS_WORDS = 'Topics exist for the UK, Germany, France, Italy and Spain — not on Amazon.nl.'

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

const newest = (dates: Array<Date | null | undefined>): Date | null =>
  dates.reduce<Date | null>((best, d) => (d && (!best || d > best) ? d : best), null)

/** The Sources rows and how many need a person. Pure. */
export function settingsSourceRows(facts: SourceFacts, extra: SourceExtraFacts, now: Date): { rows: SettingsSourceRow[]; problems: number } {
  const { sources, setup } = sourcesFromFacts(facts, now)
  const amazonSignIn = setup.find((p) => p.id === 'amazon-signin') ?? null
  const lastImport = (channel: string) => newest(facts.reviewGroups.filter((g) => g.channel.toUpperCase() === channel && g.ingestSource === 'IMPORT_CSV').map((g) => g.lastIngestedAt))
  const rows: SettingsSourceRow[] = []

  // ── Amazon review requests ──
  const sent30 = extra.amazonSent30.reduce((n, m) => n + m.count, 0)
  const markets = extra.amazonSent30.filter((m) => m.count > 0).length
  const requests: SettingsSourceRow = {
    key: 'amazon-requests', name: 'Amazon review requests', what: 'Amazon’s own standard e-mail, on the day a review rule picks',
    stateWords: 'Not sending', tone: 'neutral', words: 'No Amazon review request went out in the last 30 days.', later: null,
    lastAt: extra.amazonLastSentAt?.toISOString() ?? null, lastWords: extra.amazonLastSentAt ? null : 'Never sent',
    action: { kind: 'rules', label: 'Open requests', href: null },
  }
  if (amazonSignIn) {
    Object.assign(requests, { stateWords: 'Needs a fix', tone: 'danger', words: amazonSignIn.words, action: { kind: 'reconnect', label: 'Reconnect Amazon', href: amazonSignIn.href } })
  } else if (extra.mailerPaused) {
    Object.assign(requests, {
      stateWords: 'Paused', tone: 'warning',
      words: `A person paused every review request${extra.mailerPaused.at ? ` on ${dayWords(extra.mailerPaused.at)}` : ''}. Nothing is sent until someone resumes them on the Requests page.`,
    })
  } else if (sent30 > 0) {
    Object.assign(requests, {
      stateWords: 'On', tone: 'success',
      words: `Sending in ${markets} ${markets === 1 ? 'market' : 'markets'} · ${sent30.toLocaleString('en-US')} in 30 days`,
    })
  }
  rows.push(requests)

  // ── Amazon topics (Customer Feedback API, weekly; needs the Selling Partner Insights role; not on Amazon.nl) ──
  const topics = [...topicStates(facts.topics).entries()].filter(([m]) => !NO_TOPICS_MARKETS.has(m))
  const denied = topics.filter(([, t]) => t.roleMissing).map(([m]) => m).sort()
  const working = topics.filter(([, t]) => t.lastOkAt && !t.roleMissing).map(([m]) => m).sort()
  const lastOk = newest(topics.map(([, t]) => t.lastOkAt))
  const topicRow: SettingsSourceRow = {
    key: 'amazon-topics', name: 'Amazon topics', what: 'Topics buyers mention, their share of reviews and star effect, per product',
    stateWords: 'Off', tone: 'neutral', later: null, lastAt: lastOk?.toISOString() ?? null, lastWords: lastOk ? null : '—', action: null,
    words: `Nexus does not read Amazon topics in this setup yet. They need the Selling Partner Insights role on the Amazon connection. ${TOPIC_MARKETS_WORDS}`,
  }
  if (amazonSignIn) {
    Object.assign(topicRow, { stateWords: 'Needs a fix', tone: 'danger', words: amazonSignIn.words, action: { kind: 'reconnect', label: 'Reconnect Amazon', href: amazonSignIn.href } })
  } else if (denied.length) {
    Object.assign(topicRow, {
      stateWords: 'Needs a fix', tone: 'warning',
      words: `Amazon refused the weekly read for ${listWords(denied.map((m) => marketWords(m) ?? m))}: the Selling Partner Insights role is missing. The account owner adds it in Seller Central, then connects Amazon again. ${TOPIC_MARKETS_WORDS}`,
      lastWords: lastOk ? `Last worked ${dayWords(lastOk)}` : 'Never worked',
      action: { kind: 'reconnect', label: 'Fix in Settings', href: settingsHref('AMAZON') },
    })
  } else if (working.length) {
    Object.assign(topicRow, {
      stateWords: 'On', tone: 'success',
      words: `Read every Monday for ${listWords(working.map((m) => marketWords(m) ?? m))}. Not available on Amazon.nl.`,
    })
  } else if (facts.amazonTopicsOn) {
    Object.assign(topicRow, { stateWords: 'Waiting', tone: 'info', words: `Nexus reads Amazon topics every Monday; none have arrived yet. ${TOPIC_MARKETS_WORDS}` })
  }
  rows.push(topicRow)

  // ── Amazon seller feedback (PR H): Amazon's 1–3 star report, fetched by Nexus daily and on "Fetch now" ──
  rows.push(sellerFeedbackRow(extra.sellerFeedback ?? null))

  // ── Amazon review text: no API gives it (ruling 5) ──
  const amazonImport = lastImport('AMAZON')
  rows.push({
    key: 'amazon-review-text', name: 'Amazon review text', what: 'The words and stars buyers write',
    stateWords: 'Not available', tone: 'neutral', later: null,
    words: 'Amazon gives sellers no review text and no star rating by API — only topics. Import a file if you have one.',
    lastAt: amazonImport?.toISOString() ?? null, lastWords: amazonImport ? null : 'Nothing imported',
    action: { kind: 'import', label: 'Import reviews…', href: null },
  })

  // ── eBay feedback ──
  const ebay = sources.filter((s) => s.channel === 'EBAY')
  const ebayRow: SettingsSourceRow = {
    // Photos and eBay's AI topics are read since #795 (eBay's REST feedback read): no longer "coming later" (live audit).
    key: 'ebay-feedback', name: 'eBay feedback', what: 'Seller feedback, with the buyer’s photos and eBay’s AI topics where eBay’s newer feedback read works; one public reply of up to 500 characters',
    stateWords: 'Not connected', tone: 'neutral', later: null, lastAt: null, lastWords: '—',
    words: 'No eBay account is connected to Nexus.', action: { kind: 'connect', label: 'Connect eBay', href: settingsHref('EBAY') },
  }
  if (ebay.length) {
    const broken = ebay.filter((s) => s.state === 'not_updating')
    const fine = ebay.filter((s) => s.state === 'ok').map((s) => channelMarketLabel('EBAY', s.market))
    if (broken.length) {
      const fix = broken.find((s) => s.reconnectHref)
      const lines = broken.map((s) => `${channelMarketLabel('EBAY', s.market)}: ${s.reason ?? 'not updating'}${s.since ? ` since ${dayWords(new Date(s.since))}` : ''}.`)
      if (fine.length) lines.push(`${listWords(fine)} ${fine.length === 1 ? 'is' : 'are'} fine.`)
      Object.assign(ebayRow, {
        stateWords: 'Needs a fix', tone: 'warning', words: lines.join(' '),
        lastAt: facts.lastReadAt?.toISOString() ?? null, lastWords: facts.lastReadAt ? null : 'Never read',
        action: fix ? { kind: 'reconnect', label: broken.length === 1 ? `Reconnect ${channelMarketLabel('EBAY', fix.market)}` : 'Reconnect eBay', href: fix.reconnectHref } : null,
      })
    } else {
      Object.assign(ebayRow, {
        stateWords: 'On', tone: 'success', words: `Read every 30 minutes for ${listWords(fine)}.`,
        lastAt: facts.lastReadAt?.toISOString() ?? null, lastWords: facts.lastReadAt ? null : 'Never read', action: null,
      })
    }
  }
  rows.push(ebayRow)

  // ── Etsy reviews (PR I): read every 30 minutes through the Etsy channel connection ──
  const etsy = extra.etsy
  rows.push({
    key: 'etsy-reviews', name: 'Etsy reviews', what: 'Reviews of 1 to 5 stars with text and one photo',
    stateWords: etsy.stateWords, tone: etsy.tone, later: null,
    words: `${etsy.words} Read only: you reply on Etsy.com, once, within 100 days of the buyer’s last edit, and the reply can’t be edited after.`,
    lastAt: etsy.lastReadAt, lastWords: etsy.lastReadAt ? null : 'Never read',
    action: etsy.state === 'not_connected'
      ? { kind: 'connect', label: 'Connect Etsy', href: etsy.reconnectHref }
      : etsy.state === 'needs_fix'
        ? { kind: 'reconnect', label: 'Reconnect Etsy', href: etsy.reconnectHref }
        : { kind: 'page', label: 'Open Etsy reviews', href: '/marketing/reviews/etsy' },
  })

  // ── Shopify review app (PR I): Judge.me connects; Okendo, Yotpo and Loox later ──
  const shopifyImport = lastImport('SHOPIFY')
  const app = extra.judgeme
  const connected = app != null && (app.state === 'connected' || app.state === 'waiting')
  rows.push({
    key: 'shopify-app', name: 'Shopify review app', what: 'Reviews with photos from the store’s review app · Judge.me: read and reply',
    stateWords: app?.stateWords ?? 'Not connected',
    tone: app?.state === 'needs_fix' ? 'danger' : app?.tone === 'warning' ? 'warning' : connected ? app!.tone : 'neutral',
    later: 'Okendo, Yotpo, Loox: coming later',
    words: `${app?.words ?? 'Connect Judge.me to let Nexus read the store’s reviews and post replies.'}${shopifyImport ? ` A file import also works: the last one was on ${dayWords(shopifyImport)}.` : ''}`,
    lastAt: app?.lastReadAt ?? shopifyImport?.toISOString() ?? null,
    lastWords: app?.lastReadAt || shopifyImport ? null : 'Never read',
    action: { kind: 'app', label: connected || app?.state === 'needs_fix' ? 'Manage Judge.me…' : 'Connect Judge.me…', href: null },
  })

  return { rows, problems: rows.filter((r) => r.tone === 'warning' || r.tone === 'danger').length }
}

/** Whether Nexus reads Etsy reviews for the business the request runs in (the Etsy page shows the same answer). */
export async function readEtsySource(): Promise<EtsySource> {
  const { etsyReviewsReadOn, ETSY_REVIEWS_JOB } = await import('../etsy/reviews-read.js')
  const { isOwnConnection } = await import('../connection-resolver.service.js')
  const [connections, lastRun, lastOk, count] = await Promise.all([
    prisma.channelConnection.findMany({ where: { channelType: 'ETSY' }, select: { id: true, isActive: true, authStatus: true, displayName: true, workspaceId: true } }),
    prisma.cronRun.findFirst({ where: { jobName: ETSY_REVIEWS_JOB }, orderBy: { startedAt: 'desc' }, select: { status: true, startedAt: true, errorMessage: true } }),
    prisma.cronRun.findFirst({ where: { jobName: ETSY_REVIEWS_JOB, status: { in: ['SUCCESS', 'PARTIAL'] } }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
    prisma.review.count({ where: visibleReviewWhere({ channel: 'ETSY' }) }),
  ])
  return etsySource({
    connections: connections.filter((c) => isOwnConnection(c)).map((c) => ({ id: c.id, isActive: c.isActive, authStatus: c.authStatus, shopName: c.displayName })),
    readOn: etsyReviewsReadOn(),
    lastRun: lastRun ?? null,
    lastOkAt: lastOk?.startedAt ?? null,
    reviews: count,
  })
}

const listMarkets = (codes: string[]) => listWords(codes.map((m) => marketWords(m) ?? m))

/** The Amazon seller feedback row from its fetch state. Pure. */
export function sellerFeedbackRow(state: SellerFeedbackState | null): SettingsSourceRow {
  const when = state?.every.startsWith('Daily') ? state.every.replace(/^Daily/, 'daily at') : 'every day'
  const report = 'Amazon’s report holds only feedback of 1 to 3 stars, and Amazon can’t schedule it, so Nexus asks for it'
  const row: SettingsSourceRow = {
    key: 'amazon-seller-feedback', name: 'Amazon seller feedback', what: 'Feedback of 1 to 3 stars about the seller',
    stateWords: 'Off', tone: 'neutral', later: null, lastAt: state?.lastOkAt ?? null, lastWords: state?.lastOkAt ? null : '—',
    words: `${report}. Nexus could not check the fetches just now.`,
    action: { kind: 'fetch', label: 'Fetch now', href: null, held: state ? state.held : 'Nexus could not check the fetches just now.' },
  }
  if (!state) return row
  if (!state.on) {
    return { ...row, words: `Off in this setup. When it is on, Nexus asks Amazon for it ${when}, and “Fetch now” asks at once. ${report}.` }
  }
  const failed = state.markets.filter((m) => m.state === 'failed')
  const fine = state.markets.filter((m) => m.state === 'ok').map((m) => m.market)
  const fetched = state.markets.filter((m) => m.state === 'ok').reduce((n, m) => n + (m.rows ?? 0), 0)
  if (state.fixHref && state.held) {
    return { ...row, stateWords: 'Needs a fix', tone: 'danger', words: state.held, action: { kind: 'reconnect', label: 'Reconnect Amazon', href: state.fixHref } }
  }
  if (state.markets.length === 0) return { ...row, stateWords: 'Not used', words: state.held ?? `${report}.` }
  if (failed.length) {
    const lines = failed.map((m) => `${marketWords(m.market) ?? m.market}: ${m.words}`)
    if (fine.length) lines.push(`${listMarkets(fine)} ${fine.length === 1 ? 'is' : 'are'} fine.`)
    return { ...row, stateWords: 'Needs a fix', tone: 'warning', words: lines.join(' '), lastWords: state.lastOkAt ? null : 'Never worked' }
  }
  if (state.fetching) return { ...row, stateWords: 'Fetching', tone: 'info', words: 'Nexus is asking Amazon for the report now. It shows in a few minutes.' }
  if (fine.length === 0) {
    return { ...row, stateWords: 'Waiting', tone: 'info', words: `Nexus asks Amazon ${when} for ${listMarkets(state.markets.map((m) => m.market))}; nothing fetched yet. “Fetch now” asks at once.` }
  }
  return {
    ...row, stateWords: 'On', tone: 'success',
    words: `Fetched ${when} for ${listMarkets(fine)} · ${fetched} feedback of 1–3 stars in the last 90 days.`,
  }
}

/** GET /api/reviews/settings/sources. */
export async function readSettingsSources(now: Date = new Date()): Promise<{ rows: SettingsSourceRow[]; problems: number; checkedAt: string }> {
  const since = new Date(now.getTime() - 30 * DAY)
  const [facts, sent, last, mailer, sellerFeedback, etsy, apps] = await Promise.all([
    readSourceFacts(),
    prisma.reviewRequest.groupBy({ by: ['marketplace'], where: { channel: 'AMAZON', status: 'SENT', sentAt: { gte: since } }, _count: { _all: true } }),
    prisma.reviewRequest.aggregate({ where: { channel: 'AMAZON', status: 'SENT' }, _max: { sentAt: true } }),
    prisma.reviewMailerState.findFirst({ select: { isPaused: true, pausedAt: true } }),
    readSellerFeedbackState(now).catch(() => null),
    readEtsySource(),
    import('./review-app-connection.service.js').then((m) => m.listReviewApps(now)),
  ])
  const { rows, problems } = settingsSourceRows(facts, {
    amazonSent30: sent.map((g) => ({ marketplace: g.marketplace, count: g._count._all })),
    amazonLastSentAt: last._max.sentAt ?? null,
    mailerPaused: mailer?.isPaused ? { at: mailer.pausedAt ?? null } : null,
    sellerFeedback,
    etsy,
    judgeme: apps.apps.find((a) => a.app === 'JUDGEME') ?? null,
  }, now)
  return { rows, problems, checkedAt: now.toISOString() }
}

// ── Pipeline health ──────────────────────────────────────────────────────────────────────────────────────────────

export interface PipelineJobDef {
  key: string
  name: string
  what: string
  /** The cron expression the job runs on (UTC). */
  schedule: string
}

/** The review jobs, in the order a review travels; each schedule as its job reads it. */
export function pipelineJobDefs(env: Record<string, string | undefined> = process.env): PipelineJobDef[] {
  return [
    { key: 'review-ingest', name: 'Review intake', what: 'Reads new reviews and feedback', schedule: env.NEXUS_REVIEW_INGEST_SCHEDULE ?? '*/30 * * * *' },
    { key: 'review-rule-evaluator', name: 'Review automations', what: 'Runs the review automations', schedule: env.NEXUS_REVIEW_RULE_SCHEDULE ?? '*/15 * * * *' },
    { key: 'orders-delivered-backfill', name: 'Delivered dates', what: 'Fills in delivery dates for the request queue', schedule: env.NEXUS_ORDERS_DELIVERED_BACKFILL_SCHEDULE ?? '30 3 * * *' },
    { key: 'review-request-mailer', name: 'Request sender', what: 'Sends the review requests that are due', schedule: env.NEXUS_REVIEW_MAILER_SCHEDULE ?? '0 * * * *' },
    { key: 'review-attribution', name: 'Review matching', what: 'Links reviews to the requests that asked for them', schedule: env.NEXUS_REVIEW_ATTRIBUTION_SCHEDULE ?? '0 */6 * * *' },
    { key: 'review-spike-detector', name: 'Spike check', what: 'Finds sudden rises in complaints, and rating drops when that alert is on', schedule: env.NEXUS_REVIEW_SPIKE_SCHEDULE ?? '17 * * * *' },
    { key: 'amazon-review-insights', name: 'Amazon topics', what: 'Weekly review topics per product from Amazon', schedule: env.NEXUS_AMAZON_REVIEW_INSIGHTS_SCHEDULE ?? '0 6 * * 1' },
    { key: SELLER_FEEDBACK_JOB, name: 'Amazon seller feedback', what: 'Asks Amazon for its 1–3 star seller feedback report', schedule: sellerFeedbackSchedule(env) },
    { key: 'review-digest', name: 'Daily digest', what: 'Morning e-mail about the day before', schedule: env.NEXUS_REVIEW_DIGEST_SCHEDULE ?? '0 8 * * *' },
    // PR I (2026-10-27) — jobs/shop-reviews-read.job.ts.
    { key: 'etsy-reviews-read', name: 'Etsy reviews', what: 'Reads new and edited Etsy reviews', schedule: env.NEXUS_ETSY_REVIEWS_SCHEDULE ?? '*/30 * * * *' },
    { key: 'review-app-read', name: 'Review app', what: 'Reads new reviews from the store’s review app (Judge.me)', schedule: env.NEXUS_REVIEW_APP_SCHEDULE ?? '*/30 * * * *' },
  ]
}

/** One cron field ("*", "5", "*\/15", "1,3", "1-5") → the values it allows in [min, max]; null when unreadable. */
function cronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return null
    let lo = min
    let hi = max
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number)
      if (!Number.isInteger(a)) return null
      lo = a
      hi = b === undefined ? (stepText === undefined ? a : max) : b
      if (!Number.isInteger(hi)) return null
    }
    for (let v = lo; v <= hi; v += step) if (v >= min && v <= max) out.add(v)
  }
  return out.size ? out : null
}

/** The next time (UTC, after `from`) a 5-field cron expression fires; null when it cannot be read. Within 8 days. */
export function nextCronRun(expr: string, from: Date): Date | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [mi, h, dom, mon, dow] = [cronField(parts[0], 0, 59), cronField(parts[1], 0, 23), cronField(parts[2], 1, 31), cronField(parts[3], 1, 12), cronField(parts[4], 0, 7)]
  if (!mi || !h || !dom || !mon || !dow) return null
  if (dow.has(7)) dow.add(0)
  const t = new Date(from.getTime())
  t.setUTCSeconds(0, 0)
  t.setUTCMinutes(t.getUTCMinutes() + 1)
  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (mi.has(t.getUTCMinutes()) && h.has(t.getUTCHours()) && dom.has(t.getUTCDate()) && mon.has(t.getUTCMonth() + 1) && dow.has(t.getUTCDay())) return t
    t.setUTCMinutes(t.getUTCMinutes() + 1)
  }
  return null
}

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const pad = (n: number) => String(n).padStart(2, '0')

/** How often a job runs, in words ("Every 30 min", "Daily 03:30 UTC", "Mondays 06:00 UTC"). */
export function everyWords(expr: string): string {
  const p = expr.trim().split(/\s+/)
  if (p.length !== 5) return 'On a schedule'
  const [mi, h, dom, mon, dow] = p
  const num = (s: string) => /^\d+$/.test(s)
  if (dom !== '*' || mon !== '*') return 'On a schedule'
  if (dow === '*' && h === '*' && /^\*\/\d+$/.test(mi)) return `Every ${mi.slice(2)} min`
  if (dow === '*' && h === '*' && num(mi)) return 'Every hour'
  if (dow === '*' && /^\*\/\d+$/.test(h) && num(mi)) return `Every ${h.slice(2)} hours`
  if (num(h) && num(mi)) {
    const at = `${pad(Number(h))}:${pad(Number(mi))} UTC`
    if (dow === '*') return `Daily ${at}`
    if (num(dow)) return `${DAYS[Number(dow) % 7]} ${at}`
  }
  return 'On a schedule'
}

/** A failure's own text, safe to show as a code: no setting name, at most 200 characters. */
export function scrubCode(message: string | null | undefined): string | null {
  const t = (message ?? '').replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, 'a setting').replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > 200 ? `${t.slice(0, 199)}…` : t
}

export interface CronRunFact {
  jobName: string
  status: string
  startedAt: Date
  finishedAt: Date | null
  errorMessage: string | null
}

export type JobState = 'healthy' | 'running' | 'stuck' | 'failed' | 'late' | 'partial' | 'never' | 'off'

export interface PipelineJobView {
  key: string
  name: string
  what: string
  every: string
  lastRunAt: string | null
  nextRunAt: string | null
  state: JobState
  stateWords: string
  tone: SourceTone
  /** The failure's own text (no setting names), for a tooltip; null when none. */
  code: string | null
  words: string
}

/** A run that has been RUNNING this long is stuck (the orphan sweeper's threshold). */
export const STUCK_AFTER_MS = 2 * HOUR

function failureWords(jobKey: string, message: string | null): string {
  const m = message ?? ''
  if (/^stale/i.test(m)) return 'It stopped without finishing, and Nexus marked the run as stopped. It runs again at its next time.'
  if (jobKey === 'amazon-review-insights' && /403|unauthori[sz]ed|role|brand analytics/i.test(m)) {
    return 'Amazon refused: the Selling Partner Insights role is missing. Fix it under Sources.'
  }
  if (/time(d)?\s?out/i.test(m)) return 'It took too long and was stopped. It runs again at its next time.'
  return 'The last run failed. The code says why; it runs again at its next time.'
}

function hoursWords(ms: number): string {
  const h = Math.floor(ms / HOUR)
  return h >= 1 ? `${h} ${h === 1 ? 'hour' : 'hours'}` : `${Math.max(1, Math.round(ms / 60000))} minutes`
}

/** Each job's state from its latest run (newest first in `runs`), its schedule and the digest switch. Pure. */
export function pipelineJobs(defs: PipelineJobDef[], runs: CronRunFact[], opts: { now: Date; digestOff: boolean; offKeys?: ReadonlySet<string> }): PipelineJobView[] {
  const { now } = opts
  return defs.map((def) => {
    const latest = runs.filter((r) => r.jobName === def.key).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null
    const next = nextCronRun(def.schedule, now)
    const afterNext = next ? nextCronRun(def.schedule, next) : null
    const interval = next && afterNext ? afterNext.getTime() - next.getTime() : null
    const view: PipelineJobView = {
      key: def.key, name: def.name, what: def.what, every: everyWords(def.schedule),
      lastRunAt: latest?.startedAt.toISOString() ?? null, nextRunAt: next?.toISOString() ?? null,
      state: 'healthy', stateWords: 'Healthy', tone: 'success', code: null, words: '',
    }
    if (def.key === 'review-digest' && opts.digestOff) {
      return { ...view, state: 'off', stateWords: 'Off', tone: 'neutral', nextRunAt: null, words: 'Turned off under Alerts.' }
    }
    if (opts.offKeys?.has(def.key)) {
      return { ...view, state: 'off', stateWords: 'Off', tone: 'neutral', nextRunAt: null, words: 'Off in this setup (see Sources).' }
    }
    if (!latest) return { ...view, state: 'never', stateWords: 'Not run yet', tone: 'neutral', words: 'It has not run for this business yet.' }
    const age = now.getTime() - latest.startedAt.getTime()
    switch (latest.status) {
      case 'RUNNING':
        return age > STUCK_AFTER_MS
          ? { ...view, state: 'stuck', stateWords: 'Stuck', tone: 'danger', words: `Running for ${hoursWords(age)} without finishing. “Fix stuck jobs” marks the run as stopped, so the job runs again at its next time.` }
          : { ...view, state: 'running', stateWords: 'Running', tone: 'info', words: 'Running now.' }
      case 'FAILED':
        return { ...view, state: 'failed', stateWords: 'Failed', tone: 'danger', code: scrubCode(latest.errorMessage), words: failureWords(def.key, latest.errorMessage) }
      case 'NOT_CONFIGURED':
        return { ...view, state: 'off', stateWords: 'Not set up', tone: 'neutral', words: 'It ran, but has nothing to do in this setup.' }
      case 'PARTIAL':
        return { ...view, state: 'partial', stateWords: 'Partly done', tone: 'warning', words: 'The last run did part of its work. It runs again at its next time.' }
    }
    if (interval != null && age > interval * 2 + 10 * 60 * 1000) {
      return { ...view, state: 'late', stateWords: 'Late', tone: 'warning', words: 'It did not run at its last time.' }
    }
    return view
  })
}

/**
 * The Amazon topics job's row, in the Sources row's own facts (live audit B06: Sources said "Needs a fix — refused for
 * Germany and Italy" while this row said "Not run yet"). The newest topic read decides: refused for the missing role →
 * "Failed" with the role's words; read → when. A job switched off in this setup stays "Off" and says what the last read
 * found. Pure.
 */
export function withTopicReads(job: PipelineJobView, topics: SourceFacts['topics']): PipelineJobView {
  const usable = topics.filter((t) => !NO_TOPICS_MARKETS.has(t.marketplace.toUpperCase()))
  if (job.key !== 'amazon-review-insights' || usable.length === 0) return job
  const states = [...topicStates(usable).entries()]
  const denied = states.filter(([, t]) => t.roleMissing).map(([m]) => marketWords(m) ?? m).sort()
  const lastAt = usable.reduce<Date | null>((best, t) => (!best || t.fetchedAt > best ? t.fetchedAt : best), null)!
  const read = denied.length
    ? `The last read, on ${dayWords(lastAt)}, was refused for ${listWords(denied)}: the Selling Partner Insights role is missing. Fix it under Sources.`
    : `The last read worked on ${dayWords(lastAt)}.`
  if (job.state === 'off') return { ...job, words: `${job.words} ${read}` }
  if (job.state !== 'never') return job
  return denied.length
    ? { ...job, state: 'failed', stateWords: 'Failed', tone: 'danger', lastRunAt: lastAt.toISOString(), words: read }
    : { ...job, state: 'healthy', stateWords: 'Healthy', tone: 'success', lastRunAt: lastAt.toISOString(), words: read }
}

/** What the freshness guard found, in words (never a setting name). */
export function freshnessProblems(f: Pick<PipelineFreshness, 'deliveryStale' | 'overdueUndelivered' | 'schedulingStalled' | 'schedulingBacklog'>): string[] {
  const out: string[] = []
  if (f.deliveryStale) {
    out.push(`${f.overdueUndelivered.toLocaleString('en-US')} Amazon orders shipped 6 or more days ago still have no delivery date, so their review requests wait. “Delivered dates” fills them in.`)
  }
  if (f.schedulingStalled) {
    out.push(`${f.schedulingBacklog.toLocaleString('en-US')} delivered Amazon orders inside the request window have no review request yet. The request sender may have stopped picking them up.`)
  }
  return out
}

export interface PipelineView {
  jobs: PipelineJobView[]
  /** Sentences for what needs a person beyond a job's own state. */
  problems: string[]
  /** Jobs whose state needs a person (stuck, failed, late, partly done). */
  troubled: number
  stuck: number
  checkedAt: string
}

/** GET /api/reviews/settings/pipeline. */
export async function readSettingsPipeline(now: Date = new Date()): Promise<PipelineView> {
  const defs = pipelineJobDefs()
  const [latest, digest, freshness, topicReads] = await Promise.all([
    Promise.all(defs.map((d) => prisma.cronRun.findFirst({
      where: { jobName: d.key },
      orderBy: { startedAt: 'desc' },
      select: { jobName: true, status: true, startedAt: true, finishedAt: true, errorMessage: true },
    }))),
    readAlert('digest'),
    computeReviewPipelineFreshness(),
    prisma.amazonReviewInsight.findMany({ select: { marketplace: true, accessStatus: true, fetchedAt: true } }),
  ])
  // PR H: seller feedback; PR I: the Etsy and review-app reads — each runs only where its deployment switch is on (never
  // named on screen).
  const offKeys = new Set([
    ...(sellerFeedbackOn() ? [] : [SELLER_FEEDBACK_JOB]),
    // The weekly topics read runs only where it is switched on (runtime/scheduler.ts).
    ...(process.env.NEXUS_ENABLE_AMAZON_REVIEW_INSIGHTS === '1' ? [] : ['amazon-review-insights']),
    ...(process.env.NEXUS_ENABLE_ETSY_REVIEWS_READ === '1' ? [] : ['etsy-reviews-read']),
    ...(process.env.NEXUS_ENABLE_REVIEW_APP_READ === '1' ? [] : ['review-app-read']),
  ])
  const jobs = pipelineJobs(defs, latest.filter((r): r is CronRunFact => r != null), { now, digestOff: !digest.on, offKeys }).map((j) => withTopicReads(j, topicReads))
  return {
    jobs,
    problems: freshnessProblems(freshness),
    troubled: jobs.filter((j) => j.tone === 'danger' || j.tone === 'warning').length,
    stuck: jobs.filter((j) => j.state === 'stuck').length,
    checkedAt: now.toISOString(),
  }
}
