/**
 * What an hourly bid plan's save answers, in words: the builder's save and the coverage strip's "Add to schedule".
 *
 * 6a (2026-10-26) — a plan holds Sponsored Products campaigns only: every write of the rank engine is a Sponsored
 * Products write, so the API leaves a Brands or Display campaign out of a save and names it (`notSponsoredProducts`).
 * The success lines counted what was SENT; here they count what the plan really holds (`members`, `added`), name what
 * was left out, and say on or off from the answer's own `enabled`.
 * No React/DB — unit-tested in planSave.vitest.test.ts.
 */

/** A campaign the save left out because it is not Sponsored Products. */
export interface LeftOut { id: string; name: string }

export interface SaveAnswer {
  /** The API answered with the plan's id. */
  ok: boolean
  id?: string
  /** Campaigns the plan really holds after the save. */
  members?: number
  /** Whether the plan runs after the save. Absent from an older API. */
  enabled?: boolean
  /** "Add to schedule" only: campaigns really added. */
  added?: number
  leftOut: LeftOut[]
  /** A refused save: the API's own sentence (e.g. a save left with no Sponsored Products campaign). */
  error?: string
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** The save answer, read without trusting its shape. */
export function readSaveAnswer(body: unknown): SaveAnswer {
  const b = body != null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  const raw = Array.isArray(b.notSponsoredProducts) ? (b.notSponsoredProducts as unknown[]) : []
  const leftOut = raw
    .filter((x): x is { id: unknown; name?: unknown } => x != null && typeof x === 'object' && (x as { id?: unknown }).id != null)
    .map((x) => ({ id: String(x.id), name: String(x.name ?? x.id) }))
  return {
    ok: !!b.id,
    id: b.id ? String(b.id) : undefined,
    members: count(b.members),
    enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
    added: count(b.added),
    leftOut,
    error: typeof b.error === 'string' && b.error.trim() ? b.error.trim() : undefined,
  }
}

/** The builder's line for a refused save: the API's sentence when it gave one, else the generic line. */
export const saveRefusedMessage = (a: SaveAnswer): string => (a.error ? `Not saved. ${a.error}` : 'Save failed — please retry.')
/** The coverage strip's line for a refused "Add to schedule". */
export const addRefusedMessage = (a: SaveAnswer): string => (a.error ? `Not added. ${a.error}` : 'Could not add those campaigns — please retry.')

const plural = (n: number) => `${n} campaign${n === 1 ? '' : 's'}`

/** The left-out campaigns named: up to three, then "and N more". Empty when nothing was left out. */
export function notSponsoredSentence(leftOut: readonly LeftOut[]): string {
  if (!leftOut.length) return ''
  const shown = leftOut.slice(0, 3).map((c) => `"${c.name}"`)
  const more = leftOut.length - shown.length
  const names = more > 0 ? `${shown.join(', ')} and ${more} more`
    : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
    : shown[0]
  return leftOut.length === 1
    ? `${names} is not a Sponsored Products campaign, so it was left out: hourly bids change Sponsored Products only.`
    : `${names} are not Sponsored Products campaigns, so they were left out: hourly bids change Sponsored Products only.`
}

const withLeftOut = (line: string, leftOut: readonly LeftOut[]) => (leftOut.length ? `${line} ${notSponsoredSentence(leftOut)}` : line)

/** The builder's success line. `enabled` undefined = kept, and the answer did not say: it claims neither. */
export function planSavedMessage(a: { name: string; members: number; enabled: boolean | undefined; leftOut: readonly LeftOut[] }): string {
  const line = a.enabled === true
    ? `Saved + armed — one schedule "${a.name}" holding ${plural(a.members)} on its cadence (real Amazon pushes honour each campaign's write-gate; sandbox stays local).`
    : a.enabled === false
      ? `Saved — one schedule "${a.name}" over ${plural(a.members)}. Manual, so nothing runs yet; set Control to Automate to hold it.`
      : `Saved — one schedule "${a.name}" over ${plural(a.members)}. Whether it runs was left as it was.`
  return withLeftOut(line, a.leftOut)
}

/** The coverage strip's line after "Add to schedule". */
export function campaignsAddedMessage(a: { added: number; scheduleName: string; leftOut: readonly LeftOut[] }): string {
  const line = a.added > 0
    ? `Added ${plural(a.added)} to ${a.scheduleName}. They inherit its windows and baseline, and its enabled state — so a paused schedule still runs nothing.`
    : `No campaign was added to ${a.scheduleName}.`
  return withLeftOut(line, a.leftOut)
}
