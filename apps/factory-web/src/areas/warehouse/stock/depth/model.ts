import { LOCATION_KIND_PROFILES } from '@nexus/factory-domain/inventory/locations-depth/kinds'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { GridRow, StockLine } from '../model'
import type { StockKey, Uom } from '../../../_shared/stock/api'
import { decimalValue, type Phrase } from '../../../_shared/stock/model'
import type { PlaceView } from '../../locations/depth/api'
import type { LowRow, MoveInput, PostingCheck, WaitingAdjustment, WarehouseRules, Why } from './api'

/**
 * Stock and moves in depth (B-W2b-327; design warehouse.stock st-why, st-grid "In transit" / "Move…", st-metrics "Below
 * minimum", st-adjust "Needs approval above € 500"; warehouse.moves mv-why, mv-approval, mv-grid posting date), pure: the
 * stock key a quantity explains, what lies in transit, the below-minimum tile, a move of some rows to another place (one
 * move per stock key, a hide whole), the approval an adjustment may wait for, a posting date's check, and the words of a
 * waiting adjustment. The words are keys of `warehouse-depth` (`wd.`); the shared stock words are `stock`'s.
 */

export const DEPTH_NAMESPACE = 'warehouse-depth'

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

// ---- why is it this number --------------------------------------------------------------------------------------------------

/** The stock key one row's quantity is (the site, the material and its colour, lot and hide, at the row's place). */
export function whyKeyOf(line: Pick<StockLine, 'siteId' | 'item' | 'colour' | 'lot' | 'hide' | 'location'>): StockKey {
  return { siteId: line.siteId, itemId: line.item.id, itemColourId: line.colour?.id ?? null, lotId: line.lot?.id ?? null, hideId: line.hide?.id ?? null, locationId: line.location.id }
}

/** The figure's own Movements query (a step's or all moves): the ledger link's query as the Movements page's address. */
export function movesAddressOfLink(prefix: string, link: Why['allMoves'], extra: Record<string, string> = {}): string {
  const names: Record<string, string> = { siteId: 'site', itemId: 'item', itemColourId: 'colour', lotId: 'lot', hideId: 'hide', locationId: 'location', reasons: 'reasons' }
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(link.query)) if (names[name] && value) query.set(names[name], value)
  // A key with a period: the Movements page reads the whole ledger of a key by itself.
  for (const [name, value] of Object.entries(extra)) query.set(name, value)
  const text = query.toString()
  return `${prefix}/warehouse/moves${text ? `?${text}` : ''}`
}

/** The bridge's steps as the Waterfall draws them: the start, one step per reason (its net), the end read apart. */
export interface BridgeStep {
  id: string
  kind: 'start' | 'step' | 'total'
  reason: Why['steps'][number]['reason'] | null
  amount: number
  moves: number
}
export function bridgeSteps(why: Pick<Why, 'start' | 'steps' | 'end'>): BridgeStep[] {
  return [
    { id: 'start', kind: 'start', reason: null, amount: decimalValue(why.start) ?? 0, moves: 0 },
    ...why.steps.map((step) => ({ id: step.reason, kind: 'step' as const, reason: step.reason, amount: decimalValue(step.net) ?? 0, moves: step.moves })),
    { id: 'end', kind: 'total', reason: null, amount: decimalValue(why.end) ?? 0, moves: 0 },
  ]
}

