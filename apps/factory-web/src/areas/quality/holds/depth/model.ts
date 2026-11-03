import { TRACE_NODE_KINDS } from '@nexus/factory-domain/inventory/trace/rules'
import {
  genealogyPlan,
  HOLD_NEXT_STEPS,
  laneFacts,
  placeOfCode,
  type GenealogyStartType,
  type GroupCounts,
  type HoldNextStep,
  type ImpactEdge,
  type ImpactNode,
} from '@nexus/factory-domain/quality/holds/depth'
import { HOLD_LIMITS, STOCK_SUBJECTS, type HoldSubjectType } from '@nexus/factory-domain/quality/holds/rules'
import type { ListMode } from '../../../../list-frame/w2b/model'
import type { QualityCan, Read } from '../../_shared/model'
import type { Hold, HoldDetail, Person } from '../api'
import type { Affected, Genealogy, GenealogyBody, Impact, ImpactNodeView } from './api'

/**
 * Holds in depth without React and without the API (B-W2b-114; QHS-075, QHS-077, QHS-078): the impact tree (one tree of
 * the forward traces, each node once under the first node that reaches it, many of a kind counted in a group), what a
 * node is to a hold by genealogy in our words (held with the reason), the plan's summary sentence, the genealogy dialog's
 * draft and problems, the board's lanes (next step; a drop on Released opens the release), the quarantine move's ask and
 * confirm drafts. Message keys are the `holds` catalogue's.
 */

type Translate = (key: string, params?: Record<string, string | number>) => string
type Params = { get(name: string): string | null } | null | undefined

// ---- the impact tree ---------------------------------------------------------------------------------------------------------

/** More children of one kind than this under one node are counted first in a group the reader opens. */
export const GROUP_LIMIT = 12
const KIND_ORDER = new Map<string, number>(TRACE_NODE_KINDS.map((kind, index) => [kind, index]))

export type TreeItem =
  | { readonly type: 'node'; readonly id: string; readonly node: ImpactNodeView; readonly quantity: { amount: string; uom: string | null } | null; readonly children: readonly TreeItem[] }
  | { readonly type: 'group'; readonly id: string; readonly kind: ImpactNodeView['kind']; readonly exact: number; readonly possible: number; readonly children: readonly TreeItem[] }

const byKindThenCode = (a: ImpactNodeView, b: ImpactNodeView) => (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99) || (a.code ?? '').localeCompare(b.code ?? '') || a.id.localeCompare(b.id)

/**
 * The forward trees of the starts as ONE forest: breadth first from every start, each node once, under the first node that
 * reaches it. A node's tree id is its trace key (each node is drawn once), so the ticks ARE the keys a hold by genealogy
 * sends; a group's id is not a key (the API never sees it).
 */
export function impactTree(impact: Pick<Impact, 'starts' | 'nodes' | 'edges'>): TreeItem[] {
  const nodes = new Map(impact.nodes.map((node) => [node.key, node]))
  const next = new Map<string, { key: string; quantity: string | null; uom: string | null }[]>()
  for (const edge of impact.edges) next.set(edge.from, [...(next.get(edge.from) ?? []), { key: edge.to, quantity: edge.quantity, uom: edge.uom }])
  const starts = impact.starts.map((start) => start.key).filter((key) => nodes.has(key))
  const placed = new Set<string>(starts)
  const childrenOf = new Map<string, { node: ImpactNodeView; quantity: string | null; uom: string | null }[]>()
  let frontier = [...starts]
  while (frontier.length > 0) {
    const reached: string[] = []
    for (const key of frontier) {
      const found: { node: ImpactNodeView; quantity: string | null; uom: string | null }[] = []
      for (const step of next.get(key) ?? []) {
        const node = nodes.get(step.key)
        if (!node || placed.has(step.key)) continue
        placed.add(step.key)
        found.push({ node, quantity: step.quantity, uom: step.uom })
        reached.push(step.key)
      }
      found.sort((a, b) => byKindThenCode(a.node, b.node))
      childrenOf.set(key, found)
    }
    frontier = reached
  }
  const build = (key: string): TreeItem[] => {
    const found = childrenOf.get(key) ?? []
    const items: TreeItem[] = []
    for (const kind of [...new Set(found.map((entry) => entry.node.kind))]) {
      const ofKind = found.filter((entry) => entry.node.kind === kind)
      const drawn: TreeItem[] = ofKind.map((entry) => ({ type: 'node', id: entry.node.key, node: entry.node, quantity: entry.quantity ? { amount: entry.quantity, uom: entry.uom } : null, children: build(entry.node.key) }))
      if (ofKind.length > GROUP_LIMIT)
        items.push({ type: 'group', id: `${key}>group:${kind}`, kind, exact: ofKind.filter((entry) => entry.node.reach === 'EXACT').length, possible: ofKind.filter((entry) => entry.node.reach === 'POSSIBLE').length, children: drawn })
      else items.push(...drawn)
    }
    return items
  }
  return starts.map((key) => ({ type: 'node', id: key, node: nodes.get(key)!, quantity: null, children: build(key) }))
}

