/**
 * C.0 — client-side wizard telemetry helper.
 *
 * Fire-and-forget POST to /api/listing-wizard/:id/events. Telemetry
 * must never block the wizard UX, so:
 *   - all calls are unawaited at call sites,
 *   - failures are swallowed silently (server-side logger captures
 *     persistence failures),
 *   - sendBeacon is used when the page is unloading so events from
 *     the last few seconds before navigation still land.
 *
 * The server enforces the privacy filter (apps/api/src/services/
 * listing-wizard/telemetry.service.ts). The client only structures
 * the payload — no sanitization here, so a future change to the
 * allowlist takes effect without redeploying the web app.
 */

import { getBackendUrl } from '@/lib/backend-url'

export type WizardEventType =
  | 'step_entered'
  | 'step_exited'
  | 'validation_failed'
  | 'validation_passed'
  | 'error_shown'
  | 'jumped_to_step'
  | 'submit_completed'
  | 'submit_failed'
  // C.0 expansion — funnel completeness.
  | 'wizard_started'
  | 'wizard_resumed'
  | 'wizard_discarded'
  | 'wizard_abandoned'

export interface WizardEventPayload {
  type: WizardEventType
  step: number
  durationMs?: number
  errorCode?: string
  errorContext?: Record<string, unknown>
}

/**
 * Post a single wizard event. Returns immediately; the network
 * call runs in the background. Never throws.
 */
export function postWizardEvent(
  wizardId: string,
  payload: WizardEventPayload,
): void {
  if (!wizardId) return
  const url = `${getBackendUrl()}/api/listing-wizard/${wizardId}/events`
  const body = JSON.stringify(payload)

  // Prefer sendBeacon for unload-time events: the browser queues
  // the request even after the page is torn down. Falls back to
  // fetch with keepalive when sendBeacon is unavailable or the
  // body is too large.
  try {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function'
    ) {
      const blob = new Blob([body], { type: 'application/json' })
      const ok = navigator.sendBeacon(url, blob)
      if (ok) return
    }
  } catch {
    // fall through to fetch
  }

  try {
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // swallow — telemetry is best-effort
    })
  } catch {
    // swallow
  }
}
