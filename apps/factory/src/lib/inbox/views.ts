/**
 * EPI3.1 — pure core of query-backed inbox views. A view IS its criteria:
 * membership is computed per request through these where-builders, so routing
 * is automatic and retroactive by construction. Precedence law (Superhuman):
 * tab order = claim priority for exclusive views; overrides (pin/exclude)
 * always beat criteria. The same Criteria shape drives the ingest rules.
 */
import { z } from "zod";

export const CriterionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("senderEmail"), op: z.enum(["contains", "is"]), value: z.string().min(1) }),
  z.object({ field: z.literal("senderDomain"), op: z.literal("is"), value: z.string().min(1) }),
  z.object({ field: z.literal("subject"), op: z.literal("contains"), value: z.string().min(1) }),
  z.object({ field: z.literal("body"), op: z.literal("contains"), value: z.string().min(1) }),
  z.object({ field: z.literal("partyId"), op: z.literal("is"), value: z.string().min(1) }),
  z.object({ field: z.literal("partyKind"), op: z.literal("is"), value: z.enum(["CUSTOMER", "BRAND", "SUPPLIER"]) }),
  z.object({ field: z.literal("hasAttachment"), op: z.literal("is"), value: z.boolean() }),
  z.object({ field: z.literal("attachmentExt"), op: z.literal("is"), value: z.string().min(1) }),
  z.object({ field: z.literal("unmatched"), op: z.literal("is"), value: z.boolean() }),
  z.object({ field: z.literal("assigneeId"), op: z.literal("is"), value: z.string().nullable() }),
]);
export type Criterion = z.infer<typeof CriterionSchema>;

export const CriteriaSchema = z.object({
  all: z.array(CriterionSchema).max(10).default([]),
  any: z.array(CriterionSchema).max(10).default([]),
});
export type Criteria = z.infer<typeof CriteriaSchema>;

export const RuleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("assign"), assigneeId: z.string().min(1) }),
  z.object({ type: z.literal("close") }),
]);
export type RuleAction = z.infer<typeof RuleActionSchema>;
export const RuleActionsSchema = z.array(RuleActionSchema).min(1).max(5);

type Where = Record<string, unknown>;

export function criterionWhere(c: Criterion): Where {
  switch (c.field) {
    case "senderEmail":
      return {
        messages: {
          some: {
            direction: "INBOUND",
            fromAddress: c.op === "is" ? c.value.toLowerCase() : { contains: c.value.toLowerCase() },
          },
        },
      };
    case "senderDomain": {
      const domain = c.value.replace(/^@/, "").toLowerCase();
      return { messages: { some: { direction: "INBOUND", fromAddress: { endsWith: `@${domain}` } } } };
    }
    case "subject":
      return { subject: { contains: c.value } };
    case "body":
      return { messages: { some: { OR: [{ snippet: { contains: c.value } }, { bodyText: { contains: c.value } }] } } };
    case "partyId":
      return { partyId: c.value };
    case "partyKind":
      return { party: { kind: c.value } };
    case "hasAttachment":
      return c.value
        ? { messages: { some: { attachments: { some: {} } } } }
        : { messages: { none: { attachments: { some: {} } } } };
    case "attachmentExt": {
      const ext = c.value.replace(/^\./, "").toLowerCase();
      return { messages: { some: { attachments: { some: { filename: { endsWith: `.${ext}` } } } } } };
    }
    case "unmatched":
      return c.value ? { partyId: null } : { partyId: { not: null } };
    case "assigneeId":
      return { assigneeId: c.value };
  }
}

/** empty criteria match NOTHING — a view must say something */
export function criteriaWhere(criteria: Criteria): Where {
  const clauses: Where[] = criteria.all.map(criterionWhere);
  if (criteria.any.length > 0) clauses.push({ OR: criteria.any.map(criterionWhere) });
  if (clauses.length === 0) return { id: "__matches-nothing__" };
  return clauses.length === 1 ? clauses[0] : { AND: clauses };
}

export type ViewLite = { id: string; exclusive: boolean; showElsewhere: boolean; criteria: Criteria };
export type OverrideLite = { viewId: string; conversationId: string; mode: string };

/** membership where for one view, honoring earlier exclusive claims + overrides */
export function viewListWhere(view: ViewLite, viewsInOrder: ViewLite[], overrides: OverrideLite[]): Where {
  const idx = viewsInOrder.findIndex((v) => v.id === view.id);
  const earlierExclusive = viewsInOrder.slice(0, Math.max(idx, 0)).filter((v) => v.exclusive);
  const pinnedHere = overrides.filter((o) => o.viewId === view.id && o.mode === "pin").map((o) => o.conversationId);
  const excludedHere = overrides.filter((o) => o.viewId === view.id && o.mode === "exclude").map((o) => o.conversationId);
  const pinnedEarlier = overrides
    .filter((o) => o.mode === "pin" && earlierExclusive.some((v) => v.id === o.viewId))
    .map((o) => o.conversationId);

  const clauses: Where[] = [criteriaWhere(view.criteria), ...earlierExclusive.map((v) => ({ NOT: criteriaWhere(v.criteria) }))];
  if (excludedHere.length) clauses.push({ id: { notIn: excludedHere } });
  if (pinnedEarlier.length) clauses.push({ id: { notIn: pinnedEarlier } });
  const match: Where = clauses.length === 1 ? clauses[0] : { AND: clauses };
  return pinnedHere.length ? { OR: [match, { id: { in: pinnedHere } }] } : match;
}

/** the plain Inbox tab: everything not claimed by an exclusive view */
export function defaultTabWhere(viewsInOrder: ViewLite[], overrides: OverrideLite[]): Where {
  const claiming = viewsInOrder.filter((v) => v.exclusive && !v.showElsewhere);
  if (claiming.length === 0) return {};
  const pinnedToClaiming = overrides
    .filter((o) => o.mode === "pin" && claiming.some((v) => v.id === o.viewId))
    .map((o) => o.conversationId);
  const excludedFromClaiming = overrides
    .filter((o) => o.mode === "exclude" && claiming.some((v) => v.id === o.viewId))
    .map((o) => o.conversationId);

  const clauses: Where[] = claiming.map((v) => ({ NOT: criteriaWhere(v.criteria) }));
  if (pinnedToClaiming.length) clauses.push({ id: { notIn: pinnedToClaiming } });
  const base: Where = clauses.length === 1 ? clauses[0] : { AND: clauses };
  // an exclude on a claiming view returns the conversation to the Inbox
  return excludedFromClaiming.length ? { OR: [base, { id: { in: excludedFromClaiming } }] } : base;
}
