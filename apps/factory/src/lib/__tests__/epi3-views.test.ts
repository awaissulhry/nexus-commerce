/** EPI3.1 — the views pure core: criterion shapes, all/any composition,
 * exclusive-claim precedence, overrides, the default-tab complement. */
import { describe, expect, it } from "vitest";
import {
  CriteriaSchema,
  RuleActionsSchema,
  criteriaWhere,
  criterionWhere,
  defaultTabWhere,
  viewListWhere,
  type Criteria,
  type OverrideLite,
  type ViewLite,
} from "@/lib/inbox/views";

const crit = (partial: object) => partial as Parameters<typeof criterionWhere>[0];
const view = (id: string, criteria: Criteria, opts: Partial<ViewLite> = {}): ViewLite => ({
  id,
  exclusive: true,
  showElsewhere: false,
  criteria,
  ...opts,
});
const domainC = (d: string): Criteria => ({ all: [{ field: "senderDomain", op: "is", value: d }], any: [] });

describe("criterionWhere", () => {
  it("sender domain strips @ and lowercases; sender email is/contains", () => {
    expect(criterionWhere(crit({ field: "senderDomain", op: "is", value: "@AWA.it" }))).toEqual({
      messages: { some: { direction: "INBOUND", fromAddress: { endsWith: "@awa.it" } } },
    });
    expect(criterionWhere(crit({ field: "senderEmail", op: "is", value: "A@B.c" }))).toEqual({
      messages: { some: { direction: "INBOUND", fromAddress: "a@b.c" } },
    });
  });
  it("attachment presence/extension and unmatched/assignee", () => {
    expect(criterionWhere(crit({ field: "hasAttachment", op: "is", value: true }))).toEqual({
      messages: { some: { attachments: { some: {} } } },
    });
    expect(criterionWhere(crit({ field: "attachmentExt", op: "is", value: ".PDF" }))).toEqual({
      messages: { some: { attachments: { some: { filename: { endsWith: ".pdf" } } } } },
    });
    expect(criterionWhere(crit({ field: "unmatched", op: "is", value: true }))).toEqual({ partyId: null });
    expect(criterionWhere(crit({ field: "assigneeId", op: "is", value: null }))).toEqual({ assigneeId: null });
  });
});

describe("criteriaWhere", () => {
  it("ALL clauses AND together; ANY becomes one OR clause", () => {
    const w = criteriaWhere({
      all: [{ field: "partyKind", op: "is", value: "BRAND" }],
      any: [
        { field: "subject", op: "contains", value: "order" },
        { field: "subject", op: "contains", value: "ordine" },
      ],
    });
    expect(w).toEqual({
      AND: [
        { party: { kind: "BRAND" } },
        { OR: [{ subject: { contains: "order" } }, { subject: { contains: "ordine" } }] },
      ],
    });
  });
  it("empty criteria match NOTHING (a view must say something)", () => {
    expect(criteriaWhere({ all: [], any: [] })).toEqual({ id: "__matches-nothing__" });
  });
  it("schema defaults arrays and refuses junk", () => {
    expect(CriteriaSchema.parse({})).toEqual({ all: [], any: [] });
    expect(CriteriaSchema.safeParse({ all: [{ field: "nope" }] }).success).toBe(false);
    expect(RuleActionsSchema.safeParse([{ type: "assign", assigneeId: "u1" }]).success).toBe(true);
    expect(RuleActionsSchema.safeParse([]).success).toBe(false);
  });
});

describe("viewListWhere — claim order + overrides", () => {
  const v1 = view("v1", domainC("awa.it"));
  const v2 = view("v2", domainC("brand2.it"));
  it("a later view subtracts EARLIER exclusive views' matches", () => {
    const w = viewListWhere(v2, [v1, v2], []);
    expect(w).toEqual({
      AND: [criteriaWhere(v2.criteria), { NOT: criteriaWhere(v1.criteria) }],
    });
  });
  it("the first view subtracts nothing", () => {
    expect(viewListWhere(v1, [v1, v2], [])).toEqual(criteriaWhere(v1.criteria));
  });
  it("pins add via OR; excludes subtract; pins to EARLIER views subtract here", () => {
    const overrides: OverrideLite[] = [
      { viewId: "v2", conversationId: "cPin", mode: "pin" },
      { viewId: "v2", conversationId: "cEx", mode: "exclude" },
      { viewId: "v1", conversationId: "cStolen", mode: "pin" },
    ];
    const w = viewListWhere(v2, [v1, v2], overrides) as { OR: unknown[] };
    expect(w.OR[1]).toEqual({ id: { in: ["cPin"] } });
    expect(w.OR[0]).toEqual({
      AND: [
        criteriaWhere(v2.criteria),
        { NOT: criteriaWhere(v1.criteria) },
        { id: { notIn: ["cEx"] } },
        { id: { notIn: ["cStolen"] } },
      ],
    });
  });
  it("non-exclusive earlier views don't claim", () => {
    const soft = view("soft", domainC("x.it"), { exclusive: false });
    expect(viewListWhere(v2, [soft, v2], [])).toEqual(criteriaWhere(v2.criteria));
  });
});

describe("defaultTabWhere — the Inbox complement", () => {
  const v1 = view("v1", domainC("awa.it"));
  it("subtracts every claiming view; showElsewhere views don't claim", () => {
    const shown = view("shown", domainC("y.it"), { showElsewhere: true });
    expect(defaultTabWhere([v1, shown], [])).toEqual({ NOT: criteriaWhere(v1.criteria) });
  });
  it("no exclusive views → no constraint", () => {
    expect(defaultTabWhere([view("s", domainC("z.it"), { exclusive: false })], [])).toEqual({});
  });
  it("pins to a claiming view leave the Inbox; excludes come back", () => {
    const overrides: OverrideLite[] = [
      { viewId: "v1", conversationId: "cPin", mode: "pin" },
      { viewId: "v1", conversationId: "cEx", mode: "exclude" },
    ];
    expect(defaultTabWhere([v1], overrides)).toEqual({
      OR: [
        { AND: [{ NOT: criteriaWhere(v1.criteria) }, { id: { notIn: ["cPin"] } }] },
        { id: { in: ["cEx"] } },
      ],
    });
  });
});
