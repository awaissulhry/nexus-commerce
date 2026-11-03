import type { Issue } from '../../core/errors'
import { Dec } from '../../tax/decimal'
import { USABLE_SHARE } from '../../quality/defects/grades'
import type { GradeFacts } from './usable'

/**
 * A hide's grade and shade group by record, and an article's grades (B-W2b-94; PRD-031, SCM-250; design warehouse.hides
 * record "Measurements & grade": "Office corrections of grade, shade group and thickness … a change after the first cut asks
 * for a reason … read-only for CONSUMED / SCRAPPED"; products.materials "Grades and usable area": grade, usable share %,
 * panels allowed), pure.
 *
 * W1 graded a hide in text only (Hide.grade, Hide.shade). W2b names the record and writes the text WITH it, in one update:
 * gradeId + grade (= the grade's code), shadeGroupId + shade (= the group's label); the database's Hide_grade_shade_check
 * refuses a text that says otherwise, so no route writes the text alone once a hide has a record. Clearing a record clears
 * its text. The grades offered for a hide are its article's (the grades of its active rules, else every active grade); a
 * shade group is of the hide's article and, when it names them, of the hide's colour and lot.
 *
 * An article's grade rule (ItemGradeRule): article and grade fixed, a usable share 0-100 (two decimals) and the panels that
 * may use the grade (words until pattern pieces name their lowest grade, B-W2b-85/-95; empty: every panel). One active rule
 * per article and grade; a rule is retired, never deleted.
 */

export const GRADING_LIMITS = Object.freeze({ defects: 2000, reason: 500, panels: 20, panel: 60 })

/** Thickness in millimetres: above 0, at most 9999.99 (Decimal(6,2)), two decimals. */
const THICKNESS = /^\d{1,4}(\.\d{1,2})?$/

/** The states whose hide is read-only (design: "read-only for CONSUMED / SCRAPPED"; a returned hide left the stock too). */
export function gradingRefusal(hide: { readonly code: string; readonly state: string }): string | null {
  switch (hide.state) {
    case 'CONSUMED':
      return `Hide ${hide.code} is used up: its grade and shade stay as they were cut.`
    case 'SCRAPPED':
      return `Hide ${hide.code} was scrapped: it is read-only.`
    case 'RETURNED':
      return `Hide ${hide.code} went back to the supplier: it is read-only.`
    default:
      return null
  }
}

/** A change after the first cut asks for a reason (design). */
export const reasonRequired = (hide: { readonly state: string; readonly cutEntries: number }): boolean => hide.cutEntries > 0 || hide.state === 'PARTLY_CUT' || hide.state === 'REMNANT'

export interface GradingDraft {
  readonly gradeId?: string | null | undefined
  readonly shadeGroupId?: string | null | undefined
  readonly thicknessMm?: string | null | undefined
  readonly defects?: string | null | undefined
  readonly reason?: string | null | undefined
}

/** What the body says, before the records are read. */
export function gradingDraftProblems(draft: GradingDraft, needsReason: boolean): Issue[] {
  const problems: Issue[] = []
  const changes = [draft.gradeId, draft.shadeGroupId, draft.thicknessMm, draft.defects].some((value) => value !== undefined)
  if (!changes) problems.push({ path: 'gradeId', message: 'Change the grade, the shade group, the thickness or the defects.' })
  if (draft.thicknessMm !== undefined && draft.thicknessMm !== null && (!THICKNESS.test(draft.thicknessMm.trim()) || new Dec(draft.thicknessMm.trim()).lessThanOrEqualTo(0))) {
    problems.push({ path: 'thicknessMm', message: 'The thickness is above 0 mm, at most two decimals (1.20).' })
  }
  if (draft.defects && draft.defects.trim().length > GRADING_LIMITS.defects) problems.push({ path: 'defects', message: `At most ${GRADING_LIMITS.defects} characters.` })
  const reason = draft.reason?.trim() ?? ''
  if (reason.length > GRADING_LIMITS.reason) problems.push({ path: 'reason', message: `At most ${GRADING_LIMITS.reason} characters.` })
  if (needsReason && reason === '') problems.push({ path: 'reason', message: 'The hide was cut already: say why its grade, shade, thickness or defects change.' })
  return problems
}

