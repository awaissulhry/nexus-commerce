import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { PLANNING_PROMISE_VIEW } from '@nexus/factory-domain/planning/promise/permissions'
import { effectiveHealth, type BrandHealth, type HealthRaise } from '@nexus/factory-domain/production-brand/health'
import { standingRaiseOf } from './production-columns' // B-SA-070
import { nextStageOf, type BrandStage } from '@nexus/factory-domain/production-brand/stages'
import type { OrderStage } from '@nexus/factory-domain/production-brand/stages' // B-MS-006
import type { HandStage, StageSetReasonCode } from '@nexus/factory-domain/production-brand/stage-set' // B-MS-006
import { isAfterProduction, officeStripStateOf } from '@nexus/factory-domain/production-brand/stages' // B-OO-007
import type { BrandUrgency } from '@nexus/factory-domain/production-brand/urgency'
import { BLOCKER_OWNER, type Blocker, type BlockerKind, type BlockerRef, type WaitingOn } from '@nexus/factory-domain/production-brand/waiting' // B-OP-021: + BlockerRef
import { placeOf, waitingOn } from '@nexus/factory-domain/production-brand/waiting' // B-OO-007
import type { SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders' // B-OO-007
import { aheadWords, customerUrgencyChipWords, HEALTH_REASON_WORDS, HEALTH_WORDS, OFFICE_WAITING_WORDS, SEWING_NOT_COUNTED_WORDS, STAGE_WORDS, URGENCY_WORDS } from '@nexus/factory-domain/production-brand/words'
import { daysLate, type WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_HOLD, WORKORDERS_MANAGE, WORKORDERS_RELEASE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions' // B-OP-021: + manage, release, hold
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import { OPEN_NCR_STAGES } from '@nexus/factory-domain/quality/ncr/rules'
import { PRIORITY_WORDS, type SalesOrderPriorityLevel } from '@nexus/factory-domain/sales/orders-depth/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { PROGRESS_REFRESH_SECONDS } from '@nexus/factory-domain/sales/portal-orders/progress'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { readWorld } from '../../planning/milestones/world'
import { LINES_LIMIT, promiseLinesOf } from '../../planning/promise-keep/lines'
import type { FinishSource } from '@nexus/factory-domain/planning/promise-keep/risk' // F-SA-234b
import { SITE_COLUMNS, type SiteRow } from '../../planning/store'
import { GOODS_LINE_KINDS, readOrderProductionFacts } from '../../production/brand/facts'
import { countedUrgencyOf } from '../../production/brand/urgency-of'
import { readPlanned, readWork, workOf } from '../../production/brand-portal/access'
import { issueReadWhere, issuesOfOrderWhere, type OrderFilter } from '../../production/issues/list'
import { brandProductionKey, supervisorOfOrder } from '../../production/supervisor/resolver'
import { readHandNotice, type HandNotice } from '../../production/brand/keeper' // B-MS-008 (ms-fx1): Clear…'s words read the markers
import { reachesWorkOrder } from '../../production/work-orders/scope'
import { ncrsOfOrderWhere } from '../../quality/ncr/reads'
import { ncrListWhere } from '../../quality/wall'
import { officeProgressFor, type CellCount } from '../portal-orders/progress'
import { officeContextOf } from './access'
import { officeOrder } from './moves'
import { PRODUCTION_PARTS, type ProductionPart, type WithheldKey } from './production-contract'
import type { PlaceKind } from './production-contract' // B-OO-008
import { dayOf, dayOrNull, readLines, readOrderFacts, type LineRecord, type OrderRow } from './store'
// B-SA-043: the order's extra pieces (cut beyond what it now wants), office only.
import { madeExtraOf } from './made-extra'
import { APPROVAL_KINDS, KIND_RULES, type ApprovalKind } from '@nexus/factory-domain/approvals-out/kinds' // walk #3: what an approval we asked asks
// B-SA-050: Still to do, computed from the records.
import { stillToDoOf } from './still-to-do'
// B-OO-008 (order overview N7, N8): who answers the customer by the threads' own owner chain, office only (W08).
import { ownerOf } from '../../../platform/threads/owner'
// B-PT-001 (order production tab R1): a work order's risk by the Production list's own rule (one rule for both screens).
import { riskFactsOf, type RiskRow } from '../../production/work-orders/risk'
// B-PT-004 (R4): the spec each work order is made to — the domain's rule and the change order's decision, as …/spec/versions reads them.
import { newerSpecOf, type Decision } from '@nexus/factory-domain/product/versions/drift'
import type { RevisionStatus } from '@nexus/factory-domain/product/styles/revisions'
import { decisionFor } from '../../product/versions/drift'

/**
 * B-SA-031 / B-SA-032 (Sales page plan P2, P3, P4, P15, P16; 13-backend B1, B12; 10-order-page OR1, OR2; review WP-3): the office's
 * read of ONE sales order's production, the office twin of the customer's `GET /portal/production/:orderId`, built from the
 * readers that answer the customer (reused, never copied): the facts of the order (production/brand facts: the plain stage,
 * "N lines ahead", "sewing not counted here", what it waits on), the keeper's stored state (health, its raise, waiting, the
 * customer's urgency, the supervisor), the counts of its OWN cells (portal-orders/progress readCellCounts, kept a minute under the
 * portal's own key), the holds in plain words (brand-portal readWork), the published plan's days (readPlanned), Time & action's
 * world under orders.view (planning/milestones readWorld: the gates, start and ship; B-OO-010: each gate's version and what the
 * reader may do, by Planning's own rule — the writes stay Planning's routes), the issues and NCRs of the order
 * (B-SA-033's filters), and the supervisor resolver.
 *
 *   headline  the plain stage (since, ahead, sewing not counted; B-MS-006: the stage set by hand with its reason, the floor's own
 *             stage and when — its note and who with workorders.view only — and the production row's version; B-MS-008 (ms-fx1):
 *             whether the customer was told it or when its notice goes, from the keeper's markers), what is in work as
 *             counts (bundles; pieces between the steps),
 *             the health (its raise: the office's note and who raised it with workorders.view only), who it waits on and each
 *             blocker in words, the holds in words (their office notes with workorders.view), the promise and its slip, the
 *             three urgencies (the customer's own mark, the factory's rush, the office's priority)                  orders.view
 *   lines     per line and size the order's OWN pieces: ordered · cut (and bundled) · sewn · checked · packed · shipped orders.view
 *   work      the live work orders that make its lines, each with THIS order's share; "also makes" names only orders of this
 *             customer that the reader reaches (the rest of them counted); a work order made before the one-customer rule says
 *             "made together with other work" and a shared cut order "cut together with other work" — never another customer's
 *             name, number or count; made-to-measure units grouped per style × colourway; the work orders the reader does not
 *             reach counted ("1 work order not shown"), never named                                         workorders.view
 *   dates     the gates (B-OO-010: + version, actions) and milestones, the published plan's days, the forecast per line
 *                                                                                    orders.view (+ planning.promise.view)
 *   quality   open issues (workorders.view), open NCRs behind the brand wall (quality.ncr.view), final inspections of the work
 *             orders the reader reaches (quality.inspections.view)
 *   people    the supervisor and where from, the customer's backup, who answers the customer (B-OO-008: the threads' owner chain
 *             — the thread's own owner, else the order's supervisor, else its maker — and which one), the places of its LIVE work
 *             orders (B-OO-008: a cancelled or closed one makes nothing) — a site and line (a team by name only) at the plant, or
 *             an outside workshop since the day its job was issued; never an operator, a count or an output   workorders.view
 *   changes   the customer's requests still waiting; B-SA-050: Still to do after the accepted changes (./still-to-do: each row
 *             names the record that closes it, computed — never ticked)                                      orders.view
 *
 * About 35 indexed queries for every part; `?parts=` makes a live re-read 3–8. No planning engine runs for the health (the
 * keeper's stored row): the forecast is the only planning read, and only for a reader of promises. A read: no command, no event.
 */

type Db = FactoryClient

// ---- pure parts (unit-tested: ./production-read.vitest.test.ts) ----------------------------------------------------------------

/** The parts asked (`?parts=a,b`), in their own order; none: every part. An unknown name is refused in words. */
export function partsOf(text: string | undefined): ProductionPart[] {
  if (text === undefined) return [...PRODUCTION_PARTS]
  const asked = text.split(',').map((part) => part.trim()).filter((part) => part !== '')
  const unknown = asked.filter((part) => !(PRODUCTION_PARTS as readonly string[]).includes(part))
  if (asked.length === 0 || unknown.length > 0) {
    throw new ValidationError("Not a part of the order's production.", [{ path: 'querystring/parts', message: `Parts: ${PRODUCTION_PARTS.join(', ')}.` }])
  }
  return PRODUCTION_PARTS.filter((part) => asked.includes(part))
}

/** What each part, and each block of a part, needs beside orders.view. */
export const PART_RIGHTS: Readonly<Record<WithheldKey, Permission>> = Object.freeze({
  work: WORKORDERS_VIEW,
  people: WORKORDERS_VIEW,
  'headline.notes': WORKORDERS_VIEW,
  'quality.issues': WORKORDERS_VIEW,
  'quality.ncrs': QUALITY_NCR_VIEW,
  'quality.final': QUALITY_INSPECTIONS_VIEW,
  'dates.forecast': PLANNING_PROMISE_VIEW,
})

/** The blocks of the parts asked that the reader may not read (each named once, in the contract's order). */
export function withheldOf(parts: readonly ProductionPart[], may: (permission: Permission) => boolean): WithheldKey[] {
  const keys = Object.keys(PART_RIGHTS) as WithheldKey[]
  return keys.filter((key) => parts.includes(key.split('.')[0] as ProductionPart) && !may(PART_RIGHTS[key]))
}

/** A sum that stays null when nothing counts the step (never a made-up 0). */
export function sumOrNull(values: Iterable<number | null>): number | null {
  let total: number | null = null
  for (const value of values) if (value !== null) total = (total ?? 0) + value
  return total
}

/** THIS order's share of one work order: its own cells, their pieces and what the floor counted of them. */
export function ownShareOf(cells: readonly { readonly quantity: number; readonly cellId: string }[], counts: ReadonlyMap<string, Pick<CellCount, 'cut' | 'sewn' | 'inspected'>>) {
  return {
    cells: cells.length,
    pieces: cells.reduce((sum, cell) => sum + cell.quantity, 0),
    cut: sumOrNull(cells.map((cell) => counts.get(cell.cellId)?.cut ?? null)),
    sewn: sumOrNull(cells.map((cell) => counts.get(cell.cellId)?.sewn ?? null)),
    checked: sumOrNull(cells.map((cell) => counts.get(cell.cellId)?.inspected ?? null)),
  }
}

/** One other order a work order also makes (of any customer: the reader's wall decides below). */
export interface OtherOrder {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly partyId: string
}

/**
 * "Also makes": the other orders of THIS order's customer the reader reaches, by number; this customer's others counted (`more`);
 * another customer's order is neither named nor counted (a work order made before the rule says `sharedWithOtherCustomers`).
 */
export function alsoMakesOf(others: readonly OtherOrder[], partyId: string, reaches: (order: OtherOrder) => boolean): { orders: { id: string; number: string }[]; more: number } {
  const own = others.filter((order) => order.partyId === partyId)
  const named = own.filter(reaches).sort((a, b) => a.number.localeCompare(b.number))
  return { orders: named.map((order) => ({ id: order.id, number: order.number })), more: own.length - named.length }
}

/** Made-to-measure work orders (one per unit), grouped per style × colourway: one row with its units and statuses. */
export function mtmGroupsOf<T extends { readonly styleId: string; readonly colourwayId: string; readonly status: string; readonly units: number }>(rows: readonly T[]): { styleId: string; colourwayId: string; units: number; workOrders: number; byStatus: { status: string; count: number }[]; rows: T[] }[] {
  const groups = new Map<string, { styleId: string; colourwayId: string; rows: T[] }>()
  for (const row of rows) {
    const key = `${row.styleId}|${row.colourwayId}`
    const group = groups.get(key) ?? { styleId: row.styleId, colourwayId: row.colourwayId, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
    const statuses = new Map<string, number>()
    for (const row of group.rows) statuses.set(row.status, (statuses.get(row.status) ?? 0) + 1)
    return {
      styleId: group.styleId,
      colourwayId: group.colourwayId,
      units: group.rows.reduce((sum, row) => sum + row.units, 0),
      workOrders: group.rows.length,
      byStatus: [...statuses].map(([status, count]) => ({ status, count })).sort((a, b) => a.status.localeCompare(b.status)),
      rows: group.rows,
    }
  })
}

// ── B-PT-001 / B-PT-003 (order production tab R1, R3) ──────────────────────────────────────────────────────────────────────────
/** A job of a work order at an outside workshop, as the work part reads it. */
export interface WorkshopJob {
  readonly partyId: string
  readonly issuedAt: Date | null
  readonly expectedBackDate: Date | null
}

/**
 * B-PT-001: the outside workshops of one work order, each once (in the order met): `since` the day its first job still out there
 * was issued, `expectedBack` the latest day a job there is due back (null: not given) — "out at a workshop, back on 4 Dec". A work
 * order shared with other customers keeps the names only (both null), as before.
 */
export function workshopsOf(jobs: readonly WorkshopJob[], names: ReadonlyMap<string, string>, shared: boolean): { name: string; since: BusinessDate | null; expectedBack: BusinessDate | null }[] {
  return [...new Set(jobs.map((job) => job.partyId))].map((partyId) => {
    const mine = jobs.filter((job) => job.partyId === partyId)
    const issued = mine.flatMap((job) => (job.issuedAt ? [job.issuedAt.getTime()] : []))
    const back = mine.flatMap((job) => (job.expectedBackDate ? [dayOf(job.expectedBackDate)] : [])).sort()
    return {
      name: names.get(partyId) ?? '',
      since: shared || issued.length === 0 ? null : businessDate(new Date(Math.min(...issued))),
      expectedBack: shared || back.length === 0 ? null : back[back.length - 1]!,
    }
  })
}

/** B-PT-003: the most unit numbers one made-to-measure row lists; the rest are counted (`unitsMore`). */
export const MTM_UNITS_LIMIT = 50

/**
 * B-PT-003: a made-to-measure row's units in number order (WO-9 before WO-10), at most `limit`, and how many more. `unitList`, not
 * 13-backend's `units`: the row's `units` is already its count of pieces (the web reads it).
 */
export function mtmUnitsOf<T extends { readonly number: string }>(units: readonly T[], limit: number = MTM_UNITS_LIMIT): { unitList: T[]; unitsMore: number } {
  const sorted = [...units].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))
  return { unitList: sorted.slice(0, limit), unitsMore: Math.max(0, sorted.length - limit) }
}
// ── end B-PT-001 / B-PT-003 ──

