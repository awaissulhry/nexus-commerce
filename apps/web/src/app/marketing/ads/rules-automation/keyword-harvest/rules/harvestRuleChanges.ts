/**
 * Keyword Harvest page, Rules view (2026-10-11, lane HRULES) — what a person changes from the harvest rules table, as a
 * DRAFT and as requests. Pure, tested in Node. Nothing here sends anything.
 *
 * A mode change is POST /api/advertising/harvest/rules/mode { ids, mode } — the level dial's own path (its ceiling and
 * the graduation gate; D2: a harvest rule may reach Auto, inside its caps). A rule made in the builder for Keyword
 * Harvest (`actions[0].type = 'keyword-harvesting'`) also carries a belt (`actions[0].control`): 'manual' makes it ASK at
 * any level — so at Watch it would ask instead of watching, and at Auto it would never harvest alone (the engine's
 * `adsManualSuggest`). The mode route sets that belt itself, in one place (HCORE `setHarvestRulesMode`: 'automate' for
 * Watch and Auto first and put back when the level is refused, 'manual' for Ask me after): the page sends the mode ONLY
 * (release review RS3 — a belt write of its own could switch Manual on after a refusal). An Undo sends the level and the
 * belt the rule had before (`before`, sent back as `belt`: RS4). An engine rule (harvest_and_negate, promote_to_exact)
 * has no belt.
 *
 * The draft, archive and restore are the Bid page's own (`bid/rules/ruleChanges.ts`), imported.
 */
import type { ReviewChange } from '@/design-system/patterns'
import { MODE_WORD, holdWord, isBrain, modeRank, type BidMode, type BidRuleMode, type BidRuleRow } from '../../bid/rules/bidRulesModel'
import { canAddKeywords } from './harvestRulesModel'

/** Whether a stored rule is a builder harvest rule (its belt lives in `actions[0].control`). */
export function isHarvestBuilderRule(actions: unknown): boolean {
  const a0 = Array.isArray(actions) ? (actions[0] as { type?: unknown } | undefined) : undefined
  return a0?.type === 'keyword-harvesting'
}

export type Belt = 'manual' | 'automate'
/**
 * What a rule was before a mode change or an archive (POST /rules/mode and archive `before`, HCORE RS4 + delta review D1):
 * its set mode, its own Manual/Automate, its harvest Auto mark. An Undo sends it back UNCHANGED (`undoModeBody`), so a rule
 * saved at Auto before the release comes back at Auto still asking — never with a mark it did not have.
 */
export interface ModeBefore { mode: string; belt: Belt | null; marked?: boolean }

const isModeWord = (m: unknown): m is BidMode => m === 'OFF' || m === 'WATCH' || m === 'ASK' || m === 'AUTO'

/** The body of an Undo's mode request: `before` as it came, or null when it is not one the route takes. Pure. */
export function undoModeBody(id: string, before: ModeBefore | null | undefined): { ids: string[]; mode: BidMode; belt: Belt | null; marked?: boolean } | null {
  if (!before || !isModeWord(before.mode)) return null
  return { ids: [id], mode: before.mode, belt: before.belt ?? null, ...(typeof before.marked === 'boolean' ? { marked: before.marked } : {}) }
}

/** The level an Undo restores: the server's `before` when it is a mode, else the row's set mode. */
export const levelBefore = (before: ModeBefore | null | undefined, set: BidMode): BidMode => (isModeWord(before?.mode) ? before!.mode as BidMode : set)

/** The Done line of an archive's Undo whose mode was not put back (it is unarchived, at Off): what really happened. */
export const UNARCHIVED_AT_OFF = 'Unarchived · Off — set its mode again'

/** An archive's Undo, as its Done line says it: not unarchived; unarchived but its mode refused (at Off); or undone. Pure. */
export function archiveUndoResult(unarchive: { ok: boolean; words?: string }, mode: { ok: boolean } | null, shown: BidMode): { ok: boolean; words: string; verb?: string } {
  if (!unarchive.ok) return { ok: false, words: unarchive.words ?? 'Not unarchived', verb: 'undone' }
  if (mode && !mode.ok) return { ok: false, words: UNARCHIVED_AT_OFF, verb: 'undone' }
  return { ok: true, words: `Undone: ${MODE_WORD[shown]}` }
}

// ── one mode word (re-audit N-S2) ───────────────────────────────────────────────────────────────────────────────────

