import { createHash, randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { encryptCredentials, decryptCredentials } from '../../../lib/crypto.js'
import { legacyIngress, withIngressWorkspace } from '../../../lib/workspace-ingress.js'
import { LEGACY_WORKSPACE_ID, requireWorkspace } from '../../../lib/workspace-context.js'
import { recordInboundInTx, type InboundWriteResult } from './ledger.js'
import { readEbayNoticeIdentity, readEbayPublicationTime, type EbayNoticeIdentity } from './ebay-revocation-notice.js'
import { verifyEbayNotification, type EbayEnvironment } from './ebay-signature.js'

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

async function ownerFor(tx: Pick<Tx, '$queryRaw'>, notice: Notice, lock: boolean) {
  if (!notice.signatureOk || notice.topic !== 'AUTHORIZATION_REVOCATION' || !notice.userId) return null
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
  const rows = await tx.$queryRaw<Array<{ id: string; isActive: boolean }>>`
    SELECT id, "isActive" FROM "ChannelConnection" WHERE "workspaceId"=${workspaceId} AND "channelType"='EBAY'
      AND "externalAccountId"=${notice.userId} AND "managedBy"='oauth'
      AND COALESCE("connectionMetadata"->>'environment','production')=${notice.environment}
    ORDER BY "isActive" DESC, id LIMIT 2`
  if (rows.length === 1 || (rows[0]?.isActive && !rows[1]?.isActive)) return rows[0]
  return null
}

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
    if (!row.payloadEnc) throw new Error()
    const saved = await decryptCredentials(row.payloadEnc)
    const expected = { environment: row.environment, signatureOk: row.signatureOk, externalId: row.externalId,
      topic: row.topic, subjectHash: row.subjectHash, payloadDigest: row.payloadDigest }
    const savedBinding = saved.binding as Record<string, unknown> | undefined
    if (saved.version !== 1 || !savedBinding || Object.entries(expected).some(([key, value]) => savedBinding[key] !== value) || typeof saved.rawBody !== 'string') throw new Error()
    const rawBody = Buffer.from(saved.rawBody, 'base64')
    if (!rawBody.length || rawBody.length > MAX_BYTES || digest(rawBody) !== row.payloadDigest) throw new Error()
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
  const routeable = identity?.topic === 'AUTHORIZATION_REVOCATION' && !!identity.userId
  const notice: Notice = { environment, rawBody, payload, signatureOk: verification.ok, keyId: verification.kid,
    externalId: identity?.notificationId ?? `sha256:${payloadDigest}`, topic: identity?.topic ?? 'unclassified',
    userId: routeable ? identity!.userId : null, subjectHash: routeable ? subjectHash(environment, identity!.userId!) : null, payloadDigest,
    reason: !verification.ok ? verification.reason : !identity ? 'envelope_invalid' : !routeable ? 'subject_or_topic_unresolved' : null }
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
      if (account) {
        const saved = await writeOwned(tx, notice, account.id)
        return { outcome: { kind: 'accepted', receiptId: saved.id!, workspaceId, duplicate: saved.duplicate } } as const
      }
      if (notice.signatureOk && !cipher) return { needCipher: true } as const
      const reason = notice.reason ?? (owner ? owner.status === 'active' ? 'account_ambiguous_or_missing' : 'workspace_inactive' : 'owner_unknown')
      const row = await tx.ebayNoticeQuarantine.create({ data: { id: randomUUID(), environment, signatureOk: notice.signatureOk,
        externalId: notice.externalId, topic: notice.topic, subjectHash: notice.subjectHash, firstOwnerWorkspaceId: owner?.workspaceId ?? null,
        payloadEnc: cipher?.blob ?? null, payloadKeyId: cipher?.keyId ?? null, payloadDigest, verificationKeyId: notice.keyId, reason }, select: { id: true } })
      return { outcome: { kind: notice.signatureOk ? 'quarantined' : 'rejected', quarantineId: row.id, reason } } as { outcome: EbayAdmissionOutcome }
    }, txOptions))
    if ('outcome' in result) return result.outcome
    if ('retryWorkspace' in result) workspaceId = result.retryWorkspace
    if ('needCipher' in result) cipher = await legacyIngress(() => seal(notice, input.header))
  }
  throw new EbayAdmissionError('storage_unavailable')
}

/** Explicit owner adoption is the only automatic-first-assignment exception. No plaintext is returned. */
export async function adoptEbayQuarantine(id: string, connectionId: string): Promise<{ receiptId: string; workspaceId: string }> {
  const context = requireWorkspace()
  if (!context.actorUserId) throw new EbayAdmissionError('adoption_forbidden')
  const owner = await prisma.workspaceMembership.findFirst({ where: { workspaceId: context.workspaceId, userId: context.actorUserId,
    status: 'active', user: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } }, select: { id: true } })
  const account = await prisma.channelConnection.findFirst({ where: { id: connectionId, workspaceId: context.workspaceId, channelType: 'EBAY', managedBy: 'oauth' },
    select: { externalAccountId: true, connectionMetadata: true } })
  if (!owner || !account?.externalAccountId) throw new EbayAdmissionError('adoption_forbidden')
  return withIngressWorkspace(context.workspaceId, async () => {
    const snapshot = await prisma.ebayNoticeQuarantine.findUnique({ where: { id } })
    if (!snapshot?.signatureOk || snapshot.topic !== 'AUTHORIZATION_REVOCATION'
      || (snapshot.firstOwnerWorkspaceId && snapshot.firstOwnerWorkspaceId !== context.workspaceId)
      || snapshot.environment !== ((account.connectionMetadata as { environment?: string } | null)?.environment ?? 'production')
      || snapshot.subjectHash !== subjectHash(snapshot.environment as EbayEnvironment, account.externalAccountId!)) throw new EbayAdmissionError('adoption_forbidden')
    if (snapshot.resolvedReceiptId && snapshot.resolvedWorkspaceId === context.workspaceId) return { receiptId: snapshot.resolvedReceiptId, workspaceId: context.workspaceId }
    const notice = await open(snapshot)
    return prisma.$transaction(async tx => {
      // Membership/role writers and account assignment serialize through Workspace.
      // Recheck authority after crypto, before either receipt or pointer is changed.
      const active = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Workspace" WHERE id=${context.workspaceId} AND status='active' FOR SHARE`
      await tx.$queryRaw`SELECT id FROM "UserProfile" WHERE id=${context.actorUserId} AND status='active' FOR SHARE`
      const stillOwner = await tx.workspaceMembership.findFirst({ where: { workspaceId: context.workspaceId, userId: context.actorUserId,
        status: 'active', user: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } }, select: { id: true } })
      if (!active.length || !stillOwner) throw new EbayAdmissionError('adoption_forbidden')
      await lockDelivery(tx, notice)
      const current = await tx.ebayNoticeQuarantine.findUniqueOrThrow({ where: { id } })
      if (current.resolvedReceiptId) {
        if (current.resolvedWorkspaceId !== context.workspaceId) throw new EbayAdmissionError('adoption_forbidden')
        return { receiptId: current.resolvedReceiptId, workspaceId: context.workspaceId }
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
