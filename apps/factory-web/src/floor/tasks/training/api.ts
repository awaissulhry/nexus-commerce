import { z } from "zod";
import type { ApiClient } from "../../../lib/api/client";
import { fetchMe } from "../../api";
import {
  floorRead,
  floorWrite,
  seg,
  type TaskOutcome,
  type TaskProblem,
} from "../shared/task-api";
import { SESSION_STATUSES, type PinProblem, type PpeReason } from "./model";

/**
 * Training & PPE sign-off's calls (B-W2b-145 on the merged API of B-W2b-139, apps/factory-api modules/safety/records/floor.ts,
 * and B-W2b-134, modules/safety/ppe/floor.ts; floor.work at the tablet's own site). Online only: none of them queues.
 *
 *   GET  /safety/floor/training/sessions                  the site's OPEN sessions with how many signed
 *   GET  /safety/floor/training/sessions/:id              one session: who signed (floor names), countersigned or not, the
 *                                                         trainer's floor sign-in here, the words signed (it/en); closed or
 *                                                         cancelled: why
 *   POST /safety/floor/training/instruction/pending       a scanned badge → whose it is (and their unsigned instruction entries,
 *                                                         not used here). No PIN, nothing written: the only floor read that names
 *                                                         a badge's person before they sign
 *   POST /safety/floor/training/sessions/:id/sign         {badgeCode | workerId, pin}: the person's own PIN signs
 *   POST /safety/floor/training/sessions/:id/countersign  {workerId, pin, attendances}: the trainer's own PIN, each person's
 *                                                         language check
 *   GET  /safety/floor/ppe/items                          the site's company's ACTIVE items (sizes; never a cost)
 *   POST /safety/floor/ppe/person                         {badgeCode | workerId}: who receives, their role's kit against what
 *                                                         they hold, the words they sign in their language
 *   POST /safety/floor/ppe/receive                        {badgeCode | workerId, pin, lines}: the person's own PIN signs the receipt
 *
 * A signature answers 401 for a wrong badge, a wrong PIN or a locked person (the floor sign-in's one answer), which is also how a
 * session that ended answers: `signedOrWrong` asks the tablet's own session to tell them apart. The PIN goes in its one request
 * and never into an answer or the page's state.
 */

const names = z.record(z.string(), z.string()).nullable();
const workerOut = z.object({ id: z.string(), displayName: z.string() });
const statements = z.object({ it: z.string(), en: z.string() });

const floorSession = z.object({
  id: z.string(),
  course: z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    nameI18n: names,
  }),
  heldOn: z.string(),
  hours: z.string(),
  language: z.string(),
  trainerName: z.string(),
  location: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  stopped: z.string().nullable(),
  signed: z.number(),
  countersigned: z.number(),
  version: z.number(),
});
export type FloorSession = z.infer<typeof floorSession>;

const sessionsAnswer = z.object({ sessions: z.array(floorSession) });

export async function readSessions(
  api: ApiClient,
): Promise<TaskOutcome<FloorSession[]>> {
  const answer = await floorRead(api, "/safety/floor/training/sessions", {
    schema: sessionsAnswer,
  });
  return answer.ok ? { ok: true, value: answer.value.sessions } : answer;
}

const sessionAnswer = z.object({
  session: floorSession,
  attendances: z.array(
    z.object({
      id: z.string(),
      displayName: z.string().nullable(),
      method: z.enum(["FLOOR_PIN", "PAPER"]),
      signedAt: z.string(),
      countersigned: z.boolean(),
      languageUnderstood: z.boolean().nullable(),
    }),
  ),
  trainer: z.object({
    name: z.string(),
    workerId: z.string().nullable(),
    countersignsHere: z.boolean(),
  }),
  statements: z.object({ attendance: statements, countersign: statements }),
});
export type SessionView = z.infer<typeof sessionAnswer>;

export const readSession = (
  api: ApiClient,
  sessionId: string,
): Promise<TaskOutcome<SessionView>> =>
  floorRead(api, `/safety/floor/training/sessions/${seg(sessionId)}`, {
    schema: sessionAnswer,
  });

const whoAnswer = z.object({ worker: workerOut });

/** Whose badge this is, before the PIN (404: not known here, or not active). */
export async function badgeOwner(
  api: ApiClient,
  badgeCode: string,
): Promise<TaskOutcome<{ id: string; displayName: string }>> {
  const answer = await floorWrite(
    api,
    "POST",
    "/safety/floor/training/instruction/pending",
    { body: { badgeCode }, schema: whoAnswer },
  );
  return answer.ok ? { ok: true, value: answer.value.worker } : answer;
}

type Credentials =
  { readonly badgeCode: string } | { readonly workerId: string };

const signAnswer = z.object({
  attendance: z.object({
    id: z.string(),
    signedAt: z.string(),
    worker: workerOut,
    statement: z.string(),
    sha256: z.string(),
  }),
  signed: z.number(),
  countersigned: z.number(),
});
export type SignAnswer = z.infer<typeof signAnswer>;

