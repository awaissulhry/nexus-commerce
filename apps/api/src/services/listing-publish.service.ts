/**
 * A1.3 — the single gated publish chokepoint.
 *
 * Lifts the gate → seller-resolve → circuit → rate-limit → dry-run → execute →
 * audit chain that was duplicated inline in OutboundSyncService.syncTo{Amazon,
 * Ebay,Shopify} into one reusable service. Channel specifics — the gate
 * functions, seller/connection resolution, and the actual marketplace call — are
 * dependency-injected, so every surface that publishes can route the SAME chain
 * (gating, throttle, circuit breaker, audit) identically. Behavior-preserving
 * extraction; the queue's syncToAmazon delegates here first, eBay/Shopify follow
 * as they're touched in Track B.
 */

import { writeAttemptLog } from './channel-publish-audit.service.js'

export type PublishMode = 'gated' | 'dry-run' | 'sandbox' | 'live'
export type PublishOutcome = 'gated' | 'rate-limited' | 'circuit-open' | 'failed' | 'timeout'

/** Per-channel gate primitives (amazon-/ebay-/shopify-publish-gate.service). */
export interface PublishGate {
  getMode: () => PublishMode
  checkCircuit: (sellerId: string, marketplaceId: string) => { ok: boolean; error?: string }
  acquireToken: (sellerId: string, marketplaceId: string) => Promise<{ ok: boolean; error?: string }>
  recordOutcome: (sellerId: string, marketplaceId: string, success: boolean) => void
}

export interface PublishResult {
  success: boolean
  channel: string
  status: 'SUCCESS' | 'FAILED'
  message: string
  error?: string
  mode: PublishMode
  outcome?: PublishOutcome
}

export interface PublishArgs {
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'
  marketplaceId: string
  sku: string
  productId?: string | null
  /** Stable digest of the payload, for the audit log. */
  digest: string
  gate: PublishGate
  /**
   * Resolve the seller/connection id used for circuit/rate-limit keying + audit.
   * Called AFTER the gate so a gated attempt performs no side-effecting lookup
   * (matches the eBay "post-gate connection lookup" rule).
   */
  resolveSeller: () => Promise<{ id: string } | { error: string }>
  /** The live marketplace call. Only invoked in live/sandbox mode. */
  execute: (ctx: { sellerId: string; mode: PublishMode }) => Promise<{ ok: boolean; error?: string }>
}

export class ListingPublishService {
  async publish(args: PublishArgs): Promise<PublishResult> {
    const { channel, marketplaceId, sku, productId = null, digest, gate, resolveSeller, execute } = args

    const audit = (
      sellerId: string,
      mode: PublishMode,
      outcome: 'success' | PublishOutcome,
      message: string | null,
      durationMs: number | null,
    ): void => {
      writeAttemptLog({
        channel,
        marketplace: marketplaceId,
        sellerId: sellerId || '(unset)',
        sku,
        productId,
        mode,
        outcome,
        payloadDigest: digest,
        errorMessage: message,
        durationMs,
      })
    }

    const fail = (
      outcome: PublishOutcome,
      mode: PublishMode,
      sellerId: string,
      message: string,
      durationMs: number | null = null,
    ): PublishResult => {
      audit(sellerId, mode, outcome, message, durationMs)
      return { success: false, channel, status: 'FAILED', message: `Failed to sync to ${channel}`, error: message, mode, outcome }
    }

    // 1. Gate (master flag + mode).
    const mode = gate.getMode()
    if (mode === 'gated') {
      return fail('gated', 'gated', '(unset)', `${channel} publishing is disabled (gated).`)
    }

    // 2. Seller/connection resolution — post-gate, so a gated attempt is side-effect-free.
    const sr = await resolveSeller()
    if ('error' in sr) return fail('failed', mode, '(unset)', sr.error)
    const sellerId = sr.id

    // 3. Circuit breaker.
    const circuit = gate.checkCircuit(sellerId, marketplaceId)
    if (!circuit.ok) return fail('circuit-open', mode, sellerId, circuit.error ?? 'Circuit open')

    // 4. Rate limiter.
    const t0 = Date.now()
    const acquired = await gate.acquireToken(sellerId, marketplaceId)
    if (!acquired.ok) return fail('rate-limited', mode, sellerId, acquired.error ?? 'Rate limited', Date.now() - t0)

    // 5. Dry-run short-circuit — record + audit a synthetic success; no HTTP.
    if (mode === 'dry-run') {
      gate.recordOutcome(sellerId, marketplaceId, true)
      audit(sellerId, 'dry-run', 'success', null, Date.now() - t0)
      return { success: true, channel, status: 'SUCCESS', message: `Product ${sku} dry-run synced to ${channel}`, mode }
    }

    // 6. Live call.
    let r: { ok: boolean; error?: string }
    try {
      r = await execute({ sellerId, mode })
    } catch (err) {
      gate.recordOutcome(sellerId, marketplaceId, false)
      return fail('timeout', mode, sellerId, err instanceof Error ? err.message : String(err), Date.now() - t0)
    }

    gate.recordOutcome(sellerId, marketplaceId, r.ok)
    audit(sellerId, mode, r.ok ? 'success' : 'failed', r.error ?? null, Date.now() - t0)
    if (!r.ok) {
      return { success: false, channel, status: 'FAILED', message: `Failed to sync to ${channel}`, error: r.error ?? 'Unknown error', mode, outcome: 'failed' }
    }
    return { success: true, channel, status: 'SUCCESS', message: `Product ${sku} synced to ${channel}`, mode }
  }
}

export const listingPublishService = new ListingPublishService()
