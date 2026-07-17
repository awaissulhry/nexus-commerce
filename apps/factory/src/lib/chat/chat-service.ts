/**
 * FC1 — the ONLY sanctioned mutation path for Order Spaces chat (team-service
 * doctrine: guardrails first, then mutate; comments.ts precedent: audits live
 * INSIDE the service). Money discipline is structural — moneyCents is never
 * formatted into body text, and a body that smells of money is rejected when
 * moneyCents rides along (pure.ts owns the regex). Every mutation publishes
 * an FS2 event ("chat.message" / "chat.space") so FC2's shell goes live for
 * free. postSystemMessage is the FC5 entry: authorId null, kind SYSTEM.
 * FC3 — thread-scoped notifications (a reply pings ONLY participants +
 * followers + @mentioned, notifyLevel-filtered — the Google rule), explicit
 * audited @all expansion (resolveMentions stays user-only), auto-follow on
 * reply/direct-mention, and follow/unfollow toggles on ChatMember.followedThreads.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { resolveMentions } from "@/lib/comments";
import { publishEventDurable } from "@/lib/events";
import { OWNER_ROLE_KEY } from "@/lib/auth/permissions";
import {
  addFollowedThread,
  bodyCarriesMoney,
  bodyMentionsAll,
  buildOrderSpaceMembers,
  computeThreadAudience,
  orderSpaceName,
  parseFollowedThreads,
  removeFollowedThread,
  type ChatNotifyLevelName,
} from "./pure";

/**
 * FC3 — the NotificationKind for a non-mention thread-reply ping ("Marco
 * replied in a thread"). FLAGGED CHOICE: no existing kind fits — it is not a
 * MENTION (MENTION must stay trustworthy for mention-level filtering), not an
 * ASSIGNMENT/STATE_CHANGE/REMINDER. SYSTEM is the least-wrong generic bucket;
 * a proper THREAD_REPLY enum value is a one-line additive migration for a
 * later phase if kind-based filtering ever needs the distinction.
 */
const THREAD_REPLY_KIND = "SYSTEM" as const;

export type ChatErrorCode =
  | "not_found"
  | "not_member"
  | "forbidden"
  | "money_in_body"
  | "invalid";

export class ChatError extends Error {
  constructor(
    public code: ChatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

/** who is acting — routes pass actor.id + resolved.isOwner */
export type ChatActor = { id: string; isOwner: boolean };

const MAX_BODY = 5000;
const MAX_NAME = 80;

// ── guardrails ───────────────────────────────────────────────────

/** the cost-blind law: a body carrying structured money must not ALSO carry money in text */
function assertBodyMoneySafe(body: string, moneyCents: number | null | undefined): void {
  if (moneyCents != null && bodyCarriesMoney(body)) {
    throw new ChatError("money_in_body", "Money belongs in moneyCents, never in the message text");
  }
}

function assertBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > MAX_BODY) {
    throw new ChatError("invalid", `Message body must be 1–${MAX_BODY} characters`);
  }
  return trimmed;
}

async function requireSpace(spaceId: string) {
  const space = await prisma.chatSpace.findUnique({
    where: { id: spaceId },
    select: { id: true, kind: true, name: true, archivedAt: true },
  });
  if (!space) throw new ChatError("not_found", "Space not found");
  return space;
}

async function requireMembership(spaceId: string, userId: string) {
  const member = await prisma.chatMember.findUnique({
    where: { spaceId_userId: { spaceId, userId } },
    select: { id: true, role: true, lastReadMessageId: true, followedThreads: true },
  });
  if (!member) throw new ChatError("not_member", "Not a member of this space");
  return member;
}

/** add/remove members: space MANAGER or Owner (Owner needs no membership) */
async function assertCanManageMembers(spaceId: string, actor: ChatActor): Promise<void> {
  if (actor.isOwner) return;
  const member = await prisma.chatMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: actor.id } },
    select: { role: true },
  });
  if (member?.role !== "MANAGER") {
    throw new ChatError("forbidden", "Only a space manager or the Owner can manage members");
  }
}

// ── spaces ───────────────────────────────────────────────────────

/**
 * Idempotent order-space creation ("ORD-n · Party", active OWNER users join
 * as MANAGER). Called fire-and-forget from the two order-birth/activation
 * points (quote convert, start production) and safe to call again anytime —
 * the @@unique([entityType, entityId]) is the race arbiter.
 */
