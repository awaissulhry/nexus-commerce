/**
 * Quiet lines (owb- order workflow, S1 po2.3; design order-workflow § 5zi F, R61 a): ONE rule — a small line in the middle of an
 * order's chat, with the time and no bubble, only for the few changes the other side must know: the picture, a line added, changed
 * or taken out after Send, a new own column, the promised date, a file both sides can open. Silent for a draft, a cost, a rate, a
 * floor step, a team, an office-only file. Several of one side inside QUIET_GROUP_MINUTES are ONE line (grouped when the feed is
 * read: messages are append-only). Never counted as unread.
 *
 * A quiet line is a SYSTEM message shared with the customer (audience PARTNER) carrying `eventKey` (one of QUIET_LINE_KEYS) and
 * `eventArgs` (ids and short values only, never words: the web draws them in EN/IT; ONE JSON object — the database's guard G12).
 * `eventArgs.by` says which side caused it (CUSTOMER or FACTORY), never a person. The keys below are the list the web may copy.
 */

export const QUIET_LINE_KEYS = ['quiet.pictureSet', 'quiet.lineAdded', 'quiet.lineChanged', 'quiet.lineTakenOut', 'quiet.ownColumnAdded', 'quiet.promiseSet', 'quiet.fileShared'] as const
export type QuietLineKey = (typeof QUIET_LINE_KEYS)[number]

export const QUIET_SIDES = ['CUSTOMER', 'FACTORY'] as const
export type QuietSide = (typeof QUIET_SIDES)[number]

export const QUIET_GROUP_MINUTES = 10

/** A quiet line's arguments: ids and short values only (≤ 10 keys, a string ≤ 100 characters). */
export type QuietArgs = Readonly<Record<string, string | number>>

export const isQuietLineKey = (value: unknown): value is QuietLineKey => typeof value === 'string' && (QUIET_LINE_KEYS as readonly string[]).includes(value)

/** Whether the arguments are as a quiet line may carry them (never words, never more than a few short values). */
export function quietArgsFit(args: Readonly<Record<string, unknown>>): boolean {
  const entries = Object.entries(args)
  return entries.length <= 10 && entries.every(([key, value]) => /^[a-z][A-Za-z0-9]{0,39}$/.test(key) && ((typeof value === 'string' && value.length <= 100) || (typeof value === 'number' && Number.isFinite(value))))
}

/** The stored body of a quiet line: plain English words for a reader that draws no event (the web draws its own EN/IT words). */
export const QUIET_LINE_BODY: Readonly<Record<QuietLineKey, string>> = Object.freeze({
  'quiet.pictureSet': 'The picture of the order changed.',
  'quiet.lineAdded': 'A line was added.',
  'quiet.lineChanged': 'A line was changed.',
  'quiet.lineTakenOut': 'A line was taken out.',
  'quiet.ownColumnAdded': 'A column of your own was added.',
  'quiet.promiseSet': 'The promised date was set.',
  'quiet.fileShared': 'A file was shared.',
})

export interface FeedRow {
  readonly id: string
  readonly at: Date
  readonly eventKey: string | null
  readonly eventArgs: unknown
}

const sideOf = (args: unknown): unknown => (args !== null && typeof args === 'object' ? (args as Record<string, unknown>).by : undefined)

/**
 * The grouping at read time, over a page of the feed NEWEST FIRST: a quiet line of the same key and side as the quiet line kept just
 * before it (no ordinary message between them) and within QUIET_GROUP_MINUTES of it is dropped, and the kept one counts it. Answers
 * the dropped ids and, per kept quiet line, how many lines it stands for (1 or more).
 */
export function groupQuietLines(rows: readonly FeedRow[]): { readonly dropped: ReadonlySet<string>; readonly counts: ReadonlyMap<string, number> } {
  const dropped = new Set<string>()
  const counts = new Map<string, number>()
  let kept: FeedRow | null = null
  for (const row of rows) {
    if (row.eventKey === null) {
      kept = null
      continue
    }
    if (kept !== null && kept.eventKey === row.eventKey && sideOf(kept.eventArgs) === sideOf(row.eventArgs) && Math.abs(kept.at.getTime() - row.at.getTime()) <= QUIET_GROUP_MINUTES * 60_000) {
      dropped.add(row.id)
      counts.set(kept.id, (counts.get(kept.id) ?? 1) + 1)
      continue
    }
    kept = row
    counts.set(row.id, 1)
  }
  return { dropped, counts }
}

/** A message's event as the feed shows it (null: an ordinary message). */
export function feedEventOf(row: Pick<FeedRow, 'id' | 'eventKey' | 'eventArgs'>, counts: ReadonlyMap<string, number>): { key: QuietLineKey; args: Record<string, string | number>; count: number } | null {
  if (!isQuietLineKey(row.eventKey)) return null
  const raw = row.eventArgs !== null && typeof row.eventArgs === 'object' ? (row.eventArgs as Record<string, unknown>) : {}
  const args: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'string' || typeof value === 'number') args[key] = value
  return { key: row.eventKey, args, count: counts.get(row.id) ?? 1 }
}
