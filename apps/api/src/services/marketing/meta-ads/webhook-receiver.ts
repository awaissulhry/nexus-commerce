/**
 * Meta ads step 30 (2026-10-21) — the Meta webhook receiver's work (the route is routes/meta-webhooks.routes.ts).
 *
 * Order, and why:
 *   1. TRUST. A delivery arrives on `/webhooks/meta/<app id>`: one Meta app per business portfolio, so the path names
 *      the app, never a business. Every active Meta connection is a candidate; each checks X-Hub-Signature-256 over the
 *      RAW bytes with ITS OWN app secret, inside its own business (token.service metaWebhookSignatureCheck). The
 *      businesses whose secret signed the bytes are the only ones the delivery can belong to. Nothing is parsed before
 *      that; a delivery no secret signed is recorded as rejected (legacy ledger, raw bytes kept for a later re-check)
 *      and answered 401.
 *   2. ROUTING, per change: the ad account, Page or Instagram account it names must be a link THAT business chose
 *      (MetaAccountLink, one business per id) through THAT connection; an app-level or catalog change goes only to the
 *      one business that uses the app; a permissions change only to the business whose system user it names. A change
 *      that fits no signing business is answered 200 and ignored — never stored, never processed for anyone.
 *   3. RECORD, per change, in its business: one inbound-ledger row (`WebhookEvent`, channel META, event type
 *      `<object>.<field>`) keyed by a digest of the change itself (stable across Meta's 36-hour retries), holding only
 *      the topic's allow-listed value (webhook-topics.ts). A redelivery adds to `deliveries` and does nothing else.
 *   4. ACT, under the ledger's processing claim (inline while the answer budget lasts, else by the inbound-retry sweep):
 *      the handler checks ownership again in its own business, asks for a structure re-read of the ad account
 *      (enqueueMetaWebhookReread: one per account per 10 minutes, on the queue) and/or raises the alerts-inbox notice
 *      to the business's owners (one unread per subject). Topics Nexus only records are written as done.
 *
 * Meta answers: retries up to 36 h, and a Page/Instagram delivery that keeps failing for an hour unsubscribes the app —
 * so a delivery is answered 200 as soon as every change of it is recorded (or ignored), 503 only when the ledger could
 * not take one (Meta resends; the recorded ones are duplicates), 401 when no business's secret signed it.
 *
 * WH-003 (mutual TLS): optional at Meta; Nexus's API sits behind Railway's edge, which ends TLS and passes no client
 * certificate, so the signature (WH-002, required) is the proof. Development-mode apps receive only the App Dashboard's
 * test notifications and those of people with a role on the app (RECHECK-C3 trap 8): a quiet receiver is not broken.
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { activeChannelRoutes, legacyIngress, withIngressWorkspace } from '../../../lib/workspace-ingress.js'
import { metaAppIdOf, metaWebhookSignatureCheck } from '../../cx/token.service.js'
import { InboundDeferred, recordInbound } from '../../cx/ingress/ledger.js'
import { claimInbound, runWithInboundClaim } from '../../cx/ingress/claims.js'
import type { InboundHandlerContext } from '../../cx/ingress/handlers.js'
import { raiseChannelAlertInTx } from '../../cx/channel-alerts.service.js'
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { enqueueMetaWebhookReread } from './enqueue.js'
import {
  MAX_CHANGES_PER_DELIVERY, META_WEBHOOK_TOPICS, metaChangeKey, metaChangeTime, metaRouteOf, metaTopicOf, metaWebhookChanges, metaWebhookNotice, metaWebhookPayload,
  type MetaRouteKind, type MetaWebhookChange, type MetaWebhookPayload,
} from './webhook-topics.js'

export const META_CHANNEL = 'META'
/** A Meta app id as connect.ts takes it. */
export const META_APP_ID = /^\d{5,25}$/
/** How long the receiver handles recorded changes itself before it answers; the rest is due for the retry sweep. */
export const INLINE_BUDGET_MS = 2_000

