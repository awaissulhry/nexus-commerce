/**
 * F1 — the ONE polymorphic comment service (F0 primitive; BEAT verdict on
 * Nexus's two disconnected pockets). Mentions are parsed from the body
 * (@email or @name-prefix), resolved against active users, and DELIVERED as
 * notifications — the exact gap Nexus never closed. Publishes on the bus.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { publishEvent } from "@/lib/events";
// FC3 — the grammar moved to a pure home so the chat UI's mention chips
// tokenize with the EXACT same regex (parity by construction); behavior here
// is unchanged and resolveMentions stays user-only (@all is chat-service's).
import { MENTION_RE_SOURCE } from "@/lib/chat/pure";

const MENTION_RE = new RegExp(MENTION_RE_SOURCE, "g");

export async function resolveMentions(body: string): Promise<{ id: string; displayName: string }[]> {
  const handles = [...body.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase());
  if (!handles.length) return [];
  const users = await prisma.user.findMany({
    where: { status: "active" },
    select: { id: true, email: true, displayName: true },
  });
  const hits = new Map<string, { id: string; displayName: string }>();
  for (const handle of handles) {
    for (const user of users) {
      const emailPrefix = user.email.split("@")[0].toLowerCase();
      if (
        user.email.toLowerCase() === handle ||
        emailPrefix === handle ||
        user.displayName.toLowerCase().replace(/\s+/g, ".") === handle ||
        user.displayName.toLowerCase().split(/\s+/)[0] === handle
      ) {
        hits.set(user.id, { id: user.id, displayName: user.displayName });
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