/** Why a grade cannot be given to this hide, or null. A grade the hide already has may stay even when retired. */
export function gradeChoiceProblem(grade: GradeFacts, current: string | null, allowed: readonly GradeFacts[], articleCode: string): string | null {
  if (grade.id === current) return null
  if (!grade.active) return `Grade ${grade.code} is retired: it is given to no hide.`
  if (!allowed.some((entry) => entry.id === grade.id)) {
    return `Grade ${grade.code} is not one of ${articleCode}'s grades (${allowed.map((entry) => entry.code).join(', ') || 'none'}): add it on the material's Grades and usable area first.`
  }
  return null
}

export interface ShadeGroupFacts {
  readonly id: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly label: string
  readonly active: boolean
}

/** Why a shade group does not fit this hide, or null (the database's factory_shade_group_fits says the same). */
export function shadeChoiceProblem(group: ShadeGroupFacts, hide: { readonly itemId: string; readonly lotId: string; readonly itemColourId: string | null; readonly shadeGroupId: string | null; readonly code: string }): string | null {
  if (group.id === hide.shadeGroupId) return null
  if (!group.active) return `Shade group ${group.label} is retired: no hide is sorted into it.`
  if (group.itemId !== hide.itemId) return `Shade group ${group.label} is of another article than hide ${hide.code}.`
  if (group.lotId !== null && group.lotId !== hide.lotId) return `Shade group ${group.label} is another lot's.`
  if (group.itemColourId !== null && group.itemColourId !== hide.itemColourId) return `Shade group ${group.label} is of another colour than hide ${hide.code}.`
  return null
}

/** The shade groups a hide may be sorted into: its article's, in its colour or any, and its own lot's or any lot's. */
export function shadeGroupsFor<G extends ShadeGroupFacts>(groups: readonly G[], hide: { readonly itemId: string; readonly lotId: string; readonly itemColourId: string | null }): G[] {
  return groups.filter((group) => group.active && group.itemId === hide.itemId && (group.lotId === null || group.lotId === hide.lotId) && (group.itemColourId === null || group.itemColourId === hide.itemColourId))
}

// ---- an article's grade rules (PRD-031) ------------------------------------------------------------------------------

export interface GradeRuleDraft {
  readonly usableShare?: string | undefined
  readonly panels?: readonly string[] | undefined
}

/** The panels as kept: trimmed, the empty ones left out, each once (any case), in the order given. */
export function panelsOf(panels: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const panel of panels) {
    const text = panel.trim().replace(/\s+/g, ' ')
    if (text === '' || seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    result.push(text)
  }
  return result
}

/** A new rule (`creating`: a share is required) or a change of one. */
export function gradeRuleDraftProblems(draft: GradeRuleDraft, creating: boolean): Issue[] {
  const problems: Issue[] = []
  if (creating && draft.usableShare === undefined) problems.push({ path: 'usableShare', message: 'Say what share of a hide of this grade can be cut, in percent.' })
  if (draft.usableShare !== undefined) {
    const text = draft.usableShare.trim()
    if (!USABLE_SHARE.test(text) || new Dec(text).greaterThan(100)) problems.push({ path: 'usableShare', message: 'The usable share is a percent from 0 to 100, at most two decimals ("72.5").' })
  }
  if (draft.panels !== undefined) {
    const panels = panelsOf(draft.panels)
    if (panels.length > GRADING_LIMITS.panels) problems.push({ path: 'panels', message: `At most ${GRADING_LIMITS.panels} panels.` })
    const long = panels.find((panel) => panel.length > GRADING_LIMITS.panel)
    if (long !== undefined) problems.push({ path: 'panels', message: `A panel is at most ${GRADING_LIMITS.panel} characters ("${long.slice(0, 20)}…").` })
  }
  return problems
}
