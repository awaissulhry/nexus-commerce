import type { BusinessDate } from '../../core/time'
import { isPictureIcon, isPictureTone } from '../teams/picture'
import { STRUCTURE_CODE, TEAM_LIMITS, cleanStructureCode, movePlan, type Membership, type MovePlan } from '../teams/rules'

/**
 * The factory structure (owb-ss5 steps 5.2 + 5.3; design order-workflow-2026-11-25 § 5zb "a UNIT sits under a unit, a PERSON sits in
 * a unit", § 5zd "Merge … any number", prototype org.js unitSave, unitMove, unitMerge, unitClose, orgTpl). Pure: the API
 * (apps/factory-api modules/people/units) reads the facts in its command, asks these rules first and refuses in words; the
 * database's Team_unit_check, Team_guard, TeamMember_guard and the OrderTeam guard (G4) stay the last word for every login.
 *
 *   unit        a Team row: a picture, a name, the owner's own word for its kind, ONE leader (TeamMember.isLead) or nobody, its
 *               people (TeamMember without an end) and the units under it (parentTeamId). A team is a unit that takes orders.
 *   move        a unit goes under another unit of its company (or to the top): never under itself nor under a unit that sits
 *               under it, never under a closed unit, never 50 or more levels deep.
 *   merge       any number of units of ONE site become the kept one: their people move in (effective today, the history kept),
 *               the units under them move under it, the open order rows of orders still in work move to it (never the kept
 *               team twice on one order), and they are closed (archived) with mergedIntoId.
 *   close       today's archive: refused while people, units or orders still in work are on it (the words say what to move).
 *   ready-made  the owner and the teams · with supervisors · with a general manager: the levels above the teams of ONE site,
 *               made (or opened again) by their fixed codes; the owner then changes what they like.
 *
 * Every refusal has a stable CODE (the web has the words of each code) and its words here, in English. No figure about one
 * person's work is read or written here (Statuto dei Lavoratori art. 4), and no customer's name: a customer is an id.
 */

export const UNIT_LIMITS = { name: TEAM_LIMITS.name, code: TEAM_LIMITS.code, kindWord: 40, about: 500, maxBaskets: { min: 1, max: 999 }, worksFor: 100, merge: 50, depth: 50 } as const

