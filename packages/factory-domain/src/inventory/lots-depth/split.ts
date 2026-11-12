import type { Issue } from '../../core/errors'

/**
 * Split a lot into shade groups and regroup them (B-W2b-313; SCM-237 "Split a delivered lot into shade groups or grades
 * after sorting; each child keeps the parent link"; design warehouse.lots lt-split "hides listed with shade; drag or pick a
 * group per hide; each group becomes a child lot that keeps the parent link"; follow-up LT1:01, B-W2b-98's gap: the
 * hide-by-hide incoming inspection names the groups). Pure.
 *
 * A family is a lot that is no child (the parent) and its child lots (Lot.parentLotId, one level: the database refuses a
 * child of a child). Splitting a child makes more children of the same parent. A hide's lot is part of the ledger's key
 * (StockMove → Hide (tenant, site, lot, hide)) and never changes (W1's factory_hide_guard), so a hide that goes to another
 * lot of the family becomes a NEW hide row there, with a new tag, its grade, shade, thickness, defects and marks; its
 * stock leaves the old row and enters the new one by two ADJUSTMENT moves at the same place, reason code LOT_SPLIT or
 * LOT_REGROUP, valued at the lot's cost (the family's value does not change). The old row keeps its history and nothing on
 * hand.
 *
 * Only whole hides (FULL) with stock and nothing that names them still open move: a reservation, a quality hold, an open
 * incoming inspection, an open stock count, a warehouse task, a transfer, a claim or a subcontract kit that names a hide
 * would lose it. Only a family in QUARANTINE or RELEASED is split (a new lot starts in one of those): a blocked or rejected
 * lot is decided first.
 */

export const SPLIT_LIMITS = Object.freeze({ groups: 26, hides: 500, label: 60, note: 500 })

/** The reason codes of the two ADJUSTMENT moves of each hide (StockMove.reasonCode). */
export const SPLIT_REASON_CODE = 'LOT_SPLIT'
export const REGROUP_REASON_CODE = 'LOT_REGROUP'

export const SPLIT_KINDS = ['SPLIT', 'REGROUP'] as const
export type SplitKind = (typeof SPLIT_KINDS)[number]

/** One group of the split dialog: the hides that become one child lot, named by a shade group or a label. */
export interface SplitGroupDraft {
  readonly shadeGroupId?: string | null | undefined
  readonly label?: string | null | undefined
  readonly hideIds: readonly string[]
}

export interface SplitDraft {
  readonly groups: readonly SplitGroupDraft[]
  readonly note?: string | null | undefined
}

/** What the body says, before any row is read: at `groups/<i>/…`. */
export function splitDraftProblems(draft: SplitDraft): Issue[] {
  const problems: Issue[] = []
  if (draft.groups.length === 0) return [{ path: 'groups', message: 'Name at least one group: each becomes a child lot.' }]
  if (draft.groups.length > SPLIT_LIMITS.groups) return [{ path: 'groups', message: `At most ${SPLIT_LIMITS.groups} groups at a time.` }]
  const seen = new Map<string, number>()
  let hides = 0
  draft.groups.forEach((group, index) => {
    const at = `groups/${index}`
    const label = group.label?.trim() ?? ''
    if (!group.shadeGroupId && label === '') problems.push({ path: `${at}/label`, message: 'Pick a shade group or type a label for this group.' })
    if (label.length > SPLIT_LIMITS.label) problems.push({ path: `${at}/label`, message: `At most ${SPLIT_LIMITS.label} characters.` })
    if (group.hideIds.length === 0) problems.push({ path: `${at}/hideIds`, message: 'A group holds at least one hide.' })
    group.hideIds.forEach((hideId, position) => {
      hides += 1
      const earlier = seen.get(hideId)
      if (earlier !== undefined) problems.push({ path: `${at}/hideIds/${position}`, message: `This hide is in group ${earlier + 1} already: a hide goes to one group.` })
      else seen.set(hideId, index)
    })
  })
  if (hides > SPLIT_LIMITS.hides) problems.push({ path: 'groups', message: `At most ${SPLIT_LIMITS.hides} hides at a time.` })
  if ((draft.note?.length ?? 0) > SPLIT_LIMITS.note) problems.push({ path: 'note', message: `At most ${SPLIT_LIMITS.note} characters.` })
  return problems
}

/** The family's lot as the split reads it. */
export interface FamilyLotFacts {
  readonly code: string
  readonly qualityStatus: string
  readonly tracking: string
}

