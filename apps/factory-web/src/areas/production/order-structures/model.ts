import type { OrderStructure, RuleRow, StructureRow, StructureFrom } from './api'

/**
 * owb-ss8 (S3 web B; design plan § 5zj C ORDER STRUCTURES; prototype rules.js) — Production › Order structures and the order's and the
 * customer's parts, without a screen. Pure.
 *
 * THREE things, no more: a STRUCTURE (a named way to handle an order: steps "as the product says" in v1, its team(s), its office people;
 * the production manager), a RULE (one sentence "When an order line is from ⟨customer | any⟩ and is ⟨category | any⟩ → ⟨structure⟩"; the
 * owner and sales), and ONE ORDER by hand with a reason ("Back to the rules" undoes it). ONE list read from the top: the first rule that
 * fits wins; the last line is fixed, "Everything else → the normal way". It cannot go wrong in silence: a rule that a broader rule above
 * takes whole says "Never used" (one press moves it up), a rule whose structure is closed says so, two rules for exactly the same orders
 * are refused. An order keeps its structure at the first print. Words are keys of the catalogue `order-structures`.
 */

export const ORDER_STRUCTURES_NS = 'order-structures'

export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
const words = (key: string, params?: Words['params']): Words => (params ? { key, params } : { key })

// S4 ProductType: the category of a rule is the style's product type today (ProductType enum); S4's product types replace this list.
export const CATEGORIES = ['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER'] as const

/** A category's words: its own key when known, else the code as the server sent it (a new type from S4). */
export const categoryKeyOf = (category: string): string => ((CATEGORIES as readonly string[]).includes(category) ? `category.${category}` : '')

// ── the rules list ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The open rules in their order (the list read from the top) and the closed ones (kept, can open again). */
export function rulesOf(rules: readonly RuleRow[]): { readonly open: readonly RuleRow[]; readonly closed: readonly RuleRow[] } {
  const sorted = [...rules].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
  return { open: sorted.filter((rule) => !rule.closed), closed: sorted.filter((rule) => rule.closed) }
}

/** A rule's number in the list (1 = read first); 0 when it is not an open rule. */
export const ruleNoOf = (open: readonly RuleRow[], ruleId: string): number => open.findIndex((rule) => rule.id === ruleId) + 1

/** The parts of a rule's sentence (the view says them): its customer (null = any), its category (null = any), its structure. */
export function sentenceOf(rule: Pick<RuleRow, 'party' | 'category' | 'structure'>): { readonly customer: string | null; readonly category: string | null; readonly structure: string } {
  return { customer: rule.party?.name ?? null, category: rule.category, structure: rule.structure.name }
}

/** A rule's mark: its structure is closed · never used (a rule above takes all its orders) · it fits n open orders now. */
export type RuleMark = { readonly kind: 'closedStructure' } | { readonly kind: 'dead'; readonly above: number } | { readonly kind: 'fits'; readonly count: number }

export function ruleMarkOf(open: readonly RuleRow[], rule: RuleRow): RuleMark {
  if (rule.structure.closed) return { kind: 'closedStructure' }
  if (rule.dead) return { kind: 'dead', above: rule.deadBecause ? ruleNoOf(open, rule.deadBecause.ruleId) : 0 }
  return { kind: 'fits', count: rule.fitsNow.count }
}

/** Up (−1: read sooner) or down (+1): the new order of the open rules' ids; unchanged at an end. */
export function moveRuleIds(open: readonly RuleRow[], ruleId: string, delta: -1 | 1): readonly string[] | null {
  const ids = open.map((rule) => rule.id)
  const at = ids.indexOf(ruleId)
  const to = at + delta
  if (at < 0 || to < 0 || to >= ids.length) return null
  const next = [...ids]
  next[at] = ids[to]!
  next[to] = ruleId
  return next
}

/** "Move it up": a never-used rule goes right above the rule that takes all its orders. */
export function aboveIds(open: readonly RuleRow[], ruleId: string, aboveId: string): readonly string[] | null {
  const ids = open.map((rule) => rule.id).filter((id) => id !== ruleId)
  const at = ids.indexOf(aboveId)
  if (at < 0 || !open.some((rule) => rule.id === ruleId)) return null
  return [...ids.slice(0, at), ruleId, ...ids.slice(at)]
}

/** q takes every order that r could take: q is as broad or broader on both parts. */
const covers = (q: { partyId: string | null; category: string | null }, r: { partyId: string | null; category: string | null }): boolean => (!q.partyId || q.partyId === r.partyId) && (!q.category || q.category === r.category)