/** The first day of a Movements period (Rome, YYYY-MM-DD) for the bridge; null: the whole ledger. */
export function periodFromDay(days: number | null, now: Date, timeZone: string): string | null {
  if (days === null) return null
  const start = new Date(now.getTime() - days * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(start)
}

// ---- in transit ---------------------------------------------------------------------------------------------------------------

/** The places of the site by id (kind, block), for the rows. */
export const placesById = (places: readonly PlaceView[] | undefined): ReadonlyMap<string, PlaceView> => new Map((places ?? []).map((place) => [place.id, place]))

/** A row lying on a transit place is in transit (a transfer's goods between sites: the sending site's stock until received). */
export const isInTransit = (line: Pick<StockLine, 'location'>, places: ReadonlyMap<string, PlaceView>): boolean => places.get(line.location.id)?.kind === 'TRANSIT'

/** The Transfers list of the goods in transit from a site (B-W2b-326's tile). */
export const transitHref = (prefix: string, siteId: string) => `${prefix}/warehouse/transfers?${new URLSearchParams({ from: siteId, tile: 'IN_TRANSIT' }).toString()}`

// ---- below minimum ---------------------------------------------------------------------------------------------------------------

/** The tile's count over the sites read (unknown when one site's read failed or none was read: "—", never 0). */
export function lowCount(perSite: readonly (number | null)[]): number | null {
  if (perSite.length === 0 || perSite.some((count) => count === null)) return null
  return perSite.reduce<number>((sum, count) => sum + (count ?? 0), 0)
}

/** A below-minimum row's id (site, material, colour). */
export const lowRowId = (row: Pick<LowRow, 'site' | 'item' | 'colour'>) => `${row.site.id}|${row.item.id}|${row.colour?.id ?? '-'}`

/** The rows a search keeps (material code or name, colour). */
export function searchLow(rows: readonly LowRow[], q: string): LowRow[] {
  const words = q.trim().toLowerCase()
  if (!words) return [...rows]
  return rows.filter((row) => [row.item.code, row.item.name, row.colour?.code, row.colour?.name].some((text) => !!text && text.toLowerCase().includes(words)))
}

// ---- move some rows to another place -------------------------------------------------------------------------------------

export interface MoveDraft {
  toLocationId: string
  /** One row of material that is not leather: the quantity as typed (default all of it); else every row moves whole. */
  quantity: string
  note: string
}

export interface PlannedMove {
  /** The row it comes from (one per hide for leather). */
  key: string
  label: string
  input: Omit<MoveInput, 'toLocationId' | 'note'>
  uom: Uom
}

export interface MoveDialogModel {
  /** The rows picked (each a stock key at a place). */
  lines: StockLine[]
  /** What moves: one move per stock key and hide (a hide whole). */
  planned: PlannedMove[]
  draft: MoveDraft
  /** The site's places a move may go to (active, not in transit, not outside). */
  targets: PlaceView[]
  posting: boolean
  problem: Phrase | null
  /** After the post: how many moved, and the ones refused (their words). */
  done?: { moved: number; refused: { label: string; problem: Phrase }[] } | null
}

export interface MoveActions {
  onChange?: (draft: MoveDraft) => void
  onPost?: () => void
  onClose?: () => void
}

/** The places a move may go to: active places of the site that are not outside the site or in transit. */
export function moveTargets(places: readonly PlaceView[], siteId: string): PlaceView[] {
  return places.filter((place) => place.siteId === siteId && place.status === 'ACTIVE' && LOCATION_KIND_PROFILES[place.kind].group !== 'OUTSIDE' && LOCATION_KIND_PROFILES[place.kind].group !== 'TRANSIT')
}

/** The moves of some rows: a leather row folded over several hides moves each hide whole; another row moves its stock key. */
export function movePlan(lines: readonly StockLine[], rows: readonly GridRow[]): PlannedMove[] {
  const planned: PlannedMove[] = []
  for (const line of lines) {
    const base = { siteId: line.siteId, itemId: line.item.id, itemColourId: line.colour?.id ?? null, lotId: line.lot?.id ?? null, fromLocationId: line.location.id }
    if (line.item.tracking === 'HIDE') {
      const hides = line.hide
        ? [{ id: line.hide.id, code: line.hide.code, onHand: line.onHand }]
        : rows.filter((row) => row.siteId === line.siteId && row.location.id === line.location.id && row.item.id === line.item.id && (row.colour?.id ?? null) === (line.colour?.id ?? null) && (row.lot?.id ?? null) === (line.lot?.id ?? null) && row.hide).map((row) => ({ id: row.hide!.id, code: row.hide!.code, onHand: row.onHand }))
      for (const hide of hides) planned.push({ key: `${line.id}|${hide.id}`, label: hide.code, input: { ...base, hideId: hide.id, quantity: hide.onHand }, uom: line.item.baseUom })
      continue
    }
    planned.push({ key: line.id, label: [line.item.code, line.lot?.code].filter(Boolean).join(' · '), input: { ...base, quantity: line.onHand }, uom: line.item.baseUom })
  }
  return planned
}

/** A typed decimal ("1,5") → "1.5"; null when not one. */
export function typedQuantity(text: string): string | null {
  const plain = text.trim().replace(/\s/g, '')
  if (!plain) return null
  const normal = plain.includes(',') && plain.includes('.') ? plain.replace(/\./g, '').replace(',', '.') : plain.replace(',', '.')
  return /^\d{1,12}(\.\d{1,4})?$/.test(normal) ? normal : null
}

/** One row of a material that is not leather moves part of it; everything else moves whole. */
export const movesPart = (model: Pick<MoveDialogModel, 'lines' | 'planned'>): boolean => model.lines.length === 1 && model.planned.length === 1 && model.lines[0]!.item.tracking !== 'HIDE'

/** Why "Move" is held (a key of warehouse-depth), or null. */
export function moveHeldKey(model: Pick<MoveDialogModel, 'lines' | 'planned' | 'draft' | 'targets' | 'posting'>, places: ReadonlyMap<string, PlaceView>): { key: string; params?: Record<string, string | number> } | null {
  if (model.posting) return { key: 'wd.move.posting' }
  if (model.planned.length === 0) return { key: 'wd.move.held.nothing' }
  if (new Set(model.lines.map((line) => line.siteId)).size > 1) return { key: 'wd.move.held.sites' }
  const blockedFrom = model.lines.find((line) => places.get(line.location.id)?.block?.holds)
  if (blockedFrom) return { key: 'wd.move.held.fromBlocked', params: { code: blockedFrom.location.code } }
  const transit = model.lines.find((line) => places.get(line.location.id)?.kind === 'TRANSIT')
  if (transit) return { key: 'wd.move.held.transit', params: { code: transit.location.code } }
  if (!model.draft.toLocationId) return { key: 'wd.move.held.pick' }
  const target = places.get(model.draft.toLocationId)
  if (target?.block?.holds) return { key: 'wd.move.held.toBlocked', params: { code: target.code } }
  if (model.lines.every((line) => line.location.id === model.draft.toLocationId)) return { key: 'wd.move.held.same' }
  if (movesPart(model)) {
    const quantity = typedQuantity(model.draft.quantity)
    if (quantity === null || Number(quantity) <= 0) return { key: 'wd.move.held.quantity' }
    if (Number(quantity) > (decimalValue(model.lines[0]!.onHand) ?? 0)) return { key: 'wd.move.held.tooMuch' }
  }
  if (model.draft.note.length > 500) return { key: 'wd.move.held.note' }
  return null
}

/** The requests of a move (rows already at the target place are left out). */
export function moveInputs(model: Pick<MoveDialogModel, 'lines' | 'planned' | 'draft'>): { key: string; label: string; input: MoveInput }[] {
  const note = model.draft.note.trim() || null
  const part = movesPart(model) ? typedQuantity(model.draft.quantity) : null
  return model.planned
    .filter((entry) => entry.input.fromLocationId !== model.draft.toLocationId)
    .map((entry) => ({ key: entry.key, label: entry.label, input: { ...entry.input, quantity: part ?? entry.input.quantity, toLocationId: model.draft.toLocationId, note } }))
}

/** A refused move in our words: a blocked place (409 LOCATION_BLOCKED), the place does not hold that kind (400), the stock went. */
export function moveProblemOf(error: unknown): Phrase {
  if (!isApiError(error)) return { key: 'wd.move.problem.write' }
  const paths = error.issues.map(issuePath)
  if (paths.some((path) => path.endsWith('LOCATION_BLOCKED'))) return { key: 'wd.move.problem.blocked' }
  if (error.kind === 'invalid' && paths.some((path) => path.endsWith('toLocationId'))) return { key: 'wd.move.problem.kind' }
  if (error.kind === 'conflict' && error.issues.length > 0) return { key: 'wd.move.problem.notEnough' }
  if (error.kind === 'conflict') return { key: 'wd.move.problem.changed' }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'wd.move.problem.forbidden' }
  if (error.kind === 'unavailable') return { key: 'wd.move.problem.offline' }
  if (error.kind === 'invalid') return { key: 'wd.move.problem.invalid' }
  return { key: 'wd.move.problem.write' }
}