/** Why the lots of this family are not split or regrouped now (null: they may be). */
export function familyRefusal(lot: FamilyLotFacts): string | null {
  if (lot.tracking !== 'HIDE') return `Lot ${lot.code} is not counted by the hide: only a lot of hides is split into shade groups.`
  if (lot.qualityStatus === 'BLOCKED') return `Lot ${lot.code} is blocked: release or reject it before its hides are sorted into other lots.`
  if (lot.qualityStatus === 'REJECTED') return `Lot ${lot.code} is rejected: its hides go back or are scrapped, never into another lot.`
  return null
}

/** What may still name a hide, so it cannot move to another lot. */
export interface HideMoveFacts {
  readonly code: string
  readonly state: string
  /** On hand at the site, base unit. */
  readonly onHand: string
  readonly reserved: boolean
  readonly held: boolean
  readonly openInspection: string | null
  readonly openCount: string | null
  readonly openTask: boolean
  readonly openTransfer: boolean
  readonly openClaim: boolean
  readonly plannedKit: boolean
}

/** Why one hide does not move to another lot now, in words (null: it moves). */
export function hideMoveRefusal(hide: HideMoveFacts): string | null {
  if (hide.state !== 'FULL') return `Hide ${hide.code} is ${hide.state.toLowerCase().replace('_', ' ')}: only a whole hide moves to another lot.`
  if (!(Number(hide.onHand) > 0)) return `Hide ${hide.code} holds nothing at the site.`
  if (hide.reserved) return `Hide ${hide.code} is reserved for a work order or an order line: release the reservation first.`
  if (hide.held) return `Hide ${hide.code} is on a quality hold: clear the hold first.`
  if (hide.openInspection) return `Hide ${hide.code} is in incoming inspection ${hide.openInspection}, still open: decide or cancel it first.`
  if (hide.openCount) return `Hide ${hide.code} is on stock count ${hide.openCount}, still open: finish or cancel the count first.`
  if (hide.openTask) return `Hide ${hide.code} has an open warehouse task: do or cancel it first.`
  if (hide.openTransfer) return `Hide ${hide.code} is on a transfer to another site: receive or cancel it first.`
  if (hide.openClaim) return `Hide ${hide.code} is on a supplier claim not closed yet.`
  if (hide.plannedKit) return `Hide ${hide.code} is planned in a subcontract kit: take it off the kit first.`
  return null
}

/** The letters a child lot's code ends with: A … Z, then AA, AB … */
export function suffixAt(index: number): string {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/** The codes of `count` new child lots of a parent: `<parent>-A`, `<parent>-B` …, skipping codes already taken. */
export function childLotCodes(parentCode: string, taken: Iterable<string>, count: number): string[] {
  const used = new Set([...taken].map((code) => code.toUpperCase()))
  const codes: string[] = []
  for (let index = 0; codes.length < count; index++) {
    const code = `${parentCode}-${suffixAt(index)}`
    if (!used.has(code.toUpperCase())) codes.push(code)
  }
  return codes
}

/** One hide of an incoming inspection as the split's proposal reads it. */
export interface InspectedHide {
  readonly hideId: string
  readonly shadeGroupId: string | null
  readonly shadeLabel: string | null
  readonly decision: string | null
}

export interface ProposedGroup {
  readonly shadeGroupId: string | null
  readonly label: string
  readonly hideIds: string[]
}

/**
 * The groups an incoming inspection sorted the hides into (LT1:01): one group per shade group (or shade text), in the
 * order the inspection met them; hides it rejected or left to sort are kept apart in their own group, so the accepted ones
 * can be released apart from them. Hides with no shade stay out (they stay in the lot).
 */
export function proposalFromInspection(hides: readonly InspectedHide[]): ProposedGroup[] {
  const groups = new Map<string, ProposedGroup>()
  for (const hide of hides) {
    const apart = hide.decision === 'REJECTED' ? 'REJECTED' : hide.decision === 'TO_SORT' ? 'TO_SORT' : null
    const shade = hide.shadeGroupId ?? hide.shadeLabel
    if (!apart && !shade) continue
    const key = apart ?? `shade:${shade}`
    const group = groups.get(key) ?? { shadeGroupId: apart ? null : hide.shadeGroupId, label: apart === 'REJECTED' ? 'Rejected' : apart === 'TO_SORT' ? 'To sort' : (hide.shadeLabel ?? ''), hideIds: [] }
    group.hideIds.push(hide.hideId)
    groups.set(key, group)
  }
  return [...groups.values()]
}
