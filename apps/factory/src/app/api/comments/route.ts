/**
 * F1 — comments on ANY entity: GET ?entityType=&entityId= list, POST create
 * (⌘+Enter composers call this). Mentions fan out as notifications.
 * EPI2.4 — POST also accepts multipart/form-data with `files` so internal
 * comments can carry attachments (FP1 deferral): bytes land locally under
 * data/attachments/comment-<id>/, rows use the polymorphic Attachment host
 * (entityType "comment" — no schema change), 15MB total cap like replies.
 */
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { createComment } from "@/lib/comments";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.commentsCreate;

const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

export const GET = guarded(FEATURES.commentsCreate, async (req: NextRequest) => {
  const entityType = req.nextUrl.searchParams.get("entityType");
  const entityId = req.nextUrl.searchParams.get("entityId");
  if (!entityType || !entityId) {
    return NextResponse.json({ error: "entityType and entityId required" }, { status: 400 });
  }
  const items = await prisma.comment.findMany({ // bounded: per-entity comment thread; windowed in FS3
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
  let raw: unknown;
  let files: File[] = [];
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await req.formData();
    raw = {
      entityType: form.get("entityType")?.toString(),
      entityId: form.get("entityId")?.toString(),
      body: form.get("body")?.toString(),
      href: form.get("href")?.toString() || undefined,
    };
    files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total > MAX_TOTAL_BYTES) {
      return NextResponse.json({ error: "Attachments exceed 15MB — share big files via Drive instead" }, { status: 413 });
    }
  } else {
    raw = await req.json().catch(() => null);
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const comment = await createComment({
    ...parsed.data,
    authorId: actor!.id,
    authorName: actor!.displayName,
  });

  for (const f of files) {
    const att = await prisma.attachment.create({
      data: {
        entityType: "comment",
        entityId: comment.id,
        filename: f.name,
        mimeType: f.type || "application/octet-stream",
        sizeBytes: f.size,
      },
    });
    const dir = path.join(process.cwd(), "data", "attachments", `comment-${comment.id}`);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${att.id}-${f.name.replace(/[/\\]/g, "_")}`);
    fs.writeFileSync(filePath, Buffer.from(await f.arrayBuffer()));
    await prisma.attachment.update({ where: { id: att.id }, data: { localPath: filePath } });
  }

  return NextResponse.json({ comment }, { status: 201 });
});
