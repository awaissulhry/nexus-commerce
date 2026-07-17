/**
 * FC2 — the pure cores of the /chat shell (no DB, no DOM): the Google-Chat
 * message anatomy (author-run grouping + day-divider chips), the rail's
 * activity sort / client-side filter / snippet + unread-badge math, the
 * ?space= URL composer, system-message deep-link href conventions, and the
 * newest-window merge the optimistic composer reconciles through. The
 * chat/_components render these; src/lib/__tests__/fc2-chat-ui.test.ts pins
 * them (house pattern: chat/pure.ts, orders/money.ts).
 */

// ── message stream anatomy ───────────────────────────────────────

export type StreamMessage = {
  id: string;
  authorId: string | null;
  authorName: string | null;
  kind: "MESSAGE" | "SYSTEM";
  body: string;
  /** structured money — ABSENT for cost-blind callers (grain-stripped); render € ONLY when present */
  moneyCents?: number | null;
  moneyLabel?: string | null;
  meta?: unknown;
  editedAt?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  /** optimistic append not yet confirmed by the server */
  pending?: boolean;
};

export type StreamRow =
  | { kind: "divider"; key: string; label: string }
  | { kind: "message"; key: string; message: StreamMessage; runStart: boolean };

/** Google-Chat grouping: same author, close together = one run (avatar+name once) */
export const RUN_GAP_MS = 5 * 60_000;

const ts = (iso: string): number => new Date(iso).getTime();
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const sameLocalDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const dayKeyOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** the day-divider chip label: Today · Yesterday · "Tue 14 Jul" · "14 Jul 2025" */
export function dayLabel(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const now = new Date(nowMs);
  if (sameLocalDay(d, now)) return "Today";
  if (sameLocalDay(d, new Date(nowMs - 86_400_000))) return "Yesterday";
  if (d.getFullYear() === now.getFullYear()) return `${WD[d.getDay()]} ${d.getDate()} ${MO[d.getMonth()]}`;
  return `${d.getDate()} ${MO[d.getMonth()]} ${d.getFullYear()}`;
}

