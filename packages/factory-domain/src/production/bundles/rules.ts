import { ValidationError, type Issue } from '../../core/errors'
import { NO_DPIA_NOTE, NO_WORKER_NOTICE_NOTE, type FloorReadiness } from '../../privacy/readiness'
import { CUTTABLE_STATUSES } from '../cutting/rules'
import type { WorkOrderKind, WorkOrderStatus } from '../work-orders/machine'

/**
 * Bundles from a cut (B-W1-41; MES-065, MES-066, MES-068, MES-073; PLAN §4.7 stage 12-scans "bundles"; A2 SCR-095), pure:
 * how a cell's cut garments are split into bundles, how many of them still wait for one, which code a new ticket gets,
 * and when a bundle may be reprinted or voided. The API (apps/factory-api modules/production/bundles) reads the facts
 * inside its command, under the work order's issue lock and the cells' bundle locks, and writes the Bundle rows; the
 * …_production_guards trigger stays the last word on the work order's state, the single piece of a made-to-measure unit,
 * the cut log entries and the reprint (a new code, the old one kept as replaced).
 *
 *   cut        a cell's cut garments are B-W1-40's: the fewest pieces of any of its parts cut from hides (one piece per
 *              part per garment), from its live cut log entries. A cell with no part cut from hides is not bundled here.
 *   bundled    an ACTIVE bundle of whole garments (no part) takes one piece of every part per garment; a part bundle
 *              (the sleeves travelling on their own) takes one piece of its part per garment. So per cell:
 *                whole garments still to bundle = min over its parts (pieces − in part bundles of it) − in whole bundles
 *                pieces of part p still to bundle = pieces of p − in part bundles of p − in whole bundles
 *              A VOID bundle takes nothing: its pieces are back in "cut, not in bundles".
 *   split      the garments to bundle in bundles of the target size (the request's, else the site's standard bundle
 *              size, ProductionSettings.standardBundleSize, else DEFAULT_BUNDLE_SIZE): as many full bundles as fit, and
 *              the last one takes the rest (12 by 5 → 5 + 5 + 2). The request may give the
 *              quantities itself (the screen's "tap a bundle's quantity to change it"); they never add up to more than
 *              is still to bundle. A made-to-measure work order is single-piece (MES-068): one garment per bundle.
 *   code       a ticket's code is a BUNDLE scannable id of the tenant (numbering/scan-id, `BN-7K-00003R-M`): the
 *              tenant's highest bundle reference + 1 (the API reads it under the tenant's bundle-code lock).
 *   reprint    a lost or damaged ticket gets a new code; the old one stays in `replacedCodes` and a scan of it is
 *              refused with the new code in the words (MES-073). A void bundle is not reprinted.
 *   void       a bundle made by mistake is VOID, only before any scan names it (an undone scan too: the record keeps it),
 *              and only while its work order is open; its garments go back to "cut, not in bundles".
 *   readiness  making a bundle and reprinting a ticket are floor work: they wait for the site's floor to be ready
 *              (B-W1-36's privacy gate, B-W1-37's floor rules), refused in the gate's own words.
 */

/**
 * A bundle carries this many garments of one cell when neither the request nor the site's floor rules name a size
 * (MES-065: 10-20); the schema's default of ProductionSettings.standardBundleSize.
 */
export const DEFAULT_BUNDLE_SIZE = 10
/** The largest bundle (and target size) a request, or a site's standard bundle size, may name (the database's limit too). */
export const MAX_BUNDLE_SIZE = 500

/** The site's standard bundle size: its floor rules' (a site without a row: DEFAULT_BUNDLE_SIZE). */
export function standardBundleSizeOf(rules: { readonly standardBundleSize: number } | null | undefined): number {
  return rules?.standardBundleSize ?? DEFAULT_BUNDLE_SIZE
}

/** The target size a proposal uses: one garment for a made-to-measure unit; else the asked size, else the site's standard. */
export function targetBundleSize(kind: WorkOrderKind, asked: number | undefined, standard: number): number {
  if (kind === 'MADE_TO_MEASURE') return 1
  return Math.min(MAX_BUNDLE_SIZE, asked ?? standard)
}
/** The most bundles one request makes (and so the most tickets it prints). */
export const MAX_BUNDLES_PER_MAKE = 100

