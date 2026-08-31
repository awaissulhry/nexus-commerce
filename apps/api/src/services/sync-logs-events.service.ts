/**
 * L.7.0 — In-process event bus for sync-log events.
 *
 * Mirrors listing-events / inbound-events / outbound-events. SSE
 * subscribers stream events to the hub's live-tail UI; recordApiCall
 * publishes here after writing the OutboundApiCallLog row.
 *
 * Single-process design (current Railway scale = one API instance).
 * Horizontal scaling adds Redis pub/sub later without changing the
 * public API.
 *
 * Event payloads are slim ({ type, ts, channel, operation, statusCode,
 * latencyMs, success, errorType }) — subscribers don't need to refetch;
 * the row is enough to render the live-tail line. Heavier detail
 * (request/response payloads) stays behind the rest endpoint.
 */

export type SyncLogEvent =
  | {
      type: 'api-call.recorded'
      ts: number
      id: string
      channel: string
      marketplace: string | null
      operation: string
      statusCode: number | null
      success: boolean
      latencyMs: number
      errorType: string | null
      errorMessage: string | null
    }
  | { type: 'ping'; ts: number }


// ── EV.3 — cross-replica via the shared bus factory ─────────────────────────
//
// Signatures and synchronous behaviour are UNCHANGED: every call site is
// untouched, and a local subscriber still receives an event in the same tick.
// What changed is that a publish now also fans out to other replicas, and this
// process receives theirs — the ceiling that made a second API instance unsafe.
//
// The bus logic is lib/events/bus.ts, shared by every bus rather than copied
// into each. EPHEMERAL lane: these are refresh hints, not durable facts.

import { createCrossReplicaBus } from '../lib/events/bus.js'
import type { EventType } from '@nexus/events'

type Listener = (event: SyncLogEvent) => void

/** The catalogue types this bus carries. A remote event outside this set
 *  belongs to another bus and must not be delivered here. */
const CARRIED = ['api-call.recorded'] as const satisfies readonly EventType[]

const bus = createCrossReplicaBus<SyncLogEvent>({ name: 'sync-logs-sse', types: CARRIED })

export function publishSyncLogEvent(event: SyncLogEvent): void {
  bus.publish(event)
}

export function subscribeSyncLogEvents(listener: Listener): () => void {
  return bus.subscribe(listener)
}

export function getSyncLogListenerCount(): number {
  return bus.listenerCount()
}

/** Attach this process to events raised on OTHER replicas. Call once at boot. */
export async function startSyncLogEventIntake(): Promise<void> {
  await bus.startIntake()
}

export async function stopSyncLogEventIntake(): Promise<void> {
  await bus.stopIntake()
}