/** A business whose own Meta app secret signed a delivery. */
export interface MetaSigningBusiness {
  workspaceId: string
  connectionId: string
  /** The connection's system user (its externalAccountId): the only user a permissions change may name. */
  systemUserId: string | null
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Verification (GET): does a connected business use this Meta app? (Its app id is read inside its own business.) */
export async function metaAppConnected(appId: string): Promise<boolean> {
  if (!META_APP_ID.test(appId)) return false
  for (const route of await activeChannelRoutes(META_CHANNEL)) {
    const own = await withIngressWorkspace(route.workspaceId, () => metaAppIdOf(route.connectionId)).catch(() => null)
    if (own === appId) return true
  }
  return false
}

/**
 * Step 1 — the businesses whose own app secret signed exactly these bytes. `appKnown` says whether any connected
 * business uses the app at all (for the words of a rejection).
 */
export async function metaSigningBusinesses(appId: string, rawBody: Buffer, signature: string | string[] | undefined): Promise<{ businesses: MetaSigningBusiness[]; appKnown: boolean }> {
  const businesses: MetaSigningBusiness[] = []
  let appKnown = false
  if (!META_APP_ID.test(appId)) return { businesses, appKnown }
  for (const route of await activeChannelRoutes(META_CHANNEL)) {
    const verdict = await withIngressWorkspace(route.workspaceId, () => metaWebhookSignatureCheck(route.connectionId, appId, rawBody, signature))
      .catch((err) => { logger.warn('[meta-webhooks] a connection could not check a signature', { error: errorText(err) }); return 'no_app' as const })
    if (verdict === 'match' || verdict === 'mismatch') appKnown = true
    if (verdict === 'match') businesses.push({ workspaceId: route.workspaceId, connectionId: route.connectionId, systemUserId: route.externalAccountId ?? null })
  }
  return { businesses, appKnown }
}

/** A delivery no business's secret signed: one legacy-ledger row (the raw bytes and the signature header, never parsed). */
export async function recordMetaRejection(rawBody: Buffer | null, headers: Record<string, string | string[] | undefined>, reason: string): Promise<void> {
  await legacyIngress(() => recordInbound({
    channel: META_CHANNEL, eventType: 'unverified', externalId: null, rawBody, payload: {}, headers,
    signatureOk: false, verifiedBy: 'none', status: 'failed', lastError: reason,
  })).catch((err) => logger.warn('[meta-webhooks] could not record a rejected delivery', { error: errorText(err) }))
}

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

/** Step 2 — the one signing business each change belongs to, or null (ignored). */
export async function routeMetaChanges(businesses: MetaSigningBusiness[], changes: MetaWebhookChange[]): Promise<Array<MetaSigningBusiness | null>> {
  const routes = changes.map(metaRouteOf)
  const owned = new Map<string, Set<string>>()
  for (const product of ['AD_ACCOUNT', 'PAGE', 'INSTAGRAM'] as const) {
    const ids = [...new Set(routes.filter((r) => r && LINK_PRODUCT[r.kind] === product && r.id).map((r) => r!.id as string))]
    for (const business of businesses) owned.set(`${business.connectionId}|${product}`, await ownedIds(business, product, ids))
  }
  const workspaces = [...new Set(businesses.map((b) => b.workspaceId))]
  const appBusiness = workspaces.length === 1 ? [...businesses].sort((a, b) => a.connectionId.localeCompare(b.connectionId))[0] : null
  return routes.map((route) => {
    if (!route) return null
    const product = LINK_PRODUCT[route.kind]
    if (product) {
      if (!route.id) return null
      const holders = businesses.filter((b) => owned.get(`${b.connectionId}|${product}`)?.has(route.id as string))
      return holders.length === 1 ? holders[0] : null
    }
    if (route.kind === 'USER') {
      const holders = businesses.filter((b) => !!route.id && b.systemUserId === route.id)
      return holders.length === 1 ? holders[0] : null
    }
    return appBusiness
  })
}

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

/**
 * Steps 2–4 for a delivery whose signature one or more businesses' secrets matched. Never throws for a change: each is
 * recorded, ignored or counted as not recorded.
 */
export async function receiveMetaWebhook(input: { appId: string; businesses: MetaSigningBusiness[]; body: unknown; startedAt?: number }): Promise<MetaReceiveOutcome | null> {
  const changes = metaWebhookChanges(input.body)
  if (!changes) return null
  if (changes.length >= MAX_CHANGES_PER_DELIVERY) logger.warn('[meta-webhooks] a delivery held more changes than Nexus reads at once; the rest were not read', { read: changes.length })
  const deadline = (input.startedAt ?? Date.now()) + INLINE_BUDGET_MS
  const outcome: MetaReceiveOutcome = { changes: changes.length, recorded: 0, duplicates: 0, ignored: 0, handled: 0, failed: 0, later: 0, notRecorded: 0 }
  const owners = await routeMetaChanges(input.businesses, changes)
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
      for (const change of own) {
        const eventType = metaTopicOf(change)
        const act = META_WEBHOOK_TOPICS[eventType]?.act ?? 'record'
        let written: Awaited<ReturnType<typeof recordInbound>>
        try {
          written = await recordInbound({
            channel: META_CHANNEL, eventType, externalId: metaChangeKey(input.appId, change),
            payload: metaWebhookPayload(input.appId, change), providerTimestamp: metaChangeTime(change.time),
            signatureOk: true, verifiedBy: 'meta_hmac', connectionId: business.connectionId,
            status: act === 'record' ? 'done' : 'pending',
          })
        } catch (err) {
          logger.error('[meta-webhooks] the ledger refused a change', { eventType, error: errorText(err) })
          written = { id: null, duplicate: false }
        }
        if (!written.id) { outcome.notRecorded++; continue }
        if (written.duplicate) { outcome.duplicates++; if (written.existingStatus === 'done') continue } else outcome.recorded++
        if (act === 'record') continue
        if (Date.now() > deadline) { outcome.later++; continue }
        const claim = await claimInbound(written.id).catch(() => null)
        if (!claim) { outcome.later++; continue }
        try {
          await runWithInboundClaim(claim, (stored, signal) => handleMetaWebhookEvent(stored.payload, { connectionId: stored.connectionId, eventType: stored.eventType, channel: stored.channel, signal }))
          outcome.handled++
        } catch (err) {
          // The claim scheduled the retry (or gave the attempt back for a deferral); Meta is not asked to resend.
          if (err instanceof InboundDeferred) outcome.later++
          else { outcome.failed++; logger.warn('[meta-webhooks] handling a change failed; the ledger tries again', { eventType, error: errorText(err) }) }
        }
      }
    })
  }
  return outcome
}