/** "Show only affected customers": the branches that reach a customer who received the goods. */
export function onlyAffected(items: readonly TreeItem[]): TreeItem[] {
  const keep = (item: TreeItem): TreeItem | null => {
    if (item.type === 'node' && item.node.kind === 'CUSTOMER' && item.node.received === true) return item
    const children = item.children.map(keep).filter((child): child is TreeItem => child !== null)
    return children.length > 0 ? ({ ...item, children } as TreeItem) : null
  }
  return items.map(keep).filter((item): item is TreeItem => item !== null)
}

/** Why a node cannot be ticked in a hold by genealogy (a `holds` key with params), or null. Sizes and customers are branches. */
export function nodeHeld(node: ImpactNodeView, mayPlaceAt: (siteId: string) => boolean, sites: ReadonlyMap<string, string>): { key: string; params?: Record<string, string> } | null {
  switch (node.hold) {
    case 'HELD':
      return { key: 'genealogy.held.HELD' }
    case 'LEFT':
      return { key: 'genealogy.held.LEFT' }
    case 'NOT_HOLDABLE':
      return { key: 'genealogy.held.NOT_HOLDABLE' }
    case 'HIDDEN':
      return { key: 'genealogy.held.HIDDEN' }
    case 'NONE':
      return null
    case 'HOLDABLE':
      return node.siteId && !mayPlaceAt(node.siteId) ? { key: 'genealogy.held.site', params: { site: sites.get(node.siteId) ?? '—' } } : null
  }
}

/** Every id a tick on the whole tree reaches (the dialog's first ticks: everything that may be held, a recall's safe side). */
export function tickableIds(items: readonly TreeItem[], held: (item: TreeItem) => boolean): string[] {
  const out: string[] = []
  const walk = (list: readonly TreeItem[]) => {
    for (const item of list) {
      if (held(item)) continue
      out.push(item.id)
      walk(item.children)
    }
  }
  walk(items)
  return out
}

/** The ticks a tree starts with: every branch that may be held (a recall's safe side; the person unticks the rest). */
export function firstTicks(read: Pick<Genealogy, 'sites' | 'starts' | 'nodes' | 'edges'>): string[] {
  const sites = new Map(read.sites.map((site) => [site.id, site.code]))
  const allowed = new Map(read.sites.map((site) => [site.id, site.mayPlace]))
  const held = (item: TreeItem) => item.type === 'node' && nodeHeld(item.node, (siteId) => allowed.get(siteId) ?? false, sites) !== null
  return tickableIds(impactTree(read), held)
}

/** A node's record type for its link (sizes, bundles and garments open their work order). */
export function nodeRecord(node: ImpactNodeView): { type: string; id: string; tab?: string } | null {
  if (node.hidden || node.code === null) return null
  switch (node.kind) {
    case 'LOT':
      return { type: 'Lot', id: node.id }
    case 'HIDE':
      return { type: 'Hide', id: node.id }
    case 'WORK_ORDER':
      return { type: 'WorkOrder', id: node.id }
    case 'CELL':
    case 'SERIAL':
      return node.workOrderId ? { type: 'WorkOrder', id: node.workOrderId } : null
    case 'BUNDLE':
      return node.workOrderId ? { type: 'WorkOrder', id: node.workOrderId, tab: 'bundles' } : null
    case 'SHIPMENT':
      return { type: 'Shipment', id: node.id }
    case 'SUBCONTRACT':
      return { type: 'SubcontractOrder', id: node.id }
    default:
      return null
  }
}

/** Where a recall of what has left is followed: Compliance › PPE register & recalls (the recalls). */
export const registerHref = (prefix: string): string => `${prefix}/compliance/register?kind=RECALL`

// ---- the plan's words -------------------------------------------------------------------------------------------------------

const HELD_KINDS = ['Lot', 'Hide', 'WorkOrder', 'Bundle', 'Shipment'] as const