// ── B-PT-004 (order production tab R4): the spec each work order is made to ──────────────────────────────────────────────────
/** A revision as the spec of a work order reads it. */
export interface SpecRevision {
  readonly id: string
  readonly styleId: string
  readonly revision: number
  readonly status: string
  readonly releasedAt: Date | null
}

/**
 * B-PT-004: the spec a work order is made to, by the domain's rule (product/versions/drift newerSpecOf, as GET …/spec/versions
 * says it): its revision, the state (CURRENT, NEWER_RELEASED, WITHDRAWN, NOT_RELEASED, NO_REVISION), the newer released revision
 * with its day (only when NEWER_RELEASED) and what a change order decided for it (only then). Never the rule's `message` (English
 * only): the screen's words come from `state`.
 */
export function workOrderSpecOf(pinned: SpecRevision | null, released: SpecRevision | null, decision: Decision | null) {
  const ref = (row: SpecRevision) => ({ id: row.id, revision: row.revision, status: row.status })
  const spec = newerSpecOf({ pinned: pinned ? ref(pinned) : null, released: released ? ref(released) : null, decision })
  const newer = spec.state === 'NEWER_RELEASED' && released ? { revision: released.revision, releasedOn: released.releasedAt ? businessDate(released.releasedAt) : null } : null
  return {
    revision: pinned ? { revision: pinned.revision, status: pinned.status as RevisionStatus } : null,
    state: spec.state,
    newer,
    decision: spec.state === 'NEWER_RELEASED' ? decision : null,
  }
}
// ── end B-PT-004 ──

/** The pieces between the steps (what is in work now): counts only, from the order's own settled figures. */
export function inWorkPiecesOf(input: { readonly started: number; readonly cut: number | null; readonly sewn: number | null; readonly checked: number | null; readonly packed: number | null }) {
  const less = (from: number, minus: number) => Math.max(0, from - minus)
  const cut = input.cut ?? 0
  return {
    cutting: less(input.started, cut),
    sewing: input.sewn === null ? null : less(cut, input.sewn),
    checking: input.sewn === null ? null : less(input.sewn, input.checked ?? 0),
    packing: input.checked === null ? null : less(input.checked, input.packed ?? 0),
  }
}

