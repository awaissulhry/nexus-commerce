/**
 * FC3 — in-line threads + mention surfacing, pure contracts (no DB, no DOM):
 * the thread notify audience (participants + followers + mentioned − author,
 * notifyLevel-filtered — the Google rule), @all detection over the shared
 * mention grammar, followedThreads add/remove idempotency + cap, the
 * &thread= URL law, mention tokenization parity, and the client-side handle
 * resolution the chips render with.
 */
import { describe, expect, it } from "vitest";
import {
  FOLLOWED_THREADS_MAX,
  MENTION_RE_SOURCE,
  addFollowedThread,
  bodyMentionsAll,
  computeThreadAudience,
  parseFollowedThreads,
  removeFollowedThread,
} from "../chat/pure";
import { chatUrl, resolveHandleDisplay, splitMentionTokens, threadRepliesLabel } from "../chat/ui";

// ── the thread notify audience (the Google rule) ─────────────────

describe("computeThreadAudience", () => {
  const ALL = { u1: "ALL", u2: "ALL", u3: "ALL", author: "ALL" } as const;

  it("replies ping participants + followers, never the author", () => {
    const out = computeThreadAudience({
      authorId: "author",
      participantIds: ["author", "u1"],
      followerIds: ["u2"],
      mentionedIds: [],
      levels: ALL,
    });
    expect(out.reply).toEqual(["u1", "u2"]);
    expect(out.mention).toEqual([]);
  });

  it("mentioned users leave the reply set and get the MENTION instead", () => {
    const out = computeThreadAudience({
      authorId: "author",
      participantIds: ["u1", "u2"],
      followerIds: ["u2"],
      mentionedIds: ["u2"],
      levels: ALL,
    });
    expect(out.mention).toEqual(["u2"]);
    expect(out.reply).toEqual(["u1"]);
  });

  it("the author never notifies themselves, even self-mentioned", () => {
    const out = computeThreadAudience({
      authorId: "author",
      participantIds: ["author"],
      followerIds: ["author"],
      mentionedIds: ["author"],
      levels: ALL,
    });
    expect(out.mention).toEqual([]);
    expect(out.reply).toEqual([]);
  });

  it("notifyLevel OFF mutes everything — even direct mentions", () => {
    const out = computeThreadAudience({
      authorId: "author",
      participantIds: ["u1"],
      followerIds: ["u2"],
      mentionedIds: ["u3"],
      levels: { u1: "OFF", u2: "OFF", u3: "OFF" },
    });
    expect(out.mention).toEqual([]);
    expect(out.reply).toEqual([]);
  });

  it("notifyLevel MENTIONS mutes non-mention thread pings but keeps mentions", () => {
    const out = computeThreadAudience({
      authorId: "author",
      participantIds: ["u1"],
      followerIds: ["u2"],
      mentionedIds: ["u3"],
      levels: { u1: "MENTIONS", u2: "MENTIONS", u3: "MENTIONS" },
    });
    expect(out.mention).toEqual(["u3"]);
    expect(out.reply).toEqual([]);
  });

  it("a mentioned non-member (no level row) defaults to ALL — the FC1 behavior", () => {
    const out = computeThreadAudience({
      authorId: "author",
      participantIds: [],
      followerIds: [],
      mentionedIds: ["stranger"],
      levels: {},
    });
    expect(out.mention).toEqual(["stranger"]);
  });

  it("dedupes participant/follower overlap and sorts deterministically", () => {
    const out = computeThreadAudience({
      authorId: "author",
      participantIds: ["u2", "u1", "u2"],
      followerIds: ["u1", "u2"],
      mentionedIds: [],
      levels: ALL,
    });
    expect(out.reply).toEqual(["u1", "u2"]);
  });

  it("empty participants/followers = the main-stream case: only mentions ping", () => {
    const out = computeThreadAudience({
      authorId: "author",
      participantIds: [],
      followerIds: [],
      mentionedIds: ["u1", "u2"],
      levels: { u1: "ALL", u2: "OFF" },
    });
    expect(out.mention).toEqual(["u1"]);
    expect(out.reply).toEqual([]);
  });
});

// ── @all detection (the broadcast mention) ───────────────────────

describe("bodyMentionsAll", () => {
  it("detects @all as a standalone token, any case", () => {
    expect(bodyMentionsAll("@all")).toBe(true);
    expect(bodyMentionsAll("hey @all!")).toBe(true);
    expect(bodyMentionsAll("cc @ALL please")).toBe(true);
    expect(bodyMentionsAll("line one\n@all line two")).toBe(true);
  });

  it("never fires inside emails or longer handles", () => {
    expect(bodyMentionsAll("mail me@all thanks")).toBe(false); // glued to a handle char
    expect(bodyMentionsAll("foo@allmail.com")).toBe(false);
    expect(bodyMentionsAll("write to foo@all.com")).toBe(false); // handle is "all.com"
    expect(bodyMentionsAll("@allies assemble")).toBe(false);
    expect(bodyMentionsAll("no mention here")).toBe(false);
    expect(bodyMentionsAll("")).toBe(false);
  });
});