export async function ensureOrderSpace(orderId: string): Promise<{ id: string; created: boolean }> {
  const where = { entityType_entityId: { entityType: "order", entityId: orderId } };
  const existing = await prisma.chatSpace.findUnique({ where, select: { id: true } });
  if (existing) return { id: existing.id, created: false };

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, number: true, party: { select: { name: true } } },
  });
  if (!order) throw new ChatError("not_found", "Order not found");

  const owners = await prisma.user.findMany({
    // bounded: active OWNER users — a handful by construction (tiny team)
    where: { status: "active", roleAssignments: { some: { role: { key: OWNER_ROLE_KEY } } } },
    select: { id: true },
  });

  try {
    const space = await prisma.chatSpace.create({
      data: {
        kind: "ORDER",
        name: orderSpaceName(order.number, order.party.name),
        entityType: "order",
        entityId: orderId,
        members: { create: buildOrderSpaceMembers(owners.map((o) => o.id)) },
      },
      select: { id: true, name: true },
    });
    void audit({
      actorId: null,
      entityType: "chatSpace",
      entityId: space.id,
      action: "created",
      after: { kind: "ORDER", name: space.name, orderId, members: owners.length },
    });
    await publishEventDurable("chat.space", { spaceId: space.id });
    return { id: space.id, created: true };
  } catch (err) {
    // unique collision = a concurrent caller won the race; adopt their space
    const raced = await prisma.chatSpace.findUnique({ where, select: { id: true } });
    if (raced) return { id: raced.id, created: false };
    throw err;
  }
}

/** CUSTOM space (permission-gated at the route: chat.spaces.create). Creator joins as MANAGER. */
export async function createCustomSpace(input: {
  name: string;
  createdBy: ChatActor;
  memberIds?: string[];
}): Promise<{ id: string }> {
  const name = input.name.trim();
  if (!name || name.length > MAX_NAME) {
    throw new ChatError("invalid", `Space name must be 1–${MAX_NAME} characters`);
  }
  const extraIds = [...new Set(input.memberIds ?? [])].filter((id) => id !== input.createdBy.id);
  const extras = extraIds.length
    ? await prisma.user.findMany({
        // bounded: explicit member-id list (route caps it)
        where: { id: { in: extraIds }, status: "active" },
        select: { id: true },
      })
    : [];

  const space = await prisma.chatSpace.create({
    data: {
      kind: "CUSTOM",
      name,
      createdById: input.createdBy.id,
      members: {
        create: [
          { userId: input.createdBy.id, role: "MANAGER" },
          ...extras.map((u) => ({ userId: u.id, role: "MEMBER" as const })),
        ],
      },
    },
    select: { id: true },
  });
  void audit({
    actorId: input.createdBy.id,
    entityType: "chatSpace",
    entityId: space.id,
    action: "created",
    after: { kind: "CUSTOM", name, members: extras.length + 1 },
  });
  await publishEventDurable("chat.space", { spaceId: space.id });
  return space;
}

// ── membership ───────────────────────────────────────────────────

export async function addMember(
  spaceId: string,
  actor: ChatActor,
  userId: string,
  role: "MEMBER" | "MANAGER" = "MEMBER",
): Promise<void> {
  await requireSpace(spaceId);
  await assertCanManageMembers(spaceId, actor);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
  if (!user || user.status !== "active") throw new ChatError("not_found", "User not found or inactive");

  await prisma.chatMember.upsert({
    where: { spaceId_userId: { spaceId, userId } },
    create: { spaceId, userId, role },
    update: { role },
  });
  void audit({
    actorId: actor.id,
    entityType: "chatSpace",
    entityId: spaceId,
    action: "member.added",
    after: { userId, role },
  });
  await publishEventDurable("chat.space", { spaceId });
}

export async function removeMember(spaceId: string, actor: ChatActor, userId: string): Promise<void> {
  await requireSpace(spaceId);
  await assertCanManageMembers(spaceId, actor);
  const removed = await prisma.chatMember.deleteMany({ where: { spaceId, userId } });
  if (removed.count === 0) throw new ChatError("not_found", "Not a member");
  void audit({
    actorId: actor.id,
    entityType: "chatSpace",
    entityId: spaceId,
    action: "member.removed",
    after: { userId },
  });
  await publishEventDurable("chat.space", { spaceId });
}