/** Why Move… cannot start on these rows (a key of warehouse-depth), or null. */
export function moveStartHeldKey(lines: readonly StockLine[], can: { transfer: boolean }, pastDate: boolean): string | null {
  if (pastDate) return 'wd.move.held.pastDate'
  if (!can.transfer) return 'wd.move.held.noRight'
  if (lines.length === 0) return 'wd.move.held.pickRows'
  if (new Set(lines.map((line) => line.siteId)).size > 1) return 'wd.move.held.sites'
  return null
}

// ---- the approval an adjustment may wait for --------------------------------------------------------------------------------

export interface ApprovalNotice {
  /** The value above which an adjustment waits (minor units, the company's currency); null: held from a reader without the cost grain. */
  amount: number | null
  currency: string | null
  /** Who says yes (the active rules' approvers): names. */
  approvers: readonly string[]
}

/** The "Needs approval above € 500" banner: a value set and an approval rule on; else null (adjustments post at once). */
export function approvalNoticeOf(rules: WarehouseRules | null, approvers: readonly { name: string }[] | null): ApprovalNotice | null {
  if (!rules) return null
  const approval = rules.adjustmentApproval
  if (!approval.inForce.set || approval.approvalRules.active === 0) return null
  const amount = typeof approval.inForce.amount === 'number' ? approval.inForce.amount : null
  return { amount: approval.held ? null : amount, currency: approval.currency, approvers: (approvers ?? []).map((entry) => entry.name) }
}

