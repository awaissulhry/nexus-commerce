import { PICTURE_ICONS, PICTURE_TONES, iconOf, toneOf, type PictureIcon, type PictureTone } from '../../../lib/people-picture/model'
import type { ApiPicture } from '../../../lib/people-picture/schema'
import type { PersonRow, UnitBody, UnitRecord, UnitRow } from './api'

/**
 * owb-ss8 (S3 web B; design plan § 5zb THE STRUCTURE, § 5zd windows with every option; prototype org.js) — People › Factory structure
 * without a screen. Pure.
 *
 * ONE rule makes it simple and complex at the same time: a UNIT sits under a unit, a PERSON sits in a unit, nothing else is fixed. A team
 * is a unit that takes orders: it has people under it, never units. The chart is the tree of the flat read; the list is the same tree as
 * rows (a phone starts with it). Move = drag (the window asks first and says what moves) or Move… (its keyboard twin). Merge = tick one
 * or more of the same kind → which profile stays, its name, its leader. Close = only an empty unit (no people, no units under it, no open
 * orders): the words say what to move first. No figure about one person's work anywhere (the real app's rule).
 * Words are keys of the catalogue `factory-structure`.
 */

export const STRUCTURE_NS = 'factory-structure'

export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
const words = (key: string, params?: Words['params']): Words => (params ? { key, params } : { key })

// ── the tree ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface UnitNode {
  readonly unit: UnitRow
  readonly children: readonly UnitNode[]
  readonly depth: number
  /** The people whose home unit this is (the leader first, then by name). */
  readonly here: readonly PersonRow[]
  /** The people in it and in every unit under it. */
  readonly total: number
}

export interface Tree {
  readonly roots: readonly UnitNode[]
  readonly byId: ReadonlyMap<string, UnitNode>
  /** People in no open unit yet. */
  readonly loose: readonly PersonRow[]
  /** Open units, in the order of the tree (each once). */
  readonly order: readonly UnitNode[]
}

const byLeaderThenName = (a: PersonRow, b: PersonRow): number => Number(b.isLeader) - Number(a.isLeader) || a.name.localeCompare(b.name)

/**
 * The tree of the flat read: open units only (a closed unit keeps its history, not its place); a unit whose parent is unknown or closed
 * is a root; a loop in the data never hangs the page (a unit is placed once). The API's order is kept among brothers.
 */
export function treeOf(units: readonly UnitRow[], people: readonly PersonRow[]): Tree {
  const open = units.filter((unit) => !unit.closed)
  const ids = new Set(open.map((unit) => unit.id))
  const kids = new Map<string | null, UnitRow[]>()
  for (const unit of open) {
    const parent = unit.parentId && ids.has(unit.parentId) && unit.parentId !== unit.id ? unit.parentId : null
    kids.set(parent, [...(kids.get(parent) ?? []), unit])
  }
  const homes = new Map<string, PersonRow[]>()
  for (const row of people) if (row.unitId && ids.has(row.unitId)) homes.set(row.unitId, [...(homes.get(row.unitId) ?? []), row])
  const byId = new Map<string, UnitNode>()
  const order: UnitNode[] = []
  const placed = new Set<string>()
  const build = (unit: UnitRow, depth: number): UnitNode => {
    placed.add(unit.id)
    const children = (kids.get(unit.id) ?? []).filter((kid) => !placed.has(kid.id)).map((kid) => build(kid, depth + 1))
    const here = [...(homes.get(unit.id) ?? [])].sort(byLeaderThenName)
    const node: UnitNode = { unit, children, depth, here, total: here.length + children.reduce((sum, kid) => sum + kid.total, 0) }
    byId.set(unit.id, node)
    return node
  }
  const roots = (kids.get(null) ?? []).map((unit) => build(unit, 0))
  // A unit inside a loop (it is its own ancestor) has no root above it: it becomes a root of its own.
  for (const unit of open) if (!placed.has(unit.id)) roots.push(build(unit, 0))
  const walk = (node: UnitNode) => {
    order.push(node)
    node.children.forEach(walk)
  }
  roots.forEach(walk)
  const loose = people.filter((row) => !row.unitId || !ids.has(row.unitId)).sort((a, b) => a.name.localeCompare(b.name))
  return { roots, byId, loose, order }
}

