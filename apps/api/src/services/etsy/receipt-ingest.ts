/**
 * CX Etsy E3–E6 — what the webhook and the poller share around the writer: whether ingest is on,
 * when it started for an account (T0), which shop and seller a receipt must belong to, refusals
 * that must never be only a log line, and how fresh an account's orders are.
 *
 * 🔴 Everything here is OFF unless `NEXUS_ENABLE_ETSY_ORDER_INGEST=1`. With it off, the webhook
 * behaves exactly as before (read back, log) and the poller does nothing.
 */
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { normalizeEtsyReceipt, type EtsyReceiptBinding, type EtsyReceiptRefusal } from './receipt-normalizer.js'
import { writeEtsyReceipt, type EtsyReceiptWrite, type EtsyWriteOutcome } from './order-writer.js'

export const ETSY_ORDER_INGEST_FLAG = 'NEXUS_ENABLE_ETSY_ORDER_INGEST'
export const etsyOrderIngestEnabled = (): boolean => process.env[ETSY_ORDER_INGEST_FLAG] === '1'

/** An account that must be signed in again is not retried on the normal budget (C5's rule). */
export const ETSY_AUTH_HOLD_MS = 30 * 60 * 1000

/** A refusal with a stable code, for the ledger row's error and the owner. */
export class EtsyIngestRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'EtsyIngestRefused'
  }
}

/**
 * T0 for an account: written ONCE by an explicit activation action, before enabling processing.
 * Owner ruling H1 — receipts created before it are never ingested. Idempotent under races: the
 * unique key keeps the first writer's time. Effective H1 precision is Etsy's whole second;
 * receipts in the same second are included because subsecond ordering is unknowable.
 */
export async function activateEtsyIngest(connectionId: string): Promise<Date> {
  await prisma.etsyReceiptIngest.createMany({ data: [{ connectionId }], skipDuplicates: true })
  const row = await prisma.etsyReceiptIngest.findUnique({ where: { workspace_connectionId: workspaceKey({ connectionId }) }, select: { activatedAt: true } })
  if (!row) throw new Error('Etsy order ingest could not record its activation for this account.')
  return row.activatedAt
}

/** Processing never establishes T0: a missing activation keeps the delivery retryable. */
export async function requireEtsyIngestActivation(connectionId: string): Promise<Date> {
  const row = await prisma.etsyReceiptIngest.findUnique({ where: { workspace_connectionId: workspaceKey({ connectionId }) }, select: { activatedAt: true } })
  if (!row) throw new EtsyIngestRefused('not_activated', 'Explicit Etsy activation is required before processing this account.')
  return row.activatedAt
}

/**
 * The shop and the seller a receipt must belong to, from the connection — never from the receipt
 * or the event. For Etsy `externalAccountId` is the seller's USER id; the shop is the verified
 * identity (for example user 900000001, shop 10000001).
 */
export async function etsyIngestBinding(connectionId: string): Promise<Pick<EtsyReceiptBinding, 'shopId' | 'sellerUserId'>> {
  const { resolveConnection } = await import('../connection-resolver.service.js')
  const connection = await resolveConnection({ accountId: connectionId })
  if (connection.channelType !== 'ETSY') throw new EtsyIngestRefused('not_etsy', 'The account is not an Etsy account.')
  const identity = connection.identity as { extra?: { shopId?: unknown } } | null
  return { shopId: String(identity?.extra?.shopId ?? ''), sellerUserId: String(connection.externalAccountId ?? '') }
}