// ── messages ─────────────────────────────────────────────────────

export async function postMessage(input: {
  spaceId: string;
  author: { id: string; displayName: string };
  body: string;
  threadRootId?: string | null;
  moneyCents?: number | null;
  moneyLabel?: string | null;
}): Promise<{ id: string }> {
  const space = await requireSpace(input.spaceId);
  if (space.archivedAt) throw new ChatError("invalid", "Space is archived");
  await requireMembership(input.spaceId, input.author.id);
  const body = assertBody(input.body);
  assertBodyMoneySafe(body, input.moneyCents);

  if (input.threadRootId) {
    const root = await prisma.chatMessage.findUnique({
      where: { id: input.threadRootId },
      select: { spaceId: true, threadRootId: true },
    });
    if (!root || root.spaceId !== input.spaceId) throw new ChatError("invalid", "Thread root not in this space");
    if (root.threadRootId) throw new ChatError("invalid", "Threads are one level deep — reply to the root");
  }

  const message = await prisma.chatMessage.create({
    data: {
      spaceId: input.spaceId,
      authorId: input.author.id,
      kind: "MESSAGE",
      body,
      threadRootId: input.threadRootId ?? null,
      moneyCents: input.moneyCents ?? null,
      moneyLabel: input.moneyLabel ?? null,
    },
    select: { id: true },
  });
  // FC2 — last-activity truth for the rail: posting bumps the space row, so
  // the bounded member's-spaces query (orderBy updatedAt desc) IS activity order
  await prisma.chatSpace.update({ where: { id: input.spaceId }, data: { updatedAt: new Date() } });

  // FC3 — resolve the notify audience (the Google rule, pure-tested):
  // mentions are user-only (resolveMentions); @all expands to the space's
  // members HERE, explicitly and audited; thread replies ping only
  // participants + followers + mentioned; notifyLevel filters everything.
  const mentions = await resolveMentions(body);
  const allMention = bodyMentionsAll(body);
  void audit({
    actorId: input.author.id,
    entityType: "chatMessage",
    entityId: message.id,
    action: "created",
    after: {
      spaceId: input.spaceId,
      threadRootId: input.threadRootId ?? null,
      ...(allMention ? { allMention: true } : {}),
    },
  });

  const needMembers = mentions.length > 0 || allMention || !!input.threadRootId;
  const members = needMembers
    ? await prisma.chatMember.findMany({
        where: { spaceId: input.spaceId },
        take: 500, // bounded: one space's membership (tiny team by construction)
        select: { userId: true, notifyLevel: true, followedThreads: true },
      })
    : [];
  const levels: Record<string, ChatNotifyLevelName> = {};
  for (const m of members) levels[m.userId] = m.notifyLevel;

  const directMentionIds = mentions.map((m) => m.id);
  const mentionedIds = new Set(directMentionIds);
  if (allMention) for (const m of members) mentionedIds.add(m.userId);

  let participantIds: string[] = [];
  let followerIds: string[] = [];
  if (input.threadRootId) {
    const participantRows = await prisma.chatMessage.findMany({
      where: {
        OR: [{ id: input.threadRootId }, { threadRootId: input.threadRootId }],
        deletedAt: null,
        authorId: { not: null },
      },
      distinct: ["authorId"],
      take: 500, // bounded: distinct thread authors ≤ space membership
      select: { authorId: true },
    });
    participantIds = participantRows.map((r) => r.authorId).filter((id): id is string => !!id);
    followerIds = members
      .filter((m) => parseFollowedThreads(m.followedThreads).includes(input.threadRootId!))
      .map((m) => m.userId);
  }

  const audience = computeThreadAudience({
    authorId: input.author.id,
    participantIds,
    followerIds,
    mentionedIds: [...mentionedIds],
    levels,
  });

  const href = input.threadRootId
    ? `/chat?space=${input.spaceId}&thread=${input.threadRootId}`
    : `/chat?space=${input.spaceId}`;
  const direct = new Set(directMentionIds);
  for (const userId of audience.mention) {
    await notify({
      userId,
      kind: "MENTION",
      title: direct.has(userId)
        ? `${input.author.displayName} mentioned you in ${space.name}`
        : `${input.author.displayName} mentioned everyone in ${space.name}`,
      body: body.slice(0, 140),
      entityType: "chatSpace",
      entityId: input.spaceId,
      href,
    });
  }
  for (const userId of audience.reply) {
    await notify({
      userId,
      kind: THREAD_REPLY_KIND,
      title: `${input.author.displayName} replied in a thread · ${space.name}`,
      body: body.slice(0, 140),
      entityType: "chatSpace",
      entityId: input.spaceId,
      href,
    });
  }

  // FC3 — auto-follow (the Google rule): replying to a thread follows it, and
  // so does being DIRECTLY @mentioned in one (@all never force-follows anyone)
  if (input.threadRootId) {
    const followTargets = new Set([input.author.id, ...directMentionIds]);
    for (const m of members) {
      if (!followTargets.has(m.userId)) continue;
      const list = parseFollowedThreads(m.followedThreads);
      const next = addFollowedThread(list, input.threadRootId);
      if (next === list) continue; // already following
      await prisma.chatMember.update({
        where: { spaceId_userId: { spaceId: input.spaceId, userId: m.userId } },
        data: { followedThreads: next },
      });
    }
  }

  await publishEventDurable("chat.message", { spaceId: input.spaceId, messageId: message.id });
  return message;
}