/** Why a bundle is not made, reprinted, voided or scanned: a stable code (the screens' words) and its sentence. */
export const BUNDLE_REFUSALS = [
  'FLOOR_NOT_READY',
  'WORK_ORDER_NOT_OPEN',
  'NOT_CUT_FROM_HIDES',
  'NOTHING_TO_BUNDLE',
  'MORE_THAN_CUT',
  'NOT_A_PART',
  'SINGLE_PIECE',
  'TOO_MANY_BUNDLES',
  'VOIDED',
  'SCANNED',
  'REPLACED',
] as const
export type BundleRefusalCode = (typeof BUNDLE_REFUSALS)[number]

export interface BundleRefusal {
  readonly code: BundleRefusalCode
  readonly message: string
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const piecesOf = (count: number, part: string) => `${plural(count, 'piece')} of ${part}`

// ---- what a cell has to bundle ----------------------------------------------------------------------------------------------

/** A cell as the cut log counts it (modules/production/cutting views.ts cutForBundles). */
export interface CellCut {
  readonly cellId: string
  /** The garments the work order makes in the cell. */
  readonly quantity: number
  /** Whole garments cut; null: the cell has no part cut from hides. */
  readonly cut: number | null
  /** Pieces cut per part: the BOM's parts (`planned`), then parts logged by another name (recuts). */
  readonly parts: readonly { readonly part: string; readonly pieces: number; readonly planned: boolean }[]
}

/** An ACTIVE bundle of the work order, as counted against its cell. */
export interface BundleCount {
  readonly cellId: string
  /** null: whole garments. */
  readonly part: string | null
  readonly quantity: number
}

export interface CellBundles {
  readonly cellId: string
  readonly quantity: number
  readonly cut: number | null
  /** Garments in ACTIVE bundles of whole garments. */
  readonly bundled: number
  /** Whole garments cut and not yet in a bundle (of whole garments, or of every part). */
  readonly toBundle: number
  /** The BOM's parts of the cell: pieces cut, in bundles (whole and of the part), still to bundle as a part bundle. */
  readonly parts: readonly { readonly part: string; readonly pieces: number; readonly bundled: number; readonly toBundle: number }[]
}

/** What a cell has cut, has in bundles and still has to bundle (rules in the header). */
export function cellBundles(cell: CellCut, bundles: readonly BundleCount[]): CellBundles {
  const own = bundles.filter((bundle) => bundle.cellId === cell.cellId)
  const whole = own.filter((bundle) => bundle.part === null).reduce((sum, bundle) => sum + bundle.quantity, 0)
  const ofPart = (part: string) => own.filter((bundle) => bundle.part === part).reduce((sum, bundle) => sum + bundle.quantity, 0)
  const planned = cell.cut === null ? [] : cell.parts.filter((part) => part.planned)
  const parts = planned.map((part) => {
    const inParts = ofPart(part.part)
    return { part: part.part, pieces: part.pieces, bundled: whole + inParts, toBundle: Math.max(0, part.pieces - inParts - whole) }
  })
  const free = planned.length === 0 ? 0 : Math.min(...planned.map((part) => part.pieces - ofPart(part.part)))
  return { cellId: cell.cellId, quantity: cell.quantity, cut: cell.cut, bundled: whole, toBundle: Math.max(0, free - whole), parts }
}

/** `total` garments in bundles of `size`: full bundles, and the last one takes the rest (12 by 5 → [5, 5, 2]). */
export function splitBundles(total: number, size: number): number[] {
  if (!Number.isSafeInteger(total) || total <= 0) return []
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('A bundle size is a whole number from 1.')
  const full = Math.floor(total / size)
  const rest = total - full * size
  return [...Array.from({ length: full }, () => size), ...(rest > 0 ? [rest] : [])]
}

// ---- a request to make bundles -------------------------------------------------------------------------------------------------

/** A cell of the work order as the plan sees it: its counts and its words ("BLK 52"). */
export interface PlanCell extends CellBundles {
  readonly label: string
}

/** What the floor asks for one cell (and part): how many garments, in bundles of which size or of these quantities. */
export interface BundleAsk {
  readonly cellId: string
  /** A part bundle of one of the cell's parts; null or absent: whole garments. */
  readonly part?: string | null | undefined
  /** Garments to bundle (default: all still to bundle). */
  readonly quantity?: number | undefined
  /** The bundles' quantities, in order (instead of a size). */
  readonly quantities?: readonly number[] | undefined
  /** The target size for this cell (default: the request's, else DEFAULT_BUNDLE_SIZE). */
  readonly bundleSize?: number | undefined
}

export interface PlanFacts {
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus; readonly kind: WorkOrderKind }
  /** Every cell of the work order, in the record's order. */
  readonly cells: readonly PlanCell[]
  /** null: "all cut, not bundled": every cell's whole garments still to bundle. */
  readonly asks: readonly BundleAsk[] | null
  /** The request's target size. */
  readonly bundleSize?: number | undefined
  /** The site's standard bundle size (standardBundleSizeOf), when the request names none; absent: DEFAULT_BUNDLE_SIZE. */
  readonly standardSize?: number | undefined
}