/** The states of an order still in work: its open team rows are "open orders" of a unit (close, merge, the board). */
export const OPEN_ORDER_STATES = ['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const
export const isOpenOrderState = (status: string): boolean => (OPEN_ORDER_STATES as readonly string[]).includes(status)

/** A refusal: its stable code, its words (EN) and the field at fault, when one is. */
export interface UnitRefusal {
  readonly code: string
  readonly words: string
  readonly field?: string
}

/** The words of every refusal whose words take no number (the API and the rules below say them; the web translates by code). */
export const UNIT_REFUSALS = {
  NAME_LENGTH: `Type a name of 1 to ${TEAM_LIMITS.name} characters.`,
  CODE_FORMAT: `A code is capitals, digits and . _ - only, no spaces, at most ${TEAM_LIMITS.code} characters.`,
  KIND_WORD_LENGTH: 'The kind is a word of 1 to 40 characters.',
  ABOUT_LENGTH: 'What it does is said in 1 to 500 characters.',
  MAX_BASKETS_RANGE: 'Baskets at one time, at most: a whole number from 1 to 999. Leave it empty for no limit.',
  PICTURE_ICON_UNKNOWN: 'Pick one of the 12 pictures.',
  PICTURE_ICON_MISSING: 'A picture needs one of the 12 pictures; or show the letters.',
  PICTURE_COLOUR_UNKNOWN: 'Pick one of the 10 colours.',
  STAND_IN_UNTIL_ALONE: 'Say who stands in for the leader before the day they stand in until.',
  STAND_IN_UNTIL_PAST: 'The last day of the stand-in is today or later.',
  STAND_IN_NOT_FOUND: 'The stand-in is a person of the same company who still works here.',
  WORKS_FOR_TWICE: 'Name each customer it works for once.',
  WORKS_FOR_TOO_MANY: 'A unit names at most 100 customers it works for.',
  WORKS_FOR_UNKNOWN: 'A customer it works for is a customer of its own company.',
  SITE_NEEDED: 'Pick the site first.',
  SITE_ARCHIVED: 'This site is archived: it takes no new unit.',
  CODE_TAKEN: 'The site has a unit with this code already: type another code.',
  UNIT_CLOSED: 'This unit is closed: it no longer changes.',
  PARENT_NOT_FOUND: 'The unit above is not one you can see: pick another unit.',
  PARENT_CLOSED: 'That unit is closed: pick an open unit to sit under.',
  PARENT_OTHER_COMPANY: 'A unit sits under a unit of its own company.',
  UNIT_UNDER_ITSELF: 'A unit cannot sit under itself.',
  UNIT_CYCLE: 'A unit cannot sit under a unit that sits under it: move that unit first.',
  UNIT_TOO_DEEP: 'The structure is kept under 50 levels: pick a unit higher up.',
  MERGE_NOTHING: 'Tick one unit or more to merge into this one.',
  MERGE_KEEP_TICKED: 'The unit that stays is not one of the units merged into it.',
  MERGE_TWICE: 'Tick each unit once.',
  MERGE_TOO_MANY: 'At most 50 units are merged at once.',
  MERGE_CLOSED: 'A closed unit is not merged: tick open units only.',
  MERGE_OTHER_SITE: 'Units of one site are merged: a team works on one site.',
  MERGE_LEADER_NOT_MEMBER: 'The leader is a person of the units that become one.',
  TEAM_NO_LINE: 'This team has no line: a loan needs a line for now.',
} as const
export type UnitRefusalCode = keyof typeof UNIT_REFUSALS

const refusal = (code: UnitRefusalCode, field?: string): UnitRefusal => ({ code, words: UNIT_REFUSALS[code], ...(field ? { field } : {}) })

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// ---- the profile ------------------------------------------------------------------------------------------------------------

/** A free text as stored: trimmed, and null when nothing is left (the database keeps no blank text). */
export function cleanUnitText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** A unit's fields as they would be stored (the API passes the cleaned, effective values: what is sent, else what is there). */
export interface UnitDraft {
  readonly name?: string
  readonly code?: string
  readonly kindWord?: string | null
  readonly about?: string | null
  readonly maxBaskets?: number | null
  readonly pictureKind?: string
  readonly pictureIcon?: string | null
  readonly pictureColour?: string | null
  readonly standInEmployeeId?: string | null
  readonly standInUntil?: BusinessDate | null
  readonly worksForPartyIds?: readonly string[]
}

/**
 * What is wrong with a unit's fields (empty: nothing), in the order of the profile window: the name, the code, the kind (1 to 40),
 * the picture (one of the 12 icons, one of the 10 tones; an ICON picture names its icon), what it does (1 to 500), the most
 * baskets (a whole number from 1 to 999, or none), the stand-in's last day (only beside a stand-in, today or later), the
 * customers it works for (each once, at most 100).
 */
export function unitFieldProblems(draft: UnitDraft, today?: BusinessDate): UnitRefusal[] {
  const problems: UnitRefusal[] = []
  if (draft.name !== undefined) {
    const name = draft.name.trim()
    if (name.length === 0 || name.length > TEAM_LIMITS.name) problems.push(refusal('NAME_LENGTH', 'name'))
  }
  if (draft.code !== undefined) {
    const code = cleanStructureCode(draft.code)
    if (code.length === 0 || code.length > TEAM_LIMITS.code || !STRUCTURE_CODE.test(code)) problems.push(refusal('CODE_FORMAT', 'code'))
  }
  if (draft.kindWord !== undefined && draft.kindWord !== null) {
    if (draft.kindWord.trim() !== draft.kindWord || draft.kindWord.length === 0 || draft.kindWord.length > UNIT_LIMITS.kindWord) problems.push(refusal('KIND_WORD_LENGTH', 'kindWord'))
  }
  if (draft.pictureIcon !== undefined && draft.pictureIcon !== null && !isPictureIcon(draft.pictureIcon)) problems.push(refusal('PICTURE_ICON_UNKNOWN', 'pictureIcon'))
  else if (draft.pictureKind === 'ICON' && draft.pictureIcon !== undefined && draft.pictureIcon === null) problems.push(refusal('PICTURE_ICON_MISSING', 'pictureIcon'))
  if (draft.pictureColour !== undefined && draft.pictureColour !== null && !isPictureTone(draft.pictureColour)) problems.push(refusal('PICTURE_COLOUR_UNKNOWN', 'pictureColour'))
  if (draft.about !== undefined && draft.about !== null) {
    if (draft.about.trim().length === 0 || draft.about.length > UNIT_LIMITS.about) problems.push(refusal('ABOUT_LENGTH', 'about'))
  }
  if (draft.maxBaskets !== undefined && draft.maxBaskets !== null) {
    if (!Number.isInteger(draft.maxBaskets) || draft.maxBaskets < UNIT_LIMITS.maxBaskets.min || draft.maxBaskets > UNIT_LIMITS.maxBaskets.max) problems.push(refusal('MAX_BASKETS_RANGE', 'maxBaskets'))
  }
  if (draft.standInUntil !== undefined && draft.standInUntil !== null) {
    if (!draft.standInEmployeeId) problems.push(refusal('STAND_IN_UNTIL_ALONE', 'standIn'))
    else if (today !== undefined && draft.standInUntil < today) problems.push(refusal('STAND_IN_UNTIL_PAST', 'standIn'))
  }
  if (draft.worksForPartyIds !== undefined) {
    if (new Set(draft.worksForPartyIds).size !== draft.worksForPartyIds.length) problems.push(refusal('WORKS_FOR_TWICE', 'worksForPartyIds'))
    else if (draft.worksForPartyIds.length > UNIT_LIMITS.worksFor) problems.push(refusal('WORKS_FOR_TOO_MANY', 'worksForPartyIds'))
  }
  return problems
}

/**
 * A unit's code from its name when none is typed (the structure page asks for a name only): capitals and digits, the rest as one
 * dash, at most 20 characters, then `-2`, `-3` … until it is free on the site; "UNIT" when the name has no letter or digit.
 */
export function codeFromName(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20)
      .replace(/-+$/g, '') || 'UNIT'
  if (!taken.has(base)) return base
  for (let n = 2; n < 10_000; n += 1) {
    const code = `${base}-${n}`
    if (!taken.has(code)) return code
  }
  return `${base.slice(0, 12)}-${Date.now().toString(36).toUpperCase()}`.slice(0, TEAM_LIMITS.code)
}