/** The worker's attendance, their own PIN. `key`: the screen's for this one signature (a resend after a lost answer is answered, never signed twice). */
export const signAttendance = (
  api: ApiClient,
  sessionId: string,
  who: Credentials,
  pin: string,
  key: string,
): Promise<TaskOutcome<SignAnswer>> =>
  floorWrite(
    api,
    "POST",
    `/safety/floor/training/sessions/${seg(sessionId)}/sign`,
    { body: { ...who, pin }, schema: signAnswer, idempotencyKey: key },
  );

const countersignAnswer = z.object({
  attendanceIds: z.array(z.string()),
  trainer: workerOut,
  statement: z.string(),
  signed: z.number(),
  countersigned: z.number(),
});
export type CountersignAnswer = z.infer<typeof countersignAnswer>;

export const countersign = (
  api: ApiClient,
  sessionId: string,
  trainerWorkerId: string,
  pin: string,
  attendances: readonly { attendanceId: string; languageUnderstood: boolean }[],
  key: string,
): Promise<TaskOutcome<CountersignAnswer>> =>
  floorWrite(
    api,
    "POST",
    `/safety/floor/training/sessions/${seg(sessionId)}/countersign`,
    {
      body: { workerId: trainerWorkerId, pin, attendances },
      schema: countersignAnswer,
      idempotencyKey: key,
    },
  );

// ---- PPE ------------------------------------------------------------------------------------------------------------------------

const ppeItem = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  nameI18n: names,
  category: z.enum(["CATEGORY_I", "CATEGORY_II", "CATEGORY_III"]),
  standard: z.string().nullable(),
  sizes: z.array(z.string()),
});
const itemsAnswer = z.object({ items: z.array(ppeItem) });

export async function readItems(
  api: ApiClient,
): Promise<TaskOutcome<z.infer<typeof ppeItem>[]>> {
  const answer = await floorRead(api, "/safety/floor/ppe/items", {
    schema: itemsAnswer,
  });
  return answer.ok ? { ok: true, value: answer.value.items } : answer;
}

const personAnswer = z.object({
  worker: workerOut,
  role: z.object({ code: z.string(), name: z.string() }).nullable(),
  kit: z.array(
    z.object({
      ppeItemId: z.string(),
      quantity: z.number(),
      held: z.number(),
      missing: z.number(),
      whenToWear: z.string(),
    }),
  ),
  statement: z.string(),
});
export type PpePersonAnswer = z.infer<typeof personAnswer>;

export const readPerson = (
  api: ApiClient,
  who: Credentials,
): Promise<TaskOutcome<PpePersonAnswer>> =>
  floorWrite(api, "POST", "/safety/floor/ppe/person", {
    body: who,
    schema: personAnswer,
  });

const receiveAnswer = z.object({
  receipt: z.object({
    id: z.string(),
    issuedAt: z.string(),
    issueIds: z.array(z.string()),
    units: z.number(),
    worker: workerOut,
    statement: z.string(),
    sha256: z.string(),
  }),
});
export type ReceiveAnswer = z.infer<typeof receiveAnswer>["receipt"];

export async function receivePpe(
  api: ApiClient,
  who: Credentials,
  pin: string,
  lines: readonly {
    ppeItemId: string;
    size: string | null;
    quantity: number;
    reason: PpeReason;
  }[],
  key: string,
): Promise<TaskOutcome<ReceiveAnswer>> {
  const answer = await floorWrite(api, "POST", "/safety/floor/ppe/receive", {
    body: { ...who, pin, lines },
    schema: receiveAnswer,
    idempotencyKey: key,
  });
  return answer.ok ? { ok: true, value: answer.value.receipt } : answer;
}

// ---- a signature that did not go ------------------------------------------------------------------------------------------------

export type SignFailure =
  | { readonly kind: "pin"; readonly problem: Exclude<PinProblem, null> }
  | { readonly kind: "ended" }
  | { readonly kind: "problem"; readonly problem: TaskProblem };

/**
 * A failed signature, sorted: a 401 is the badge or PIN (wrong, or the person locked) while the tablet's own session still
 * stands; else the session ended. No network, no answer and too many tries stay on the pad; anything else is the screen's.
 */
export async function signedOrWrong(
  api: ApiClient,
  problem: TaskProblem,
): Promise<SignFailure> {
  switch (problem.kind) {
    case "signedOut": {
      const me = await fetchMe(api);
      if (me.ok && me.value === null) return { kind: "ended" };
      return me.ok
        ? { kind: "pin", problem: "wrong" }
        : { kind: "pin", problem: "unavailable" };
    }
    case "rateLimited":
      return { kind: "pin", problem: "rateLimited" };
    case "offline":
      return { kind: "pin", problem: "offline" };
    case "unavailable":
      return { kind: "pin", problem: "unavailable" };
    default:
      return { kind: "problem", problem };
  }
}