// ---- a posting date ----------------------------------------------------------------------------------------------------------------

export interface PostingState {
  /** The day typed (YYYY-MM-DD); '' = today (the day it happens). */
  day: string
  check: Loaded<PostingCheck> | null
  /** Why it goes into a soft-locked month (asked only then). */
  lockReason: string
}
export const blankPosting = (): PostingState => ({ day: '', check: null, lockReason: '' })

/** Why the post is held by its posting date (a key of warehouse-depth with its values), or null. */
export function postingHeldOf(posting: PostingState | null | undefined): { key: string; params?: Record<string, string> } | null {
  if (!posting || !posting.day) return null
  const check = posting.check
  if (!check || check.status === 'loading') return { key: 'wd.posting.checking' }
  if (check.status === 'error') return { key: 'wd.posting.checkFailed' }
  const value = check.value
  if (value.periodLock?.level === 'HARD') return { key: 'wd.posting.closed' }
  if (!value.allowed) return value.earliest ? { key: 'wd.posting.tooFar', params: { earliest: value.earliest } } : { key: 'wd.posting.notAllowed' }
  if (value.periodLock?.needsReason && posting.lockReason.trim().length < 3) return { key: 'wd.posting.lockReason' }
  return null
}

// ---- a waiting adjustment ---------------------------------------------------------------------------------------------------------

/** What the waiting words need: who approves (a role or a person), since when, the stock from → to. */
export function waitingFacts(waiting: WaitingAdjustment): { approver: string | null; since: string; from: string; to: string; uom: Uom } {
  return { approver: waiting.approver.name, since: waiting.requestedAt, from: waiting.onHand.from, to: waiting.onHand.to, uom: waiting.item.baseUom }
}

/** The approval request's page (Home › Approvals, its review open). */
export const requestHref = (prefix: string, taskId: string) => `${prefix}${recordAddress({ type: 'ApprovalTask', id: taskId }, OFFICE_PAGES)}`
