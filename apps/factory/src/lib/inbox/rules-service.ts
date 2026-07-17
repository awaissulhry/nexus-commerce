/**
 * EPI3.2 — the ingest-rules service. Rules fire ONCE, at conversation
 * creation (first inbound), in explicit sortOrder, honoring stopProcessing —
 * never Missive's alphabetical wart. Matching reuses the views criteria
 * builder as a per-conversation SQL probe (one evaluator, no drift). Every
 * application is audited (`rule.applied`) and published durably (worker
 * context — open tabs refresh).
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { publishEventDurable } from "@/lib/events";
import { CriteriaSchema, RuleActionsSchema, criteriaWhere, type RuleAction } from "./views";

type LoadedRule = {
  id: string;
  name: string;
  stopProcessing: boolean;
  criteria: ReturnType<typeof CriteriaSchema.parse>;
  actions: RuleAction[];
};

async function loadEnabledRules(): Promise<LoadedRule[]> {
  const rows = await prisma.inboxRule.findMany({ where: { enabled: true }, orderBy: { sortOrder: "asc" }, take: 50 }); // bounded: rules are hand-authored config
  const rules: LoadedRule[] = [];
  for (const r of rows) {
    const criteria = CriteriaSchema.safeParse(r.criteria);
    const actions = RuleActionsSchema.safeParse(r.actions);
    if (criteria.success && actions.success) {
      rules.push({ id: r.id, name: r.name, stopProcessing: r.stopProcessing, criteria: criteria.data, actions: actions.data });
    }
  }
  return rules;
}

function actionData(actions: RuleAction[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const a of actions) {
    if (a.type === "assign") data.assigneeId = a.assigneeId;
    if (a.type === "close") {
      data.state = "CLOSED";
      data.snoozeUntil = null;
    }
  }
  return data;
}

/** worker hook: apply enabled rules to a freshly-created conversation */
export async function applyInboxRules(conversationId: string): Promise<number> {
  const rules = await loadEnabledRules();
  let applied = 0;
  for (const rule of rules) {
    const match = await prisma.conversation.findFirst({
      where: { AND: [{ id: conversationId }, criteriaWhere(rule.criteria)] },
      select: { id: true, subject: true },
    });
    if (!match) continue;
    const data = actionData(rule.actions);
    await prisma.conversation.update({ where: { id: conversationId }, data });
    void audit({
      entityType: "conversation",
      entityId: conversationId,
      action: "rule.applied",
      after: { rule: rule.name, ...data },
    });
    if (typeof data.assigneeId === "string") {
      await notify({
        userId: data.assigneeId,
        kind: "ASSIGNMENT",
        title: `Rule "${rule.name}" assigned you: ${match.subject ?? "(no subject)"}`,
        entityType: "conversation",
        entityId: conversationId,
        href: `/inbox?focus=${conversationId}`,
      });
    }
    applied++;
    if (rule.stopProcessing) break;
  }
  if (applied > 0) await publishEventDurable("conversation.updated", { rules: true, id: conversationId });
  return applied;
}

export type RuleRunRow = {
  id: string;
  subject: string | null;
  partyName: string | null;
  current: { assigneeId: string | null; state: string };
  after: Record<string, unknown>;
};

/** Run-now: dry-run diff over existing conversations, or apply a chosen subset */
export async function runRuleNow(
  ruleId: string,
  opts: { dryRun: boolean; ids?: string[]; actorId: string },
): Promise<{ rows: RuleRunRow[]; applied: number }> {
  const rule = await prisma.inboxRule.findUnique({ where: { id: ruleId } });
  if (!rule) throw new Error("Rule not found");
  const criteria = CriteriaSchema.parse(rule.criteria);
  const actions = RuleActionsSchema.parse(rule.actions);
  const data = actionData(actions);

  // only conversations the action would actually CHANGE (honest dry-run)
  const changeFilter: Record<string, unknown>[] = [];
  if (typeof data.assigneeId === "string") changeFilter.push({ NOT: { assigneeId: data.assigneeId } });
  if (data.state === "CLOSED") changeFilter.push({ NOT: { state: "CLOSED" } });

  const matches = await prisma.conversation.findMany({
    where: {
      AND: [
        criteriaWhere(criteria),
        ...(changeFilter.length ? [{ OR: changeFilter }] : []),
        ...(opts.ids?.length ? [{ id: { in: opts.ids } }] : []),
      ],
    },
    orderBy: { lastMessageAt: "desc" },
    take: 200, // bounded: Run-now page (mirrors bulk's 200 cap)
    select: { id: true, subject: true, assigneeId: true, state: true, party: { select: { name: true } } },
  });

  const rows: RuleRunRow[] = matches.map((m) => ({
    id: m.id,
    subject: m.subject,
    partyName: m.party?.name ?? null,
    current: { assigneeId: m.assigneeId, state: m.state },
    after: data,
  }));

  if (opts.dryRun) return { rows, applied: 0 };

  for (const row of rows) {
    await prisma.conversation.update({ where: { id: row.id }, data });
    void audit({
      actorId: opts.actorId,
      entityType: "conversation",
      entityId: row.id,
      action: "rule.applied",
      after: { rule: rule.name, via: "run-now", ...data },
    });
  }
  if (rows.length > 0) await publishEventDurable("conversation.updated", { rules: true, bulk: true });
  return { rows, applied: rows.length };
}
