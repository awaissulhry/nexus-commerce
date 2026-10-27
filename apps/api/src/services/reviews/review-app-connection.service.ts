/**
 * Reviews (2026-10-27, build spec B21 / PR I; Okendo, Yotpo and Loox 2026-10-28) — the store's review apps a business
 * connects to Nexus: Settings › Sources "Connect your review app" and the Shopify reviews page. Each app connects with
 * what it needs, the secret stored encrypted and never shown again:
 *
 *   Judge.me  the store's myshopify address + a private API token      read every 30 min · reply from Nexus
 *   Okendo    the Okendo User ID + the API key (Merchant REST API)      read every 30 min · reply from Nexus
 *   Yotpo     the store ID (app key) + the API secret                   read every 30 min · reply in Yotpo
 *   Loox      the public store ID + an API key (Merchant API)           read every 30 min · reply in Loox
 *
 * The model keeps one row per business and app (unique workspaceId + app), so a business may connect more than one
 * app; each is read and answered on its own. The column `shopDomain` holds what the app knows the store by and is not a
 * secret: Judge.me's myshopify address, Okendo's User ID, Yotpo's store ID, Loox's public store ID.
 *
 *   GET    /api/reviews/apps            each app's state in words — NEVER a secret (not even part of it)
 *   POST   /api/reviews/apps/:app       the app's fields → stored with `encryptCredentials`; the app is not called here:
 *                                       the first read checks the key, and its answer shows as the state
 *   DELETE /api/reviews/apps/:app       the secret is wiped (credentials null, state DISCONNECTED); reviews already read stay
 *
 * Reading: `readReviewAppsOnce()` — the 30-minute job (jobs/shop-reviews-read.job.ts, clustered, once per business,
 * behind NEXUS_ENABLE_REVIEW_APP_READ) — reads every connected app's reviews into `Review` (channel SHOPIFY,
 * ingestSource JUDGEME_API | OKENDO_API | YOTPO_API | LOOX_API) through the shared ingest (dedupe on the app's review id —
 * Judge.me's id as it is, the others prefixed "okendo:", "yotpo:", "loox:" — sentiment, live events), and updates a review
 * the buyer edited. Replying: `sendReviewAppReply()` posts a person's reply where the app allows it (Judge.me, Okendo).
 *
 * A secret is decrypted only inside this file, only to call its app, and never logged or returned.
 */
import type { Prisma } from '@prisma/client'
import { REVIEW_APP_NAME, REVIEW_APP_REPLIES, REVIEW_APP_SOURCE, REVIEW_APPS, reviewAppReplyHref, type ReviewApp } from '@nexus/shared/review-reply-rules'
import prisma from '../../db.js'
import { decryptCredentials, encryptCredentials } from '../../lib/crypto.js'
import { logger } from '../../utils/logger.js'
import {
  JudgemeError, normalizeApiToken, normalizeShopDomain, postJudgemeReply, readJudgemeReviews,
} from './adapters/shopify-review-app.adapter.js'
import { normalizeOkendoUserId, postOkendoReply, readOkendoReviews } from './adapters/okendo-review-app.adapter.js'
import { readYotpoReviews } from './adapters/yotpo-review-app.adapter.js'
import { readLooxReviews } from './adapters/loox-review-app.adapter.js'
import { appReviewIdOf, normalizeSecret, normalizeStoreId, ReviewAppError, type AppReplyResult, type AppReviewParsed } from './adapters/review-app-http.js'
import type { AdapterRawReview } from './adapters/types.js'

/** The CronRun name of the 30-minute read (jobs/shop-reviews-read.job.ts). */
export const REVIEW_APP_JOB = 'review-app-read'

/** The deployment switch for the 30-minute read (never named on screen). */
export function reviewAppReadOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEXUS_ENABLE_REVIEW_APP_READ === '1'
}

export type ReviewAppStateKind = 'connected' | 'waiting' | 'needs_fix' | 'disconnected' | 'not_connected'

