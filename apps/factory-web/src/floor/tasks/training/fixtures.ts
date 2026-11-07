import { defineDesignScreen } from "../../../lib/design/design-screen";
import { DEMO_OPERATOR, onFloor, signedInFrame } from "../../frame/fixtures";
import type { FloorSession, SessionView } from "./api";
import type {
  AttendanceRow,
  KitLine,
  PpeItem,
  PpeLine,
  RosterPerson,
  Signer,
} from "./model";
import {
  TrainingView,
  type PpePerson,
  type TrainingStep,
  type TrainingViewModel,
} from "./view/TrainingView";

/**
 * SCR-231's cases (B-W2b-145; design floor.training, QHS-248, QHS-261): Training or PPE? (two tiles; offline: both held with the
 * reason), Training attendance (the site's open sessions: loading, several, none, the office not answering, no permission; one
 * session: the badge or a name, the list filling, just signed, a badge not known here, the name picker, a tablet with no names,
 * closed or cancelled in the office (signing stops with the reason), offline, an outside trainer, nobody left to countersign;
 * the worker's PIN: ready, checking, wrong, refused (signed already, no employee record), stopped under the pad; the trainer's
 * language check: none answered, one did not understand; the trainer's PIN: ready, refused (not the trainer), countersigned),
 * Receive PPE (who: the badge or a name, reading, not known; what: the kit's missing items prefilled, nothing missing, no role
 * sheet, an unknown code, no items in the catalogue, the office not answering; one item: sizes, one size; the receipt: ready,
 * checking, wrong PIN, refused, offline; signed). Roles: a worker who signs, the trainer, an outside trainer, a person the API
 * refuses. Made-up people, courses and items of a made-up "Demo" plant: no money.
 */

const AT = "2026-11-06T08:42:00.000Z";
const frame = (extra: Partial<TrainingViewModel["frame"]> = {}) =>
  signedInFrame("tile.training", {
    station: { name: "CUT-01 · Taglio 1", site: "Stabilimento Demo Nord" },
    ...extra,
  });

const ROSTER: RosterPerson[] = [
  { id: "worker-ada", name: DEMO_OPERATOR, locale: "it" },
  { id: "worker-paolo", name: "Paolo Demo", locale: "it" },
  { id: "worker-sara", name: "Sara Demo", locale: "en" },
  { id: "worker-bruno", name: "Bruno Demo", locale: "it" },
  { id: "worker-irene", name: "Irene Demo", locale: "it" },
  { id: "worker-marta", name: "Marta Formatrice", locale: "it" },
];

const session = (extra: Partial<FloorSession> = {}): FloorSession => ({
  id: "session-1",
  course: {
    id: "course-gen",
    code: "GEN-4H",
    name: "General worker training",
    nameI18n: {
      it: "Formazione generale lavoratori",
      en: "General worker training",
    },
  },
  heldOn: "2026-11-06",
  hours: "4",
  language: "it",
  trainerName: "Marta Formatrice",
  location: "Sala riunioni",
  status: "OPEN",
  stopped: null,
  signed: 5,
  countersigned: 0,
  version: 3,
  ...extra,
});

const attendance = (
  index: number,
  name: string,
  extra: Partial<AttendanceRow> = {},
): AttendanceRow => ({
  id: `attendance-${index}`,
  displayName: name,
  method: "FLOOR_PIN",
  signedAt: `2026-11-06T08:${String(10 + index * 3).padStart(2, "0")}:00.000Z`,
  countersigned: false,
  languageUnderstood: null,
  ...extra,
});

const SIGNED = [
  attendance(1, DEMO_OPERATOR),
  attendance(2, "Paolo Demo"),
  attendance(3, "Sara Demo"),
  attendance(4, "Bruno Demo", { method: "PAPER" }),
  attendance(5, "Irene Demo"),
];

const STATEMENTS = {
  attendance: {
    it: "Ho partecipato a questa sessione di formazione (art. 37 D.Lgs. 81/2008).",
    en: "I attended this training session (D.Lgs. 81/2008 art. 37).",
  },
  countersign: {
    it: "Ho tenuto questa sessione e, per ogni persona che controfirmo, ho verificato se ha compreso la lingua in cui è stata tenuta (art. 37 c.13).",
    en: "I gave this session and, for each person I countersign, checked whether they understood the language it was given in (art. 37 c.13).",
  },
};

const view = (
  extra: Partial<SessionView> = {},
  sessionExtra: Partial<FloorSession> = {},
): SessionView => ({
  session: session({
    signed: (extra.attendances ?? SIGNED).length,
    ...sessionExtra,
  }),
  attendances: SIGNED,
  trainer: {
    name: "Marta Formatrice",
    workerId: "worker-marta",
    countersignsHere: true,
  },
  statements: STATEMENTS,
  ...extra,
});