/** "Hold 4 work orders and 126 garments; 18 garments already shipped to 2 customers." in the reader's words. */
export function summaryWords(counts: GroupCounts, t: Translate): { head: string; shipped: string | null; nothing: boolean } {
  const parts = HELD_KINDS.filter((type) => counts[type] > 0).map((type) => t(`genealogy.part.${type}`, { count: counts[type] }))
  if (counts.garments > 0) parts.push(t('genealogy.part.garments', { count: counts.garments }))
  const list = parts.length > 1 ? t('genealogy.and', { first: parts.slice(0, -1).join(', '), last: parts[parts.length - 1]! }) : (parts[0] ?? '')
  return {
    head: parts.length > 0 ? t('genealogy.hold', { what: list }) : t('genealogy.holdNothing'),
    shipped: counts.shippedGarments > 0 ? t('genealogy.shipped', { count: counts.shippedGarments, customers: t('genealogy.customers', { count: counts.customers }) }) : null,
    nothing: parts.length === 0,
  }
}

/** The plan of the ticks (the domain's: one hold per kind and site; covered, already held, refused). */
export function planOf(read: Pick<Impact, 'nodes' | 'edges'>, selected: readonly string[]) {
  const keys = new Set(read.nodes.map((node) => node.key))
  return genealogyPlan(read.nodes as unknown as readonly ImpactNode[], read.edges as readonly ImpactEdge[], selected.filter((id) => keys.has(id)))
}

// ---- the genealogy dialog ---------------------------------------------------------------------------------------------------

export interface GenealogyDraft {
  /** The suspect lot's or hide's code typed or scanned (when no start was named). */
  readonly code: string
  readonly reasonCode: string | null
  readonly reasonNote: string
  readonly ownerId: string | null
  readonly expectedReleaseOn: string
  readonly askQuarantine: boolean
  readonly note: string
}

export const GENEALOGY_DRAFT: GenealogyDraft = Object.freeze({ code: '', reasonCode: null, reasonNote: '', ownerId: null, expectedReleaseOn: '', askQuarantine: true, note: '' })

export interface GenealogyStart {
  readonly type: GenealogyStartType
  readonly id: string
  readonly code?: string | null
}

/** The address that opens the dialog: `?genealogy=1&type=Lot&id=<uuid>[&hold=<uuid>]` (another list's verb, the lot's ⋯). */
export function genealogyFromAddress(params: Params): { start: GenealogyStart | null; holdId: string | null } | null {
  if (params?.get('genealogy') !== '1') return null
  const type = params.get('type')
  const id = params.get('id') ?? ''
  const hold = params.get('hold') ?? ''
  const uuid = /^[0-9a-f-]{36}$/i
  return { start: (type === 'Lot' || type === 'Hide') && uuid.test(id) ? { type, id } : null, holdId: uuid.test(hold) ? hold : null }
}

/** Where "Extend by genealogy" starts for a hold of the list: its group's suspect record, else its first lot or hide. */
export function extendStartOf(hold: Pick<Hold, 'group' | 'subjectType' | 'subjects' | 'status'>, can: Pick<QualityCan, 'holdsPlace'>): { start: GenealogyStart | null; held: string | null } {
  if (!can.holdsPlace) return { start: null, held: 'held.noPlace' }
  if (hold.status !== 'ACTIVE') return { start: null, held: 'held.notActive' }
  if (hold.group && (hold.group.sourceType === 'Lot' || hold.group.sourceType === 'Hide')) return { start: { type: hold.group.sourceType, id: hold.group.sourceId, code: hold.group.sourceCode }, held: null }
  const first = hold.subjects[0]
  if ((hold.subjectType === 'Lot' || hold.subjectType === 'Hide') && first) return { start: { type: hold.subjectType, id: first.id, code: first.label }, held: null }
  return { start: null, held: 'genealogy.extendKind' }
}

/** The dialog's problems (holds keys), every one at once; the API checks again. */
export function genealogyProblems(draft: GenealogyDraft, read: Genealogy | null, picks: readonly string[], reasons: readonly { code: string; needsDetail: boolean }[], today: string): string[] {
  const problems: string[] = []
  if (!read) problems.push('genealogy.problem.start')
  else {
    const plan = planOf(read, picks)
    if (plan.holds.length === 0) problems.push('genealogy.problem.nothing')
  }
  const reason = reasons.find((entry) => entry.code === draft.reasonCode)
  if (!draft.reasonCode || !reason) problems.push('genealogy.problem.reason')
  else if (reason.needsDetail && !draft.reasonNote.trim()) problems.push('genealogy.problem.reasonNote')
  if (draft.reasonNote.length > HOLD_LIMITS.reasonNote) problems.push('genealogy.problem.reasonNoteLong')
  if (draft.note.length > HOLD_LIMITS.note) problems.push('genealogy.problem.noteLong')
  if (draft.expectedReleaseOn && draft.expectedReleaseOn < today) problems.push('genealogy.problem.date')
  return problems
}

