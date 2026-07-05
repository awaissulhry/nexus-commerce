/**
 * FP1.2 — thread read + conversation mutations.
 * GET: lazily fetches missing bodies (gmail-body), returns messages +
 * comments + conversation audit entries for the ONE-timeline merge.
 * PATCH: assign / state / snooze / follow-up — audited; assignment notifies.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { publishEventDurable } from "@/lib/events";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES, PAGES } from "@/lib/auth/permissions";
import { ensureBodies } from "@/lib/google/gmail-body";

export const permission = { GET: PAGES.inbox, PATCH: FEATURES.inboxAssign };

export const GET = guarded(PAGES.inbox, async (_req, { params, resolved }) => {
  const { id } = await params;
  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: {
      party: { include: { emails: true, priceList: { select: { name: true } } } },
      assignee: { select: { id: true, displayName: true } },
    },
  });
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await ensureBodies(id).catch((err) =>
    console.error("[inbox] body fetch failed:", (err as Error).message),
  );

  const [messages, comments, events] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { sentAt: "asc" },
      include: {
        attachments: {
          select: { id: true, filename: true, mimeType: true, sizeBytes: true, driveFileId: true, webViewLink: true },
        },
      },
    }),
    prisma.comment.findMany({
      where: { entityType: "conversation", entityId: id },
      orderBy: { createdAt: "asc" },
      include: { author: { select: { displayName: true } } },
    }),
    prisma.auditLog.findMany({
      where: { entityType: "conversation", entityId: id },
      orderBy: { createdAt: "asc" },
      take: 200,
      select: { id: true, action: true, createdAt: true, after: true, actor: { select: { displayName: true } } },
    }),
  ]);

  // FP3: quotes born from this thread (the ContextRail "Linked" slot)
  const quoteRows = await prisma.quote.findMany({
    where: { conversationId: id },
    orderBy: { updatedAt: "desc" },
    include: { lines: { select: { netPriceCents: true, costCents: true, qty: true } } },
  });
  const quotes = quoteRows.map((q) => {
    const net = q.lines.reduce((s, l) => s + l.netPriceCents * l.qty, 0);
    const cost = q.lines.reduce((s, l) => s + l.costCents * l.qty, 0);
    return { id: q.id, number: q.number, state: q.state, netCents: net, marginCents: net - cost, convertedOrderId: q.convertedOrderId };
  });

  return jsonStripped({ conversation, messages, comments, events, quotes }, resolved);
});

const Patch = z.object({
  assigneeId: z.string().nullable().optional(),
  state: z.enum(["OPEN", "SNOOZED", "CLOSED"]).optional(),
  snoozeUntil: z.string().datetime().nullable().optional(),
  followUpAt: z.string().datetime().nullable().optional(),
});

export const PATCH = guarded(FEATURES.inboxAssign, async (req: NextRequest, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const input = parsed.data;

  const existing = await prisma.conversation.findUnique({
    where: { id },
    select: { id: true, subject: true, state: true, assigneeId: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId;
  if (input.followUpAt !== undefined) data.followUpAt = input.followUpAt ? new Date(input.followUpAt) : null;
  if (input.snoozeUntil !== undefined) {
    data.snoozeUntil = input.snoozeUntil ? new Date(input.snoozeUntil) : null;
    if (input.snoozeUntil) data.state = "SNOOZED";
  }
  if (input.state) {
    data.state = input.state;
    if (input.state !== "SNOOZED") data.snoozeUntil = null;
    if (input.state === "SNOOZED" && !data.snoozeUntil && input.snoozeUntil === undefined) {
      return NextResponse.json({ error: "Snoozing needs a wake date" }, { status: 400 });
    }
  }

  const updated = await prisma.conversation.update({
    where: { id },
    data,
    include: { assignee: { select: { id: true, displayName: true } } },
  });

  if (input.assigneeId !== undefined && input.assigneeId !== existing.assigneeId) {
    void audit({
      actorId: actor!.id, entityType: "conversation", entityId: id, action: "assigned",
      before: { assigneeId: existing.assigneeId }, after: { assigneeId: input.assigneeId },
    });
    if (input.assigneeId && input.assigneeId !== actor!.id) {
      await notify({
        userId: input.assigneeId,
        kind: "ASSIGNMENT",
        title: `${actor!.displayName} assigned you: ${existing.subject ?? "(no subject)"}`,
        entityType: "conversation", entityId: id, href: `/inbox?focus=${id}`,
      });
    }
  }
  if (data.state && data.state !== existing.state) {
    void audit({
      actorId: actor!.id, entityType: "conversation", entityId: id, action: "state.changed",
      before: { state: existing.state }, after: { state: data.state, snoozeUntil: data.snoozeUntil ?? null },
    });
  }
  if (input.followUpAt !== undefined) {
    void audit({
      actorId: actor!.id, entityType: "conversation", entityId: id,
      action: input.followUpAt ? "followup.set" : "followup.cleared",
      after: { followUpAt: input.followUpAt },
    });
  }

  await publishEventDurable("conversation.updated", { id });
  return jsonStripped({ conversation: updated }, resolved);
});
