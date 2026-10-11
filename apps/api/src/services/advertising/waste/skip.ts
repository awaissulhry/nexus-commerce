/**
 * Negative Targeting page (2026-10-11, lane NWRITE) — Skip: a person snoozes a waste row for 7 or 30 days (PLAN §2:
 * "Skip = snooze, never dismiss forever; the row comes back with fresh numbers"). Nexus only: nothing changes at Amazon.
 *
 *   skip     one AdsWasteSkip row per waste row (rowKey = the row id: 'kw:<AdTarget.id>' or
 *            'term:<market>|<external ad group id>|<term key>'), until now + days (or an exact `until`: the undo of an
 *            unskip puts the same end back). A row's open skip is ended first, so one stands per row at most.
 *   unskip   ends the open skip of each row (endedAt, endedBy). Its answer carries what an undo needs (the ends it took).
 *   reads    `activeSkips` — the open skips of some rows, for the Wasting view (lane NREAD) and the preview.
 *
 * Undo: skip ↔ unskip (the routes answer the body that puts it back). Polish M5 — the undo of an unskip REOPENS the very
 * skips it ended (`reopen`: their ids): the same start, person, end and reason, never a new skip.
 */
import prisma from '../../../db.js'

/** The snooze lengths the page offers. */
export const SKIP_DAYS = [7, 30] as const
/** The most rows one skip or unskip names. */
export const MAX_SKIP_ROWS = 500

const ROW_KEY = /^(kw:[^\s|]{1,64}|term:[^|]{1,20}\|[^|]{1,64}\|.{1,400})$/

/** A waste row id a skip may name (a keyword row or a search-term row). Pure. */
export function skippableRowKey(id: string): boolean {
  return ROW_KEY.test(id.trim())
}

export interface ActiveSkip { rowKey: string; until: Date; by: string; at: Date }

/** The open skips of these rows (or of every row when none is named), as of `now`. */
export async function activeSkips(rowKeys?: readonly string[], now: Date = new Date()): Promise<Map<string, ActiveSkip>> {
  const rows = await prisma.adsWasteSkip.findMany({
    where: { endedAt: null, until: { gt: now }, ...(rowKeys ? { rowKey: { in: [...rowKeys] } } : {}) },
    orderBy: { at: 'desc' },
    select: { rowKey: true, until: true, by: true, at: true },
    take: 20_000,
  })
  const out = new Map<string, ActiveSkip>()
  for (const r of rows) if (!out.has(r.rowKey)) out.set(r.rowKey, r)
  return out
}

export type SkipOutcome =
  | { ok: true; skipped: Array<{ rowId: string; until: string }>; undo: { path: '/api/advertising/waste/unskip'; body: { ids: string[] } } }
  | { ok: false; error: string }

/**
 * Snooze rows until now + `days` (7 or 30), or until an exact future `until` (the undo of an unskip). Ids are trimmed and
 * deduplicated; an id that is not a waste row is refused by name and nothing is written.
 */
export async function skipRows(args: { ids: readonly string[]; days?: number | null; until?: Date | null; by: string; reason?: string | null; now?: Date }): Promise<SkipOutcome> {
  const now = args.now ?? new Date()
  const ids = [...new Set(args.ids.map((id) => id.trim()).filter(Boolean))]
  if (!ids.length) return { ok: false, error: 'Name the rows to skip (ids).' }
  if (ids.length > MAX_SKIP_ROWS) return { ok: false, error: `${ids.length} rows named: at most ${MAX_SKIP_ROWS} in one skip.` }
  const wrong = ids.filter((id) => !skippableRowKey(id))
  if (wrong.length) return { ok: false, error: `Not skipped: ${wrong.slice(0, 3).join(', ')}${wrong.length > 3 ? ` and ${wrong.length - 3} more` : ''} ${wrong.length === 1 ? 'is' : 'are'} not a waste row (kw:<id> or term:<market>|<ad group>|<term>).` }
  let until: Date
  if (args.until) {
    if (args.until.getTime() <= now.getTime()) return { ok: false, error: 'until is not in the future.' }
    until = args.until
  } else {
    if (!SKIP_DAYS.includes(args.days as (typeof SKIP_DAYS)[number])) return { ok: false, error: `days is ${SKIP_DAYS.join(' or ')}.` }
    until = new Date(now.getTime() + (args.days as number) * 86_400_000)
  }
  const reason = args.reason?.trim() ? args.reason.trim().slice(0, 300) : null
  await prisma.$transaction(async (tx) => {
    await tx.adsWasteSkip.updateMany({ where: { rowKey: { in: ids }, endedAt: null }, data: { endedAt: now, endedBy: args.by } })
    await tx.adsWasteSkip.createMany({ data: ids.map((rowKey) => ({ rowKey, until, by: args.by, reason, at: now })) })
  })
  return { ok: true, skipped: ids.map((rowId) => ({ rowId, until: until.toISOString() })), undo: { path: '/api/advertising/waste/unskip', body: { ids } } }
}

