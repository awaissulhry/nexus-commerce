import { daysFrom, plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { MAX_SIZES, PROTECTABLE_FIELDS, type PeggedDemand, type PlannedOrderKind, type SizeQuantity } from '../planned-orders/rules'

/**
 * A planner's edits kept across runs (B-W2b-306; PLN-076 "protect planner edits across reruns", PLN-078 "bulk edit planned
 * orders"; design planning.mrp: "an edited cell keeps a dot and 'Reset to plan'"), pure.
 *
 *   edit        a planner changes fields of a PLANNED planned work order (its size run, start and due, line, workshop and
 *               steps, kit date, revision): each field that changes joins PlannedWorkOrder.protectedFields (with who and
 *               when). Nothing is planned before today (PLN-083): a date before today is refused.
 *   the run     a protected row follows its demand (`claimProposals`: the proposal that pegs most of its pieces) and the run
 *               rewrites only the fields NOT protected (`mergeWithPlan`), keeping start ≤ due and the kit by the due date
 *               by moving a field that is not protected; a firm row stays whole as before; a protected row nothing needs any
 *               more is kept as it is (never removed by a run) and the plan says so (an action message).
 *   reset       Reset to plan takes fields (or all) out of the list; their values go back to the latest plan's (the run log
 *               keeps the plan's value of every protected field), so the cell shows the plan again at once.
 *
 * No money, no person.
 */

export type ProtectableField = (typeof PROTECTABLE_FIELDS)[number]
/** Garments of one size: whole, from 1 (the database's). */
export const MAX_SIZE_QUANTITY = 9_999_999
/** A bulk edit takes at most this many planned orders (one review). */
export const MAX_BULK_EDIT = 100
/** A bulk move of dates: at most this many days either way. */
export const MAX_SHIFT_DAYS = 366

/** The fields a run writes and a planner may protect, as one value each. */
export interface PlanFields {
  readonly sizes: readonly SizeQuantity[]
  readonly startDate: BusinessDate
  readonly dueDate: BusinessDate
  readonly lineId: string | null
  readonly partyId: string | null
  readonly operationSeqs: readonly number[]
  /** An instant (ISO, UTC); null: none. */
  readonly kitDueAt: string | null
  readonly styleRevisionId: string | null
}

/** What a planner asks to change (a field left out is not changed). */
export interface PlannedChanges {
  readonly sizes?: readonly SizeQuantity[] | undefined
  readonly startDate?: BusinessDate | undefined
  readonly dueDate?: BusinessDate | undefined
  readonly lineId?: string | null | undefined
  readonly partyId?: string | null | undefined
  readonly operationSeqs?: readonly number[] | undefined
  readonly kitDueAt?: string | null | undefined
  readonly styleRevisionId?: string | null | undefined
}

export const quantityOfSizes = (sizes: readonly SizeQuantity[]): number => sizes.reduce((sum, row) => sum + row.quantity, 0)
export const sameSizes = (a: readonly SizeQuantity[], b: readonly SizeQuantity[]): boolean => a.length === b.length && a.every((row, index) => row.size === b[index]!.size && row.quantity === b[index]!.quantity)
const sameSeqs = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((seq, index) => seq === b[index])
const dayOfInstant = (instant: string | null): BusinessDate | null => (instant === null ? null : instant.slice(0, 10))

/** Whether one field differs between two sets of values. */
export function differs(field: ProtectableField, a: PlanFields, b: PlanFields): boolean {
  switch (field) {
    case 'sizes':
      return !sameSizes(a.sizes, b.sizes)
    case 'operationSeqs':
      return !sameSeqs(a.operationSeqs, b.operationSeqs)
    case 'kitDueAt':
      return (a.kitDueAt === null ? null : new Date(a.kitDueAt).getTime()) !== (b.kitDueAt === null ? null : new Date(b.kitDueAt).getTime())
    default:
      return a[field] !== b[field]
  }
}

/** The fields that change from `current` to `next`, in the list's order. */
export const changedFields = (current: PlanFields, next: PlanFields): ProtectableField[] => PROTECTABLE_FIELDS.filter((field) => differs(field, current, next))

/** The protected list after an edit: what was protected and what the edit changed, each once, in the list's order. */
export const protectedAfter = (current: readonly string[], changed: readonly ProtectableField[]): ProtectableField[] => PROTECTABLE_FIELDS.filter((field) => current.includes(field) || changed.includes(field))

/** The protected list after Reset to plan of `fields` (none named: every field). */
export const protectedAfterReset = (current: readonly string[], fields?: readonly ProtectableField[]): ProtectableField[] =>
  fields && fields.length > 0 ? PROTECTABLE_FIELDS.filter((field) => current.includes(field) && !fields.includes(field)) : []

/** Values with the changes applied (nothing checked: `editProblems` says what is wrong). */
export function applyChanges(current: PlanFields, changes: PlannedChanges): PlanFields {
  const pick = <K extends keyof PlanFields>(key: K): PlanFields[K] => (changes[key] === undefined ? current[key] : (changes[key] as PlanFields[K]))
  return {
    sizes: pick('sizes'),
    startDate: pick('startDate'),
    dueDate: pick('dueDate'),
    lineId: pick('lineId'),
    partyId: pick('partyId'),
    operationSeqs: pick('operationSeqs'),
    kitDueAt: pick('kitDueAt'),
    styleRevisionId: pick('styleRevisionId'),
  }
}

/** A bulk move of the dates by whole days (start, due and the kit's time together). */
export function shiftedBy(current: PlanFields, days: number): Pick<PlannedChanges, 'startDate' | 'dueDate' | 'kitDueAt'> {
  if (days === 0) return {}
  return {
    startDate: plusDays(current.startDate, days),
    dueDate: plusDays(current.dueDate, days),
    ...(current.kitDueAt ? { kitDueAt: new Date(new Date(current.kitDueAt).getTime() + days * 86_400_000).toISOString() } : {}),
  }
}

export interface EditIssue {
  /** The field's place in the request ("sizes", "startDate", …). */
  readonly field: ProtectableField | 'changes'
  readonly message: string
}

/** What the API read for an edit: the style's sizes, the routing's steps, the lines and workshops it may name. */
export interface EditFacts {
  readonly kind: PlannedOrderKind
  readonly today: BusinessDate
  /** The style's size range. */
  readonly styleSizes: readonly string[]
  /** The routing steps of the revision the row plans (its seq numbers). */
  readonly routingSeqs: readonly number[]
  /** A line of the site, when one is named (null: not found there). */
  readonly line: { readonly id: string; readonly status: string } | null
  /** The workshop named: an ACTIVE party with the SUBCONTRACTOR role, or why not. */
  readonly workshop: { readonly id: string; readonly usable: boolean; readonly why: string | null } | null
  /** The revision named: one of the style's, and whether it may be made (RELEASED, or the one its order lines name). */
  readonly revision: { readonly id: string; readonly ofStyle: boolean; readonly usable: boolean } | null
}

/** Every problem of an edit at once, in words (empty: it may be written). */
export function editProblems(next: PlanFields, changed: readonly ProtectableField[], facts: EditFacts): EditIssue[] {
  const issues: EditIssue[] = []
  if (changed.length === 0) issues.push({ field: 'changes', message: 'Nothing changes: name at least one field with a new value.' })
  if (changed.includes('sizes')) {
    const codes = new Set<string>()
    if (next.sizes.length === 0 || next.sizes.length > MAX_SIZES) issues.push({ field: 'sizes', message: `A size run has 1 to ${MAX_SIZES} sizes.` })
    for (const row of next.sizes) {
      if (codes.has(row.size)) issues.push({ field: 'sizes', message: `Size ${row.size} is named twice.` })
      codes.add(row.size)
      if (!facts.styleSizes.includes(row.size)) issues.push({ field: 'sizes', message: `Size ${row.size} is not one of the style's sizes (${facts.styleSizes.join(', ')}).` })
      if (!Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > MAX_SIZE_QUANTITY) issues.push({ field: 'sizes', message: `Size ${row.size} makes whole garments from 1.` })
    }
  }
  // PLN-083: nothing planned before today (a date the plan keeps from before is left as it is).
  if (changed.includes('startDate') && next.startDate < facts.today) issues.push({ field: 'startDate', message: `Nothing is planned before today (${facts.today}): start it today or later.` })
  if (changed.includes('dueDate') && next.dueDate < facts.today) issues.push({ field: 'dueDate', message: `Nothing is planned before today (${facts.today}): it is due today or later.` })
  if ((changed.includes('startDate') || changed.includes('dueDate')) && next.startDate > next.dueDate) issues.push({ field: changed.includes('dueDate') ? 'dueDate' : 'startDate', message: `It starts on ${next.startDate}, after it is due (${next.dueDate}): the start comes first.` })
  if (facts.kind === 'MAKE') {
    if (changed.includes('partyId') || changed.includes('operationSeqs') || changed.includes('kitDueAt')) issues.push({ field: changed.includes('partyId') ? 'partyId' : changed.includes('operationSeqs') ? 'operationSeqs' : 'kitDueAt', message: 'It is made in-house: a workshop, its steps and a kit date belong to a planned subcontract order.' })
    if (changed.includes('lineId') && next.lineId !== null && (!facts.line || facts.line.status !== 'ACTIVE')) issues.push({ field: 'lineId', message: facts.line ? 'That line is not active.' : 'That line is not one of this site.' })
  } else {
    if (changed.includes('lineId') && next.lineId !== null) issues.push({ field: 'lineId', message: 'It goes to a workshop: a line belongs to a planned work order made in-house.' })
    if (changed.includes('partyId')) {
      if (next.partyId === null) issues.push({ field: 'partyId', message: 'A planned subcontract order goes to a workshop: name one.' })
      else if (!facts.workshop) issues.push({ field: 'partyId', message: 'That workshop is not found.' })
      else if (!facts.workshop.usable) issues.push({ field: 'partyId', message: facts.workshop.why ?? 'That workshop may not get work.' })
    }
    if (changed.includes('operationSeqs')) {
      const seen = new Set<number>()
      for (const seq of next.operationSeqs) {
        if (seen.has(seq)) issues.push({ field: 'operationSeqs', message: `Step ${seq} is named twice.` })
        seen.add(seq)
        if (!facts.routingSeqs.includes(seq)) issues.push({ field: 'operationSeqs', message: `Step ${seq} is not a step of its routing.` })
      }
    }
    if (changed.includes('kitDueAt') || changed.includes('dueDate')) {
      const kitDay = dayOfInstant(next.kitDueAt)
      if (kitDay !== null && kitDay > next.dueDate) issues.push({ field: changed.includes('kitDueAt') ? 'kitDueAt' : 'dueDate', message: `The kit leaves on ${kitDay}, after it is due (${next.dueDate}): it leaves by its due date.` })
      if (changed.includes('kitDueAt') && kitDay !== null && kitDay < facts.today) issues.push({ field: 'kitDueAt', message: `Nothing is planned before today (${facts.today}): the kit leaves today or later.` })
    }
  }
  if (changed.includes('styleRevisionId') && next.styleRevisionId !== null) {
    if (!facts.revision || !facts.revision.ofStyle) issues.push({ field: 'styleRevisionId', message: 'That revision is not one of the style.' })
    else if (!facts.revision.usable) issues.push({ field: 'styleRevisionId', message: 'That revision cannot be made: name a RELEASED one (or the one its order lines name).' })
  }
  return issues
}

/**
 * The values a run writes on a protected row: the planner's for the protected fields, the plan's for the others; then
 * start ≤ due and the kit by the due date, by moving a field that is not protected (the due date first). `kitAt` gives
 * the kit's time on a day (the site's 08:00). PLN-083: with `today`, a protected date that has fallen before today moves
 * to today (nothing is planned in the past; it stays protected).
 */
export function mergeWithPlan(stored: PlanFields, plan: PlanFields, protectedFields: readonly string[], kind: PlannedOrderKind, kitAt: (day: BusinessDate) => string, today?: BusinessDate): PlanFields {
  const own = (field: ProtectableField) => protectedFields.includes(field)
  const notPast = (day: BusinessDate) => (today !== undefined && day < today ? today : day)
  let startDate = own('startDate') ? notPast(stored.startDate) : plan.startDate
  let dueDate = own('dueDate') ? notPast(stored.dueDate) : plan.dueDate
  if (startDate > dueDate) {
    if (!own('dueDate')) dueDate = startDate
    else if (!own('startDate')) startDate = dueDate
  }
  let partyId = own('partyId') ? stored.partyId : plan.partyId
  let operationSeqs = own('operationSeqs') ? stored.operationSeqs : plan.operationSeqs
  let kitDueAt = own('kitDueAt') ? stored.kitDueAt : plan.kitDueAt
  let lineId = own('lineId') ? stored.lineId : plan.lineId
  if (kind === 'MAKE') {
    partyId = null
    operationSeqs = []
    kitDueAt = null
  } else {
    lineId = null
    // The plan makes it in-house now: the workshop and its steps stay as they are (a SUBCONTRACT row keeps a workshop).
    if (partyId === null) {
      partyId = stored.partyId
      operationSeqs = stored.operationSeqs
    }
    if (kitDueAt === null || (today !== undefined && dayOfInstant(kitDueAt)! < today)) kitDueAt = kitAt(startDate)
    const kitDay = dayOfInstant(kitDueAt)!
    if (kitDay > dueDate) {
      if (!own('kitDueAt')) kitDueAt = kitAt(dueDate < startDate ? dueDate : startDate)
      else if (!own('dueDate')) dueDate = kitDay
    }
  }
  return {
    sizes: own('sizes') ? stored.sizes : plan.sizes,
    startDate,
    dueDate,
    lineId,
    partyId,
    operationSeqs,
    kitDueAt,
    styleRevisionId: own('styleRevisionId') ? stored.styleRevisionId : plan.styleRevisionId,
  }
}

/** The plan's values of the protected fields (what Reset to plan puts back), as JSON. */
export function planValuesOf(plan: PlanFields, protectedFields: readonly string[]): Partial<Record<ProtectableField, unknown>> {
  const out: Partial<Record<ProtectableField, unknown>> = {}
  for (const field of PROTECTABLE_FIELDS) if (protectedFields.includes(field)) out[field] = field === 'sizes' || field === 'operationSeqs' ? [...(plan[field] as readonly unknown[])] : plan[field]
  return out
}

/** Stored plan values (the run log's), read defensively: only fields with a value of the right shape. */
export function readPlanValues(value: unknown): Partial<PlanFields> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as Record<string, unknown>
  const day = (key: string) => (typeof row[key] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row[key] as string) ? (row[key] as string) : undefined)
  const id = (key: string) => (row[key] === null ? null : typeof row[key] === 'string' ? (row[key] as string) : undefined)
  const out: { -readonly [K in keyof PlanFields]?: PlanFields[K] } = {}
  if (Array.isArray(row.sizes)) {
    const sizes = row.sizes.flatMap((entry) => (entry && typeof entry === 'object' && typeof (entry as SizeQuantity).size === 'string' && Number.isSafeInteger((entry as SizeQuantity).quantity) ? [{ size: (entry as SizeQuantity).size, quantity: (entry as SizeQuantity).quantity }] : []))
    if (sizes.length > 0) out.sizes = sizes
  }
  if (day('startDate')) out.startDate = day('startDate')!
  if (day('dueDate')) out.dueDate = day('dueDate')!
  if (id('lineId') !== undefined) out.lineId = id('lineId')!
  if (id('partyId') !== undefined) out.partyId = id('partyId')!
  if (id('styleRevisionId') !== undefined) out.styleRevisionId = id('styleRevisionId')!
  if (row.kitDueAt === null || (typeof row.kitDueAt === 'string' && !Number.isNaN(Date.parse(row.kitDueAt)))) out.kitDueAt = row.kitDueAt as string | null
  if (Array.isArray(row.operationSeqs) && row.operationSeqs.every((seq) => Number.isSafeInteger(seq))) out.operationSeqs = row.operationSeqs as number[]
  return out
}

