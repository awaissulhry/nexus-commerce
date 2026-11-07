"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirmFeedback } from "@nexus/ui/floor";
import { newIdempotencyKey } from "../../../lib/api/client";
import { useLiveChanges } from "../../../record-panels/live";
import { useFloor, useFloorRouter } from "../../FloorApp";
import { useFloorKeys } from "../../keys";
import type { TaskProblem } from "../shared/task-api";
import {
  badgeOwner,
  countersign,
  readItems,
  readPerson,
  readSession,
  readSessions,
  receivePpe,
  signAttendance,
  signedOrWrong,
} from "./api";
import {
  allUnderstood,
  checksDone,
  countersignLines,
  credentialsOf,
  itemByCode,
  lineForItem,
  linesFromKit,
  localeIn,
  nextUnsized,
  receiveHeld,
  receiveLines,
  stepQuantity,
  updateLine,
  waitingCountersign,
  withSize,
  type PpeItem,
  type PpeLine,
  type RosterPerson,
  type Signer,
} from "./model";
import {
  TrainingView,
  type PpePerson,
  type TrainingAction,
  type TrainingStep,
} from "./view/TrainingView";

/**
 * The live SCR-231 (`/floor/training`; B-W2b-145 on the merged API of B-W2b-139 and B-W2b-134). Online only, by those steps'
 * rule: a signature is the person's own PIN proved by the office at that moment, never queued or kept on the tablet. The PIN goes
 * in its one request and never into this component's state.
 *
 *   Training attendance  the site's open sessions (one: it opens at once) → a badge (its owner named first, by the office) or a
 *                        name from the tablet's list → the person's PIN signs; the list fills and the next worker scans. The
 *                        trainer: the language check per person, then their PIN countersigns. Live `training_session.changed`
 *                        / `training_attendance.changed` (the reconnect, and a 30 s beat for a missed hint) read the session
 *                        again: closed or cancelled in the office, signing stops with the reason, even under a PIN pad.
 *   Receive PPE          a badge or a name → who, their role's kit against what they hold (the missing items prefilled) → items
 *                        (a tile, or the item's own code scanned) → size → how many → their PIN signs the receipt
 *
 * Each signature keeps one Idempotency-Key until it is answered: a resend after a lost answer gets the first answer, never a
 * second signature.
 */

const LIVE = new Set([
  "training_session.changed",
  "training_attendance.changed",
]);
const BEAT_MS = 30_000;
const CHANGED_MEANWHILE = new Set([
  "COUNTERSIGNED_ALREADY",
  "ATTENDANCE_VOIDED",
  "NOT_OF_SESSION",
]);
let lineSeq = 0;
const lineId = () => `line-${(lineSeq += 1)}`;