export interface UnskipOutcome {
  ok: true
  unskipped: number
  /** What the undo puts back (polish M5): the very skips it ended, reopened (POST /skip with `reopen`: their ids). */
  undo: { path: '/api/advertising/waste/skip'; body: { reopen: string[] } } | null
}

/** End the open skip of each row (a row with none is left as it is). */
export async function unskipRows(args: { ids: readonly string[]; by: string; now?: Date }): Promise<UnskipOutcome | { ok: false; error: string }> {
  const now = args.now ?? new Date()
  const ids = [...new Set(args.ids.map((id) => id.trim()).filter(Boolean))]
  if (!ids.length) return { ok: false, error: 'Name the rows to unskip (ids).' }
  if (ids.length > MAX_SKIP_ROWS) return { ok: false, error: `${ids.length} rows named: at most ${MAX_SKIP_ROWS} in one unskip.` }
  const open = await prisma.adsWasteSkip.findMany({ where: { rowKey: { in: ids }, endedAt: null, until: { gt: now } }, select: { id: true, rowKey: true, until: true } })
  if (open.length) await prisma.adsWasteSkip.updateMany({ where: { id: { in: open.map((r) => r.id) } }, data: { endedAt: now, endedBy: args.by } })
  return { ok: true, unskipped: open.length, undo: open.length ? { path: '/api/advertising/waste/skip', body: { reopen: open.map((r) => r.id) } } : null }
}

export type ReopenOutcome =
  | { ok: true; reopened: Array<{ rowId: string; until: string }>; notReopened: Array<{ id: string; why: string }>; undo: { path: '/api/advertising/waste/unskip'; body: { ids: string[] } } | null }
  | { ok: false; error: string }

/**
 * Polish M5 — the undo of an unskip: reopen the very skips it ended (endedAt and endedBy cleared), keeping their start,
 * person, end and reason. One that has run out since, or whose row was skipped again meanwhile, stays as it is (said).
 */
export async function reopenSkips(args: { ids: readonly string[]; now?: Date }): Promise<ReopenOutcome> {
  const now = args.now ?? new Date()
  const ids = [...new Set(args.ids.map((id) => id.trim()).filter(Boolean))]
  if (!ids.length) return { ok: false, error: 'Name the skips to reopen (reopen).' }
  if (ids.length > MAX_SKIP_ROWS) return { ok: false, error: `${ids.length} skips named: at most ${MAX_SKIP_ROWS} in one undo.` }
  const rows = await prisma.adsWasteSkip.findMany({ where: { id: { in: ids } }, select: { id: true, rowKey: true, until: true, endedAt: true } })
  const open = await prisma.adsWasteSkip.findMany({ where: { rowKey: { in: rows.map((r) => r.rowKey) }, endedAt: null, until: { gt: now } }, select: { rowKey: true } })
  const busy = new Set(open.map((r) => r.rowKey))
  const reopened: Array<{ rowId: string; until: string }> = []
  const notReopened: Array<{ id: string; why: string }> = []
  for (const id of ids) {
    const r = rows.find((x) => x.id === id)
    if (!r) { notReopened.push({ id, why: 'no such skip in this business' }); continue }
    if (!r.endedAt) { notReopened.push({ id, why: 'it is still open' }); continue }
    if (r.until.getTime() <= now.getTime()) { notReopened.push({ id, why: 'it has run out since' }); continue }
    if (busy.has(r.rowKey)) { notReopened.push({ id, why: 'the row was skipped again since' }); continue }
    const done = await prisma.adsWasteSkip.updateMany({ where: { id, endedAt: r.endedAt }, data: { endedAt: null, endedBy: null } })
    if (done.count) { reopened.push({ rowId: r.rowKey, until: r.until.toISOString() }); busy.add(r.rowKey) }
    else notReopened.push({ id, why: 'it changed meanwhile' })
  }
  return { ok: true, reopened, notReopened, undo: reopened.length ? { path: '/api/advertising/waste/unskip', body: { ids: reopened.map((r) => r.rowId) } } : null }
}
