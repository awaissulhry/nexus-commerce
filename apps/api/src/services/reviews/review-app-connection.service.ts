/**
 * Reviews (2026-10-27, build spec B21 / PR I) — the store's review app a business connects to Nexus: Settings › Sources
 * "Connect your review app" and the Shopify reviews page. Judge.me connects today (a private API token + the store's
 * myshopify domain); Okendo, Yotpo and Loox are listed as "Coming later".
 *
 *   GET    /api/reviews/apps            each app's state in words — NEVER the token (not even part of it)
 *   POST   /api/reviews/apps/judgeme    { shopDomain, apiToken } → stored with `encryptCredentials`; Judge.me is not
 *                                       called here: the first read checks the token, and its answer shows as the state
 *   DELETE /api/reviews/apps/judgeme    the token is wiped (credentials null, state DISCONNECTED); reviews already read stay
 *
 * Reading: `readReviewAppsOnce()` — the 30-minute job (jobs/shop-reviews-read.job.ts, clustered, once per business) —
 * reads every connected app's reviews into `Review` (channel SHOPIFY, ingestSource JUDGEME_API) through the shared
 * ingest (dedupe on the review's Judge.me id, sentiment, live events), and updates a review the buyer edited. Replying:
 * `sendJudgemeReply()` posts a person's reply (review-reply-send.service.ts, one press, Idempotency-Key).
 *
 * The token is decrypted only inside this file, only to call Judge.me, and never logged or returned.
 */
import type { Prisma } from '@prisma/client'
import { REVIEW_APP_NAME, REVIEW_APPS, type ReviewApp } from '@nexus/shared/review-reply-rules'
import prisma from '../../db.js'
import { decryptCredentials, encryptCredentials } from '../../lib/crypto.js'
import { logger } from '../../utils/logger.js'
import {
  JudgemeError, normalizeApiToken, normalizeShopDomain, postJudgemeReply, readJudgemeReviews,
  type JudgemeParsed, type JudgemePayload, type JudgemeReplyResult,
} from './adapters/shopify-review-app.adapter.js'

export const REVIEW_APP_INGEST_SOURCE = 'JUDGEME_API'
/** The CronRun name of the 30-minute read (jobs/shop-reviews-read.job.ts). */
export const REVIEW_APP_JOB = 'review-app-read'

/** The deployment switch for the 30-minute read (never named on screen). */
export function reviewAppReadOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEXUS_ENABLE_REVIEW_APP_READ === '1'
}

export type ReviewAppStateKind = 'connected' | 'waiting' | 'needs_fix' | 'disconnected' | 'not_connected' | 'later'

export interface ReviewAppView {
  app: ReviewApp
  name: string
  /** What the app gives Nexus, in words. */
  what: string
  state: ReviewAppStateKind
  stateWords: string
  tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info'
  /** What is going on, in words a person can act on. */
  words: string
  /** The store's myshopify domain (not a secret); null when never connected. */
  shopDomain: string | null
  connectedAt: string | null
  lastReadAt: string | null
  lastReadCount: number | null
  /** Nexus posts replies through this app (Judge.me, while connected). */
  canReply: boolean
  /** Only Judge.me connects today; the others are "Coming later" (build spec ruling 3). */
  connectable: boolean
}

export interface ReviewAppRow {
  app: string
  shopDomain: string
  state: string
  hasCredentials: boolean
  lastReadAt: Date | null
  lastReadCount: number | null
  lastError: string | null
  lastErrorAt: Date | null
  createdAt: Date
}

const WHAT: Record<ReviewApp, string> = {
  JUDGEME: 'Reviews and photos (videos marked) · read and reply',
  OKENDO: 'Reviews, photos and videos · read and reply (Enterprise plan only)',
  YOTPO: 'Reviews and photos · read only — reply in Yotpo',
  LOOX: 'Reviews, photos and videos · read only (Convert/Unlimited plan) — reply in Loox',
}