export interface PlannedBundle {
  readonly cellId: string
  readonly part: string | null
  readonly quantity: number
}

export type BundlePlan =
  | { readonly ok: true; readonly bundles: readonly PlannedBundle[]; readonly singlePiece: boolean }
  | { readonly ok: false; readonly refusal: BundleRefusal }

const refuse = (code: BundleRefusalCode, message: string): { readonly ok: false; readonly refusal: BundleRefusal } => ({ ok: false, refusal: { code, message } })

/** The bundles a request makes, or why not. A request that does not hold together (an unknown cell, a cell named twice, a quantity that is not the sum of its bundles) is a ValidationError. */
export function planBundles(facts: PlanFacts): BundlePlan {
  const { workOrder } = facts
  if (!CUTTABLE_STATUSES.includes(workOrder.status)) {
    return refuse('WORK_ORDER_NOT_OPEN', `Work order ${workOrder.number} is ${workOrder.status}; bundles are made only for a RELEASED or IN_PROGRESS work order.`)
  }
  const singlePiece = workOrder.kind === 'MADE_TO_MEASURE'
  const cellOf = new Map(facts.cells.map((cell) => [cell.cellId, cell]))
  const problems: Issue[] = []
  const asks: (BundleAsk & { readonly path: string })[] = []
  if (facts.asks === null) {
    for (const cell of facts.cells) if (cell.toBundle > 0) asks.push({ cellId: cell.cellId, path: 'body' })
    if (asks.length === 0) return refuse('NOTHING_TO_BUNDLE', `Nothing cut is waiting for bundles on work order ${workOrder.number}.`)
  } else {
    const seen = new Set<string>()
    for (const [index, ask] of facts.asks.entries()) {
      const path = `body/cells/${index}`
      if (!cellOf.has(ask.cellId)) problems.push({ path: `${path}/workOrderSizeId`, message: 'Not a cell of this work order.' })
      const key = `${ask.cellId}|${ask.part ?? ''}`
      if (seen.has(key)) problems.push({ path, message: 'This cell (and part) is named twice: name it once.' })
      seen.add(key)
      if (ask.quantities !== undefined && ask.quantity !== undefined && ask.quantities.reduce((sum, value) => sum + value, 0) !== ask.quantity) {
        problems.push({ path: `${path}/quantity`, message: 'The quantity is the sum of the bundles: give one or the other.' })
      }
      if (ask.quantities !== undefined && ask.bundleSize !== undefined) problems.push({ path: `${path}/bundleSize`, message: 'Give the bundles their quantities or a size, not both.' })
      asks.push({ ...ask, path })
    }
    if (asks.length === 0) problems.push({ path: 'body/cells', message: 'Name at least one cell, or leave the cells out to bundle everything cut.' })
  }
  if (problems.length > 0) throw new ValidationError('The bundles asked for do not hold together.', problems)

  const bundles: PlannedBundle[] = []
  for (const ask of asks) {
    const cell = cellOf.get(ask.cellId)!
    const part = ask.part?.trim() || null
    if (cell.cut === null) return refuse('NOT_CUT_FROM_HIDES', `${cell.label} has no part cut from hides; its bundles are not counted from the cutting log.`)
    let available = cell.toBundle
    let counts = `${cell.cut} cut, ${cell.bundled} in bundles`
    if (part !== null) {
      const known = cell.parts.find((row) => row.part === part)
      if (!known) return refuse('NOT_A_PART', `${part} is not a part of ${cell.label}: its parts are ${cell.parts.map((row) => row.part).join(', ')}.`)
      available = known.toBundle
      counts = `${piecesOf(known.pieces, part)} cut, ${known.bundled} in bundles`
    }
    if (available <= 0) return refuse('NOTHING_TO_BUNDLE', `${cell.label}: nothing cut is waiting for bundles (${counts}).`)
    const size = ask.bundleSize ?? facts.bundleSize ?? (singlePiece ? 1 : (facts.standardSize ?? DEFAULT_BUNDLE_SIZE))
    if (singlePiece && (size !== 1 || (ask.quantities ?? []).some((value) => value !== 1))) {
      return refuse('SINGLE_PIECE', `Work order ${workOrder.number} is made to measure: each bundle is the one garment (single-piece mode).`)
    }
    const quantities = ask.quantities ? [...ask.quantities] : splitBundles(ask.quantity ?? available, size)
    const total = quantities.reduce((sum, value) => sum + value, 0)
    if (total > available) {
      return refuse('MORE_THAN_CUT', `${cell.label} has ${part === null ? plural(available, 'cut garment') : piecesOf(available, part)} not in bundles; ${total} asked. A bundle never holds more than was cut.`)
    }
    for (const quantity of quantities) bundles.push({ cellId: cell.cellId, part, quantity })
  }
  if (bundles.length > MAX_BUNDLES_PER_MAKE) {
    return refuse('TOO_MANY_BUNDLES', `That makes ${bundles.length} bundles; at most ${MAX_BUNDLES_PER_MAKE} are made at once. Take a larger bundle size, or bundle fewer cells at a time.`)
  }
  return { ok: true, bundles, singlePiece }
}