/** One thing the connect window asks for. The secret one is a password field, never filled back in. */
export interface ReviewAppField {
  key: string
  label: string
  hint: string
  secret: boolean
  placeholder: string | null
}

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
  /** What the connect window asks for, in order. */
  fields: ReviewAppField[]
  /** The plan the app's API needs, and what to do on another plan (export a CSV and import it), in words. */
  planWords: string
  /** What the app knows the store by (not a secret): the myshopify address or the app's store / user id; null when never connected. */
  storeId: string | null
  /** The same in words: "a-store.myshopify.com", "Store ID 4JG3Fn92E.37d…". */
  storeWords: string | null
  connectedAt: string | null
  lastReadAt: string | null
  lastReadCount: number | null
  /** The app lets Nexus post replies (Judge.me, Okendo). */
  replies: boolean
  /** Nexus posts replies through this app now (it replies, and it is connected). */
  canReply: boolean
  /** Where a reply is posted by hand in the app (Yotpo, Loox, and Okendo while not connected); null for Judge.me. */
  replyHref: string | null
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

interface AppSpec {
  what: string
  fields: ReviewAppField[]
  /** The secret's name in the encrypted blob. */
  secretKey: 'apiToken' | 'apiKey' | 'apiSecret'
  /** The secret in words ("the API token"), for disconnect and fix words. */
  secretWords: string
  /** Not connected yet: what to paste, in words. */
  notConnected: string
  planWords: string
  storeWords: (storeId: string) => string
}

const SECRET_HINT = 'Nexus stores it encrypted and never shows it again — not even here.'
const CSV = (name: string) => `On another plan, export the reviews as a CSV file in ${name} and import the file here (Inbox › Import reviews).`
const shortId = (id: string) => (id.length > 16 ? `${id.slice(0, 14)}…` : id)

