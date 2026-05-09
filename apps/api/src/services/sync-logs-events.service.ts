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

type Listener = (event: SyncLogEvent) => void

const listeners = new Set<Listener>()

export function publishSyncLogEvent(event: SyncLogEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // A misbehaving listener mustn't break the bus for others.
    }
  }
}

export function subscribeSyncLogEvents(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSyncLogListenerCount(): number {
  return listeners.size
}
