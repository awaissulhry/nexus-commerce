/** FP3 — add a line to a DRAFT quote. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { addDraftQuoteLine } from "@/lib/quotes/create-draft";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.quotesCreate;

const Body = z.object({ templateId: z.string().nullable().optional(), description: z.string().max(300).optional() });

export const POST = guarded(FEATURES.quotesCreate, async (req, { params, actor }) => {
  const { id } = await params;
  // P12 — the write lives in src/lib/quotes/create-draft.ts (Claude's factory-draft-quote adds lines through it too).
  // A body that does not parse still adds an empty line, as before; a missing or non-draft quote is refused first.
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const added = await addDraftQuoteLine({
    quoteId: id,
    actorId: actor!.id,
    templateId: parsed.success ? parsed.data.templateId ?? null : null,
    description: parsed.success ? parsed.data.description : undefined,
  });
  if (!added.ok) return NextResponse.json({ error: added.error }, { status: added.status });
  return NextResponse.json({ line: added.line }, { status: 201 });
});