// ---- reprint, void, scan -------------------------------------------------------------------------------------------------------

export interface BundleFacts {
  readonly code: string
  readonly status: 'ACTIVE' | 'VOID'
  readonly replacedCodes: readonly string[]
}

const voided = (code: string): BundleRefusal => ({ code: 'VOIDED', message: `Bundle ${code} is voided: no scan takes it, and its ticket is not printed again.` })
const notOpen = (workOrder: { readonly number: string; readonly status: WorkOrderStatus }): BundleRefusal => ({
  code: 'WORK_ORDER_NOT_OPEN',
  message: `Work order ${workOrder.number} is ${workOrder.status}; its bundles change only while it is RELEASED or IN_PROGRESS.`,
})

/** Why a bundle's ticket may not be reprinted with a new code, or null. */
export function reprintRefusal(facts: { readonly bundle: BundleFacts; readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus } }): BundleRefusal | null {
  if (facts.bundle.status === 'VOID') return voided(facts.bundle.code)
  if (!CUTTABLE_STATUSES.includes(facts.workOrder.status)) return notOpen(facts.workOrder)
  return null
}

/** Why a bundle may not be voided, or null: only an ACTIVE bundle of an open work order that no scan names. */
export function voidRefusal(facts: {
  readonly bundle: BundleFacts
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus }
  /** The scans that name the bundle (an undone report counts: the record keeps it). */
  readonly scans: number
}): BundleRefusal | null {
  if (facts.bundle.status === 'VOID') return { code: 'VOIDED', message: `Bundle ${facts.bundle.code} is voided already.` }
  if (!CUTTABLE_STATUSES.includes(facts.workOrder.status)) return notOpen(facts.workOrder)
  if (facts.scans > 0) {
    return {
      code: 'SCANNED',
      message: `Bundle ${facts.bundle.code} was scanned already (${plural(facts.scans, 'scan')}): a bundle is voided only before any scan names it. Undo or correct its scans instead.`,
    }
  }
  return null
}

/**
 * Whether a scanned code takes the bundle it names (B-W1-42's scan, the floor's bundle card): null when it is the
 * ticket's current code of an ACTIVE bundle; REPLACED for an old ticket (with the new code, MES-073); VOIDED.
 */
export function scannedBundleRefusal(bundle: BundleFacts, scanned: string): BundleRefusal | null {
  if (scanned !== bundle.code && bundle.replacedCodes.includes(scanned)) {
    return { code: 'REPLACED', message: `Ticket ${scanned} was replaced by ${bundle.code}: use the new ticket.${bundle.status === 'VOID' ? ' That bundle is voided too.' : ''}` }
  }
  if (bundle.status === 'VOID') return voided(bundle.code)
  return null
}

/** Whether the site's floor may make bundles and print tickets (platform/privacy floorReadinessFor's answer; null: the site is not in scope). */
export function bundlesReadyRefusal(readiness: FloorReadiness | null): BundleRefusal | null {
  if (readiness?.readyForFloor) return null
  const missing = readiness
    ? [...(readiness.privacy.ready ? [] : readiness.privacy.notes.filter((note) => note === NO_DPIA_NOTE || note === NO_WORKER_NOTICE_NOTE)), ...(readiness.rules.readyForFloor ? [] : readiness.rules.notes)]
    : []
  const words = missing.length > 0 ? missing : (readiness?.notes ?? ['The floor rules of this site are not set up.'])
  return { code: 'FLOOR_NOT_READY', message: `Bundles are held at this site until its floor is ready: ${words.join(' ')}` }
}