const VIEW = view();
const OUTSIDE = view(
  {
    trainer: {
      name: "Studio Sicurezza Demo",
      workerId: null,
      countersignsHere: false,
    },
  },
  { trainerName: "Studio Sicurezza Demo" },
);
const ALL_COUNTERSIGNED = view(
  {
    attendances: SIGNED.map((row) => ({
      ...row,
      countersigned: true,
      languageUnderstood: row.id !== "attendance-3",
    })),
  },
  { countersigned: 5 },
);
const EMPTY_SESSION = view({ attendances: [] });
const CLOSED = view(
  {},
  {
    status: "CLOSED",
    stopped: "This session was closed in the office: signing has stopped.",
  },
);
const CANCELLED = view(
  {},
  {
    status: "CANCELLED",
    stopped:
      "This session was cancelled: the trainer is ill. Signing has stopped.",
  },
);

const SESSIONS: FloorSession[] = [
  session({ signed: 5 }),
  session({
    id: "session-2",
    course: {
      id: "course-cut",
      code: "PRESS-2H",
      name: "Clicking press: specific training",
      nameI18n: {
        it: "Pressa fustellatrice: formazione specifica",
        en: "Clicking press: specific training",
      },
    },
    hours: "2",
    location: null,
    signed: 0,
  }),
  session({
    id: "session-3",
    course: {
      id: "course-fire",
      code: "FIRE-L1",
      name: "Fire warden (level 1)",
      nameI18n: {
        it: "Addetto antincendio (livello 1)",
        en: "Fire warden (level 1)",
      },
    },
    heldOn: "2026-11-07",
    hours: "4",
    trainerName: "Studio Sicurezza Demo",
    signed: 2,
  }),
];

const BADGE_ADA: Signer = {
  kind: "badge",
  code: "DEMOBADGE00000000000000ADA",
  workerId: "worker-ada",
  name: DEMO_OPERATOR,
  locale: "it",
};
const NAME_SARA: Signer = {
  kind: "name",
  workerId: "worker-sara",
  name: "Sara Demo",
  locale: "en",
};

const model = (
  step: TrainingStep,
  extra: Partial<TrainingViewModel> = {},
): TrainingViewModel => ({
  frame: frame(extra.online === false ? { online: false } : {}),
  online: true,
  roster: ROSTER,
  step,
  ...extra,
});

// ---- PPE ----------------------------------------------------------------------------------------------------------------------

const ITEMS: PpeItem[] = [
  {
    id: "ppe-gloves",
    code: "GLOVES-CUT",
    name: "Cut-resistant gloves",
    nameI18n: { it: "Guanti antitaglio", en: "Cut-resistant gloves" },
    category: "CATEGORY_II",
    standard: "EN 388:2016",
    sizes: ["7", "8", "9", "10"],
  },
  {
    id: "ppe-shoes",
    code: "SHOES-S3",
    name: "Safety shoes S3",
    nameI18n: { it: "Scarpe antinfortunistiche S3", en: "Safety shoes S3" },
    category: "CATEGORY_II",
    standard: "EN ISO 20345:2022",
    sizes: ["38", "39", "40", "41", "42", "43", "44", "45", "46"],
  },
  {
    id: "ppe-glasses",
    code: "GLASSES",
    name: "Safety glasses",
    nameI18n: { it: "Occhiali di protezione", en: "Safety glasses" },
    category: "CATEGORY_II",
    standard: "EN 166:2001",
    sizes: [],
  },
  {
    id: "ppe-ear",
    code: "EAR-DEF",
    name: "Hearing protection",
    nameI18n: { it: "Protezione dell’udito", en: "Hearing protection" },
    category: "CATEGORY_III",
    standard: "EN 352-1:2020",
    sizes: [],
  },
  {
    id: "ppe-apron",
    code: "APRON",
    name: "Work apron",
    nameI18n: { it: "Grembiule da lavoro", en: "Work apron" },
    category: "CATEGORY_I",
    standard: "EN ISO 13688:2013",
    sizes: ["S", "M", "L", "XL"],
  },
  {
    id: "ppe-mask",
    code: "MASK-FFP2",
    name: "Filtering half mask FFP2",
    nameI18n: { it: "Facciale filtrante FFP2", en: "Filtering half mask FFP2" },
    category: "CATEGORY_III",
    standard: "EN 149:2001+A1:2009",
    sizes: [],
  },
  {
    id: "ppe-sleeves",
    code: "SLEEVES",
    name: "Cut-resistant sleeves",
    nameI18n: { it: "Manicotti antitaglio", en: "Cut-resistant sleeves" },
    category: "CATEGORY_II",
    standard: "EN 388:2016",
    sizes: [],
  },
];