/** Whole days from `from` to `to` (later: positive). */
export const daysBetween = (from: BusinessDate, to: BusinessDate): number => Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000)

// ── B-OP-021 (13-backend §3 B6; review R-11): what the order page may do to a work order in place ──────────────────────────────
/** A work order shared with other customers (made before the one-customer rule) is changed on its own page, never from one order. */
export const SHARED_WORK_ORDER_WORDS: Words = Object.freeze({ it: 'Condiviso con altri clienti: cambialo dalla sua pagina.', en: 'Shared with other customers: change it on its page.' })

/** The reader's rights over one work order from the order page (`may`: can() over the work order); a shared one: none, in words. */
export function workOrderRightsOf(may: (permission: Permission) => boolean, shared: boolean): { manage: boolean; release: boolean; hold: boolean; why: Words | null } {
  if (shared) return { manage: false, release: false, hold: false, why: SHARED_WORK_ORDER_WORDS }
  return { manage: may(WORKORDERS_MANAGE), release: may(WORKORDERS_RELEASE), hold: may(WORKORDERS_HOLD), why: null }
}

/** B-OP-021: a blocker's record for this reader: a work order only when the reader reaches it (else no door), every other as it is. */
// op-fx1: the answer names its message only when there is one (never null), as the order view's contract says (messageId optional).
export function blockerRefFor(ref: BlockerRef | null | undefined, reaches: (workOrderId: string) => boolean): (Omit<BlockerRef, 'messageId'> & { readonly messageId?: string }) | null {
  if (!ref) return null
  if (ref.type === 'WorkOrder' && !reaches(ref.id)) return null
  // F-OP-103: a reported problem keeps the message it was raised with (the order's own thread).
  return ref.messageId ? { type: ref.type, id: ref.id, messageId: ref.messageId } : { type: ref.type, id: ref.id }
}
// ── end B-OP-021 ──

/** Each blocker in the office's words (tu): what the order waits for. */
export const BLOCKER_WORDS: Readonly<Record<BlockerKind, Words>> = Object.freeze({
  APPROVAL: { it: 'In attesa del sì del cliente', en: "Waiting for the customer's yes" },
  PARTNER_TASK: { it: 'Un compito aperto sul portale del cliente', en: "An open task on the customer's portal" },
  DEPOSIT: { it: 'Acconto non ancora pagato', en: 'Deposit not paid yet' },
  CUSTOMER_MATERIAL: { it: 'Materiale del cliente non ancora arrivato', en: "The customer's material is not in yet" },
  BRAND_PAUSE: { it: 'In pausa su richiesta del cliente', en: "Paused at the customer's request" },
  MATERIAL_SHORT: { it: 'Materiale mancante', en: 'Material short' },
  SUBCONTRACT: { it: 'Presso un laboratorio esterno', en: 'At an outside workshop' },
  BRAND_REQUEST: { it: 'Una richiesta del cliente aspetta la nostra risposta', en: 'A customer request waits for our answer' },
  GATE: { it: 'Un passaggio non è ancora superato', en: 'A gate is not passed yet' },
  RELEASE_CHECK: { it: 'Il controllo di rilascio non è superato', en: 'The release check is not passed' },
  QUALITY_HOLD: { it: 'In blocco qualità', en: 'On a quality hold' },
  NONCONFORMANCE: { it: 'Una non conformità aperta', en: 'An open nonconformance' },
  NO_MOVE: { it: 'Fermo di produzione', en: 'Production hold' },
})

// ── walk #3 (order overview walk fix round): an approval we asked of the customer says what it asks ──────────────────────────────
/**
 * A blocker's words for the office. An approval we asked of the customer (an ApprovalRequest) names what it asks — its kind's own name
 * ("Waiting for the customer's yes: Artwork"), so it never reads like the order's own yes. Never its question: that is free text the
 * approvals list shows only with partners.approvals.view (and a revised order's names money). A kind not read: the plain words.
 */
export function blockerWordsOf(blocker: Pick<Blocker, 'kind' | 'ref'>, askedKinds: ReadonlyMap<string, ApprovalKind>): Words {
  const kind = blocker.kind === 'APPROVAL' && blocker.ref?.type === 'ApprovalRequest' ? askedKinds.get(blocker.ref.id) : undefined
  const name = kind ? KIND_RULES[kind].name : null
  return name ? { it: `${BLOCKER_WORDS.APPROVAL.it}: ${name.it}`, en: `${BLOCKER_WORDS.APPROVAL.en}: ${name.en}` } : BLOCKER_WORDS[blocker.kind]
}

/** walk #3: the kinds of the approvals we asked that the blockers name (one read; a kind the schema does not know is left out). */
async function askedKindsOf(db: Db, blockers: readonly Blocker[]): Promise<Map<string, ApprovalKind>> {
  const ids = [...new Set(blockers.flatMap((blocker) => (blocker.kind === 'APPROVAL' && blocker.ref?.type === 'ApprovalRequest' ? [blocker.ref.id] : [])))]
  if (ids.length === 0) return new Map()
  const rows = await db.approvalRequest.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true } })
  const known: ReadonlySet<string> = new Set(APPROVAL_KINDS)
  return new Map(rows.flatMap((row) => (known.has(row.kind) ? [[row.id, row.kind as ApprovalKind] as const] : [])))
}
// ── end walk #3 ──

// ── B-OO-007 (order overview plan §6; review F11; N10b) ──────────────────────────────────────────────────────────────────────
/**
 * What still waits once production is over (the office strip state ALL_DONE or STOPPED: shipped, delivered, closed, cancelled):
 * only the requests (a customer's open request or problem, a yes asked of it, a portal task) — a hold or a date is moot then.
 * While the order is current (or waits for a yes) every blocker stays.
 */
export function officeBlockersOf(status: SalesOrderStatus, blockers: readonly Blocker[]): Blocker[] {
  if (!isAfterProduction(officeStripStateOf(status))) return [...blockers]
  return blockers.filter((blocker) => placeOf(blocker) === 'REQUEST')
}

/**
 * How many times the promise MOVED: the order's `orders.changePromise` audit rows (their `before`), less the ones that set a first
 * promise — an order with no promise yet records `before.originalPromiseDate: null` (sales/orders moves.ts, the order's and the
 * lines' change alike). A row that does not say counts, as before.
 */
export function promiseMovesOf(befores: readonly unknown[]): number {
  const first = (before: unknown): boolean => before !== null && typeof before === 'object' && 'originalPromiseDate' in before && (before as { originalPromiseDate: unknown }).originalPromiseDate === null
  return befores.filter((before) => !first(before)).length
}
// ── end B-OO-007 ──

// ── B-MS-006 (set the stage by hand; review fixes R9, R17) ──────────────────────────────────────────────────────────────────────
/** The production row's stage columns as the headline reads them. */
export interface HeadlineStageRow {
  readonly stage: string
  readonly stageAt: Date
  readonly stageSet: string | null
  readonly stageSetReason: string | null
  readonly stageSetNote: string | null
  readonly stageSetAt: Date | null
  readonly version: number
}

/** An office person as the read names one. */
export interface HeadlinePerson {
  readonly id: string
  readonly name: string
  readonly active: boolean
}

/**
 * The headline's stage: the one the customer reads — the row's (the keeper's SHOWN stage: the floor's, or the one set by hand while
 * it leads), else the live facts while no row is kept yet — with "ahead" and "sewing not counted" only from live facts that agree
 * (under a hand stage they never do: both vanish). B-MS-006: `byHand` while a stage set by hand stands — its stage and reason, the
 * floor's own stage from the live facts (null: no goods line open), when; the office's note and who set it only behind the `notes`
 * gate (workorders.view) — and the production row's `version`, which a set, change or clear by hand sends back (R9; null: no row
 * yet, so a set sends null and makes it, R1). null: no stage at all (no row, no goods line open).
 * B-MS-008 (ms-fx1; Z01 note 2): `byHand.notice` — the customer's notice of that stage as the keeper's markers say it (keeper
 * readHandNotice): told, or when it goes (`waitsUntil`), or neither (never told); null when not read. Clear… says it, never the set's
 * time (a Change to the same stage writes a new one and tells nothing).
 */
