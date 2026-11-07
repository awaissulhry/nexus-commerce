import { describe, expect, it } from "vitest";
import {
  ATTENDANCE_STATEMENT,
  RECORDS_REFUSALS,
  SESSION_STATUSES as DOMAIN_STATUSES,
  statementLanguageOf as recordsLanguage,
  stoppedWords,
} from "@nexus/factory-domain/safety/records/rules";
import {
  COMMON_PPE,
  PPE_ISSUE_REASONS,
  PPE_LIMITS,
  PPE_REFUSALS,
  statementLanguageOf as ppeLanguage,
} from "@nexus/factory-domain/safety/ppe/rules";
import type { ApiClient } from "../../../lib/api/client";
import { ApiError } from "../../../lib/api/errors";
import { CATALOGUE } from "../../../lib/i18n/messages";
import { LOCALES } from "../../../lib/i18n/locales";
import { homeTiles, TILE_RULES } from "../../model";
import { FLOOR_PAGES } from "../../moves";
import { FLOOR_NAMESPACES, TASK_ROUTES, taskOfTile } from "../routes";
import { signedOrWrong } from "./api";
import {
  allUnderstood,
  checkCounts,
  checksDone,
  commonKindOf,
  COMMON_KINDS,
  countersignHeld,
  countersignLines,
  credentialsOf,
  defaultReason,
  isKnownRefusal,
  itemByCode,
  KNOWN_REFUSALS,
  lineForItem,
  LINES_MAX,
  linesFromKit,
  localeIn,
  missingCount,
  needsSize,
  nextUnsized,
  PPE_REASONS,
  QUANTITY_MAX,
  receiveHeld,
  receiveLines,
  SESSION_STATUSES,
  shownLanguage,
  signHeld,
  statementLanguageOf,
  stepQuantity,
  stopOf,
  tileOrder,
  unitsOf,
  waitingCountersign,
  withSize,
  type AttendanceRow,
  type KitLine,
  type PpeItem,
  type PpeLine,
} from "./model";

const item = (
  id: string,
  code: string,
  sizes: string[] = [],
  name = code,
): PpeItem => ({
  id,
  code,
  name,
  nameI18n: null,
  category: "CATEGORY_II",
  standard: null,
  sizes,
});
const GLOVES = item("g", "GLOVES-CUT", ["7", "8", "9"], "Gloves");
const GLASSES = item("s", "GLASSES", [], "Glasses");
const APRON = item("a", "APRON", ["M"], "Apron");
const SLEEVES = item("m", "SLEEVES", [], "Arm sleeves");
const ITEMS = [SLEEVES, APRON, GLASSES, GLOVES];
const kit = (ppeItemId: string, quantity: number, held: number): KitLine => ({
  ppeItemId,
  quantity,
  held,
  missing: Math.max(0, quantity - held),
  whenToWear: "Always",
});
const line = (
  id: string,
  ppeItemId: string,
  extra: Partial<PpeLine> = {},
): PpeLine => ({
  id,
  ppeItemId,
  size: null,
  quantity: 1,
  reason: "NEW",
  fromKit: false,
  ...extra,
});
const row = (
  id: string,
  extra: Partial<AttendanceRow> = {},
): AttendanceRow => ({
  id,
  displayName: id,
  method: "FLOOR_PIN",
  signedAt: "2026-11-06T08:00:00.000Z",
  countersigned: false,
  languageUnderstood: null,
  ...extra,
});