export function genealogyBody(read: Genealogy, picks: readonly string[], draft: GenealogyDraft, holdId: string | null): GenealogyBody {
  const keys = new Set(read.nodes.map((node) => node.key))
  return {
    type: read.start.type,
    id: read.start.id,
    picks: picks.filter((id) => keys.has(id)),
    reasonCode: draft.reasonCode ?? '',
    reasonNote: draft.reasonNote.trim() || null,
    ownerId: draft.ownerId,
    expectedReleaseOn: draft.expectedReleaseOn || null,
    askQuarantine: draft.askQuarantine,
    note: draft.note.trim() || null,
    holdId,
  }
}

/** The sites of the ticked stock without exactly one quarantine place (the move is not asked there: said before the click). */
export function quarantineGaps(read: Genealogy, picks: readonly string[]): { code: string; places: number }[] {
  const plan = planOf(read, picks)
  const stockSites = new Set(plan.holds.filter((hold) => STOCK_SUBJECTS.includes(hold.subjectType as HoldSubjectType)).map((hold) => hold.siteId))
  return read.sites.filter((site) => stockSites.has(site.id) && site.quarantinePlaces.length !== 1).map((site) => ({ code: site.code, places: site.quarantinePlaces.length }))
}

export interface GenealogyModel {
  readonly open: boolean
  /** The suspect record named (null: the person types or scans its code). */
  readonly start: GenealogyStart | null
  /** Extending this hold (its group). */
  readonly holdId: string | null
  readonly read: Read<Genealogy> | null
  readonly selected: readonly string[]
  readonly affectedOnly: boolean
  readonly draft: GenealogyDraft
  readonly reasons: Read<readonly { code: string; labelIt: string; labelEn: string; needsDetail: boolean }[]>
  readonly people: Read<readonly Person[]> | null
  readonly today: string
  /** Finding the typed code: idle, finding, or the code named nothing (a `holds` key). */
  readonly find: { readonly state: 'idle' | 'finding' | 'none' | 'error'; readonly problem?: string | null }
  readonly busy: boolean
  readonly problem: string | null
  readonly lines?: readonly string[]
  /** Why holding by genealogy is held for this person at all (no right): a `holds` key. */
  readonly held: string | null
}

// ---- the hold board (QHS-077) ----------------------------------------------------------------------------------------------

export const BOARD_RELEASED = 'RELEASED'
export const BOARD_LANES = [...HOLD_NEXT_STEPS, BOARD_RELEASED] as const
export type BoardLaneId = (typeof BOARD_LANES)[number]

/** The lane a hold stands in: its next step while ACTIVE; Released (and closed in an NCR) otherwise. */
export const laneOfHold = (hold: Pick<Hold, 'status' | 'nextStep'>): BoardLaneId => (hold.status === 'ACTIVE' ? hold.nextStep : BOARD_RELEASED)

/** The lanes with their counts and the oldest age in our words; a lane the person may not drop on says why. */
export function boardLanes(rows: readonly Pick<Hold, 'status' | 'nextStep' | 'ageDays'>[], can: Pick<QualityCan, 'holdsPlace' | 'holdsRelease'>, t: Translate) {
  const facts = laneFacts(rows)
  // A board the person only reads says it once (boardHeld), not on every lane.
  const readOnly = !can.holdsPlace && !can.holdsRelease
  return [
    ...facts.map((lane) => ({
      id: lane.step,
      label: t(`board.lane.${lane.step}`),
      detail: lane.oldestDays === null ? t('board.empty') : t('board.oldest', { count: lane.oldestDays }),
      total: lane.count,
      held: can.holdsPlace || readOnly ? null : t('held.noPlace'),
      tone: lane.step === 'READY_TO_RELEASE' ? ('success' as const) : lane.step === 'WAITING_DECISION' ? ('warning' as const) : ('neutral' as const),
    })),
    { id: BOARD_RELEASED, label: t('board.lane.RELEASED'), detail: t('board.releasedHint'), total: rows.filter((row) => row.status !== 'ACTIVE').length, held: can.holdsRelease || readOnly ? null : t('held.noRelease'), tone: 'info' as const },
  ]
}