// ---- move -------------------------------------------------------------------------------------------------------------------

/** A unit as the tree rules read it. */
export interface TreeUnit {
  readonly parentId: string | null
  readonly closed: boolean
}

/**
 * Why `unitId` may not go under `parentId` (null: to the top, always allowed), read from the units of its company: never under
 * itself, an unknown or a closed unit, nor under a unit that sits under it; and the walk up from the new unit above stops before
 * 50 units (the database counts the same way).
 */
export function moveProblems(unitId: string, parentId: string | null, units: ReadonlyMap<string, TreeUnit>): UnitRefusal[] {
  if (parentId === null) return []
  if (parentId === unitId) return [refusal('UNIT_UNDER_ITSELF', 'parentId')]
  const parent = units.get(parentId)
  if (!parent) return [refusal('PARENT_NOT_FOUND', 'parentId')]
  if (parent.closed) return [refusal('PARENT_CLOSED', 'parentId')]
  const seen = new Set<string>()
  let walker: string | null = parentId
  let depth = 0
  while (walker !== null) {
    if (walker === unitId) return [refusal('UNIT_CYCLE', 'parentId')]
    depth += 1
    if (depth >= UNIT_LIMITS.depth) return [refusal('UNIT_TOO_DEEP', 'parentId')]
    // A loop in the data that does not pass through this unit: the walk stops (the database is the last word).
    if (seen.has(walker)) break
    seen.add(walker)
    walker = units.get(walker)?.parentId ?? null
  }
  return []
}

// ---- close ------------------------------------------------------------------------------------------------------------------

/** What still sits on a unit: units under it (open), its people (the leader too), its orders still in work. */
export interface CloseFacts {
  readonly units: number
  readonly people: number
  readonly openOrders: number
}