/** The ids of a unit and every unit under it. */
export function subtreeIds(node: UnitNode): string[] {
  return [node.unit.id, ...node.children.flatMap(subtreeIds)]
}

/** The units above a unit, nearest first (the line up to the top). */
export function chainOf(tree: Tree, unitId: string): readonly UnitRow[] {
  const out: UnitRow[] = []
  const seen = new Set<string>([unitId])
  let parent = tree.byId.get(unitId)?.unit.parentId ?? null
  while (parent && !seen.has(parent) && tree.byId.has(parent)) {
    seen.add(parent)
    const node = tree.byId.get(parent)!
    out.push(node.unit)
    parent = node.unit.parentId
  }
  return out
}

/** Whom a person answers to: the leader of the home unit, else the first leader up the line (never the person). */
export function bossOf(tree: Tree, row: PersonRow): { readonly employeeId: string; readonly name: string } | null {
  if (!row.unitId) return null
  for (const unit of [tree.byId.get(row.unitId)?.unit, ...chainOf(tree, row.unitId)]) if (unit?.leader && unit.leader.employeeId !== row.employeeId) return unit.leader
  return null
}

/** The list's rows: the tree in order, each with its depth; a shut unit hides the units under it (the find box opens every unit). */
export function listRowsOf(tree: Tree, shut: ReadonlySet<string>, finding: boolean): readonly UnitNode[] {
  const out: UnitNode[] = []
  const walk = (node: UnitNode) => {
    out.push(node)
    if (finding || !shut.has(node.unit.id)) node.children.forEach(walk)
  }
  tree.roots.forEach(walk)
  return out
}

/** The view a page starts with: the address's, else the list on a narrow room (a phone), else the chart. */
export function viewOf(param: string | null | undefined, narrow: boolean): 'chart' | 'list' {
  return param === 'chart' || param === 'list' ? param : narrow ? 'list' : 'chart'
}

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()

/** The find box: a unit is marked when every word typed is in its name, its kind, or the name or role of one of its people. */
export function hitsOf(tree: Tree, query: string): ReadonlySet<string> {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return new Set()
  const hits = new Set<string>()
  for (const node of tree.order) {
    const own = fold(`${node.unit.name} ${node.unit.kindWord ?? ''}`)
    const person = node.here.some((row) => terms.every((term) => fold(`${row.name} ${row.role ?? ''}`).includes(term)))
    if (person || terms.every((term) => own.includes(term))) hits.add(node.unit.id)
  }
  return hits
}

// ── move (drag or Move…) ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type Drag = { readonly kind: 'unit'; readonly id: string } | { readonly kind: 'person'; readonly id: string }

/** The drag's text (dataTransfer): `unit:<id>` or `person:<id>`; anything else reads as nothing. */
export const dragText = (drag: Drag): string => `${drag.kind}:${drag.id}`
export function dragOf(text: string | null | undefined): Drag | null {
  const match = /^(unit|person):(.+)$/.exec(text ?? '')
  return match ? { kind: match[1] as Drag['kind'], id: match[2]! } : null
}

export type MoveAsk =
  | { readonly kind: 'unit'; readonly unitId: string; readonly parentId: string | null; readonly from: string | null; readonly to: string | null; readonly people: number }
  | { readonly kind: 'person'; readonly employeeId: string; readonly unitId: string; readonly from: string | null; readonly to: string; readonly leaves: boolean }