/** A rule that acts HIGHER than it is set (a builder rule whose belt asks: set to Watch, it asks you). */
export const actsHigher = (m: Pick<BidRuleMode, 'set' | 'acts'>): boolean => modeRank(m.acts) > modeRank(m.set)

/** The server's hold on a rule saved at Auto before the harvest path marked it (HCORE `PICK_AUTO_AGAIN`): it asks. */
export const PICK_AUTO_AGAIN = 'Pick Auto again'
/** A rule set to Auto that must be picked on Auto again before it acts alone (functional walk, MUST). */
export const needsAutoAgain = (m: Pick<BidRuleMode, 'set' | 'heldBy' | 'also'>): boolean =>
  m.set === 'AUTO' && (m.heldBy?.label === PICK_AUTO_AGAIN || m.also.some((h) => h.label === PICK_AUTO_AGAIN))

/**
 * The one mode word of a rule — what it DOES: a rule set to Watch that asks reads "Ask me" (its shield says why), and a
 * rule set to Auto that must be picked on Auto again reads what it does now, so picking Auto is a change that is sent.
 */
export const modeBase = (m: BidRuleMode): BidMode => (actsHigher(m) || needsAutoAgain(m) ? m.acts : m.set)

/** The mode the table and the detail show: the person's pick while drafted; else what the rule does (`modeBase`). */
export function shownHarvestMode(row: BidRuleRow, draft: Readonly<Record<string, BidMode>>): BidRuleMode {
  const pick = draft[row.id]
  if (pick) return { ...row.mode, set: pick, acts: pick, heldBy: null }
  const base = modeBase(row.mode)
  return base !== row.mode.set ? { ...row.mode, set: base } : row.mode
}

/** The draft after a pick. Picking the set mode of a rule that acts higher is a fix (saving sets its belt), so it stays. */
export function pickHarvestMode(draft: Readonly<Record<string, BidMode>>, row: BidRuleRow, next: BidMode): Record<string, BidMode> {
  if (isBrain(row) || row.archived) return { ...draft }
  const out: Record<string, BidMode> = { ...draft }
  const shown = modeBase(row.mode)
  if (next === shown) delete out[row.id]
  else out[row.id] = next
  return out
}
export const pickHarvestModeFor = (draft: Readonly<Record<string, BidMode>>, rows: readonly BidRuleRow[], next: BidMode): Record<string, BidMode> =>
  rows.reduce<Record<string, BidMode>>((d, r) => pickHarvestMode(d, r, next), { ...draft })

/** Keep only picks that still change what the rule does (after a re-read or a save). */
export function retidyHarvestModes(draft: Readonly<Record<string, BidMode>>, rows: ReadonlyMap<string, BidRuleRow>): Record<string, BidMode> {
  const out: Record<string, BidMode> = {}
  for (const [id, mode] of Object.entries(draft)) {
    const row = rows.get(id)
    if (!row || row.archived || isBrain(row)) continue
    const shown = modeBase(row.mode)
    if (mode !== shown) out[id] = mode
  }
  return out
}

/** One line of the review per drafted rule (Now = what it does). A pick that lets it add keywords needs the one tick. */
export function harvestModeReviewChanges(draft: Readonly<Record<string, BidMode>>, rows: ReadonlyMap<string, BidRuleRow>, capWords: string): ReviewChange[] {
  return Object.entries(draft).flatMap(([id, next]) => {
    const row = rows.get(id)
    if (!row) return []
    const now = modeBase(row.mode)
    const raise = canAddKeywords(now, next)
    const again = needsAutoAgain(row.mode) && next === 'AUTO' ? 'Set to Auto before: picked again, it acts by itself' : undefined
    const held = again ?? (row.mode.acts !== row.mode.set ? `Acts as ${MODE_WORD[row.mode.acts]} now${row.mode.heldBy ? `: ${holdWord(row.mode.heldBy.label)}` : ''}` : undefined)
    const note = held ?? (next === 'AUTO' ? capWords : raise ? 'Can add keywords' : undefined)
    return [{ id, where: row.name, what: 'Mode', now: MODE_WORD[now], next: MODE_WORD[next], raise, ...(note ? { note } : {}) }]
  })
}

/** The rules a bulk "Mode…" may reach: not the brain (set per product), not archived. */
export const modeable = (rows: readonly BidRuleRow[]): BidRuleRow[] => rows.filter((r) => r.kind !== 'brain' && r.id !== 'brain' && !r.archived)
