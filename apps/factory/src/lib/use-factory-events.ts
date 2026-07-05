/**
 * F1 — debounced SSE client hook (the useOrderEventsRefresh pattern): one
 * EventSource, named listeners, a burst collapses into ONE callback; the last
 * event ts persists in sessionStorage so reconnects replay with `?since=`.
 * Silent degrade: if EventSource fails, callers keep their own polling.
 */
"use client";

import { useEffect, useRef } from "react";
import type { FactoryEventType } from "@/lib/events";

const LAST_TS_KEY = "factory.events.lastTs.v1";

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
    let source: EventSource | null = null;
    try {
      const since = sessionStorage.getItem(LAST_TS_KEY) ?? "0";
      source = new EventSource(`/api/events?since=${since}`);
      const record = (ts: number) => {
        try {
          sessionStorage.setItem(LAST_TS_KEY, String(ts));
        } catch {
          /* private mode */
        }
      };
      const fire = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => cb.current(), debounceMs);
      };
      for (const type of key.split(",") as FactoryEventType[]) {
        source.addEventListener(type, (e) => {
          const data = JSON.parse((e as MessageEvent).data) as { ts: number };
          record(data.ts);
          fire();
        });
      }
      source.addEventListener("ping", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { ts: number };
        record(data.ts);
      });
    } catch {
      /* degrade silently */
    }
    return () => {
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, [key, debounceMs, enabled]);
}
