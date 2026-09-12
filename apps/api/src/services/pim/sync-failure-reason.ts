/**
 * PES.5 — why a sync row failed, in a form an operator can act on.
 *
 * ── `errorCode` cannot answer this, measured ────────────────────────────────
 * Ruling #142 approved "a derived reason from errorCode". It does not work:
 * **2,490 of the failed rows carry the SAME code, `MAX_RETRIES_EXCEEDED`** —
 * both the writes Amazon genuinely refused and the writes never attempted
 * because publishing is switched off. The code records how it ended (retries
 * ran out), not why it could not succeed.
 *
 * The distinguishing signal is in `errorMessage`. Measured 2026-09-01:
 *
 *   NEXUS_ENABLE_AMAZON_PUBLISH=false …        356
 *   NEXUS_ENABLE_EBAY_PUBLISH=false …           12   } 368 = PES.3's count
 *   eBay publish circuit open after 3 …         ~20
 *   EBAY_VALIDATION / EBAY_LISTING_ENDED        ~40
 *   EBAY_REVISE_DEBOUNCED                        22
 *
 * ── Why it matters ─────────────────────────────────────────────────────────
 * Those 368 sit in `dead` beside genuine rejections. "Refused because
 * publishing is switched off" and "Amazon rejected this listing" demand
 * opposite responses from an operator, and a console that shows them as one
 * misreports the health of the channel.
 */

export type SyncFailureReason =
  /** Publishing is deliberately disabled by a flag. Not a failure. */
  | 'gated'
  /** Deferred by our own throttle or circuit breaker; it will retry itself. */
  | 'throttled'
  /** The marketplace refused it. This is the one that needs an operator. */
  | 'rejected'
  /** We aborted it ourselves (stale intent, crash mid-dispatch). */
  | 'internal'
  /** Genuinely unclassified — NOT a synonym for "rejected". */
  | 'unknown'

export interface FailureReason {
  reason: SyncFailureReason
  /** One line an operator can read without opening the raw message. */
  summary: string
  /**
   * True when a human needs to do something.
   *
   * ⚠ This depends on whether the row can still PROGRESS, not on the cause
   * alone. A throttled row that is still runnable will retry itself and needs
   * nobody; a throttled row that is DEAD exhausted its retries while being
   * throttled and will never run again — the write silently never landed.
   *
   * Measured 2026-09-01: ALL 399 throttled rows are `isDead: true`, `3/3`
   * retries, `nextRetryAt: null`. Grading those "it will retry without you"
   * told an operator that 399 writes which never happened were fine — the exact
   * failure class this classifier exists to remove, one level down.
   */
  actionable: boolean
  /** False when the row can no longer progress on its own. */
  willRetry: boolean
}

/**
 * Ordered because the categories overlap: a circuit-breaker message also
 * mentions "publish", and a gated row also ends as MAX_RETRIES_EXCEEDED. First
 * match wins, most specific first.
 */
const RULES: Array<{ reason: SyncFailureReason; test: RegExp; summary: string; actionable: boolean }> = [
  {
    reason: 'gated',
    // The flag names itself in the message — the most reliable signal we have.
    test: /NEXUS_ENABLE_\w*PUBLISH\s*=\s*false/i,
    summary: 'Not sent — outbound publishing is switched off for this channel',
    actionable: false,
  },
  {
    reason: 'throttled',
    test: /circuit open|debounced|rate.?limit|too many requests|min interval/i,
    summary: 'Deferred by our own throttle or circuit breaker — it will retry without you',
    actionable: false,
  },
  {
    reason: 'internal',
    // "refusing content PUT built from an empty read" is OUR safety guard, not
    // the channel's answer — 5 rows were being reported as marketplace
    // rejections when the marketplace was never asked. Must precede `rejected`,
    // whose HTTP-code pattern would otherwise claim them.
    test: /stale|crashed mid-dispatch|not re-applied|cancelled by|refusing .* (?:PUT|POST|write)|would (?:wipe|clear|blank)/i,
    summary: 'Abandoned on our side before it reached the channel',
    actionable: false,
  },
  {
    reason: 'rejected',
    // Anything the channel itself answered. Deliberately last of the positive
    // rules, so a gated or throttled row never lands here by accident.
    // `Failure:` catches the channel's own error envelopes that carry no HTTP
    // code and no English keyword — e.g. "ReviseInventoryStatus Failure: SKU non
    // esiste nell'inserzione", a genuine eBay refusal that was landing in
    // `unknown` purely for being Italian.
    test: /\b\d{3}\b|Failure:|validation|rejected|invalid|expired|scaduta|non esiste|ended|not allowed|forbidden|denied/i,
    summary: 'The marketplace refused this write',
    actionable: true,
  },
]

/**
 * `errorCode` is accepted and deliberately UNUSED for classification — it is
 * kept in the signature so a future code that IS discriminating can be wired in
 * without changing every caller, and so this decision is visible rather than
 * looking like an oversight.
 */
export function deriveFailureReason(
  errorCode: string | null,
  errorMessage: string | null,
  opts: { isDead?: boolean } = {},
): FailureReason {
  const msg = errorMessage ?? ''
  // A dead row has exhausted its retries: whatever the cause, it will not run
  // again and the write did not reach the channel.
  const dead = opts.isDead === true
  const willRetry = !dead

  const base = RULES.find((r) => r.test.test(msg))

  if (!base) {
    return {
      reason: 'unknown',
      // Says what it does not know. Defaulting to 'rejected' would invent a
      // marketplace refusal that may never have happened.
      summary: errorMessage ? 'Failed for a reason this console does not recognise yet' : 'Failed with no recorded reason',
      actionable: true,
      willRetry,
    }
  }

  // ── The dead override ────────────────────────────────────────────────────
  if (dead) {
    if (base.reason === 'throttled') {
      return {
        reason: 'throttled',
        summary: 'Gave up while throttled — this write never reached the channel and will not retry',
        actionable: true,
        willRetry: false,
      }
    }
    if (base.reason === 'internal') {
      return {
        reason: 'internal',
        summary: 'Abandoned on our side and out of retries — this write never reached the channel',
        actionable: true,
        willRetry: false,
      }
    }
    if (base.reason === 'gated') {
      // Still not actionable — nothing is broken — but the row will not send
      // itself if the flag is turned on later, and saying so is the difference
      // between "paused" and "lost".
      return {
        reason: 'gated',
        summary: 'Not sent — outbound publishing is switched off. Out of retries, so enabling the flag will not resend this row',
        actionable: false,
        willRetry: false,
      }
    }
  }

  return { reason: base.reason, summary: base.summary, actionable: base.actionable, willRetry }
}
