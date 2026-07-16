/**
 * EPQ.2 — the follow-up nudge. GET renders the per-rule Italian template
 * (placeholders filled from the quote) for the preview-before-send modal;
 * POST sends the (Owner-edited) text threaded into the same Gmail
 * conversation via the shared plumbing (src/lib/quotes/mail.ts) — a short
 * reply that REFERENCES the original offer, deliberately without the PDF and
 * WITHOUT freezing a version (nothing about the offer changed). On success:
 * OUTBOUND Message + conversation bump (in the helper), Quote.lastNudgeAt set
 * + followUpRule cleared (the quote leaves the queue), audit 'nudged' {rule},
 * durable pricing.updated + conversation.updated.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { sendQuoteMail } from "@/lib/quotes/mail";
import { renderNudgeTemplate, FOLLOW_UP_RULES, type FollowUpRule } from "@/lib/quotes/followup";
import { loadFollowUpSettings } from "@/lib/quotes/followup-settings";

export const permission = FEATURES.quotesSend;

const dmy = (d: Date | null) => (d ? d.toLocaleDateString("it-IT") : "—");

async function renderForQuote(id: string, rule: FollowUpRule) {
  const quote = await prisma.quote.findUnique({
    where: { id },
    select: {
      id: true, number: true, state: true, sentAt: true, validUntilAt: true,
      party: { select: { name: true, emails: { take: 1, select: { email: true } } } },
      conversation: { select: { id: true, subject: true, gmailThreadId: true } },
    },
  });
  if (!quote) return { ok: false as const, res: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (quote.state !== "SENT") {
    return { ok: false as const, res: NextResponse.json({ error: `A ${quote.state.toLowerCase()} quote doesn't take a follow-up — only sent quotes do` }, { status: 400 }) };
  }
  const settings = await loadFollowUpSettings();
  const text = renderNudgeTemplate(settings.templates[rule], {
    party: quote.party.name,
    number: quote.number,
    sentDate: dmy(quote.sentAt),
    validUntil: dmy(quote.validUntilAt),
  });
  return { ok: true as const, quote, text };
}

const RuleParam = z.enum(FOLLOW_UP_RULES as [FollowUpRule, ...FollowUpRule[]]);

/** Preview: the rendered Italian text the Owner can edit before sending. */
export const GET = guarded(FEATURES.quotesSend, async (req, { params }) => {
  const { id } = await params;
  const parsedRule = RuleParam.safeParse(req.nextUrl.searchParams.get("rule"));
  if (!parsedRule.success) return NextResponse.json({ error: "Unknown follow-up rule" }, { status: 400 });
  const r = await renderForQuote(id, parsedRule.data);
  if (!r.ok) return r.res;
  return NextResponse.json({ rule: parsedRule.data, text: r.text });
});

const Body = z.object({ rule: RuleParam, text: z.string().max(4000).optional() });

export const POST = guarded(FEATURES.quotesSend, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const r = await renderForQuote(id, parsed.data.rule);
  if (!r.ok) return r.res;
  const { quote } = r;
  const text = parsed.data.text?.trim() || r.text;

  const mail = await sendQuoteMail({
    conversation: quote.conversation,
    partyEmail: quote.party.emails[0]?.email ?? null,
    fallbackSubject: `Preventivo ${quote.number}`,
    text,
    snippet: `Promemoria preventivo ${quote.number}`,
    // no attachments by design: the nudge references the original email's PDF
  });
  if (!mail.ok) return NextResponse.json({ error: mail.error }, { status: mail.status });

  // the nudge answers the flag: out of the queue, dedupe clock starts
  await prisma.quote.update({ where: { id }, data: { lastNudgeAt: mail.sentAt, followUpRule: null } });
  void audit({ actorId: actor!.id, entityType: "quote", entityId: id, action: "nudged", after: { rule: parsed.data.rule, to: mail.recipient } });
  await publishEventDurable("pricing.updated", { quoteId: id });
  await publishEventDurable("conversation.updated", { id: quote.conversation?.id });
  return NextResponse.json({ ok: true, recipient: mail.recipient });
});
