/**
 * Training & PPE sign-off's rules (B-W2b-145, SCR-231; design floor.training, QHS-248, QHS-261; on the merged API of B-W2b-139 and
 * B-W2b-134). Pure, so the tests hold them:
 *
 *   Training attendance   the site's OPEN sessions; each worker: badge (or name) + their own PIN signs; the trainer countersigns
 *                         with their PIN after saying, for each person, whether they understood the session's language (art. 37
 *                         c.13). A session closed or cancelled in the office stops signing, with the reason.
 *   Receive PPE           the person's badge (or name) → the items (their kit's missing ones prefilled; a tile or the item's code
 *                         adds one) → size → quantity (default 1) → the person signs the receipt with their own PIN.
 *
 * Both are ONLINE only (B-W2b-134 / -139: a PIN is never queued or kept on a tablet; a signature is the PIN proved at that
 * moment). No money: a floor screen holds no price, cost or margin grain. A person's name only inside this one session or
 * receipt.
 *
 * factory-domain's safety/records and safety/ppe rules import node:crypto, so the few constants this screen needs are copied
 * here and a test keeps them equal to the domain's.
 */

export type Job = "training" | "ppe";

// ---- the words a person signs ---------------------------------------------------------------------------------------------

export type StatementLanguage = "it" | "en";

/** factory-domain `statementLanguageOf` (both modules): Italian for an Italian locale, English for any other. */
export const statementLanguageOf = (
  locale: string | null | undefined,
): StatementLanguage =>
  (locale ?? "").toLowerCase().startsWith("it") ? "it" : "en";

/**
 * The words shown before a PIN: in the signer's language when the tablet knows it (a name picked from the tablet's list, a badge
 * of someone on it), else in the screen's. The API signs the words in the signer's own language and answers them; the screen
 * shows that answer after the signature.
 */
export const shownLanguage = (
  signerLocale: string | null | undefined,
  screen: string,
): StatementLanguage => statementLanguageOf(signerLocale ?? screen);

// ---- who signs ------------------------------------------------------------------------------------------------------------

/** The person who signs: a badge read (named once the office says whose it is) or a name picked from the tablet's list. */
export type Signer =
  | {
      readonly kind: "badge";
      readonly code: string;
      readonly workerId: string | null;
      readonly name: string | null;
      readonly locale: string | null;
    }
  | {
      readonly kind: "name";
      readonly workerId: string;
      readonly name: string;
      readonly locale: string | null;
    };

/** What the API takes: the badge itself (so the badge is checked again), or the worker picked by name. Never both. */
export const credentialsOf = (
  signer: Signer,
): { readonly badgeCode: string } | { readonly workerId: string } =>
  signer.kind === "badge"
    ? { badgeCode: signer.code }
    : { workerId: signer.workerId };

export interface RosterPerson {
  readonly id: string;
  readonly name: string;
  readonly locale: string | null;
}

/** The tablet's list knows this worker's language. */
export const localeIn = (
  roster: readonly RosterPerson[],
  workerId: string | null,
): string | null =>
  workerId
    ? (roster.find((person) => person.id === workerId)?.locale ?? null)
    : null;

// ---- a training session ---------------------------------------------------------------------------------------------------