describe("the domain, copied (its rules import node:crypto, so the web keeps equal copies)", () => {
  it("the reasons, limits, common items, statuses and the signer’s language", () => {
    expect([...PPE_REASONS]).toEqual([...PPE_ISSUE_REASONS]);
    expect(QUANTITY_MAX).toBe(PPE_LIMITS.quantity);
    expect(LINES_MAX).toBe(PPE_LIMITS.lines);
    // The design's common items, in its order, known by a word of their code (a company types its own codes).
    expect(COMMON_PPE.map((entry) => commonKindOf(entry.code))).toEqual([
      ...COMMON_KINDS,
    ]);
    expect(
      [
        "SEED-PPE-GLOVES-CUT",
        "SEED-PPE-SHOES",
        "SEED-PPE-EAR-DEF",
        "SEED-PPE-APRON-B",
        "GEAR-BAG",
        "SLEEVES",
      ].map(commonKindOf),
    ).toEqual(["gloves", "shoes", "hearing", "apron", null, null]);
    expect([...SESSION_STATUSES]).toEqual([...DOMAIN_STATUSES]);
    for (const locale of [
      "it",
      "it-IT",
      "IT",
      "en",
      "de",
      "",
      null,
      undefined,
    ]) {
      expect(statementLanguageOf(locale), String(locale)).toBe(
        recordsLanguage(locale),
      );
      expect(statementLanguageOf(locale), String(locale)).toBe(
        ppeLanguage(locale),
      );
    }
  });

  it("why signing stopped comes from the status, the office’s reason out of the API’s sentence", () => {
    expect(stopOf({ status: "OPEN", stopped: null })).toBeNull();
    expect(
      stopOf({ status: "CLOSED", stopped: stoppedWords("CLOSED", null) }),
    ).toEqual({ kind: "closed" });
    expect(
      stopOf({
        status: "CANCELLED",
        stopped: stoppedWords("CANCELLED", "the trainer is ill"),
      }),
    ).toEqual({ kind: "cancelled", reason: "the trainer is ill" });
    expect(
      stopOf({
        status: "CANCELLED",
        stopped: stoppedWords("CANCELLED", "room: flooded. Next week"),
      }),
    ).toEqual({ kind: "cancelled", reason: "room: flooded. Next week" });
    expect(
      stopOf({ status: "CANCELLED", stopped: stoppedWords("CANCELLED", null) }),
    ).toEqual({ kind: "cancelled", reason: null });
    expect(stopOf({ status: "CANCELLED", stopped: "something else" })).toEqual({
      kind: "cancelled",
      reason: null,
    });
  });

  it("every refusal this screen knows is one of the API’s, with its words in both languages", () => {
    const domain = new Set([
      ...Object.keys(RECORDS_REFUSALS),
      ...Object.keys(PPE_REFUSALS),
    ]);
    for (const code of KNOWN_REFUSALS) {
      expect(domain.has(code), code).toBe(true);
      expect(isKnownRefusal(code)).toBe(true);
      for (const locale of LOCALES) {
        expect(
          CATALOGUE[locale]["floor-training"]?.[`refusal.${code}.message`],
          `${locale} ${code}`,
        ).toBeTruthy();
        expect(
          CATALOGUE[locale]["floor-training"]?.[`refusal.${code}.fix`],
          `${locale} ${code}`,
        ).toBeTruthy();
      }
    }
    expect(isKnownRefusal("CLIENT_ID_REUSED")).toBe(false);
  });
});