/**
 * What a drop (or a pick in Move…) asks: the unit and its people go under the target (never under itself or a unit under it, never under
 * a team: a team has people under it, not units), or the person moves to the target unit (a leader who moves leaves the unit without a
 * leader). A drop on the place it already is asks nothing. `parentId` null = the top.
 */
export function moveAskOf(tree: Tree, drag: Drag, target: string | null): MoveAsk | Words {
  if (drag.kind === 'unit') {
    const node = tree.byId.get(drag.id)
    if (!node) return words('move.refused.gone')
    if (target !== null && subtreeIds(node).includes(target)) return words('move.refused.self')
    const to = target === null ? null : tree.byId.get(target)
    if (target !== null && !to) return words('move.refused.gone')
    if (to?.unit.takesOrders) return words('move.refused.team')
    if ((node.unit.parentId ?? null) === target) return words('move.refused.same')
    return { kind: 'unit', unitId: node.unit.id, parentId: target, from: node.unit.parentId ? (tree.byId.get(node.unit.parentId)?.unit.name ?? null) : null, to: to?.unit.name ?? null, people: node.total }
  }
  const row = [...tree.order.flatMap((node) => node.here), ...tree.loose].find((each) => each.employeeId === drag.id)
  if (!row || target === null) return words('move.refused.gone')
  const to = tree.byId.get(target)
  if (!to) return words('move.refused.gone')
  if (row.unitId === target) return words('move.refused.same')
  return { kind: 'person', employeeId: row.employeeId, unitId: target, from: row.unitId ? (tree.byId.get(row.unitId)?.unit.name ?? null) : null, to: to.unit.name, leaves: row.isLeader }
}

export const isAsk = (value: MoveAsk | Words): value is MoveAsk => 'kind' in value

/** The units a unit may go under in Move… (with "the top" first when it is not there already), or the units a person may go to. */
export function moveTargetsOf(tree: Tree, drag: Drag): { readonly top: boolean; readonly units: readonly UnitNode[] } {
  if (drag.kind === 'person') {
    const row = [...tree.order.flatMap((node) => node.here), ...tree.loose].find((each) => each.employeeId === drag.id)
    return { top: false, units: tree.order.filter((node) => node.unit.id !== row?.unitId) }
  }
  const node = tree.byId.get(drag.id)
  if (!node) return { top: false, units: [] }
  const own = new Set(subtreeIds(node))
  return { top: node.unit.parentId !== null, units: tree.order.filter((each) => !own.has(each.unit.id) && !each.unit.takesOrders && each.unit.id !== node.unit.parentId) }
}

/** Move…'s search: the units whose name or kind holds every word typed. */
export function filterUnits(units: readonly UnitNode[], query: string): readonly UnitNode[] {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  return terms.length === 0 ? units : units.filter((node) => terms.every((term) => fold(`${node.unit.name} ${node.unit.kindWord ?? ''}`).includes(term)))
}

// ── merge ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The units a unit may merge with: the same kind (teams with teams), not the top, not above or under it, not itself. */
export function mergeCandidatesOf(tree: Tree, unitId: string): readonly UnitNode[] {
  const node = tree.byId.get(unitId)
  if (!node) return []
  const below = new Set(subtreeIds(node))
  const above = new Set(chainOf(tree, unitId).map((unit) => unit.id))
  return tree.order.filter((each) => !below.has(each.unit.id) && !above.has(each.unit.id) && each.unit.takesOrders === node.unit.takesOrders && each.unit.parentId !== null)
}

export interface MergeDraft {
  readonly baseId: string
  readonly picked: readonly string[]
  readonly step: 'pick' | 'confirm'
  /** The profile that stays (its picture, its place). */
  readonly keepId: string
  readonly name: string
  /** The leader of the one unit; null = nobody yet. */
  readonly leaderId: string | null
}