/** Why a unit cannot be closed yet, each in words that say what to move first (empty: it may be closed). */
export function closeBlockers(facts: CloseFacts): UnitRefusal[] {
  const blockers: UnitRefusal[] = []
  if (facts.units > 0) blockers.push({ code: 'CLOSE_HAS_UNITS', words: `Move the ${plural(facts.units, 'unit', 'units')} under it to another unit first.` })
  if (facts.people > 0) blockers.push({ code: 'CLOSE_HAS_PEOPLE', words: `Move its ${plural(facts.people, 'person', 'people')} to another unit first.` })
  if (facts.openOrders > 0) blockers.push({ code: 'CLOSE_HAS_ORDERS', words: `Give its ${plural(facts.openOrders, 'open order', 'open orders')} to another team first.` })
  return blockers
}

// ---- merge ------------------------------------------------------------------------------------------------------------------

/** A unit of the company (for the tree part of a merge). */
export interface MergeUnit extends TreeUnit {
  readonly id: string
}

/** A current membership (TeamMember without an end) of the kept or a merged unit. */
export interface MergeMember extends Membership {
  readonly employeeId: string
}

/** An open order row (OrderTeam without an end) of an order still in work on which the kept or a merged unit is. */
export interface MergeOrderRow {
  readonly id: string
  readonly salesOrderId: string
  readonly companyId: string
  readonly partyId: string
  readonly siteId: string
  readonly teamId: string
  readonly inCharge: boolean
  readonly basketShare: number | null
  readonly bundleIds: readonly string[]
  readonly givenBy: 'USER' | 'RULE'
}

export interface MergeFacts {
  readonly keepId: string
  readonly mergeIds: readonly string[]
  readonly today: BusinessDate
  /** Every unit of the company (ids, the unit above, closed or not). */
  readonly units: readonly MergeUnit[]
  /** The current memberships of the kept and the merged units. */
  readonly members: readonly MergeMember[]
  /** Every open row of the orders still in work on which the kept or a merged unit is (the other teams' rows too). */
  readonly orderRows: readonly MergeOrderRow[]
}

export interface MergeRowInsert {
  readonly salesOrderId: string
  readonly companyId: string
  readonly partyId: string
  readonly siteId: string
  readonly inCharge: boolean
  readonly basketShare: number | null
  readonly bundleIds: readonly string[]
  readonly givenBy: 'USER' | 'RULE'
  /** The merged rows it takes over. */
  readonly fromRowIds: readonly string[]
}

export interface MergeRowUpdate {
  readonly rowId: string
  readonly salesOrderId: string
  readonly inCharge: boolean
  readonly basketShare: number | null
  readonly bundleIds: readonly string[]
  readonly fromRowIds: readonly string[]
}

export interface MergePlan {
  /** The kept unit's new place, when one of the merged units sat above it (it takes the place of the highest one). */
  readonly keptParent: { readonly from: string | null; readonly to: string | null } | null
  /** The open units under a merged unit: they go under the kept one. */
  readonly reparent: readonly { readonly unitId: string; readonly from: string }[]
  /** The people of the merged units: each moves into the kept unit, effective today (movePlan). */
  readonly people: readonly { readonly employeeId: string; readonly fromTeamId: string; readonly plan: Extract<MovePlan, { kind: 'MOVE' }> }[]
  /** The merged order rows that end (when and who: the API). */
  readonly endRows: readonly string[]
  /** A new open row of the kept team on an order it was not on yet (one per order, never twice). */
  readonly insertRows: readonly MergeRowInsert[]
  /** The kept team's own open row on an order a merged team was on too: it takes the baskets, the share, maybe the charge. */
  readonly updateRows: readonly MergeRowUpdate[]
}

const sumShares = (shares: readonly (number | null)[]): number | null => (shares.length > 0 && shares.every((share) => share !== null) ? shares.reduce<number>((total, share) => total + (share ?? 0), 0) : null)