// ── FC3 — followed threads ───────────────────────────────────────

/** the follow/unfollow guardrail walk shared by both toggles */
async function requireThreadRoot(spaceId: string, rootId: string) {
  const root = await prisma.chatMessage.findUnique({
    where: { id: rootId },
    select: { id: true, spaceId: true, threadRootId: true },
  });
  if (!root || root.spaceId !== spaceId) throw new ChatError("not_found", "Thread not found in this space");
  if (root.threadRootId) throw new ChatError("invalid", "Threads are one level deep — follow the root message");
  return root;
}

/** Follow a thread (idempotent). Membership required; audited; rail refresh is scoped to the follower. */
export async function followThread(spaceId: string, userId: string, rootId: string): Promise<{ following: boolean }> {
  await requireSpace(spaceId);
  const member = await requireMembership(spaceId, userId);
  await requireThreadRoot(spaceId, rootId);

  const list = parseFollowedThreads(member.followedThreads);
  const next = addFollowedThread(list, rootId);
  if (next !== list) {
    await prisma.chatMember.update({
      where: { spaceId_userId: { spaceId, userId } },
      data: { followedThreads: next },
    });
    void audit({
      actorId: userId,
      entityType: "chatMessage",
      entityId: rootId,
      action: "thread.followed",
      after: { spaceId },
    });
    await publishEventDurable("chat.space", { spaceId }, { userId });
  }
  return { following: true };
}

/** Unfollow a thread (idempotent). */
export async function unfollowThread(spaceId: string, userId: string, rootId: string): Promise<{ following: boolean }> {
  await requireSpace(spaceId);
  const member = await requireMembership(spaceId, userId);
  await requireThreadRoot(spaceId, rootId);

  const list = parseFollowedThreads(member.followedThreads);
  const next = removeFollowedThread(list, rootId);
  if (next !== list) {
    await prisma.chatMember.update({
      where: { spaceId_userId: { spaceId, userId } },
      data: { followedThreads: next },
    });
    void audit({
      actorId: userId,
      entityType: "chatMessage",
      entityId: rootId,
      action: "thread.unfollowed",
      after: { spaceId },
    });
    await publishEventDurable("chat.space", { spaceId }, { userId });
  }
  return { following: false };
}

/**
 * System-authored feed entry (authorId null — the poll-tracking precedent).
 * FC5 (lifecycle messages via the FS2 bus) will be its only caller; money, if
 * any, rides ONLY in moneyCents and is client-formatted after the grain strip.
 */
