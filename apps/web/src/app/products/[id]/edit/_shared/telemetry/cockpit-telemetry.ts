'use client'

// AC.14 — Cockpit telemetry client.
//
// Fire-and-forget POST to /api/cockpit/events. Mirrors the wizard
// telemetry pattern (apps/web/src/app/products/[id]/list-wizard/
// lib/telemetry.ts):
//   - all calls unawaited at call sites,
//   - failures swallowed silently,
//   - sendBeacon used when the page is unloading so events from the
//     last few seconds before navigation still land.
//
// Server (cockpit-telemetry.routes.ts) persists each event into the
// AuditLog model tagged metadata.source='cockpit-telemetry' so the
// existing admin / analytics queries can roll up adoption without a
// fresh schema migration.

import { getBackendUrl } from '@/lib/backend-url'

export type CockpitEventType =
  // Session lifecycle.
  | 'cockpit_mounted'      // any time the AmazonCockpit instance mounts
  | 'classic_toggled'      // operator flipped from cockpit → classic
  | 'cockpit_toggled'      // operator flipped from classic → cockpit
  // Market switch.
  | 'market_switched'      // chip click / Alt+N / URL adopt — durationMs
  // Auto-fill (AC.11).
  | 'autofill_applied'     // diff modal Apply — fieldCount + source
  // Publish (AC.12).
  | 'publish_submitted'    // POST /publish-amazon succeeded — marketplaces + healthScore
  | 'publish_failed'       // POST /publish-amazon caught — error
  | 'publish_terminal'     // per-market feed reached DONE/CANCELLED/FATAL
  // Suppression (AC.10).
  | 'suppression_resolved' // PATCH /suppressions/:id { resolved: true }

export interface CockpitEventPayload {
  type: CockpitEventType
  productId?: string | null
  marketplace?: string | null
  durationMs?: number | null
  /** Sanitized JSON. Free-form but should stay small (server caps
   *  the row's metadata column). */
  payload?: Record<string, unknown>
}

/** Post a single telemetry event. Returns immediately; the network
 *  call runs in the background. Never throws. */
export function postCockpitEvent(payload: CockpitEventPayload): void {
  if (!payload.type) return
  const url = `${getBackendUrl()}/api/cockpit/events`
  const body = JSON.stringify(payload)

  // Prefer sendBeacon for unload-time events.
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
      credentials: 'include',
    }).catch(() => {
      // swallow — telemetry is best-effort
    })
  } catch {
    // swallow
  }
}