export const SESSION_STATUSES = ["OPEN", "CLOSED", "CANCELLED"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type SessionStop =
  | { readonly kind: "closed" }
  | { readonly kind: "cancelled"; readonly reason: string | null }
  | null;

/**
 * Why signing stopped, in the screen's own words. The floor read gives the status and the API's English sentence only
 * (factory-domain `stoppedWords`: "This session was cancelled: <reason>. Signing has stopped."); the office's typed reason is
 * taken out of it (a test keeps the shape equal to the domain's).
 */
export function stopOf(session: {
  readonly status: SessionStatus;
  readonly stopped: string | null;
}): SessionStop {
  if (session.status === "OPEN") return null;
  if (session.status === "CLOSED") return { kind: "closed" };
  const match =
    /^This session was cancelled: ([\s\S]+)\. Signing has stopped\.$/.exec(
      session.stopped ?? "",
    );
  return { kind: "cancelled", reason: match ? match[1]!.trim() || null : null };
}

export interface AttendanceRow {
  readonly id: string;
  readonly displayName: string | null;
  readonly method: "FLOOR_PIN" | "PAPER";
  readonly signedAt: string;
  readonly countersigned: boolean;
  readonly languageUnderstood: boolean | null;
}

/** The attendances the trainer has still to countersign (paper ones too: the API countersigns any not done). */
export const waitingCountersign = (
  attendances: readonly AttendanceRow[],
): AttendanceRow[] =>
  attendances.filter((attendance) => !attendance.countersigned);

export type SignHeld = "offline" | "stopped" | null;

/** Why a worker cannot sign now: the network (online only), or the office closed the session. */
export const signHeld = (input: {
  readonly online: boolean;
  readonly stop: SessionStop;
}): SignHeld => (input.stop ? "stopped" : input.online ? null : "offline");

export type CountersignHeld =
  "offline" | "stopped" | "outsideTrainer" | "nobody" | null;

/** Why the trainer cannot countersign here now. An outside trainer (no floor sign-in at this site) countersigns in the office. */
export function countersignHeld(input: {
  readonly online: boolean;
  readonly stop: SessionStop;
  readonly trainerHere: boolean;
  readonly waiting: number;
}): CountersignHeld {
  if (input.stop) return "stopped";
  if (!input.trainerHere) return "outsideTrainer";
  if (input.waiting === 0) return "nobody";
  return input.online ? null : "offline";
}

/** The trainer's language check: attendance id → understood the session's language. */
export type LanguageChecks = Readonly<Record<string, boolean>>;

/** Every person waiting has their answer (art. 37 c.13: never a default). */
export const checksDone = (
  waiting: readonly AttendanceRow[],
  checks: LanguageChecks,
): boolean =>
  waiting.length > 0 &&
  waiting.every((attendance) => typeof checks[attendance.id] === "boolean");

export const allUnderstood = (
  waiting: readonly AttendanceRow[],
): LanguageChecks =>
  Object.fromEntries(waiting.map((attendance) => [attendance.id, true]));

/** The countersignature's lines, in the list's order. */
export const countersignLines = (
  waiting: readonly AttendanceRow[],
  checks: LanguageChecks,
): { attendanceId: string; languageUnderstood: boolean }[] =>
  waiting
    .filter((attendance) => typeof checks[attendance.id] === "boolean")
    .map((attendance) => ({
      attendanceId: attendance.id,
      languageUnderstood: checks[attendance.id]!,
    }));

/** How many understood and how many did not (the summary above the trainer's PIN). */
export const checkCounts = (
  checks: LanguageChecks,
): { understood: number; notUnderstood: number } => {
  const values = Object.values(checks);
  return {
    understood: values.filter(Boolean).length,
    notUnderstood: values.filter((value) => !value).length,
  };
};

// ---- receive PPE ----------------------------------------------------------------------------------------------------------

/** factory-domain PPE_ISSUE_REASONS. */
export const PPE_REASONS = ["NEW", "REPLACEMENT", "LOST"] as const;
export type PpeReason = (typeof PPE_REASONS)[number];

/** factory-domain PPE_LIMITS.quantity and .lines. */
export const QUANTITY_MAX = 99;
export const LINES_MAX = 20;

/**
 * The design's common items, in its order (gloves, safety shoes, glasses, hearing protection, apron, mask: factory-domain
 * COMMON_PPE), known by a word of the item's code, since a company types its own codes ("SEED-PPE-GLOVES-CUT", "GLOVES-CUT-B").
 */
export const COMMON_KINDS = [
  "gloves",
  "shoes",
  "glasses",
  "hearing",
  "apron",
  "mask",
] as const;
export type CommonKind = (typeof COMMON_KINDS)[number];
const COMMON_WORDS: Readonly<Record<CommonKind, RegExp>> = {
  gloves: /GLOVE/,
  shoes: /SHOE|BOOT/,
  glasses: /GLASS|GOGGLE/,
  hearing: /(^|[^A-Z])EAR|HEAR/,
  apron: /APRON/,
  mask: /MASK|FFP/,
};

/** Which common item a code names, or null. */
export const commonKindOf = (code: string): CommonKind | null =>
  COMMON_KINDS.find((kind) => COMMON_WORDS[kind].test(code.toUpperCase())) ??
  null;

export interface PpeItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameI18n: Readonly<Record<string, string>> | null;
  readonly category: "CATEGORY_I" | "CATEGORY_II" | "CATEGORY_III";
  readonly standard: string | null;
  readonly sizes: readonly string[];
}

