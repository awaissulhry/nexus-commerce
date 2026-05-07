/**
 * C.0 — WizardStepEvent telemetry writer.
 *
 * Two writers feed this service:
 *   1. PATCH /api/listing-wizard/:id detects currentStep transitions
 *      and writes step_entered / step_exited.
 *   2. POST /api/listing-wizard/:id/events accepts client-emitted
 *      events (validation_failed, validation_passed, error_shown,
 *      jumped_to_step, submit_completed, submit_failed) and routes
 *      through this same writer for one privacy filter.
 *
 * Privacy: errorContext is constrained by an allowlist of keys, a
 * length cap on string values, and a regex that drops anything that
 * looks like email / phone / credit-card. AuditLog is the place for
 * full state diffs; this table holds categorical reasons + small
 * numeric counts only.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export const WIZARD_EVENT_TYPES = [
  'step_entered',
  'step_exited',
  'validation_failed',
  'validation_passed',
  'error_shown',
  'jumped_to_step',
  'submit_completed',
  'submit_failed',
  // C.0 expansion — funnel completeness.
  'wizard_started',
  'wizard_resumed',
  'wizard_discarded',
  'wizard_abandoned',
] as const

export type WizardEventType = (typeof WIZARD_EVENT_TYPES)[number]

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'fieldKey', // e.g., "brand", "marketplace.IT.price"
  'channelKey', // e.g., "AMAZON:IT"
  'reason', // categorical
  'blockerCount',
  'attemptCount',
  'fromStep',
  'toStep',
  'channelsSucceeded',
  'channelsFailed',
  'totalDurationMs',
])

const STRING_CAP = 80

// Defense in depth: even if a developer adds the wrong key to
// ALLOWED_KEYS, these patterns drop string values that look like PII.
const EMAIL_RE = /[\w.-]+@[\w.-]+\.\w+/
const LONG_DIGITS_RE = /\d{10,}/

function looksLikePii(value: string): boolean {
  if (EMAIL_RE.test(value)) return true
  if (LONG_DIGITS_RE.test(value)) return true
  return false
}

/**
 * Sanitize errorContext: keys must be in the allowlist; string values
 * are length-capped and PII-screened; nested objects/arrays are
 * dropped (we want flat scalar data only). Returns null if nothing
 * survived — callers persist null instead of an empty object so the
 * column reads cleanly.
 */
export function sanitizeErrorContext(
  input: unknown,
): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null
  if (Array.isArray(input)) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!ALLOWED_KEYS.has(k)) continue
    if (v === null || v === undefined) continue
    if (typeof v === 'string') {
      if (v.length > STRING_CAP) continue
      if (looksLikePii(v)) continue
      out[k] = v
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v
    } else if (typeof v === 'boolean') {
      out[k] = v
    }
    // objects, arrays, functions, symbols, bigints — all dropped.
  }
  return Object.keys(out).length > 0 ? out : null
}

export interface WriteEventArgs {
  wizardId: string
  productId: string
  type: WizardEventType
  step: number
  durationMs?: number | null
  errorCode?: string | null
  errorContext?: unknown
}

/**
 * Append a single WizardStepEvent. Fire-and-forget at the call site
 * (telemetry must never block a PATCH or submit). Logs on failure
 * but never throws — a missing row is preferable to a failed wizard
 * action.
 */
export async function writeWizardEvent(args: WriteEventArgs): Promise<void> {
  try {
    if (!WIZARD_EVENT_TYPES.includes(args.type)) {
      logger.warn('wizard-telemetry: rejecting unknown event type', {
        type: args.type,
      })
      return
    }
    if (
      typeof args.step !== 'number' ||
      args.step < 1 ||
      args.step > 9 ||
      !Number.isInteger(args.step)
    ) {
      logger.warn('wizard-telemetry: rejecting out-of-range step', {
        step: args.step,
      })
      return
    }
    const errorCode =
      typeof args.errorCode === 'string' && args.errorCode.length > 0
        ? args.errorCode.slice(0, STRING_CAP)
        : null
    const durationMs =
      typeof args.durationMs === 'number' &&
      Number.isFinite(args.durationMs) &&
      args.durationMs >= 0
        ? Math.floor(args.durationMs)
        : null
    const errorContext = sanitizeErrorContext(args.errorContext)

    await prisma.wizardStepEvent.create({
      data: {
        wizardId: args.wizardId,
        productId: args.productId,
        type: args.type,
        step: args.step,
        durationMs,
        errorCode,
        errorContext: errorContext as object | null,
      },
    })
  } catch (err) {
    // Telemetry writes must never break the calling flow.
    logger.warn('wizard-telemetry: write failed (non-fatal)', {
      err: err instanceof Error ? err.message : String(err),
      type: args.type,
      step: args.step,
      wizardId: args.wizardId,
    })
  }
}

/**
 * Convenience for the PATCH-handler step-transition pair. Writes
 * step_exited for the previous step (with durationMs from the
 * wizard's prior updatedAt) and step_entered for the new step.
 * Intended for void-return fire-and-forget call sites.
 */
export async function writeStepTransition(args: {
  wizardId: string
  productId: string
  fromStep: number
  toStep: number
  prevUpdatedAt: Date
}): Promise<void> {
  if (args.fromStep === args.toStep) return
  const now = Date.now()
  const durationMs = Math.max(0, now - args.prevUpdatedAt.getTime())
  await writeWizardEvent({
    wizardId: args.wizardId,
    productId: args.productId,
    type: 'step_exited',
    step: args.fromStep,
    durationMs,
    errorContext: { fromStep: args.fromStep, toStep: args.toStep },
  })
  await writeWizardEvent({
    wizardId: args.wizardId,
    productId: args.productId,
    type: 'step_entered',
    step: args.toStep,
    errorContext: { fromStep: args.fromStep, toStep: args.toStep },
  })
}
