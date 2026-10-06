import { createHash, randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { encryptCredentials } from '../../../lib/crypto.js'
import { legacyIngress, withIngressWorkspace } from '../../../lib/workspace-ingress.js'
import { LEGACY_WORKSPACE_ID, requireWorkspace } from '../../../lib/workspace-context.js'
import { recordInboundInTx, type InboundWriteResult } from './ledger.js'
import { readEbayNoticeIdentity, readEbayPublicationTime, type EbayNoticeIdentity } from './ebay-revocation-notice.js'
import { verifyEbayNotification, type EbayEnvironment } from './ebay-signature.js'
import { openEbayQuarantineBody } from './ebay-quarantine-crypto.js'

type Tx = Prisma.TransactionClient
type Quarantine = NonNullable<Awaited<ReturnType<typeof prisma.ebayNoticeQuarantine.findUnique>>>
const txOptions = { maxWait: 5_000, timeout: 30_000 }
const MAX_BYTES = 1_048_576
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
export const ebayReceiptExternalId = (environment: EbayEnvironment, externalId: string) => `ebay:${environment}:${externalId}`
const subjectHash = (environment: EbayEnvironment, userId: string) => digest(JSON.stringify([environment, userId]))

export class EbayAdmissionError extends Error {
  constructor(readonly reason: 'invalid_body' | 'storage_unavailable' | 'identity_conflict' | 'owner_unavailable' | 'adoption_forbidden' | 'cipher_unavailable') {
    super('The eBay notice could not be accepted or routed safely.')
    this.name = 'EbayAdmissionError'
  }
}

export type EbayAdmissionOutcome =
  | { kind: 'accepted'; receiptId: string; workspaceId: string; duplicate: boolean }
  | { kind: 'quarantined'; quarantineId: string; reason: string }
  | { kind: 'rejected'; quarantineId: string; reason: string }

interface Notice {
  environment: EbayEnvironment
  rawBody: Buffer
  payload: unknown
  signatureOk: boolean
  keyId: string | null
  externalId: string
  topic: string
  userId: string | null
  subjectHash: string | null
  payloadDigest: string
  reason: string | null
}

async function lockDelivery(tx: Tx, notice: Pick<Notice, 'environment' | 'signatureOk' | 'externalId'>) {
  const key = JSON.stringify(['nexus-ebay-ingress', notice.environment, notice.signatureOk, notice.externalId])
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

/** Topics routed to a business by their verified seller id. Every other topic stays in encrypted quarantine. */
const ROUTED_TOPICS: ReadonlySet<string> = new Set(['AUTHORIZATION_REVOCATION', 'ORDER_CONFIRMATION'])

async function ownerFor(tx: Pick<Tx, '$queryRaw'>, notice: Pick<Notice, 'signatureOk' | 'topic' | 'userId' | 'environment'>, lock: boolean) {
  if (!notice.signatureOk || !ROUTED_TOPICS.has(notice.topic) || !notice.userId) return null
  const rows = lock
    ? await tx.$queryRaw<Array<{ workspaceId: string; status: string }>>`
      SELECT * FROM nexus_lock_ebay_notice_owner(${notice.environment}, ${notice.userId})`
    : await tx.$queryRaw<Array<{ workspaceId: string; status: string }>>`
      SELECT o."workspaceId", w.status FROM "ChannelAccountOwnership" o JOIN "Workspace" w ON w.id=o."workspaceId"
      WHERE o."channelType"='EBAY' AND o.environment=${notice.environment} AND o."externalAccountId"=${notice.userId}`
  return rows[0] ?? null
}

/** Exact subject and environment; one active account wins over its inactive history. */
async function accountFor(tx: Tx, notice: Notice, workspaceId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; isActive: boolean; authStatus: string }>>`
    SELECT id, "isActive", "authStatus" FROM "ChannelConnection" WHERE "workspaceId"=${workspaceId} AND "channelType"='EBAY'
      AND "externalAccountId"=${notice.userId} AND "managedBy"='oauth'
      AND COALESCE("connectionMetadata"->>'environment','production')=${notice.environment}
    ORDER BY "isActive" DESC, id LIMIT 2`
  if (rows.length === 1 || (rows[0]?.isActive && !rows[1]?.isActive)) return rows[0]
  return null
}

/**
 * An order notice is only worth storing for processing when its account can read the order now: the
 * gateway holds every call of an inactive account or one that needs Reconnect (gateway.ts, step 2),
 * so such a receipt could only wait. It is quarantined instead (`account_not_connected`: the eBay
 * account is not connected; the 5-minute order check records the order after Reconnect).
 * Revocation is not affected: it is exactly the notice an account that lost its sign-in receives.
 */
const ACCOUNT_NEEDS_SIGNIN = new Set(['needs_reauth', 'revoked', 'disconnected'])
const heldForSignIn = (notice: Pick<Notice, 'topic'>, account: { isActive: boolean; authStatus: string }) =>
  notice.topic === 'ORDER_CONFIRMATION' && (!account.isActive || ACCOUNT_NEEDS_SIGNIN.has(account.authStatus))

function quarantineWhere(notice: Pick<Notice, 'environment' | 'signatureOk' | 'externalId'>) {
  return { environment_signatureOk_externalId: { environment: notice.environment, signatureOk: notice.signatureOk, externalId: notice.externalId } }
}

function binding(notice: Notice) {
  return { environment: notice.environment, signatureOk: notice.signatureOk, externalId: notice.externalId,
    topic: notice.topic, subjectHash: notice.subjectHash, payloadDigest: notice.payloadDigest }
}

async function seal(notice: Notice, header?: string) {
  try {
    return await encryptCredentials({ version: 1, binding: binding(notice), rawBody: notice.rawBody.toString('base64'), header: header ?? null })
  } catch { throw new EbayAdmissionError('cipher_unavailable') }
}

async function open(row: Quarantine): Promise<Notice> {
  try {
    const rawBody = await openEbayQuarantineBody(row)
    const payload: unknown = JSON.parse(rawBody.toString('utf8'))
    const identity = readEbayNoticeIdentity(payload)
    if (!row.signatureOk || identity.topic !== row.topic || identity.notificationId !== row.externalId || !identity.userId
      || subjectHash(row.environment as EbayEnvironment, identity.userId) !== row.subjectHash) throw new Error()
    return { environment: row.environment as EbayEnvironment, signatureOk: true, rawBody, payload, keyId: row.verificationKeyId,
      externalId: row.externalId, topic: row.topic, userId: identity.userId, subjectHash: row.subjectHash, payloadDigest: row.payloadDigest, reason: null }
  } catch { throw new EbayAdmissionError('cipher_unavailable') }
}

async function writeOwned(tx: Tx, notice: Notice, connectionId: string, history?: { receivedAt: Date; deliveries: number }): Promise<InboundWriteResult> {
  const result = await recordInboundInTx(tx, { channel: 'EBAY', eventType: notice.topic,
    externalId: ebayReceiptExternalId(notice.environment, notice.externalId), connectionId,
    // Unscheduled admission is invisible to old workers during a rolling deploy.
    // The ready protocol-aware worker activates and claims it atomically.
    payload: notice.payload, rawBody: notice.rawBody, signatureOk: true, verifiedBy: 'ebay_ecdsa', queueForRetry: false,
    providerTimestamp: readEbayPublicationTime(notice.payload),
  }, history)
  if (!result.id) throw new EbayAdmissionError(result.conflict ? 'identity_conflict' : 'storage_unavailable')
  return result
}

async function existingReceipt(tx: Tx, notice: Notice, workspaceId: string) {
  return tx.webhookEvent.findUnique({ where: { channel_externalId: { workspaceId, channel: 'EBAY', externalId: ebayReceiptExternalId(notice.environment, notice.externalId) } },
    select: { id: true, connectionId: true, eventType: true, payload: true, signatureOk: true, verifiedBy: true, archivedAt: true } })
}

async function sameSubject(tx: Tx, stored: NonNullable<Awaited<ReturnType<typeof existingReceipt>>>, notice: Notice): Promise<boolean> {
  if (stored.eventType !== notice.topic || !stored.signatureOk || stored.verifiedBy !== 'ebay_ecdsa') return false
  // Archived history retains its bound account and delivery/trust metadata.
  // A duplicate may increment delivery history, but cannot restore or replay it.
  if (stored.archivedAt && stored.connectionId) {
    const account = await tx.channelConnection.findUnique({ where: { id: stored.connectionId }, select: { externalAccountId: true, connectionMetadata: true } })
    return account?.externalAccountId === notice.userId
      && ((account.connectionMetadata as { environment?: string } | null)?.environment ?? 'production') === notice.environment
  }
  try { const first = readEbayNoticeIdentity(stored.payload); return first.userId === notice.userId && first.topic === notice.topic && first.notificationId === notice.externalId }
  catch { return false }
}

/** Owns verification and the byte snapshot; a request body cannot supply its own trust verdict. */
export async function receiveEbayNotice(input: { rawBody: Buffer; header?: string; environment?: EbayEnvironment }): Promise<EbayAdmissionOutcome> {
  if (!Buffer.isBuffer(input.rawBody) || !input.rawBody.length || input.rawBody.length > MAX_BYTES) throw new EbayAdmissionError('invalid_body')
  const environment = input.environment ?? 'production'
  if (environment !== 'production' && environment !== 'sandbox') throw new EbayAdmissionError('invalid_body')
  const rawBody = Buffer.from(input.rawBody)
  const verification = await verifyEbayNotification({ rawBody, header: input.header, environment })
  let payload: unknown
  try { payload = JSON.parse(rawBody.toString('utf8')) } catch { payload = null }
  let identity: EbayNoticeIdentity | null = null
  if (verification.ok) { try { identity = readEbayNoticeIdentity(payload) } catch { /* encrypted quarantine */ } }
  const payloadDigest = digest(rawBody)
  const routeable = !!identity && ROUTED_TOPICS.has(identity.topic) && !!identity.userId
  const notice: Notice = { environment, rawBody, payload, signatureOk: verification.ok, keyId: verification.kid,
    externalId: identity?.notificationId ?? `sha256:${payloadDigest}`, topic: identity?.topic ?? 'unclassified',
    userId: routeable ? identity!.userId : null, subjectHash: routeable ? subjectHash(environment, identity!.userId!) : null, payloadDigest,
    reason: !verification.ok ? verification.reason : !identity ? 'envelope_invalid'
      : identity.topic === 'MARKETPLACE_ACCOUNT_DELETION' ? 'account_deletion_review_required' : !routeable ? 'subject_or_topic_unresolved' : null }
  let cipher: Awaited<ReturnType<typeof seal>> | undefined
  let workspaceId = await legacyIngress(async () => {
    const prior = await prisma.ebayNoticeQuarantine.findUnique({ where: quarantineWhere(notice), select: { resolvedWorkspaceId: true } })
    return prior?.resolvedWorkspaceId ?? (await ownerFor(prisma, notice, false))?.workspaceId ?? LEGACY_WORKSPACE_ID
  })

  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await withIngressWorkspace(workspaceId, () => prisma.$transaction(async tx => {
      await lockDelivery(tx, notice)
      let previouslyBound = false
      if (notice.signatureOk) {
        const original = await tx.$queryRaw<Array<{ workspaceId: string }>>`
          SELECT * FROM nexus_ebay_notice_workspace(${notice.environment}, ${notice.externalId})`
        if (original.length > 1) throw new EbayAdmissionError('identity_conflict')
        if (original[0] && original[0].workspaceId !== workspaceId) return { retryWorkspace: original[0].workspaceId } as const
        previouslyBound = original.length === 1
      }
      const prior = await tx.ebayNoticeQuarantine.findUnique({ where: quarantineWhere(notice) })
      if (prior) {
        if (prior.topic !== notice.topic || prior.subjectHash !== notice.subjectHash) throw new EbayAdmissionError('identity_conflict')
        if (prior.resolvedWorkspaceId && prior.resolvedWorkspaceId !== workspaceId) return { retryWorkspace: prior.resolvedWorkspaceId } as const
        if (prior.resolvedReceiptId) {
          const stored = await tx.webhookEvent.findUnique({ where: { id: prior.resolvedReceiptId } })
          if (!stored?.connectionId || !await sameSubject(tx, stored, notice)) throw new EbayAdmissionError('identity_conflict')
          await writeOwned(tx, notice, stored.connectionId)
        }
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
        await tx.ebayNoticeQuarantine.update({ where: { id: prior.id }, data: { deliveries: { increment: 1 }, lastReceivedAt: clock.now } })
        return { outcome: prior.resolvedReceiptId
          ? { kind: 'accepted', receiptId: prior.resolvedReceiptId, workspaceId, duplicate: true }
          : { kind: notice.signatureOk ? 'quarantined' : 'rejected', quarantineId: prior.id, reason: prior.reason } } as { outcome: EbayAdmissionOutcome }
      }
      // A bound receipt already blocks supported account reassignment. Do not take
      // an ownership lock before waiting on that receipt: transfer locks account first.
      if (notice.signatureOk) {
        const existing = await existingReceipt(tx, notice, workspaceId)
        if (existing) {
          if (!existing.connectionId || !await sameSubject(tx, existing, notice)) throw new EbayAdmissionError('identity_conflict')
          const saved = await writeOwned(tx, notice, existing.connectionId)
          return { outcome: { kind: 'accepted', receiptId: saved.id!, workspaceId, duplicate: true } } as const
        }
        if (previouslyBound) throw new EbayAdmissionError('owner_unavailable')
      }
      const owner = await ownerFor(tx, notice, true)
      if (owner?.status === 'active' && owner.workspaceId !== workspaceId) return { retryWorkspace: owner.workspaceId } as const
      const account = owner?.status === 'active' ? await accountFor(tx, notice, workspaceId) : null
      const signInHeld = !!account && heldForSignIn(notice, account)
      if (account && !signInHeld) {
        const saved = await writeOwned(tx, notice, account.id)
        return { outcome: { kind: 'accepted', receiptId: saved.id!, workspaceId, duplicate: saved.duplicate } } as const
      }
      if (notice.signatureOk && !cipher) return { needCipher: true } as const
      const reason = notice.reason ?? (signInHeld ? 'account_not_connected'
        : owner ? owner.status === 'active' ? 'account_ambiguous_or_missing' : 'workspace_inactive' : 'owner_unknown')
      const row = await tx.ebayNoticeQuarantine.create({ data: { id: randomUUID(), environment, signatureOk: notice.signatureOk,
        externalId: notice.externalId, topic: notice.topic, subjectHash: notice.subjectHash, firstOwnerWorkspaceId: owner?.workspaceId ?? null,
        payloadEnc: cipher?.blob ?? null, payloadKeyId: cipher?.keyId ?? null, payloadDigest, verificationKeyId: notice.keyId, reason }, select: { id: true } })
      return { outcome: { kind: notice.signatureOk ? 'quarantined' : 'rejected', quarantineId: row.id, reason } } as { outcome: EbayAdmissionOutcome }
    }, txOptions))
    // Returning means the notice is durable. Nothing may run between this commit and eBay's
    // 2xx: a deletion notice is reviewed later by the retry worker from its stored first body.
    if ('outcome' in result) return result.outcome
    if ('retryWorkspace' in result) workspaceId = result.retryWorkspace
    if ('needCipher' in result) cipher = await legacyIngress(() => seal(notice, input.header))
  }
  throw new EbayAdmissionError('storage_unavailable')
}

