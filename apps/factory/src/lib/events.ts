/**
 * F1 → FS2 — the event layer, rebuilt for O(1)-per-process fan-out.
 * One model, no special cases: EVERY event is durable (an outbox row with a
 * monotonic id), ONE shared poller per web process reads forward and fans out
 * to all SSE connections in memory (was: one 3s DB poll PER CLIENT — S-1).
 * Local publishes also dispatch immediately for latency; per-connection
 * lastId dedupe collapses the double delivery. Targeted events carry
 * scope.userId and reach only that user's connections. The old ts-based
 * replay ring is gone — resume is outbox-id-based and gap-free (worker
 * events that happened while a client was offline finally replay).
 * FC4 amendment: ephemeral events (typing/presence) are the ONE sanctioned
 * exception to "every event is durable" — see publishEphemeral below.
 */

export type FactoryEventType =
  | "notification.created"
  | "comment.created"
  | "conversation.synced"
  | "conversation.updated"
  | "pricing.updated"
  | "order.updated"
  | "workorder.created"
  | "workorder.updated"
  | "shipment.updated"
  | "payment.recorded"
  | "integration.changed"
  | "import.finished"
  | "party.updated" // FS2 — contacts CRUD was silent
  | "certificate.updated" // FS2 — cert CRUD was silent
  | "team.updated" // FS2 — role/member changes were silent
  | "settings.updated" // FS2 — config changes were silent
  | "chat.message" // FC1 — {spaceId, messageId}: message posted/edited/deleted/reacted
  | "chat.space" // FC1 — {spaceId}: space created/membership/read-cursor changed
  | "chat.typing" // FC4 — EPHEMERAL {spaceId, userId, name}: composer keystrokes (throttled), never persisted
  | "chat.presence" // FC4 — EPHEMERAL {online: userId[]}: the hub's connected-users set changed
  | "resync" // FS2 — server → client: gap too old, hard-refetch
  | "ping";

export type EventScope = { userId?: string };

export type FactoryEvent = {
  /** outbox id — monotonic, the resume cursor; 0 only for ping/resync */
  id: number;
  type: FactoryEventType;
  ts: number;
  payload?: Record<string, unknown>;
  scope?: EventScope;
};

export type Connection = {
  userId: string | null;
  /** returns false when the sink is gone (connection should be dropped) */
  send: (event: FactoryEvent) => boolean;
  lastId: number;
};

const POLL_MS = 1_000;
const POLL_TAKE = 200;
/** payload key that smuggles scope through the Json outbox column */
const SCOPE_KEY = "__scope";

type Hub = {
  connections: Set<Connection>;
  cursor: number; // shared poller cursor (outbox id)
  timer: ReturnType<typeof setInterval> | null;
  cursorReady: Promise<void> | null;
};

// survive Next dev HMR: one hub per process
const g = globalThis as unknown as { __factoryHub?: Hub };
const hub: Hub = (g.__factoryHub ??= { connections: new Set(), cursor: -1, timer: null, cursorReady: null });

/** pure delivery decision — exported for unit tests */
export function shouldDeliver(conn: Pick<Connection, "userId" | "lastId">, event: FactoryEvent): "send" | "skip-dupe" | "skip-scope" {
  if (event.id > 0 && event.id <= conn.lastId) return "skip-dupe";
  if (event.scope?.userId && conn.userId !== event.scope.userId) return "skip-scope";
  return "send";
}

function deliver(conn: Connection, event: FactoryEvent): void {
  const verdict = shouldDeliver(conn, event);
  if (verdict === "skip-dupe") return;
  // scoped-away events still advance the cursor so the dedupe window stays correct
  if (event.id > 0) conn.lastId = event.id;
  if (verdict === "skip-scope") return;
  if (!conn.send(event)) hub.connections.delete(conn);
}

function dispatch(event: FactoryEvent): void {
  for (const conn of [...hub.connections]) {
    try {
      deliver(conn, event);
    } catch (err) {
      console.error("[events] deliver failed", err);
      hub.connections.delete(conn);
    }
  }
}

/** outbox row → event (scope un-smuggled from payload) — exported for unit tests */
export function rowToEvent(row: { id: number; type: string; payload: unknown; createdAt: Date }): FactoryEvent {
  const raw = (row.payload as Record<string, unknown> | null) ?? undefined;
  let scope: EventScope | undefined;
  let payload = raw;
  if (raw && typeof raw[SCOPE_KEY] === "object" && raw[SCOPE_KEY] !== null) {
    scope = raw[SCOPE_KEY] as EventScope;
    payload = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== SCOPE_KEY));
  }
  return { id: row.id, type: row.type as FactoryEventType, ts: row.createdAt.getTime(), payload, scope };
}

async function pollOnce(): Promise<void> {
  const { prisma } = await import("@/lib/db");
  const rows = await prisma.factoryEventOutbox.findMany({
    where: { id: { gt: hub.cursor } },
    orderBy: { id: "asc" },
    take: POLL_TAKE, // bounded: shared poller page
  });
  for (const row of rows) {
    hub.cursor = row.id;
    dispatch(rowToEvent(row));
  }
}

