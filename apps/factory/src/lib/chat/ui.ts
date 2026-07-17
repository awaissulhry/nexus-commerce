/**
 * FC2 — the pure cores of the /chat shell (no DB, no DOM): the Google-Chat
 * message anatomy (author-run grouping + day-divider chips), the rail's
 * activity sort / client-side filter / snippet + unread-badge math, the
 * ?space= URL composer, system-message deep-link href conventions, and the
 * newest-window merge the optimistic composer reconciles through. The
 * chat/_components render these; src/lib/__tests__/fc2-chat-ui.test.ts pins
 * them (house pattern: chat/pure.ts, orders/money.ts).
 * FC4 — reaction grouping/toggling, the read-receipt placement rule, the
 * typing state machine + throttle gate, and the presence-set fold
 * (src/lib/__tests__/fc4-affordances.test.ts pins these).
 */

import { MENTION_RE_SOURCE } from "./pure";

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
  /** FC3 — root messages carry their thread summary (null/absent = no replies) */
  thread?: ThreadSummary | null;
  /** FC4 — reaction rows (userId + emoji), first-reaction order; pills group them */
  reactions?: Reaction[];
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

/** the deep-link law: /chat?space=<id>[&thread=<rootId>] (FC3 — a thread is meaningless without its space) */
export function chatUrl(spaceId: string | null, threadId?: string | null): string {
  if (!spaceId) return "/chat";
  return threadId ? `/chat?space=${spaceId}&thread=${threadId}` : `/chat?space=${spaceId}`;
}

/** rail keyboard cursor: clamped (never wraps), -1 on an empty list */
export function clampMove(index: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.max(0, index + delta));
}

// ── FC3 — thread affordances + mention chips ─────────────────────

/** a root message's thread summary (rides the messages payload) */
export type ThreadSummary = {
  replyCount: number;
  lastReplyAt: string;
  /** up to 3 distinct repliers for the facepile */
  participants: { id: string; name: string }[];
};

export function threadRepliesLabel(n: number): string {
  return n === 1 ? "1 reply" : `${n} replies`;
}

/** the bounded space-members payload the mention chips resolve against */
export type MentionMember = { id: string; displayName: string; email: string };

export type BodyToken =
  | { kind: "text"; text: string }
  | { kind: "mention"; handle: string; raw: string; all: boolean };

/**
 * Tokenize a message body with the SERVER's mention grammar
 * (MENTION_RE_SOURCE — parity by construction): mention tokens carry the
 * handle; `all` marks the @all broadcast. Concatenating raw/text round-trips
 * the body exactly, so rendering never loses a character.
 */
export function splitMentionTokens(body: string): BodyToken[] {
  const re = new RegExp(MENTION_RE_SOURCE, "g");
  const tokens: BodyToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m.index > last) tokens.push({ kind: "text", text: body.slice(last, m.index) });
    tokens.push({ kind: "mention", handle: m[1], raw: m[0], all: m[1].toLowerCase() === "all" });
    last = m.index + m[0].length;
  }
  if (last < body.length) tokens.push({ kind: "text", text: body.slice(last) });
  return tokens;
}

/**
 * Client-side twin of resolveMentions' matching rules (email · email prefix ·
 * dotted.display.name · first name), over the bounded members payload. Null =
 * no member matches → the token renders as plain text, exactly like the
 * server would have resolved nobody.
 */
export function resolveHandleDisplay(handle: string, members: MentionMember[]): string | null {
  const h = handle.toLowerCase();
  for (const m of members) {
    const email = m.email.toLowerCase();
    const display = m.displayName.toLowerCase();
    if (email === h || email.split("@")[0] === h || display.replace(/\s+/g, ".") === h || display.split(/\s+/)[0] === h) {
      return m.displayName;
    }
  }
  return null;
}

