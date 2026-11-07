"use client";

import {
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  CircleAlert,
  CloudOff,
  Ear,
  Footprints,
  Glasses,
  GraduationCap,
  Hand,
  HardHat,
  House,
  ListChecks,
  Minus,
  PenLine,
  Plus,
  ScanLine,
  Shirt,
  ShieldCheck,
  Signature,
  Trash2,
  UserCheck,
  UserRound,
  UsersRound,
  Wind,
} from "lucide-react";
import { PinSignBlock } from "@nexus/ui/components/PinSignBlock/index";
import {
  FloorActionBar,
  FloorButton,
  FloorList,
  FloorListRow,
  FloorTile,
  FloorTileGrid,
  ScanInput,
  SizeButtons,
  type FloorAction,
  type FloorActions,
} from "@nexus/ui/floor";
import { FloorNamePicker } from "@nexus/ui/floor/FloorNamePicker/index";
import { ReasonGrid, type ReasonTile } from "@nexus/ui/floor/ReasonGrid/index";
import {
  REASON_KIT_NAMESPACE,
  useReasonWords,
} from "../../../../lib/ds-words/reason-grid";
import { formatDate, formatTime } from "../../../../lib/i18n/format";
import { useDsWords } from "../../../../lib/i18n/ds-parts";
import { INTL_LOCALE } from "../../../../lib/i18n/locales";
import type { Translate } from "../../../../lib/i18n/messages";
import { useLocale, useT } from "../../../../lib/i18n/provider";
import { WithMessages } from "../../../../record-panels/i18n";
import { FloorFacts, type FloorFact } from "../../../frame/view/FloorFacts";
import {
  FloorFrameView,
  type FrameAction,
  type FrameModel,
} from "../../../frame/view/FloorFrameView";
import { FloorState } from "../../../frame/view/FloorState";
import type { TaskProblem } from "../../shared/task-api";
import {
  ListFooter,
  ProblemState,
  TaskLine,
} from "../../shared/view/TaskParts";
import type { FloorSession, SessionView } from "../api";
import {
  checkCounts,
  checksDone,
  commonKindOf,
  countersignHeld,
  isKnownRefusal,
  itemName,
  missingCount,
  needsSize,
  PPE_REASONS,
  QUANTITY_MAX,
  receiveHeld,
  shownLanguage,
  signHeld,
  stopOf,
  tileOrder,
  unitsOf,
  waitingCountersign,
  type AttendanceRow,
  type CommonKind,
  type KitLine,
  type LanguageChecks,
  type PinProblem,
  type PpeItem,
  type PpeLine,
  type PpeReason,
  type RosterPerson,
  type SessionStop,
  type Signer,
} from "../model";
import "../training.css";

/**
 * SCR-231 — Floor › Training & PPE sign-off (B-W2b-145; design floor.training, QHS-248, QHS-261; on the merged API of B-W2b-139 and
 * B-W2b-134): one job per screen inside the floor frame, tablet first, centred.
 *
 *   Training or PPE?     two tiles: Training attendance · Receive PPE (both need the network: a signature is the PIN proved at once)
 *   Training attendance  the site's open sessions → one session: each worker scans their badge (or picks their name) and signs with
 *                        their own PIN; the list fills ("8 signed"); the trainer says for each person whether they understood the
 *                        language, then countersigns with their PIN. Closed or cancelled in the office: signing stops, with why.
 *   Receive PPE          the person's badge (or name) → what to hand over (their kit's missing items prefilled; a tile or the
 *                        item's code adds one) → size → how many (1) → the person signs the receipt with their own PIN
 *
 * Never money; a person's name only inside this one session or receipt. The view fetches nothing: Training.tsx reads and maps.
 */

export type Done =
  | { readonly kind: "signed"; readonly name: string; readonly at: string }
  | {
      readonly kind: "countersigned";
      readonly count: number;
      readonly at: string;
    };

export interface PpePerson {
  readonly signer: Signer;
  readonly name: string;
  readonly role: { readonly code: string; readonly name: string } | null;
  readonly kit: readonly KitLine[];
  /** What they sign, in their language (the API's). */
  readonly statement: string;
}

export type TrainingStep =
  | { readonly kind: "mode" }
  | {
      readonly kind: "sessions";
      readonly sessions: readonly FloorSession[] | null;
      readonly problem?: TaskProblem | null;
    }
  | {
      readonly kind: "session";
      /** Null while it is read. */
      readonly view: SessionView | null;
      readonly problem?: TaskProblem | null;
      /** A badge being read, or not known here. */
      readonly badge?: "reading" | "unknown" | null;
      readonly badgeProblem?: TaskProblem | null;
      /** The tablet's names are open instead of the badge. */
      readonly names?: boolean;
      /** What just happened (the next worker scans). */
      readonly done?: Done | null;
    }
  | {
      readonly kind: "sign";
      readonly view: SessionView;
      readonly signer: Signer;
      readonly busy?: boolean;
      readonly pinProblem?: PinProblem;
      readonly problem?: TaskProblem | null;
    }
  | {
      readonly kind: "check";
      readonly view: SessionView;
      readonly checks: LanguageChecks;
    }
  | {
      readonly kind: "countersign";
      readonly view: SessionView;
      readonly checks: LanguageChecks;
      readonly busy?: boolean;
      readonly pinProblem?: PinProblem;
      readonly problem?: TaskProblem | null;
    }
  | {
      readonly kind: "ppeWho";
      readonly reading?: boolean;
      readonly names?: boolean;
      readonly unknown?: boolean;
      readonly problem?: TaskProblem | null;
    }
  | {
      readonly kind: "ppeItems";
      readonly person: PpePerson;
      readonly lines: readonly PpeLine[];
      readonly items: readonly PpeItem[] | null;
      readonly itemsProblem?: TaskProblem | null;
      readonly unknownCode?: string | null;
    }
  | {
      readonly kind: "ppeLine";
      readonly person: PpePerson;
      readonly lines: readonly PpeLine[];
      readonly items: readonly PpeItem[];
      readonly lineId: string;
    }
  | {
      readonly kind: "ppeSign";
      readonly person: PpePerson;
      readonly lines: readonly PpeLine[];
      readonly items: readonly PpeItem[];
      readonly busy?: boolean;
      readonly pinProblem?: PinProblem;
      readonly problem?: TaskProblem | null;
    }
  | {
      readonly kind: "ppeDone";
      readonly person: PpePerson;
      readonly lines: readonly PpeLine[];
      readonly items: readonly PpeItem[];
      readonly receipt: {
        readonly issuedAt: string;
        readonly units: number;
        readonly statement: string;
      };
    };

