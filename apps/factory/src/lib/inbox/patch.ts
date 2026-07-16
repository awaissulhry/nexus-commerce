/**
 * EPI1.1 — pure resolver for conversation PATCH semantics, extracted from
 * api/inbox/[id] so the state rules are unit-testable. Fixes the
 * stranded-SNOOZED bug (EPI-UI-INVENTORY G2): clearing the wake date while
 * snoozed reopens the conversation instead of leaving it snoozed-forever
 * with nothing to wake it.
 */

export type ConversationState = "OPEN" | "SNOOZED" | "CLOSED";

export type ConversationPatchInput = {
  assigneeId?: string | null;
  state?: ConversationState;
  snoozeUntil?: string | null;
  followUpAt?: string | null;
};

export type ResolvedConversationPatch =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

export function resolveConversationPatch(
  existingState: ConversationState,
  input: ConversationPatchInput,
): ResolvedConversationPatch {
  const data: Record<string, unknown> = {};
  if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId;
  if (input.followUpAt !== undefined) data.followUpAt = input.followUpAt ? new Date(input.followUpAt) : null;
  if (input.snoozeUntil !== undefined) {
    data.snoozeUntil = input.snoozeUntil ? new Date(input.snoozeUntil) : null;
    if (input.snoozeUntil) data.state = "SNOOZED";
    // G2: a cleared wake date must not strand the thread in SNOOZED — the
    // worker wake query (snoozeUntil <= now) can never match null.
    else if (input.state === undefined && existingState === "SNOOZED") data.state = "OPEN";
  }
  if (input.state) {
    data.state = input.state;
    if (input.state !== "SNOOZED") data.snoozeUntil = null;
    if (input.state === "SNOOZED" && !data.snoozeUntil && input.snoozeUntil === undefined) {
      return { ok: false, error: "Snoozing needs a wake date" };
    }
  }
  return { ok: true, data };
}
