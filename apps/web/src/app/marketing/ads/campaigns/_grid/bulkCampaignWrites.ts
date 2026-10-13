/**
 * Editing correctness (group 3 review) — the Ad Manager's Bulk Actions write each part of a campaign's change on its own:
 * a budget refused because it moved since ("Changed since: now …") no longer takes the status or bidding strategy sent
 * with it down too. This reads the parts back as one line that says, per campaign, which part was not changed and why.
 * Pure, tested in Node.
 */

/** One part of one campaign's bulk change, and whether it was written. */
export interface PartResult { part: string; wrote: boolean; reason?: string }

/** The Bulk Actions line: how many campaigns changed whole, partly, not at all — and the first reason of each. */
export function bulkApplyMessage(campaigns: ReadonlyArray<{ name: string; parts: readonly PartResult[] }>): string {
  const whole = campaigns.filter((c) => c.parts.length > 0 && c.parts.every((p) => p.wrote))
  const partly = campaigns.filter((c) => c.parts.some((p) => p.wrote) && c.parts.some((p) => !p.wrote))
  const none = campaigns.filter((c) => c.parts.length > 0 && c.parts.every((p) => !p.wrote))
  const n = (k: number) => `${k} campaign${k === 1 ? '' : 's'}`
  const first = (list: typeof campaigns) => {
    const c = list[0]!
    const p = c.parts.find((x) => !x.wrote)!
    return `${c.name}: ${p.part} — ${p.reason ?? 'no reason given'}${list.length > 1 ? ` (and ${list.length - 1} more)` : ''}`
  }
  return [
    `Applied to ${n(whole.length)}`,
    ...(partly.length ? [`${n(partly.length)} partly changed — ${first(partly)}`] : []),
    ...(none.length ? [`${n(none.length)} not changed — ${first(none)}`] : []),
  ].join(' · ')
}
