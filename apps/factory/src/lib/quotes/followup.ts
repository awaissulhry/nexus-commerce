/**
 * EPQ.2 — the follow-up engine's pure core: cadence due-math (which rule is
 * due for a SENT quote), the flag/keep/clear decision with its dedupe and
 * snooze boundaries, the Italian nudge templates + renderer, and the pipeline
 * "viewed" cell format. Pure by design — the worker tick, the routes, and the
 * client all consume THIS module, and the unit tests pin every boundary.
 *
 * Column semantics (Quote):
 *   followUpRule      — the rule currently flagged (row is in the queue), or null
 *   followUpFlaggedAt — when it was flagged/actioned; a FUTURE value = snoozed
 *                       until then; a FRESH past value (within the rule's own
 *                       cadence window) suppresses re-notification (dismiss dedupe)
 *   lastNudgeAt       — last follow-up email; fresh = the quote leaves the queue
 */

export type FollowUpRule = "unviewed" | "viewed-silent" | "pre-expiry";

export type CadenceConfig = { unviewedDays: number; viewedDays: number; preExpiryDays: number };

/** Owner-editable via the gear popover on the queue card (AppSetting quotes.followup). */
export const CADENCE_DEFAULTS: CadenceConfig = { unviewedDays: 3, viewedDays: 7, preExpiryDays: 3 };

export const FOLLOW_UP_RULES: FollowUpRule[] = ["unviewed", "viewed-silent", "pre-expiry"];

/** Chip copy on the queue card. */
export const FOLLOW_UP_RULE_LABEL: Record<FollowUpRule, string> = {
  unviewed: "not viewed",
  "viewed-silent": "viewed, silent",
  "pre-expiry": "expiring",
};

const DAY_MS = 86_400_000;

/** Each rule's own cadence window — also the dedupe/re-notify freshness window. */
export function ruleWindowDays(rule: FollowUpRule, cfg: CadenceConfig): number {
  return rule === "unviewed" ? cfg.unviewedDays : rule === "viewed-silent" ? cfg.viewedDays : cfg.preExpiryDays;
}

export type FollowUpQuoteState = {
  state: string;
  sentAt: Date | null;
  viewCount: number;
  lastViewedAt: Date | null;
  validUntilAt: Date | null;
  lastNudgeAt: Date | null;
  followUpRule: string | null;
  followUpFlaggedAt: Date | null;
};

/**
 * Which rule is due for this quote right now (null = none). SENT only — the
 * expiry sweep owns lapsed quotes, decisions own the rest. Priority when
 * several hold: pre-expiry (a deadline) > viewed-silent > unviewed.
 * Boundaries are inclusive: due at EXACTLY N days.
 */
export function dueRule(q: FollowUpQuoteState, cfg: CadenceConfig, now: Date): FollowUpRule | null {
  if (q.state !== "SENT") return null;
  const t = now.getTime();
  // (c) validity ends within the window (but hasn't lapsed — that's EXPIRED's job)
  if (q.validUntilAt && q.validUntilAt.getTime() > t && q.validUntilAt.getTime() <= t + cfg.preExpiryDays * DAY_MS) {
    return "pre-expiry";
  }
  // (b) viewed, but no decision for M days after the LAST view
  if (q.viewCount > 0 && q.lastViewedAt && t - q.lastViewedAt.getTime() >= cfg.viewedDays * DAY_MS) {
    return "viewed-silent";
  }
  // (a) sent N days ago, never viewed, and no nudge since the (first) send
  if (
    q.viewCount === 0 &&
    q.sentAt &&
    t - q.sentAt.getTime() >= cfg.unviewedDays * DAY_MS &&
    (!q.lastNudgeAt || q.lastNudgeAt.getTime() < q.sentAt.getTime())
  ) {
    return "unviewed";
  }
  return null;
}

export type FollowUpDecision =
  | { kind: "flag"; rule: FollowUpRule } // write rule + flaggedAt=now, notify ONCE
  | { kind: "keep" } // already flagged (or snoozed) — in/awaiting the queue, no write
  | { kind: "clear" } // no longer due — take it out of the queue
  | { kind: "none" }; // nothing due, nothing flagged