// ── followedThreads list math ────────────────────────────────────

describe("followedThreads add/remove", () => {
  it("parse is defensive: nulls, junk and mixed arrays degrade to sane", () => {
    expect(parseFollowedThreads(null)).toEqual([]);
    expect(parseFollowedThreads(undefined)).toEqual([]);
    expect(parseFollowedThreads("junk")).toEqual([]);
    expect(parseFollowedThreads({ a: 1 })).toEqual([]);
    expect(parseFollowedThreads([1, "t1", null, "", "t2"])).toEqual(["t1", "t2"]);
  });

  it("add is idempotent — already-following returns the SAME reference (callers skip the write)", () => {
    const list = ["t1", "t2"];
    expect(addFollowedThread(list, "t1")).toBe(list);
    expect(addFollowedThread(list, "t3")).toEqual(["t1", "t2", "t3"]);
    expect(list).toEqual(["t1", "t2"]); // never mutated
  });

  it("remove is idempotent — not-following returns the SAME reference", () => {
    const list = ["t1", "t2"];
    expect(removeFollowedThread(list, "t9")).toBe(list);
    expect(removeFollowedThread(list, "t1")).toEqual(["t2"]);
    expect(list).toEqual(["t1", "t2"]);
  });

  it("caps at FOLLOWED_THREADS_MAX, dropping the oldest", () => {
    const full = Array.from({ length: FOLLOWED_THREADS_MAX }, (_, i) => `t${i}`);
    const next = addFollowedThread(full, "fresh");
    expect(next).toHaveLength(FOLLOWED_THREADS_MAX);
    expect(next[next.length - 1]).toBe("fresh");
    expect(next).not.toContain("t0"); // oldest dropped
    expect(next).toContain("t1");
  });
});

// ── the &thread= URL law ─────────────────────────────────────────

describe("chatUrl with thread", () => {
  it("keeps the FC2 grammar for spaces", () => {
    expect(chatUrl(null)).toBe("/chat");
    expect(chatUrl("s1")).toBe("/chat?space=s1");
    expect(chatUrl("s1", null)).toBe("/chat?space=s1");
  });

  it("appends &thread= only alongside its space", () => {
    expect(chatUrl("s1", "t9")).toBe("/chat?space=s1&thread=t9");
    expect(chatUrl(null, "t9")).toBe("/chat"); // a thread is meaningless without its space
  });
});

// ── mention tokenization + chip resolution ───────────────────────

describe("splitMentionTokens", () => {
  it("uses the server's exact mention grammar (parity by construction)", () => {
    expect(MENTION_RE_SOURCE).toBe("@([\\w.+-]+(?:@[\\w.-]+)?)");
  });

  it("round-trips the body exactly (text + raw concatenation)", () => {
    const body = "hey @marco.rossi check @all and mail x@y.com ok";
    const joined = splitMentionTokens(body)
      .map((t) => (t.kind === "text" ? t.text : t.raw))
      .join("");
    expect(joined).toBe(body);
  });

  it("tokenizes handles and flags @all", () => {
    const tokens = splitMentionTokens("ping @marco and @all now");
    const mentions = tokens.filter((t) => t.kind === "mention");
    expect(mentions).toHaveLength(2);
    expect(mentions[0]).toMatchObject({ handle: "marco", all: false });
    expect(mentions[1]).toMatchObject({ handle: "all", all: true });
  });

  it("a body without mentions is a single text token", () => {
    expect(splitMentionTokens("plain words")).toEqual([{ kind: "text", text: "plain words" }]);
  });
});

describe("resolveHandleDisplay", () => {
  const members = [
    { id: "u1", displayName: "Marco Rossi", email: "marco@xavia.it" },
    { id: "u2", displayName: "Giulia Bianchi", email: "giulia.b@xavia.it" },
  ];

  it("matches email, email prefix, dotted display name and first name — case-insensitive", () => {
    expect(resolveHandleDisplay("marco@xavia.it", members)).toBe("Marco Rossi");
    expect(resolveHandleDisplay("marco", members)).toBe("Marco Rossi");
    expect(resolveHandleDisplay("marco.rossi", members)).toBe("Marco Rossi");
    expect(resolveHandleDisplay("MARCO.ROSSI", members)).toBe("Marco Rossi");
    expect(resolveHandleDisplay("giulia.b", members)).toBe("Giulia Bianchi");
    expect(resolveHandleDisplay("giulia", members)).toBe("Giulia Bianchi");
  });

  it("no member match = null (renders as plain text, like the server resolving nobody)", () => {
    expect(resolveHandleDisplay("nobody", members)).toBeNull();
    expect(resolveHandleDisplay("rossi", members)).toBeNull(); // last name alone is not a handle
    expect(resolveHandleDisplay("marco", [])).toBeNull();
  });
});

describe("threadRepliesLabel", () => {
  it("pluralizes honestly", () => {
    expect(threadRepliesLabel(1)).toBe("1 reply");
    expect(threadRepliesLabel(2)).toBe("2 replies");
    expect(threadRepliesLabel(0)).toBe("0 replies");
  });
});