/** a followed thread with unread activity (the rail's Threads section) */
export type FollowedThread = {
  rootId: string;
  spaceId: string;
  spaceName: string;
  snippet: string;
  rootAuthorName: string | null;
  lastReplyAt: string;
  replyCount: number;
};

// ── FC4 — reactions · read receipts · typing · presence ──────────

export type Reaction = { userId: string; emoji: string };

/** the Google-Chat quick row (hover picker, first tier) */
export const QUICK_REACTIONS: readonly string[] = ["👍", "✅", "🎉", "❤️", "😂", "😮", "🙏", "👀"];

/** the compact "more" grid — 24, disjoint from the quick row */
export const MORE_REACTIONS: readonly string[] = [
  "😀", "😅", "😉", "😊", "😍", "🤩", "🙃", "🤔",
  "😐", "😢", "😭", "😡", "🤯", "🥳", "😴", "🤒",
  "🤝", "👏", "💪", "🙌", "👎", "🔥", "💡", "🚀",
];

export type ReactionGroup = { emoji: string; count: number; mine: boolean; userIds: string[] };

/**
 * Group raw reaction rows into pills: first-seen order (rows arrive ordered
 * by first reaction time, so the earliest emoji keeps the leftmost pill —
 * the Google behavior), per-emoji count, and whether the viewer is in it.
 * Defensive against duplicate rows (the DB unique makes them impossible;
 * optimistic client state should not be trusted the same way).
 */
export function groupReactions(reactions: Reaction[] | undefined, meId: string | null): ReactionGroup[] {
  const groups: ReactionGroup[] = [];
  const byEmoji = new Map<string, ReactionGroup>();
  for (const r of reactions ?? []) {
    let g = byEmoji.get(r.emoji);
    if (!g) {
      g = { emoji: r.emoji, count: 0, mine: false, userIds: [] };
      byEmoji.set(r.emoji, g);
      groups.push(g);
    }
    if (g.userIds.includes(r.userId)) continue;
    g.userIds.push(r.userId);
    g.count++;
    if (meId != null && r.userId === meId) g.mine = true;
  }
  return groups;
}

/**
 * Optimistic toggle: clicking a pill (or picking an emoji) adds the viewer's
 * reaction when absent, removes it when present. `added` tells the caller
 * which FC1 route to call (POST vs DELETE); the server's chat.message event
 * reconciles everyone else.
 */
export function toggleReaction(
  reactions: Reaction[] | undefined,
  meId: string,
  emoji: string,
): { next: Reaction[]; added: boolean } {
  const list = reactions ?? [];
  const mine = list.some((r) => r.userId === meId && r.emoji === emoji);
  return mine
    ? { next: list.filter((r) => !(r.userId === meId && r.emoji === emoji)), added: false }
    : { next: [...list, { userId: meId, emoji }], added: true };
}

/** pill tooltip names — "You" first when the viewer reacted; unknown ids degrade to "Someone" */
export function reactionNames(userIds: string[], meId: string | null, members: MentionMember[]): string[] {
  const nameOf = new Map(members.map((m) => [m.id, m.displayName]));
  const others = userIds.filter((id) => id !== meId).map((id) => nameOf.get(id) ?? "Someone");
  return meId != null && userIds.includes(meId) ? ["You", ...others] : others;
}

/**
 * FC4 — the messages payload's member shape: FC3's mention-chip trio plus the
 * member's read cursor. `lastReadAt` is the CURSOR MESSAGE's timestamp,
 * server-resolved, so the client can seat a receipt even when the cursor
 * points at a thread reply that never appears in the main stream.
 */
export type SpaceMember = MentionMember & {
  lastReadMessageId: string | null;
  lastReadAt: string | null;
};

export type ReceiptReader = { id: string; name: string };