/**
 * The worker's per-quote decision. Dedupe boundaries, in order:
 *  1. nothing due → clear any stale flag;
 *  2. snoozed (flaggedAt in the FUTURE) → keep silently until it lapses;
 *  3. nudged within the rule's window → the nudge answered it: leave the queue;
 *  4. same rule already flagged & fresh → keep (no re-notification);
 *     …flag gone stale → re-flag (re-notify: "no offer dies of silence");
 *  5. dismissed recently (no rule, fresh flaggedAt) → suppressed for the window;
 *  6. otherwise → flag (first time, or the due rule changed — an upgrade rings).
 */
export function followUpDecision(q: FollowUpQuoteState, cfg: CadenceConfig, now: Date): FollowUpDecision {
  const rule = dueRule(q, cfg, now);
  const flagged = q.followUpRule != null;
  if (!rule) return flagged ? { kind: "clear" } : { kind: "none" };
  if (q.followUpFlaggedAt && q.followUpFlaggedAt.getTime() > now.getTime()) return { kind: "keep" }; // snoozed
  const windowMs = ruleWindowDays(rule, cfg) * DAY_MS;
  if (q.lastNudgeAt && now.getTime() - q.lastNudgeAt.getTime() < windowMs) {
    return flagged ? { kind: "clear" } : { kind: "none" };
  }
  const flagFresh = q.followUpFlaggedAt != null && now.getTime() - q.followUpFlaggedAt.getTime() < windowMs;
  if (q.followUpRule === rule) return flagFresh ? { kind: "keep" } : { kind: "flag", rule };
  if (!flagged && flagFresh) return { kind: "none" }; // recently dismissed
  return { kind: "flag", rule };
}

/** Whole days of rule-relevant age — the "days" figure on the queue row. */
export function ruleDays(rule: FollowUpRule, q: Pick<FollowUpQuoteState, "sentAt" | "lastViewedAt" | "validUntilAt">, now: Date): number {
  if (rule === "pre-expiry") return q.validUntilAt ? Math.max(0, Math.ceil((q.validUntilAt.getTime() - now.getTime()) / DAY_MS)) : 0;
  const anchor = rule === "viewed-silent" ? q.lastViewedAt : q.sentAt;
  return anchor ? Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / DAY_MS)) : 0;
}

// ── Nudge templates (customer-facing → Italian; PDF is NOT re-attached — the
//    nudge references the original email, which carries it) ─────────────────

export type NudgeVars = { party: string; number: string; sentDate: string; validUntil: string };

export const NUDGE_TEMPLATE_DEFAULTS: Record<FollowUpRule, string> = {
  unviewed:
    "Gentile {party},\n\nle scrivo per ricordarle il preventivo {number}, inviato il {sentDate} — trova tutti i dettagli e il documento nella nostra email precedente. Se ha domande o desidera qualche modifica, sono a sua disposizione.\n\nCordiali saluti",
  "viewed-silent":
    "Gentile {party},\n\ntorno volentieri sul preventivo {number} inviato il {sentDate}. Se ci sono aspetti da chiarire o da rivedere per venire incontro alle sue esigenze, mi faccia sapere: sarò felice di aiutarla.\n\nCordiali saluti",
  "pre-expiry":
    "Gentile {party},\n\nle ricordo che il preventivo {number}, inviato il {sentDate}, resta valido fino al {validUntil}. Se desidera procedere o discuterne insieme, sono a sua disposizione.\n\nCordiali saluti",
};

/** Replaces the known {placeholders}; anything else is left visibly intact. */
export function renderNudgeTemplate(template: string, vars: NudgeVars): string {
  return template.replace(/\{(party|number|sentDate|validUntil)\}/g, (_m, k: keyof NudgeVars) => vars[k] ?? "");
}

// ── Pipeline "viewed" cell ───────────────────────────────────────────────────

/** Compact grid cell: "2× · 3d ago" (or "—" when never viewed). */
export function formatViewed(viewCount: number, lastViewedAt: Date | string | null, now: Date): string {
  if (!viewCount || !lastViewedAt) return "—";
  const last = typeof lastViewedAt === "string" ? new Date(lastViewedAt) : lastViewedAt;
  const days = Math.floor(Math.max(0, now.getTime() - last.getTime()) / DAY_MS);
  return `${viewCount}× · ${days === 0 ? "today" : `${days}d ago`}`;
}