async function ownedQuarantineAccount(connectionId: string) {
  const context = requireWorkspace()
  if (!context.actorUserId) throw new EbayAdmissionError('adoption_forbidden')
  const owner = await prisma.workspaceMembership.findFirst({ where: { workspaceId: context.workspaceId, userId: context.actorUserId,
    status: 'active', user: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } }, select: { id: true } })
  const account = await prisma.channelConnection.findFirst({ where: { id: connectionId, workspaceId: context.workspaceId, channelType: 'EBAY', managedBy: 'oauth' },
    select: { externalAccountId: true, connectionMetadata: true } })
  if (!owner || !account?.externalAccountId) throw new EbayAdmissionError('adoption_forbidden')
  return { context, account }
}

/** Keep disclosure and adoption behind the same fresh owner authority. */
async function lockQuarantineOwner(tx: Tx, context: ReturnType<typeof requireWorkspace>) {
  const active = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Workspace" WHERE id=${context.workspaceId} AND status='active' FOR SHARE`
  await tx.$queryRaw`SELECT id FROM "UserProfile" WHERE id=${context.actorUserId} AND status='active' FOR SHARE`
  const stillOwner = await tx.workspaceMembership.findFirst({ where: { workspaceId: context.workspaceId, userId: context.actorUserId!,
    status: 'active', user: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } }, select: { id: true } })
  if (!active.length || !stillOwner) throw new EbayAdmissionError('adoption_forbidden')
}

