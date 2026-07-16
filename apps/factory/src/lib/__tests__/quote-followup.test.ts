/**
 * EPQ.2 — pins the follow-up engine's pure core: the cadence due-math for all
 * three rules (with their exact day boundaries), the flag/keep/clear dedupe
 * decisions (fresh vs stale flags, snooze via future flaggedAt, dismiss
 * suppression, nudge freshness), the Italian template rendering, and the
 * pipeline "viewed" cell format. The worker tick and the routes are thin
 * shells over these functions — if these hold, the queue behaves.
 */
import { describe, expect, it } from "vitest";
import {
  CADENCE_DEFAULTS,
  NUDGE_TEMPLATE_DEFAULTS,
  dueRule,
  followUpDecision,
  formatViewed,
  renderNudgeTemplate,
  ruleDays,
  ruleWindowDays,
  type FollowUpQuoteState,
} from "../quotes/followup";
import { withDefaults } from "../quotes/followup-settings";

const DAY = 86_400_000;
const NOW = new Date("2026-07-16T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const daysAhead = (n: number) => new Date(NOW.getTime() + n * DAY);

const base = (over: Partial<FollowUpQuoteState> = {}): FollowUpQuoteState => ({
  state: "SENT",
  sentAt: daysAgo(10),
  viewCount: 0,
  lastViewedAt: null,
  validUntilAt: daysAhead(20),
  lastNudgeAt: null,
  followUpRule: null,
  followUpFlaggedAt: null,
  ...over,
});

const cfg = CADENCE_DEFAULTS; // {unviewedDays: 3, viewedDays: 7, preExpiryDays: 3}

describe("dueRule (cadence due-math)", () => {
  it("only ever fires for SENT quotes", () => {
    for (const state of ["DRAFT", "ACCEPTED", "REJECTED", "EXPIRED"]) {
      expect(dueRule(base({ state }), cfg, NOW)).toBeNull();
    }
  });

  it("(a) unviewed: due at EXACTLY N days after send, not a minute before", () => {
    expect(dueRule(base({ sentAt: daysAgo(3) }), cfg, NOW)).toBe("unviewed");
    expect(dueRule(base({ sentAt: new Date(NOW.getTime() - 3 * DAY + 60_000) }), cfg, NOW)).toBeNull();
    expect(dueRule(base({ sentAt: daysAgo(2) }), cfg, NOW)).toBeNull();
  });

  it("(a) unviewed requires zero views and no nudge since the send", () => {
    expect(dueRule(base({ viewCount: 1, lastViewedAt: daysAgo(1) }), cfg, NOW)).toBeNull();
    // nudged after the send → the unviewed rule is answered
    expect(dueRule(base({ lastNudgeAt: daysAgo(4) }), cfg, NOW)).toBeNull();
    // a nudge that PRECEDES the (first) send doesn't count
    expect(dueRule(base({ sentAt: daysAgo(5), lastNudgeAt: daysAgo(9) }), cfg, NOW)).toBe("unviewed");
    // never sent (no sentAt) → nothing due
    expect(dueRule(base({ sentAt: null }), cfg, NOW)).toBeNull();
  });

  it("(b) viewed-silent: due at EXACTLY M days after the LAST view", () => {
    const viewed = (d: number) => base({ viewCount: 2, lastViewedAt: daysAgo(d) });
    expect(dueRule(viewed(7), cfg, NOW)).toBe("viewed-silent");
    expect(dueRule(viewed(6), cfg, NOW)).toBeNull();
    expect(dueRule(viewed(8), cfg, NOW)).toBe("viewed-silent");
  });

  it("(c) pre-expiry: validity ending within the window, exclusive of lapsed", () => {
    expect(dueRule(base({ validUntilAt: daysAhead(3) }), cfg, NOW)).toBe("pre-expiry");
    expect(dueRule(base({ validUntilAt: daysAhead(1) }), cfg, NOW)).toBe("pre-expiry");
    // beyond the window → not yet (sentAt fresh so no other rule interferes)
    expect(dueRule(base({ sentAt: daysAgo(1), validUntilAt: new Date(NOW.getTime() + 3 * DAY + 60_000) }), cfg, NOW)).toBeNull();
    // already lapsed → the EXPIRED sweep owns it, never this rule
    expect(dueRule(base({ sentAt: daysAgo(1), validUntilAt: daysAgo(1) }), cfg, NOW)).toBeNull();
    // no validity → never pre-expiry
    expect(dueRule(base({ sentAt: daysAgo(1), validUntilAt: null }), cfg, NOW)).toBeNull();
  });

  it("priority: pre-expiry beats viewed-silent beats unviewed", () => {
    // both unviewed and expiring → the deadline wins
    expect(dueRule(base({ sentAt: daysAgo(10), validUntilAt: daysAhead(2) }), cfg, NOW)).toBe("pre-expiry");
    // viewed-silent and expiring → the deadline wins
    expect(dueRule(base({ viewCount: 1, lastViewedAt: daysAgo(10), validUntilAt: daysAhead(2) }), cfg, NOW)).toBe("pre-expiry");
    // viewed-silent vs (impossible) unviewed — viewCount>0 rules unviewed out structurally
    expect(dueRule(base({ viewCount: 1, lastViewedAt: daysAgo(10) }), cfg, NOW)).toBe("viewed-silent");
  });

  it("ruleWindowDays maps each rule to its own cadence number", () => {
    expect(ruleWindowDays("unviewed", cfg)).toBe(3);
    expect(ruleWindowDays("viewed-silent", cfg)).toBe(7);
    expect(ruleWindowDays("pre-expiry", cfg)).toBe(3);
  });

  it("ruleDays reports the rule-relevant age/remaining days", () => {
    expect(ruleDays("unviewed", base({ sentAt: daysAgo(5) }), NOW)).toBe(5);
    expect(ruleDays("viewed-silent", base({ lastViewedAt: daysAgo(9) }), NOW)).toBe(9);
    expect(ruleDays("pre-expiry", base({ validUntilAt: daysAhead(2) }), NOW)).toBe(2);
  });
});

describe("followUpDecision (dedupe boundaries)", () => {
  it("flags a first-time due quote", () => {
    expect(followUpDecision(base({ sentAt: daysAgo(4) }), cfg, NOW)).toEqual({ kind: "flag", rule: "unviewed" });
  });

  it("keeps (no re-notification) while the same rule's flag is fresh", () => {
    const q = base({ sentAt: daysAgo(4), followUpRule: "unviewed", followUpFlaggedAt: daysAgo(1) });
    expect(followUpDecision(q, cfg, NOW)).toEqual({ kind: "keep" });
  });

  it("re-flags (re-notifies) once the flag goes stale — no offer dies of silence", () => {
    const q = base({ sentAt: daysAgo(10), followUpRule: "unviewed", followUpFlaggedAt: daysAgo(3) });
    expect(followUpDecision(q, cfg, NOW)).toEqual({ kind: "flag", rule: "unviewed" });
  });

  it("snooze = FUTURE flaggedAt: silently kept until the clock lapses", () => {
    const q = base({ sentAt: daysAgo(10), followUpRule: "unviewed", followUpFlaggedAt: daysAhead(2) });
    expect(followUpDecision(q, cfg, NOW)).toEqual({ kind: "keep" });
  });

  it("dismiss (rule cleared, flaggedAt fresh) suppresses for the rule's window, then re-flags", () => {
    const dismissed = base({ sentAt: daysAgo(10), followUpRule: null, followUpFlaggedAt: daysAgo(1) });
    expect(followUpDecision(dismissed, cfg, NOW)).toEqual({ kind: "none" });
    const staleDismiss = base({ sentAt: daysAgo(10), followUpRule: null, followUpFlaggedAt: daysAgo(3) });
    expect(followUpDecision(staleDismiss, cfg, NOW)).toEqual({ kind: "flag", rule: "unviewed" });
  });

  it("a fresh nudge answers the flag: the quote leaves the queue", () => {
    // viewed-silent due, but nudged yesterday (window 7d) → clear the flag
    const q = base({ viewCount: 1, lastViewedAt: daysAgo(10), followUpRule: "viewed-silent", followUpFlaggedAt: daysAgo(4), lastNudgeAt: daysAgo(1) });
    expect(followUpDecision(q, cfg, NOW)).toEqual({ kind: "clear" });
    // …and an unflagged quote with a fresh nudge stays silent
    const q2 = base({ viewCount: 1, lastViewedAt: daysAgo(10), lastNudgeAt: daysAgo(1) });
    expect(followUpDecision(q2, cfg, NOW)).toEqual({ kind: "none" });
  });

  it("a rule change (upgrade) flags even while the old rule's flag is fresh", () => {
    // flagged unviewed yesterday; the offer now enters the pre-expiry window
    const q = base({ sentAt: daysAgo(10), validUntilAt: daysAhead(2), followUpRule: "unviewed", followUpFlaggedAt: daysAgo(1) });
    expect(followUpDecision(q, cfg, NOW)).toEqual({ kind: "flag", rule: "pre-expiry" });
  });

  it("clears a flag whose condition no longer holds", () => {
    // flagged unviewed, then the customer viewed → nothing due yet → clear
    const q = base({ sentAt: daysAgo(10), viewCount: 1, lastViewedAt: daysAgo(1), followUpRule: "unviewed", followUpFlaggedAt: daysAgo(2) });
    expect(followUpDecision(q, cfg, NOW)).toEqual({ kind: "clear" });
    // nothing due, nothing flagged → none
    expect(followUpDecision(base({ sentAt: daysAgo(1) }), cfg, NOW)).toEqual({ kind: "none" });
  });
});

describe("renderNudgeTemplate", () => {
  const vars = { party: "Rossi Cuoio", number: "Q-12", sentDate: "01/07/2026", validUntil: "31/07/2026" };

  it("replaces every known placeholder", () => {
    const out = renderNudgeTemplate("Gentile {party}, preventivo {number} del {sentDate}, valido fino al {validUntil}.", vars);
    expect(out).toBe("Gentile Rossi Cuoio, preventivo Q-12 del 01/07/2026, valido fino al 31/07/2026.");
  });

  it("leaves unknown placeholders visibly intact (no silent swallowing)", () => {
    expect(renderNudgeTemplate("Ciao {party} {sconto}", vars)).toBe("Ciao Rossi Cuoio {sconto}");
  });

  it("all three default templates render with no leftover known placeholders", () => {
    for (const tpl of Object.values(NUDGE_TEMPLATE_DEFAULTS)) {
      const out = renderNudgeTemplate(tpl, vars);
      expect(out).not.toMatch(/\{(party|number|sentDate|validUntil)\}/);
      expect(out).toContain("Q-12");
      expect(out).toContain("Rossi Cuoio");
    }
    // the pre-expiry default must reference the validity date
    expect(renderNudgeTemplate(NUDGE_TEMPLATE_DEFAULTS["pre-expiry"], vars)).toContain("31/07/2026");
  });
});

describe("formatViewed (pipeline cell)", () => {
  it("em-dash when never viewed", () => {
    expect(formatViewed(0, null, NOW)).toBe("—");
    expect(formatViewed(0, daysAgo(1), NOW)).toBe("—");
    expect(formatViewed(2, null, NOW)).toBe("—");
  });

  it("counts and relative days", () => {
    expect(formatViewed(2, daysAgo(3), NOW)).toBe("2× · 3d ago");
    expect(formatViewed(1, new Date(NOW.getTime() - 3600_000), NOW)).toBe("1× · today");
    expect(formatViewed(7, daysAgo(1), NOW)).toBe("7× · 1d ago");
  });

  it("accepts ISO strings (API rows arrive serialized)", () => {
    expect(formatViewed(3, daysAgo(2).toISOString(), NOW)).toBe("3× · 2d ago");
  });
});

describe("withDefaults (settings folding)", () => {
  it("fills a missing/partial row with the defaults", () => {
    expect(withDefaults(null)).toEqual({ ...CADENCE_DEFAULTS, templates: NUDGE_TEMPLATE_DEFAULTS });
    expect(withDefaults({ unviewedDays: 5 }).unviewedDays).toBe(5);
    expect(withDefaults({ unviewedDays: 5 }).viewedDays).toBe(7);
  });

  it("clamps nonsense day values into 1..90", () => {
    expect(withDefaults({ unviewedDays: 0 }).unviewedDays).toBe(1);
    expect(withDefaults({ viewedDays: 400 }).viewedDays).toBe(90);
    expect(withDefaults({ preExpiryDays: Number.NaN }).preExpiryDays).toBe(3);
  });

  it("keeps a stored template override, defaults the rest", () => {
    const s = withDefaults({ templates: { unviewed: "Ciao {party}" } });
    expect(s.templates.unviewed).toBe("Ciao {party}");
    expect(s.templates["pre-expiry"]).toBe(NUDGE_TEMPLATE_DEFAULTS["pre-expiry"]);
  });
});
