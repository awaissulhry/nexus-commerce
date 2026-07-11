/** FP1.2 — active users for assignee pickers + @mention autocomplete. */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.commentsCreate;

export const GET = guarded(FEATURES.commentsCreate, async () => {
  const users = await prisma.user.findMany({ // bounded: active users ≈ team size; paged combobox lands in FS3 (S-16)
    where: { status: "active" },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true, email: true },
  });
  return NextResponse.json({ users });
});