/** Why nothing moves on this board for this person (they neither place nor release holds), or null. */
export const boardHeld = (can: Pick<QualityCan, 'holdsPlace' | 'holdsRelease'>, t: Translate): string | null => (!can.holdsPlace && !can.holdsRelease ? t('board.readOnly') : null)

/** Why a hold may not go to a lane now (a `holds` key with params), or null. Released: the release's own reasons. */
export function boardMoveHeld(hold: Pick<Hold, 'status' | 'nextStep'>, lane: string, can: Pick<QualityCan, 'holdsPlace' | 'holdsRelease'>): { key: string; params?: Record<string, string | number> } | null {
  if (hold.status !== 'ACTIVE') return { key: 'board.held.notActive' }
  if (lane === BOARD_RELEASED) return can.holdsRelease ? null : { key: 'held.noRelease' }
  if (!can.holdsPlace) return { key: 'held.noPlace' }
  if (hold.nextStep === lane) return { key: 'board.held.same' }
  return null
}

export const isNextStep = (lane: string): lane is HoldNextStep => (HOLD_NEXT_STEPS as readonly string[]).includes(lane)

// ---- the quarantine move (QHS-078) -------------------------------------------------------------------------------------------

export type QuarantineDialog = { readonly kind: 'ask'; readonly holdId: string } | { readonly kind: 'confirm'; readonly holdId: string }

/** Asking the move of one hold: held with the reason before the click (a `holds` key), or null. */
export function askHeld(hold: Pick<Hold, 'status' | 'subjectType' | 'quarantine'>, can: Pick<QualityCan, 'holdsPlace'>): string | null {
  if (!can.holdsPlace) return 'held.noPlace'
  if (hold.status !== 'ACTIVE') return 'held.notActive'
  if (!STOCK_SUBJECTS.includes(hold.subjectType)) return 'qmove.held.notStock'
  if (hold.quarantine === 'MOVED') return 'qmove.held.moved'
  return null
}

/** Confirming the move of one hold (it moves stock: inventory.transfer at the site). */
export function confirmHeld(hold: Pick<Hold, 'status' | 'subjectType' | 'quarantine'>, canTransfer: boolean): string | null {
  if (!canTransfer) return 'qmove.held.noTransfer'
  if (hold.status !== 'ACTIVE') return 'held.notActive'
  if (!STOCK_SUBJECTS.includes(hold.subjectType)) return 'qmove.held.notStock'
  if (hold.quarantine === 'NOT_NEEDED') return 'qmove.held.notAsked'
  if (hold.quarantine === 'MOVED') return 'qmove.held.moved'
  return null
}

export interface QuarantineDraft {
  readonly locationId: string | null
  readonly code: string
}

/** The confirm's problems: a code, and one of the site's quarantine places (read from the hold's record). */
export function confirmProblems(draft: QuarantineDraft, detail: Pick<HoldDetail, 'stock'> | null): string[] {
  if (!draft.code.trim()) return ['qmove.problem.code']
  if (detail?.stock && !placeOfCode(draft.code, detail.stock.places)) return ['qmove.problem.notPlace']
  return []
}

/** The ask's problems: a place of the site (when the site has places). */
export function askProblems(draft: QuarantineDraft, detail: Pick<HoldDetail, 'stock'> | null): string[] {
  if (!detail?.stock) return ['qmove.problem.reading']
  if (detail.stock.places.length === 0) return ['qmove.problem.noPlaces']
  if (!draft.locationId || !detail.stock.places.some((place) => place.id === draft.locationId)) return ['qmove.problem.place']
  return []
}

export interface QuarantineModel {
  readonly dialog: QuarantineDialog | null
  readonly hold: Hold | null
  readonly detail: Read<HoldDetail> | null
  readonly draft: QuarantineDraft
  readonly canTransfer: boolean
  readonly busy: boolean
  readonly problem: string | null
  readonly lines?: readonly string[]
}

/** What the Holds page adds for holds in depth (the board mode, the genealogy dialog, the Affected tab, the moves). */
export interface HoldsDepthModel {
  readonly mode: ListMode
  readonly canTransfer: boolean
  readonly genealogy: GenealogyModel | null
  readonly affected: Read<Affected> | null
  readonly quarantine: QuarantineModel | null
  /** The board's moves in flight / refused (by hold id). */
  readonly moving?: Readonly<Record<string, 'moving' | 'refused'>>
}
