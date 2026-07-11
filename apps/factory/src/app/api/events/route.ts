/**
 * F1 → FS2 — the SSE pipe on the shared-poller hub. Per connection: NO DB
 * polling (the process-wide poller in src/lib/events.ts does one 1s query
 * for everyone); id-based gap-free resume (SSE `id:` field → the browser
 * sends Last-Event-ID on reconnect automatically; `?sinceId=` works too);
 * userId-scoped delivery; heartbeat doubles as the backpressure probe — a
 * client whose buffer stays saturated across two beats is dropped and
 * resumes losslessly on reconnect. Payloads still carry ids, not data
 * (clients refetch through permission-filtered endpoints — F0-FINDINGS §8).
 */
import { NextRequest } from "next/server";
import { guarded } from "@/lib/auth/guard";
import { registerConnection, replayOutboxSince, currentOutboxId, type Connection, type FactoryEvent } from "@/lib/events";
import { PAGES } from "@/lib/auth/permissions";

export const permission = PAGES.production; // lowest common page every seeded role holds
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

export const GET = guarded(PAGES.production, async (req: NextRequest, { actor }) => {
  const sinceParam = Number(req.nextUrl.searchParams.get("sinceId") ?? 0);
  const lastEventId = Number(req.headers.get("last-event-id") ?? 0);
  const sinceId = Math.max(sinceParam || 0, lastEventId || 0);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let saturatedBeats = 0;
      let closed = false;
      let unregister: (() => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unregister?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const raw = (event: FactoryEvent): boolean => {
        if (closed) return false;
        try {
          const idLine = event.id > 0 ? `id: ${event.id}\n` : "";
          controller.enqueue(encoder.encode(`${idLine}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          return true;
        } catch {
          return false;
        }
      };

      raw({ id: 0, type: "ping", ts: Date.now(), payload: { connected: true } });

      // resume: replay the outbox gap (worker events included — the pre-FS2
      // design lost anything that happened while the tab was closed)
      let lastId = await currentOutboxId();
      if (sinceId > 0) {
        const { events, resync } = await replayOutboxSince(sinceId);
        if (resync) {
          raw({ id: 0, type: "resync", ts: Date.now() });
        } else {
          for (const e of events) {
            if (!e.scope?.userId || e.scope.userId === (actor?.id ?? null)) raw(e);
          }
          if (events.length) lastId = Math.max(lastId, events[events.length - 1].id);
        }
      }

      const conn: Connection = { userId: actor?.id ?? null, send: raw, lastId };
      unregister = registerConnection(conn);

      heartbeat = setInterval(() => {
        // backpressure probe: desiredSize < 0 means the client isn't draining
        if ((controller.desiredSize ?? 1) < 0) {
          saturatedBeats++;
          if (saturatedBeats >= 2) return close();
        } else {
          saturatedBeats = 0;
        }
        raw({ id: 0, type: "ping", ts: Date.now() });
      }, HEARTBEAT_MS);

      req.signal.addEventListener("abort", close);
      if (req.signal.aborted) close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
});