export interface TrainingViewModel {
  readonly frame: FrameModel;
  readonly online: boolean;
  readonly timeZone?: string;
  /** The tablet's sign-in list: a name instead of a badge. */
  readonly roster: readonly RosterPerson[];
  readonly step: TrainingStep;
}

export type TrainingAction =
  | { readonly type: "job"; readonly job: "training" | "ppe" }
  | { readonly type: "openSession"; readonly sessionId: string }
  | { readonly type: "back" }
  | { readonly type: "home" }
  | { readonly type: "retry" }
  | { readonly type: "badge"; readonly code: string }
  | { readonly type: "names"; readonly open: boolean }
  | {
      readonly type: "pickName";
      readonly workerId: string;
      readonly name: string;
    }
  | { readonly type: "pin"; readonly pin: string }
  | { readonly type: "notYou" }
  | { readonly type: "countersign" }
  | {
      readonly type: "check";
      readonly attendanceId: string;
      readonly understood: boolean;
    }
  | { readonly type: "checkAll" }
  | { readonly type: "toPin" }
  | { readonly type: "item"; readonly ppeItemId: string }
  | { readonly type: "itemCode"; readonly code: string }
  | { readonly type: "openLine"; readonly lineId: string }
  | { readonly type: "size"; readonly size: string; readonly advance: boolean }
  | { readonly type: "quantity"; readonly delta: 1 | -1 }
  | { readonly type: "reason"; readonly reason: PpeReason }
  | { readonly type: "removeLine"; readonly lineId: string }
  | { readonly type: "lineDone" }
  | { readonly type: "sign" }
  | { readonly type: "changeItems" }
  | { readonly type: "nextPerson" };

export interface TrainingViewProps {
  model: TrainingViewModel;
  onAction?: (action: TrainingAction) => void;
  onFrame?: (action: FrameAction) => void;
}

export function TrainingView(props: TrainingViewProps) {
  return (
    <WithMessages namespaces={[REASON_KIT_NAMESPACE]}>
      <Screen {...props} />
    </WithMessages>
  );
}

/** The icon of a PPE item: the design's common items by a word of their code, else a shield. */
const ITEM_ICON: Readonly<Record<CommonKind, ReactNode>> = {
  gloves: <Hand />,
  shoes: <Footprints />,
  glasses: <Glasses />,
  hearing: <Ear />,
  apron: <Shirt />,
  mask: <Wind />,
};
const itemIcon = (item: Pick<PpeItem, "code"> | undefined): ReactNode => {
  const kind = item ? commonKindOf(item.code) : null;
  return kind ? ITEM_ICON[kind] : <ShieldCheck />;
};

/** A refusal in this screen's words when it knows the code, else the API's. */
const refusalWords = (t: Translate) => (code: string) =>
  isKnownRefusal(code)
    ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) }
    : null;

/** The language a session is held in, in the screen's language ("Italiano"). */
function languageName(code: string, locale: string): string {
  try {
    const name =
      new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    return code;
  }
}

const courseName = (session: FloorSession, locale: string): string =>
  session.course.nameI18n?.[locale]?.trim() || session.course.name;

function stopWords(
  stop: SessionStop,
  t: Translate,
): { title: string; text: string } | null {
  if (!stop) return null;
  if (stop.kind === "closed")
    return { title: t("stopped.title"), text: t("stopped.closed") };
  return {
    title: t("stopped.title"),
    text: stop.reason
      ? t("stopped.cancelledWhy", { reason: stop.reason })
      : t("stopped.cancelled"),
  };
}

