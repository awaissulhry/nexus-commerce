/**
 * P4.1d — one reconciliation of eBay business policies, for both builders.
 *
 * ## What was measured (2026-09-20)
 *
 * eBay business policies belong to ONE marketplace. A policy id from another
 * market — a DE default applied to an IT offer — is the classic eBay **25007**
 * "invalid shipping policy", and it often surfaces as a mixed IT/DE error that
 * reads like anything but a policy problem.
 *
 * Both eBay publishers already knew that, and both ran the same three-tier
 * waterfall (row override → account default → this market's first policy) and
 * the same "REPLACE any id not in this market's list, not just the missing
 * ones" rule. **They disagreed about the one case that matters: what to do when
 * the account snapshot cannot be fetched.**
 *
 *   `ebay-variation-push.service.ts` (the group publisher) — **REFUSES.** Its
 *   comment records why (FFP.12): *"NEVER proceed with UNVERIFIED policy ids.
 *   The old fallback ('keep whatever ids we have') is exactly how another
 *   market's policy got written onto DE offers — creating unpublishable drafts
 *   that then failed EVERY publish of the family with a mixed-locale 25007."*
 *
 *   `routes/ebay-flat-file.routes.ts` (the single-SKU publisher) — **WARNS and
 *   CONTINUES**, pushing a sentence into `axisWarnings` and then writing the
 *   unverified ids anyway. Its own comment shows it stopped one step earlier:
 *   *"Audit R12 — silent skip left cross-market policy IDs unvalidated and eBay
 *   later failed with an opaque 25007. Warn once per push."*
 *
 * R12 made it warn. FFP.12 made the other one refuse. **The single-SKU path was
 * left with the behaviour FFP.12 exists to prevent** — it can still write a
 * wrong-market policy id onto an offer whenever eBay's account API is briefly
 * unavailable.
 *
 * That is the banked "two column builders DRIFT" lesson in its exact shape: a
 * rule learned in one builder and never carried to the other, silent, and only
 * visible by reading both. The fix the lesson prescribes is this file — **one
 * accessor, called by both sides** — not a third copy of the rule.
 *
 * ## The rule, stated once
 *
 * 1. **The waterfall**: the row's own column wins, then the account's stored
 *    default, then this market's first policy.
 * 2. **REPLACE, don't top up.** An id that is not in THIS market's list is
 *    wrong, not merely unconfirmed — a DE id on an IT offer is a 25007 whether
 *    or not an IT id was also configured.
 * 3. **An unverifiable snapshot is a REFUSAL, never a warning.** Retrying in a
 *    minute is cheap. An unpublishable draft carrying another market's policy is
 *    not: it fails every subsequent publish of the family, with an error that
 *    names the wrong thing.
 */

import { ebayAccountService } from './ebay-account.service.js'

export interface EbayPolicyIds {
  fulfillmentPolicyId: string
  paymentPolicyId: string
  returnPolicyId: string
  merchantLocationKey: string
}

/**
 * The outcome. Deliberately NOT a discriminated union on an `ok` flag.
 *
 * 🔴 `apps/api/tsconfig.json` sets `"strict": false`, and without
 * `strictNullChecks` TypeScript does **not** narrow a discriminated union: after
 * `if (!resolution.ok)`, `resolution.message` is still an error because the
 * `{ ok: true }` member is never eliminated. The union compiles and gives no
 * safety at all here. Two nullable fields say the same thing and actually work.
 */
export interface EbayPolicyResolution {
  /** The ids to send. `null` exactly when the reconciliation refused. */
  policies: EbayPolicyIds | null
  /** The operator's sentence when it refused; `null` otherwise. */
  message: string | null
}

/** The flat-file column names, as they appear on a row. */
export interface EbayPolicyRowOverrides {
  fulfillment_policy_id?: unknown
  payment_policy_id?: unknown
  return_policy_id?: unknown
  merchant_location_key?: unknown
}

/** `ChannelConnection.connectionMetadata.ebayPolicies`. */
export interface EbayPolicyAccountDefaults {
  fulfillmentPolicyId?: string
  paymentPolicyId?: string
  returnPolicyId?: string
  merchantLocationKey?: string
}

const str = (value: unknown): string => (typeof value === 'string' && value.trim() ? value : '')

/**
 * The policy ids this offer should carry in this market, or a refusal.
 *
 * `getSnapshot` is cached for five minutes per account and market, so calling
 * this once per push costs one request at most.
 */
export async function reconcileEbayPolicies(input: {
  /** The eBay account this push goes out on. */
  connectionId: string
  /** The SP marketplace id (`EBAY_IT`), which is what the snapshot is keyed on. */
  marketplaceId: string
  /** The 2-letter market, for the operator's sentence. */
  market: string
  /** Tier 1 — the row's own flat-file columns. */
  rowOverrides?: EbayPolicyRowOverrides
  /** Tier 2 — the account's stored defaults. */
  accountDefaults?: EbayPolicyAccountDefaults
}): Promise<EbayPolicyResolution> {
  const row = input.rowOverrides ?? {}
  const account = input.accountDefaults ?? {}

  let fulfillmentPolicyId = str(row.fulfillment_policy_id) || str(account.fulfillmentPolicyId)
  let paymentPolicyId = str(row.payment_policy_id) || str(account.paymentPolicyId)
  let returnPolicyId = str(row.return_policy_id) || str(account.returnPolicyId)
  let merchantLocationKey = str(row.merchant_location_key) || str(account.merchantLocationKey)

  try {
    const snapshot = await ebayAccountService.getSnapshot(input.connectionId, input.marketplaceId)
    const fSet = new Set(snapshot.fulfillmentPolicies.map((p) => p.id))
    const pSet = new Set(snapshot.paymentPolicies.map((p) => p.id))
    const rSet = new Set(snapshot.returnPolicies.map((p) => p.id))
    // REPLACE, not top up: an id absent from this market's list is WRONG.
    if (!fulfillmentPolicyId || !fSet.has(fulfillmentPolicyId)) fulfillmentPolicyId = snapshot.fulfillmentPolicies[0]?.id ?? ''
    if (!paymentPolicyId || !pSet.has(paymentPolicyId)) paymentPolicyId = snapshot.paymentPolicies[0]?.id ?? ''
    if (!returnPolicyId || !rSet.has(returnPolicyId)) returnPolicyId = snapshot.returnPolicies[0]?.id ?? ''
    if (!merchantLocationKey) merchantLocationKey = snapshot.locations[0]?.key ?? ''
  } catch (err) {
    // FFP.12 — never proceed with unverified policy ids. This used to be a
    // refusal in the group publisher and a warning in the single-SKU one; it is
    // a refusal for both now, because the warning is the behaviour that caused
    // the incident FFP.12 was written for.
    return {
      policies: null,
      message:
        `Couldn't verify ${input.market} business policies (${err instanceof Error ? err.message : String(err)}) — ` +
        `refusing to write unverified policy ids onto ${input.market} offers ` +
        `(a wrong-market policy is the classic persistent 25007). Retry in a minute.`,
    }
  }

  return { policies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId, merchantLocationKey }, message: null }
}