export function mergeDraftOf(tree: Tree, baseId: string): MergeDraft {
  const node = tree.byId.get(baseId)
  return { baseId, picked: [], step: 'pick', keepId: baseId, name: node?.unit.name ?? '', leaderId: node?.unit.leader?.employeeId ?? null }
}

export function tickMerge(draft: MergeDraft, unitId: string): MergeDraft {
  return { ...draft, picked: draft.picked.includes(unitId) ? draft.picked.filter((id) => id !== unitId) : [...draft.picked, unitId] }
}

/** The units of the merger: the base and the ticked ones. */
export const mergeIdsOf = (draft: MergeDraft): readonly string[] => [draft.baseId, ...draft.picked.filter((id) => id !== draft.baseId)]

/** Which profile stays: its name becomes the default name (while the name was the old default) and its leader the default leader. */
export function keepMerge(tree: Tree, draft: MergeDraft, keepId: string): MergeDraft {
  if (!mergeIdsOf(draft).includes(keepId)) return draft
  const was = tree.byId.get(draft.keepId)?.unit
  const now = tree.byId.get(keepId)?.unit
  return { ...draft, keepId, name: !draft.name.trim() || draft.name === was?.name ? (now?.name ?? draft.name) : draft.name, leaderId: draft.leaderId === (was?.leader?.employeeId ?? null) ? (now?.leader?.employeeId ?? null) : draft.leaderId }
}

/** The leaders the one unit may keep: a leader of one of the units merged. */
export function mergeLeadersOf(tree: Tree, draft: MergeDraft): readonly { readonly employeeId: string; readonly name: string }[] {
  const seen = new Set<string>()
  return mergeIdsOf(draft).flatMap((id) => {
    const leader = tree.byId.get(id)?.unit.leader
    if (!leader || seen.has(leader.employeeId)) return []
    seen.add(leader.employeeId)
    return [leader]
  })
}

/** "n people and m open orders move to it": the people of every unit merged into the one that stays. */
export function mergeMovesOf(tree: Tree, draft: MergeDraft): { readonly people: number; readonly units: number } {
  const gone = mergeIdsOf(draft).filter((id) => id !== draft.keepId)
  return { people: gone.reduce((sum, id) => sum + (tree.byId.get(id)?.total ?? 0), 0), units: gone.length }
}

export const NAME_MAX = 60

export function mergeHeldOf(draft: MergeDraft): Words | null {
  if (draft.picked.length === 0) return words('merge.held.pick')
  if (draft.step === 'pick') return null
  const name = draft.name.trim()
  if (!name) return words('merge.held.name')
  return name.length > NAME_MAX ? words('held.long', { count: NAME_MAX }) : null
}

/** The body of POST /people/units/merge. */
export function mergeBodyOf(draft: MergeDraft): { keepId: string; mergeIds: string[]; name: string; leaderEmployeeId: string | null } {
  return { keepId: draft.keepId, mergeIds: mergeIdsOf(draft).filter((id) => id !== draft.keepId), name: draft.name.trim(), leaderEmployeeId: draft.leaderId }
}

// ── close ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What to move first (empty: it may close). The top unit never closes. Open orders come from the unit's read (its Work). */
export function closeBlockersOf(node: UnitNode, openOrders: number): readonly Words[] {
  const out: Words[] = []
  if (node.unit.parentId === null) out.push(words('close.top'))
  if (node.children.length > 0) out.push(words('close.units', { count: node.children.length }))
  if (node.here.length > 0) out.push(words('close.people', { count: node.here.length }))
  if (openOrders > 0) out.push(words('close.orders', { count: openOrders }))
  return out
}

/** The open orders of a unit's work (not shipped, not delivered, not withdrawn). */
export function openOrdersOf(record: Pick<UnitRecord, 'work'> | null): number {
  return (record?.work ?? []).filter((order) => !['SHIPPED', 'DELIVERED', 'WITHDRAWN', 'CANCELLED', 'CLOSED'].includes(order.state.toUpperCase())).length
}

