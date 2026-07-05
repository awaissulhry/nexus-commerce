/**
 * F1 — comments on ANY entity: GET ?entityType=&entityId= list, POST create
 * (⌘+Enter composers call this). Mentions fan out as notifications.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { createComment } from "@/lib/comments";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.commentsCreate;

export const GET = guarded(FEATURES.commentsCreate, async (req: NextRequest) => {
  const entityType = req.nextUrl.searchParams.get("entityType");
  const entityId = req.nextUrl.searchParams.get("entityId");
  if (!entityType || !entityId) {
    return NextResponse.json({ error: "entityType and entityId required" }, { status: 400 });
  }
  const items = await prisma.comment.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: "asc" },
    include: { author: { select: { displayName: true, email: true } } },
  });
  return NextResponse.json({ items });
});

const Body = z.object({
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  body: z.string().min(1).max(5000),
  href: z.string().optional(),
});

export const POST = guarded(FEATURES.commentsCreate, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const comment = await createComment({
    ...parsed.data,
    authorId: actor!.id,
    authorName: actor!.displayName,
  });
  return NextResponse.json({ comment }, { status: 201 });
});