// ── the handler (receiver, retry sweep and replay all run this, under the row's claim, in the row's business) ─────────

function payloadOf(raw: unknown): MetaWebhookPayload | null {
  const p = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  if (!p || typeof p.appId !== 'string' || typeof p.object !== 'string' || typeof p.entryId !== 'string' || typeof p.field !== 'string') return null
  const value = p.value && typeof p.value === 'object' && !Array.isArray(p.value) ? p.value as Record<string, unknown> : {}
  return { appId: p.appId, object: p.object, entryId: p.entryId, field: p.field, time: typeof p.time === 'number' ? p.time : null, value }
}

/** Is the change still this business's, through this connection? The ad account id when it names one. */
async function stillOwned(payload: MetaWebhookPayload, connectionId: string): Promise<{ ok: boolean; adAccountId: string | null }> {
  const route = metaRouteOf({ object: payload.object, entryId: payload.entryId, time: payload.time, field: payload.field, value: payload.value })
  if (!route) return { ok: false, adAccountId: null }
  const product = LINK_PRODUCT[route.kind]
  if (product) {
    if (!route.id) return { ok: false, adAccountId: null }
    const link = await prisma.metaAccountLink.findFirst({ where: { product, externalId: route.id, connectionId }, select: { id: true } })
    return { ok: !!link, adAccountId: product === 'AD_ACCOUNT' ? route.id : null }
  }
  if (route.kind === 'USER') {
    const id = metaObjectId(payload.entryId)
    const own = id ? await prisma.channelConnection.findFirst({ where: { id: connectionId, channelType: META_CHANNEL, isActive: true, externalAccountId: id }, select: { id: true } }) : null
    return { ok: !!own, adAccountId: null }
  }
  return { ok: (await metaAppIdOf(connectionId)) === payload.appId, adAccountId: null }
}

/**
 * Run one recorded Meta change: ownership again (a replay may come long after the business let the object go), then the
 * re-read and/or the notice. Idempotent: the re-read is one job per account and window, the notice one unread per
 * subject and person.
 */
export async function handleMetaWebhookEvent(raw: unknown, context?: InboundHandlerContext): Promise<void> {
  const payload = payloadOf(raw)
  if (!payload) throw new Error('This Meta notification row holds no readable change.')
  const eventType = `${payload.object}.${payload.field}`
  const topic = META_WEBHOOK_TOPICS[eventType]
  if (!topic || topic.act === 'record') return
  const connectionId = context?.connectionId ?? null
  if (!connectionId) throw new Error('This Meta notification has no connected account on its ledger row.')
  const owned = await stillOwned(payload, connectionId)
  if (!owned.ok) {
    logger.info('[meta-webhooks] a recorded change is no longer this business\'s; nothing done', { eventType })
    return
  }
  context?.signal?.throwIfAborted()
  if (topic.act === 'reread' || topic.act === 'reread+notice') {
    const adAccountId = owned.adAccountId ?? metaAdAccountId(payload.entryId)
    if (adAccountId) {
      const reread = await enqueueMetaWebhookReread(adAccountId)
      if (!reread.queued && reread.retry) throw new Error(`The re-read of the ad account was not queued: ${reread.reason}`)
      if (!reread.queued) logger.info('[meta-webhooks] no re-read queued', { eventType, reason: reread.reason })
    }
  }
  if (topic.act === 'notice' || topic.act === 'reread+notice') {
    const notice = metaWebhookNotice(payload)
    if (notice) {
      await raiseChannelAlertInTx(prisma, {
        kind: notice.kind, severity: notice.severity, title: notice.title, body: notice.body,
        entityType: notice.entityType, entityId: notice.entityId, href: notice.href,
        meta: { source: 'meta-webhook', topic: eventType, rows: topic.rows, appId: payload.appId, entryId: payload.entryId },
      })
    }
  }
}