export async function postSystemMessage(input: {
  spaceId: string;
  body: string;
  meta: { entityType: string; entityId: string; event: string };
  moneyCents?: number | null;
  moneyLabel?: string | null;
}): Promise<{ id: string }> {
  await requireSpace(input.spaceId);
  const body = assertBody(input.body);
  assertBodyMoneySafe(body, input.moneyCents);

  const message = await prisma.chatMessage.create({
    data: {
      spaceId: input.spaceId,
      authorId: null,
      kind: "SYSTEM",
      body,
      meta: input.meta,
      moneyCents: input.moneyCents ?? null,
      moneyLabel: input.moneyLabel ?? null,
    },
    select: { id: true },
  });
  // FC2 — system posts count as activity too (rail ordering, see postMessage)
  await prisma.chatSpace.update({ where: { id: input.spaceId }, data: { updatedAt: new Date() } });
  void audit({
    actorId: null,
    entityType: "chatMessage",
    entityId: message.id,
    action: "created",
    after: { spaceId: input.spaceId, kind: "SYSTEM", event: input.meta.event },
  });
  await publishEventDurable("chat.message", { spaceId: input.spaceId, messageId: message.id });
  return message;
}

/** author-only edit; audit keeps before/after body (soft-deleted messages stay dead) */
export async function editMessage(messageId: string, actorId: string, newBody: string): Promise<void> {
  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { id: true, spaceId: true, authorId: true, body: true, deletedAt: true, moneyCents: true },
  });
  if (!message || message.deletedAt) throw new ChatError("not_found", "Message not found");
  if (message.authorId !== actorId) throw new ChatError("forbidden", "Only the author can edit a message");
  const body = assertBody(newBody);
  assertBodyMoneySafe(body, message.moneyCents);

  await prisma.chatMessage.update({ where: { id: messageId }, data: { body, editedAt: new Date() } });
  void audit({
    actorId,
    entityType: "chatMessage",
    entityId: messageId,
    action: "edited",
    before: { body: message.body },
    after: { body },
  });
  await publishEventDurable("chat.message", { spaceId: message.spaceId, messageId });
}

/** author-only SOFT delete — the audit row keeps the truth (append-only law) */
export async function deleteMessage(messageId: string, actorId: string): Promise<void> {
  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { id: true, spaceId: true, authorId: true, body: true, deletedAt: true },
  });
  if (!message || message.deletedAt) throw new ChatError("not_found", "Message not found");
  if (message.authorId !== actorId) throw new ChatError("forbidden", "Only the author can delete a message");

  await prisma.chatMessage.update({ where: { id: messageId }, data: { deletedAt: new Date() } });
  void audit({
    actorId,
    entityType: "chatMessage",
    entityId: messageId,
    action: "deleted",
    before: { body: message.body },
  });
  await publishEventDurable("chat.message", { spaceId: message.spaceId, messageId });
}

// ── read cursors & reactions ─────────────────────────────────────

/** move the member's read cursor to a message in the space (unread math derives from it) */
export async function setReadCursor(spaceId: string, userId: string, messageId: string): Promise<void> {
  await requireMembership(spaceId, userId);
  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { spaceId: true },
  });
  if (!message || message.spaceId !== spaceId) throw new ChatError("not_found", "Message not in this space");

  await prisma.chatMember.update({
    where: { spaceId_userId: { spaceId, userId } },
    data: { lastReadMessageId: messageId },
  });
  // scoped: only the reader's own connections care (their unread badges)
  await publishEventDurable("chat.space", { spaceId }, { userId });
}

export async function react(messageId: string, userId: string, emoji: string): Promise<void> {
  const trimmed = emoji.trim();
  if (!trimmed || trimmed.length > 16) throw new ChatError("invalid", "Not an emoji");
  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { spaceId: true, deletedAt: true },
  });
  if (!message || message.deletedAt) throw new ChatError("not_found", "Message not found");
  await requireMembership(message.spaceId, userId);

  try {
    await prisma.chatReaction.create({ data: { messageId, userId, emoji: trimmed } });
  } catch {
    return; // unique collision — already reacted with this emoji; idempotent
  }
  await publishEventDurable("chat.message", { spaceId: message.spaceId, messageId });
}

export async function unreact(messageId: string, userId: string, emoji: string): Promise<void> {
  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { spaceId: true },
  });
  if (!message) throw new ChatError("not_found", "Message not found");
  const removed = await prisma.chatReaction.deleteMany({
    where: { messageId, userId, emoji: emoji.trim() },
  });
  if (removed.count === 0) return; // idempotent
  await publishEventDurable("chat.message", { spaceId: message.spaceId, messageId });
}