/**
 * What a merge of `mergeIds` into `keepId` does (the API checked the units first: open, one site, writable). Pure.
 *
 *   the tree    when a merged unit sits above the kept one, the kept one takes the place of the highest such unit (its unit
 *               above, or the top when that one is closed); then every open unit under a merged unit goes under the kept one.
 *               Done in this order, no step makes a cycle.
 *   people      every person of a merged unit moves into the kept unit, effective today (ends yesterday, or the row that began
 *               today is removed); a leader loses the flag first.
 *   orders      per order still in work: the merged rows end; when the kept team already has an open row there, that row takes
 *               their baskets (and the sum of the shares when every row has one); otherwise ONE new row of the kept team takes
 *               their baskets, share (summed) and how it was given. It takes the charge only when a merged row had it and no
 *               other open row holds it: the kept team is never twice on an order, and one team stays in charge.
 */
export function mergePlan(facts: MergeFacts): MergePlan {
  const merged = new Set(facts.mergeIds)
  const byId = new Map(facts.units.map((unit) => [unit.id, unit]))
  const kept = byId.get(facts.keepId)

  // The tree: the highest merged unit above the kept one, if any.
  let keptParent: MergePlan['keptParent'] = null
  if (kept) {
    const chain: string[] = []
    const seen = new Set<string>()
    for (let at = kept.parentId; at !== null && !seen.has(at) && chain.length < UNIT_LIMITS.depth; at = byId.get(at)?.parentId ?? null) {
      seen.add(at)
      chain.push(at)
    }
    let highest = -1
    chain.forEach((id, index) => {
      if (merged.has(id)) highest = index
    })
    if (highest >= 0) {
      const above = chain[highest + 1] ?? null
      const to = above !== null && byId.get(above) && !byId.get(above)!.closed ? above : null
      keptParent = { from: kept.parentId, to }
    }
  }
  const reparent = facts.units
    .filter((unit) => unit.id !== facts.keepId && !merged.has(unit.id) && !unit.closed && unit.parentId !== null && merged.has(unit.parentId))
    .map((unit) => ({ unitId: unit.id, from: unit.parentId! }))

  // People.
  const people = facts.members
    .filter((member) => merged.has(member.teamId))
    .flatMap((member) => {
      const plan = movePlan({ id: member.id, teamId: member.teamId, isLead: member.isLead, since: member.since }, facts.keepId, facts.today)
      return plan.kind === 'MOVE' ? [{ employeeId: member.employeeId, fromTeamId: member.teamId, plan }] : []
    })

  // Orders: per order, the merged rows, the kept row, the others.
  const endRows: string[] = []
  const insertRows: MergeRowInsert[] = []
  const updateRows: MergeRowUpdate[] = []
  const orders = [...new Set(facts.orderRows.map((row) => row.salesOrderId))]
  for (const orderId of orders) {
    const rows = facts.orderRows.filter((row) => row.salesOrderId === orderId)
    const gone = rows.filter((row) => merged.has(row.teamId))
    if (gone.length === 0) continue
    const keptRow = rows.find((row) => row.teamId === facts.keepId) ?? null
    const others = rows.filter((row) => row.teamId !== facts.keepId && !merged.has(row.teamId))
    endRows.push(...gone.map((row) => row.id))
    const goneHadCharge = gone.some((row) => row.inCharge)
    const bundleIds = [...new Set([...(keptRow?.bundleIds ?? []), ...gone.flatMap((row) => row.bundleIds)])]
    if (keptRow) {
      const takesCharge = goneHadCharge && !others.some((row) => row.inCharge)
      const inCharge = keptRow.inCharge || takesCharge
      const shared = sumShares([keptRow.basketShare, ...gone.map((row) => row.basketShare)])
      const basketShare = shared ?? keptRow.basketShare
      const changed = inCharge !== keptRow.inCharge || basketShare !== keptRow.basketShare || bundleIds.length !== keptRow.bundleIds.length
      if (changed) updateRows.push({ rowId: keptRow.id, salesOrderId: orderId, inCharge, basketShare, bundleIds, fromRowIds: gone.map((row) => row.id) })
    } else {
      const first = gone.find((row) => row.inCharge) ?? gone[0]!
      insertRows.push({
        salesOrderId: orderId,
        companyId: first.companyId,
        partyId: first.partyId,
        siteId: first.siteId,
        inCharge: goneHadCharge && !others.some((row) => row.inCharge),
        basketShare: sumShares(gone.map((row) => row.basketShare)),
        bundleIds,
        givenBy: first.givenBy,
        fromRowIds: gone.map((row) => row.id),
      })
    }
  }
  return { keptParent, reparent, people, endRows, insertRows, updateRows }
}