/** Matching metadata only. Unknown/unverified/other-business bodies never reach the owner UI. */
export async function listOwnEbayQuarantine(connectionId: string, options: { after?: string; take?: number } = {}) {
  const { context } = await ownedQuarantineAccount(connectionId)
  const take = Number.isSafeInteger(options.take) && options.take! > 0 ? Math.min(options.take!, 50) : 50
  return withIngressWorkspace(context.workspaceId, () => prisma.$transaction(async tx => {
    await lockQuarantineOwner(tx, context)
    const account = await tx.channelConnection.findFirst({ where: { id: connectionId, workspaceId: context.workspaceId, channelType: 'EBAY', managedBy: 'oauth' },
      select: { externalAccountId: true, connectionMetadata: true } })
    const environment = (account?.connectionMetadata as { environment?: string } | null)?.environment ?? 'production'
    if (!account?.externalAccountId || (environment !== 'production' && environment !== 'sandbox')) throw new EbayAdmissionError('adoption_forbidden')
    const owned = await ownerFor(tx, { environment, userId: account.externalAccountId, signatureOk: true, topic: 'AUTHORIZATION_REVOCATION' }, true)
    if (owned?.workspaceId !== context.workspaceId || owned.status !== 'active') throw new EbayAdmissionError('adoption_forbidden')
    const rows = await tx.ebayNoticeQuarantine.findMany({ where: {
      signatureOk: true, topic: 'AUTHORIZATION_REVOCATION', environment,
      subjectHash: subjectHash(environment, account.externalAccountId), resolvedReceiptId: null,
      OR: [{ firstOwnerWorkspaceId: null }, { firstOwnerWorkspaceId: context.workspaceId }],
      ...(options.after ? { id: { gt: options.after } } : {}),
    }, orderBy: { id: 'asc' }, take: take + 1, select: {
      id: true, externalId: true, topic: true, environment: true, receivedAt: true, lastReceivedAt: true, deliveries: true, reason: true,
    } })
    const items = rows.slice(0, take)
    return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null }
  }, { ...txOptions, isolationLevel: 'ReadCommitted' }))
}

