/**
 * The Control section of the Hourly bid plan builder: Manual (saved, switched off) or Automate (switched on).
 *
 * 🔴 (2026-10-26) — on edit the radio stayed on its Manual default, never read from the plan, so "Save Changes" on a
 * running plan sent `enabled: false`: the save switched it off and gave back every bid it floored. Here the radio
 * opens on what the plan IS, and `null` (not read yet, or the read failed) is a state the builder cannot save.
 * No React/DB — unit-tested in planControl.vitest.test.ts.
 */
export type PlanControl = 'manual' | 'automate'

/** What Control shows for a saved plan (the group row, or a legacy AdSchedule row): on → Automate, off → Manual, else null. */
export function controlForPlan(stored: unknown): PlanControl | null {
  const enabled = stored != null && typeof stored === 'object' ? (stored as { enabled?: unknown }).enabled : undefined
  return enabled === true ? 'automate' : enabled === false ? 'manual' : null
}

/**
 * What a save sends as `enabled`. An edit of a saved plan (?groupId) sends it only when the person changed Control from
 * what was read, so a plan switched on elsewhere while the builder is open is not switched back off; absent, the API
 * keeps the plan as it is. A create (a ?scheduleId save is one too) always says it. No Control, nothing to send.
 */
export function enabledToSend(editsGroup: boolean, control: PlanControl | null, controlRead: PlanControl | null): boolean | undefined {
  if (!control) return undefined
  if (editsGroup && control === controlRead) return undefined
  return control === 'automate'
}

/** Under Control while the plan's state is being read: the save waits for it. */
export const CONTROL_READING = 'Reading whether this plan is on or off. Saving waits until Control shows it.'
/** Under Control when the read failed: nothing is guessed. */
export const CONTROL_UNREAD = 'Could not read whether this plan is on or off. Reload the page, or pick Manual or Automate yourself before saving.'
