/**
 * 2c (review G.11) — "about N changes a day sent to Amazon" for an hourly bid plan, in words.
 *
 * The number is the API's (GET /advertising/rank-schedule-groups/write-projection, from rank-write-projection.ts): it
 * walks the plan's painted week with the rank engine's rules. Every switch into or out of Min bid moves every bid in a
 * campaign, a placement change is one change, a base bid moves the bids it names. It assumes every bid sits above the
 * floor, so the real count can be lower; the words say "about" and say why.
 */

export interface WriteProjection {
  perDay: number
  perWeek: number
  /** The week's changes by kind. */
  byKind: { restore: number; suppress: number; placement: number; base: number }
  /** Min-bid hours a week that keep serving because the campaign already entered Min bid twice that day. */
  keptServing: number
  campaigns: number
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The endpoint's `items`, keyed by plan id. Anything malformed is left out rather than shown as 0. */
export function parseWriteProjections(body: unknown): Record<string, WriteProjection> {
  const items = (body as { items?: unknown } | null)?.items
  const out: Record<string, WriteProjection> = {}
  if (!items || typeof items !== 'object') return out
  for (const [id, raw] of Object.entries(items as Record<string, unknown>)) {
    const p = raw as Partial<WriteProjection> | null
    if (!p || typeof p.perDay !== 'number') continue
    const k = (p.byKind ?? {}) as Partial<WriteProjection['byKind']>
    out[id] = {
      perDay: num(p.perDay), perWeek: num(p.perWeek), keptServing: num(p.keptServing), campaigns: num(p.campaigns),
      byKind: { restore: num(k.restore), suppress: num(k.suppress), placement: num(k.placement), base: num(k.base) },
    }
  }
  return out
}

const changes = (n: number) => `${n.toLocaleString('en-GB')} change${n === 1 ? '' : 's'}`

/** "about 24 changes a day sent to Amazon" — or that it sends none once set. */
export function writesPerDayWords(p: WriteProjection): string {
  if (p.perWeek === 0) return 'no changes sent to Amazon once each hour’s values are set'
  if (p.perDay === 0) return 'fewer than one change a day sent to Amazon'
  return `about ${changes(p.perDay)} a day sent to Amazon`
}

/** The list cell: "about 24", "under 1", or "none" for a plan that sends nothing once each hour is set. */
export function writesCell(p: WriteProjection): string {
  if (p.perWeek === 0) return 'none'
  return p.perDay === 0 ? 'under 1' : `about ${p.perDay.toLocaleString('en-GB')}`
}

/** What those changes are, a day: "20 bid floors and give-backs, 4 placement changes". */
export function writesBreakdownWords(p: WriteProjection): string {
  const day = (n: number) => Math.round(n / 7)
  const floors = day(p.byKind.suppress + p.byKind.restore)
  const parts = [
    floors ? `${floors.toLocaleString('en-GB')} bid floor${floors === 1 ? '' : 's'} and give-backs` : null,
    day(p.byKind.placement) ? `${day(p.byKind.placement).toLocaleString('en-GB')} placement change${day(p.byKind.placement) === 1 ? '' : 's'}` : null,
    day(p.byKind.base) ? `${day(p.byKind.base).toLocaleString('en-GB')} base-bid change${day(p.byKind.base) === 1 ? '' : 's'}` : null,
  ].filter(Boolean)
  return parts.join(', ')
}

/** When Min bid is painted more than twice on a day: the hours that keep serving instead. Null when none do. */
export function keptServingWords(p: WriteProjection): string | null {
  if (!p.keptServing) return null
  return `Min bid is painted more than twice on some days. A campaign is floored at most twice a day, so ${p.keptServing} of those hour${p.keptServing === 1 ? '' : 's'} a week keep serving.`
}

/** The full sentence for a tooltip or the builder: the number, what it is made of, and why it is an estimate. */
export function writesExplained(p: WriteProjection): string {
  const what = writesBreakdownWords(p)
  const kept = keptServingWords(p)
  const per = writesPerDayWords(p)
  const head = p.perWeek === 0
    ? 'Once each hour’s values are set, this plan sends no changes to Amazon.'
    : `${per[0].toUpperCase()}${per.slice(1)}${p.campaigns ? ` across ${p.campaigns} campaign${p.campaigns === 1 ? '' : 's'}` : ''}${what ? ` (${what})` : ''}.`
  return [
    head,
    'Each switch into or out of Min bid moves every bid in a campaign; each placement change is one change.',
    'Counted from the painted hours: a bid already at the floor does not move, so the real number can be lower.',
    kept,
  ].filter(Boolean).join(' ')
}