// ── the picture (letters · 12 icons · 10 colours, no photo) ─────────────────────────────────────────────────────────────────

export interface PictureDraft {
  readonly kind: 'LETTERS' | 'ICON'
  readonly icon: PictureIcon | null
  readonly colour: PictureTone
}

export function pictureDraftOf(picture: ApiPicture | null | undefined, fallbackTone: PictureTone): PictureDraft {
  const icon = iconOf(picture?.icon)
  return { kind: picture?.kind === 'ICON' && icon ? 'ICON' : 'LETTERS', icon: picture?.kind === 'ICON' ? icon : null, colour: picture?.colour ? toneOf(picture.colour) : fallbackTone }
}

export const pickLetters = (draft: PictureDraft): PictureDraft => ({ ...draft, kind: 'LETTERS', icon: null })
export const pickIcon = (draft: PictureDraft, icon: string): PictureDraft => (iconOf(icon) ? { ...draft, kind: 'ICON', icon: iconOf(icon) } : draft)
export const pickColour = (draft: PictureDraft, colour: string): PictureDraft => ((PICTURE_TONES as readonly string[]).includes(colour) ? { ...draft, colour: colour as PictureTone } : draft)

/** A new unit's colour: the next of the 10 by how many units there are (two new units side by side differ). */
export const toneForNew = (count: number): PictureTone => PICTURE_TONES[Math.abs(count) % PICTURE_TONES.length]!

export { PICTURE_ICONS, PICTURE_TONES }

// ── Edit the profile / A new unit ────────────────────────────────────────────────────────────────────────────────────────────

export interface UnitDraft {
  /** null: a new unit. */
  readonly id: string | null
  readonly version: number
  readonly siteId: string
  readonly parentId: string | null
  readonly takesOrders: boolean
  readonly name: string
  readonly kindWord: string
  readonly about: string
  readonly picture: PictureDraft
  readonly leaderId: string | null
  readonly standInId: string | null
  readonly standInUntil: string
  readonly worksFor: readonly string[]
  /** As typed ("" = no limit). */
  readonly maxBaskets: string
  readonly takesNewOrders: boolean
}

export const ABOUT_MAX = 140
export const KIND_MAX = 30

/** The kinds offered (your own word is fine): words of the catalogue `kind.<KEY>`. */
export const KIND_WORDS = ['COMPANY', 'MANAGEMENT', 'DEPARTMENT', 'GROUP', 'SERVICE'] as const

export function newUnitDraftOf(input: { siteId: string; parentId: string | null; takesOrders: boolean; count: number }): UnitDraft {
  return {
    id: null,
    version: 0,
    siteId: input.siteId,
    parentId: input.parentId,
    takesOrders: input.takesOrders,
    name: '',
    kindWord: '',
    about: '',
    picture: { kind: 'LETTERS', icon: null, colour: toneForNew(input.count) },
    leaderId: null,
    standInId: null,
    standInUntil: '',
    worksFor: [],
    maxBaskets: '',
    takesNewOrders: true,
  }
}

export function unitDraftOf(record: UnitRecord): UnitDraft {
  return {
    id: record.id,
    version: record.version,
    siteId: record.siteId,
    parentId: record.parentId,
    takesOrders: record.takesOrders,
    name: record.name,
    kindWord: record.kindWord ?? '',
    about: record.about ?? '',
    picture: pictureDraftOf(record.picture, 'slate'),
    leaderId: record.leader?.employeeId ?? null,
    standInId: record.standIn?.employeeId ?? null,
    standInUntil: record.standIn?.until?.slice(0, 10) ?? '',
    worksFor: record.worksFor.map((party) => party.partyId),
    maxBaskets: record.maxBaskets === null ? '' : String(record.maxBaskets),
    takesNewOrders: record.takesNewOrders,
  }
}

