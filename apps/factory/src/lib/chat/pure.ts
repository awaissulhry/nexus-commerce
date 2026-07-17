/**
 * FC1 — the pure cores of the chat service, extracted so the contract is
 * testable without a DB (house pattern: orders/money.ts). chat-service.ts is
 * the only consumer besides the tests and the /api/chat routes.
 */

/**
 * The cost-blind law (FC1-SPEC §Schema, substrate trap #1): money rides ONLY
 * in the structured `moneyCents` field — the grain strip deletes `*Cents`
 * keys, but money interpolated into free text would be unstrippable. When a
 * message carries moneyCents, its body must not smell of money.
 */
export const MONEY_IN_BODY_RE = /€|\bEUR\b|\d+[.,]\d{2}\s*€/;

export const bodyCarriesMoney = (body: string): boolean => MONEY_IN_BODY_RE.test(body);

/** ORDER spaces are system-named: "ORD-214 · Rossi Leather". */
export function orderSpaceName(orderNumber: string, partyName: string): string {
  return `${orderNumber} · ${partyName}`;
}

export type OrderSpaceMember = { userId: string; role: "MANAGER" };

/**
 * ensureOrderSpace's membership contract: every active OWNER user joins as
 * MANAGER (dedupe-stable — same input, same output, so the create is
 * idempotent in shape as well as in the DB unique).
 */
export function buildOrderSpaceMembers(ownerUserIds: string[]): OrderSpaceMember[] {
  return [...new Set(ownerUserIds)].map((userId) => ({ userId, role: "MANAGER" as const }));
}

/**
 * Read-cursor unread math: a message is unread when it landed AFTER the
 * cursor message, is not soft-deleted, and is not the viewer's own (system
 * messages — authorId null — always count). No cursor = everything unread.
 * FC3 — main-stream only (threadRootId null): thread replies notify their
 * audience (participants/followers/mentioned) and surface in the rail's
 * Threads section — they never bold the whole space (the Google rule).
 * Returns the Prisma where clause the bounded count aggregate runs on.
 */
export function unreadMessageWhere(spaceId: string, viewerUserId: string, lastReadAt: Date | null) {
  return {
    spaceId,
    deletedAt: null,
    threadRootId: null,
    OR: [{ authorId: null }, { authorId: { not: viewerUserId } }],
    ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
  };
}

export const WINDOW_TAKE_DEFAULT = 100;
export const WINDOW_TAKE_MAX = 100;

// ── FC3 — in-line threads: mentions, @all, follows, notify audience ──

/**
 * The ONE mention-token grammar (source of truth; comments.ts builds its
 * MENTION_RE from this, chat/ui.ts tokenizes chips with it — parity by
 * construction, not by convention). Matches @email, @email-prefix,
 * @first-name and @dotted.display.name handles.
 */
export const MENTION_RE_SOURCE = "@([\\w.+-]+(?:@[\\w.-]+)?)";

/**
 * `@all` — the broadcast mention. Detected over the SAME tokenizer the
 * mention grammar uses (so "foo@all.com" or "me@all" never broadcast): a
 * token whose handle is exactly "all" (case-insensitive), not glued to a
 * preceding handle/email character. resolveMentions stays user-only — the
 * chat service expands @all to the space's members explicitly, audited.
 */
export function bodyMentionsAll(body: string): boolean {
  const re = new RegExp(MENTION_RE_SOURCE, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[1].toLowerCase() === "all" && !/[\w@.+-]/.test(body[m.index - 1] ?? "")) return true;
  }
  return false;
}

/** followedThreads cap per membership — newest follows kept, oldest dropped */
export const FOLLOWED_THREADS_MAX = 50;

/** defensive Json → string[] (nulls, junk, mixed arrays all degrade to sane) */
export function parseFollowedThreads(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * Follow a thread (idempotent): already-following returns the SAME array
 * reference so callers can skip the write; a new follow appends at the end
 * (newest last) and drops the oldest beyond FOLLOWED_THREADS_MAX.
 */
export function addFollowedThread(list: string[], rootId: string): string[] {
  if (list.includes(rootId)) return list;
  const next = [...list, rootId];
  return next.length > FOLLOWED_THREADS_MAX ? next.slice(next.length - FOLLOWED_THREADS_MAX) : next;
}

/** Unfollow (idempotent): not-following returns the SAME array reference. */
export function removeFollowedThread(list: string[], rootId: string): string[] {
  if (!list.includes(rootId)) return list;
  return list.filter((id) => id !== rootId);
}

export type ChatNotifyLevelName = "ALL" | "MENTIONS" | "OFF";

/**
 * The Google notify rule for a message, pure: who gets a MENTION ping and
 * who gets a reply ping. Thread replies notify ONLY participants + followers
 * + @mentioned — never the whole space; main-stream messages pass empty
 * participant/follower sets so only mentions ping.
 *   · the author never notifies themselves
 *   · mentioned users leave the reply set (they get the MENTION instead)
 *   · notifyLevel: OFF mutes EVERYTHING (even direct mentions — the user
 *     asked for silence); MENTIONS mutes non-mention thread pings; a user
 *     with no membership row (mentioned non-member) defaults to ALL —
 *     matching FC1, which already notified mentioned non-members
 * Output arrays are sorted for determinism (tests + stable notify order).
 */
export function computeThreadAudience(input: {
  authorId: string;
  /** distinct authors of the root + its replies */
  participantIds: string[];
  /** members whose followedThreads contains the rootId */
  followerIds: string[];
  /** resolved @user mentions (plus the @all expansion, if any) */
  mentionedIds: string[];
  /** notifyLevel per space member (absent = non-member = ALL) */
  levels: Record<string, ChatNotifyLevelName>;
}): { mention: string[]; reply: string[] } {
  const levelOf = (id: string): ChatNotifyLevelName => input.levels[id] ?? "ALL";
  const mentioned = new Set(input.mentionedIds.filter((id) => id !== input.authorId));
  const reply = new Set<string>();
  for (const id of [...input.participantIds, ...input.followerIds]) {
    if (id !== input.authorId && !mentioned.has(id)) reply.add(id);
  }
  return {
    mention: [...mentioned].filter((id) => levelOf(id) !== "OFF").sort(),
    reply: [...reply].filter((id) => levelOf(id) === "ALL").sort(),
  };
}

/**
 * The windowed-query param grammar (?before=<messageId>&take=<n>), shared by
 * GET …/messages: take clamps to [1, 100] and defaults to 100 on anything
 * non-numeric; before is a message-id anchor or null (= newest window).
 */
export function parseWindow(input: { before?: string | null; take?: string | null }): {
  before: string | null;
  take: number;
} {
  const rawTake = Number(input.take);
  const take =
    input.take != null && input.take !== "" && Number.isFinite(rawTake)
      ? Math.min(WINDOW_TAKE_MAX, Math.max(1, Math.floor(rawTake)))
      : WINDOW_TAKE_DEFAULT;
  const before = input.before && input.before.trim() ? input.before.trim() : null;
  return { before, take };
}