/** Why a merge cannot be made, from the ids alone (the API adds what it reads: closed, another site, rights). */
export function mergeIdProblems(keepId: string, mergeIds: readonly string[]): UnitRefusal[] {
  if (mergeIds.length === 0) return [refusal('MERGE_NOTHING', 'mergeIds')]
  if (mergeIds.includes(keepId)) return [refusal('MERGE_KEEP_TICKED', 'mergeIds')]
  if (new Set(mergeIds).size !== mergeIds.length) return [refusal('MERGE_TWICE', 'mergeIds')]
  if (mergeIds.length > UNIT_LIMITS.merge) return [refusal('MERGE_TOO_MANY', 'mergeIds')]
  return []
}

// ---- ready-made structures --------------------------------------------------------------------------------------------------

/** org.js ORG_TPL: simple · super · full. */
export const READY_MADE_KINDS = ['OWNER_TEAMS', 'SUPERVISORS', 'GENERAL_MANAGER'] as const
export type ReadyMadeKind = (typeof READY_MADE_KINDS)[number]

/** The fixed codes of the ready-made units of a site (unique on the site, so a unit made once is opened again, never twice). */
export const READY_MADE_CODES = { top: 'RM-TOP', manager: 'RM-GM', floor: 'RM-FLOOR', groupPrefix: 'RM-G-' } as const
export const isReadyMadeCode = (code: string): boolean => code === READY_MADE_CODES.top || code === READY_MADE_CODES.manager || code === READY_MADE_CODES.floor || code.startsWith(READY_MADE_CODES.groupPrefix)
/** A supervisor's group of an area of the site (its teams' lines are in that area). */
export const groupCodeOf = (areaCode: string): string => `${READY_MADE_CODES.groupPrefix}${areaCode}`.slice(0, TEAM_LIMITS.code)

export const READY_MADE_WORDS = { managerName: 'General management', floorName: 'Floor', topKind: 'Company', managerKind: 'Management', groupKind: 'Group' } as const

/** A unit of the site as a ready-made structure reads it. */
export interface ReadyMadeUnit {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly parentId: string | null
  readonly takesOrders: boolean
  readonly closed: boolean
  readonly mergedIntoId: string | null
  /** The area of its line (null: no line, or a line in no area). */
  readonly areaId: string | null
  readonly members: readonly { readonly employeeId: string; readonly name: string }[]
  readonly openOrders: number
}

export interface ReadyMadeFacts {
  readonly siteName: string
  readonly units: readonly ReadyMadeUnit[]
  readonly areas: readonly { readonly id: string; readonly code: string; readonly name: string; readonly sortOrder: number }[]
}

export const READY_MADE_CHANGES = ['MAKE', 'REOPEN', 'MOVE', 'CLOSE'] as const
export type ReadyMadeChangeKind = (typeof READY_MADE_CHANGES)[number]

export interface ReadyMadeChange {
  readonly change: ReadyMadeChangeKind
  /** null: a unit to make. */
  readonly unitId: string | null
  readonly code: string
  readonly name: string
  /** MAKE only: the owner's word for it. */
  readonly kindWord: string | null
  /** The unit it goes under (its code: a unit to make has no id yet); null: the top. CLOSE: null. */
  readonly parentCode: string | null
  /** The names of the unit above, before and after (null: the top), for the window's words. */
  readonly from: string | null
  readonly to: string | null
  /** CLOSE: the people taken out (they wait in "In no unit yet"). */
  readonly peopleOut: readonly { readonly employeeId: string; readonly name: string }[]
}

export interface ReadyMadePlan {
  readonly kind: ReadyMadeKind
  /** In the order they are written: the ready-made units (the top first), the units placed, then the units closed. */
  readonly changes: readonly ReadyMadeChange[]
  /** Each with the name of the unit it is about (the preview's line). */
  readonly blockers: readonly (UnitRefusal & { readonly name: string })[]
}