const keyOfRule = (rule: RuleRow) => ({ partyId: rule.party?.id ?? null, category: rule.category })

/** Where a new rule goes: above the first open rule (with an open structure) that would take all its orders, else last (1-based). */
export function placeOf(open: readonly RuleRow[], draft: { partyId: string | null; category: string | null }, without: string | null = null): number {
  const list = open.filter((rule) => rule.id !== without)
  const at = list.findIndex((rule) => !rule.structure.closed && rule.active && covers(keyOfRule(rule), draft))
  return (at < 0 ? list.length : at) + 1
}

/** The open rule for exactly the same orders (refused: two rules for the same orders are never both used). */
export function sameRuleOf(open: readonly RuleRow[], draft: { id: string | null; partyId: string | null; category: string | null }): RuleRow | null {
  return open.find((rule) => rule.id !== draft.id && (rule.party?.id ?? null) === draft.partyId && rule.category === draft.category) ?? null
}

// ── the rule window ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RuleDraft {
  readonly id: string | null
  readonly version: number
  readonly partyId: string | null
  readonly category: string | null
  readonly structureId: string | null
  readonly note: string
}

export const RULE_NOTE_MAX = 120

export function newRuleDraftOf(preset: { partyId?: string | null; category?: string | null; structureId?: string | null } = {}): RuleDraft {
  return { id: null, version: 0, partyId: preset.partyId ?? null, category: preset.category ?? null, structureId: preset.structureId ?? null, note: '' }
}

export function ruleDraftOf(rule: RuleRow): RuleDraft {
  return { id: rule.id, version: rule.version, partyId: rule.party?.id ?? null, category: rule.category, structureId: rule.structure.id, note: rule.note ?? '' }
}

export function ruleHeldOf(draft: RuleDraft, open: readonly RuleRow[], structures: readonly StructureRow[]): Words | null {
  const structure = structures.find((each) => each.id === draft.structureId)
  if (!structure) return words('rule.held.structure')
  if (structure.closed) return words('rule.held.closed')
  const same = sameRuleOf(open, draft)
  if (same) return words('rule.held.same', { n: ruleNoOf(open, same.id) })
  return draft.note.trim().length > RULE_NOTE_MAX ? words('held.long', { count: RULE_NOTE_MAX }) : null
}

export function ruleBodyOf(draft: RuleDraft): { partyId: string | null; category: string | null; structureId: string; note?: string } {
  const note = draft.note.trim()
  return { partyId: draft.partyId, category: draft.category, structureId: draft.structureId ?? '', ...(note ? { note } : {}) }
}

// ── the structure window ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StructureDraft {
  readonly id: string | null
  readonly version: number
  readonly name: string
  /** The first team is in charge when several work together. */
  readonly teamIds: readonly string[]
  readonly peopleIds: readonly string[]
  readonly note: string
}

export const STRUCTURE_NAME_MAX = 60
export const STRUCTURE_NOTE_MAX = 140

export const newStructureDraftOf = (): StructureDraft => ({ id: null, version: 0, name: '', teamIds: [], peopleIds: [], note: '' })
export function structureDraftOf(row: StructureRow, copy = false): StructureDraft {
  return { id: copy ? null : row.id, version: copy ? 0 : row.version, name: row.name, teamIds: row.teams.map((team) => team.id), peopleIds: row.people.map((person) => person.userId), note: row.note ?? '' }
}

const toggle = (list: readonly string[], id: string): readonly string[] => (list.includes(id) ? list.filter((each) => each !== id) : [...list, id])
export const toggleTeam = (draft: StructureDraft, teamId: string): StructureDraft => ({ ...draft, teamIds: toggle(draft.teamIds, teamId) })
export const togglePerson = (draft: StructureDraft, userId: string): StructureDraft => ({ ...draft, peopleIds: toggle(draft.peopleIds, userId) })

/** What the team part says: no team (given by hand, as today) · this team at Confirm · these teams together, the first in charge. */
export function teamsNoteOf(draft: Pick<StructureDraft, 'teamIds'>): Words {
  return words(draft.teamIds.length === 0 ? 'structure.teams.none' : draft.teamIds.length === 1 ? 'structure.teams.one' : 'structure.teams.many')
}

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim()

