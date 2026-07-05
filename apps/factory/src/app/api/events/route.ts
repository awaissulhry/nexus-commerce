/**
 * F1 — the SSE pipe (RT pattern): immediate ping, 25s heartbeat, `?since=`
 * replay from the ring buffer. Any authenticated user may listen; event
 * payloads carry ids, not data (clients refetch through permission-filtered
 * endpoints, so SSE cannot leak financial fields — F0-FINDINGS §8).
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { replaySince, subscribeEvents, type FactoryEvent, type FactoryEventType } from "@/lib/events";
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

      // FP1.1 — outbox bridge: forward WORKER-process events (Gmail sync,
      // reminders) that the in-memory bus can't carry across processes.
      // Each connection polls forward from its own last-seen id (~3s; cheap).
      let lastOutboxId = 0;
      void prisma.factoryEventOutbox
        .findFirst({ orderBy: { id: "desc" }, select: { id: true } })
        .then((row) => {
          lastOutboxId = row?.id ?? 0;
        })
        .catch(() => {});
      const outboxPoll = setInterval(() => {
        void prisma.factoryEventOutbox
          .findMany({ where: { id: { gt: lastOutboxId } }, orderBy: { id: "asc" }, take: 100 })
          .then((rows) => {
            for (const row of rows) {
              lastOutboxId = row.id;
              send({
                type: row.type as FactoryEventType,
                ts: row.createdAt.getTime(),
                payload: (row.payload as Record<string, unknown>) ?? undefined,
              });
            }
          })
          .catch(() => {});
      }, 3000);

      const close = () => {
        clearInterval(heartbeat);
        clearInterval(outboxPoll);
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
