/**
 * F1 → FS2 — the SSE client, multiplexed: ONE EventSource per browser tab
 * shared by every useFactoryEvents hook (was: one connection per distinct
 * type-set — a page could hold several). The hook signature is unchanged, so
 * zero call sites move. Resume is outbox-id-based: the last delivered id
 * persists in localStorage and rides `?sinceId=` (plus the browser's native
 * Last-Event-ID on auto-reconnect); a server `resync` event fires every
 * subscriber immediately (their callbacks refetch — that IS the resync).
 * FC4 amendment: subscribers now receive the parsed event object (existing
 * refetch-style callers ignore it) and useFactoryEventData exposes it for
 * the ephemeral chat.typing / chat.presence types.
 */
"use client";

import { useEffect, useRef } from "react";
import type { FactoryEventType } from "@/lib/events";

const LAST_ID_KEY = "factory.events.lastId.v2";

/** FC4 — the wire shape a payload subscriber receives (parsed SSE data) */
export type FactoryEventData = { type: FactoryEventType; id?: number; payload?: Record<string, unknown> };

type Subscriber = {
  types: Set<FactoryEventType>;
  /** refetch-style subscribers ignore the arg; FC4 payload subscribers read it */
  fire: (event?: FactoryEventData) => void;
};

type Manager = {
  source: EventSource | null;
  subscribers: Set<Subscriber>;
};

const g = globalThis as unknown as { __factoryEventManager?: Manager };

function manager(): Manager {
  return (g.__factoryEventManager ??= { source: null, subscribers: new Set() });
}

function recordId(id: number): void {
  if (!id) return;
  try {
    const prev = Number(localStorage.getItem(LAST_ID_KEY) ?? 0);
    if (id > prev) localStorage.setItem(LAST_ID_KEY, String(id));
  } catch {
    /* private mode */
  }
}

function dispatchToSubs(type: FactoryEventType, event?: FactoryEventData): void {
  for (const sub of manager().subscribers) {
    if (type === "resync" || sub.types.has(type)) sub.fire(event);
  }
}

/** every concrete event type the server can emit (ping handled separately) */
const ALL_TYPES: FactoryEventType[] = [
  "notification.created", "comment.created", "conversation.synced", "conversation.updated",
  "pricing.updated", "order.updated", "workorder.created", "workorder.updated",
  "shipment.updated", "payment.recorded", "integration.changed", "import.finished",
  "party.updated", "certificate.updated", "team.updated", "settings.updated",
  "chat.message", "chat.space", "chat.typing", "chat.presence", "resync", // chat.typing/presence: FC4 ephemerals
];

function ensureSource(): void {
  const m = manager();
  if (m.source || typeof window === "undefined" || !("EventSource" in window)) return;
  try {
    let sinceId = "0";
    try {
      sinceId = localStorage.getItem(LAST_ID_KEY) ?? "0";
    } catch {
      /* private mode */
    }
    const source = new EventSource(`/api/events?sinceId=${sinceId}`);
    m.source = source;
    for (const type of ALL_TYPES) {
      source.addEventListener(type, (e) => {
        const data = JSON.parse((e as MessageEvent).data) as FactoryEventData;
        recordId(data.id ?? 0); // ephemeral events carry id 0 — recordId ignores them
        dispatchToSubs(type, data);
      });
    }
    // pings are liveness only — ids are the resume cursor now; native
    // auto-reconnect carries Last-Event-ID, nothing else to do
  } catch {
    /* degrade silently: callers keep their own fallbacks */
  }
}

function releaseSourceIfIdle(): void {
  const m = manager();
  if (m.subscribers.size === 0 && m.source) {
    m.source.close();
    m.source = null;
  }
}

export function useFactoryEvents(
  types: FactoryEventType[],
  onEvent: () => void,
  opts?: { debounceMs?: number; enabled?: boolean },
) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const debounceMs = opts?.debounceMs ?? 2000;
  const enabled = opts?.enabled ?? true;
  const key = types.join(",");

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || !("EventSource" in window)) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub: Subscriber = {
      types: new Set(key.split(",") as FactoryEventType[]),
      fire: () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => cb.current(), debounceMs);
      },
    };
    manager().subscribers.add(sub);
    ensureSource();
    return () => {
      if (timer) clearTimeout(timer);
      manager().subscribers.delete(sub);
      releaseSourceIfIdle();
    };
  }, [key, debounceMs, enabled]);
}

/**
 * FC4 — payload-carrying subscription for the EPHEMERAL event types
 * (chat.typing / chat.presence): no debounce (an indicator that arrives late
 * is a lie), the parsed event object reaches the callback so there is nothing
 * to refetch — by design, since ephemeral events have no DB row behind them.
 * A server `resync` still fires every subscriber (event.type === "resync");
 * callers that seeded state from a GET should re-seed on it. Refetch-style
 * consumers stay on useFactoryEvents — this hook is for payloads only.
 */
export function useFactoryEventData(
  types: FactoryEventType[],
  onEvent: (event: FactoryEventData) => void,
  opts?: { enabled?: boolean },
) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const enabled = opts?.enabled ?? true;
  const key = types.join(",");

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || !("EventSource" in window)) return;
    const sub: Subscriber = {
      types: new Set(key.split(",") as FactoryEventType[]),
      fire: (event) => {
        if (event) cb.current(event);
      },
    };
    manager().subscribers.add(sub);
    ensureSource();
    return () => {
      manager().subscribers.delete(sub);
      releaseSourceIfIdle();
    };
  }, [key, enabled]);
}
