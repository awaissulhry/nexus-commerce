/**
 * Kept paused on the ad group's Targets tab (Negative Targeting page, 2026-10-11). A keyword or target a person or a
 * rule paused and KEPT paused carries the hold (`AdTarget.keptPausedAt/By/Until/Reason`): no rule, Brain or plan turns it
 * on, and a person's own turn-on from this tab is refused (409, the hold's words) until the person confirms the release
 * — the same PATCH again with `releaseKeptPaused: true`, which lets it spend again. Pure, tested in Node.
 */
import type { EachResult } from '../../../../../_shared/adsWrite'

export interface HoldFields {
  status: string
  keptPausedAt?: string | null
  keptPausedBy?: string | null
  keptPausedUntil?: string | null
  keptPausedReason?: string | null
}

export const isKeptPaused = (r: HoldFields) => !!r.keptPausedAt

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Rome' })
const MOMENT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Rome' })
const day = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(t) ? DAY.format(new Date(t)) : null
}
/** Who holds it, in words: "You" for the person signed in, "a person", "a rule", the Brain — never a raw id (audit M8). */
const who = (by: string | null | undefined, me?: string | null) => {
  if (!by) return 'a person'
  if (by.startsWith('user:')) return me && by === `user:${me}` ? 'You' : 'a person'
  if (by.startsWith('rule:')) return 'a rule'
  if (/brain/i.test(by)) return 'the Brain'
  if (/claude|agent/i.test(by)) return 'Claude'
  return 'a person'
}

/** The lock's words: who keeps it paused, since when, until when — on hover and as its accessible name. */
export function keptPausedWords(r: HoldFields, me?: string | null): string {
  if (!isKeptPaused(r)) return ''
  const since = day(r.keptPausedAt)
  const until = day(r.keptPausedUntil)
  return `Kept paused by ${who(r.keptPausedBy, me)}${since ? ` since ${since}` : ''} · ${until ? `until ${until}` : 'always'}: only a person turns it on`
}

/** The confirm's line for one kept-paused row: who, since when (Rome), until when, and what turning it on does. */
export function keptPausedReason(r: HoldFields, me?: string | null): string {
  const at = r.keptPausedAt ? Date.parse(r.keptPausedAt) : Number.NaN
  const since = Number.isFinite(at) ? MOMENT.format(new Date(at)) : null
  const until = day(r.keptPausedUntil)
  return `Kept paused by ${who(r.keptPausedBy, me)}${since ? ` since ${since}` : ''} (${until ? `until ${until}` : 'always'}). Turning it on lets it spend.`
}

/** The ids a turn-on left out because they are kept paused (the rows say so, or the server's words do). */
export function keptPausedRefusals(res: EachResult, rows: ReadonlyMap<string, HoldFields & { expressionValue?: string }>, me?: string | null): Array<{ id: string; text: string; reason: string }> {
  return res.failed.flatMap((f) => {
    const row = rows.get(f.id)
    const kept = (row && isKeptPaused(row)) || /kept paused/i.test(f.reason)
    // The row's own words (no raw ids, no tool names, Rome time), never the server's technical sentence (audit M8).
    return kept ? [{ id: f.id, text: row?.expressionValue || 'This target', reason: row && isKeptPaused(row) ? keptPausedReason(row, me) : 'Kept paused. Turning it on lets it spend.' }] : []
  })
}

/** The same result without the refusals the person is now asked about (so the toast does not say them twice). */
export function withoutRefusals(res: EachResult, ids: ReadonlySet<string>): EachResult {
  return { ...res, failed: res.failed.filter((f) => !ids.has(f.id)) }
}
