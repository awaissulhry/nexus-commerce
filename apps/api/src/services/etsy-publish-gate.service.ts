/**
 * P4.6a — the Etsy publish gate.
 *
 * Until this file, `publishModeOf('ETSY')` in services/gateway/channels.ts returned the literal
 * `'live'`, with a comment explaining why that was safe: the connected-account client was read-only
 * and the only Etsy writer needed its own env credentials. Both halves of that reasoning are about
 * to stop being true — P4.6 puts listing, stock, price and image writes on the connected account —
 * and a hard-coded `'live'` means the first Etsy writer ships the moment it compiles, with no
 * dry-run to rehearse it in and no switch to turn it off.
 *
 * So Etsy gets what the other three channels have: a master flag (default OFF) and a mode
 * (default dry-run). Mirrors shopify-publish-gate.service.ts, which is the right model here —
 * eBay's and Amazon's gates also carry a sandbox mode, and **Etsy has no sandbox**. Etsy's Open API
 * v3 is one host, api.etsy.com, and SANDBOX_HOSTS.ETSY is `[]`, so a call in sandbox mode has
 * nowhere to go. The mode is therefore three-valued, and a literal `ETSY_PUBLISH_MODE=sandbox`
 * falls to dry-run rather than pretending a sandbox exists.
 *
 * No rate limiter or circuit breaker here. The other three gates predate the P1.1 gateway and carry
 * their own copies; Etsy is born on the gateway, which already owns the rate bucket
 * (services/gateway/rate.ts, keyed per account and operation group) and reads Etsy's own daily
 * quota headers (x-remaining-today / x-limit-per-day) into the call ledger. A second bucket here
 * would be a second opinion about the same quota.
 */

export type EtsyPublishMode = 'gated' | 'dry-run' | 'live'

/** The master switch. Default OFF — an Etsy write needs a deliberate deploy variable. */
export function isEtsyPublishEnabled(): boolean {
  const raw = process.env.NEXUS_ENABLE_ETSY_PUBLISH
  return raw === 'true' || raw === '1' || raw === 'yes'
}

/**
 * The mode that governs every Etsy WRITE. The master flag wins: while it is off the mode is
 * `gated` whatever ETSY_PUBLISH_MODE says, so a caller has one boolean to reason about.
 */
export function getEtsyPublishMode(): EtsyPublishMode {
  if (!isEtsyPublishEnabled()) return 'gated'
  const raw = (process.env.ETSY_PUBLISH_MODE ?? 'dry-run').toLowerCase()
  if (raw === 'live' || raw === 'production') return 'live'
  // Anything else — 'dry-run', 'sandbox' (Etsy has none), empty, a typo — is dry-run. Default-safe.
  return 'dry-run'
}

export class EtsyWriteRefusedError extends Error {
  readonly code = 'ETSY_WRITE_REFUSED'
  constructor(message: string) {
    super(message)
    this.name = 'EtsyWriteRefusedError'
  }
}

/** The sentence to show when an Etsy write must not be sent, or null when it may. */
export function etsyWriteRefusal(): string | null {
  const mode = getEtsyPublishMode()
  if (mode === 'live') return null
  if (mode === 'gated') return 'Etsy publishing is turned off. Nothing was sent to Etsy.'
  return 'Etsy publishing is in dry-run mode. Nothing was sent to Etsy.'
}

/** Throws EtsyWriteRefusedError when the write must not be sent. */
export function assertEtsyWriteAllowed(): void {
  const refusal = etsyWriteRefusal()
  if (refusal) throw new EtsyWriteRefusedError(refusal)
}
