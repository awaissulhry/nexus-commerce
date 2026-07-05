/**
 * F1 — the SSE pipe (RT pattern): immediate ping, 25s heartbeat, `?since=`
 * replay from the ring buffer. Any authenticated user may listen; event
 * payloads carry ids, not data (clients refetch through permission-filtered
 * endpoints, so SSE cannot leak financial fields — F0-FINDINGS §8).
 */
import { NextRequest } from "next/server";
import { guarded } from "@/lib/auth/guard";
import { replaySince, subscribeEvents, type FactoryEvent } from "@/lib/events";
import { PAGES } from "@/lib/auth/permissions";

export const permission = PAGES.production; // every role holds at least one page; see note below
export const dynamic = "force-dynamic";

// NOTE: the guard requires SOME permission; production is the lowest common
// page every seeded role holds (OWNER implicit, WORKER explicit). If a future
// role lacks it, give the route its own `events.listen` feature grant.

const HEARTBEAT_MS = 25_000;

export const GET = guarded(PAGES.production, async (req: NextRequest) => {
  const since = Number(req.nextUrl.searchParams.get("since") ?? 0);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: FactoryEvent) => {
        controller.enqueue(
          encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        );
      };

      send({ type: "ping", ts: Date.now(), payload: { connected: true } });
      if (since > 0) for (const event of replaySince(since)) send(event);

      const unsubscribe = subscribeEvents(send);
      const heartbeat = setInterval(
        () => send({ type: "ping", ts: Date.now() }),
        HEARTBEAT_MS,
      );

      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", close);
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