export interface KitLine {
  readonly ppeItemId: string;
  readonly quantity: number;
  readonly held: number;
  readonly missing: number;
  readonly whenToWear: string;
}

/** One line of the receipt, as this page holds it (its own id; never stored). */
export interface PpeLine {
  readonly id: string;
  readonly ppeItemId: string;
  readonly size: string | null;
  readonly quantity: number;
  readonly reason: PpeReason;
  /** Prefilled from the person's kit. */
  readonly fromKit: boolean;
}

export const itemName = (
  item: Pick<PpeItem, "name" | "nameI18n">,
  locale: string,
): string => item.nameI18n?.[locale]?.trim() || item.name;

/** The tiles in order: the common items first (in the design's order), then the rest by name in the screen's language. */
export function tileOrder(
  items: readonly PpeItem[],
  locale: string,
): PpeItem[] {
  const rank = (item: PpeItem) => {
    const kind = commonKindOf(item.code);
    return kind === null ? COMMON_KINDS.length : COMMON_KINDS.indexOf(kind);
  };
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      itemName(a, locale).localeCompare(itemName(b, locale), locale),
  );
}

/** factory-domain `normalPpeCode`: a scanned item code, in capitals. */
export const normalCode = (code: string): string => code.trim().toUpperCase();

/** The item a scanned code names (its own code), or null. */
export const itemByCode = (
  items: readonly PpeItem[],
  code: string,
): PpeItem | null =>
  items.find((item) => item.code === normalCode(code)) ?? null;

/** A sized item waits for its size; a one-size item takes none (factory-domain `lineProblems`). */
export const needsSize = (
  line: Pick<PpeLine, "size">,
  item: Pick<PpeItem, "sizes"> | undefined,
): boolean =>
  item !== undefined &&
  item.sizes.length > 0 &&
  (line.size === null || !item.sizes.includes(line.size));

/** Why a new line is a replacement: the person already holds this item; else it is new. Lost is said by hand. */
export const defaultReason = (
  kit: readonly KitLine[],
  ppeItemId: string,
): PpeReason =>
  (kit.find((line) => line.ppeItemId === ppeItemId)?.held ?? 0) > 0
    ? "REPLACEMENT"
    : "NEW";

/** The kit's missing items, prefilled (each its missing count, new); items no longer in the catalogue are left out. */
export function linesFromKit(
  kit: readonly KitLine[],
  items: readonly PpeItem[],
  idOf: (index: number) => string,
): PpeLine[] {
  const known = new Map(items.map((item) => [item.id, item]));
  return kit
    .filter((line) => line.missing > 0 && known.has(line.ppeItemId))
    .slice(0, LINES_MAX)
    .map((line, index) => {
      const item = known.get(line.ppeItemId)!;
      return {
        id: idOf(index),
        ppeItemId: line.ppeItemId,
        size: item.sizes.length === 1 ? item.sizes[0]! : null,
        quantity: Math.min(QUANTITY_MAX, line.missing),
        reason: "NEW" as const,
        fromKit: true,
      };
    });
}

/** The line a tile (or a scanned code) opens: the item's line still without a size, else a new one of 1. */
export function lineForItem(
  lines: readonly PpeLine[],
  item: PpeItem,
  kit: readonly KitLine[],
  id: string,
): { lines: PpeLine[]; lineId: string } {
  const open = lines.find(
    (line) => line.ppeItemId === item.id && needsSize(line, item),
  );
  if (open) return { lines: [...lines], lineId: open.id };
  if (item.sizes.length === 0) {
    const same = lines.find((line) => line.ppeItemId === item.id);
    if (same) return { lines: [...lines], lineId: same.id };
  }
  const line: PpeLine = {
    id,
    ppeItemId: item.id,
    size: item.sizes.length === 1 ? item.sizes[0]! : null,
    quantity: 1,
    reason: defaultReason(kit, item.id),
    fromKit: false,
  };
  return { lines: [...lines, line], lineId: id };
}

