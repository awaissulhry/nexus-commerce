/**
 * F1 — the ONE polymorphic comment service (F0 primitive; BEAT verdict on
 * Nexus's two disconnected pockets). Mentions are parsed from the body
 * (@email or @name-prefix), resolved against active users, and DELIVERED as
 * notifications — the exact gap Nexus never closed. Publishes on the bus.
 * FS4 (S-10) — resolveMentions no longer scans every user per call: the
 * parsed handles hit indexed lookups (User.handle · email · email-prefix) in
 * ONE query; the legacy display-name scan survives ONLY as a bounded
 * per-handle fallback (typo/first-name tolerance, and the pre-migration
 * window before fs4_user_handle backfills).
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { publishEvent } from "@/lib/events";
// FC3 — the grammar moved to a pure home so the chat UI's mention chips
// tokenize with the EXACT same regex (parity by construction); behavior here
// is unchanged and resolveMentions stays user-only (@all is chat-service's).
import { MENTION_RE_SOURCE } from "@/lib/chat/pure";

const MENTION_RE = new RegExp(MENTION_RE_SOURCE, "g"); // FC3 — single grammar, shared with chat
const LEGACY_SCAN_TAKE = 500; // bounded: fallback only — active users, name-ordered (FS4)

type Mention = { id: string; displayName: string };
type UserRow = { id: string; email: string; displayName: string; handle?: string | null };

/** The legacy matching rules, per handle (email · email-prefix · dotted name · first name). */
function legacyMatches(handle: string, user: UserRow): boolean {
  const emailPrefix = user.email.split("@")[0].toLowerCase();
  return (
    user.email.toLowerCase() === handle ||
    emailPrefix === handle ||
    user.displayName.toLowerCase().replace(/\s+/g, ".") === handle ||
    user.displayName.toLowerCase().split(/\s+/)[0] === handle
  );
}

export async function resolveMentions(body: string): Promise<Mention[]> {
  const handles = [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()))];
  if (!handles.length) return [];
  const hits = new Map<string, Mention>();
  const unmatched: string[] = [];

  // indexed pass — one query over the three exact shapes
  try {
    const emailish = handles.filter((h) => h.includes("@"));
    const plain = handles.filter((h) => !h.includes("@"));
    const users: UserRow[] = await prisma.user.findMany({
      where: {
        status: "active",
        OR: [
          ...(plain.length ? [{ handle: { in: plain } }] : []),
          ...(emailish.length ? [{ email: { in: emailish } }] : []),
          ...plain.map((h) => ({ email: { startsWith: `${h}@` } })),
        ],
      },
      select: { id: true, email: true, displayName: true, handle: true },
      take: 200, // bounded: at most a handful of exact matches per handle
    });
    for (const handle of handles) {
      let found = false;
      for (const u of users) {
        const prefix = u.email.split("@")[0].toLowerCase();
        if (u.handle === handle || u.email.toLowerCase() === handle || prefix === handle) {
          hits.set(u.id, { id: u.id, displayName: u.displayName });
          found = true;
        }
      }
      if (!found) unmatched.push(handle);
    }
  } catch {
    // pre-migration: the handle column does not exist yet — everything falls back
    unmatched.push(...handles);
  }

  // legacy fallback — ONLY for handles the indexed pass missed
  if (unmatched.length) {
    const users: UserRow[] = await prisma.user.findMany({
      where: { status: "active" },
      select: { id: true, email: true, displayName: true },
      orderBy: { displayName: "asc" },
      take: LEGACY_SCAN_TAKE, // bounded: fallback path, team-sized in practice
    });
    for (const handle of unmatched) {
      for (const u of users) {
        if (legacyMatches(handle, u)) hits.set(u.id, { id: u.id, displayName: u.displayName });
      }
    }
  }
  return [...hits.values()];
}

export async function createComment(input: {
  entityType: string;
  entityId: string;
  body: string;
  authorId: string;
  authorName: string;
  href?: string;
}) {
  const mentions = await resolveMentions(input.body);
  const comment = await prisma.comment.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      authorId: input.authorId,
      body: input.body,
      mentions: mentions.map((m) => m.id),
    },
  });
  void audit({
    actorId: input.authorId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: "comment.created",
    after: { commentId: comment.id },
  });
  for (const mention of mentions) {
    if (mention.id === input.authorId) continue;
    await notify({
      userId: mention.id,
      kind: "MENTION",
      title: `${input.authorName} mentioned you`,
      body: input.body.slice(0, 140),
      entityType: input.entityType,
      entityId: input.entityId,
      href: input.href,
    });
  }
  publishEvent("comment.created", { entityType: input.entityType, entityId: input.entityId });
  return comment;
}