const KIT: KitLine[] = [
  {
    ppeItemId: "ppe-gloves",
    quantity: 2,
    held: 0,
    missing: 2,
    whenToWear: "At the cutting table",
  },
  {
    ppeItemId: "ppe-shoes",
    quantity: 1,
    held: 1,
    missing: 0,
    whenToWear: "Always",
  },
  {
    ppeItemId: "ppe-ear",
    quantity: 1,
    held: 0,
    missing: 1,
    whenToWear: "At the press",
  },
];

const PERSON: PpePerson = {
  signer: BADGE_ADA,
  name: DEMO_OPERATOR,
  role: { code: "CUT", name: "Tagliatore" },
  kit: KIT,
  statement:
    "Ho ricevuto questi dispositivi di protezione individuale e le relative istruzioni (D.Lgs. 81/2008 art. 77 c.4).",
};
const NO_ROLE: PpePerson = { ...PERSON, role: null, kit: [] };
const COMPLETE: PpePerson = {
  ...PERSON,
  kit: KIT.map((line) => ({ ...line, held: line.quantity, missing: 0 })),
};

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
const FROM_KIT = [
  line("line-1", "ppe-gloves", { quantity: 2, fromKit: true }),
  line("line-2", "ppe-ear", { fromKit: true }),
];
const READY = [
  line("line-1", "ppe-gloves", { quantity: 2, size: "9", fromKit: true }),
  line("line-2", "ppe-ear", { fromKit: true }),
];
const ONE = [
  line("line-3", "ppe-shoes", { size: "42", reason: "REPLACEMENT" }),
];

const items = (
  person: PpePerson,
  lines: readonly PpeLine[],
  extra: Partial<Extract<TrainingStep, { kind: "ppeItems" }>> = {},
): TrainingStep => ({
  kind: "ppeItems",
  person,
  lines,
  items: ITEMS,
  ...extra,
});
const ppeSign = (
  lines: readonly PpeLine[],
  extra: Partial<Extract<TrainingStep, { kind: "ppeSign" }>> = {},
): TrainingStep => ({
  kind: "ppeSign",
  person: PERSON,
  lines,
  items: ITEMS,
  ...extra,
});

