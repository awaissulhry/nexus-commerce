/**
 * Negative Targeting page, Rules view (2026-10-11) — what a person can change from the rules table, as a DRAFT and as
 * review lines. Pure, tested in Node. Nothing here sends anything: the view reviews the draft in the DS
 * `ReviewChangesModal` and sends the requests (`wasteRulesApi.ts`).
 *
 * A mode change is POST /api/advertising/waste/rules/mode { ids, mode } — each rule through the level dial (the API
 * refuses a step its ceiling or its gate does not allow, in words). Archive replaces delete (runs and changes kept; its
 * waiting asks expire); Unarchive brings it back at Off. The Brain and Harvest rows never enter a draft.
 */
import type { ReviewChange, ReviewConflict } from '@/design-system/patterns'
import { MODES, MODE_WORD, holdWord, modeRank, type BidMode } from '../../bid/rules/bidRulesModel'
import type { Waiting } from '../waste/wasteModel'
import { askWhat, isPseudo, isStopWaste, plural, type WaitingAsk, type WasteRuleRow } from './wasteRulesModel'

// ── the mode draft ──────────────────────────────────────────────────────────────────────────────────────────────────

/** rule id → the mode the person picked (only rules whose pick differs from what is set). */
export type ModeDraft = Readonly<Record<string, BidMode>>

export const isMode = (v: unknown): v is BidMode => typeof v === 'string' && (MODES as readonly string[]).includes(v)

/** The draft after a pick: a pick back to the set mode drops the rule. Read-only and archived rows never enter it. */
export function pickMode(draft: ModeDraft, row: WasteRuleRow, next: BidMode): ModeDraft {
  if (isPseudo(row) || row.archived) return draft
  const out: Record<string, BidMode> = { ...draft }
  if (next === row.mode.set) delete out[row.id]
  else out[row.id] = next
  return out
}

/** The same pick for many rules (the selection's "Mode"). */
export function pickModeFor(draft: ModeDraft, rows: readonly WasteRuleRow[], next: BidMode): ModeDraft {
  return rows.reduce((d, r) => pickMode(d, r, next), draft)
}

/** Keep only picks that still differ from what is set now (after a re-read or a save). */
export function retidyModes(draft: ModeDraft, rows: ReadonlyMap<string, WasteRuleRow>): ModeDraft {
  const out: Record<string, BidMode> = {}
  for (const [id, mode] of Object.entries(draft)) {
    const row = rows.get(id)
    if (row && !row.archived && !isPseudo(row) && row.mode.set !== mode) out[id] = mode
  }
  return out
}

/** The mode a row shows in the grid: the person's pick while it is in the draft, else what is set (and what acts). */
export function shownMode(row: WasteRuleRow, draft: ModeDraft): WasteRuleRow['mode'] {
  const pick = draft[row.id]
  return pick ? { ...row.mode, set: pick, acts: pick, heldBy: null } : row.mode
}

/** A pick that lets it stop things: up to Ask me (its asks pause or negate once approved) or Auto. Off → Watch is no raise. */
export const canStop = (from: BidMode, to: BidMode): boolean => (to === 'ASK' || to === 'AUTO') && modeRank(to) > modeRank(from)

/** The one tick's words for the picks that let a rule stop keywords and search terms. */
export const raiseAck = (count: number): string => (count === 1
  ? 'I understand: from its next run this rule can pause keywords or add negatives'
  : `I understand: from their next run these ${count} rules can pause keywords or add negatives`)

/** One review line per drafted rule: Where = its scope, What = Mode, Now → New. A pick that lets it stop things ticks. */
export function modeReviewChanges(draft: ModeDraft, rows: ReadonlyMap<string, WasteRuleRow>): ReviewChange[] {
  return Object.entries(draft).flatMap(([id, next]) => {
    const row = rows.get(id)
    if (!row) return []
    const raise = canStop(row.mode.set, next)
    const held = row.mode.acts !== row.mode.set ? `Acts as ${MODE_WORD[row.mode.acts]} now${row.mode.heldBy ? `: ${holdWord(row.mode.heldBy.label)}` : ''}` : undefined
    const note = held ?? (next === 'AUTO' && isStopWaste(row) ? 'Acts alone, inside its caps' : raise ? 'Can pause or add negatives' : undefined)
    return [{ id, where: row.name, what: 'Mode', now: MODE_WORD[row.mode.set], next: MODE_WORD[next], raise, ...(note ? { note } : {}) }]
  })
}