/** The leader changes: the stand-in can never be the leader. */
export function withLeader(draft: UnitDraft, leaderId: string | null): UnitDraft {
  return { ...draft, leaderId, standInId: draft.standInId === leaderId ? null : draft.standInId }
}

/** "Works for": all customers (none ticked) or the ones ticked (a wish, not a wall). */
export function toggleWorksFor(draft: UnitDraft, partyId: string | null): UnitDraft {
  if (partyId === null) return { ...draft, worksFor: [] }
  return { ...draft, worksFor: draft.worksFor.includes(partyId) ? draft.worksFor.filter((id) => id !== partyId) : [...draft.worksFor, partyId] }
}

/** Baskets at one time, at most: "" = no limit, else a whole number 1 … 999; null = not a number (held). */
export function maxBasketsOf(text: string): number | null | undefined {
  const value = text.trim()
  if (!value) return null
  return /^\d{1,3}$/.test(value) && Number(value) >= 1 ? Number(value) : undefined
}

/** Why Save / Make it waits (null: it saves). */
export function unitHeldOf(draft: UnitDraft, otherNames: readonly string[]): Words | null {
  const name = draft.name.trim()
  if (!name) return words('unit.held.name')
  if (name.length > NAME_MAX) return words('held.long', { count: NAME_MAX })
  if (otherNames.some((other) => fold(other) === fold(name))) return words('unit.held.taken')
  if (draft.kindWord.trim().length > KIND_MAX) return words('held.long', { count: KIND_MAX })
  if (draft.about.trim().length > ABOUT_MAX) return words('held.long', { count: ABOUT_MAX })
  if (draft.takesOrders && maxBasketsOf(draft.maxBaskets) === undefined) return words('unit.held.max')
  if (draft.standInId && draft.standInUntil && !/^\d{4}-\d{2}-\d{2}$/.test(draft.standInUntil)) return words('unit.held.until')
  return null
}

/** The body of POST / PATCH /people/units (the leader goes through today's PUT …/lead after it). */
export function unitBodyOf(draft: UnitDraft): UnitBody {
  const max = draft.takesOrders ? maxBasketsOf(draft.maxBaskets) : null
  return {
    name: draft.name.trim(),
    kindWord: draft.takesOrders ? null : draft.kindWord.trim() || null,
    takesOrders: draft.takesOrders,
    pictureKind: draft.picture.kind,
    pictureIcon: draft.picture.kind === 'ICON' ? draft.picture.icon : null,
    pictureColour: draft.picture.colour,
    about: draft.about.trim() || null,
    standInEmployeeId: draft.standInId,
    standInUntil: draft.standInId && draft.standInUntil ? draft.standInUntil : null,
    worksForPartyIds: [...draft.worksFor],
    maxBaskets: max ?? null,
    takesNewOrders: draft.takesOrders ? draft.takesNewOrders : true,
  }
}

/** The leader of a saved unit changed in the window: one more call, today's PUT /people/teams/:id/lead. */
export const leaderChanged = (draft: UnitDraft, record: Pick<UnitRecord, 'leader'> | null): boolean => draft.id !== null && (record?.leader?.employeeId ?? null) !== draft.leaderId

// ── a person ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Reads and speaks": the worker's language (one code). Urdu brings the floor's Urdu words and voice. */
export const SPEAKS = ['en', 'ur'] as const

export interface PersonDraft {
  readonly employeeId: string
  readonly version: number
  readonly role: string
  readonly phone: string
  readonly locale: string
  readonly since: string
}

export const ROLE_MAX = 60
export const PHONE_MAX = 30

export function personDraftOf(facts: { id: string; version: number; jobRole: string | null; phone?: string | null; locale: string; startDate: string }): PersonDraft {
  return { employeeId: facts.id, version: facts.version, role: facts.jobRole ?? '', phone: facts.phone ?? '', locale: facts.locale, since: facts.startDate.slice(0, 10) }
}