export function headlineStageOf(input: { readonly row: HeadlineStageRow | null; readonly live: OrderStage | null; readonly partlyShipped: boolean; readonly notes: boolean; readonly setBy: HeadlinePerson | null; readonly notice?: HandNotice | null }) {
  const { row, live, notes } = input
  const code: BrandStage | null = row ? (row.stage as BrandStage) : (live?.stage ?? null)
  if (code === null) return null
  const agreeing = live && live.stage === code ? live : null
  const next = nextStageOf(code)
  const hand = row && row.stageSet !== null && row.stageSetReason !== null && row.stageSetAt !== null ? { stage: row.stageSet as HandStage, reasonCode: row.stageSetReason as StageSetReasonCode, at: row.stageSetAt, note: row.stageSetNote } : null
  return {
    code,
    words: STAGE_WORDS[code],
    since: row ? businessDate(row.stageAt) : null,
    ahead: agreeing?.ahead ?? 0,
    aheadWords: aheadWords(agreeing?.ahead ?? 0),
    sewingNotCounted: agreeing?.sewingNotCounted ?? false,
    sewingNotCountedWords: agreeing?.sewingNotCounted ? SEWING_NOT_COUNTED_WORDS : null,
    next: next ? { code: next, words: STAGE_WORDS[next] } : null,
    partlyShipped: input.partlyShipped,
    byHand: hand
      ? {
          stage: hand.stage,
          reasonCode: hand.reasonCode,
          floor: live ? { code: live.stage, words: STAGE_WORDS[live.stage] } : null,
          at: toUtcIso(hand.at),
          note: notes ? hand.note : null,
          by: notes ? input.setBy : null,
          // B-MS-008 (ms-fx1): told, or when its notice goes (null: not read).
          notice: input.notice ? { told: input.notice.told, waitsUntil: input.notice.waitsUntil ? toUtcIso(input.notice.waitsUntil) : null } : null,
        }
      : null,
    version: row ? row.version : null,
  }
}
// ── end B-MS-006 ──

// ---- the read ---------------------------------------------------------------------------------------------------------------------

/** Subcontract orders whose pieces are out at the workshop (production/brand facts' own set). */
const AT_WORKSHOP = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] as const
/** Work orders whose ACTIVE bundles are in work. */
const IN_WORK = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
/** B-OO-008 (N8): work orders that make nothing any more, so name no place (the loader already leaves out cancelled cells). */
const NO_PLACE_WORK_ORDERS: readonly string[] = ['CANCELLED', 'CLOSED']

const isGoods = (line: Pick<LineRecord, 'kind'>): boolean => (GOODS_LINE_KINDS as readonly string[]).includes(line.kind)
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]
const named = (row: { readonly code: string; readonly name: string } | undefined | null) => (row ? { code: row.code, name: row.name } : null)

/** The order's own facts every part reads from, each read once and only when a part asks for it. */
function loaders(db: Db, context: OfficeContext, order: OrderRow, now: Date) {
  const once = <T>(read: () => Promise<T>): (() => Promise<T>) => {
    let kept: Promise<T> | null = null
    return () => (kept ??= read())
  }
  const lines = once(() => readLines(db, order.id))
  // The cells of its own lines in live work orders (not a repair, not cancelled), read now; their counts from the kept minute.
  const cells = once(async () => {
    const lineIds = (await lines()).map((line) => line.id)
    if (lineIds.length === 0) return []
    const rows = await db.workOrderSize.findMany({
      where: { salesOrderLineId: { in: lineIds }, workOrder: { kind: { not: 'REPAIR' }, status: { not: 'CANCELLED' } } },
      select: { id: true, workOrderId: true, salesOrderLineId: true, colourwayId: true, size: true, quantity: true },
      orderBy: { id: 'asc' },
    })
    return rows.flatMap((row) => (row.salesOrderLineId ? [{ cellId: row.id, workOrderId: row.workOrderId, lineId: row.salesOrderLineId, colourwayId: row.colourwayId, size: row.size, quantity: row.quantity }] : []))
  })
  const progress = once(async () => officeProgressFor(db, context.tenantId, order.id, await lines(), now))
  const counts = once(async () => new Map((await progress()).cells.cells.map((cell) => [cell.cellId, cell] as const)))
  const workOrders = once(async () => {
    const ids = unique((await cells()).map((cell) => cell.workOrderId))
    if (ids.length === 0) return []
    return db.workOrder.findMany({
      where: { id: { in: ids } },
      select: { id: true, number: true, status: true, kind: true, companyId: true, siteId: true, lineId: true, partyId: true, styleId: true, rush: true, dueDate: true, /* B-OP-021 */ version: true, releasedAt: true, priority: true, /* B-PT-004 */ styleRevisionId: true },
      orderBy: { number: 'asc' },
    })
  })
  const filter = once(async (): Promise<OrderFilter> => ({ id: order.id, workOrderIds: (await workOrders()).map((row) => row.id) }))
  return { lines, cells, progress, counts, workOrders, filter, orderFacts: once(() => readOrderFacts(db, order)) }
}
type Loaders = ReturnType<typeof loaders>

async function peopleById(db: Db, ids: readonly (string | null | undefined)[]) {
  const wanted = unique(ids.filter((value): value is string => typeof value === 'string'))
  const rows = wanted.length === 0 ? [] : await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true, status: true }, orderBy: { id: 'asc' } })
  return new Map(rows.map((row) => [row.id, { id: row.id, name: row.displayName, active: row.status === 'ACTIVE' }]))
}

