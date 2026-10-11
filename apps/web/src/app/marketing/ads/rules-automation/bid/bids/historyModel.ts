/**
 * Bid page, Bids view — one bid's history in the side panel, from the change feed
 * (`GET /api/advertising/changes?entityType=AD_TARGET&entityId=…&field=bid`, ads-changes.service.ts `listChanges`).
 * Pure, tested in Node (`historyModel.vitest.test.ts`).
 *
 * What became of each change and its Undo are the page's one word set (`_shared/delivery.ts`), so the rule panel's
 * History and this one never say the same change two ways (audit M3, S18).
 *
 * The night floor and its morning give-back are two automatic writes a day that cancel out. They are folded into one
 * line (or none, when the bid came back to where it was), as the bids read folds them (bid-owner.ts
 * `collapseBidChanges`); "Night floor" shows every step. A folded line offers no Undo: its last step is the give-back,
 * and undoing it would put the bid back on the floor.
 */
import { changeStateOf, undoView, type ChangeState, type UndoView } from '../_shared/delivery'
import { rulePanelHref } from './bidsModel'

/** The subset of the feed's ChangeRow this panel reads. A bid's values are cents, as strings. */
export interface FeedRow {
  id: string
  at: string
  source: string
  origin: { kind: string; id: string | null; name: string } | null
  field: string
  oldValue: string | null
  newValue: string | null
  reason?: string | null
  delivery: { state: string; attempts?: number; lastError: string | null } | null
  undoable: boolean
  undoActionLogId: string | null
  undoBlockedReason?: string
  marketplace?: string | null
}

/** Who made a change, and where it opens: a rule → its detail on this page; the Brain → this keyword's Why tab. */
export interface ChangeWho { kind: 'person' | 'rule' | 'brain' | 'plan' | 'other'; id: string | null; name: string }

/** The bid brain writes as `automation:bid-brain` (ads-engine-actors.ts); the feed names that job "bid brain". */
const BRAIN_JOB = /^bid[\s-]brain$/i

export function whoOf(r: Pick<FeedRow, 'source' | 'origin'>): ChangeWho {
  const kind = r.origin?.kind
  const id = r.origin?.id ?? null
  const name = r.origin?.name?.trim() ?? ''
  if (kind === 'manual' || r.source === 'operator') return { kind: 'person', id: null, name: 'You' }
  if (BRAIN_JOB.test(name)) return { kind: 'brain', id: 'brain', name: 'Brain' }
  const known = name && !/^unknown$/i.test(name) ? name : null
  if (kind === 'rule' && id) return { kind: 'rule', id, name: known ?? 'Rule' }
  if ((kind === 'schedule' || kind === 'plan') && known) return { kind: 'plan', id, name: known }
  if (known) return { kind: 'other', id: null, name: known }
  if (r.source === 'automation') return { kind: 'other', id: null, name: 'Automation' }
  return { kind: 'other', id: null, name: r.source || 'Unknown' }
}

/** A rule's detail on this page; null for the rest (the Brain opens the keyword's Why tab, the panel's own). */
export const whoHref = (w: ChangeWho, market: string | null | undefined): string | null =>
  w.kind === 'rule' && w.id ? rulePanelHref(w.id, market) : null

export interface HistoryLine {
  id: string
  at: string
  /** null: the bid before is not known. */
  from: number | null
  to: number
  who: ChangeWho
  /** What became of it (delivery.ts); null without a record — never read as success. */
  state: ChangeState | null
  undo: UndoView
  /** A night floor and its give-back, folded into one line. */
  folded: boolean
}

/** The floor the hourly plans and the brain set at night is at most this many cents (bid-owner.ts NIGHT_FLOOR_MAX_CENTS). */
export const NIGHT_FLOOR_MAX_CENTS = 5
export const FOLDED_UNDO = 'Night floor pair: show the night floor to undo one step'

const cents = (v: string | null): number | null => {
  if (v == null || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : null
}

const isAuto = (r: FeedRow) => r.source === 'automation'

/** The change's Undo: the feed's handle where it offers one, else why not (delivery.ts undoView). */
export const undoOf = (r: Pick<FeedRow, 'at' | 'undoable' | 'undoActionLogId' | 'undoBlockedReason'>, now: number = Date.now()): UndoView =>
  undoView({ changeId: r.undoable ? r.undoActionLogId : null, undoBlocked: r.undoBlockedReason ?? null, at: r.at }, now)

/** What became of the change (delivery.ts changeStateOf), Undone included. */
export const stateOf = (r: Pick<FeedRow, 'delivery' | 'undoBlockedReason' | 'reason'>): ChangeState | null =>
  changeStateOf({ delivery: r.delivery?.state ?? null, undoBlocked: r.undoBlockedReason ?? null, reason: r.reason ?? null })

/** One bid's lines, NEWEST first. `raw`: every step, the night floor too. */
export function historyLines(rows: readonly FeedRow[], opts: { raw?: boolean; now?: number } = {}): { lines: HistoryLine[]; foldedSteps: number } {
  const now = opts.now ?? Date.now()
  const steps = rows
    .filter((r) => r.field === 'bid' && cents(r.newValue) !== null)
    .map((r) => ({ r, from: cents(r.oldValue), to: cents(r.newValue)! }))
    .sort((a, b) => Date.parse(a.r.at) - Date.parse(b.r.at) || a.r.id.localeCompare(b.r.id))

  const lineOf = (s: (typeof steps)[number]): HistoryLine => ({
    id: s.r.id, at: s.r.at, from: s.from, to: s.to, who: whoOf(s.r), state: stateOf(s.r), undo: undoOf(s.r, now), folded: false,
  })
  if (opts.raw) return { lines: steps.map(lineOf).reverse(), foldedSteps: 0 }

  const out: HistoryLine[] = []
  let open: (typeof steps)[number] | null = null
  for (const s of steps) {
    const floor = isAuto(s.r) && s.from !== null && s.to < s.from && s.to <= NIGHT_FLOOR_MAX_CENTS
    if (floor) {
      // A second floor while one is on keeps the first's bid (the one the morning gives back).
      if (!open) open = s
      continue
    }
    if (open && isAuto(s.r) && s.from !== null && s.from <= NIGHT_FLOOR_MAX_CENTS && s.to > s.from) {
      const before = open.from
      open = null
      if (before !== null && before !== s.to) {
        out.push({ ...lineOf(s), from: before, folded: true, undo: undoView({ changeId: null, undoBlocked: FOLDED_UNDO }) })
      }
      continue
    }
    if (open) {
      // Something else moved the bid while the floor was on: the floor stays a line of its own.
      out.push(lineOf(open))
      open = null
    }
    out.push(lineOf(s))
  }
  // A floor still on (tonight's) is today's bid: shown.
  if (open) out.push(lineOf(open))
  const foldedSteps = steps.length - out.length
  return { lines: out.reverse(), foldedSteps }
}
