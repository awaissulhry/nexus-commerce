/**
 * Meta ads step 30 (2026-10-21) — the Meta webhook receiver's work (the route is routes/meta-webhooks.routes.ts).
 *
 * Order, and why:
 *   1. TRUST. A delivery arrives on `/webhooks/meta/<app id>`: one Meta app per business portfolio, so the path names
 *      the app, never a business. Only the connections that USE that app (their app id, read once per APP_ID_TTL_MS
 *      inside their own business) are candidates — an app no business uses is refused before its body is read, and no
 *      secret is touched for it. Each candidate checks X-Hub-Signature-256 over the RAW bytes with ITS OWN app secret,
 *      inside its own business (token.service metaWebhookSignatureCheck). Nothing is parsed before that.
 *      A known app whose businesses' secrets ALL fail to sign the bytes: nothing is read, the delivery is answered 200
 *      (Meta unsubscribes a Page or Instagram account after an hour of failures), and each business using the app gets
 *      ONE ledger row per hour (the first body's digest and the signature header, never the bytes: they can hold
 *      another business's messages) and ONE unread notice ("signatures stopped matching": was the secret changed?).
 *   2. ROUTING, per change: the ad account, Page or Instagram account it names must be a link THAT business chose
 *      (MetaAccountLink, one business per id) through THAT connection; an app-level or catalog change goes only when
 *      exactly one business USES the app (signed or not) and that business signed; a permissions change only to the
 *      business whose system user it names. Anything else is answered 200 and ignored — never stored, never processed.
 *   3. RECORD, per business, in one batch (recordInboundBatch): one inbound-ledger row per change (`WebhookEvent`,
 *      channel META, event type `<object>.<field>`), keyed so Meta's 36-hour retries are no-ops (metaChangeKey),
 *      holding only the topic's allow-listed value (webhook-topics.ts). Topics Nexus only records are written done.
 *   4. ACT, under a batch claim of the ledger (claimInboundMany), while the answer budget lasts: each distinct action of
 *      the claimed rows runs once — a structure re-read of the ad account (enqueueMetaWebhookReread: one per account per
 *      10 minutes, on the queue) and/or an alerts-inbox notice to the business's owners (one unread per subject). What
 *      the budget did not reach is handed back unspent; the inbound-retry sweep runs it through handleMetaWebhookEvent,
 *      which checks ownership again first (also on a replay).
 *
 * Answers: 200 once every change is recorded or ignored; 503 only when the ledger could not take one (Meta resends;
 * the recorded ones are duplicates); 401 for an app no business uses.
 *
 * WH-003 (mutual TLS): optional at Meta; Nexus's API sits behind Railway's edge, which ends TLS (no client certificate
 * reaches the API), so the signature (WH-002, required) is the proof. Development-mode apps receive only the App
 * Dashboard's test notifications and those of people with a role on the app (RECHECK-C3 trap 8).
 */