/** Explicit owner adoption is the only automatic-first-assignment exception. No plaintext is returned. */
export async function adoptEbayQuarantine(id: string, connectionId: string): Promise<{ receiptId: string; workspaceId: string }> {
  const { context, account } = await ownedQuarantineAccount(connectionId)
  return withIngressWorkspace(context.workspaceId, async () => {
    const snapshot = await prisma.ebayNoticeQuarantine.findUnique({ where: { id } })
    if (!snapshot?.signatureOk || snapshot.topic !== 'AUTHORIZATION_REVOCATION'
      || (snapshot.firstOwnerWorkspaceId && snapshot.firstOwnerWorkspaceId !== context.workspaceId)
      || snapshot.environment !== ((account.connectionMetadata as { environment?: string } | null)?.environment ?? 'production')
      || snapshot.subjectHash !== subjectHash(snapshot.environment as EbayEnvironment, account.externalAccountId!)) throw new EbayAdmissionError('adoption_forbidden')
    const notice = await open(snapshot)
    return prisma.$transaction(async tx => {
      // Membership/role writers and account assignment serialize through Workspace.
      // Recheck authority after crypto, before either receipt or pointer is changed.
      await lockQuarantineOwner(tx, context)
      await lockDelivery(tx, notice)
      const current = await tx.ebayNoticeQuarantine.findUniqueOrThrow({ where: { id } })
      if (current.resolvedReceiptId) {
        if (current.resolvedWorkspaceId !== context.workspaceId) throw new EbayAdmissionError('adoption_forbidden')
        const stored = await existingReceipt(tx, notice, context.workspaceId)
        const target = await tx.channelConnection.findFirst({ where: { id: connectionId, workspaceId: context.workspaceId,
          channelType: 'EBAY', managedBy: 'oauth', externalAccountId: notice.userId }, select: { connectionMetadata: true } })
        const environment = (target?.connectionMetadata as { environment?: string } | null)?.environment ?? 'production'
        if (!stored || stored.id !== current.resolvedReceiptId || stored.connectionId !== connectionId
          || !target || environment !== notice.environment || !await sameSubject(tx, stored, notice)) throw new EbayAdmissionError('identity_conflict')
        return { receiptId: stored.id, workspaceId: context.workspaceId }
      }
      const original = await tx.$queryRaw<Array<{ workspaceId: string }>>`
        SELECT * FROM nexus_ebay_notice_workspace(${notice.environment}, ${notice.externalId})`
      if (original.length > 1 || (original[0] && original[0].workspaceId !== context.workspaceId)) throw new EbayAdmissionError('identity_conflict')
      // A prior business receipt can predate quarantine. Lock it before ownership
      // to match receipt→account dispatch and account→ownership assignment.
      await tx.$queryRaw`SELECT id FROM "WebhookEvent" WHERE "workspaceId"=${context.workspaceId}
        AND channel='EBAY' AND "externalId"=${ebayReceiptExternalId(notice.environment, notice.externalId)} FOR UPDATE`
      const existing = await existingReceipt(tx, notice, context.workspaceId)
      if (existing && (existing.connectionId !== connectionId || !await sameSubject(tx, existing, notice))) throw new EbayAdmissionError('identity_conflict')
      const owned = await ownerFor(tx, notice, true)
      if (owned?.workspaceId !== context.workspaceId || owned.status !== 'active') throw new EbayAdmissionError('owner_unavailable')
      const target = await tx.channelConnection.findFirst({ where: { id: connectionId, workspaceId: context.workspaceId, channelType: 'EBAY', managedBy: 'oauth', externalAccountId: notice.userId },
        select: { id: true, connectionMetadata: true } })
      const environment = (target?.connectionMetadata as { environment?: string } | null)?.environment ?? 'production'
      if (!target || environment !== notice.environment) throw new EbayAdmissionError('adoption_forbidden')
      const saved = await writeOwned(tx, notice, target.id, { receivedAt: current.receivedAt, deliveries: current.deliveries })
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      await tx.ebayNoticeQuarantine.update({ where: { id }, data: { resolvedWorkspaceId: context.workspaceId, resolvedReceiptId: saved.id!, resolvedAt: clock.now } })
      await tx.workspaceAudit.create({ data: { workspaceId: context.workspaceId, actorUserId: context.actorUserId,
        action: 'ebay.notice.adopted', targetId: id, metadata: { receiptId: saved.id, connectionId } } })
      return { receiptId: saved.id!, workspaceId: context.workspaceId }
    }, txOptions)
  })
}