/** A refused receipt, kept. One row per (account, receipt, version, reason); repeats fold into it. */
export async function recordEtsyRefusal(args: {
  connectionId: string; receiptId: string; receiptVersion: string; source: EtsyReceiptWrite['source']; refusal: Pick<EtsyReceiptRefusal, 'code' | 'message'> & { path?: string | null }
}): Promise<void> {
  try {
    await prisma.etsyReceiptRefusal.createMany({
      skipDuplicates: true,
      data: [{
        connectionId: args.connectionId, receiptId: args.receiptId, receiptVersion: args.receiptVersion, source: args.source,
        code: args.refusal.code, message: args.refusal.message.slice(0, 500), path: args.refusal.path ?? null,
      }],
    })
  } catch (error) {
    // A poll may advance only after the refusal is durable.
    logger.error('[etsy-orders] could not record a refused receipt', { connectionId: args.connectionId, receiptId: args.receiptId, code: args.refusal.code, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

/** Etsy's identifiers of a raw receipt, read defensively, for refusal records and the poll cursor. */
export function receiptIdentity(raw: unknown): { receiptId: string; updatedAt: number | null } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const id = typeof r.receipt_id === 'number' && Number.isSafeInteger(r.receipt_id) && r.receipt_id > 0 ? String(r.receipt_id) : 'unknown'
  const updated = [r.updated_timestamp, r.update_timestamp].find((v) => typeof v === 'number' && Number.isSafeInteger(v) && (v as number) > 0) as number | undefined
  return { receiptId: id, updatedAt: updated ?? null }
}

export type EtsyIngestOutcome = EtsyWriteOutcome | { kind: 'receipt_refused'; refusal: EtsyReceiptRefusal }

/** Normalise (outside any transaction), record a refusal durably, or write. */
export async function ingestEtsyReceipt(args: {
  connectionId: string
  raw: unknown
  binding: Pick<EtsyReceiptBinding, 'shopId' | 'sellerUserId'>
  source: EtsyReceiptWrite['source']
  deliveredEvent?: boolean
  expectedReceiptId?: string | null
  claimedShopId?: string | null
}): Promise<EtsyIngestOutcome> {
  const normalized = normalizeEtsyReceipt(args.raw, {
    ...args.binding, expectedReceiptId: args.expectedReceiptId ?? null, claimedShopId: args.claimedShopId ?? null,
  })
  if (!normalized.ok) {
    const refusal = (normalized as Extract<typeof normalized, { ok: false }>).refusal
    const identity = receiptIdentity(args.raw)
    await recordEtsyRefusal({ connectionId: args.connectionId, receiptId: args.expectedReceiptId ?? identity.receiptId, receiptVersion: identity.updatedAt === null ? 'unknown' : String(identity.updatedAt), source: args.source, refusal })
    return { kind: 'receipt_refused', refusal }
  }
  const receipt = (normalized as Extract<typeof normalized, { ok: true }>).receipt
  return writeEtsyReceipt({ connectionId: args.connectionId, receipt, source: args.source, deliveredEvent: args.deliveredEvent })
}

// ── E6 — freshness ────────────────────────────────────────────────────────────────────────────

/**
 * The account's last VERIFIED delivery, by the database clock. Recorded as what it is — a delivery
 * arrived — and never counted as freshness (only a successful poll is). Never throws.
 */
export async function stampEtsyInbound(connectionId: string): Promise<void> {
  try {
    await prisma.$executeRaw`UPDATE "ChannelConnection" SET "lastInboundAt" = clock_timestamp() WHERE id = ${connectionId}`
  } catch (error) {
    logger.warn('[etsy-orders] could not stamp lastInboundAt', { connectionId, error: error instanceof Error ? error.message : String(error) })
  }
}

export interface EtsyReceiptFreshness {
  status: 'not_activated' | 'never' | 'fresh' | 'stale'
  reasons: string[]
}

/**
 * How current an account's Etsy orders are. ONLY a successful poll proves it: a webhook proves
 * that one receipt arrived, never that none were missed (Etsy's portal showed zero endpoints once,
 * and a webhook that stops says nothing). Stale when no poll succeeded within two schedule
 * periods, or when the last one stopped with receipts still waiting (backlog). Pure.
 */
export function etsyReceiptFreshness(
  state: { activatedAt: Date; lastPollSucceededAt: Date | null; backlog: boolean } | null,
  now: Date,
  scheduleMs: number,
): EtsyReceiptFreshness {
  if (!state) return { status: 'not_activated', reasons: [] }
  const reasons: string[] = []
  if (!state.lastPollSucceededAt) reasons.push('no poll has succeeded since ingest started')
  else if (now.getTime() - state.lastPollSucceededAt.getTime() > 2 * scheduleMs) reasons.push(`the last successful poll is older than ${Math.round((2 * scheduleMs) / 60_000)} minutes`)
  else if (state.lastPollSucceededAt.getTime() > now.getTime()) reasons.push('the last successful poll is in the future (a clock error)')
  if (state.backlog) reasons.push('the last poll stopped with receipts still waiting')
  if (reasons.length === 0) return { status: 'fresh', reasons }
  return { status: state.lastPollSucceededAt ? 'stale' : 'never', reasons }
}