interface Wanted {
  readonly code: string
  readonly name: string
  readonly kindWord: string
  readonly parentCode: string | null
}

/**
 * What a ready-made structure does to ONE site (org.js orgArrange; nothing is written: the preview shows it, the apply writes it
 * after reading the facts again):
 *
 *   OWNER_TEAMS       the top unit (the site's name, kind "Company") and every unit placed under it; no level between.
 *   SUPERVISORS       the top unit → one group per area of the teams' lines (kind "Group", the area's name; "Floor" for teams of
 *                     no area) → the teams; the units that take no orders (services) beside the groups, under the top.
 *   GENERAL_MANAGER   the top unit → "General management" (kind "Management") → the groups → the teams; the services under the
 *                     general management.
 *
 * The units it places are the open units that are not ready-made and sit at the top, under a ready-made unit or under a closed
 * unit; a unit the owner put under one of their own units stays there. The ready-made units are found by their fixed codes: one
 * that exists is kept (its name too) and opened again when closed; one no longer wanted is closed, its people taken out (they wait
 * in "In no unit yet"). Refused when a ready-made unit to close has orders still in work, or a merged unit holds a fixed code.
 */
export function readyMadePreview(kind: ReadyMadeKind, facts: ReadyMadeFacts): ReadyMadePlan {
  const byId = new Map(facts.units.map((unit) => [unit.id, unit]))
  const byCode = new Map(facts.units.map((unit) => [unit.code, unit]))
  const above = kind === 'GENERAL_MANAGER' ? READY_MADE_CODES.manager : READY_MADE_CODES.top
  const wanted: Wanted[] = [{ code: READY_MADE_CODES.top, name: facts.siteName, kindWord: READY_MADE_WORDS.topKind, parentCode: null }]
  if (kind === 'GENERAL_MANAGER') wanted.push({ code: READY_MADE_CODES.manager, name: READY_MADE_WORDS.managerName, kindWord: READY_MADE_WORDS.managerKind, parentCode: READY_MADE_CODES.top })

  const placed = facts.units.filter((unit) => {
    if (unit.closed || isReadyMadeCode(unit.code)) return false
    if (unit.parentId === null) return true
    const parent = byId.get(unit.parentId)
    return !!parent && (parent.closed || isReadyMadeCode(parent.code))
  })
  const areaOf = new Map(facts.areas.map((area) => [area.id, area]))
  const targetOf = (unit: ReadyMadeUnit): string => {
    if (kind === 'OWNER_TEAMS' || !unit.takesOrders) return above
    const area = unit.areaId ? areaOf.get(unit.areaId) : undefined
    return area ? groupCodeOf(area.code) : READY_MADE_CODES.floor
  }
  if (kind !== 'OWNER_TEAMS') {
    const groups = [...new Set(placed.filter((unit) => unit.takesOrders).map(targetOf))]
    const ordered = facts.areas
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
      .filter((area) => groups.includes(groupCodeOf(area.code)))
      .map((area) => ({ code: groupCodeOf(area.code), name: area.name, kindWord: READY_MADE_WORDS.groupKind, parentCode: above }))
    const unique = ordered.filter((group, index) => ordered.findIndex((other) => other.code === group.code) === index)
    wanted.push(...unique)
    if (groups.includes(READY_MADE_CODES.floor)) wanted.push({ code: READY_MADE_CODES.floor, name: READY_MADE_WORDS.floorName, kindWord: READY_MADE_WORDS.groupKind, parentCode: above })
  }

  const wantedCodes = new Set(wanted.map((unit) => unit.code))
  const nameOfCode = (code: string | null): string | null => (code === null ? null : (wanted.find((unit) => unit.code === code && !byCode.get(code))?.name ?? byCode.get(code)?.name ?? code))
  const parentNameOf = (unit: ReadyMadeUnit): string | null => (unit.parentId ? (byId.get(unit.parentId)?.name ?? null) : null)
  const changes: ReadyMadeChange[] = []
  const blockers: (UnitRefusal & { readonly name: string })[] = []

  for (const unit of wanted) {
    const there = byCode.get(unit.code)
    if (!there) {
      changes.push({ change: 'MAKE', unitId: null, code: unit.code, name: unit.name, kindWord: unit.kindWord, parentCode: unit.parentCode, from: null, to: nameOfCode(unit.parentCode), peopleOut: [] })
      continue
    }
    if (there.mergedIntoId !== null) {
      blockers.push({ name: there.name, code: 'READY_MADE_CODE_TAKEN', words: `Unit ${there.name} was merged into another unit and keeps the code ${unit.code}, which this ready-made structure needs.` })
      continue
    }
    const parentCode = there.parentId ? (byId.get(there.parentId)?.code ?? null) : null
    if (there.closed) changes.push({ change: 'REOPEN', unitId: there.id, code: there.code, name: there.name, kindWord: null, parentCode: unit.parentCode, from: null, to: nameOfCode(unit.parentCode), peopleOut: [] })
    else if (parentCode !== unit.parentCode || (there.parentId !== null && !byId.get(there.parentId)))
      changes.push({ change: 'MOVE', unitId: there.id, code: there.code, name: there.name, kindWord: null, parentCode: unit.parentCode, from: parentNameOf(there), to: nameOfCode(unit.parentCode), peopleOut: [] })
  }
  for (const unit of placed) {
    const target = targetOf(unit)
    const parentCode = unit.parentId ? (byId.get(unit.parentId)?.code ?? null) : null
    if (parentCode === target) continue
    changes.push({ change: 'MOVE', unitId: unit.id, code: unit.code, name: unit.name, kindWord: null, parentCode: target, from: parentNameOf(unit), to: nameOfCode(target), peopleOut: [] })
  }
  for (const unit of facts.units) {
    if (unit.closed || !isReadyMadeCode(unit.code) || wantedCodes.has(unit.code)) continue
    if (unit.openOrders > 0) {
      blockers.push({ name: unit.name, code: 'READY_MADE_BLOCKED', words: `${unit.name} has ${plural(unit.openOrders, 'open order', 'open orders')}: give ${unit.openOrders === 1 ? 'it' : 'them'} to another team first.` })
      continue
    }
    changes.push({ change: 'CLOSE', unitId: unit.id, code: unit.code, name: unit.name, kindWord: null, parentCode: null, from: parentNameOf(unit), to: null, peopleOut: unit.members })
  }
  return { kind, changes, blockers }
}

