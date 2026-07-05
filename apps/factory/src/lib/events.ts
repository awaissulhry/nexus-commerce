/**
 * F1 — in-process event bus + SSE replay buffer (the Nexus RT pattern,
 * single-machine edition: no Redis, no websockets). Ring buffer sized so a
 * laptop-lid-close survives (`?since=` replay); longer gaps fall through to a
 * full refetch by the client. Per-listener try/catch — one bad listener can't
 * break the bus.
 */

export type FactoryEventType =
  | "notification.created"
  | "comment.created"
  | "conversation.synced"
  | "conversation.updated"
  | "pricing.updated"
  | "integration.changed"
  | "import.finished"
  | "audit.written"
  | "ping";

export type FactoryEvent = {
  type: FactoryEventType;
  ts: number;
  payload?: Record<string, unknown>;
};

type Listener = (event: FactoryEvent) => void;

const REPLAY_MAX = 100;
const REPLAY_TTL_MS = 5 * 60 * 1000;

type Bus = {
  listeners: Set<Listener>;
  buffer: FactoryEvent[];
};

// survive Next dev HMR: one bus per process
const g = globalThis as unknown as { __factoryBus?: Bus };
const bus: Bus = (g.__factoryBus ??= { listeners: new Set(), buffer: [] });

export function publishEvent(type: FactoryEventType, payload?: Record<string, unknown>): void {
  const event: FactoryEvent = { type, ts: Date.now(), payload };
  if (type !== "ping") {
    bus.buffer.push(event);
    const cutoff = Date.now() - REPLAY_TTL_MS;
    while (bus.buffer.length > REPLAY_MAX || (bus.buffer[0] && bus.buffer[0].ts < cutoff)) {
      bus.buffer.shift();
    }
  }
  for (const listener of bus.listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("[events] listener failed", err);
    }
  }
}

export function subscribeEvents(listener: Listener): () => void {
  bus.listeners.add(listener);
  return () => bus.listeners.delete(listener);
}

/**
 * FP1.1 — durable publish: the in-process bus AND the FactoryEventOutbox
 * table. REQUIRED for anything emitted from the WORKER (separate process —
 * its bus never reaches web SSE clients; each SSE connection polls the
 * outbox forward every ~3s). Web-side emitters may also use it; the client
 * hooks debounce, so the double delivery collapses harmlessly.
 */
export async function publishEventDurable(
  type: FactoryEventType,
  payload?: Record<string, unknown>,
): Promise<void> {
  publishEvent(type, payload);
  try {
    const { prisma } = await import("@/lib/db");
    await prisma.factoryEventOutbox.create({ data: { type, payload: payload as object | undefined } });
  } catch (err) {
    console.error("[events] durable publish failed", type, (err as Error).message);
  }
}

export const replaySince = (since: number): FactoryEvent[] => bus.buffer.filter((e) => e.ts > since);

export const listenerCount = (): number => bus.listeners.size;