/** What each app asks for and says (docs in each adapter's header). */
const SPECS: Record<ReviewApp, AppSpec> = {
  JUDGEME: {
    what: 'Reviews and photos (videos marked) · read and reply',
    fields: [
      { key: 'shopDomain', label: 'Store address', hint: 'The store’s Shopify address, like name.myshopify.com.', secret: false, placeholder: 'name.myshopify.com' },
      { key: 'apiToken', label: 'Judge.me private API token', hint: `From your Judge.me admin (Settings › Integrations › View API token). ${SECRET_HINT}`, secret: true, placeholder: null },
    ],
    secretKey: 'apiToken',
    secretWords: 'the API token',
    notConnected: 'Paste the store’s domain and a private API token from Judge.me to let Nexus read the reviews and post replies.',
    planWords: 'Judge.me gives every plan a private API token.',
    storeWords: (id) => id,
  },
  OKENDO: {
    what: 'Reviews and photos (videos marked) · read and reply',
    fields: [
      { key: 'userId', label: 'Okendo User ID', hint: 'In the Okendo app’s integration settings, next to the API key. It is not secret.', secret: false, placeholder: '00000000-0000-0000-0000-000000000000' },
      { key: 'apiKey', label: 'Okendo API key', hint: `The 32-character key in the same place. ${SECRET_HINT}`, secret: true, placeholder: null },
    ],
    secretKey: 'apiKey',
    secretWords: 'the API key',
    notConnected: 'Paste the User ID and the API key from Okendo’s integration settings to let Nexus read the reviews and post replies.',
    planWords: `Okendo shares reviews by API with its API access: on the Growth plan and up, or as an add-on on Essentials. ${CSV('Okendo')}`,
    storeWords: (id) => `User ID ${shortId(id)}`,
  },
  YOTPO: {
    what: 'Reviews and photos (videos marked) · read only — reply in Yotpo',
    fields: [
      { key: 'storeId', label: 'Yotpo store ID (app key)', hint: 'In Yotpo: Account Settings › General Settings, at the bottom. It is not secret.', secret: false, placeholder: null },
      { key: 'apiSecret', label: 'Yotpo API secret', hint: `Same page, “Get secret key” — only the account administrator sees it. ${SECRET_HINT}`, secret: true, placeholder: null },
    ],
    secretKey: 'apiSecret',
    secretWords: 'the API secret',
    notConnected: 'Paste the store ID and the API secret from Yotpo to let Nexus read the reviews. Yotpo gives apps no way to reply: replies are posted in Yotpo.',
    planWords: `Yotpo shares reviews by API on its Premium plan. ${CSV('Yotpo')}`,
    storeWords: (id) => `Store ID ${shortId(id)}`,
  },
  LOOX: {
    what: 'Reviews and photos (videos marked) · read only — reply in Loox',
    fields: [
      { key: 'storeId', label: 'Loox public store ID', hint: 'In Loox: Settings › API Keys. It is not secret.', secret: false, placeholder: null },
      { key: 'apiKey', label: 'Loox API key', hint: `Same page, “Generate”: Loox shows the key once. ${SECRET_HINT}`, secret: true, placeholder: null },
    ],
    secretKey: 'apiKey',
    secretWords: 'the API key',
    notConnected: 'Paste the public store ID and an API key from Loox to let Nexus read the reviews. Loox gives apps no way to reply: replies are posted in Loox.',
    planWords: `Loox shares reviews by API on its Convert and Unlimited plans. ${CSV('Loox')}`,
    storeWords: (id) => `Store ID ${shortId(id)}`,
  },
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

/** The app a request names ("okendo" → OKENDO), or null. */
export function reviewAppFrom(raw: unknown): ReviewApp | null {
  const app = String(raw ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '')
  return (REVIEW_APPS as readonly string[]).includes(app) ? app as ReviewApp : null
}

/** One app's state in words, from its row (or none). Pure. */
export function reviewAppView(app: ReviewApp, row: ReviewAppRow | null, opts: { readOn: boolean; now: Date }): ReviewAppView {
  const spec = SPECS[app]
  const name = REVIEW_APP_NAME[app]
  const replies = REVIEW_APP_REPLIES[app]
  const storeId = row?.shopDomain || null
  const base = {
    app, name, what: spec.what, fields: spec.fields, planWords: spec.planWords, storeId, storeWords: storeId ? spec.storeWords(storeId) : null,
    connectedAt: row?.createdAt.toISOString() ?? null, lastReadAt: row?.lastReadAt?.toISOString() ?? null,
    lastReadCount: row?.lastReadCount ?? null, replies, canReply: false,
    replyHref: reviewAppReplyHref(app),
  }
  if (!row || (!row.hasCredentials && row.state !== 'DISCONNECTED')) {
    return { ...base, state: 'not_connected', stateWords: 'Not connected', tone: 'neutral', words: spec.notConnected }
  }
  if (row.state === 'DISCONNECTED' || !row.hasCredentials) {
    return {
      ...base, state: 'disconnected', stateWords: 'Disconnected', tone: 'neutral',
      words: `Disconnected: Nexus no longer reads ${name} and ${spec.secretWords.replace(/^the /, 'its ')} was deleted. The reviews already read stay. Connect again any time.`,
    }
  }
  if (row.state === 'NEEDS_FIX') {
    return {
      ...base, state: 'needs_fix', stateWords: 'Needs a fix', tone: 'danger',
      words: `${row.lastError ?? `${name} refused ${spec.secretWords}.`} Until it is pasted again, Nexus cannot read ${name}${replies ? ' or post replies there' : ''}.`,
    }
  }
  const readWords = row.lastReadAt
    ? `Read every 30 min · last read ${agoWords(row.lastReadAt, opts.now)}${row.lastReadCount != null ? ` (${row.lastReadCount.toLocaleString('en')} reviews)` : ''}.`
    : `Connected. The first read checks ${spec.secretWords} and brings the reviews in.`
  const canReply = replies
  if (!opts.readOn) {
    return {
      ...base, state: 'waiting', stateWords: 'Connected · not read yet', tone: 'info', canReply,
      words: `Connected. Nexus does not read the review app in this setup yet, so new reviews do not arrive${replies ? '; replies to reviews already read can still be sent' : ''}.${row.lastReadAt ? ` Last read ${agoWords(row.lastReadAt, opts.now)}.` : ''}`,
    }
  }
  if (row.lastError) {
    return { ...base, state: 'connected', stateWords: 'Connected · last read failed', tone: 'warning', canReply, words: `${row.lastError} ${row.lastReadAt ? `Last good read ${agoWords(row.lastReadAt, opts.now)}.` : ''}`.trim() }
  }
  return { ...base, state: row.lastReadAt ? 'connected' : 'waiting', stateWords: row.lastReadAt ? 'Connected' : 'Connected · waiting for the first read', tone: row.lastReadAt ? 'success' : 'info', canReply, words: readWords }
}

const ROW_SELECT = {
  app: true, shopDomain: true, state: true, credentials: true, lastReadAt: true, lastReadCount: true, lastError: true, lastErrorAt: true, createdAt: true,
} as const

type DbRow = Prisma.ReviewAppConnectionGetPayload<{ select: typeof ROW_SELECT }>

/** The row without its secret: the blob only says whether a key is held. */
function safeRow(row: DbRow): ReviewAppRow {
  return {
    app: row.app, shopDomain: row.shopDomain, state: row.state, hasCredentials: !!row.credentials,
    lastReadAt: row.lastReadAt, lastReadCount: row.lastReadCount, lastError: row.lastError, lastErrorAt: row.lastErrorAt, createdAt: row.createdAt,
  }
}

/** A view's state counts as connected (read, or waiting for its read). */
export function isConnectedView(view: Pick<ReviewAppView, 'state'> | null | undefined): boolean {
  return !!view && (view.state === 'connected' || view.state === 'waiting')
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

/** Whether Nexus holds a working connection to this app (a key, not disconnected, not refused). */
export async function reviewAppConnected(app: ReviewApp): Promise<boolean> {
  const row = await prisma.reviewAppConnection.findFirst({ where: { app }, select: { state: true, credentials: true } })
  return !!row?.credentials && row.state !== 'DISCONNECTED' && row.state !== 'NEEDS_FIX'
}

export type ConnectResult = { ok: true; app: ReviewAppView } | { ok: false; status: 400 | 404; error: string; words: string }

export type ConnectCheck = { ok: true; storeId: string; secret: string } | { ok: false; error: string; words: string }

/** Checks a connect request for one app. Pure: the words say what to fix; a secret is never echoed. */
export function validateReviewAppConnect(app: ReviewApp, body: unknown): ConnectCheck {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const spec = SPECS[app]
  const [idField, secretField] = spec.fields
  let storeId: string | null
  if (app === 'JUDGEME') storeId = normalizeShopDomain(b.shopDomain)
  else if (app === 'OKENDO') storeId = normalizeOkendoUserId(b.userId)
  else storeId = normalizeStoreId(b.storeId)
  if (!storeId) {
    const words = app === 'JUDGEME' ? 'Type the store’s Shopify address, like name.myshopify.com.'
      : app === 'OKENDO' ? 'Paste the Okendo User ID: 36 letters, digits and dashes, from the Okendo app’s integration settings.'
        : `Paste the ${idField.label.replace(/ \(app key\)$/, '')} as ${REVIEW_APP_NAME[app]} shows it: letters, digits, dots and dashes.`
    return { ok: false, error: app === 'JUDGEME' ? 'invalid_shop_domain' : 'invalid_store_id', words }
  }
  const secret = app === 'JUDGEME' ? normalizeApiToken(b.apiToken) : normalizeSecret(b[secretField.key])
  if (!secret) {
    const words = app === 'JUDGEME'
      ? 'Paste the private API token from Judge.me (Settings › Integrations › View API token in Judge.me).'
      : `Paste ${spec.secretWords} from ${REVIEW_APP_NAME[app]}: one word, at least 8 characters.`
    return { ok: false, error: 'invalid_token', words }
  }
  return { ok: true, storeId, secret }
}

/** POST /api/reviews/apps/:app — stores the secret encrypted. The app is not called: the next read checks it. */
export async function connectReviewApp(appRaw: unknown, body: unknown, actor: string, now: Date = new Date()): Promise<ConnectResult> {
  const app = reviewAppFrom(appRaw)
  if (!app) return { ok: false, status: 404, error: 'unknown_app', words: 'Nexus does not know that review app.' }
  const valid = validateReviewAppConnect(app, body)
  if (valid.ok === false) return { ok: false, status: 400, error: valid.error, words: valid.words }
  const { blob, keyId } = await encryptCredentials({ [SPECS[app].secretKey]: valid.secret })
  const data = {
    shopDomain: valid.storeId, credentials: blob, credentialsKeyId: keyId, state: 'CONNECTED',
    lastError: null, lastErrorAt: null, updatedBy: actor,
  }
  const existing = await prisma.reviewAppConnection.findFirst({ where: { app }, select: { id: true } })
  const row = existing
    ? await prisma.reviewAppConnection.update({ where: { id: existing.id }, data, select: ROW_SELECT })
    : await prisma.reviewAppConnection.create({ data: { app, ...data, createdBy: actor }, select: ROW_SELECT })
  logger.info('[review-apps] connected', { app, actor })
  return { ok: true, app: reviewAppView(app, safeRow(row), { readOn: reviewAppReadOn(), now }) }
}

/** DELETE /api/reviews/apps/:app — wipes the secret; the reviews already read stay. */
export async function disconnectReviewApp(appRaw: string, actor: string, now: Date = new Date()): Promise<{ ok: true; app: ReviewAppView } | { ok: false; status: 404; error: string; words: string }> {
  const app = reviewAppFrom(appRaw)
  if (!app) return { ok: false, status: 404, error: 'unknown_app', words: 'Nexus does not know that review app.' }
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

interface AppKey { id: string; app: ReviewApp; storeId: string; secret: string; lastReadAt: Date | null }

/** The decrypted key of one app, inside this file only. Null when not connected or the blob cannot be opened. */
async function appKey(app: ReviewApp): Promise<AppKey | null> {
  const row = await prisma.reviewAppConnection.findFirst({ where: { app }, select: { id: true, shopDomain: true, credentials: true, state: true, lastReadAt: true } })
  if (!row?.credentials || row.state === 'DISCONNECTED') return null
  try {
    const creds = await decryptCredentials(row.credentials)
    const secret = creds[SPECS[app].secretKey]
    return typeof secret === 'string' && secret ? { id: row.id, app, storeId: row.shopDomain, secret, lastReadAt: row.lastReadAt } : null
  } catch (err) {
    logger.warn('[review-apps] the key could not be opened', { app, error: err instanceof Error ? err.name : 'error' })
    return null
  }
}

// ── Reading ──────────────────────────────────────────────────────────

export interface ReviewAppReadResult { app: ReviewApp; seen: number; inserted: number; updated: number; error: string | null }

export interface ReviewAppReadSummary {
  enabled: boolean
  apps: number
  seen: number
  inserted: number
  updated: number
  errors: string[]
  /** Each connected app's read. */
  results: ReviewAppReadResult[]
}

/** What Nexus keeps of an app's answer that tells whether the review changed. */
interface ComparablePayload {
  updatedAt?: string | null
  photos?: unknown[]
  hasVideo?: boolean
  storeReply?: string | null
  mediaKnown?: false
}

/** What an already-stored review changes when the app's copy changed (the reviewer edited it, a reply came). Pure. */
export function appReviewChanges(stored: { rating: number | null; title: string | null; body: string; rawPayload: unknown }, parsed: { raw: AdapterRawReview }): Prisma.ReviewUpdateInput | null {
  const before = (stored.rawPayload && typeof stored.rawPayload === 'object' ? stored.rawPayload : {}) as ComparablePayload
  let after = parsed.raw.rawPayload as ComparablePayload
  // A read that did not look at the photos keeps the ones Nexus holds.
  if (after.mediaKnown === false) {
    const { mediaKnown: _skip, ...rest } = after
    after = { ...rest, photos: before.photos ?? [], hasVideo: before.hasVideo ?? false }
  }
  const textChanged = stored.body !== parsed.raw.body || (stored.title ?? null) !== (parsed.raw.title ?? null)
  const same = !textChanged && stored.rating === (parsed.raw.rating ?? null)
    && (before.updatedAt ?? null) === (after.updatedAt ?? null) && JSON.stringify(before.photos ?? []) === JSON.stringify(after.photos ?? [])
    && (before.hasVideo ?? false) === (after.hasVideo ?? false) && (before.storeReply ?? null) === (after.storeReply ?? null)
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

/** A review the app read: Judge.me's and the others' parsed reviews share this shape. */
type ParsedAppReview = Pick<AppReviewParsed, 'raw' | 'productExternalId'>

/**
 * Stores one app's reviews: new ones through the shared ingest, edited ones updated in place (photos replaced as a set,
 * unless the read did not look at them). The product: the Shopify product id the app names (`Product.shopifyProductId`);
 * Yotpo is sent a product key that may be the SKU, so a Yotpo review also matches a product by its SKU.
 */
export async function storeAppReviews(app: ReviewApp, parsed: ParsedAppReview[]): Promise<{ inserted: number; updated: number; errors: string[] }> {
  if (parsed.length === 0) return { inserted: 0, updated: 0, errors: [] }
  const ids = parsed.map((p) => p.raw.externalReviewId)
  const keys = [...new Set(parsed.map((p) => p.productExternalId).filter((x): x is string => !!x))]
  const [existing, products] = await Promise.all([
    prisma.review.findMany({
      where: { channel: 'SHOPIFY', externalReviewId: { in: ids } },
      select: {
        id: true, externalReviewId: true, rating: true, title: true, body: true, rawPayload: true,
        media: { select: { url: true, position: true }, orderBy: { position: 'asc' } },
      },
    }),
    keys.length === 0 ? Promise.resolve([]) : prisma.product.findMany({
      where: app === 'YOTPO' ? { OR: [{ shopifyProductId: { in: keys } }, { sku: { in: keys } }] } : { shopifyProductId: { in: keys } },
      select: { shopifyProductId: true, sku: true },
    }),
  ])
  const skuOf = new Map<string, string>()
  for (const p of products) {
    if (app === 'YOTPO' && keys.includes(p.sku)) skuOf.set(p.sku, p.sku)
    if (p.shopifyProductId) skuOf.set(p.shopifyProductId, p.sku)
  }
  const known = new Map(existing.map((r) => [r.externalReviewId, r]))
  const { ingestRawReviews, replaceReviewMedia } = await import('./review-ingest.service.js')
  let updated = 0
  const errors: string[] = []
  const fresh = parsed.filter((p) => !known.has(p.raw.externalReviewId)).map((p) => {
    const payload = p.raw.rawPayload as ComparablePayload | undefined
    // A new review: no photos found by this read means none.
    const rawPayload = payload?.mediaKnown === false ? (({ mediaKnown: _skip, ...rest }) => rest)(payload) : p.raw.rawPayload
    return { ...p.raw, rawPayload, sku: p.productExternalId ? skuOf.get(p.productExternalId) ?? undefined : undefined }
  })
  for (const p of parsed) {
    const stored = known.get(p.raw.externalReviewId)
    if (!stored) continue
    const change = appReviewChanges(stored, p)
    try {
      if (change) await prisma.review.update({ where: { id: stored.id }, data: change })
      // The photos as stored media (also for a review stored before Nexus kept media): replaced only when they differ,
      // and only when this read looked at them.
      const mediaChanged = p.raw.media === undefined ? false : await replaceReviewMedia(stored.id, stored.media ?? [], p.raw.media)
      if (change || mediaChanged) updated++
    } catch (err) {
      errors.push(`review ${p.raw.externalReviewId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const summary = await ingestRawReviews(fresh, { ingestSource: REVIEW_APP_SOURCE[app] })
  return { inserted: summary.reviewsInserted, updated, errors: [...errors, ...summary.errors] }
}

/** One app's reviews from the app itself. Throws JudgemeError | ReviewAppError. */
async function readApp(key: AppKey): Promise<{ reviews: ParsedAppReview[]; more: boolean; pages: number }> {
  switch (key.app) {
    case 'JUDGEME': return readJudgemeReviews({ shopDomain: key.storeId, apiToken: key.secret })
    case 'OKENDO': return readOkendoReviews({ userId: key.storeId, apiKey: key.secret })
    case 'YOTPO': return readYotpoReviews({ storeId: key.storeId, apiSecret: key.secret }, { since: key.lastReadAt })
    case 'LOOX': return readLooxReviews({ storeId: key.storeId, apiKey: key.secret })
  }
}

/** One read of every connected review app of the business being visited. Never throws. */
export async function readReviewAppsOnce(opts: { now?: () => Date } = {}): Promise<ReviewAppReadSummary> {
  const summary: ReviewAppReadSummary = { enabled: reviewAppReadOn(), apps: 0, seen: 0, inserted: 0, updated: 0, errors: [], results: [] }
  if (!summary.enabled) return summary
  const clock = opts.now ?? (() => new Date())
  for (const app of REVIEW_APPS) {
    const key = await appKey(app)
    if (!key) continue
    summary.apps++
    const result: ReviewAppReadResult = { app, seen: 0, inserted: 0, updated: 0, error: null }
    summary.results.push(result)
    try {
      const read = await readApp(key)
      result.seen = read.reviews.length
      const stored = await storeAppReviews(app, read.reviews)
      result.inserted = stored.inserted
      result.updated = stored.updated
      summary.errors.push(...stored.errors)
      await prisma.reviewAppConnection.update({
        where: { id: key.id },
        // A store with more reviews than one read takes (read.more) is read on at the next runs; that is not a failure.
        data: { state: 'CONNECTED', lastReadAt: clock(), lastReadCount: read.reviews.length, lastError: null, lastErrorAt: null },
      })
      if (read.more) logger.info('[review-apps] more pages wait for the next read', { app, pages: read.pages })
    } catch (err) {
      const known = err instanceof JudgemeError || err instanceof ReviewAppError
      const words = known ? err.message : `${REVIEW_APP_NAME[app]} could not be read.`
      result.error = words
      summary.errors.push(words)
      await prisma.reviewAppConnection.update({
        where: { id: key.id },
        data: { lastError: words, lastErrorAt: clock(), ...(known && err.kind === 'refused' ? { state: 'NEEDS_FIX' } : {}) },
      }).catch(() => undefined)
      logger.warn('[review-apps] read failed', { app, kind: known ? err.kind : 'error' })
    }
    summary.seen += result.seen
    summary.inserted += result.inserted
    summary.updated += result.updated
  }
  return summary
}

export function summarizeReviewAppRead(s: ReviewAppReadSummary): string {
  if (!s.enabled) return 'The review app read is off in this setup; nothing was read.'
  if (s.apps === 0) return 'No review app is connected.'
  return s.results.map((r) => r.error
    ? `${REVIEW_APP_NAME[r.app]}: not read (${r.error})`
    : `${REVIEW_APP_NAME[r.app]}: ${r.seen} read, ${r.inserted} new, ${r.updated} updated`).join('; ')
    + (s.errors.length ? ` · ${s.errors.length} problem(s)` : '')
}

// ── Replying ─────────────────────────────────────────────────────────

/**
 * Posts a person's reply under a review read from `app` (its Nexus `externalReviewId`). Only Judge.me and Okendo take
 * replies; a refused key marks the connection as needing a fix. Never throws.
 */
export async function sendReviewAppReply(app: ReviewApp, externalReviewId: string, text: string): Promise<AppReplyResult> {
  const name = REVIEW_APP_NAME[app]
  if (!REVIEW_APP_REPLIES[app]) return { ok: false, code: `${app}_NO_REPLY`, error: `${name} gives apps no way to reply. Nothing was sent.` }
  const key = await appKey(app)
  if (!key) return { ok: false, code: `${app}_NOT_CONNECTED`, error: `${name} is not connected to Nexus. Nothing was sent.` }
  let result: AppReplyResult
  if (app === 'JUDGEME') {
    result = await postJudgemeReply({ shopDomain: key.storeId, apiToken: key.secret, reviewId: externalReviewId, text })
  } else {
    const reviewId = appReviewIdOf(app, externalReviewId)
    if (!reviewId) return { ok: false, code: `${app}_NOT_SENT`, error: `This review has no ${name} id Nexus can answer. Nothing was sent.` }
    result = await postOkendoReply({ userId: key.storeId, apiKey: key.secret }, reviewId, text)
  }
  if (result.refusedKey) {
    await prisma.reviewAppConnection.update({ where: { id: key.id }, data: { state: 'NEEDS_FIX', lastError: result.error ?? `${name} refused ${SPECS[app].secretWords}.`, lastErrorAt: new Date() } }).catch(() => undefined)
  }
  return result
}