/**
 * The Google read-receipt rule, pure: each OTHER member's avatar sits under
 * the LAST main-stream message they have read. Placement: the cursor message
 * itself when it is in the window; otherwise the newest loaded message with
 * createdAt ≤ the cursor's timestamp (cursor-on-thread-reply, or same-stream
 * older edits). A cursor older than the loaded window renders nothing (their
 * position is off-screen); no cursor renders nothing. Own avatar never shows
 * to self. Pending optimistic rows are never placement targets.
 */
export function buildReceiptMap(
  messages: StreamMessage[],
  members: SpaceMember[],
  meId: string | null,
): Map<string, ReceiptReader[]> {
  const map = new Map<string, ReceiptReader[]>();
  if (messages.length === 0) return map;
  const idIndex = new Map<string, number>();
  messages.forEach((m, i) => {
    if (!m.pending) idIndex.set(m.id, i);
  });
  for (const member of members) {
    if (member.id === meId || !member.lastReadMessageId) continue;
    let idx = idIndex.get(member.lastReadMessageId) ?? -1;
    if (idx < 0 && member.lastReadAt) {
      const at = new Date(member.lastReadAt).getTime();
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.pending) continue;
        if (new Date(m.createdAt).getTime() <= at) {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0) continue;
    const target = messages[idx];
    const list = map.get(target.id) ?? [];
    list.push({ id: member.id, name: member.displayName });
    map.set(target.id, list);
  }
  return map;
}

export const RECEIPT_STACK_MAX = 5;

/** stack up to 5 reader avatars; the rest collapse into "+N" */
export function receiptStack(
  readers: ReceiptReader[],
  max: number = RECEIPT_STACK_MAX,
): { shown: ReceiptReader[]; extra: number } {
  return readers.length <= max
    ? { shown: readers, extra: 0 }
    : { shown: readers.slice(0, max), extra: readers.length - max };
}

// typing — ephemeral client state (nothing persists; see events.ts publishEphemeral)

export type Typist = { userId: string; name: string; at: number };

/** an indicator older than this is a lie — fade it */
export const TYPING_TTL_MS = 4_000;
/** the composer publishes at most one typing ping per this window */
export const TYPING_THROTTLE_MS = 2_000;

/** a fresh typing ping replaces the user's entry and prunes the stale in one pass */
export function typingUpsert(list: Typist[], entry: { userId: string; name: string }, nowMs: number): Typist[] {
  const fresh = list.filter((t) => t.userId !== entry.userId && nowMs - t.at < TYPING_TTL_MS);
  return [...fresh, { userId: entry.userId, name: entry.name, at: nowMs }];
}

/** drop expired typists; returns the SAME reference when nothing expired (render stability) */
export function typingPrune(list: Typist[], nowMs: number): Typist[] {
  if (!list.some((t) => nowMs - t.at >= TYPING_TTL_MS)) return list;
  return list.filter((t) => nowMs - t.at < TYPING_TTL_MS);
}

/** "Marco is typing…" · "Marco and Anna are typing…" · "+N more"; self excluded; null = show nothing */
export function typingLabel(list: Typist[], meId: string | null): string | null {
  const others = list.filter((t) => t.userId !== meId);
  if (others.length === 0) return null;
  const names = others.map((t) => t.name.trim().split(/\s+/)[0] || "Someone");
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more are typing…`;
}

/** the composer-side throttle gate (≤1 publish per TYPING_THROTTLE_MS) */
export function shouldPublishTyping(lastSentAt: number, nowMs: number): boolean {
  return nowMs - lastSentAt >= TYPING_THROTTLE_MS;
}

/**
 * Fold a chat.presence payload into the online set: `{online: string[]}` is
 * deduped + sorted (stable renders); anything malformed returns the CURRENT
 * set unchanged — a junk event must never blank every green dot.
 */
export function foldPresence(current: string[], payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return current;
  const raw = (payload as { online?: unknown }).online;
  if (!Array.isArray(raw)) return current;
  return [...new Set(raw.filter((v): v is string => typeof v === "string" && v.length > 0))].sort();
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