async function headlinePart(db: Db, context: OfficeContext, order: OrderRow, load: Loaders, now: Date, notes: boolean) {
  const actor = actorOf(context)
  const today = businessDate(now)
  const facts = await readOrderProductionFacts(db, context, order.id, now, { health: false })
  const row = await db.brandOrderProduction.findFirst({
    where: { key: brandProductionKey(order.id) },
    select: {
      id: true, // B-MS-008 (ms-fx1): the keeper's stage markers are on the row
      stage: true,
      stageAt: true,
      // B-MS-006: the stage set by hand and the row's version.
      stageSet: true,
      stageSetReason: true,
      stageSetNote: true,
      stageSetAt: true,
      stageSetById: true,
      version: true,
      health: true,
      healthSet: true,
      healthReasonCode: true,
      healthNote: true,
      healthSetAt: true,
      healthSetById: true,
      healthSetUntil: true,
      waitingOn: true,
      waitingSince: true,
    },
  })
  // The stage the customer reads too (its kept state first), with "ahead" and "sewing not counted" from the live facts that agree.
  // B-MS-006: the stage set by hand (who only behind the notes gate) and the row's version (./headlineStageOf).
  const live = facts?.stage ?? null
  const handBy = row && notes && row.stageSet !== null && row.stageSetById ? ((await peopleById(db, [row.stageSetById])).get(row.stageSetById) ?? null) : null
  // B-MS-008 (ms-fx1): the customer's notice of the stage set by hand, from the keeper's markers (only while one stands).
  const notice = row && row.stageSet !== null ? await readHandNotice(db, row.id, order.id, row.stageSet as BrandStage, now) : null
  const stage = headlineStageOf({ row, live, partlyShipped: order.status === 'PARTLY_SHIPPED', notes, setBy: handBy, notice })

  // What is in work: the order's ACTIVE bundles of work orders past their draft, and its pieces between the steps.
  const cells = await load.cells()
  const workOrders = await load.workOrders()
  const statusOf = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder.status as string]))
  const started = cells.filter((cell) => (IN_WORK as readonly string[]).includes(statusOf.get(cell.workOrderId) ?? '') || statusOf.get(cell.workOrderId) === 'COMPLETED')
  const bundles = started.length === 0 ? 0 : await db.bundle.count({ where: { status: 'ACTIVE', workOrderSizeId: { in: started.filter((cell) => (IN_WORK as readonly string[]).includes(statusOf.get(cell.workOrderId) ?? '')).map((cell) => cell.cellId) } } })
  const whole = (await load.progress()).view.whole
  const inWork = { bundles, pieces: inWorkPiecesOf({ started: Math.min(whole.ordered, started.reduce((sum, cell) => sum + cell.quantity, 0)), cut: whole.cut, sewn: whole.sewn, checked: whole.inspected, packed: whole.packed }) }

  // The keeper's health, raised to At risk by a person while the raise stands (its note and who raised it: office only).
  // B-OO-007 (F11): once production is over (shipped, delivered, closed, cancelled) nothing is "now": no health (the keeper's last row
  // stays the customer's history, untouched).
  const afterProduction = isAfterProduction(officeStripStateOf(order.status as SalesOrderStatus))
  const raise: HealthRaise | null = row && !afterProduction ? standingRaiseOf(row, today) : null // B-SA-070: the one reading of a standing raise (./production-columns)
  const effective = row && !afterProduction ? effectiveHealth(row.health as BrandHealth | null, raise) : null
  const raisedBy = row && notes && raise && row.healthSetById ? ((await peopleById(db, [row.healthSetById])).get(row.healthSetById) ?? null) : null
  const health =
    row && effective && effective.health !== null
      ? {
          code: effective.health,
          words: HEALTH_WORDS[effective.health],
          computed: (row.health as BrandHealth | null) ?? null,
          raise: raise ? { reasonCode: raise.reasonCode, words: HEALTH_REASON_WORDS[raise.reasonCode], until: raise.until, note: notes ? row.healthNote : null, by: raisedBy, at: notes && row.healthSetAt ? toUtcIso(row.healthSetAt) : null } : null,
        }
      : null

  // Who acts next (the kept state first, else the live facts) and each thing it waits for, in words.
  // B-OO-007 (F11): after production only the requests still wait (a hold or a date is moot); who acts next is then the same one
  // rule (waitingOn) over what still waits — the keeper no longer keeps the order, so its row would name a wait that is gone.
  const waits = officeBlockersOf(order.status as SalesOrderStatus, facts?.blockers ?? [])
  const after = afterProduction ? waitingOn(waits) : null
  const on: WaitingOn = after ? after.on : ((row?.waitingOn as WaitingOn | null | undefined) ?? facts?.waiting.on ?? 'US')
  const since = after ? after.since : row ? row.waitingSince : (facts?.waiting.since ?? null)
  // B-OP-021 (B4): each with the record it is about (a work order only for a reader who reaches it) and what a request waiting on us is.
  const reached = workOrders.filter((workOrder) => reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder))
  const reachedWork = new Set(reached.map((workOrder) => workOrder.id))
  const askedKinds = await askedKindsOf(db, waits) // walk #3
  const blockers = waits.map((blocker: Blocker) => ({
    kind: blocker.kind,
    on: BLOCKER_OWNER[blocker.kind],
    words: blockerWordsOf(blocker, askedKinds), // walk #3: an approval we asked names what it asks
    since: blocker.since ? toUtcIso(blocker.since) : null,
    ref: blockerRefFor(blocker.ref, (workOrderId) => reachedWork.has(workOrderId)),
    sub: blocker.kind === 'BRAND_REQUEST' ? (blocker.sub ?? null) : null,
  }))

  // The holds in plain words (the customer's own reader: a hold of a work order of several customers reads its reason's words).
  const lines = await load.lines()
  const work = workOf(await readWork(db, order.partyId, lines, { words: true }), order.id)
  const holdRows = notes && reached.length > 0 ? await db.workOrderHold.findMany({ where: { workOrderId: { in: reached.map((workOrder) => workOrder.id) }, status: 'ACTIVE', note: { not: null } }, select: { workOrderId: true, kind: true, note: true, placedAt: true }, orderBy: [{ placedAt: 'asc' }, { id: 'asc' }] }) : []
  const numberOf = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder.number]))

  // The promise and how far it moved, the three urgencies.
  const date = dayOrNull(order.promiseDate)
  const first = dayOrNull(order.originalPromiseDate)
  // B-OO-007 (N10b): a first promise is not a move (its audit row says the order had none).
  const moves = promiseMovesOf((await db.auditLog.findMany({ where: { recordType: 'SalesOrder', recordId: order.id, action: 'orders.changePromise' }, select: { before: true } })).map((audit) => audit.before))
  const priority = await db.salesOrder.findUnique({ where: { id: order.id }, select: { priorityLevel: true, urgentReason: true } })
  const level = (priority?.priorityLevel ?? 'NORMAL') as SalesOrderPriorityLevel
  const customer = (await countedUrgencyOf(db, [order.id])).get(order.id) ?? null
  const customerUrgency = customer
    ? { code: customer.urgency as BrandUrgency, urgentRank: customer.urgentRank, words: customer.urgency === 'URGENT' ? customerUrgencyChipWords(customer.urgentRank) : URGENCY_WORDS.REGULAR }
    : null

  return {
    stage,
    inWork,
    health,
    waiting: { on, words: OFFICE_WAITING_WORDS[on], since: since ? toUtcIso(since) : null, blockers },
    held: work.onHold || (facts?.held ?? false),
    holds: work.holds.map((hold) => ({ kind: hold.kind, words: hold.words, since: hold.since })),
    holdNotes: notes ? holdRows.map((hold) => ({ workOrderId: hold.workOrderId, number: numberOf.get(hold.workOrderId) ?? '', kind: hold.kind as string, note: hold.note ?? '', since: toUtcIso(hold.placedAt) })) : null,
    promise: { date, first, moved: first !== null && date !== first, moves, slipDays: date !== null && first !== null ? daysBetween(first, date) : null },
    urgency: {
      customer: customerUrgency,
      factoryRush: workOrders.some((workOrder) => workOrder.rush && !['COMPLETED', 'CLOSED'].includes(workOrder.status)),
      officePriority: { level, words: PRIORITY_WORDS[level], reason: priority?.urgentReason ?? null },
    },
  }
}

