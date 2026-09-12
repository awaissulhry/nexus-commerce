/**
 * PES.7 — what the operator is allowed to do, and what they must be told, before an Amazon publish.
 *
 * This is the only surface in the tab that reaches a real marketplace, so the gating is pure and
 * tested rather than assembled inside a component.
 *
 * Three rules, all of them from the programme's own law rather than invented here:
 *
 * 1. **Preflight first.** `GET /amazon-images/validate` runs BEFORE publish is offered. Hard fails
 *    (MAIN_MISSING, IMAGE_TOO_SMALL, URL_INVALID) block the ASINs they name; the publisher already
 *    skips those, so a partial publish is legitimate and must be described as partial.
 * 2. **Dry run is the default.** A live submission is an explicit, separate choice.
 * 3. 🔴 **The mode comes from the SERVER** — `GET /listings/publish-readiness`, which reports
 *    `getAmazonPublishMode()`. It is never re-derived from an env var in the browser, and it is
 *    never assumed to be live. When the server says the gate is closed, the button must say the
 *    submission will not reach Amazon rather than implying it will.
 *
 * And the wording rule: Amazon publishing is a FEED submission and is asynchronous. Nothing here
 * ever says "published" — the honest verb is "queued", and whether Amazon accepted it is a later
 * question the feed-status poll answers.
 */

/**
 * Re-exported from the frame's shared vocabulary, not redeclared.
 *
 * This lane's own copy was open but three-membered and had no `'sandbox'`. It was never unsafe —
 * only `'live'` submits, so a sandbox mode fell into the open arm and was handled as a rehearsal —
 * but two spellings of one server concept is one too many, and the other copy (channel-ops) was
 * closed, which is the failure in the opposite direction.
 */
import type { PublishMode } from '../../../types'

export type { PublishMode }

/**
 * The `/listings/publish-readiness` response: **one gate per channel**, not a gate.
 *
 * 🔴 Declared here, once. `usePublishGate` had a private `RawReadiness` and the cross-channel
 * planner typed the whole envelope as a single `PublishReadiness` and then reached the per-channel
 * gates through `as unknown as Record<string, …>` — a cast that made a wrong type compile. Two
 * declarations of one wire shape, and only one of them true.
 *
 * Every member is optional because a channel absent from the payload is a real answer — it means
 * the server did not report on it, which is not the same as reporting it closed.
 */
export interface PublishReadinessByChannel {
  amazon?: PublishReadiness
  ebay?: PublishReadiness
  shopify?: PublishReadiness
}

export interface PublishReadiness {
  enabled: boolean
  mode: PublishMode
  sellerIdPresent?: boolean
  lwaCredsPresent?: boolean
  liveReady?: boolean
}

export interface ValidationIssue {
  sku: string
  asin: string | null
  slot: string | null
  code: string
  message: string
  level: 'error' | 'warning'
}

export interface ValidationResult {
  hardFails: ValidationIssue[]
  softWarnings: ValidationIssue[]
  blockedAsins: string[]
  summary: { totalAsins: number; asinsWithIssues: number; asinsBlocked: number }
}

export interface PublishPlan {
  /** May the operator submit at all? */
  canSubmit: boolean
  /** True when some ASINs publish and others are skipped — the label must say so. */
  partial: boolean
  publishableAsins: number
  blockedAsins: number
  /** What the button should read. Never the word "published". */
  actionLabel: string
  /** The one sentence above the button. Empty when there is nothing the operator must know. */
  advisory: string
  /** Blocking issues, for the list. */
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  /** True when a submission cannot reach Amazon whatever the operator does. */
  rehearsalOnly: boolean
}

/**
 * `null` readiness means the server has not answered yet. That is NOT "gated" and NOT "live" — the
 * plan refuses to offer a submission it cannot describe, because guessing either way would either
 * block a legitimate publish or imply a live one.
 */
export function buildPublishPlan(args: {
  readiness: PublishReadiness | null
  validation: ValidationResult | null
  dryRun: boolean
}): PublishPlan {
  const { readiness, validation, dryRun } = args

  const errors = validation?.hardFails ?? []
  const warnings = validation?.softWarnings ?? []
  const total = validation?.summary.totalAsins ?? 0
  const blocked = validation?.summary.asinsBlocked ?? 0
  const publishable = Math.max(0, total - blocked)

  if (!readiness) {
    return {
      canSubmit: false, partial: false, publishableAsins: publishable, blockedAsins: blocked,
      actionLabel: 'Checking publish settings…',
      advisory: 'Asking the server whether publishing is enabled. Nothing is submitted until it answers.',
      errors, warnings, rehearsalOnly: false,
    }
  }

  if (!validation) {
    return {
      canSubmit: false, partial: false, publishableAsins: 0, blockedAsins: 0,
      actionLabel: 'Running preflight…',
      advisory: 'Checking every ASIN against Amazon’s image rules before anything is submitted.',
      errors, warnings, rehearsalOnly: false,
    }
  }

  // The gate is the server's answer, not a guess. `enabled: false` or a non-live mode both mean a
  // submission cannot reach Amazon.
  const rehearsalOnly = !readiness.enabled || readiness.mode !== 'live'

  if (total === 0) {
    return {
      canSubmit: false, partial: false, publishableAsins: 0, blockedAsins: 0,
      actionLabel: 'Nothing to submit',
      advisory: 'No ASIN on this product has images resolved for this market.',
      errors, warnings, rehearsalOnly,
    }
  }

  if (publishable === 0) {
    return {
      canSubmit: false, partial: false, publishableAsins: 0, blockedAsins: blocked,
      actionLabel: 'Blocked by preflight',
      advisory: `All ${blocked} ASIN${blocked === 1 ? '' : 's'} have a blocking problem. Amazon would reject the submission, so it is not offered.`,
      errors, warnings, rehearsalOnly,
    }
  }

  const partial = blocked > 0
  const scope = partial
    ? `${publishable} of ${total} ASINs`
    : `${total} ASIN${total === 1 ? '' : 's'}`

  // Dry run and the server-side gate are different facts and both must be visible: an operator who
  // turned dry-run off should still be told the gate is closed.
  const advisoryBits: string[] = []
  if (partial) {
    advisoryBits.push(`${blocked} ASIN${blocked === 1 ? ' is' : 's are'} blocked by preflight and will be skipped.`)
  }
  if (rehearsalOnly) {
    advisoryBits.push(
      readiness.enabled
        ? `Publishing is in ${readiness.mode} mode on the server, so nothing will reach Amazon.`
        : 'Publishing is disabled on the server, so nothing will reach Amazon.',
    )
  } else if (dryRun) {
    advisoryBits.push('Dry run: the feed is built and checked, but not submitted.')
  }
  if (warnings.length > 0) {
    advisoryBits.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'} — these do not block a submission.`)
  }

  return {
    canSubmit: true,
    partial,
    publishableAsins: publishable,
    blockedAsins: blocked,
    // "Queue", never "publish" — the Amazon path is an asynchronous feed submission, and whether
    // Amazon accepted it is a question the feed-status poll answers later.
    actionLabel: dryRun || rehearsalOnly ? `Dry run for ${scope}` : `Queue ${scope} to Amazon`,
    advisory: advisoryBits.join(' '),
    errors,
    warnings,
    rehearsalOnly,
  }
}