/** A drafted rule whose set mode changed since the draft was made (another tab, Claude, the Control Room). */
export function modeConflicts(draft: ModeDraft, before: ReadonlyMap<string, WasteRuleRow>, fresh: ReadonlyMap<string, WasteRuleRow>): ReviewConflict[] {
  return Object.keys(draft).flatMap((id) => {
    const was = before.get(id), now = fresh.get(id)
    if (!was) return []
    if (!now) return [{ label: was.name, was: MODE_WORD[was.mode.set], now: 'gone' }]
    if (now.archived && !was.archived) return [{ label: was.name, was: MODE_WORD[was.mode.set], now: 'archived' }]
    return now.mode.set !== was.mode.set ? [{ label: was.name, was: MODE_WORD[was.mode.set], now: MODE_WORD[now.mode.set] }] : []
  })
}

/** The draft as one request per mode (POST /rules/mode takes many ids for one mode). Ids keep the draft's order. */
export function modeGroups(draft: ModeDraft): Array<{ mode: BidMode; ids: string[] }> {
  const out = new Map<BidMode, string[]>()
  for (const [id, mode] of Object.entries(draft)) out.set(mode, [...(out.get(mode) ?? []), id])
  return [...out].map(([mode, ids]) => ({ mode, ids }))
}

// ── archive / unarchive ─────────────────────────────────────────────────────────────────────────────────────────────

export const archivable = (rows: readonly WasteRuleRow[]): WasteRuleRow[] => rows.filter((r) => !isPseudo(r) && !r.archived)
export const unarchivable = (rows: readonly WasteRuleRow[]): WasteRuleRow[] => rows.filter((r) => !isPseudo(r) && r.archived)

export function archiveReviewChanges(rows: readonly WasteRuleRow[]): ReviewChange[] {
  return archivable(rows).map((r) => ({
    id: r.id, where: r.name, what: 'Rule', now: MODE_WORD[r.mode.set], next: 'Archived',
    ...(r.waiting ? { note: `${plural(r.waiting, 'waiting ask')} ${r.waiting === 1 ? 'expires' : 'expire'}` } : {}),
  }))
}

export function unarchiveReviewChanges(rows: readonly WasteRuleRow[]): ReviewChange[] {
  return unarchivable(rows).map((r) => ({ id: r.id, where: r.name, what: 'Rule', now: 'Archived', next: MODE_WORD.OFF }))
}

export const archiveLabel = (count: number): string => `Archive ${plural(count, 'rule')}`
export const unarchiveLabel = (count: number): string => `Unarchive ${plural(count, 'rule')}`

// ── a waiting ask decided on the page ───────────────────────────────────────────────────────────────────────────────

/**
 * A rule's waiting asks as the page's ONE decide review takes them (`waste/useWasteReview.tsx`, the Wasting record's):
 * one line per ask (an ask over two ad groups says "2 places"), what it does, where (links), who asked.
 */
const pageRef = (x: { id: string; name: string; href?: string | null } | null): { id: string; name: string; href?: string } | null =>
  (x ? { id: x.id, name: x.name, ...(x.href ? { href: x.href } : {}) } : null)

export function waitsOf(asks: readonly WaitingAsk[]): Waiting[] {
  return asks.flatMap((a) => {
    const r = a.rows[0]
    if (!r) return []
    return [{
      rowId: r.id, approvalId: a.approvalId,
      text: a.rows.length > 1 ? `${r.text} · ${a.rows.length} places` : r.text,
      by: r.waiting?.by.name ?? '', what: askWhat(a), place: [r.portfolio, r.campaign, r.adGroup].map(pageRef),
    }]
  })
}

/** Done's Undo after a mode change, in words: "Undo: back to Ask me", or "Undo: put 3 back" when they differ. */
export function modeUndoLabel(previous: Readonly<Record<string, BidMode>>): string {
  const modes = [...new Set(Object.values(previous))]
  const n = Object.keys(previous).length
  return modes.length === 1 ? `Undo: back to ${MODE_WORD[modes[0]]}` : `Undo: put ${n} back`
}