/** A row's demand per order line and size: pieces. */
const cellsOf = (demand: readonly PeggedDemand[]): Map<string, number> => {
  const out = new Map<string, number>()
  for (const entry of demand) out.set(`${entry.orderLineId}|${entry.size}`, (out.get(`${entry.orderLineId}|${entry.size}`) ?? 0) + entry.pieces)
  return out
}

/** How many pieces two demands share (per order line and size, the lesser). */
export function overlapOf(a: readonly PeggedDemand[], b: readonly PeggedDemand[]): number {
  const left = cellsOf(a)
  let shared = 0
  for (const [key, pieces] of cellsOf(b)) shared += Math.min(pieces, left.get(key) ?? 0)
  return shared
}

/**
 * Each protected row follows its demand: the proposal of the same style and colourway that shares most of its pieces
 * (the same kind first, then the proposal's order), each proposal to one row at most, rows in their order. A row whose
 * demand no proposal shares stays unclaimed.
 */
export function claimProposals(rows: readonly { readonly id: string; readonly kind: string; readonly styleId: string; readonly colourwayId: string; readonly demand: readonly PeggedDemand[] }[], proposals: readonly { readonly kind: string; readonly styleId: string; readonly colourwayId: string; readonly demand: readonly PeggedDemand[] }[]): Map<string, number> {
  const claims = new Map<string, number>()
  const taken = new Set<number>()
  for (const row of rows) {
    let best: { index: number; shared: number; sameKind: boolean } | null = null
    proposals.forEach((proposal, index) => {
      if (taken.has(index) || proposal.styleId !== row.styleId || proposal.colourwayId !== row.colourwayId) return
      const shared = overlapOf(row.demand, proposal.demand)
      if (shared <= 0) return
      const sameKind = proposal.kind === row.kind
      if (!best || shared > best.shared || (shared === best.shared && sameKind && !best.sameKind)) best = { index, shared, sameKind }
    })
    if (best) {
      claims.set(row.id, (best as { index: number }).index)
      taken.add((best as { index: number }).index)
    }
  }
  return claims
}

/** PLN-083: how late a planned order is against the day its demand needs it (null: in time). */
export function lateOf(needDate: BusinessDate, dueDate: BusinessDate): { readonly needDate: BusinessDate; readonly daysLate: number } | null {
  return dueDate > needDate ? { needDate, daysLate: daysFrom(needDate, dueDate) } : null
}