export function structureHeldOf(draft: StructureDraft, others: readonly StructureRow[]): Words | null {
  const name = draft.name.trim()
  if (!name) return words('structure.held.name')
  if (name.length > STRUCTURE_NAME_MAX) return words('held.long', { count: STRUCTURE_NAME_MAX })
  if (others.some((row) => row.id !== draft.id && !row.closed && fold(row.name) === fold(name))) return words('structure.held.taken')
  return draft.note.trim().length > STRUCTURE_NOTE_MAX ? words('held.long', { count: STRUCTURE_NOTE_MAX }) : null
}

export function structureBodyOf(draft: StructureDraft): { name: string; teamIds: string[]; peopleUserIds: string[]; note?: string } {
  const note = draft.note.trim()
  return { name: draft.name.trim(), teamIds: [...draft.teamIds], peopleUserIds: [...draft.peopleIds], ...(note ? { note } : {}) }
}

// ── the page's head ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function headOf(structures: readonly StructureRow[], rules: readonly RuleRow[], neverUsed: number): { readonly structures: number; readonly rules: number; readonly neverUsed: number } {
  return { structures: structures.filter((row) => !row.closed).length, rules: rulesOf(rules).open.length, neverUsed }
}

// ── one order: the part "Order structure" and "Another structure for this order…" ───────────────────────────────────────────

export const FROM_TONE: Readonly<Record<StructureFrom, 'info' | 'warning' | 'neutral'>> = { RULE: 'info', ORDER: 'warning', NORMAL: 'neutral' }

export type OrderPartButton = 'CHANGE' | null

export interface OrderPartModel {
  /** Every line has the same structure from the same source: one sentence, no line list. */
  readonly one: boolean
  readonly answer: Words
  readonly lines: OrderStructure['lines']
  readonly printed: boolean
  readonly button: OrderPartButton
  /** "Back to the rules" (an order chosen by hand, before the print, with the right). */
  readonly back: boolean
}

/** The words of one line's source: by rule n · chosen by hand for this order (why) · no rule fits. */
export function fromWordsOf(line: Pick<OrderStructure['lines'][number], 'from' | 'why'>, ruleNo: number): Words {
  if (line.from === 'RULE') return ruleNo > 0 ? words('from.ruleN', { n: ruleNo }) : words('from.rule')
  if (line.from === 'ORDER') return line.why ? words('from.orderWhy', { why: line.why }) : words('from.order')
  return words('from.normal')
}

export function orderPartOf(read: OrderStructure): OrderPartModel {
  const kinds = new Set(read.lines.map((line) => `${line.structure?.id ?? ''}|${line.from}`))
  const one = read.lines.length > 0 && kinds.size === 1
  const first = read.lines[0]
  const may = read.may.change && !read.printed
  const answer = read.lines.length === 0 ? words('order.noLines') : one && first ? (first.structure ? words(read.printed ? 'order.oneKept' : 'order.one', { name: first.structure.name }) : words(read.printed ? 'order.normalKept' : 'order.normal')) : words(read.printed ? 'order.manyKept' : 'order.many', { count: new Set(read.lines.map((line) => line.structure?.id ?? '')).size })
  return { one, answer, lines: read.lines, printed: read.printed, button: may ? 'CHANGE' : null, back: may && read.byHand !== null }
}

/** The order window's draft: a structure, the normal way (null), or nothing chosen yet (undefined); the why is needed. */
export interface OrderDraft {
  readonly structureId: string | null | undefined
  readonly why: string
}

export const ORDER_WHY_MAX = 140

export function orderDraftOf(read: OrderStructure): OrderDraft {
  return read.byHand ? { structureId: read.byHand.structureId, why: read.byHand.why } : { structureId: undefined, why: '' }
}

export function orderHeldOf(draft: OrderDraft, structures: readonly StructureRow[]): Words | null {
  if (draft.structureId === undefined) return words('order.held.pick')
  if (draft.structureId !== null && !structures.some((row) => row.id === draft.structureId && !row.closed)) return words('rule.held.closed')
  const why = draft.why.trim()
  if (!why) return words('order.held.why')
  return why.length > ORDER_WHY_MAX ? words('held.long', { count: ORDER_WHY_MAX }) : null
}

/** A failed call as a key of the catalogue. */
export function problemKeyOf(error: unknown, write: boolean): string {
  const kind = typeof error === 'object' && error !== null && 'kind' in error ? String((error as { kind: unknown }).kind) : ''
  if (kind === 'forbidden' || kind === 'step_up') return 'error.forbidden'
  if (kind === 'unavailable') return 'error.offline'
  if (kind === 'not_found') return 'error.notFound'
  if (write && kind === 'conflict') return 'error.conflict'
  if (write && kind === 'invalid') return 'error.invalid'
  return write ? 'error.write' : 'error.read'
}