import { createHash } from 'node:crypto'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { activeChannelRoutes, withIngressWorkspace } from '../../../lib/workspace-ingress.js'
import { metaAppIdOf, metaWebhookSignatureCheck } from '../../cx/token.service.js'
import { recordInbound, recordInboundBatch } from '../../cx/ingress/ledger.js'
import { claimInboundMany, finishInboundClaimMany, type InboundClaim } from '../../cx/ingress/claims.js'
import type { InboundHandlerContext } from '../../cx/ingress/handlers.js'
import { raiseChannelAlertInTx } from '../../cx/channel-alerts.service.js'
import { metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { enqueueMetaWebhookReread } from './enqueue.js'
import {
  MAX_CHANGES_PER_DELIVERY, META_WEBHOOK_TOPICS, metaChangeKey, metaChangeTime, metaRouteOf, metaSignatureNotice, metaTopicOf, metaWebhookChanges,
  metaWebhookNotice, metaWebhookPayload, type MetaNotice, type MetaRouteKind, type MetaWebhookChange, type MetaWebhookPayload,
} from './webhook-topics.js'

export const META_CHANNEL = 'META'
/** A Meta app id as connect.ts takes it. */
export const META_APP_ID = /^\d{5,25}$/
/** How long the receiver settles changes itself before it answers; the rest is due for the retry sweep. */
export const INLINE_BUDGET_MS = 1_500
/** A connection's app id is read (its credentials decrypted) at most this often. */
export const APP_ID_TTL_MS = 5 * 60_000

/** A business's Meta connection, as the receiver sees it. */
export interface MetaSigningBusiness {
  workspaceId: string
  connectionId: string
  /** The connection's system user (its externalAccountId): the only user a permissions change may name. */
  systemUserId: string | null
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ── who uses an app ────────────────────────────────────────────────────────────────────────────────────────────────

const appIds = new Map<string, { appId: string | null; at: number }>()
/** Tests, and a connection whose credentials changed: read the app ids again. */
export function forgetMetaAppIds(connectionId?: string): void {
  if (connectionId) appIds.delete(connectionId)
  else appIds.clear()
}

async function appIdOf(route: { workspaceId: string; connectionId: string }): Promise<string | null> {
  const kept = appIds.get(route.connectionId)
  if (kept && Date.now() - kept.at < APP_ID_TTL_MS) return kept.appId
  const appId = await withIngressWorkspace(route.workspaceId, () => metaAppIdOf(route.connectionId)).catch(() => null)
  appIds.set(route.connectionId, { appId, at: Date.now() })
  return appId
}

/** The Meta connections (one or more businesses) that use this app. No secret is read. */
export async function metaAppUsers(appId: string): Promise<MetaSigningBusiness[]> {
  if (!META_APP_ID.test(appId)) return []
  const users: MetaSigningBusiness[] = []
  for (const route of await activeChannelRoutes(META_CHANNEL)) {
    if ((await appIdOf(route)) === appId) users.push({ workspaceId: route.workspaceId, connectionId: route.connectionId, systemUserId: route.externalAccountId ?? null })
  }
  return users
}

/** Verification (GET) and the route's early refusal: does a connected business use this Meta app? */
export async function metaAppConnected(appId: string): Promise<boolean> {
  return (await metaAppUsers(appId)).length > 0
}

// ── 1. trust ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MetaSignatureVerdicts {
  /** Every connection using the app whose secret could be checked (signed or not). */
  users: MetaSigningBusiness[]
  /** The ones whose own secret signed these bytes. */
  signers: MetaSigningBusiness[]
  /** The ones whose secret did not. */
  mismatched: MetaSigningBusiness[]
}

/** Of the connections that use this app, which own secrets signed exactly these bytes (each checked in its business). */
export async function metaSignatureVerdicts(appId: string, rawBody: Buffer, signature: string | string[] | undefined): Promise<MetaSignatureVerdicts> {
  const out: MetaSignatureVerdicts = { users: [], signers: [], mismatched: [] }
  for (const user of await metaAppUsers(appId)) {
    const verdict = await withIngressWorkspace(user.workspaceId, () => metaWebhookSignatureCheck(user.connectionId, appId, rawBody, signature))
      .catch((err) => { logger.warn('[meta-webhooks] a connection could not check a signature', { error: errorText(err) }); return 'no_app' as const })
    if (verdict !== 'match' && verdict !== 'mismatch') { forgetMetaAppIds(user.connectionId); continue }
    out.users.push(user)
    ;(verdict === 'match' ? out.signers : out.mismatched).push(user)
  }
  return out
}

const raise = (notice: MetaNotice, meta: Record<string, unknown>) => raiseChannelAlertInTx(prisma, {
  kind: notice.kind, severity: notice.severity, title: notice.title, body: notice.body,
  entityType: notice.entityType, entityId: notice.entityId, href: notice.href, meta,
})

/**
 * A delivery for this app that these businesses' secrets do not sign: per business ONE ledger row per hour (the first
 * body's digest and the signature header; `deliveries` counts the rest) and ONE unread notice. Never the bytes, never
 * the platform's own business, never an exception.
 */
export async function recordMetaSignatureMismatch(appId: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>, businesses: MetaSigningBusiness[], now: Date = new Date()): Promise<void> {
  const digest = createHash('sha256').update(rawBody).digest('hex')
  const seen = new Set<string>()
  for (const business of businesses) {
    if (seen.has(business.workspaceId)) continue
    seen.add(business.workspaceId)
    await withIngressWorkspace(business.workspaceId, async () => {
      await recordInbound({
        channel: META_CHANNEL, eventType: 'unverified', externalId: `meta-unverified:${appId}:${now.toISOString().slice(0, 13)}`,
        payload: { appId, firstDigest: digest }, headers, rawBody: null, connectionId: business.connectionId,
        signatureOk: false, verifiedBy: 'none', status: 'failed',
        lastError: `X-Hub-Signature-256 does not match the app secret this business holds for Meta app ${appId}; nothing of the delivery was read.`,
      })
      await raise(metaSignatureNotice(appId), { source: 'meta-webhook', appId })
    }).catch((err) => logger.warn('[meta-webhooks] could not record a signature mismatch', { error: errorText(err) }))
  }
}

// ── 2. routing ─────────────────────────────────────────────────────────────────────────────────────────────────────

const LINK_PRODUCT: Partial<Record<MetaRouteKind, 'AD_ACCOUNT' | 'PAGE' | 'INSTAGRAM'>> = { AD_ACCOUNT: 'AD_ACCOUNT', PAGE: 'PAGE', INSTAGRAM: 'INSTAGRAM' }

/** Which of these ids this business chose (MetaAccountLink) through this very connection, read in its own business. */
async function ownedIds(business: MetaSigningBusiness, product: 'AD_ACCOUNT' | 'PAGE' | 'INSTAGRAM', ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await withIngressWorkspace(business.workspaceId, () => prisma.metaAccountLink.findMany({
    where: { product, externalId: { in: ids }, connectionId: business.connectionId },
    select: { externalId: true },
  }))
  return new Set(rows.map((r) => r.externalId))
}

/** The one signing business each change belongs to, or null (ignored). `users`: every business using the app. */
export async function routeMetaChanges(signers: MetaSigningBusiness[], users: MetaSigningBusiness[], changes: MetaWebhookChange[]): Promise<Array<MetaSigningBusiness | null>> {
  const routes = changes.map(metaRouteOf)
  const owned = new Map<string, Set<string>>()
  for (const product of ['AD_ACCOUNT', 'PAGE', 'INSTAGRAM'] as const) {
    const ids = [...new Set(routes.filter((r) => r && LINK_PRODUCT[r.kind] === product && r.id).map((r) => r!.id as string))]
    for (const business of signers) owned.set(`${business.connectionId}|${product}`, await ownedIds(business, product, ids))
  }
  // Review F3 — an app-level or catalog change names no business: only when ONE business uses the app at all.
  const usingWorkspaces = new Set([...users, ...signers].map((b) => b.workspaceId))
  const appBusiness = usingWorkspaces.size === 1 ? [...signers].sort((a, b) => a.connectionId.localeCompare(b.connectionId))[0] ?? null : null
  return routes.map((route) => {
    if (!route) return null
    const product = LINK_PRODUCT[route.kind]
    if (product) {
      if (!route.id) return null
      const holders = signers.filter((b) => owned.get(`${b.connectionId}|${product}`)?.has(route.id as string))
      return holders.length === 1 ? holders[0] : null
    }
    if (route.kind === 'USER') {
      const holders = signers.filter((b) => !!route.id && b.systemUserId === route.id)
      return holders.length === 1 ? holders[0] : null
    }
    return appBusiness
  })
}

// ── 3–4. record and settle ─────────────────────────────────────────────────────────────────────────────────────────

export interface MetaReceiveOutcome {
  changes: number
  recorded: number
  duplicates: number
  ignored: number
  handled: number
  failed: number
  /** Left for the inbound-retry sweep (the answer budget ran out, or another worker holds it). */
  later: number
  /** Changes the ledger could not take: the delivery is answered 503 so Meta sends it again. */
  notRecorded: number
}

interface Action { key: string; run: () => Promise<void> }

/** What a recorded change asks for: the re-read of its ad account and/or its notice, each with a key so a batch runs it once. */
function actionsOf(payload: MetaWebhookPayload): Action[] {
  const eventType = `${payload.object}.${payload.field}`
  const topic = META_WEBHOOK_TOPICS[eventType]
  if (!topic || topic.act === 'record') return []
  const actions: Action[] = []
  const route = metaRouteOf(payload)
  const adAccountId = route?.kind === 'AD_ACCOUNT' ? route.id : null
  if ((topic.act === 'reread' || topic.act === 'reread+notice') && adAccountId) {
    actions.push({ key: `reread|${adAccountId}`, run: async () => {
      const reread = await enqueueMetaWebhookReread(adAccountId)
      if (!reread.queued && reread.retry) throw new Error(`The re-read of the ad account was not queued: ${reread.reason}`)
      if (!reread.queued) logger.info('[meta-webhooks] no re-read queued', { eventType, reason: reread.reason })
    } })
  }
  if (topic.act === 'notice' || topic.act === 'reread+notice') {
    const notice = metaWebhookNotice(payload)
    if (notice) {
      actions.push({ key: `notice|${notice.kind}|${notice.entityType}|${notice.entityId}`, run: async () => {
        await raise(notice, { source: 'meta-webhook', topic: eventType, rows: topic.rows, appId: payload.appId, entryId: payload.entryId })
      } })
    }
  }
  return actions
}

function payloadOf(raw: unknown): MetaWebhookPayload | null {
  const p = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  if (!p || typeof p.appId !== 'string' || typeof p.object !== 'string' || typeof p.entryId !== 'string' || typeof p.field !== 'string') return null
  const value = p.value && typeof p.value === 'object' && !Array.isArray(p.value) ? p.value as Record<string, unknown> : {}
  return { appId: p.appId, object: p.object, entryId: p.entryId, field: p.field, time: typeof p.time === 'number' ? p.time : null, value }
}

/** Run each distinct action of the claimed rows once, until the deadline; finish the batch claim accordingly. */
async function settle(claims: InboundClaim[], deadline: number, outcome: MetaReceiveOutcome): Promise<void> {
  const results = new Map<string, true | string>()
  const done: string[] = []
  const release: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  for (const claim of claims) {
    const payload = payloadOf(claim.payload)
    if (!payload) { failed.push({ id: claim.id, error: 'This Meta notification row holds no readable change.' }); continue }
    let error: string | null = null
    let late = false
    for (const action of actionsOf(payload)) {
      if (!results.has(action.key)) {
        if (Date.now() > deadline) { late = true; break }
        try { await action.run(); results.set(action.key, true) } catch (err) { results.set(action.key, errorText(err)) }
      }
      const result = results.get(action.key)
      if (result !== true) { error = result as string; break }
    }
    if (late) release.push(claim.id)
    else if (error) failed.push({ id: claim.id, error })
    else done.push(claim.id)
  }
  await finishInboundClaimMany(claims, { done, release, failed })
  outcome.handled += done.length
  outcome.failed += failed.length
  outcome.later += release.length
  if (failed.length) logger.warn('[meta-webhooks] some changes failed; the ledger tries them again', { failed: failed.length })
}

/**
 * Steps 2–4 for a delivery that one or more businesses' secrets signed. Never throws for a change: each is recorded,
 * ignored or counted as not recorded. Null when the body is not Meta's envelope.
 */
export async function receiveMetaWebhook(input: { appId: string; signers: MetaSigningBusiness[]; users: MetaSigningBusiness[]; body: unknown; startedAt?: number }): Promise<MetaReceiveOutcome | null> {
  const changes = metaWebhookChanges(input.body)
  if (!changes) return null
  if (changes.length >= MAX_CHANGES_PER_DELIVERY) logger.warn('[meta-webhooks] a delivery held more changes than Nexus reads at once; the rest were not read', { read: changes.length })
  const deadline = (input.startedAt ?? Date.now()) + INLINE_BUDGET_MS
  const outcome: MetaReceiveOutcome = { changes: changes.length, recorded: 0, duplicates: 0, ignored: 0, handled: 0, failed: 0, later: 0, notRecorded: 0 }
  const owners = await routeMetaChanges(input.signers, input.users, changes)
  const byBusiness = new Map<string, { business: MetaSigningBusiness; changes: MetaWebhookChange[] }>()
  changes.forEach((change, i) => {
    const owner = owners[i]
    if (!owner) { outcome.ignored++; return }
    const group = byBusiness.get(owner.connectionId) ?? { business: owner, changes: [] }
    group.changes.push(change)
    byBusiness.set(owner.connectionId, group)
  })
  if (outcome.ignored) logger.info('[meta-webhooks] changes no business of this app chose were ignored', { ignored: outcome.ignored, objects: [...new Set(changes.map((c) => c.object))].slice(0, 5) })

  for (const { business, changes: own } of byBusiness.values()) {
    await withIngressWorkspace(business.workspaceId, async () => {
      const acts = own.map((change) => META_WEBHOOK_TOPICS[metaTopicOf(change)]?.act ?? 'record')
      const written = await recordInboundBatch(own.map((change, i) => ({
        channel: META_CHANNEL, eventType: metaTopicOf(change), externalId: metaChangeKey(input.appId, change),
        payload: metaWebhookPayload(input.appId, change), providerTimestamp: metaChangeTime(change.time),
        signatureOk: true, verifiedBy: 'meta_hmac' as const, connectionId: business.connectionId,
        status: acts[i] === 'record' ? 'done' as const : 'pending' as const,
      })))
      const due = new Set<string>()
      written.forEach((w, i) => {
        if (!w.id) { outcome.notRecorded++; return }
        if (w.duplicate) outcome.duplicates++
        else outcome.recorded++
        if (acts[i] !== 'record' && !(w.duplicate && w.existingStatus === 'done')) due.add(w.id)
      })
      if (due.size === 0) return
      if (Date.now() > deadline) { outcome.later += due.size; return }
      const { claims } = await claimInboundMany([...due]).catch((err) => {
        logger.warn('[meta-webhooks] could not claim the changes; the retry sweep runs them', { error: errorText(err) })
        return { claims: [] as InboundClaim[] }
      })
      outcome.later += due.size - claims.length
      await settle(claims, deadline, outcome).catch((err) => {
        logger.warn('[meta-webhooks] could not settle the changes; the retry sweep runs them', { error: errorText(err) })
      })
    })
  }
  return outcome
}

// ── the handler (retry sweep and replay, under the row's claim, in the row's business) ─────────────────────────────

/** Is the change still this business's, through this connection? */
async function stillOwned(payload: MetaWebhookPayload, connectionId: string): Promise<boolean> {
  const route = metaRouteOf(payload)
  if (!route) return false
  const product = LINK_PRODUCT[route.kind]
  if (product) {
    if (!route.id) return false
    return !!(await prisma.metaAccountLink.findFirst({ where: { product, externalId: route.id, connectionId }, select: { id: true } }))
  }
  if (route.kind === 'USER') {
    const id = metaObjectId(payload.entryId)
    return !!(id && await prisma.channelConnection.findFirst({ where: { id: connectionId, channelType: META_CHANNEL, isActive: true, externalAccountId: id }, select: { id: true } }))
  }
  // Review F3 — app-level and catalog: the connection still uses the app, and this is still the ONE business using it.
  if ((await metaAppIdOf(connectionId)) !== payload.appId) return false
  const using = new Set((await metaAppUsers(payload.appId)).map((u) => u.workspaceId))
  return using.size === 1 && using.has(workspaceIdForQuery())
}

/**
 * Run one recorded Meta change (the retry sweep, a replay): ownership again — a replay may come long after the business
 * let the object or the app go — then the re-read and/or the notice. Idempotent: the re-read is one job per account and
 * window, the notice one unread per subject and person.
 */
export async function handleMetaWebhookEvent(raw: unknown, context?: InboundHandlerContext): Promise<void> {
  const payload = payloadOf(raw)
  if (!payload) throw new Error('This Meta notification row holds no readable change.')
  const eventType = `${payload.object}.${payload.field}`
  const topic = META_WEBHOOK_TOPICS[eventType]
  if (!topic || topic.act === 'record') return
  const connectionId = context?.connectionId ?? null
  if (!connectionId) throw new Error('This Meta notification has no connected account on its ledger row.')
  if (!(await stillOwned(payload, connectionId))) {
    logger.info('[meta-webhooks] a recorded change is no longer this business\'s; nothing done', { eventType })
    return
  }
  for (const action of actionsOf(payload)) {
    context?.signal?.throwIfAborted()
    await action.run()
  }
}