function Screen({ model, onAction, onFrame }: TrainingViewProps) {
  const t = useT("floor-training");
  const locale = useLocale();
  const ds = useDsWords();
  const send = (action: TrainingAction) => onAction?.(action);
  const place = { locale, timeZone: model.timeZone };
  const time = (value: string) => formatTime(value, place);
  const day = (value: string) => formatDate(value, place);
  const { step } = model;
  const back: FloorAction = {
    label: t("action.back"),
    icon: <ArrowLeft />,
    variant: "secondary",
    onPress: () => send({ type: "back" }),
  };
  const offlineHeld = model.online ? null : t("held.offline");

  let body: ReactNode = null;
  let actions: FloorActions | null = null;
  let start: string | null = null;

  const sessionFacts = (session: FloorSession): FloorFact[] => [
    { label: t("fact.day"), value: day(session.heldOn) },
    {
      label: t("fact.hours"),
      value: t("fact.hoursValue", { hours: session.hours }),
    },
    {
      label: t("fact.language"),
      value: languageName(session.language, locale),
    },
    { label: t("fact.trainer"), value: session.trainerName },
    ...(session.location
      ? [{ label: t("fact.where"), value: session.location }]
      : []),
  ];

  const sessionHead = (session: FloorSession, id: string) => (
    <header className="fw-tr-head">
      <span className="fw-floor-card-icon" aria-hidden="true">
        <GraduationCap />
      </span>
      <span className="fw-tr-head-text">
        <span className="fw-floor-card-type">{t("session.type")}</span>
        <h2 id={id} className="fw-tr-head-title">
          {courseName(session, locale)}
        </h2>
      </span>
    </header>
  );

  /** The badge, or a name from the tablet's list: who signs next. */
  const whoBlock = (input: {
    label: string;
    hint: string;
    names: boolean;
    reading: boolean;
    unknown: boolean;
    problem: TaskProblem | null;
    held: string | null;
    namesLabel: string;
  }) =>
    input.names ? (
      <div className="fw-floor-stack">
        <FloorNamePicker
          label={input.namesLabel}
          people={model.roster}
          onPick={(workerId, person) =>
            send({ type: "pickName", workerId, name: person.name })
          }
          locale={locale}
          labels={ds.floorNamePicker}
          heldReason={input.held}
        />
        <FloorButton
          size="lg"
          variant="secondary"
          icon={<ScanLine />}
          onClick={() => send({ type: "names", open: false })}
        >
          {t("who.useBadge")}
        </FloorButton>
      </div>
    ) : (
      <div className="fw-floor-stack">
        <ScanInput
          label={input.label}
          hint={input.hint}
          scannedLabel={() => t("who.read")}
          acceptTyped={false}
          disabled={Boolean(input.held) || input.reading}
          onScan={(code) => send({ type: "badge", code })}
        />
        {input.held ? (
          <TaskLine tone="warning" icon={<CloudOff />}>
            {input.held}
          </TaskLine>
        ) : null}
        {input.reading ? (
          <p className="fw-floor-lead" role="status">
            {t("who.reading")}
          </p>
        ) : null}
        {input.unknown ? (
          <TaskLine tone="danger" icon={<CircleAlert />} alert>
            {t("who.unknown")}
          </TaskLine>
        ) : null}
        {input.problem ? <ProblemLine problem={input.problem} t={t} /> : null}
        <FloorButton
          size="lg"
          variant="secondary"
          icon={<UsersRound />}
          heldReason={
            input.held ?? (model.roster.length === 0 ? t("who.noRoster") : null)
          }
          onClick={() => send({ type: "names", open: true })}
        >
          {t("who.byName")}
        </FloorButton>
      </div>
    );

  switch (step.kind) {
    // ---- Training or PPE? ------------------------------------------------------------------------------------------------------
    case "mode": {
      body = (
        <section className="fw-floor-section" aria-labelledby="fw-tr-mode">
          <h2 id="fw-tr-mode" className="fw-floor-section-title">
            {t("mode.title")}
          </h2>
          <FloorTileGrid label={t("mode.title")} columns={2}>
            <FloorTile
              icon={<GraduationCap />}
              label={t("mode.training")}
              hint={t("mode.trainingHint")}
              tone="info"
              heldReason={offlineHeld}
              onPress={() => send({ type: "job", job: "training" })}
            />
            <FloorTile
              icon={<HardHat />}
              label={t("mode.ppe")}
              hint={t("mode.ppeHint")}
              tone="info"
              heldReason={offlineHeld}
              onPress={() => send({ type: "job", job: "ppe" })}
            />
          </FloorTileGrid>
          {model.online ? null : (
            <TaskLine tone="warning" icon={<CloudOff />}>
              {t("mode.offline")}
            </TaskLine>
          )}
          <p className="fw-floor-muted">{t("mode.paper")}</p>
        </section>
      );
      break;
    }

    // ---- the open sessions -----------------------------------------------------------------------------------------------------
    case "sessions": {
      const sessions = step.sessions;
      body = (
        <section className="fw-floor-section" aria-labelledby="fw-tr-sessions">
          <h2 id="fw-tr-sessions" className="fw-floor-section-title">
            {t("sessions.title")}
          </h2>
          {step.problem ? (
            <ProblemState problem={step.problem} words={refusalWords(t)} />
          ) : sessions === null ? (
            <FloorState
              tone="info"
              icon={<GraduationCap />}
              title={t("sessions.loading")}
              busy
            />
          ) : sessions.length === 0 ? (
            <FloorState
              tone="info"
              icon={<GraduationCap />}
              title={t("sessions.empty")}
              text={t("sessions.emptyHint")}
            />
          ) : (
            <>
              <p className="fw-floor-muted">{t("sessions.hint")}</p>
              <FloorList label={t("sessions.title")}>
                {sessions.map((session) => (
                  <FloorListRow
                    key={session.id}
                    icon={<GraduationCap />}
                    tone="info"
                    title={courseName(session, locale)}
                    meta={[
                      day(session.heldOn),
                      t("fact.hoursValue", { hours: session.hours }),
                      session.trainerName,
                      session.location,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    status={t("sessions.signed", { count: session.signed })}
                    heldReason={offlineHeld}
                    onPress={() =>
                      send({ type: "openSession", sessionId: session.id })
                    }
                  />
                ))}
              </FloorList>
              <ListFooter
                count={t("sessions.count", { count: sessions.length })}
                keys={[
                  { key: "Tab", does: t("keys.tab") },
                  { key: "Enter", does: t("keys.open") },
                  { key: "Esc", does: t("keys.back") },
                ]}
              />
            </>
          )}
        </section>
      );
      actions = step.problem
        ? [
            back,
            {
              label: t("action.retry"),
              onPress: () => send({ type: "retry" }),
              heldReason: offlineHeld,
            },
          ]
        : [back];
      break;
    }

    // ---- one session: each worker signs, the list fills --------------------------------------------------------------------------
    case "session": {
      const view = step.view;
      if (!view) {
        body = step.problem ? (
          <ProblemState problem={step.problem} words={refusalWords(t)} />
        ) : (
          <FloorState
            tone="info"
            icon={<GraduationCap />}
            title={t("session.loading")}
            busy
          />
        );
        actions = step.problem
          ? [
              back,
              {
                label: t("action.retry"),
                onPress: () => send({ type: "retry" }),
                heldReason: offlineHeld,
              },
            ]
          : [back];
        break;
      }
      const stop = stopOf(view.session);
      const stopped = stopWords(stop, t);
      const waiting = waitingCountersign(view.attendances);
      const signWhy = signHeld({ online: model.online, stop });
      const countersignWhy = countersignHeld({
        online: model.online,
        stop,
        trainerHere: view.trainer.countersignsHere,
        waiting: waiting.length,
      });
      body = (
        <div className="fw-floor-stack">
          {sessionHead(view.session, "fw-tr-session")}
          <FloorFacts facts={sessionFacts(view.session)} />
          {stopped ? (
            <FloorState
              tone="danger"
              icon={<CircleAlert />}
              title={stopped.title}
              text={stopped.text}
              alert
            />
          ) : (
            <section className="fw-floor-section" aria-labelledby="fw-tr-sign">
              <h3 id="fw-tr-sign" className="fw-floor-subtitle">
                {t("session.signTitle")}
              </h3>
              {step.done ? (
                <TaskLine tone="success" icon={<UserCheck />}>
                  {step.done.kind === "signed"
                    ? t("done.signed", {
                        name: step.done.name,
                        time: time(step.done.at),
                      })
                    : t("done.countersigned", {
                        count: step.done.count,
                        time: time(step.done.at),
                      })}
                </TaskLine>
              ) : null}
              {whoBlock({
                label: t("session.scan"),
                hint: t("session.scanHint"),
                names: Boolean(step.names),
                reading: step.badge === "reading",
                unknown: step.badge === "unknown",
                problem: step.badgeProblem ?? null,
                held: signWhy === "offline" ? t("held.offline") : null,
                namesLabel: t("session.pickName"),
              })}
            </section>
          )}
          <AttendanceList attendances={view.attendances} t={t} time={time} />
          <section className="fw-floor-section" aria-labelledby="fw-tr-trainer">
            <h3 id="fw-tr-trainer" className="fw-floor-subtitle">
              {t("trainer.title", { name: view.trainer.name })}
            </h3>
            <p className="fw-floor-muted">
              {countersignWhy === "outsideTrainer"
                ? t("trainer.outside", { name: view.trainer.name })
                : t("trainer.hint")}
            </p>
          </section>
        </div>
      );
      start = t("session.counts", {
        signed: view.session.signed,
        waiting: waiting.length,
      });
      actions = [
        back,
        {
          label: t("action.countersign"),
          icon: <Signature />,
          heldReason: countersignWhy
            ? t(`held.countersign.${countersignWhy}`)
            : null,
          onPress: () => send({ type: "countersign" }),
        },
      ];
      break;
    }

    // ---- a worker signs with their PIN ----------------------------------------------------------------------------------------------
    case "sign": {
      const { view, signer } = step;
      if (step.problem) {
        body = (
          <div className="fw-floor-stack">
            <ProblemState problem={step.problem} words={refusalWords(t)} />
          </div>
        );
        actions = [{ ...back, label: t("action.backToSession") }];
        break;
      }
      const stop = stopOf(view.session);
      const held = signHeld({ online: model.online, stop });
      body = (
        <SignLayout
          title={t("sign.title")}
          what={
            <>
              {sessionHead(view.session, "fw-tr-sign-course")}
              <p className="fw-floor-lead">
                {t("sign.summary", {
                  day: day(view.session.heldOn),
                  hours: view.session.hours,
                  trainer: view.session.trainerName,
                })}
              </p>
            </>
          }
        >
          <PinSignBlock
            meaning={
              view.statements.attendance[shownLanguage(signer.locale, locale)]
            }
            signer={{
              name: signer.name ?? t("sign.badgeOwner"),
              detail:
                signer.kind === "badge" ? t("sign.byBadge") : t("sign.byName"),
            }}
            onNotYou={() => send({ type: "notYou" })}
            onCancel={() => send({ type: "back" })}
            onSign={(pin) => send({ type: "pin", pin })}
            state={step.busy ? "busy" : "idle"}
            heldReason={
              held === "offline"
                ? t("held.offline")
                : held === "stopped"
                  ? t("stopped.title")
                  : null
            }
            message={step.pinProblem ? t(`pin.${step.pinProblem}`) : undefined}
            messageTone={step.pinProblem === "wrong" ? "danger" : "warning"}
            autoFocus
            labels={ds.pinSignBlock}
          />
        </SignLayout>
      );
      break;
    }

    // ---- the trainer's language check (art. 37 c.13) -------------------------------------------------------------------------------
    case "check": {
      const { view, checks } = step;
      const waiting = waitingCountersign(view.attendances);
      const answered = waiting.filter(
        (attendance) => typeof checks[attendance.id] === "boolean",
      ).length;
      const ready = checksDone(waiting, checks);
      body = (
        <div className="fw-floor-stack">
          {sessionHead(view.session, "fw-tr-check-course")}
          <section className="fw-floor-section" aria-labelledby="fw-tr-check">
            <h3 id="fw-tr-check" className="fw-floor-section-title">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <ListChecks />
              </span>
              {t("check.title", {
                language: languageName(view.session.language, locale),
              })}
            </h3>
            <p className="fw-floor-muted">{t("check.law")}</p>
            <FloorButton
              size="lg"
              variant="secondary"
              icon={<UserCheck />}
              onClick={() => send({ type: "checkAll" })}
            >
              {t("check.all")}
            </FloorButton>
            <ul
              className="fw-tr-checks"
              aria-label={t("check.list", { count: waiting.length })}
            >
              {waiting.map((attendance) => {
                const value = checks[attendance.id];
                const name = attendance.displayName ?? t("attendance.unnamed");
                return (
                  <li key={attendance.id} className="fw-tr-check">
                    <span className="fw-tr-check-name">
                      <span className="fw-floor-inline-icon" aria-hidden="true">
                        <UserRound />
                      </span>
                      {name}
                    </span>
                    <span
                      className="fw-tr-check-how"
                      role="group"
                      aria-label={t("check.how", { name })}
                    >
                      {([true, false] as const).map((understood) => (
                        <FloorButton
                          key={String(understood)}
                          size="md"
                          aria-pressed={value === understood}
                          variant={
                            value === understood
                              ? understood
                                ? "primary"
                                : "warning"
                              : "secondary"
                          }
                          onClick={() =>
                            send({
                              type: "check",
                              attendanceId: attendance.id,
                              understood,
                            })
                          }
                        >
                          {understood
                            ? t("check.understood")
                            : t("check.notUnderstood")}
                        </FloorButton>
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
            {Object.values(checks).some((value) => value === false) ? (
              <TaskLine tone="warning" icon={<CircleAlert />}>
                {t("check.notUnderstoodMeans")}
              </TaskLine>
            ) : null}
          </section>
        </div>
      );
      start = t("check.answered", { answered, total: waiting.length });
      actions = [
        back,
        {
          label: t("action.toPin"),
          icon: <Signature />,
          heldReason: !ready ? t("held.check") : offlineHeld,
          onPress: () => send({ type: "toPin" }),
        },
      ];
      break;
    }

    // ---- the trainer countersigns with their PIN ------------------------------------------------------------------------------------
    case "countersign": {
      const { view, checks } = step;
      if (step.problem) {
        body = <ProblemState problem={step.problem} words={refusalWords(t)} />;
        actions = [{ ...back, label: t("action.backToSession") }];
        break;
      }
      const counts = checkCounts(checks);
      const trainerLocale =
        model.roster.find((person) => person.id === view.trainer.workerId)
          ?.locale ?? null;
      body = (
        <SignLayout
          title={t("countersign.title")}
          what={
            <>
              {sessionHead(view.session, "fw-tr-countersign-course")}
              <p className="fw-floor-lead">
                {t("countersign.summary", {
                  count: counts.understood + counts.notUnderstood,
                })}
              </p>
              <p className="fw-floor-muted">
                {t("countersign.checks", {
                  understood: counts.understood,
                  notUnderstood: counts.notUnderstood,
                })}
              </p>
            </>
          }
        >
          <PinSignBlock
            meaning={
              view.statements.countersign[shownLanguage(trainerLocale, locale)]
            }
            signer={{
              name: view.trainer.name,
              detail: t("countersign.trainer"),
            }}
            onNotYou={() => send({ type: "notYou" })}
            onCancel={() => send({ type: "back" })}
            onSign={(pin) => send({ type: "pin", pin })}
            state={step.busy ? "busy" : "idle"}
            heldReason={offlineHeld}
            message={step.pinProblem ? t(`pin.${step.pinProblem}`) : undefined}
            messageTone={step.pinProblem === "wrong" ? "danger" : "warning"}
            autoFocus
            labels={ds.pinSignBlock}
          />
        </SignLayout>
      );
      break;
    }

    // ---- Receive PPE: who receives ------------------------------------------------------------------------------------------------------
    case "ppeWho": {
      body = (
        <section className="fw-floor-section" aria-labelledby="fw-tr-ppe-who">
          <h2 id="fw-tr-ppe-who" className="fw-floor-section-title">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <HardHat />
            </span>
            {t("ppe.title")}
          </h2>
          <p className="fw-floor-muted">{t("ppe.law")}</p>
          {whoBlock({
            label: t("ppe.scan"),
            hint: t("ppe.scanHint"),
            names: Boolean(step.names),
            reading: Boolean(step.reading),
            unknown: Boolean(step.unknown),
            problem: step.problem ?? null,
            held: offlineHeld,
            namesLabel: t("ppe.pickName"),
          })}
        </section>
      );
      actions = [back];
      break;
    }

    // ---- Receive PPE: what to hand over ------------------------------------------------------------------------------------------------
    case "ppeItems": {
      const { person, lines } = step;
      const items = step.items ?? [];
      const why = step.items
        ? receiveHeld({ online: model.online, lines, items })
        : "empty";
      const tiles: ReasonTile[] = tileOrder(items, locale).map((item) => {
        const kit = person.kit.find((line) => line.ppeItemId === item.id);
        return {
          id: item.id,
          label: itemName(item, locale),
          hint:
            kit && kit.missing > 0
              ? t("ppe.tileMissing", { count: kit.missing })
              : (item.standard ?? undefined),
          icon: itemIcon(item),
          tone: kit && kit.missing > 0 ? "warning" : "primary",
        };
      });
      body = (
        <div className="fw-floor-stack">
          <PersonCard person={person} t={t} />
          <section className="fw-floor-section" aria-labelledby="fw-tr-lines">
            <h3 id="fw-tr-lines" className="fw-floor-subtitle">
              {t("lines.title")}
            </h3>
            {lines.length === 0 ? (
              <p className="fw-floor-muted">{t("lines.empty")}</p>
            ) : (
              <LineList
                lines={lines}
                items={items}
                t={t}
                locale={locale}
                onOpen={(lineId) => send({ type: "openLine", lineId })}
              />
            )}
          </section>
          <section className="fw-floor-section" aria-labelledby="fw-tr-add">
            <h3 id="fw-tr-add" className="fw-floor-subtitle">
              {t("add.title")}
            </h3>
            <ScanInput
              label={t("add.scan")}
              hideLabel
              hint={t("add.scanHint")}
              scannedLabel={(code) => t("add.read", { code })}
              acceptTyped={false}
              keepFocus={false}
              onScan={(code) => send({ type: "itemCode", code })}
            />
            {step.unknownCode ? (
              <TaskLine tone="danger" icon={<CircleAlert />} alert>
                {t("add.unknown", { code: step.unknownCode })}
              </TaskLine>
            ) : null}
            {step.itemsProblem ? (
              <ProblemLine problem={step.itemsProblem} t={t} />
            ) : step.items === null ? (
              <p className="fw-floor-lead" role="status">
                {t("add.loading")}
              </p>
            ) : items.length === 0 ? (
              <TaskLine tone="warning" icon={<CircleAlert />}>
                {t("add.none")}
              </TaskLine>
            ) : (
              <ItemTiles
                label={t("add.title")}
                tiles={tiles}
                locale={locale}
                onPick={(id) => send({ type: "item", ppeItemId: id })}
              />
            )}
          </section>
        </div>
      );
      start =
        lines.length > 0 ? t("lines.units", { count: unitsOf(lines) }) : null;
      actions = [
        { ...back, label: t("action.otherPerson"), icon: <UserRound /> },
        {
          label: t("action.sign"),
          icon: <PenLine />,
          heldReason: why ? t(`held.receive.${why}`) : null,
          onPress: () => send({ type: "sign" }),
        },
      ];
      break;
    }

    // ---- Receive PPE: one item (size, how many, why) ---------------------------------------------------------------------------------------
    case "ppeLine": {
      const line = step.lines.find((entry) => entry.id === step.lineId);
      const item = line
        ? step.items.find((entry) => entry.id === line.ppeItemId)
        : undefined;
      if (!line || !item) {
        body = null;
        actions = [back];
        break;
      }
      const sized = item.sizes.length > 0;
      const waitsSize = needsSize(line, item);
      body = (
        <div className="fw-floor-stack">
          <header className="fw-tr-head">
            <span className="fw-floor-card-icon" aria-hidden="true">
              {itemIcon(item)}
            </span>
            <span className="fw-tr-head-text">
              <span className="fw-floor-card-type">
                {t("line.type", { name: step.person.name })}
              </span>
              <h2 id="fw-tr-line" className="fw-tr-head-title">
                {itemName(item, locale)}
              </h2>
              {item.standard ? (
                <span className="fw-floor-muted">{item.standard}</span>
              ) : null}
            </span>
          </header>
          <div className="fw-tr-line-row">
            <section className="fw-floor-section" aria-labelledby="fw-tr-qty">
              <h3 id="fw-tr-qty" className="fw-floor-subtitle">
                {t("line.quantity")}
              </h3>
              <div className="fw-tr-qty">
                <FloorButton
                  size="lg"
                  variant="secondary"
                  icon={<Minus />}
                  aria-label={t("line.less")}
                  heldReason={line.quantity <= 1 ? t("line.atLeastOne") : null}
                  onClick={() => send({ type: "quantity", delta: -1 })}
                />
                <output
                  className="fw-tr-qty-value"
                  aria-live="polite"
                  aria-labelledby="fw-tr-qty"
                >
                  {line.quantity}
                </output>
                <FloorButton
                  size="lg"
                  variant="secondary"
                  icon={<Plus />}
                  aria-label={t("line.more")}
                  heldReason={
                    line.quantity >= QUANTITY_MAX
                      ? t("line.atMost", { count: QUANTITY_MAX })
                      : null
                  }
                  onClick={() => send({ type: "quantity", delta: 1 })}
                />
              </div>
            </section>
            <section className="fw-floor-section" aria-labelledby="fw-tr-why">
              <h3 id="fw-tr-why" className="fw-floor-subtitle">
                {t("line.why")}
              </h3>
              <div
                className="fw-tr-reasons"
                role="group"
                aria-labelledby="fw-tr-why"
              >
                {PPE_REASONS.map((reason) => (
                  <FloorButton
                    key={reason}
                    size="md"
                    aria-pressed={line.reason === reason}
                    variant={line.reason === reason ? "primary" : "secondary"}
                    onClick={() => send({ type: "reason", reason })}
                  >
                    {t(`reason.${reason}`)}
                  </FloorButton>
                ))}
              </div>
            </section>
          </div>
          {sized ? (
            <PickSize
              sizes={item.sizes}
              value={line.size}
              label={t("line.size")}
              onPick={(size, advance) => send({ type: "size", size, advance })}
            />
          ) : (
            <p className="fw-floor-muted">{t("line.oneSize")}</p>
          )}
          {sized && waitsSize ? (
            <p className="fw-floor-muted">{t("line.sizeHint")}</p>
          ) : null}
        </div>
      );
      actions = [
        {
          label: t("action.remove"),
          icon: <Trash2 />,
          variant: "quiet",
          onPress: () => send({ type: "removeLine", lineId: line.id }),
        },
        {
          label: t("action.lineDone"),
          heldReason: waitsSize ? t("held.size") : null,
          onPress: () => send({ type: "lineDone" }),
        },
      ];
      break;
    }

    // ---- Receive PPE: the person signs ----------------------------------------------------------------------------------------------------
    case "ppeSign": {
      const { person, lines, items } = step;
      if (step.problem) {
        body = <ProblemState problem={step.problem} words={refusalWords(t)} />;
        actions = [{ ...back, label: t("action.changeItems") }];
        break;
      }
      body = (
        <SignLayout
          title={t("receipt.title")}
          what={
            <>
              <ReceiptLines lines={lines} items={items} t={t} locale={locale} />
              <div>
                <FloorButton
                  size="md"
                  variant="secondary"
                  icon={<ArrowLeft />}
                  heldReason={step.busy ? t("held.busy") : null}
                  onClick={() => send({ type: "changeItems" })}
                >
                  {t("action.changeItems")}
                </FloorButton>
              </div>
            </>
          }
        >
          <PinSignBlock
            meaning={person.statement}
            signer={{ name: person.name, detail: person.role?.name }}
            onNotYou={() => send({ type: "notYou" })}
            onSign={(pin) => send({ type: "pin", pin })}
            state={step.busy ? "busy" : "idle"}
            heldReason={offlineHeld}
            message={step.pinProblem ? t(`pin.${step.pinProblem}`) : undefined}
            messageTone={step.pinProblem === "wrong" ? "danger" : "warning"}
            autoFocus
            labels={ds.pinSignBlock}
          />
        </SignLayout>
      );
      break;
    }

    case "ppeDone": {
      const { person, lines, items, receipt } = step;
      body = (
        <div className="fw-floor-stack">
          <FloorState
            tone="success"
            icon={<ShieldCheck />}
            title={t("receipt.done", { name: person.name })}
            text={t("receipt.doneAt", {
              time: time(receipt.issuedAt),
              count: receipt.units,
            })}
          >
            <p className="fw-floor-state-text">
              {t("receipt.signed", { statement: receipt.statement })}
            </p>
          </FloorState>
          <ReceiptLines lines={lines} items={items} t={t} locale={locale} />
          <p className="fw-floor-muted">{t("receipt.office")}</p>
        </div>
      );
      actions = [
        {
          label: t("action.home"),
          icon: <House />,
          variant: "secondary",
          onPress: () => send({ type: "home" }),
        },
        {
          label: t("action.nextPerson"),
          icon: <UserRound />,
          onPress: () => send({ type: "nextPerson" }),
        },
      ];
      break;
    }
  }

  return (
    <FloorFrameView
      frame={model.frame}
      onFrame={onFrame}
      actions={
        actions ? (
          <FloorActionBar
            label={t("title")}
            actions={actions}
            start={start ?? undefined}
          />
        ) : undefined
      }
    >
      <div className="fw-tr">{body}</div>
    </FloorFrameView>
  );
}

/** A failed call as a line inside the step (the step stays). */
function ProblemLine({ problem, t }: { problem: TaskProblem; t: Translate }) {
  const tasks = useT("floor-tasks");
  if (problem.kind === "refused") {
    const own = isKnownRefusal(problem.code);
    return (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {own ? t(`refusal.${problem.code}.message`) : problem.message}
      </TaskLine>
    );
  }
  const kind = problem.kind === "stepUp" ? "forbidden" : problem.kind;
  return (
    <TaskLine
      tone={
        kind === "offline" || kind === "unavailable" || kind === "rateLimited"
          ? "warning"
          : "danger"
      }
      icon={<CircleAlert />}
      alert
    >
      {tasks(`problem.${kind}.title`)}: {tasks(`problem.${kind}.body`)}
    </TaskLine>
  );
}

/** Who signed so far: a name, when and how, countersigned or waiting for the trainer (never a figure about a person). */
function AttendanceList({
  attendances,
  t,
  time,
}: {
  attendances: readonly AttendanceRow[];
  t: Translate;
  time: (value: string) => string;
}) {
  return (
    <section className="fw-floor-section" aria-labelledby="fw-tr-signed">
      <h3 id="fw-tr-signed" className="fw-floor-subtitle">
        {t("attendance.title", { count: attendances.length })}
      </h3>
      {attendances.length === 0 ? (
        <p className="fw-floor-muted">{t("attendance.empty")}</p>
      ) : (
        <FloorList label={t("attendance.title", { count: attendances.length })}>
          {attendances.map((attendance) => {
            const status = attendance.countersigned
              ? attendance.languageUnderstood === false
                ? "notUnderstood"
                : "countersigned"
              : "waiting";
            return (
              <FloorListRow
                key={attendance.id}
                icon={attendance.countersigned ? <UserCheck /> : <PenLine />}
                tone={
                  status === "countersigned"
                    ? "success"
                    : status === "notUnderstood"
                      ? "warning"
                      : "info"
                }
                title={attendance.displayName ?? t("attendance.unnamed")}
                meta={t(
                  attendance.method === "PAPER"
                    ? "attendance.paper"
                    : "attendance.tablet",
                  { time: time(attendance.signedAt) },
                )}
                status={t(`attendance.${status}`)}
              />
            );
          })}
        </FloorList>
      )}
    </section>
  );
}

/** Who receives: their name, their role, what their kit lacks (in this one receipt only). */
function PersonCard({ person, t }: { person: PpePerson; t: Translate }) {
  const missing = missingCount(person.kit);
  return (
    <header className="fw-tr-head">
      <span className="fw-floor-card-icon" aria-hidden="true">
        <UserRound />
      </span>
      <span className="fw-tr-head-text">
        <span className="fw-floor-card-type">{t("person.type")}</span>
        <h2 id="fw-tr-person" className="fw-tr-head-title">
          {person.name}
        </h2>
        <span className="fw-floor-muted">
          {person.role
            ? t("person.role", { role: person.role.name })
            : t("person.noRole")}
        </span>
        {person.role ? (
          <span className="fw-floor-muted">
            {missing > 0
              ? t("person.missing", { count: missing })
              : t("person.complete")}
          </span>
        ) : null}
      </span>
    </header>
  );
}

function lineMeta(
  line: PpeLine,
  item: PpeItem | undefined,
  t: Translate,
): string {
  const size =
    !item || item.sizes.length === 0
      ? t("line.oneSizeShort")
      : line.size && !needsSize(line, item)
        ? t("line.sizeValue", { size: line.size })
        : t("line.sizeMissing");
  return [
    size,
    t(`reason.${line.reason}`),
    line.fromKit ? t("line.fromKit") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The lines to hand over: each opens its own step (size, how many, why). */
function LineList({
  lines,
  items,
  t,
  locale,
  onOpen,
}: {
  lines: readonly PpeLine[];
  items: readonly PpeItem[];
  t: Translate;
  locale: string;
  onOpen: (lineId: string) => void;
}) {
  return (
    <FloorList label={t("lines.title")}>
      {lines.map((line) => {
        const item = items.find((entry) => entry.id === line.ppeItemId);
        const waits = needsSize(line, item);
        return (
          <FloorListRow
            key={line.id}
            icon={itemIcon(item)}
            tone={waits ? "warning" : "neutral"}
            title={item ? itemName(item, locale) : t("line.unknownItem")}
            meta={lineMeta(line, item, t)}
            status={waits ? t("line.pickSize") : undefined}
            count={line.quantity}
            countLabel={t("line.pieces", { count: line.quantity })}
            onPress={() => onOpen(line.id)}
          />
        );
      })}
    </FloorList>
  );
}

/** What the receipt holds, read-only (above the PIN and after it). */
function ReceiptLines({
  lines,
  items,
  t,
  locale,
}: {
  lines: readonly PpeLine[];
  items: readonly PpeItem[];
  t: Translate;
  locale: string;
}) {
  return (
    <ul
      className="fw-tr-receipt"
      aria-label={t("receipt.lines", { count: lines.length })}
    >
      {lines.map((line) => {
        const item = items.find((entry) => entry.id === line.ppeItemId);
        return (
          <li key={line.id} className="fw-tr-receipt-line">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              {itemIcon(item)}
            </span>
            <span className="fw-tr-receipt-name">
              {item ? itemName(item, locale) : t("line.unknownItem")}
            </span>
            <span className="fw-tr-receipt-meta">
              {lineMeta(line, item, t)}
            </span>
            <span className="fw-tr-receipt-qty">
              {t("line.times", { count: line.quantity })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const ARROWS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

/**
 * The DS SizeButtons as a one-tap step: a tap (or Enter / Space) on a size picks it and finishes the item; arrows only move the
 * pick (the group is a radio group: an arrow picks), so the keyboard never leaves the step by itself; a tap on the size already
 * picked finishes too.
 */
function PickSize({
  sizes,
  value,
  label,
  onPick,
}: {
  sizes: readonly string[];
  value: string | null;
  label: string;
  onPick: (size: string, advance: boolean) => void;
}) {
  const last = useRef<"pointer" | "arrow" | "key">("pointer");
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    last.current = ARROWS.has(event.key) ? "arrow" : "key";
  };
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (last.current === "arrow") last.current = "key";
    const id = (event.target as HTMLElement)
      .closest("[data-size-id]")
      ?.getAttribute("data-size-id");
    if (id && id === value) onPick(id, true);
  };
  return (
    <div
      className="fw-tr-sizes"
      onKeyDownCapture={onKeyDownCapture}
      onPointerDownCapture={() => (last.current = "pointer")}
      onClickCapture={onClickCapture}
    >
      <SizeButtons
        label={label}
        sizes={sizes.map((size) => ({ id: size, label: size }))}
        value={value}
        onChange={(size) => onPick(size, last.current !== "arrow")}
      />
    </div>
  );
}

/**
 * The catalogue's tiles (the DS ReasonGrid, six a page with More): a tap (or Enter / Space) on an item opens it; arrows only move
 * between the tiles (the grid is a radio group whose arrows pick), so the keyboard never opens an item by itself.
 */
function ItemTiles({
  label,
  tiles,
  locale,
  onPick,
}: {
  label: string;
  tiles: readonly ReasonTile[];
  locale: string;
  onPick: (id: string) => void;
}) {
  const words = useReasonWords();
  const last = useRef<"pointer" | "arrow" | "key">("pointer");
  return (
    <div
      className="fw-tr-tiles"
      onKeyDownCapture={(event) =>
        (last.current = ARROWS.has(event.key) ? "arrow" : "key")
      }
      onPointerDownCapture={() => (last.current = "pointer")}
    >
      <ReasonGrid
        label={label}
        hideLabel
        reasons={tiles}
        value={null}
        onChange={(id) => (last.current === "arrow" ? undefined : onPick(id))}
        pageSize={6}
        words={words}
        locale={INTL_LOCALE[locale as keyof typeof INTL_LOCALE]}
      />
    </div>
  );
}

/**
 * A signature step: what is signed on one side, the DS PinSignBlock (what signing means, who signs, the PIN pad) on the other, so
 * a tablet shows the pad without scrolling past the summary; one column on a narrow screen.
 */
function SignLayout({
  title,
  what,
  children,
}: {
  title: string;
  what: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="fw-tr-sign">
      <section className="fw-tr-sign-what" aria-labelledby="fw-tr-sign-title">
        <h2 id="fw-tr-sign-title" className="fw-floor-section-title">
          {title}
        </h2>
        {what}
      </section>
      <div className="fw-tr-sign-pin">{children}</div>
    </div>
  );
}