const placeOf = (name: string | null): string => (name === null ? 'at the top' : `under ${name}`)

/**
 * The preview's lines (the lead's fixed answer { rows: [{ name, words }] }): one line a unit that changes, in the order it is written,
 * then one line a blocker. Empty: nothing changes (the levels are like this already).
 *
 *   MAKE    "Is made, at the top" · "Is made, under Made-up Plant A1"
 *   REOPEN  "Opens again, under …"
 *   MOVE    "Moves under Floor A (was at the top)" · "Moves to the top (was under Floor A)"
 *   CLOSE   "Leaves the chart (closed)" — and its people: "; Gina waits in “In no unit yet”"
 */
export function readyMadeRows(plan: ReadyMadePlan): { readonly name: string; readonly words: string }[] {
  const changed = plan.changes.map((change) => {
    switch (change.change) {
      case 'MAKE':
        return { name: change.name, words: `Is made, ${placeOf(change.to)}` }
      case 'REOPEN':
        return { name: change.name, words: `Opens again, ${placeOf(change.to)}` }
      case 'MOVE':
        return { name: change.name, words: `${change.to === null ? 'Moves to the top' : `Moves under ${change.to}`} (was ${placeOf(change.from)})` }
      case 'CLOSE': {
        const out = change.peopleOut.map((person) => person.name)
        return { name: change.name, words: `Leaves the chart (closed)${out.length > 0 ? `; ${out.join(', ')} ${out.length === 1 ? 'waits' : 'wait'} in “In no unit yet”` : ''}` }
      }
    }
  })
  return [...changed, ...plan.blockers.map((blocker) => ({ name: blocker.name, words: blocker.words }))]
}