async function linesPart(db: Db, load: Loaders, /* B-SA-043 */ context: OfficeContext, order: OrderRow) {
  const lines = await load.lines()
  // B-SA-043 (R1, review P6-4): pieces cut of the order's own cells beyond what the line now wants (office only: "Made extra: 4 M").
  const extra = await madeExtraOf(db, context.tenantId, order)
  // A sizeless line (a made-to-measure unit) reads its one piece's extra, of its base size.
  const extraOf = (lineId: string, size: string | null) => extra.find((entry) => entry.lineId === lineId && (size === null || entry.size === size))
  const extraOfLine = (lineId: string) => extra.filter((entry) => entry.lineId === lineId).reduce((sum, entry) => sum + entry.count, 0)
  const view = (await load.progress()).view
  const facts = await load.orderFacts()
  const cells = await load.cells()
  const inWork = new Map<string, number>()
  for (const cell of cells) inWork.set(cell.lineId, (inWork.get(cell.lineId) ?? 0) + cell.quantity)
  const styles = new Map((await db.style.findMany({ where: { id: { in: unique(lines.map((line) => line.styleId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: unique(lines.map((line) => line.colourwayId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const lineOf = new Map(lines.map((line) => [line.id, line]))
  const shippedOf = (lineId: string, size: string | null) => facts.progress.rows.find((row) => row.lineId === lineId && row.size === size)?.shipped ?? 0
  return view.lines.map((entry) => {
    const line = lineOf.get(entry.lineId)
    return {
      lineId: entry.lineId,
      seq: entry.seq,
      kind: line?.kind ?? '',
      style: named(line ? styles.get(line.styleId) : undefined),
      colourway: named(line ? colourways.get(line.colourwayId) : undefined),
      ordered: entry.ordered,
      cut: entry.cut,
      sewn: entry.sewn,
      checked: entry.inspected,
      packed: entry.packed,
      shipped: facts.progress.lines.find((total) => total.lineId === entry.lineId)?.shipped ?? 0,
      inWorkOrders: inWork.get(entry.lineId) ?? 0,
      notInWorkOrders: !inWork.has(entry.lineId),
      sizes: entry.sizes.map((size) => ({ size: size.size, ordered: size.ordered, cut: size.cut, sewn: size.sewn, checked: size.inspected, packed: size.packed, shipped: shippedOf(entry.lineId, size.size), /* B-SA-043 */ madeExtra: extraOf(entry.lineId, size.size)?.count ?? 0, madeExtraWords: extraOf(entry.lineId, size.size)?.words ?? null })),
      // B-SA-043: the line's extra pieces, all sizes together.
      madeExtra: extraOfLine(entry.lineId),
    }
  })
}

// ── B-PT-004 (R4) ──
const SPEC_REVISION = { id: true, styleId: true, revision: true, status: true, releasedAt: true } as const

/**
 * B-PT-004: the spec of each work order (one read of the pinned revisions, one of the styles' RELEASED ones; the change order's
 * decision only for a work order a newer released revision exists for — what GET …/spec/versions shows under workorders.view).
 */
async function specsOf(db: Db, rows: readonly { readonly id: string; readonly styleId: string; readonly styleRevisionId: string | null }[]): Promise<Map<string, ReturnType<typeof workOrderSpecOf>>> {
  const out = new Map<string, ReturnType<typeof workOrderSpecOf>>()
  if (rows.length === 0) return out
  const pinnedIds = [...new Set(rows.flatMap((row) => (row.styleRevisionId ? [row.styleRevisionId] : [])))]
  const pinned = new Map<string, SpecRevision>((pinnedIds.length === 0 ? [] : await db.styleRevision.findMany({ where: { id: { in: pinnedIds } }, select: SPEC_REVISION })).map((row) => [row.id, row]))
  const released = new Map<string, SpecRevision>()
  for (const row of await db.styleRevision.findMany({ where: { styleId: { in: [...new Set(rows.map((entry) => entry.styleId))] }, status: 'RELEASED' }, select: SPEC_REVISION, orderBy: { revision: 'desc' } })) {
    if (!released.has(row.styleId)) released.set(row.styleId, row)
  }
  for (const row of rows) {
    const pin = row.styleRevisionId ? (pinned.get(row.styleRevisionId) ?? null) : null
    const now = released.get(row.styleId) ?? null
    const newer = workOrderSpecOf(pin, now, null).state === 'NEWER_RELEASED'
    out.set(row.id, workOrderSpecOf(pin, now, newer ? await decisionFor(db, row.id) : null))
  }
  return out
}
// ── end B-PT-004 ──

async function workPart(db: Db, context: OfficeContext, order: OrderRow, load: Loaders, today: BusinessDate) {
  const actor = actorOf(context)
  const cells = await load.cells()
  const counts = await load.counts()
  const lines = await load.lines()
  const all = await load.workOrders()
  const reached = all.filter((workOrder) => reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder))
  const reachedIds = reached.map((workOrder) => workOrder.id)
  const ownLineIds = new Set(lines.map((line) => line.id))
  const ownCellIds = cells.map((cell) => cell.cellId)

  // The other orders each reached work order makes (its cells of other lines): named only when of this customer and reached.
  const others = reachedIds.length === 0 ? [] : await db.workOrderSize.findMany({ where: { workOrderId: { in: reachedIds }, salesOrderLineId: { not: null } }, select: { workOrderId: true, salesOrderLineId: true }, distinct: ['workOrderId', 'salesOrderLineId'] })
  const otherLineIds = unique(others.flatMap((cell) => (cell.salesOrderLineId && !ownLineIds.has(cell.salesOrderLineId) ? [cell.salesOrderLineId] : [])))
  const otherLines = otherLineIds.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { id: { in: otherLineIds } }, select: { id: true, orderId: true } })
  const orderOfLine = new Map(otherLines.map((line) => [line.id, line.orderId]))
  const otherOrderIds = unique(otherLines.map((line) => line.orderId).filter((id) => id !== order.id))
  const otherOrders = new Map((otherOrderIds.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: otherOrderIds } }, select: { id: true, number: true, companyId: true, partyId: true } })).map((row) => [row.id, row]))
  const othersOf = (workOrderId: string): OtherOrder[] =>
    unique(others.filter((cell) => cell.workOrderId === workOrderId && cell.salesOrderLineId && orderOfLine.has(cell.salesOrderLineId)).map((cell) => orderOfLine.get(cell.salesOrderLineId!)!))
      .filter((orderId) => orderId !== order.id)
      .flatMap((orderId) => (otherOrders.has(orderId) ? [otherOrders.get(orderId)!] : []))

  // A cut order of one of its cells that also cuts other work (no other id, no count).
  const cutLines = ownCellIds.length === 0 ? [] : await db.cutOrderLine.findMany({ where: { workOrderSizeId: { in: ownCellIds } }, select: { cutOrderId: true, workOrderId: true } })
  const cutOrderIds = unique(cutLines.map((line) => line.cutOrderId))
  const sharedCuts = new Set(
    cutOrderIds.length === 0 ? [] : (await db.cutOrderLine.findMany({ where: { cutOrderId: { in: cutOrderIds }, workOrderSizeId: { notIn: ownCellIds } }, select: { cutOrderId: true }, distinct: ['cutOrderId'] })).map((line) => line.cutOrderId),
  )

  // Where each is made: its site and line, the outside workshops its pieces are at now.
  // B-PT-001: + the site's zone (the day a bar ends), each job's issued day and the day it is expected back.
  const sites = new Map((reached.length === 0 ? [] : await db.site.findMany({ where: { id: { in: unique(reached.map((row) => row.siteId)) } }, select: { id: true, code: true, name: true, timezone: true } })).map((row) => [row.id, row]))
  const lineIds = unique(reached.flatMap((row) => (row.lineId ? [row.lineId] : [])))
  const floorLines = new Map((lineIds.length === 0 ? [] : await db.line.findMany({ where: { id: { in: lineIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const outside = reachedIds.length === 0 ? [] : await db.subcontractOrder.findMany({ where: { workOrderId: { in: reachedIds }, status: { in: [...AT_WORKSHOP] } }, select: { workOrderId: true, partyId: true, issuedAt: true, expectedBackDate: true } })
  const workshopNames = new Map((outside.length === 0 ? [] : await db.party.findMany({ where: { id: { in: unique(outside.map((row) => row.partyId)) } }, select: { id: true, legalName: true, tradeName: true } })).map((row) => [row.id, row.tradeName ?? row.legalName]))
  const styles = new Map((reached.length === 0 ? [] : await db.style.findMany({ where: { id: { in: unique(reached.map((row) => row.styleId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const colourways = new Map((cells.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: unique(cells.map((cell) => cell.colourwayId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))

  // ── B-PT-001 (R1): the risk of each reached work order by the Production list's own rule (riskFactsOf, one call: a planVersion read
  // and a groupBy per site, two reads); none for one shared with other customers (its waiting merges other customers' orders). ──
  const riskRows: RiskRow[] = reached.flatMap((row) => {
    const site = sites.get(row.siteId)
    return row.partyId !== null && row.kind !== 'MADE_TO_MEASURE' && site ? [{ id: row.id, status: row.status as WorkOrderStatus, dueDate: dayOrNull(row.dueDate), siteId: row.siteId, timezone: site.timezone }] : []
  })
  const risks = await riskFactsOf(db, riskRows, today)
  // ── end B-PT-001 ──
  // B-PT-004 (R4): the spec each one is made to; none for one shared with other customers (no plan or spec detail of shared work).
  const specs = await specsOf(db, reached.filter((row) => row.partyId !== null && row.kind !== 'MADE_TO_MEASURE'))

  const ownOf = (workOrderId: string) => cells.filter((cell) => cell.workOrderId === workOrderId)
  const rows = reached.map((workOrder) => {
    const own = ownOf(workOrder.id)
    return {
      id: workOrder.id,
      number: workOrder.number,
      status: workOrder.status as string,
      kind: workOrder.kind as string,
      styleId: workOrder.styleId,
      colourwayId: own[0]?.colourwayId ?? '',
      units: own.length,
      held: workOrder.status === 'ON_HOLD',
      rush: workOrder.rush,
      style: named(styles.get(workOrder.styleId)),
      colourways: unique(own.map((cell) => cell.colourwayId)).flatMap((id) => (colourways.has(id) ? [named(colourways.get(id))!] : [])),
      site: named(sites.get(workOrder.siteId)),
      line: named(workOrder.lineId ? floorLines.get(workOrder.lineId) : undefined),
      // B-PT-001: + since and expected back (a shared work order: the names only).
      workshops: workshopsOf(outside.filter((row) => row.workOrderId === workOrder.id), workshopNames, workOrder.partyId === null),
      own: ownShareOf(own, counts),
      alsoMakes: alsoMakesOf(othersOf(workOrder.id), order.partyId, (other) => can(actor, ORDERS_VIEW, { companyId: other.companyId, partyId: other.partyId })),
      sharedWithOtherCustomers: workOrder.partyId === null,
      cutWithOtherWork: cutLines.some((line) => line.workOrderId === workOrder.id && sharedCuts.has(line.cutOrderId)),
      due: dayOrNull(workOrder.dueDate),
      daysLate: daysLate(workOrder.status as WorkOrderStatus, dayOrNull(workOrder.dueDate), today),
      // ── B-OP-021 (B6; review R-11): its version, release and priority; its cells of this order's lines; the reader's rights ──
      version: workOrder.version,
      releasedAt: workOrder.releasedAt ? toUtcIso(workOrder.releasedAt) : null,
      priority: workOrder.priority,
      // B-PT-002: + sewn and checked per cell, from the same counts (null: not counted there).
      cells: own.map((cell) => ({ id: cell.cellId, salesOrderLineId: cell.lineId, size: cell.size, quantity: cell.quantity, cut: counts.get(cell.cellId)?.cut ?? null, sewn: counts.get(cell.cellId)?.sewn ?? null, checked: counts.get(cell.cellId)?.inspected ?? null })),
      rights: workOrderRightsOf((permission) => reachesWorkOrder(actor, permission, workOrder), workOrder.partyId === null),
      // ── end B-OP-021 ──
      // B-PT-001: null when finished or shared with other customers.
      risk: workOrder.partyId === null ? null : (risks.get(workOrder.id)?.risk ?? null),
      // B-PT-004: null when shared with other customers.
      spec: workOrder.partyId === null ? null : (specs.get(workOrder.id) ?? null),
    }
  })
  // B-OP-021: the row keeps its kind (the contract names it); only the grouping's own keys go.
  const strip = ({ styleId: _styleId, colourwayId: _colourwayId, units: _units, ...row }: (typeof rows)[number]) => row
  const seqOfLine = new Map(lines.map((line) => [line.id, line.seq])) // B-PT-003
  const mtm = mtmGroupsOf(rows.filter((row) => row.kind === 'MADE_TO_MEASURE')).map((group) => ({
    style: named(styles.get(group.styleId)),
    colourway: named(colourways.get(group.colourwayId)),
    units: group.units,
    workOrders: group.workOrders,
    byStatus: group.byStatus,
    own: ownShareOf(group.rows.flatMap((row) => ownOf(row.id)), counts),
    // B-PT-003 (R3): its units by number with the line of each one's first own cell (reached rows only), at most MTM_UNITS_LIMIT.
    ...mtmUnitsOf(group.rows.map((row) => ({ id: row.id, number: row.number, status: row.status, lineSeq: seqOfLine.get(ownOf(row.id)[0]?.lineId ?? '') ?? null }))),
  }))

  // Goods lines no live work order makes yet (a line closed short is done).
  const inWork = new Set(cells.map((cell) => cell.lineId))
  const waiting = lines.filter((line) => isGoods(line) && line.closedShortQuantity === null && !inWork.has(line.id))
  return {
    workOrders: rows.filter((row) => row.kind !== 'MADE_TO_MEASURE').map(strip),
    mtm,
    workOrdersLeftOut: all.length - reached.length,
    notInProduction: { lines: waiting.length, pieces: waiting.reduce((sum, line) => sum + line.quantity, 0) },
  }
}

/** The forecast per open line from the plan (promise-keep, per making site; a line of no site: its company's only plant). */
async function forecastOf(caller: CommandCaller, context: OfficeContext, lines: readonly LineRecord[], companyId: string, now: Date) {
  const open = lines.filter((line) => isGoods(line) && line.closedShortQuantity === null)
  if (open.length === 0) return []
  // F-SA-234b: + source (what sets the day), as the planner's promise lines say it.
  const out: { lineId: string; seq: number; finish: BusinessDate | null; risk: string | null; slackDays: number | null; source: FinishSource; sizes: { size: string | null; finish: BusinessDate | null; risk: string | null }[] }[] = []
  // Its own transaction: a planning read that fails is answered without its lines (never the rest of the order's read).
  await caller.withClient(async (db) => {
    const siteIds = unique(open.flatMap((line) => (line.siteId ? [line.siteId] : [])))
    const sites = new Map<string, SiteRow>((siteIds.length === 0 ? [] : await db.site.findMany({ where: { id: { in: siteIds } }, select: SITE_COLUMNS })).map((site) => [site.id, site]))
    const plants = open.some((line) => line.siteId === null) ? await db.site.findMany({ where: { companyId, kind: 'PLANT', status: 'ACTIVE' }, select: SITE_COLUMNS, take: 2 }) : []
    const plant = plants.length === 1 ? plants[0]! : null
    const bySite = new Map<string, { site: SiteRow; ids: string[] }>()
    for (const line of open) {
      const site = line.siteId ? (sites.get(line.siteId) ?? null) : plant
      if (!site) continue
      const group = bySite.get(site.id) ?? { site, ids: [] }
      group.ids.push(line.id)
      bySite.set(site.id, group)
    }
    for (const { site, ids } of bySite.values()) {
      for (let at = 0; at < ids.length; at += LINES_LIMIT) {
        const read = await promiseLinesOf(db, context, site, now, { orderLineIds: ids.slice(at, at + LINES_LIMIT), limit: LINES_LIMIT })
        for (const line of read.lines) out.push({ lineId: line.id, seq: line.seq, finish: line.finish, risk: line.risk, slackDays: line.slackDays, source: line.finishSource /* F-SA-234b */, sizes: line.sizes.map((size) => ({ size: size.size, finish: size.finish, risk: size.risk })) })
      }
    }
  }).catch(() => undefined)
  return out.sort((a, b) => a.seq - b.seq)
}

async function datesPart(db: Db, context: OfficeContext, order: OrderRow, load: Loaders, now: Date) {
  const world = { actor: actorOf(context), actorId: context.actorId, now }
  // Time & action's own world of this one order, under orders.view (the Sales template holds no planning.view). B-OO-010: each gate's
  // actions are readWorld's for THIS reader (planning.milestones.manage / .override over the order, and the gate's own refusals).
  const read = await readWorld(db, world, { orderIds: [order.id] }, { permission: ORDERS_VIEW })
  const view = read.orders.find((entry) => entry.id === order.id)
  const own = (await load.workOrders()).filter((workOrder) => workOrder.partyId === order.partyId).map((workOrder) => workOrder.id)
  const planned = (await readPlanned(db, new Map([[order.id, own]]))).get(order.id) ?? { cutStart: null, sewStart: null, finish: null }
  return {
    gates: (view?.gates ?? []).map((gate) => ({
      id: gate.id,
      kind: gate.kind,
      label: gate.label,
      targetDate: gate.targetDate,
      sampleRound: gate.sampleRound,
      owner: gate.owner,
      state: gate.state,
      passedOn: gate.passedOn,
      via: gate.via,
      startedBefore: gate.startedBefore,
      leather: gate.leather,
      // B-OO-010 (N9): its version and what THIS reader may do, as Planning's own read built them (writes stay Planning's routes).
      version: gate.version,
      actions: gate.actions,
    })),
    milestones: (view?.milestones ?? []).map((row) => ({ id: row.id, kind: row.kind, gateId: row.gateId, gateKind: row.gateKind, label: row.label, target: row.target, actual: row.actual, state: row.state, late: row.late, owner: row.owner })),
    late: view?.late ?? 0,
    next: view?.next ?? null,
    planned,
    // Filled after this read, in a transaction of its own (forecastOf); null while withheld.
    forecast: null as Awaited<ReturnType<typeof forecastOf>> | null,
  }
}

async function qualityPart(db: Db, context: OfficeContext, load: Loaders, may: { readonly issues: boolean; readonly ncrs: boolean; readonly final: boolean }) {
  const actor = actorOf(context)
  const filter = await load.filter()
  const issueReach = may.issues ? issueReadWhere(actor) : null
  const issues =
    may.issues && issueReach
      ? await db.productionIssue.findMany({ where: { AND: [issueReach, issuesOfOrderWhere(filter), { status: 'OPEN' }] }, select: { id: true, source: true, recordType: true, raisedAt: true, dueDate: true, escalationStep: true }, orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }], take: 200 })
      : null
  const ncrsRead = async () => {
    const own: Prisma.NonconformanceWhereInput = { AND: [scopeWhere(actor, QUALITY_NCR_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.NonconformanceWhereInput, ncrsOfOrderWhere(filter), { stage: { in: [...OPEN_NCR_STAGES] } }] }
    // The brand wall: an NCR of a work order of several customers (or of none) only for people who reach every customer.
    const where = await ncrListWhere(db, actor, QUALITY_NCR_VIEW, own)
    const rows = await db.nonconformance.findMany({ where, select: { id: true, number: true, stage: true, severity: true, workOrderId: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 })
    const workOrderIds = unique(rows.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))
    const shared = new Set(workOrderIds.length === 0 ? [] : (await db.workOrder.findMany({ where: { id: { in: workOrderIds }, partyId: null }, select: { id: true } })).map((row) => row.id))
    return rows.map((row) => ({ id: row.id, number: row.number, stage: row.stage as string, severity: row.severity as string, sharedWorkOrder: row.workOrderId !== null && shared.has(row.workOrderId) }))
  }
  const ncrs = may.ncrs ? await ncrsRead() : null
  const finalRead = async () => {
    const reached = (await load.workOrders()).filter((workOrder) => reachesWorkOrder(actor, QUALITY_INSPECTIONS_VIEW, workOrder)).map((workOrder) => workOrder.id)
    const rows = reached.length === 0 ? [] : await db.inspection.findMany({ where: { workOrderId: { in: reached }, status: { not: 'CANCELLED' } }, select: { workOrderId: true, number: true, status: true, sampleSize: true, decidedAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 })
    return rows.map((row) => ({ workOrderId: row.workOrderId, number: row.number, status: row.status as string, sampleSize: row.sampleSize, on: row.decidedAt ? businessDate(row.decidedAt) : null }))
  }
  const final = may.final ? await finalRead() : null
  return {
    issues: issues ? issues.map((row) => ({ id: row.id, source: row.source as string, recordType: row.recordType, since: toUtcIso(row.raisedAt), dueOn: dayOf(row.dueDate), escalation: row.escalationStep })) : null,
    ncrs,
    final,
  }
}

async function peoplePart(db: Db, context: OfficeContext, order: OrderRow, load: Loaders) {
  const actor = actorOf(context)
  const supervisor = await supervisorOfOrder(db, order.id)
  const thread = await db.thread.findFirst({ where: { recordType: 'SalesOrder', recordId: order.id }, select: { ownerId: true } })
  // B-OO-008 (N7): "Answers the customer" is the conversation's owner by the threads' ONE chain (platform/threads/owner.ts): the
  // thread's own owner (SET) → the order's production supervisor (SUPERVISOR, registered by production/supervisor) → the order's
  // maker (MAKER), with where it comes from. A portal-made order with no supervisor names nobody (null: "—" is then true).
  const answersCustomer = await ownerOf(db, { type: 'SalesOrder', id: order.id }, thread)
  const people = await peopleById(db, [supervisor?.userId, supervisor?.backupId])
  // Places: a site and its line (a team by name, never with a count), and the outside workshops — of the work orders it reaches.
  // B-OO-008 (N8): of its LIVE work orders only — a closed one (and a cancelled one, already left out by the loader) makes nothing.
  const reached = (await load.workOrders()).filter((workOrder) => !NO_PLACE_WORK_ORDERS.includes(workOrder.status) && reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder))
  const sites = new Map((reached.length === 0 ? [] : await db.site.findMany({ where: { id: { in: unique(reached.map((row) => row.siteId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const lineIds = unique(reached.flatMap((row) => (row.lineId ? [row.lineId] : [])))
  const floorLines = new Map((lineIds.length === 0 ? [] : await db.line.findMany({ where: { id: { in: lineIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const teams = lineIds.length === 0 ? [] : await db.team.findMany({ where: { lineId: { in: lineIds }, status: 'ACTIVE' }, select: { lineId: true, code: true, name: true }, orderBy: { code: 'asc' } })
  const outside = reached.length === 0 ? [] : await db.subcontractOrder.findMany({ where: { workOrderId: { in: reached.map((row) => row.id) }, status: { in: [...AT_WORKSHOP] } }, select: { partyId: true, issuedAt: true } })
  const workshops = outside.length === 0 ? [] : await db.party.findMany({ where: { id: { in: unique(outside.map((row) => row.partyId)) } }, select: { id: true, legalName: true, tradeName: true }, orderBy: { legalName: 'asc' } })
  const places = new Map<string, { kind: PlaceKind; site: ReturnType<typeof named>; line: ReturnType<typeof named>; team: ReturnType<typeof named>; workshop: { name: string } | null; since: BusinessDate | null }>()
  for (const workOrder of reached) {
    const key = `${workOrder.siteId}|${workOrder.lineId ?? ''}`
    if (places.has(key)) continue
    places.set(key, {
      kind: 'PLANT',
      site: named(sites.get(workOrder.siteId)),
      line: named(workOrder.lineId ? floorLines.get(workOrder.lineId) : undefined),
      team: named(workOrder.lineId ? teams.find((team) => team.lineId === workOrder.lineId) : undefined),
      workshop: null,
      since: null,
    })
  }
  for (const workshop of workshops) {
    // B-OO-008: since the day its first job still out there was issued (null: one not marked issued).
    const issued = outside.flatMap((row) => (row.partyId === workshop.id && row.issuedAt ? [row.issuedAt.getTime()] : []))
    const name = workshop.tradeName ?? workshop.legalName
    places.set(`workshop|${name}`, { kind: 'WORKSHOP', site: null, line: null, team: null, workshop: { name }, since: issued.length > 0 ? businessDate(new Date(Math.min(...issued))) : null })
  }
  const supervisorPerson = supervisor?.userId ? people.get(supervisor.userId) : undefined
  return {
    supervisor: supervisorPerson && supervisor?.from ? { ...supervisorPerson, from: supervisor.from, me: supervisorPerson.id === context.actorId } : null,
    backup: supervisor?.backupId ? (people.get(supervisor.backupId) ?? null) : null,
    answersCustomer: answersCustomer ? { id: answersCustomer.id, name: answersCustomer.name, active: answersCustomer.active, source: answersCustomer.source } : null,
    places: [...places.values()],
  }
}

async function changesPart(db: Db, order: OrderRow, /* B-SA-050 */ context: OfficeContext) {
  const rows = await db.orderChangeRequest.findMany({ where: { orderId: order.id, status: { in: ['OPEN', 'COUNTERED'] } }, select: { id: true, kind: true, status: true, createdAt: true, batchId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  // B-SA-050 (R1, P6; review C-8): what is still to do after the accepted changes, computed from the records (./still-to-do).
  const stillToDo = await stillToDoOf(db, context, order)
  return { openRequests: rows.map((row) => ({ id: row.id, kind: row.kind as string, status: row.status as string, since: toUtcIso(row.createdAt), batchId: row.batchId })), stillToDo }
}

/** The parts asked of one order the caller reached with orders.view (`order`), each by its right. */
export async function readOrderProduction(caller: CommandCaller, context: OfficeContext, order: OrderRow, parts: readonly ProductionPart[], now: Date) {
  const actor = actorOf(context)
  const may = (permission: Permission): boolean => can(actor, permission, { companyId: order.companyId, partyId: order.partyId })
  const withheld = withheldOf(parts, may)
  const kept = (key: WithheldKey) => !withheld.includes(key)
  const today = businessDate(now)
  const read = await caller.withClient(async (db) => {
    const load = loaders(db, context, order, now)
    // One after another: a scoped client is one transaction (no Promise.all on it).
    const headline = parts.includes('headline') ? await headlinePart(db, context, order, load, now, kept('headline.notes')) : undefined
    const lines = parts.includes('lines') ? await linesPart(db, load, context, order) : undefined
    const work = parts.includes('work') ? (kept('work') ? await workPart(db, context, order, load, today) : null) : undefined
    const dates = parts.includes('dates') ? await datesPart(db, context, order, load, now) : undefined
    const quality = parts.includes('quality') ? await qualityPart(db, context, load, { issues: kept('quality.issues'), ncrs: kept('quality.ncrs'), final: kept('quality.final') }) : undefined
    const people = parts.includes('people') ? (kept('people') ? await peoplePart(db, context, order, load) : null) : undefined
    const changes = parts.includes('changes') ? await changesPart(db, order, context) : undefined
    const progress = parts.includes('lines') || parts.includes('headline') ? await load.progress() : null
    return { headline, lines, work, dates, quality, people, changes, asOf: progress ? progress.computedAt : now, orderLines: dates && kept('dates.forecast') ? await load.lines() : null }
  })
  const { asOf, orderLines, ...answer } = read
  // The forecast per line: a planning read in its own transaction, after the rest (one that fails leaves the lines without it).
  if (answer.dates && orderLines) answer.dates.forecast = await forecastOf(caller, context, orderLines, order.companyId, now)
  return {
    order: { id: order.id, number: order.number, status: order.status as string, version: order.version },
    asOf: toUtcIso(asOf),
    refreshSeconds: PROGRESS_REFRESH_SECONDS,
    parts: [...parts],
    withheld,
    // A part not asked is absent; one withheld is null (named in `withheld`).
    ...(answer.headline !== undefined ? { headline: answer.headline } : {}),
    ...(answer.lines !== undefined ? { lines: answer.lines } : {}),
    ...(answer.work !== undefined ? { work: answer.work } : {}),
    ...(answer.dates !== undefined ? { dates: answer.dates } : {}),
    ...(answer.quality !== undefined ? { quality: answer.quality } : {}),
    ...(answer.people !== undefined ? { people: answer.people } : {}),
    ...(answer.changes !== undefined ? { changes: answer.changes } : {}),
  }
}

/** GET /sales/orders/:orderId/production (B-SA-031, B-SA-032). */
export async function orderProduction(caller: CommandCaller, orderId: string, query: { readonly parts?: string | undefined }) {
  const parts = partsOf(query.parts)
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  return readOrderProduction(caller, context, order, parts, serverClock.now())
}

/** GET /sales/orders/:orderId/milestones (B-SA-032, P16): the `dates` part alone, for any caller of the order's own dates. */
export async function orderMilestones(caller: CommandCaller, orderId: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  const answer = await readOrderProduction(caller, context, order, ['dates'], serverClock.now())
  if (!('dates' in answer) || !answer.dates) throw new Error('the dates part was asked')
  return { order: answer.order, asOf: answer.asOf, withheld: answer.withheld, dates: answer.dates }
}