export const designScreen = defineDesignScreen<TrainingViewModel>({
  screen: "SCR-231",
  title: "Floor › Training & PPE sign-off",
  view: onFloor(TrainingView),
  cases: [
    // ---- Training or PPE? ------------------------------------------------------------------------------------------------------
    {
      id: "mode",
      label: "Training or PPE? Two tiles",
      model: model({ kind: "mode" }),
      note: "One job per screen after this. Both need the network: a signature is the PIN proved by the office at once.",
    },
    {
      id: "mode-offline",
      label: "Offline: both tiles held with the reason",
      model: model({ kind: "mode" }, { online: false }),
    },

    // ---- Training attendance: the open sessions ------------------------------------------------------------------------------------
    {
      id: "sessions-loading",
      label: "Reading the open sessions",
      model: model({ kind: "sessions", sessions: null }),
    },
    {
      id: "sessions",
      label: "Three open sessions at this site (one opens at once by itself)",
      model: model({ kind: "sessions", sessions: SESSIONS }),
    },
    {
      id: "sessions-empty",
      label: "No session open: the trainer opens it in the office",
      model: model({ kind: "sessions", sessions: [] }),
    },
    {
      id: "sessions-unavailable",
      label: "The office does not answer",
      model: model({
        kind: "sessions",
        sessions: null,
        problem: { kind: "unavailable" },
      }),
    },
    {
      id: "sessions-no-permission",
      label: "A person the API does not let read sessions here",
      model: model({
        kind: "sessions",
        sessions: null,
        problem: { kind: "forbidden", path: null, message: null },
      }),
    },

    // ---- one session ----------------------------------------------------------------------------------------------------------
    {
      id: "session-loading",
      label: "Reading the session",
      model: model({ kind: "session", view: null }),
    },
    {
      id: "session",
      label:
        'A session: scan your badge or pick your name; the list fills ("5 signed")',
      model: model({ kind: "session", view: VIEW }),
      note: "Main: Sign (the badge, then 6 PIN digits) / Countersign (the trainer).",
    },
    {
      id: "session-empty",
      label: "Nobody has signed yet",
      model: model({ kind: "session", view: EMPTY_SESSION }),
    },
    {
      id: "session-signed",
      label: "Just signed: the next person scans",
      model: model({
        kind: "session",
        view: VIEW,
        done: { kind: "signed", name: "Irene Demo", at: AT },
      }),
    },
    {
      id: "session-reading",
      label: "A badge read: the office says whose it is",
      model: model({ kind: "session", view: VIEW, badge: "reading" }),
    },
    {
      id: "session-unknown-badge",
      label: "A badge not known here",
      model: model({ kind: "session", view: VIEW, badge: "unknown" }),
    },
    {
      id: "session-names",
      label: "Pick your name from this tablet’s list",
      model: model({ kind: "session", view: VIEW, names: true }),
    },
    {
      id: "session-no-roster",
      label: "A tablet with no list of names: the badge only",
      model: model({ kind: "session", view: VIEW }, { roster: [] }),
    },
    {
      id: "session-closed",
      label: "Closed in the office: signing has stopped",
      model: model({ kind: "session", view: CLOSED }),
    },
    {
      id: "session-cancelled",
      label: "Cancelled in the office: signing stops, with the reason",
      model: model({ kind: "session", view: CANCELLED }),
    },
    {
      id: "session-offline",
      label: "Offline: signing and countersigning held with the reason",
      model: model({ kind: "session", view: VIEW }, { online: false }),
    },
    {
      id: "session-outside-trainer",
      label: "An outside trainer (no sign-in here): the office countersigns",
      model: model({ kind: "session", view: OUTSIDE }),
    },
    {
      id: "session-countersigned",
      label: "Everyone countersigned (one did not understand the language)",
      model: model({
        kind: "session",
        view: ALL_COUNTERSIGNED,
        done: { kind: "countersigned", count: 5, at: AT },
      }),
    },

    // ---- a worker signs ----------------------------------------------------------------------------------------------------------
    {
      id: "sign",
      label: "Sign your attendance: what it means, who signs, the PIN pad",
      model: model({ kind: "sign", view: VIEW, signer: BADGE_ADA }),
    },
    {
      id: "sign-by-name",
      label: "Signing by name, in the person’s own language (English)",
      model: model({ kind: "sign", view: VIEW, signer: NAME_SARA }),
    },
    {
      id: "sign-busy",
      label: "Checking the PIN",
      model: model({ kind: "sign", view: VIEW, signer: BADGE_ADA, busy: true }),
    },
    {
      id: "sign-wrong",
      label: "Badge or PIN wrong, or the person locked (the one answer)",
      model: model({
        kind: "sign",
        view: VIEW,
        signer: BADGE_ADA,
        pinProblem: "wrong",
      }),
    },
    {
      id: "sign-offline",
      label: "The network went: the pad held with the reason",
      model: model(
        { kind: "sign", view: VIEW, signer: BADGE_ADA },
        { online: false },
      ),
    },
    {
      id: "sign-stopped",
      label: "Closed in the office while the pad was open: held with why",
      model: model({ kind: "sign", view: CLOSED, signer: BADGE_ADA }),
    },
    {
      id: "sign-already",
      label: "Refused: signed this session already",
      model: model({
        kind: "sign",
        view: VIEW,
        signer: BADGE_ADA,
        problem: {
          kind: "refused",
          code: "ATTENDED_ALREADY",
          message: "This person signed this session already.",
          fix: null,
        },
      }),
    },
    {
      id: "sign-no-employee",
      label: "Refused: the sign-in has no person’s record",
      model: model({
        kind: "sign",
        view: VIEW,
        signer: NAME_SARA,
        problem: {
          kind: "refused",
          code: "NO_EMPLOYEE",
          message: "This worker has no employee record.",
          fix: null,
        },
      }),
    },

    // ---- the trainer -------------------------------------------------------------------------------------------------------------
    {
      id: "check",
      label:
        "The trainer: did each person understand the language? (none answered: held)",
      model: model({ kind: "check", view: VIEW, checks: {} }),
      note: 'D.Lgs. 81/2008 art. 37 c.13: no default; "Everyone understood" answers for all at once.',
    },
    {
      id: "check-answered",
      label: "Every person answered, one did not understand",
      model: model({
        kind: "check",
        view: VIEW,
        checks: {
          "attendance-1": true,
          "attendance-2": true,
          "attendance-3": false,
          "attendance-4": true,
          "attendance-5": true,
        },
      }),
    },
    {
      id: "countersign",
      label: "The trainer countersigns with their PIN",
      model: model({
        kind: "countersign",
        view: VIEW,
        checks: {
          "attendance-1": true,
          "attendance-2": true,
          "attendance-3": false,
          "attendance-4": true,
          "attendance-5": true,
        },
      }),
    },
    {
      id: "countersign-not-trainer",
      label: "Refused: only the session’s trainer countersigns",
      model: model({
        kind: "countersign",
        view: VIEW,
        checks: { "attendance-1": true },
        problem: {
          kind: "refused",
          code: "NOT_THE_TRAINER",
          message: "Only the session’s trainer countersigns.",
          fix: null,
        },
      }),
    },

    // ---- Receive PPE -------------------------------------------------------------------------------------------------------------
    {
      id: "ppe-who",
      label: "Receive PPE: scan the badge of the person who receives",
      model: model({ kind: "ppeWho" }),
    },
    {
      id: "ppe-who-names",
      label: "Who receives? A name from this tablet’s list",
      model: model({ kind: "ppeWho", names: true }),
    },
    {
      id: "ppe-who-reading",
      label: "Reading the person and their kit",
      model: model({ kind: "ppeWho", reading: true }),
    },
    {
      id: "ppe-who-unknown",
      label: "A badge not known here",
      model: model({ kind: "ppeWho", unknown: true }),
    },
    {
      id: "ppe-who-offline",
      label: "Offline: held with the reason",
      model: model({ kind: "ppeWho" }, { online: false }),
    },
    {
      id: "ppe-items-kit",
      label: "The kit’s missing items prefilled (the gloves wait for a size)",
      model: model(items(PERSON, FROM_KIT)),
      note: "A tile or the item’s code scanned adds one; Sign is held until each item has its size.",
    },
    {
      id: "ppe-items-ready",
      label: "Everything sized: Sign with PIN",
      model: model(items(PERSON, READY)),
    },
    {
      id: "ppe-items-complete",
      label: "Nothing missing from the kit: pick a tile or scan the item",
      model: model(items(COMPLETE, [])),
    },
    {
      id: "ppe-items-no-role",
      label: "A person with no role sheet: nothing prefilled",
      model: model(items(NO_ROLE, [])),
    },
    {
      id: "ppe-items-unknown-code",
      label: "A scanned code that is no item here",
      model: model(items(COMPLETE, [], { unknownCode: "BOX-0042" })),
    },
    {
      id: "ppe-items-none",
      label: "The company has no PPE items yet",
      model: model(items(NO_ROLE, [], { items: [] })),
    },
    {
      id: "ppe-items-unavailable",
      label: "The items could not be read",
      model: model(
        items(NO_ROLE, [], {
          items: null,
          itemsProblem: { kind: "unavailable" },
        }),
      ),
    },
    {
      id: "ppe-line-size",
      label: "One item: how many, why, the size (a tap on a size adds it)",
      model: model({
        kind: "ppeLine",
        person: PERSON,
        lines: FROM_KIT,
        items: ITEMS,
        lineId: "line-1",
      }),
    },
    {
      id: "ppe-line-one-size",
      label: "A one-size item: how many, why, Done",
      model: model({
        kind: "ppeLine",
        person: PERSON,
        lines: [line("line-4", "ppe-glasses", { reason: "LOST" })],
        items: ITEMS,
        lineId: "line-4",
      }),
    },
    {
      id: "ppe-sign",
      label: "The person signs the receipt with their PIN (their own language)",
      model: model(ppeSign(READY)),
    },
    {
      id: "ppe-sign-one",
      label: "One item (badge → item → size → 6 PIN digits)",
      model: model(ppeSign(ONE)),
    },
    {
      id: "ppe-sign-busy",
      label: "Checking the PIN",
      model: model(ppeSign(READY, { busy: true })),
    },
    {
      id: "ppe-sign-wrong",
      label: "Badge or PIN wrong, or the person locked",
      model: model(ppeSign(READY, { pinProblem: "wrong" })),
    },
    {
      id: "ppe-sign-offline",
      label: "The network went: the pad held with the reason",
      model: model(ppeSign(READY), { online: false }),
    },
    {
      id: "ppe-sign-refused",
      label: "Refused: the person works for another company",
      model: model(
        ppeSign(READY, {
          problem: {
            kind: "refused",
            code: "OTHER_COMPANY",
            message: "This person works for another company than this site’s.",
            fix: null,
          },
        }),
      ),
    },
    {
      id: "ppe-done",
      label: "Receipt signed: the next person",
      model: model({
        kind: "ppeDone",
        person: PERSON,
        lines: READY,
        items: ITEMS,
        receipt: { issuedAt: AT, units: 3, statement: PERSON.statement },
      }),
    },
  ],
});