describe("training attendance", () => {
  it("who signs: the badge itself or the worker picked, never both; the words in their language when the tablet knows it", () => {
    expect(
      credentialsOf({
        kind: "badge",
        code: "B1",
        workerId: "w1",
        name: "Ada",
        locale: "it",
      }),
    ).toEqual({ badgeCode: "B1" });
    expect(
      credentialsOf({
        kind: "name",
        workerId: "w2",
        name: "Sara",
        locale: "en",
      }),
    ).toEqual({ workerId: "w2" });
    const roster = [{ id: "w1", name: "Ada", locale: "it" }];
    expect(localeIn(roster, "w1")).toBe("it");
    expect(localeIn(roster, "w9")).toBeNull();
    expect(localeIn(roster, null)).toBeNull();
    expect(shownLanguage("en", "it")).toBe("en");
    expect(shownLanguage(null, "it")).toBe("it");
    expect(ATTENDANCE_STATEMENT[shownLanguage("de", "it")]).toBe(
      ATTENDANCE_STATEMENT.en,
    );
  });

  it("signing and countersigning are held with the reason: stopped first, then the trainer, nobody waiting, the network", () => {
    expect(signHeld({ online: true, stop: null })).toBeNull();
    expect(signHeld({ online: false, stop: null })).toBe("offline");
    expect(signHeld({ online: false, stop: { kind: "closed" } })).toBe(
      "stopped",
    );
    expect(
      countersignHeld({
        online: true,
        stop: null,
        trainerHere: true,
        waiting: 2,
      }),
    ).toBeNull();
    expect(
      countersignHeld({
        online: true,
        stop: { kind: "cancelled", reason: null },
        trainerHere: true,
        waiting: 2,
      }),
    ).toBe("stopped");
    expect(
      countersignHeld({
        online: true,
        stop: null,
        trainerHere: false,
        waiting: 2,
      }),
    ).toBe("outsideTrainer");
    expect(
      countersignHeld({
        online: true,
        stop: null,
        trainerHere: true,
        waiting: 0,
      }),
    ).toBe("nobody");
    expect(
      countersignHeld({
        online: false,
        stop: null,
        trainerHere: true,
        waiting: 1,
      }),
    ).toBe("offline");
  });

  it("the language check: every person waiting answered (no default), in the list’s order", () => {
    const rows = [
      row("a"),
      row("b", { countersigned: true, languageUnderstood: true }),
      row("c", { method: "PAPER" }),
    ];
    const waiting = waitingCountersign(rows);
    expect(waiting.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(checksDone(waiting, {})).toBe(false);
    expect(checksDone(waiting, { a: true })).toBe(false);
    expect(checksDone(waiting, { a: true, c: false })).toBe(true);
    expect(checksDone([], {})).toBe(false);
    expect(allUnderstood(waiting)).toEqual({ a: true, c: true });
    expect(countersignLines(waiting, { c: false, a: true })).toEqual([
      { attendanceId: "a", languageUnderstood: true },
      { attendanceId: "c", languageUnderstood: false },
    ]);
    expect(checkCounts({ a: true, c: false, d: true })).toEqual({
      understood: 2,
      notUnderstood: 1,
    });
  });
});

describe("receive PPE", () => {
  it("the tiles: the design’s common items first, then the rest by name; a scanned code finds its item", () => {
    expect(tileOrder(ITEMS, "en").map((entry) => entry.code)).toEqual([
      "GLOVES-CUT",
      "GLASSES",
      "APRON",
      "SLEEVES",
    ]);
    expect(itemByCode(ITEMS, " gloves-cut ")).toBe(GLOVES);
    expect(itemByCode(ITEMS, "BOX-1")).toBeNull();
  });

  it("the kit’s missing items prefilled, new, their missing count; a one-size item needs no size", () => {
    const lines = linesFromKit(
      [kit("g", 2, 0), kit("s", 1, 1), kit("a", 1, 0), kit("gone", 1, 0)],
      ITEMS,
      (index) => `k${index}`,
    );
    expect(lines).toEqual([
      {
        id: "k0",
        ppeItemId: "g",
        size: null,
        quantity: 2,
        reason: "NEW",
        fromKit: true,
      },
      {
        id: "k1",
        ppeItemId: "a",
        size: "M",
        quantity: 1,
        reason: "NEW",
        fromKit: true,
      },
    ]);
    expect(missingCount([kit("g", 2, 0), kit("s", 1, 1)])).toBe(1);
    expect(needsSize(lines[0]!, GLOVES)).toBe(true);
    expect(needsSize(lines[1]!, APRON)).toBe(false);
    expect(needsSize(line("x", "s"), GLASSES)).toBe(false);
    expect(needsSize({ size: "12" }, GLOVES)).toBe(true);
  });

  it("a tile opens the item’s line still without a size, else a new one of 1 (a replacement when the person holds it)", () => {
    const kitHeld = [kit("g", 2, 2)];
    expect(defaultReason(kitHeld, "g")).toBe("REPLACEMENT");
    expect(defaultReason(kitHeld, "s")).toBe("NEW");
    const open = lineForItem([line("l1", "g")], GLOVES, kitHeld, "new");
    expect(open.lineId).toBe("l1");
    expect(open.lines).toHaveLength(1);
    const added = lineForItem(
      [line("l1", "g", { size: "8" })],
      GLOVES,
      kitHeld,
      "new",
    );
    expect(added.lineId).toBe("new");
    expect(added.lines[1]).toEqual({
      id: "new",
      ppeItemId: "g",
      size: null,
      quantity: 1,
      reason: "REPLACEMENT",
      fromKit: false,
    });
    expect(lineForItem([line("l2", "s")], GLASSES, [], "new").lineId).toBe(
      "l2",
    );
  });

  it("one line per item and size: a size another line holds takes this line’s units", () => {
    const merged = withSize(
      [
        line("l1", "g", { size: "8", quantity: 2 }),
        line("l2", "g", { quantity: 3 }),
      ],
      "l2",
      "8",
    );
    expect(merged.lineId).toBe("l1");
    expect(merged.lines).toEqual([line("l1", "g", { size: "8", quantity: 5 })]);
    expect(withSize([line("l1", "g")], "l1", "9").lines[0]!.size).toBe("9");
    expect(stepQuantity(1, -1)).toBe(1);
    expect(stepQuantity(QUANTITY_MAX, 1)).toBe(QUANTITY_MAX);
    expect(stepQuantity(2, 1)).toBe(3);
  });

  it("the person signs once every item has its size; the lines as the API takes them", () => {
    const lines = [line("l1", "g", { quantity: 2 }), line("l2", "s")];
    expect(nextUnsized(lines, ITEMS)).toBe("l1");
    expect(receiveHeld({ online: true, lines: [], items: ITEMS })).toBe(
      "empty",
    );
    expect(receiveHeld({ online: true, lines, items: ITEMS })).toBe("size");
    const sized = withSize(lines, "l1", "9").lines;
    expect(nextUnsized(sized, ITEMS)).toBeNull();
    expect(
      receiveHeld({ online: true, lines: sized, items: ITEMS }),
    ).toBeNull();
    expect(receiveHeld({ online: false, lines: sized, items: ITEMS })).toBe(
      "offline",
    );
    expect(
      receiveHeld({
        online: true,
        lines: Array.from({ length: LINES_MAX + 1 }, (_, index) =>
          line(`l${index}`, "s"),
        ),
        items: ITEMS,
      }),
    ).toBe("tooMany");
    expect(receiveLines(sized)).toEqual([
      { ppeItemId: "g", size: "9", quantity: 2, reason: "NEW" },
      { ppeItemId: "s", size: null, quantity: 1, reason: "NEW" },
    ]);
    expect(unitsOf(sized)).toBe(3);
  });
});

describe("a signature that did not go", () => {
  const apiWith = (me: unknown | Error): ApiClient =>
    ({
      get: async () => {
        if (me instanceof Error) throw me;
        return me;
      },
    }) as unknown as ApiClient;
  const signedOut = new ApiError(
    "signed_out",
    401,
    "unauthenticated",
    "Sign in first.",
  );

  it("a 401 is the badge or PIN while the tablet’s session stands, else the session ended", async () => {
    expect(
      await signedOrWrong(apiWith({ worker: { id: "w" } }), {
        kind: "signedOut",
      }),
    ).toEqual({ kind: "pin", problem: "wrong" });
    expect(
      await signedOrWrong(apiWith(signedOut), { kind: "signedOut" }),
    ).toEqual({ kind: "ended" });
    expect(await signedOrWrong(apiWith(null), { kind: "offline" })).toEqual({
      kind: "pin",
      problem: "offline",
    });
    expect(await signedOrWrong(apiWith(null), { kind: "rateLimited" })).toEqual(
      { kind: "pin", problem: "rateLimited" },
    );
    const refused = {
      kind: "refused",
      code: "ATTENDED_ALREADY",
      message: "x",
      fix: null,
    } as const;
    expect(await signedOrWrong(apiWith(null), refused)).toEqual({
      kind: "problem",
      problem: refused,
    });
  });
});

describe("the wiring", () => {
  it("the tile at every station mode and a lead’s line tablet, floor.work, never held by the worker notice; its page, catalogue and offline move", () => {
    const rule = TILE_RULES.find((entry) => entry.key === "training")!;
    expect(rule).toMatchObject({
      permission: "floor.work",
      modes: ["sewing", "cutting", "warehouse", "packing", "inspection"],
      devices: ["LINE"],
      built: true,
      takesScans: false,
    });
    for (const mode of [
      "sewing",
      "cutting",
      "warehouse",
      "packing",
      "inspection",
    ] as const) {
      expect(
        homeTiles(mode, ["floor.work"], true).find(
          (tile) => tile.key === "training",
        ),
        mode,
      ).toEqual({ key: "training", held: null });
    }
    expect(
      homeTiles(null, ["floor.work"], false, "LINE").map((tile) => tile.key),
    ).toContain("training");
    expect(
      homeTiles(null, ["floor.work"], false, "PHONE").map((tile) => tile.key),
    ).not.toContain("training");
    expect(
      homeTiles("sewing", [], false).map((tile) => tile.key),
    ).not.toContain("training");
    expect(taskOfTile("training")).toBe("training");
    expect(TASK_ROUTES.training).toBe("/floor/training");
    expect(FLOOR_PAGES).toContain("/floor/training");
    expect(FLOOR_NAMESPACES).toContain("floor-training");
  });
});