export function FloorTraining() {
  const store = useFloor();
  const router = useFloorRouter();
  const feedback = useConfirmFeedback();
  const { frame, onFrame } = store.frame("tile.training", { showHome: true });
  const { api, me, online, sessionEnded, device } = store;
  const [step, setStep] = useState<TrainingStep>({ kind: "mode" });
  const current = useRef(step);
  current.current = step;
  /** The session list came first (more than one open session): Back goes to it, else to the two tiles. */
  const fromList = useRef(false);
  /** The PPE catalogue of the site's company, read once a visit. */
  const items = useRef<{
    value: PpeItem[] | null;
    problem: TaskProblem | null;
    reading: Promise<void> | null;
  }>({ value: null, problem: null, reading: null });
  /** One signature's key, kept until it is answered. */
  const pending = useRef<{ what: string; key: string } | null>(null);
  const roster: RosterPerson[] = useMemo(
    () =>
      (device?.roster ?? []).map((person) => ({
        id: person.id,
        name: person.displayName,
        locale: person.locale,
      })),
    [device],
  );

  const keyFor = (what: string): string => {
    if (pending.current?.what !== what)
      pending.current = { what, key: newIdempotencyKey() };
    return pending.current.key;
  };

  const ended = useCallback(
    (problem: TaskProblem | null | undefined): boolean => {
      if (problem?.kind !== "signedOut") return false;
      void sessionEnded();
      return true;
    },
    [sessionEnded],
  );

  // ---- Training attendance --------------------------------------------------------------------------------------------------

  const openSession = useCallback(
    async (
      sessionId: string,
      extra: Partial<Extract<TrainingStep, { kind: "session" }>> = {},
    ) => {
      const shown = current.current;
      const before =
        "view" in shown && shown.view?.session.id === sessionId
          ? shown.view
          : null;
      setStep({ kind: "session", view: before, ...extra });
      const answer = await readSession(api, sessionId);
      if (!answer.ok) {
        if (ended(answer.problem)) return;
        return setStep({
          kind: "session",
          view: before,
          problem: before ? null : answer.problem,
          ...extra,
        });
      }
      setStep((now) =>
        now.kind === "session" &&
        (now.view === null || now.view.session.id === sessionId)
          ? { ...now, view: answer.value, problem: null }
          : now,
      );
    },
    [api, ended],
  );

  const loadSessions = useCallback(async () => {
    setStep({ kind: "sessions", sessions: null });
    const answer = await readSessions(api);
    if (!answer.ok) {
      if (ended(answer.problem)) return;
      return setStep({
        kind: "sessions",
        sessions: null,
        problem: answer.problem,
      });
    }
    if (answer.value.length === 1) {
      fromList.current = false;
      return void openSession(answer.value[0]!.id);
    }
    fromList.current = true;
    setStep({ kind: "sessions", sessions: answer.value });
  }, [api, ended, openSession]);

  /** A live hint or the reconnect: the session (or the list) on screen is read again; a PIN pad stays, held if signing stopped. */
  const refresh = useCallback(async () => {
    const shown = current.current;
    if (shown.kind === "sessions" && shown.sessions !== null) {
      const answer = await readSessions(api);
      if (answer.ok)
        setStep((now) =>
          now.kind === "sessions" ? { ...now, sessions: answer.value } : now,
        );
      return;
    }
    const view = "view" in shown ? shown.view : null;
    if (
      !view ||
      (shown.kind !== "session" &&
        shown.kind !== "sign" &&
        shown.kind !== "check" &&
        shown.kind !== "countersign")
    )
      return;
    const answer = await readSession(api, view.session.id);
    if (!answer.ok) return;
    setStep((now) => {
      if (
        !("view" in now) ||
        !now.view ||
        now.view.session.id !== view.session.id
      )
        return now;
      // The trainer's checks keep only the people still waiting.
      if (now.kind === "check" || now.kind === "countersign") {
        const waiting = new Set(
          waitingCountersign(answer.value.attendances).map(
            (attendance) => attendance.id,
          ),
        );
        return {
          ...now,
          view: answer.value,
          checks: Object.fromEntries(
            Object.entries(now.checks).filter(([id]) => waiting.has(id)),
          ),
        };
      }
      return { ...now, view: answer.value } as TrainingStep;
    });
  }, [api]);

  const watching =
    step.kind === "sessions" ||
    step.kind === "session" ||
    step.kind === "sign" ||
    step.kind === "check" ||
    step.kind === "countersign";
  useLiveChanges(
    {
      onChange: (change) => void (LIVE.has(change.type) && refresh()),
      onReconnect: () => void refresh(),
    },
    watching,
  );
  // A beat while a session is on screen: a live hint can be missed (the stream down, no dispatcher), and the office's close must
  // still stop signing here.
  useEffect(() => {
    if (!watching || !online) return;
    const timer = window.setInterval(() => void refresh(), BEAT_MS);
    return () => window.clearInterval(timer);
  }, [watching, online, refresh]);

  const badgeForSession = async (code: string) => {
    const shown = current.current;
    if (shown.kind !== "session" || !shown.view) return;
    const view = shown.view;
    setStep({ ...shown, badge: "reading", badgeProblem: null, done: null });
    const owner = await badgeOwner(api, code);
    if (!owner.ok) {
      if (ended(owner.problem)) return;
      feedback("error");
      return setStep((now) =>
        now.kind === "session"
          ? {
              ...now,
              badge: owner.problem.kind === "notFound" ? "unknown" : null,
              badgeProblem:
                owner.problem.kind === "notFound" ? null : owner.problem,
            }
          : now,
      );
    }
    const signer: Signer = {
      kind: "badge",
      code,
      workerId: owner.value.id,
      name: owner.value.displayName,
      locale: localeIn(roster, owner.value.id),
    };
    setStep({ kind: "sign", view, signer });
  };

  const sign = async (pin: string) => {
    const shown = current.current;
    if (shown.kind !== "sign" || shown.busy) return;
    const { view, signer } = shown;
    setStep({ ...shown, busy: true, pinProblem: null, problem: null });
    const key = keyFor(
      `sign:${view.session.id}:${signer.kind === "badge" ? signer.code : signer.workerId}`,
    );
    const done = await signAttendance(
      api,
      view.session.id,
      credentialsOf(signer),
      pin,
      key,
    );
    if (done.ok) {
      pending.current = null;
      feedback("success");
      return void openSession(view.session.id, {
        done: {
          kind: "signed",
          name: done.value.attendance.worker.displayName,
          at: done.value.attendance.signedAt,
        },
      });
    }
    feedback("error");
    if (
      done.problem.kind === "refused" &&
      done.problem.code === "SESSION_STOPPED"
    )
      return void openSession(view.session.id);
    const failure = await signedOrWrong(api, done.problem);
    if (failure.kind === "ended") return void sessionEnded();
    setStep((now) =>
      now.kind === "sign"
        ? {
            ...now,
            busy: false,
            ...(failure.kind === "pin"
              ? { pinProblem: failure.problem }
              : { problem: failure.problem }),
          }
        : now,
    );
  };

  const countersignNow = async (pin: string) => {
    const shown = current.current;
    if (shown.kind !== "countersign" || shown.busy) return;
    const { view, checks } = shown;
    const trainerWorkerId = view.trainer.workerId;
    if (!trainerWorkerId) return;
    const lines = countersignLines(
      waitingCountersign(view.attendances),
      checks,
    );
    setStep({ ...shown, busy: true, pinProblem: null, problem: null });
    const key = keyFor(
      `countersign:${view.session.id}:${lines.map((line) => `${line.attendanceId}=${line.languageUnderstood}`).join(",")}`,
    );
    const done = await countersign(
      api,
      view.session.id,
      trainerWorkerId,
      pin,
      lines,
      key,
    );
    if (done.ok) {
      pending.current = null;
      feedback("success");
      return void openSession(view.session.id, {
        done: {
          kind: "countersigned",
          count: done.value.attendanceIds.length,
          at: new Date().toISOString(),
        },
      });
    }
    feedback("error");
    if (
      done.problem.kind === "refused" &&
      done.problem.code === "SESSION_STOPPED"
    )
      return void openSession(view.session.id);
    // Someone else's change meanwhile (countersigned or voided in the office): the list is read again under the refusal.
    if (
      done.problem.kind === "refused" &&
      CHANGED_MEANWHILE.has(done.problem.code)
    )
      void refresh();
    const failure = await signedOrWrong(api, done.problem);
    if (failure.kind === "ended") return void sessionEnded();
    setStep((now) =>
      now.kind === "countersign"
        ? {
            ...now,
            busy: false,
            ...(failure.kind === "pin"
              ? { pinProblem: failure.problem }
              : { problem: failure.problem }),
          }
        : now,
    );
  };

  // ---- Receive PPE -----------------------------------------------------------------------------------------------------------

  const loadItems = useCallback(async () => {
    if (items.current.value) return;
    if (!items.current.reading) {
      items.current.reading = (async () => {
        const answer = await readItems(api);
        items.current = answer.ok
          ? { value: answer.value, problem: null, reading: null }
          : { value: null, problem: answer.problem, reading: null };
      })();
    }
    await items.current.reading;
  }, [api]);

  const startPpe = () => {
    setStep({ kind: "ppeWho" });
    void loadItems();
  };

  const readReceiver = async (signer: Signer) => {
    setStep({ kind: "ppeWho", reading: true });
    const [person] = await Promise.all([
      readPerson(api, credentialsOf(signer)),
      loadItems(),
    ]);
    if (!person.ok) {
      if (ended(person.problem)) return;
      feedback("error");
      return setStep({
        kind: "ppeWho",
        unknown: person.problem.kind === "notFound",
        problem: person.problem.kind === "notFound" ? null : person.problem,
      });
    }
    const named: Signer =
      signer.kind === "badge"
        ? {
            ...signer,
            workerId: person.value.worker.id,
            name: person.value.worker.displayName,
            locale: localeIn(roster, person.value.worker.id),
          }
        : signer;
    const receiver: PpePerson = {
      signer: named,
      name: person.value.worker.displayName,
      role: person.value.role,
      kit: person.value.kit,
      statement: person.value.statement,
    };
    const catalogue = items.current.value;
    const lines = catalogue
      ? linesFromKit(receiver.kit, catalogue, () => lineId())
      : [];
    setStep({
      kind: "ppeItems",
      person: receiver,
      lines,
      items: catalogue,
      itemsProblem: items.current.problem,
    });
  };

  /** The item's line done: the next line still without a size, else the PIN (nothing left to choose), else the list. */
  const afterLine = (
    person: PpePerson,
    lines: readonly PpeLine[],
    catalogue: readonly PpeItem[],
  ) => {
    const next = nextUnsized(lines, catalogue);
    if (next)
      return setStep({
        kind: "ppeLine",
        person,
        lines,
        items: catalogue,
        lineId: next,
      });
    if (
      lines.length > 0 &&
      receiveHeld({ online: true, lines, items: catalogue }) === null
    )
      return setStep({ kind: "ppeSign", person, lines, items: catalogue });
    setStep({ kind: "ppeItems", person, lines, items: catalogue });
  };

  const addItem = (item: PpeItem) => {
    const shown = current.current;
    if (shown.kind !== "ppeItems" || !shown.items) return;
    const added = lineForItem(shown.lines, item, shown.person.kit, lineId());
    setStep({
      kind: "ppeLine",
      person: shown.person,
      lines: added.lines,
      items: shown.items,
      lineId: added.lineId,
    });
  };

  const receive = async (pin: string) => {
    const shown = current.current;
    if (shown.kind !== "ppeSign" || shown.busy) return;
    const { person, lines } = shown;
    setStep({ ...shown, busy: true, pinProblem: null, problem: null });
    const body = receiveLines(lines);
    const key = keyFor(
      `receive:${person.signer.kind === "badge" ? person.signer.code : person.signer.workerId}:${JSON.stringify(body)}`,
    );
    const done = await receivePpe(
      api,
      credentialsOf(person.signer),
      pin,
      body,
      key,
    );
    if (done.ok) {
      pending.current = null;
      feedback("success");
      return setStep({
        kind: "ppeDone",
        person,
        lines,
        items: shown.items,
        receipt: {
          issuedAt: done.value.issuedAt,
          units: done.value.units,
          statement: done.value.statement,
        },
      });
    }
    feedback("error");
    const failure = await signedOrWrong(api, done.problem);
    if (failure.kind === "ended") return void sessionEnded();
    setStep((now) =>
      now.kind === "ppeSign"
        ? {
            ...now,
            busy: false,
            ...(failure.kind === "pin"
              ? { pinProblem: failure.problem }
              : { problem: failure.problem }),
          }
        : now,
    );
  };

  // ---- moves --------------------------------------------------------------------------------------------------------------------

  const back = () => {
    const shown = current.current;
    switch (shown.kind) {
      case "mode":
        return router.push("/floor");
      case "sessions":
      case "ppeWho":
        return setStep({ kind: "mode" });
      case "session":
        if (shown.names) return setStep({ ...shown, names: false });
        return fromList.current
          ? void loadSessions()
          : setStep({ kind: "mode" });
      case "sign":
      case "check":
        return void openSession(shown.view.session.id);
      case "countersign":
        if (shown.busy) return;
        return shown.problem
          ? void openSession(shown.view.session.id)
          : setStep({ kind: "check", view: shown.view, checks: shown.checks });
      case "ppeItems":
        return setStep({ kind: "ppeWho" });
      case "ppeLine":
        return setStep({
          kind: "ppeItems",
          person: shown.person,
          lines: shown.lines,
          items: shown.items,
        });
      case "ppeSign":
        if (shown.busy) return;
        return setStep({
          kind: "ppeItems",
          person: shown.person,
          lines: shown.lines,
          items: shown.items,
        });
      case "ppeDone":
        return startPpe();
    }
  };

  const onAction = (action: TrainingAction) => {
    const shown = current.current;
    switch (action.type) {
      case "job":
        if (!online) return;
        return action.job === "training" ? void loadSessions() : startPpe();
      case "openSession":
        if (!online) return;
        return void openSession(action.sessionId);
      case "back":
        return back();
      case "home":
        return router.push("/floor");
      case "retry":
        if (shown.kind === "sessions") return void loadSessions();
        if (shown.kind === "session" && shown.view)
          return void openSession(shown.view.session.id);
        if (shown.kind === "session") return void loadSessions();
        return;
      case "badge":
        if (!online) return;
        if (shown.kind === "session") return void badgeForSession(action.code);
        if (shown.kind === "ppeWho" && !shown.reading)
          return void readReceiver({
            kind: "badge",
            code: action.code,
            workerId: null,
            name: null,
            locale: null,
          });
        return;
      case "names":
        if (shown.kind === "session" || shown.kind === "ppeWho")
          return setStep({ ...shown, names: action.open } as TrainingStep);
        return;
      case "pickName": {
        const signer: Signer = {
          kind: "name",
          workerId: action.workerId,
          name: action.name,
          locale: localeIn(roster, action.workerId),
        };
        if (shown.kind === "session" && shown.view)
          return setStep({ kind: "sign", view: shown.view, signer });
        if (shown.kind === "ppeWho") return void readReceiver(signer);
        return;
      }
      case "pin":
        if (shown.kind === "sign") return void sign(action.pin);
        if (shown.kind === "countersign")
          return void countersignNow(action.pin);
        if (shown.kind === "ppeSign") return void receive(action.pin);
        return;
      case "notYou":
        if (shown.kind === "sign" || shown.kind === "countersign")
          return void openSession(shown.view.session.id);
        if (shown.kind === "ppeSign") return setStep({ kind: "ppeWho" });
        return;
      case "countersign":
        if (shown.kind === "session" && shown.view)
          return setStep({ kind: "check", view: shown.view, checks: {} });
        return;
      case "check":
        if (shown.kind === "check")
          return setStep({
            ...shown,
            checks: {
              ...shown.checks,
              [action.attendanceId]: action.understood,
            },
          });
        return;
      case "checkAll":
        if (shown.kind === "check")
          return setStep({
            ...shown,
            checks: allUnderstood(waitingCountersign(shown.view.attendances)),
          });
        return;
      case "toPin":
        if (
          shown.kind === "check" &&
          checksDone(
            waitingCountersign(shown.view.attendances),
            shown.checks,
          ) &&
          online
        )
          return setStep({
            kind: "countersign",
            view: shown.view,
            checks: shown.checks,
          });
        return;
      case "item": {
        const item =
          shown.kind === "ppeItems"
            ? shown.items?.find((entry) => entry.id === action.ppeItemId)
            : undefined;
        if (item) addItem(item);
        return;
      }
      case "itemCode": {
        if (shown.kind !== "ppeItems" || !shown.items) return;
        const item = itemByCode(shown.items, action.code);
        if (item) return addItem(item);
        feedback("error");
        return setStep({ ...shown, unknownCode: action.code.trim() });
      }
      case "openLine":
        if (shown.kind === "ppeItems" && shown.items)
          return setStep({
            kind: "ppeLine",
            person: shown.person,
            lines: shown.lines,
            items: shown.items,
            lineId: action.lineId,
          });
        return;
      case "size": {
        if (shown.kind !== "ppeLine") return;
        const sized = withSize(shown.lines, shown.lineId, action.size);
        if (action.advance)
          return afterLine(shown.person, sized.lines, shown.items);
        return setStep({ ...shown, lines: sized.lines, lineId: sized.lineId });
      }
      case "quantity": {
        if (shown.kind !== "ppeLine") return;
        const line = shown.lines.find((entry) => entry.id === shown.lineId);
        if (line)
          setStep({
            ...shown,
            lines: updateLine(shown.lines, line.id, {
              quantity: stepQuantity(line.quantity, action.delta),
            }),
          });
        return;
      }
      case "reason":
        if (shown.kind === "ppeLine")
          setStep({
            ...shown,
            lines: updateLine(shown.lines, shown.lineId, {
              reason: action.reason,
            }),
          });
        return;
      case "removeLine":
        if (shown.kind === "ppeLine" || shown.kind === "ppeItems") {
          const catalogue = shown.items ?? [];
          return setStep({
            kind: "ppeItems",
            person: shown.person,
            lines: shown.lines.filter((line) => line.id !== action.lineId),
            items: catalogue,
          });
        }
        return;
      case "lineDone":
        if (shown.kind === "ppeLine")
          afterLine(shown.person, shown.lines, shown.items);
        return;
      case "sign":
        if (
          shown.kind === "ppeItems" &&
          shown.items &&
          receiveHeld({ online, lines: shown.lines, items: shown.items }) ===
            null
        )
          return setStep({
            kind: "ppeSign",
            person: shown.person,
            lines: shown.lines,
            items: shown.items,
          });
        return;
      case "changeItems":
        if (shown.kind === "ppeSign" && !shown.busy)
          return setStep({
            kind: "ppeItems",
            person: shown.person,
            lines: shown.lines,
            items: shown.items,
          });
        return;
      case "nextPerson":
        return startPpe();
    }
  };

  // Back online: a read the network stopped is tried again.
  useEffect(() => {
    if (!online) return;
    const shown = current.current;
    if (shown.kind === "sessions" && shown.problem?.kind === "offline")
      void loadSessions();
    else if (
      shown.kind === "session" &&
      shown.view === null &&
      shown.problem?.kind === "offline"
    )
      void loadSessions();
    else void refresh();
  }, [online, loadSessions, refresh]);

  const enter = (): (() => void) | null => {
    const shown = current.current;
    if (shown.kind === "check") return () => onAction({ type: "toPin" });
    if (shown.kind === "ppeItems") return () => onAction({ type: "sign" });
    if (shown.kind === "ppeLine") return () => onAction({ type: "lineDone" });
    if (shown.kind === "ppeDone") return () => onAction({ type: "nextPerson" });
    return null;
  };
  useFloorKeys({ enter: enter(), escape: back });

  if (!me) return null;
  return (
    <TrainingView
      model={{ frame, online, roster, step }}
      onAction={onAction}
      onFrame={onFrame}
    />
  );
}
