/**
 * P11 — Settings › Integrations › Claude: the OWNER's list of Claude connections (never their secret) and the
 * creation of a new one, whose token is in the answer ONCE. A connection runs as one active person: Claude reads and
 * drafts with that person's roles (a WORKER's connection sees no money). Only an OWNER may create or revoke one.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES, OWNER_ROLE_KEY } from "@/lib/auth/permissions";
import { AccessTokenInputError, createAccessToken, listAccessTokens } from "@/lib/claude/tokens";
import { MAX_TOKEN_DAYS, SCOPE_SETS } from "@/lib/claude/core";

export const permission = FEATURES.integrationsManage;

const ownerOnly = () =>
  NextResponse.json({ error: "Only an owner can manage Claude connections.", code: "owner_required" }, { status: 403 });

export const GET = guarded(FEATURES.integrationsManage, async (_req, { actor }) => {
  if (!actor!.roleKeys.includes(OWNER_ROLE_KEY)) return ownerOnly();
  const people = await prisma.user.findMany({ // bounded: the factory's team, a handful of people
    where: { status: "active" },
    select: { id: true, displayName: true },
    orderBy: { displayName: "asc" },
    take: 200,
  });
  return NextResponse.json({ tokens: await listAccessTokens(), people, maxDays: MAX_TOKEN_DAYS });
});

const Body = z.object({
  label: z.string().trim().min(1).max(80),
  userId: z.string().min(1),
  scopes: z.enum(SCOPE_SETS),
  days: z.number().int().min(1).max(MAX_TOKEN_DAYS),
});

export const POST = guarded(FEATURES.integrationsManage, async (req, { actor }) => {
  if (!actor!.roleKeys.includes(OWNER_ROLE_KEY)) return ownerOnly();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Name the connection, choose who it acts as, what it may do and for how many days (1–90)." }, { status: 400 });
  }
  try {
    const { token, raw } = await createAccessToken({ ownerId: actor!.id, ...parsed.data });
    return NextResponse.json({ token, raw }, { status: 201 });
  } catch (error) {
    if (error instanceof AccessTokenInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
});