export const updateLine = (
  lines: readonly PpeLine[],
  lineId: string,
  change: Partial<Pick<PpeLine, "size" | "quantity" | "reason">>,
): PpeLine[] =>
  lines.map((line) => (line.id === lineId ? { ...line, ...change } : line));

export const stepQuantity = (quantity: number, delta: 1 | -1): number =>
  Math.min(QUANTITY_MAX, Math.max(1, quantity + delta));

/**
 * A size picked: the line takes it; another line of the same item and size takes this one's units instead (one line per item and
 * size: factory-domain `lineProblems`). Answers the lines and the line that now holds them.
 */
export function withSize(
  lines: readonly PpeLine[],
  lineId: string,
  size: string,
): { lines: PpeLine[]; lineId: string } {
  const line = lines.find((entry) => entry.id === lineId);
  if (!line) return { lines: [...lines], lineId };
  const twin = lines.find(
    (entry) =>
      entry.id !== lineId &&
      entry.ppeItemId === line.ppeItemId &&
      entry.size === size,
  );
  if (!twin) return { lines: updateLine(lines, lineId, { size }), lineId };
  return {
    lines: lines
      .filter((entry) => entry.id !== lineId)
      .map((entry) =>
        entry.id === twin.id
          ? {
              ...entry,
              quantity: Math.min(QUANTITY_MAX, entry.quantity + line.quantity),
            }
          : entry,
      ),
    lineId: twin.id,
  };
}

/** The next line still waiting for its size (the wizard walks them), or null. */
export const nextUnsized = (
  lines: readonly PpeLine[],
  items: readonly PpeItem[],
): string | null =>
  lines.find((line) =>
    needsSize(
      line,
      items.find((item) => item.id === line.ppeItemId),
    ),
  )?.id ?? null;

export type ReceiveHeld = "offline" | "empty" | "size" | "tooMany" | null;

/** Why the person cannot sign yet. */
export function receiveHeld(input: {
  readonly online: boolean;
  readonly lines: readonly PpeLine[];
  readonly items: readonly PpeItem[];
}): ReceiveHeld {
  if (input.lines.length === 0) return "empty";
  if (input.lines.length > LINES_MAX) return "tooMany";
  if (nextUnsized(input.lines, input.items) !== null) return "size";
  return input.online ? null : "offline";
}

/** The lines as POST /safety/floor/ppe/receive takes them. */
export const receiveLines = (
  lines: readonly PpeLine[],
): {
  ppeItemId: string;
  size: string | null;
  quantity: number;
  reason: PpeReason;
}[] =>
  lines.map((line) => ({
    ppeItemId: line.ppeItemId,
    size: line.size,
    quantity: line.quantity,
    reason: line.reason,
  }));

export const unitsOf = (lines: readonly PpeLine[]): number =>
  lines.reduce((sum, line) => sum + line.quantity, 0);

/** How many of the kit's items the person lacks (a count on the card, never a figure in a list). */
export const missingCount = (kit: readonly KitLine[]): number =>
  kit.filter((line) => line.missing > 0).length;

// ---- refusals --------------------------------------------------------------------------------------------------------------

/** The refusals this screen has its own words for (B-W2b-139 RECORDS_REFUSALS, B-W2b-134 PPE_REFUSALS); any other shows the API's. */
export const KNOWN_REFUSALS = [
  // training attendance
  "SESSION_STOPPED",
  "ATTENDED_ALREADY",
  "PERSON_NOT_ACTIVE",
  "PERSON_OTHER_COMPANY",
  "NO_EMPLOYEE",
  "NOT_THE_TRAINER",
  "NO_TRAINER_WORKER",
  "COUNTERSIGNED_ALREADY",
  "ATTENDANCE_VOIDED",
  "NOT_OF_SESSION",
  // receive PPE
  "NOT_ACTIVE",
  "OTHER_COMPANY",
] as const;
export const isKnownRefusal = (code: string): boolean =>
  (KNOWN_REFUSALS as readonly string[]).includes(code);

// ---- a PIN that did not sign -----------------------------------------------------------------------------------------------

/**
 * Why the PIN did not sign, for the pad: the floor sign-in's one answer for a wrong badge, a wrong PIN or a locked person (a 401
 * while the tablet's own session still stands), too many tries, no network, no answer.
 */
export type PinProblem =
  "wrong" | "rateLimited" | "offline" | "unavailable" | null;