function ensurePoller(): void {
  if (hub.timer) return;
  // seed the cursor to MAX(id) once, then poll forward — ONE query/second
  // per process, flat in connection count (FS2's whole point)
  hub.cursorReady ??= (async () => {
    const { prisma } = await import("@/lib/db");
    const row = await prisma.factoryEventOutbox.findFirst({ orderBy: { id: "desc" }, select: { id: true } });
    if (hub.cursor < 0) hub.cursor = row?.id ?? 0;
  })().catch(() => {
    if (hub.cursor < 0) hub.cursor = 0;
  });
  hub.timer = setInterval(() => {
    void pollOnce().catch((err) => console.error("[events] poll failed", (err as Error).message));
  }, POLL_MS);
}

// ── FC4 — ephemeral events (typing / presence) ───────────────────

/**
 * FC4 — pure ephemeral-event builder (exported for unit tests): id 0 marks
 * "never persisted" — no outbox row is minted, so the SSE route writes no
 * `id:` line (Last-Event-ID resume is undisturbed), shouldDeliver never
 * dupe-skips it, and replayOutboxSince can never return it.
 */
export function ephemeralEvent(
  type: FactoryEventType,
  payload?: Record<string, unknown>,
  scope?: EventScope,
): FactoryEvent {
  return { id: 0, type, ts: Date.now(), payload, scope };
}

/**
 * FC4 — publish an EPHEMERAL event: local in-memory dispatch ONLY, no outbox
 * write (typing indicators and presence must never cost a DB row per
 * keystroke). This is correct — not merely acceptable — because the web app
 * is a single process and every SSE connection lives in THIS hub (the worker
 * sidecar has no browser clients). If FS6 (multi-process / hosted Postgres)
 * ever lands, its LISTEN/NOTIFY pub/sub replaces this local dispatch; call
 * sites keep their shape.
 */
export function publishEphemeral(
  type: FactoryEventType,
  payload?: Record<string, unknown>,
  scope?: EventScope,
): void {
  dispatch(ephemeralEvent(type, payload, scope));
}

/** FC4 — distinct authed users currently holding an SSE connection on this hub */
export function connectedUserIds(): string[] {
  const ids = new Set<string>();
  for (const conn of hub.connections) if (conn.userId) ids.add(conn.userId);
  return [...ids].sort();
}

/**
 * FC4 — last-broadcast presence key. Module-local on purpose: worst case
 * (dev HMR re-evaluates the module) is ONE redundant presence event, which
 * clients fold idempotently. Comparing against the last broadcast — not the
 * mutation just performed — also heals connections that dispatch() dropped
 * on send failure without going through unregister.
 */
let lastPresenceKey: string | null = null;

function emitPresenceIfChanged(): void {
  const online = connectedUserIds();
  const key = online.join(",");
  if (key === lastPresenceKey) return;
  lastPresenceKey = key;
  publishEphemeral("chat.presence", { online });
}

/** SSE route: register a connection; returns unregister. Starts/stops the shared poller. */
export function registerConnection(conn: Connection): () => void {
  hub.connections.add(conn);
  ensurePoller();
  emitPresenceIfChanged(); // FC4 — the joiner (and everyone else) learns the new online set
  return () => {
    hub.connections.delete(conn);
    if (hub.connections.size === 0 && hub.timer) {
      clearInterval(hub.timer);
      hub.timer = null;
    }
    emitPresenceIfChanged(); // FC4 — departure (or a dispatch-dropped conn finally aborting)
  };
}

/** current shared cursor (connections initialize their lastId from it) */
export async function currentOutboxId(): Promise<number> {
  ensurePoller();
  await hub.cursorReady;
  return hub.cursor < 0 ? 0 : hub.cursor;
}

/**
 * Gap-free resume: outbox rows after `sinceId`. `resync: true` means the gap
 * predates outbox retention — the client must hard-refetch instead.
 */
export async function replayOutboxSince(
  sinceId: number,
  limit = 500,
): Promise<{ events: FactoryEvent[]; resync: boolean }> {
  const { prisma } = await import("@/lib/db");
  const oldest = await prisma.factoryEventOutbox.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
  if (oldest && sinceId > 0 && sinceId < oldest.id - 1) return { events: [], resync: true };
  const rows = await prisma.factoryEventOutbox.findMany({
    where: { id: { gt: sinceId } },
    orderBy: { id: "asc" },
    take: limit, // bounded: replay window
  });
  return { events: rows.map(rowToEvent), resync: rows.length === limit };
}

/**
 * The ONE publish path (FS2): outbox write first (mints the id), then an
 * immediate local dispatch so same-process clients don't wait for the poll.
 * `scope.userId` targets delivery to one user's connections.
 */
export async function publishEventDurable(
  type: FactoryEventType,
  payload?: Record<string, unknown>,
  scope?: EventScope,
): Promise<void> {
  try {
    const { prisma } = await import("@/lib/db");
    const stored = scope?.userId ? { ...(payload ?? {}), [SCOPE_KEY]: scope } : payload;
    const row = await prisma.factoryEventOutbox.create({
      data: { type, payload: stored as object | undefined },
    });
    dispatch({ id: row.id, type, ts: row.createdAt.getTime(), payload, scope });
  } catch (err) {
    console.error("[events] durable publish failed", type, (err as Error).message);
  }
}

/**
 * DEPRECATED alias (FS2): every event is durable now. Kept so existing
 * call sites keep compiling; fire-and-forget.
 */
export function publishEvent(type: FactoryEventType, payload?: Record<string, unknown>): void {
  void publishEventDurable(type, payload);
}

export const listenerCount = (): number => hub.connections.size;