export function personHeldOf(draft: PersonDraft): Words | null {
  if (draft.role.trim().length > ROLE_MAX) return words('held.long', { count: ROLE_MAX })
  if (draft.phone.trim().length > PHONE_MAX) return words('held.long', { count: PHONE_MAX })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.since)) return words('person.held.since')
  return /^[a-z]{2,3}$/.test(draft.locale) ? null : words('person.held.speaks')
}

/** The body of today's PATCH /people/employees/:id: the phone only for someone with the personal right. */
export function personBodyOf(draft: PersonDraft, mayPhone: boolean): { version: number; jobRole: string | null; locale: string; startDate: string; phone?: string | null } {
  const body = { version: draft.version, jobRole: draft.role.trim() || null, locale: draft.locale, startDate: draft.since }
  return mayPhone ? { ...body, phone: draft.phone.trim() || null } : body
}

export interface AddDraft {
  readonly firstName: string
  readonly lastName: string
  readonly role: string
  readonly unitId: string | null
  readonly startDate: string
}

export function addDraftOf(unitId: string | null, today: string): AddDraft {
  return { firstName: '', lastName: '', role: '', unitId, startDate: today }
}

export function addHeldOf(draft: AddDraft): Words | null {
  if (!draft.firstName.trim() || !draft.lastName.trim()) return words('add.held.name')
  if (draft.firstName.trim().length > NAME_MAX || draft.lastName.trim().length > NAME_MAX) return words('held.long', { count: NAME_MAX })
  if (!draft.unitId) return words('add.held.unit')
  return /^\d{4}-\d{2}-\d{2}$/.test(draft.startDate) ? null : words('person.held.since')
}

// ── profiles and the address ─────────────────────────────────────────────────────────────────────────────────────────────────

export const UNIT_TABS = ['overview', 'people', 'work', 'history'] as const
export const PERSON_TABS = ['overview', 'history'] as const
export type UnitTab = (typeof UNIT_TABS)[number]
export type PersonTab = (typeof PERSON_TABS)[number]

export function tabOf<T extends string>(param: string | null | undefined, tabs: readonly T[]): T {
  return (tabs as readonly string[]).includes(param ?? '') ? (param as T) : tabs[0]!
}

export interface StructureTerms {
  readonly view: 'chart' | 'list' | null
  readonly unit: string | null
  readonly person: string | null
  readonly tab: string | null
  /** `?new=team` (the Teams page's "New team…"): the window "A new unit" opens as a team. */
  readonly newTeam: boolean
}

export function termsOf(params: { get(name: string): string | null } | null | undefined): StructureTerms {
  const view = params?.get('view')
  return { view: view === 'chart' || view === 'list' ? view : null, unit: params?.get('unit') || null, person: params?.get('person') || null, tab: params?.get('tab') || null, newTeam: params?.get('new') === 'team' }
}

/** The address of the page, a unit's or a person's profile (one at a time) and its tab. */
export function structureHref(path: string, terms: Partial<StructureTerms>): string {
  const query = new URLSearchParams()
  if (terms.view) query.set('view', terms.view)
  if (terms.unit) query.set('unit', terms.unit)
  else if (terms.person) query.set('person', terms.person)
  if ((terms.unit || terms.person) && terms.tab && terms.tab !== 'overview') query.set('tab', terms.tab)
  const text = query.toString()
  return `${path}${text ? `?${text}` : ''}`
}

/** The rights of the page: changes with people.structure.manage (and the read's `may.manage`); a person's own fields and Add a person
 * with today's people.employees.manage too; a phone with the personal right. */
export function structureRightsOf(permissions: readonly string[], mayManage: boolean): { readonly manage: boolean; readonly phone: boolean; readonly editPerson: boolean } {
  const manage = mayManage && permissions.includes('people.structure.manage')
  return { manage, phone: permissions.includes('fields.personal.view'), editPerson: manage && permissions.includes('people.employees.manage') }
}