/** "12 min ago", "3 h ago", "2 days ago". */
export function agoWords(at: Date, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

/** One app's state in words, from its row (or none). Pure. */
export function reviewAppView(app: ReviewApp, row: ReviewAppRow | null, opts: { readOn: boolean; now: Date }): ReviewAppView {
  const base = {
    app, name: REVIEW_APP_NAME[app], what: WHAT[app], shopDomain: row?.shopDomain ?? null,
    connectedAt: row?.createdAt.toISOString() ?? null, lastReadAt: row?.lastReadAt?.toISOString() ?? null,
    lastReadCount: row?.lastReadCount ?? null, canReply: false, connectable: app === 'JUDGEME',
  }
  if (app !== 'JUDGEME') {
    return { ...base, state: 'later', stateWords: 'Coming later', tone: 'neutral', words: `Nexus does not connect to ${REVIEW_APP_NAME[app]} yet. Import a file from ${REVIEW_APP_NAME[app]} meanwhile.` }
  }
  if (!row || (!row.hasCredentials && row.state !== 'DISCONNECTED')) {
    return { ...base, state: 'not_connected', stateWords: 'Not connected', tone: 'neutral', words: 'Paste the store’s domain and a private API token from Judge.me to let Nexus read the reviews and post replies.' }
  }
  if (row.state === 'DISCONNECTED' || !row.hasCredentials) {
    return {
      ...base, state: 'disconnected', stateWords: 'Disconnected', tone: 'neutral',
      words: 'Disconnected: Nexus no longer reads Judge.me and its token was deleted. The reviews already read stay. Connect again any time.',
    }
  }
  if (row.state === 'NEEDS_FIX') {
    return {
      ...base, state: 'needs_fix', stateWords: 'Needs a fix', tone: 'danger',
      words: `${row.lastError ?? 'Judge.me refused the API token.'} Until a new token is pasted, Nexus cannot read Judge.me or post replies there.`,
    }
  }
  const readWords = row.lastReadAt
    ? `Read every 30 min · last read ${agoWords(row.lastReadAt, opts.now)}${row.lastReadCount != null ? ` (${row.lastReadCount.toLocaleString('en')} reviews)` : ''}.`
    : 'Connected. The first read checks the token and brings the reviews in.'
  if (!opts.readOn) {
    return {
      ...base, state: 'waiting', stateWords: 'Connected · not read yet', tone: 'info', canReply: true,
      words: `Connected. Nexus does not read the review app in this setup yet, so new reviews do not arrive; replies to reviews already read can still be sent.${row.lastReadAt ? ` Last read ${agoWords(row.lastReadAt, opts.now)}.` : ''}`,
    }
  }
  if (row.lastError) {
    return { ...base, state: 'connected', stateWords: 'Connected · last read failed', tone: 'warning', canReply: true, words: `${row.lastError} ${row.lastReadAt ? `Last good read ${agoWords(row.lastReadAt, opts.now)}.` : ''}`.trim() }
  }
  return { ...base, state: row.lastReadAt ? 'connected' : 'waiting', stateWords: row.lastReadAt ? 'Connected' : 'Connected · waiting for the first read', tone: row.lastReadAt ? 'success' : 'info', canReply: true, words: readWords }
}

const ROW_SELECT = {
  app: true, shopDomain: true, state: true, credentials: true, lastReadAt: true, lastReadCount: true, lastError: true, lastErrorAt: true, createdAt: true,
} as const

type DbRow = Prisma.ReviewAppConnectionGetPayload<{ select: typeof ROW_SELECT }>

/** The row without its secret: the blob only says whether a token is held. */
function safeRow(row: DbRow): ReviewAppRow {
  return {
    app: row.app, shopDomain: row.shopDomain, state: row.state, hasCredentials: !!row.credentials,
    lastReadAt: row.lastReadAt, lastReadCount: row.lastReadCount, lastError: row.lastError, lastErrorAt: row.lastErrorAt, createdAt: row.createdAt,
  }
}

/** GET /api/reviews/apps. */
export async function listReviewApps(now: Date = new Date()): Promise<{ apps: ReviewAppView[]; readOn: boolean }> {
  const rows = await prisma.reviewAppConnection.findMany({ select: ROW_SELECT })
  const readOn = reviewAppReadOn()
  return {
    readOn,
    apps: REVIEW_APPS.map((app) => {
      const row = rows.find((r) => r.app === app)
      return reviewAppView(app, row ? safeRow(row) : null, { readOn, now })
    }),
  }
}

/** The Judge.me connection's state for the reply rules: connected with a token, or not. */
export async function judgemeConnected(): Promise<boolean> {
  const row = await prisma.reviewAppConnection.findFirst({ where: { app: 'JUDGEME' }, select: { state: true, credentials: true } })
  return !!row?.credentials && row.state !== 'DISCONNECTED' && row.state !== 'NEEDS_FIX'
}

export type ConnectResult = { ok: true; app: ReviewAppView } | { ok: false; status: 400; error: string; words: string }

/** Checks a connect request. Pure: the words say what to fix; the token is never echoed. */
export function validateJudgemeConnect(body: unknown): { ok: true; shopDomain: string; apiToken: string } | { ok: false; error: string; words: string } {
  const b = (body && typeof body === 'object' ? body : {}) as { shopDomain?: unknown; apiToken?: unknown }
  const shopDomain = normalizeShopDomain(b.shopDomain)
  if (!shopDomain) return { ok: false, error: 'invalid_shop_domain', words: 'Type the store’s Shopify address, like name.myshopify.com.' }
  const apiToken = normalizeApiToken(b.apiToken)
  if (!apiToken) return { ok: false, error: 'invalid_token', words: 'Paste the private API token from Judge.me (Settings › Integrations › View API token in Judge.me).' }
  return { ok: true, shopDomain, apiToken }
}

/** POST /api/reviews/apps/judgeme — stores the token encrypted. Judge.me is not called: the next read checks it. */
export async function connectJudgeme(body: unknown, actor: string, now: Date = new Date()): Promise<ConnectResult> {
  const valid = validateJudgemeConnect(body)
  if (valid.ok === false) return { ok: false, status: 400, error: valid.error, words: valid.words }
  const { blob, keyId } = await encryptCredentials({ apiToken: valid.apiToken })
  const data = {
    shopDomain: valid.shopDomain, credentials: blob, credentialsKeyId: keyId, state: 'CONNECTED',
    lastError: null, lastErrorAt: null, updatedBy: actor,
  }
  const existing = await prisma.reviewAppConnection.findFirst({ where: { app: 'JUDGEME' }, select: { id: true } })
  const row = existing
    ? await prisma.reviewAppConnection.update({ where: { id: existing.id }, data, select: ROW_SELECT })
    : await prisma.reviewAppConnection.create({ data: { app: 'JUDGEME', ...data, createdBy: actor }, select: ROW_SELECT })
  logger.info('[review-apps] Judge.me connected', { app: 'JUDGEME', shopDomain: valid.shopDomain, actor })
  return { ok: true, app: reviewAppView('JUDGEME', safeRow(row), { readOn: reviewAppReadOn(), now }) }
}

/** DELETE /api/reviews/apps/:app — wipes the token; the reviews already read stay. */
export async function disconnectReviewApp(appRaw: string, actor: string, now: Date = new Date()): Promise<{ ok: true; app: ReviewAppView } | { ok: false; status: 404; error: string; words: string }> {
  const app = String(appRaw ?? '').toUpperCase() as ReviewApp
  if (!REVIEW_APPS.includes(app)) return { ok: false, status: 404, error: 'unknown_app', words: 'Nexus does not know that review app.' }
  const existing = await prisma.reviewAppConnection.findFirst({ where: { app }, select: { id: true } })
  if (!existing) return { ok: false, status: 404, error: 'not_connected', words: `${REVIEW_APP_NAME[app]} is not connected.` }
  const row = await prisma.reviewAppConnection.update({
    where: { id: existing.id },
    data: { credentials: null, credentialsKeyId: null, state: 'DISCONNECTED', updatedBy: actor },
    select: ROW_SELECT,
  })
  logger.info('[review-apps] disconnected', { app, actor })
  return { ok: true, app: reviewAppView(app, safeRow(row), { readOn: reviewAppReadOn(), now }) }
}

/** The decrypted Judge.me key, inside this file only. Null when not connected or the blob cannot be opened. */
async function judgemeKey(): Promise<{ id: string; shopDomain: string; apiToken: string } | null> {
  const row = await prisma.reviewAppConnection.findFirst({ where: { app: 'JUDGEME' }, select: { id: true, shopDomain: true, credentials: true, state: true } })
  if (!row?.credentials || row.state === 'DISCONNECTED') return null
  try {
    const creds = await decryptCredentials(row.credentials)
    const apiToken = typeof creds.apiToken === 'string' ? creds.apiToken : null
    return apiToken ? { id: row.id, shopDomain: row.shopDomain, apiToken } : null
  } catch (err) {
    logger.warn('[review-apps] the Judge.me token could not be opened', { error: err instanceof Error ? err.name : 'error' })
    return null
  }
}

// ── Reading ──────────────────────────────────────────────────────────

export interface ReviewAppReadSummary {
  enabled: boolean
  apps: number
  seen: number
  inserted: number
  updated: number
  errors: string[]
}

/** What an already-stored review changes when Judge.me's copy changed (the reviewer edited it). Pure. */
export function judgemeChanges(stored: { rating: number | null; title: string | null; body: string; rawPayload: unknown }, parsed: JudgemeParsed): Prisma.ReviewUpdateInput | null {
  const before = stored.rawPayload && typeof stored.rawPayload === 'object' ? stored.rawPayload as Partial<JudgemePayload> : {}
  const after = parsed.raw.rawPayload as JudgemePayload
  const textChanged = stored.body !== parsed.raw.body || (stored.title ?? null) !== (parsed.raw.title ?? null)
  const same = !textChanged && stored.rating === (parsed.raw.rating ?? null)
    && before.updatedAt === after.updatedAt && JSON.stringify(before.photos ?? []) === JSON.stringify(after.photos) && before.hasVideo === after.hasVideo
  if (same) return null
  return {
    rating: parsed.raw.rating ?? null,
    title: parsed.raw.title ?? null,
    body: parsed.raw.body,
    rawPayload: after as unknown as Prisma.InputJsonValue,
    // A new text needs a new translation (the Inbox translates again on demand).
    ...(textChanged ? { bodyEnglish: null } : {}),
  }
}

/** Stores Judge.me reviews: new ones through the shared ingest, edited ones updated in place (photos replaced as a set). */
export async function storeJudgemeReviews(parsed: JudgemeParsed[]): Promise<{ inserted: number; updated: number; errors: string[] }> {
  if (parsed.length === 0) return { inserted: 0, updated: 0, errors: [] }
  const ids = parsed.map((p) => p.raw.externalReviewId)
  const [existing, products] = await Promise.all([
    prisma.review.findMany({
      where: { channel: 'SHOPIFY', externalReviewId: { in: ids } },
      select: {
        id: true, externalReviewId: true, rating: true, title: true, body: true, rawPayload: true,
        media: { select: { url: true, position: true }, orderBy: { position: 'asc' } },
      },
    }),
    prisma.product.findMany({
      where: { shopifyProductId: { in: [...new Set(parsed.map((p) => p.productExternalId).filter((x): x is string => !!x))] } },
      select: { shopifyProductId: true, sku: true },
    }),
  ])
  const skuOf = new Map(products.map((p) => [p.shopifyProductId, p.sku]))
  const known = new Map(existing.map((r) => [r.externalReviewId, r]))
  const { ingestRawReviews, replaceReviewMedia } = await import('./review-ingest.service.js')
  let updated = 0
  const errors: string[] = []
  const fresh = parsed.filter((p) => !known.has(p.raw.externalReviewId)).map((p) => ({ ...p.raw, sku: p.productExternalId ? skuOf.get(p.productExternalId) ?? undefined : undefined }))
  for (const p of parsed) {
    const stored = known.get(p.raw.externalReviewId)
    if (!stored) continue
    const change = judgemeChanges(stored, p)
    try {
      if (change) await prisma.review.update({ where: { id: stored.id }, data: change })
      // The photos as stored media (also for a review stored before Nexus kept media): replaced only when they differ.
      const mediaChanged = await replaceReviewMedia(stored.id, stored.media ?? [], p.raw.media ?? [])
      if (change || mediaChanged) updated++
    } catch (err) {
      errors.push(`review ${p.raw.externalReviewId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const summary = await ingestRawReviews(fresh, { ingestSource: REVIEW_APP_INGEST_SOURCE })
  return { inserted: summary.reviewsInserted, updated, errors: [...errors, ...summary.errors] }
}

/** One read of the connected review app of the business being visited. Never throws. */
export async function readReviewAppsOnce(opts: { now?: () => Date } = {}): Promise<ReviewAppReadSummary> {
  const summary: ReviewAppReadSummary = { enabled: reviewAppReadOn(), apps: 0, seen: 0, inserted: 0, updated: 0, errors: [] }
  if (!summary.enabled) return summary
  const key = await judgemeKey()
  if (!key) return summary
  summary.apps = 1
  const clock = opts.now ?? (() => new Date())
  try {
    const read = await readJudgemeReviews({ shopDomain: key.shopDomain, apiToken: key.apiToken })
    summary.seen = read.reviews.length
    const stored = await storeJudgemeReviews(read.reviews)
    summary.inserted = stored.inserted
    summary.updated = stored.updated
    summary.errors.push(...stored.errors)
    await prisma.reviewAppConnection.update({
      where: { id: key.id },
      // A store with more reviews than one read takes (read.more) is read on at the next runs; that is not a failure.
      data: { state: 'CONNECTED', lastReadAt: clock(), lastReadCount: read.reviews.length, lastError: null, lastErrorAt: null },
    })
    if (read.more) logger.info('[review-apps] more Judge.me pages wait for the next read', { pages: read.pages })
  } catch (err) {
    const words = err instanceof JudgemeError ? err.message : 'The review app could not be read.'
    summary.errors.push(words)
    await prisma.reviewAppConnection.update({
      where: { id: key.id },
      data: { lastError: words, lastErrorAt: clock(), ...(err instanceof JudgemeError && err.kind === 'refused' ? { state: 'NEEDS_FIX' } : {}) },
    }).catch(() => undefined)
    logger.warn('[review-apps] read failed', { app: 'JUDGEME', kind: err instanceof JudgemeError ? err.kind : 'error' })
  }
  return summary
}

export function summarizeReviewAppRead(s: ReviewAppReadSummary): string {
  if (!s.enabled) return 'The review app read is off in this setup; nothing was read.'
  if (s.apps === 0) return 'No review app is connected.'
  return `Judge.me: ${s.seen} read, ${s.inserted} new, ${s.updated} updated${s.errors.length ? `, ${s.errors.length} problem(s)` : ''}`
}

// ── Replying ─────────────────────────────────────────────────────────

/** Posts a person's reply under a Judge.me review. A refused token marks the connection as needing a fix. */
export async function sendJudgemeReply(judgemeReviewId: string, text: string): Promise<JudgemeReplyResult> {
  const key = await judgemeKey()
  if (!key) return { ok: false, code: 'JUDGEME_NOT_CONNECTED', error: 'Judge.me is not connected to Nexus. Nothing was sent.' }
  const result = await postJudgemeReply({ shopDomain: key.shopDomain, apiToken: key.apiToken, reviewId: judgemeReviewId, text })
  if (result.refusedKey) {
    await prisma.reviewAppConnection.update({ where: { id: key.id }, data: { state: 'NEEDS_FIX', lastError: result.error ?? 'Judge.me refused the API token.', lastErrorAt: new Date() } }).catch(() => undefined)
  }
  return result
}