/** rail relative time: now · 12m · 3h · Yesterday · "14 Jul" · "14 Jul 2025" */
export function relTime(iso: string, nowMs: number): string {
  const at = ts(iso);
  const d = new Date(at);
  const now = new Date(nowMs);
  const s = Math.max(0, (nowMs - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (sameLocalDay(d, now)) return `${Math.floor(s / 3600)}h`;
  if (sameLocalDay(d, new Date(nowMs - 86_400_000))) return "Yesterday";
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MO[d.getMonth()]}`;
  return `${d.getDate()} ${MO[d.getMonth()]} ${d.getFullYear()}`;
}

/** run-header timestamp — 24h, the factory's clock */
export function timeOfDay(iso: string): string {
  const d = new Date(ts(iso));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Ascending messages → render rows: a divider chip whenever the local day
 * changes, and `runStart` marking the first message of an author run (avatar +
 * name + time render there; followers are bare lines). SYSTEM messages always
 * stand alone; a divider always breaks the run.
 */
export function buildStream(messages: StreamMessage[], nowMs: number): StreamRow[] {
  const rows: StreamRow[] = [];
  let prev: StreamMessage | null = null;
  for (const m of messages) {
    const at = ts(m.createdAt);
    if (!prev || dayKeyOf(ts(prev.createdAt)) !== dayKeyOf(at)) {
      rows.push({ kind: "divider", key: `d-${dayKeyOf(at)}`, label: dayLabel(at, nowMs) });
      prev = null; // a divider breaks the run
    }
    const runStart =
      !prev ||
      m.kind === "SYSTEM" ||
      prev.kind === "SYSTEM" ||
      prev.authorId !== m.authorId ||
      at - ts(prev.createdAt) > RUN_GAP_MS;
    rows.push({ kind: "message", key: m.id, message: m, runStart });
    prev = m;
  }
  return rows;
}

/**
 * Reconcile a freshly-fetched newest window (ascending) into the accumulated
 * ascending list: server copies replace stale rows by id, unseen rows join,
 * and a pending optimistic row vanishes once its server copy arrives (same
 * author + body within a minute — the id swap may not have landed yet).
 */
export function mergeNewestWindow(existing: StreamMessage[], incoming: StreamMessage[]): StreamMessage[] {
  const byId = new Map(incoming.map((m) => [m.id, m]));
  const out: StreamMessage[] = [];
  for (const m of existing) {
    const server = byId.get(m.id);
    if (server) {
      out.push(server);
      byId.delete(m.id);
      continue;
    }
    if (
      m.pending &&
      incoming.some((i) => i.authorId === m.authorId && i.body === m.body && Math.abs(ts(i.createdAt) - ts(m.createdAt)) < 60_000)
    ) {
      continue; // the server copy supersedes the optimistic row
    }
    out.push(m);
  }
  for (const m of incoming) if (byId.has(m.id)) out.push(m);
  return out.sort((a, b) => ts(a.createdAt) - ts(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ── system-message deep links (house URL conventions) ────────────

export function entityHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case "order":
      return `/orders?o=${entityId}`;
    case "quote":
      return `/quotes?q=${entityId}`;
    case "conversation":
      return `/inbox?focus=${entityId}`;
    default:
      return null;
  }
}

const ENTITY_LABEL: Record<string, string> = {
  order: "Open order",
  quote: "Open quote",
  conversation: "Open thread",
};

/** a SYSTEM message's meta → its jump-to-source chip (null = no chip, never a dead link) */
export function metaChip(meta: unknown): { href: string; label: string } | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as { entityType?: unknown; entityId?: unknown };
  if (typeof m.entityType !== "string" || typeof m.entityId !== "string" || !m.entityId) return null;
  const href = entityHref(m.entityType, m.entityId);
  return href ? { href, label: ENTITY_LABEL[m.entityType] ?? "Open" } : null;
}

// ── rail math ────────────────────────────────────────────────────

export type RailLastMessage = {
  kind: "MESSAGE" | "SYSTEM";
  body: string;
  authorName?: string | null;
  deletedAt?: string | null;
  createdAt: string;
};

export type RailSpaceLike = {
  name: string;
  updatedAt: string;
  lastMessage?: RailLastMessage | null;
};

/** last activity = the latest message; a message-less space falls back to its row time */
export const spaceActivityAt = (s: RailSpaceLike): number => ts(s.lastMessage?.createdAt ?? s.updatedAt);

export function sortSpacesByActivity<T extends RailSpaceLike>(spaces: T[]): T[] {
  return [...spaces].sort((a, b) => spaceActivityAt(b) - spaceActivityAt(a));
}

/** the rail search filters client-side by name */
export function filterSpaces<T extends RailSpaceLike>(spaces: T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return spaces;
  return spaces.filter((s) => s.name.toLowerCase().includes(needle));
}

/** the row's one-line snippet: "Marco: measured the sleeves" · system text · tombstone */
export function railSnippet(last: RailLastMessage | null | undefined): string {
  if (!last) return "No messages yet";
  if (last.deletedAt) return "Message deleted";
  const body = last.body.replace(/\s+/g, " ").trim().slice(0, 120);
  if (last.kind === "SYSTEM") return body;
  const first = (last.authorName ?? "").trim().split(/\s+/)[0];
  return first ? `${first}: ${body}` : body;
}

/** badge text — empty at zero, capped at 99+ */
export function formatUnread(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

/** the deep-link law: /chat?space=<id> */
export function chatUrl(spaceId: string | null): string {
  return spaceId ? `/chat?space=${spaceId}` : "/chat";
}

/** rail keyboard cursor: clamped (never wraps), -1 on an empty list */
export function clampMove(index: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.max(0, index + delta));
}

// ── avatars ──────────────────────────────────────────────────────

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const second = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + second).toUpperCase();
}

/** deterministic avatar hue per author id (stable across sessions) */
export function avatarHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}
